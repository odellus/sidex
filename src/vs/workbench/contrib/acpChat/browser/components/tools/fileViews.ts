/*---------------------------------------------------------------------------------------------
 *  FileViews — Monaco-based file renderers for ACP tool calls
 *  - FileReadView: Read-only Monaco editor with syntax highlighting
 *  - FileWriteView: New file view (all green content)
 *  - FileEditView: Inline diff view (before vs after)
 *--------------------------------------------------------------------------------------------*/

import { Component } from '../base.js';
import * as monaco from 'monaco-editor';

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

// ─── FileReadView (read-only) ────────────────────────────────────────────────

interface FileReadViewOptions {
	content: string;
	path: string;
	maxHeight?: number;
}

export class FileReadView extends Component {
	private _editor: monaco.editor.IStandaloneCodeEditor | null = null;

	constructor(options: FileReadViewOptions) {
		super('div', 'sc-file-read-view');
		const container = this.append('div', 'sc-file-view-container');
		const maxHeight = options.maxHeight ?? 300;

		const language = getLanguage(options.path);
		const model = monaco.editor.createModel(options.content, language);

		const editor = monaco.editor.create(container, {
			model,
			readOnly: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			scrollBeyondLastColumn: 0,
			scrollbar: { vertical: 'auto', horizontal: 'auto' },
			lineNumbers: 'on',
			folding: true,
			wordWrap: 'on',
			automaticLayout: true,
			fontSize: 12,
			fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
			padding: { top: 4, bottom: 4 },
			contextmenu: false,
			overviewRulerLanes: 0,
			hideCursorInOverviewRuler: true,
			renderLineHighlight: 'none',
			selectOnLineNumbers: false,
		});

		this._editor = editor;

		const lineCount = model.getLineCount();
		const height = Math.min(lineCount * 18 + 16, maxHeight);
		container.style.height = `${Math.max(height, 60)}px`;

		this._register({
			dispose: () => {
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
}

export class FileWriteView extends Component {
	private _editor: monaco.editor.IStandaloneCodeEditor | null = null;

	constructor(options: FileWriteViewOptions) {
		super('div', 'sc-file-write-view');
		const container = this.append('div', 'sc-file-view-container');
		const maxHeight = options.maxHeight ?? 300;

		const language = getLanguage(options.path);
		const model = monaco.editor.createModel(options.content, language);

		const editor = monaco.editor.create(container, {
			model,
			readOnly: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			scrollBeyondLastColumn: 0,
			scrollbar: { vertical: 'auto', horizontal: 'auto' },
			lineNumbers: 'on',
			folding: false,
			wordWrap: 'on',
			automaticLayout: true,
			fontSize: 12,
			fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
			padding: { top: 4, bottom: 4 },
			contextmenu: false,
			overviewRulerLanes: 0,
			hideCursorInOverviewRuler: true,
			renderLineHighlight: 'none',
			selectOnLineNumbers: false,
		});

		this._editor = editor;

		// Add green background decorations for all lines
		const lineCount = model.getLineCount();
		model.deltaDecorations([], [
			{
				range: new monaco.Range(1, 1, lineCount, model.getLineMaxColumn(lineCount)),
				options: {
					isWholeLine: true,
					className: 'sc-write-view-line',
					linesDecorationsClassName: 'sc-write-view-glyph',
				},
			},
		]);

		const height = Math.min(lineCount * 18 + 16, maxHeight);
		container.style.height = `${Math.max(height, 60)}px`;

		this._register({
			dispose: () => {
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
}

export class FileEditView extends Component {
	private _diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
	private _showFullDiff = false;

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
	}

	private _rebuildDiffEditor(
		container: HTMLElement,
		options: FileEditViewOptions,
		maxHeight: number
	): void {
		// Dispose old editor
		if (this._diffEditor) {
			this._diffEditor.dispose();
		}

		const language = getLanguage(options.path);
		const originalModel = monaco.editor.createModel(options.beforeContent, language);
		const modifiedModel = monaco.editor.createModel(options.afterContent, language);

		const diffEditor = monaco.editor.createDiffEditor(container, {
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
			diffAlgorithm: 'legacy',
			hideUnchangedRegions: {
				enabled: !this._showFullDiff,
				contextLineCount: 3,
				minimumLineCount: 5,
				revealLineCount: 5,
			},
		});

		diffEditor.setModel({
			original: originalModel,
			modified: modifiedModel,
		});

		this._diffEditor = diffEditor;

		const lineCount = Math.max(
			options.beforeContent.split('\n').length,
			options.afterContent.split('\n').length
		);
		const height = Math.min(lineCount * 18 + 16, maxHeight);
		container.style.height = `${Math.max(height, 80)}px`;

		this._register({
			dispose: () => {
				diffEditor.dispose();
				originalModel.dispose();
				modifiedModel.dispose();
			}
		});
	}
}
