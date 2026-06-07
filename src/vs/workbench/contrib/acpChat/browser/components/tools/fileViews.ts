/*---------------------------------------------------------------------------------------------
 *  FileViews — Monaco-based file renderers for ACP tool calls
 *  - FileReadView: Read-only Monaco editor with syntax highlighting
 *  - FileWriteView: New file view (all green content)
 *  - FileEditView: Inline diff view (before vs after)
 *
 *  Uses VSCode's CodeEditorWidget and DiffEditorWidget (not the standalone
 *  monaco-editor npm package) to stay within the workbench theme service.
 *--------------------------------------------------------------------------------------------*/

import { Component } from '../base.js';
import { CodeEditorWidget } from '../../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { DiffEditorWidget } from '../../../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Range } from '../../../../../../editor/common/core/range.js';

function getLanguage(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() || '';
	const map: Record<string, string> = {
		rs: 'rust', ts: 'typescript', tsx: 'typescriptreact',
		js: 'javascript', jsx: 'javascriptreact', py: 'python',
		go: 'go', java: 'java', c: 'c', cpp: 'cpp', cs: 'csharp',
		css: 'css', html: 'html', json: 'json', md: 'markdown',
		yml: 'yaml', yaml: 'yaml', toml: 'toml', sh: 'shell',
		sql: 'sql', php: 'php', swift: 'swift', kt: 'kotlin',
		lua: 'lua', rb: 'ruby', r: 'r', dart: 'dart',
	};
	return map[ext] || 'plaintext';
}

function makeModelUri(path: string): URI {
	const safePath = path.replace(/[^a-zA-Z0-9_.\-/]/g, '_').replace(/^\/+/, '');
	return URI.from({ scheme: 'acp-tool', path: '/' + safePath + '-' + Math.random().toString(36).slice(2, 8) });
}

function createModel(
	content: string,
	path: string,
	instantiationService: IInstantiationService
) {
	const modelService = instantiationService.invokeFunction(accessor => accessor.get(IModelService));
	const languageService = instantiationService.invokeFunction(accessor => accessor.get(ILanguageService));
	const language = getLanguage(path);
	const languageSelection = language ? languageService.createById(language) : null;
	return modelService.createModel(content, languageSelection, makeModelUri(path));
}

const commonEditorOptions = {
	readOnly: true,
	minimap: { enabled: false },
	scrollBeyondLastLine: false,
	scrollBeyondLastColumn: 0,
	scrollbar: { vertical: 'auto' as const, horizontal: 'auto' as const },
	lineNumbers: 'on' as const,
	wordWrap: 'on' as const,
	automaticLayout: true,
	fontSize: 12,
	fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
	padding: { top: 4, bottom: 4 },
	contextmenu: false,
	overviewRulerLanes: 0,
	hideCursorInOverviewRuler: true,
	renderLineHighlight: 'none' as const,
	selectOnLineNumbers: false,
};

// ─── FileReadView (read-only) ────────────────────────────────────────────────

interface FileReadViewOptions {
	content: string;
	path: string;
	maxHeight?: number;
	instantiationService: IInstantiationService;
}

export class FileReadView extends Component {
	private _editor: CodeEditorWidget | null = null;

	constructor(options: FileReadViewOptions) {
		super('div', 'sc-file-read-view');
		const container = this.append('div', 'sc-file-view-container');
		const maxHeight = options.maxHeight ?? 300;

		const model = createModel(options.content, options.path, options.instantiationService);

		const editor = options.instantiationService.createInstance(CodeEditorWidget, container, {
			...commonEditorOptions,
			folding: true,
		}, {
			isSimpleWidget: true
		});
		editor.setModel(model);
		editor.layout();

		this._editor = editor;

		const lineCount = model.getLineCount();
		const estimatedHeight = Math.min(lineCount * 18 + 16, maxHeight);
		container.style.height = `${Math.max(estimatedHeight, 60)}px`;

		const measureTimer = setTimeout(() => {
			const contentHeight = editor.getContentHeight();
			const measured = Math.min(contentHeight + 16, maxHeight);
			container.style.height = `${Math.max(measured, 60)}px`;
			editor.layout();
		}, 50);

		this._register({
			dispose: () => {
				clearTimeout(measureTimer);
				editor.dispose();
				model.dispose();
			}
		});
	}
}

// ─── FileWriteView (new file, all green) ─────────────────────────────────────

interface FileWriteViewOptions {
	content: string;
	path: string;
	maxHeight?: number;
	instantiationService: IInstantiationService;
}

export class FileWriteView extends Component {
	private _editor: CodeEditorWidget | null = null;

	constructor(options: FileWriteViewOptions) {
		super('div', 'sc-file-write-view');
		const container = this.append('div', 'sc-file-view-container');
		const maxHeight = options.maxHeight ?? 300;

		const model = createModel(options.content, options.path, options.instantiationService);

		const editor = options.instantiationService.createInstance(CodeEditorWidget, container, {
			...commonEditorOptions,
			folding: false,
		}, {
			isSimpleWidget: true
		});
		editor.setModel(model);
		editor.layout();

		this._editor = editor;

		// Add green background decorations for all lines
		const lineCount = model.getLineCount();
		editor.deltaDecorations([], [
			{
				range: new Range(1, 1, lineCount, model.getLineMaxColumn(lineCount)),
				options: {
					description: 'file-write-green-line',
					isWholeLine: true,
					className: 'sc-write-view-line',
					linesDecorationsClassName: 'sc-write-view-glyph',
				},
			},
		]);

		const estimatedHeight = Math.min(lineCount * 18 + 16, maxHeight);
		container.style.height = `${Math.max(estimatedHeight, 60)}px`;

		const measureTimer = setTimeout(() => {
			const contentHeight = editor.getContentHeight();
			const measured = Math.min(contentHeight + 16, maxHeight);
			container.style.height = `${Math.max(measured, 60)}px`;
			editor.layout();
		}, 50);

		this._register({
			dispose: () => {
				clearTimeout(measureTimer);
				editor.dispose();
				model.dispose();
			}
		});
	}
}

// ─── FileEditView (inline diff: before vs after) ─────────────────────────────

interface FileEditViewOptions {
	beforeContent: string;
	afterContent: string;
	path: string;
	maxHeight?: number;
	instantiationService: IInstantiationService;
}

export class FileEditView extends Component {
	private _diffEditor: DiffEditorWidget | null = null;
	private _showFullDiff = false;
	private _heightTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: FileEditViewOptions) {
		super('div', 'sc-file-edit-view');

		// Header with path and expand/collapse button
		const header = this.append('div', 'sc-file-edit-header');
		const pathEl = header.appendChild(document.createElement('span'));
		pathEl.className = 'sc-file-edit-path';
		pathEl.textContent = options.path;

		const toggleBtn = header.appendChild(document.createElement('button'));
		toggleBtn.className = 'sc-file-edit-toggle';
		toggleBtn.textContent = 'Expand';
		toggleBtn.onclick = () => {
			this._showFullDiff = !this._showFullDiff;
			toggleBtn.textContent = this._showFullDiff ? 'Collapse' : 'Expand';
			this._rebuildDiffEditor(container, options, maxHeight);
		};

		const container = this.append('div', 'sc-file-view-container');
		const maxHeight = options.maxHeight ?? 400;

		this._rebuildDiffEditor(container, options, maxHeight);

		// Single dispose callback — handles whatever editor is current
		this._register({
			dispose: () => {
				if (this._heightTimer) {
					clearTimeout(this._heightTimer);
					this._heightTimer = null;
				}
				if (this._diffEditor) {
					const model = this._diffEditor.getModel();
					if (model) {
						model.original?.dispose();
						model.modified?.dispose();
					}
					this._diffEditor.dispose();
					this._diffEditor = null;
				}
			}
		});
	}

	private _rebuildDiffEditor(
		container: HTMLElement,
		options: FileEditViewOptions,
		maxHeight: number
	): void {
		// Dispose old editor and models explicitly
		if (this._diffEditor) {
			const model = this._diffEditor.getModel();
			if (model) {
				model.original?.dispose();
				model.modified?.dispose();
			}
			this._diffEditor.dispose();
			this._diffEditor = null;
		}
		if (this._heightTimer) {
			clearTimeout(this._heightTimer);
			this._heightTimer = null;
		}
		container.innerHTML = '';

		const originalModel = createModel(options.beforeContent, options.path + '-orig', options.instantiationService);
		const modifiedModel = createModel(options.afterContent, options.path + '-mod', options.instantiationService);

		const diffEditor = options.instantiationService.createInstance(DiffEditorWidget, container, {
			originalEditable: false,
			readOnly: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			scrollbar: { vertical: 'auto', horizontal: 'auto' },
			lineNumbers: 'on',
			folding: true,
			wordWrap: 'on',
			automaticLayout: true,
			fontSize: 12,
			fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
			padding: { top: 4, bottom: 4 },
			contextmenu: false,
			renderSideBySide: true,
			useInlineViewWhenSpaceIsLimited: false,
			renderOverviewRuler: false,
			diffAlgorithm: 'legacy',
			hideUnchangedRegions: {
				enabled: !this._showFullDiff,
				contextLineCount: 3,
				minimumLineCount: 5,
				revealLineCount: 5,
			},
		}, {});

		diffEditor.setModel({
			original: originalModel,
			modified: modifiedModel,
		});
		diffEditor.layout();

		this._diffEditor = diffEditor;

		// Initial height estimate
		const lineCount = Math.max(
			options.beforeContent.split('\n').length,
			options.afterContent.split('\n').length
		);
		const estimatedHeight = Math.min(lineCount * 18 + 16, maxHeight);
		container.style.height = `${Math.max(estimatedHeight, 80)}px`;

		// Measure actual rendered height after layout
		this._heightTimer = setTimeout(() => {
			const contentHeight = Math.max(
				diffEditor.getOriginalEditor().getContentHeight(),
				diffEditor.getModifiedEditor().getContentHeight()
			);
			const measured = Math.min(contentHeight + 16, maxHeight);
			container.style.height = `${Math.max(measured, 80)}px`;
			diffEditor.layout();
		}, 50);
	}
}
