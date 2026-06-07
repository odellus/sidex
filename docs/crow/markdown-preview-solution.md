# Markdown Preview Solution

## Problem

The built-in `markdown-language-features` extension provides markdown preview functionality in sidex. However, in .deb builds (production), the web worker extension host doesn't start due to memory issues with the `tauri://` protocol. This means:

- Extension never activates
- Preview commands never get registered
- Users can't preview markdown files

## Why Previous Approaches Failed

### Attempt 1: Disable Extension + Build New Contrib
We gutted the extension and built a parallel contrib system. This broke the command palette because:
- Command ID conflicts (both trying to register `markdown.showPreview`)
- Extension activation likely crashed from missing dependencies
- Too many changes at once without incremental testing

### Attempt 2: Create New + Stub Old
Similar issues - the extension's deep integration with VSCode's command system made it fragile to modification.

## Solution: Conditional Activation

The key insight: **The extension only fails in .deb because web workers aren't available.** So we:

1. **Modify the extension** to check if web workers are available
2. **If no web workers** (.deb environment), skip registering preview commands
3. **Build a minimal contrib module** that registers the same commands using our renderer
4. **No conflicts** because only one system registers the commands at runtime

## Implementation

### Step 1: Modify Extension Activation

In `extensions/markdown-language-features/src/extension.browser.ts`:

```typescript
export async function activate(context: vscode.ExtensionContext) {
	console.log('[markdown-language-features] Activating...');
	
	// Check if web workers are available
	const hasWebWorkers = typeof Worker !== 'undefined';
	console.log('[markdown-language-features] Web workers available:', hasWebWorkers);
	
	if (!hasWebWorkers) {
		// Skip preview commands - contrib module will handle them
		console.log('[markdown-language-features] Skipping preview commands (no web worker support)');
		// Still activate language features (diagnostics, etc.) if they don't need workers
		return;
	}
	
	// Normal activation with preview
	return activateShared(...);
}
```

### Step 2: Build Minimal Contrib Module

Create `src/vs/workbench/contrib/markdownPreview/browser/markdownPreview.contribution.ts`:

```typescript
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWebviewService } from '../../webview/browser/webview.js';
import { renderMarkdown } from '../../acpChat/browser/components/markdownRenderer.js';

class ShowMarkdownPreviewAction extends Action2 {
	constructor() {
		super({
			id: 'markdown.showPreview',
			title: 'Open Preview',
			f1: true,
			category: 'Markdown',
			menu: [{
				id: MenuId.CommandPalette,
				when: ContextKeyExpr.equals('editorLangId', 'markdown'),
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const fileService = accessor.get(IFileService);
		const webviewService = accessor.get(IWebviewService);

		const activeEditor = editorService.activeEditor;
		if (!activeEditor?.resource) {
			console.log('[MarkdownPreview] No active editor');
			return;
		}

		const resource = activeEditor.resource;
		if (!resource.path.endsWith('.md')) {
			console.log('[MarkdownPreview] Not a markdown file');
			return;
		}

		console.log('[MarkdownPreview] Opening preview for:', resource.toString());

		// Read file content
		const fileContent = await fileService.readFile(resource);
		const markdownText = fileContent.value.toString();

		// Create webview panel
		const webview = webviewService.createWebviewElement({
			title: `Preview: ${resource.path.split('/').pop()}`,
			options: {
				enableScripts: true,
				retainContextWhenHidden: true,
			},
			contentOptions: {},
			extension: undefined,
		});

		// Render markdown
		const html = renderMarkdown(markdownText);

		// Set webview HTML
		webview.setHtml(`
			<!DOCTYPE html>
			<html>
			<head>
				<meta charset="UTF-8">
				<style>
					body {
						font-family: var(--vscode-font-family);
						color: var(--vscode-foreground);
						background: var(--vscode-editor-background);
						padding: 20px;
					}
				</style>
			</head>
			<body>
				<div class="markdown-body">
					${html}
				</div>
			</body>
			</html>
		`);

		// Show webview
		webview.reveal();
	}
}

registerAction2(ShowMarkdownPreviewAction);
```

### Step 3: Register in workbench.common.main.ts

```typescript
import './contrib/markdownPreview/browser/markdownPreview.contribution.js';
```

## Why This Works

1. **No command conflicts**: The extension checks for web workers and skips preview registration in .deb
2. **Simple contrib**: Just opens a webview and renders markdown - no complex state management
3. **Uses existing renderer**: Leverages the marked + KaTeX + mermaid renderer we already built
4. **Incremental**: Can test extension modification first, then add contrib module
5. **Safe**: If something breaks, we can disable the contrib module without affecting dev mode

## Testing Strategy

### Dev Mode (web workers available)
- Extension activates normally
- Extension registers `markdown.showPreview`
- Contrib module also tries to register but gets ignored (command already exists)
- Preview works via extension's web worker-based system

### .deb Build (no web workers)
- Extension activates but skips preview commands
- Contrib module registers `markdown.showPreview`
- Preview works via contrib's main-thread renderer
- No command conflicts

## Future Enhancements

Once this basic preview works, we can add:
- Live preview updates (watch editor changes)
- Scroll sync between editor and preview
- Mermaid diagram rendering
- Copy code buttons
- Better styling (match ACP chat)
- Side-by-side preview command (`markdown.showPreviewToSide`)

## Files to Modify

1. `extensions/markdown-language-features/src/extension.browser.ts` - Add web worker check
2. `src/vs/workbench/contrib/markdownPreview/browser/markdownPreview.contribution.ts` - New contrib module
3. `src/vs/workbench/workbench.common.main.ts` - Register contrib

## Key Learnings

- **Don't gut deeply integrated systems** - modify incrementally
- **Use runtime checks, not compile-time** - let the environment decide what activates
- **Leverage existing working code** - our marked renderer already works in ACP chat
- **Test incrementally** - verify each change before moving to the next
- **Command conflicts are real** - only one system should register a command ID
