# Markdown Preview Contrib Module Design

## Overview

This document describes how to build a markdown preview feature as a VSCode contrib module that uses the `marked` library for rendering, with styling matching the ACP chat's markdown renderer.

## Why Contrib Instead of Extension

The web worker extension host is fundamentally broken in Tauri production builds (`tauri://` protocol). Multiple attempts to fix it have failed. The Sidex team themselves disabled it with a "memory spiral" patch.

Building as a contrib module:
- Bypasses the extension host entirely
- Works in all contexts (dev, binary, .deb)
- Uses proven patterns (ACP chat already works this way)
- Faster path to a working solution

## Architecture

```
src/vs/workbench/contrib/markdownPreview/
├── browser/
│   ├── markdownPreview.contribution.ts   # Registration & commands
│   ├── markdownPreview.ts                # Main preview logic
│   ├── markdownPreviewPanel.ts           # Webview panel management
│   └── media/
│       └── markdownPreview.css             # Styling (matches ACP chat)
```

## Step 1: Install marked

```bash
npm install marked
```

The `marked` package is already installed in the project. It provides:
- Full CommonMark support
- GitHub-flavored markdown extensions
- Plugin ecosystem
- ~20KB minified

## Step 2: Create the Markdown Renderer

Create `src/vs/workbench/contrib/markdownPreview/browser/markdownRenderer.ts`:

```typescript
import { marked } from 'marked';

export function renderMarkdown(text: string): string {
	return marked.parse(text, { async: false }) as string;
}
```

This replaces the custom regex-based renderer in ACP chat with a proper markdown parser.

## Step 3: Create the Preview Panel

Create `src/vs/workbench/contrib/markdownPreview/browser/markdownPreviewPanel.ts`:

```typescript
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWebviewService } from '../../webview/browser/webview.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { renderMarkdown } from './markdownRenderer.js';

export class MarkdownPreviewPanel extends Disposable {
	private _webviewPanel: any; // WebviewPanel type
	private _currentUri: URI | undefined;

	constructor(
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super();
	}

	async showPreview(uri: URI, content: string): Promise<void> {
		this._currentUri = uri;
		const html = this._generateHtml(content);

		if (!this._webviewPanel) {
			this._webviewPanel = this._webviewService.createWebviewPanel(
				'markdownPreview',
				'Markdown Preview',
				{ viewColumn: 2, preserveFocus: true },
				{ enableScripts: true }
			);

			this._register(this._webviewPanel.onDidDispose(() => {
				this._webviewPanel = undefined;
			}));
		}

		this._webviewPanel.webview.html = html;
		this._webviewPanel.title = `Preview: ${uri.fsPath}`;
	}

	private _generateHtml(content: string): string {
		const bodyHtml = renderMarkdown(content);

		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<style>
		${this._getStyles()}
	</style>
</head>
<body>
	<div class="markdown-preview">
		${bodyHtml}
	</div>
</body>
</html>`;
	}

	private _getStyles(): string {
		// Extracted from acpChatView.css, scoped to .markdown-preview
		return \`
			.markdown-preview {
				font-family: var(--vscode-font-family);
				font-size: 13px;
				line-height: 1.65;
				color: var(--vscode-foreground);
				padding: 20px;
				max-width: 800px;
				margin: 0 auto;
			}

			.markdown-preview h1,
			.markdown-preview h2,
			.markdown-preview h3,
			.markdown-preview h4 {
				color: var(--vscode-foreground);
				font-weight: 600;
				margin: 12px 0 4px;
			}

			.markdown-preview h1 { font-size: 18px; }
			.markdown-preview h2 { font-size: 16px; }
			.markdown-preview h3 { font-size: 14px; }
			.markdown-preview h4 { font-size: 13px; }

			.markdown-preview code:not(pre code) {
				font-family: var(--vscode-editor-font-family);
				font-size: 12px;
				background: var(--vscode-textPreformat-background);
				color: var(--vscode-textPreformat-foreground);
				padding: 1px 5px;
				border-radius: 3px;
			}

			.markdown-preview pre {
				background: var(--vscode-textCodeBlock-background);
				border: 1px solid var(--vscode-widget-border);
				border-radius: 6px;
				padding: 10px 12px;
				margin: 8px 0;
				overflow-x: auto;
				font-family: var(--vscode-editor-font-family);
				font-size: 12px;
				line-height: 1.45;
			}

			.markdown-preview table {
				width: 100%;
				border-collapse: collapse;
				margin: 8px 0;
				font-size: 12px;
			}

			.markdown-preview th {
				text-align: left;
				font-weight: 600;
				padding: 6px 10px;
				border-bottom: 2px solid var(--vscode-widget-border);
			}

			.markdown-preview td {
				padding: 5px 10px;
				border-bottom: 1px solid var(--vscode-widget-border);
			}

			.markdown-preview a {
				color: var(--vscode-textLink-foreground);
				text-decoration: none;
			}

			.markdown-preview a:hover {
				text-decoration: underline;
			}

			.markdown-preview ul,
			.markdown-preview ol {
				padding-left: 20px;
				margin: 4px 0;
			}
		\`;
	}
}
```

## Step 4: Register Commands

Create `src/vs/workbench/contrib/markdownPreview/browser/markdownPreview.contribution.ts`:

```typescript
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { MarkdownPreviewPanel } from './markdownPreviewPanel.js';

class ShowMarkdownPreviewAction extends Action2 {
	constructor() {
		super({
			id: 'markdown.showPreview',
			title: 'Open Markdown Preview',
			f1: true,
			category: 'Markdown',
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const activeEditor = editorService.activeEditor;

		if (!activeEditor) {
			return;
		}

		const resource = activeEditor.resource;
		if (!resource || !resource.path.endsWith('.md')) {
			return;
		}

		// Read file content
		const fileService = accessor.get(IFileService);
		const content = await fileService.readFile(resource);
		const text = content.value.toString();

		// Show preview
		const previewPanel = accessor.get(MarkdownPreviewPanel);
		await previewPanel.showPreview(resource, text);
	}
}

registerAction2(ShowMarkdownPreviewAction);
```

## Step 5: Register the Contribution

Add to `src/vs/workbench/workbench.web.main.ts`:

```typescript
import './contrib/markdownPreview/browser/markdownPreview.contribution.js';
```

## Styling Approach

The CSS is extracted from `acpChatView.css` and scoped to `.markdown-preview`. Key design decisions:

1. **Use CSS variables** — All colors use `var(--vscode-*)` so they adapt to the current theme
2. **Match ACP chat** — Same font sizes, spacing, and colors as the chat markdown renderer
3. **Responsive** — Max-width of 800px, centered, with padding
4. **Code blocks** — Same styling as chat (background, border, font family)

## Handling Images and Links

For images with relative paths:

```typescript
private _resolveImageSrc(src: string, baseUri: URI): string {
	if (src.startsWith('http://') || src.startsWith('https://')) {
		return src;
	}
	// Resolve relative to markdown file
	const dir = dirname(baseUri);
	return URI.joinPath(dir, src).toString();
}
```

For links:
- Internal links (same file): Scroll to anchor
- External links: Open in browser
- File links: Open in editor

## Live Preview Updates

To update preview when editor content changes:

```typescript
this._register(editorService.onDidActiveEditorChange(() => {
	// Re-render preview if active editor changed
}));

this._register(editorService.onDidEditorsChange(() => {
	// Re-render preview if content changed
}));
```

Debounce updates to avoid re-rendering on every keystroke:

```typescript
import { debounce } from '../../../../base/common/decorators.js';

private _debouncedUpdate = debounce((content: string) => {
	this._updatePreview(content);
}, 300);
```

## Security Considerations

1. **Sanitize HTML** — Use DOMPurify to prevent XSS:
   ```bash
   npm install dompurify
   ```
   ```typescript
   import DOMPurify from 'dompurify';
   const clean = DOMPurify.sanitize(html);
   ```

2. **CSP** — Set Content-Security-Policy on the webview

3. **No scripts** — Disable scripts in the preview webview unless needed

## Testing

1. **Dev mode**: `npx tauri dev`
2. **Binary**: Run from `target/release/Crow`
3. **.deb**: Install and test the packaged app

All three should work identically since contrib modules don't depend on the extension host.

## Future: SDK Migration

Once the sidex extension SDK supports webview creation:

1. Extract preview logic into a Rust extension
2. Compile to WASM
3. Load via the extension host
4. Keep the same styling and behavior

This is a non-blocking future optimization.

## Summary

**Problem**: Markdown preview doesn't work in .deb because the web worker extension host can't load via `tauri://`.

**Solution**: Build markdown preview as a contrib module using `marked` for rendering and VSCode's webview API for display.

**Key files**:
- `markdownRenderer.ts` — Wraps `marked.parse()`
- `markdownPreviewPanel.ts` — Manages webview panel
- `markdownPreview.contribution.ts` — Registers command
- `markdownPreview.css` — Theme-aware styling

**Why this works**: Contrib modules run in the main webview, not the extension host. They have full access to VSCode's APIs and don't need the web worker infrastructure.
