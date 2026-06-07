/*---------------------------------------------------------------------------------------------
 *  Markdown Preview — Sidex-native markdown preview with KaTeX + Mermaid.
 *  Opens as an editor tab alongside the source file.
 *  No web workers, no node backend — pure main-thread rendering.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerAction2, Action2, MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownPreviewEditor } from './markdownPreviewEditor.js';
import { MarkdownPreviewEditorInput, markdownPreviewEditorId } from './markdownPreviewEditorInput.js';
import { MarkdownPreviewSerializer } from './markdownPreviewSerializer.js';
import { createPreviewUri } from './markdownPreviewUri.js';

// ── Editor registration ──

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	MarkdownPreviewEditorInput.ID,
	MarkdownPreviewSerializer,
);
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		MarkdownPreviewEditor,
		markdownPreviewEditorId,
		nls.localize('markdownPreview', 'Markdown Preview'),
	),
	[new SyncDescriptor(MarkdownPreviewEditorInput)],
);

// ── Commands ──

// Open preview to the side
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'markdown.openPreview',
			title: nls.localize2('markdown.openPreview', 'Markdown: Open Preview'),
			icon: Codicon.openPreview,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV,
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.equals('resourceLangId', 'markdown'),
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const activeEditor = editorService.activeTextEditorControl;
		if (!activeEditor) {
			console.warn('[MarkdownPreview] No active text editor');
			return;
		}

		const model = (activeEditor as any).getModel?.();
		if (!model || !model.uri) {
			console.warn('[MarkdownPreview] Active editor has no model');
			return;
		}

		const sourceUri = model.uri;
		console.log('[MarkdownPreview] Opening preview for:', sourceUri.toString());

		const previewUri = createPreviewUri(sourceUri);
		const input = new MarkdownPreviewEditorInput(previewUri);

		// Open to the side (split editor)
		await editorService.openEditor(input, {
			pinned: true,
		}, SIDE_GROUP);
	}
});

// Add button to editor title bar (top right, next to split view, etc.)
MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: {
		id: 'markdown.openPreview',
		title: nls.localize('markdown.openPreviewTitle', 'Open Preview'),
		icon: Codicon.openPreview,
	},
	when: ContextKeyExpr.equals('resourceLangId', 'markdown'),
	group: 'navigation',
	order: 1,
});

// Add to right-click context menu
MenuRegistry.appendMenuItem(MenuId.EditorContext, {
	command: {
		id: 'markdown.openPreview',
		title: nls.localize('markdown.openPreviewContext', 'Open Preview'),
	},
	when: ContextKeyExpr.equals('resourceLangId', 'markdown'),
	group: 'markdown',
	order: 1,
});
