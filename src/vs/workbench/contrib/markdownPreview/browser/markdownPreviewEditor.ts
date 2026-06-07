/*---------------------------------------------------------------------------------------------
 *  MarkdownPreviewEditor — EditorPane containing a webview that renders markdown.
 *  Uses the marked + KaTeX + mermaid pipeline from the acpChat contrib.
 *  Mermaid diagrams render inside the webview (needs DOM).
 *  KaTeX renders in the main thread (pure string → HTML).
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import type { IReference } from '../../../../base/common/lifecycle.js';
import type { IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { IWebviewService, IWebviewElement } from '../../webview/browser/webview.js';
import { MarkdownPreviewEditorInput, markdownPreviewEditorId } from './markdownPreviewEditorInput.js';
import { renderMarkdown } from '../../acpChat/browser/components/markdownRenderer.js';

const $ = dom.$;

export class MarkdownPreviewEditor extends EditorPane {
	static readonly ID = markdownPreviewEditorId;

	private _webview: IWebviewElement | undefined;
	private _modelRef = this._register(new MutableDisposable<IReference<IResolvedTextEditorModel>>());
	private readonly _contentDisposables = this._register(new DisposableStore());
	private _updateTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IWebviewService private readonly _webviewService: IWebviewService,
	) {
		super(MarkdownPreviewEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const container = dom.append(parent, $('div.markdown-preview-container'));
		dom.size(container, parent.clientWidth, parent.clientHeight);

		this._webview = this._webviewService.createWebviewElement({
			title: undefined,
			options: {
				disableServiceWorker: true,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
			},
			extension: undefined,
		});

		this._webview.mountTo(container, mainWindow);
	}

	override async setInput(
		input: MarkdownPreviewEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		this._contentDisposables.clear();

		console.log('[MarkdownPreview] setInput:', input.sourceUri.toString());

		// Resolve the source document
		try {
			const ref = await this._textModelService.createModelReference(input.sourceUri);
			if (token.isCancellationRequested) {
				ref.dispose();
				return;
			}

			this._modelRef.value = ref;
			const model = ref.object;

			// Initial render
			this._updatePreview(model.textEditorModel.getValue());

			// Listen for changes
			const textModel = model.textEditorModel;
			this._contentDisposables.add(textModel.onDidChangeContent(() => {
				this._scheduleUpdate(textModel.getValue());
			}));
		} catch (err) {
			console.error('[MarkdownPreview] Failed to resolve source document:', err);
			this._showError(String(err));
		}
	}

	override clearInput(): void {
		super.clearInput();
		this._contentDisposables.clear();
		this._modelRef.clear();
	}

	override layout(dimension: dom.Dimension): void {
		const container = this.element?.querySelector('.markdown-preview-container') as HTMLElement | null;
		if (container) {
			dom.size(container, dimension.width, dimension.height);
		}
	}

	private _scheduleUpdate(text: string): void {
		if (this._updateTimer) {
			clearTimeout(this._updateTimer);
		}
		this._updateTimer = setTimeout(() => {
			this._updatePreview(text);
		}, 300);
	}

	private _updatePreview(text: string): void {
		if (!this._webview) {
			return;
		}

		console.log('[MarkdownPreview] Updating preview, text length:', text.length);

		const bodyHtml = renderMarkdown(text);
		const fullHtml = this._buildWebviewHtml(bodyHtml);
		this._webview.setHtml(fullHtml);
	}

	private _showError(message: string): void {
		if (!this._webview) {
			return;
		}
		this._webview.setHtml(this._buildWebviewHtml(
			`<div style="color: #f44; padding: 2em;"><h2>Error</h2><pre>${message}</pre></div>`
		));
	}

	private _buildWebviewHtml(bodyHtml: string): string {
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css"
	crossorigin="anonymous">
<style>
	body {
		background: var(--vscode-editor-background, var(--vscode-sideBar-background, #1e1e1e));
		color: var(--vscode-editor-foreground, var(--vscode-foreground, #d4d4d4));
		font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
		font-size: var(--vscode-font-size, 13px);
		line-height: 1.6;
		padding: 1em 2em 5em 2em;
		margin: 0;
	}
	h1, h2, h3, h4, h5, h6 {
		color: var(--vscode-editor-foreground, var(--vscode-foreground, #e0e0e0));
		border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #404040));
		padding-bottom: 0.3em;
		margin-top: 1.5em;
		margin-bottom: 0.5em;
	}
	h1 { font-size: 2em; }
	h2 { font-size: 1.5em; }
	h3 { font-size: 1.25em; }
	a {
		color: var(--vscode-textLink-foreground, #569cd6);
		text-decoration: var(--text-link-decoration, none);
	}
	a:hover {
		color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
	}
	code {
		background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background, #2d2d2d));
		padding: 0.2em 0.4em;
		border-radius: 3px;
		font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
		font-size: 0.9em;
	}
	pre {
		background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background, #2d2d2d));
		padding: 1em;
		border-radius: 6px;
		overflow-x: auto;
		border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
	}
	pre code {
		background: none;
		padding: 0;
		font-size: 1em;
	}
	blockquote {
		border-left: 4px solid var(--vscode-widget-border, var(--vscode-panel-border, #404040));
		margin: 0;
		padding: 0.5em 1em;
		color: var(--vscode-descriptionForeground, #aaa);
	}
	table {
		border-collapse: collapse;
		width: 100%;
		margin: 1em 0;
	}
	th, td {
		border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #404040));
		padding: 0.5em 1em;
		text-align: left;
	}
	th {
		background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background, #2d2d2d));
		font-weight: 600;
	}
	img { max-width: 100%; }
	hr {
		border: none;
		border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #404040));
		margin: 2em 0;
	}
	.mermaid {
		display: flex;
		justify-content: center;
		margin: 1em 0;
	}
	/* KaTeX display math */
	.katex-display {
		overflow-x: auto;
		overflow-y: hidden;
		padding: 0.5em 0;
	}
	/* Lists */
	ul, ol {
		padding-left: 2em;
	}
	/* Inline math */
	.katex-inline {
		padding: 0 0.2em;
	}
</style>
</head>
<body>
<div class="markdown-body">${bodyHtml}</div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
	mermaid.initialize({
		startOnLoad: false,
		theme: 'dark',
		securityLevel: 'loose',
		fontFamily: 'inherit',
	});
	function renderMermaid() {
		const divs = document.querySelectorAll('.mermaid:not([data-processed])');
		if (divs.length > 0) {
			mermaid.run({ nodes: Array.from(divs) });
		}
	}
	renderMermaid();
</script>
</body>
</html>`;
	}
}
