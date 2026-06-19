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

// ─── Simple line diff ────────────────────────────────────────────────────────

interface DiffLine { type: 'context' | 'removed' | 'added'; line: string; }

/** Simple line-level diff for small files. Produces unified-diff-style output. */
function simpleLineDiff(oldText: string, newText: string): DiffLine[] {
	const oldLines = oldText.split('\n');
	const newLines = newText.split('\n');
	const result: DiffLine[] = [];
	let oldIdx = 0, newIdx = 0;

	while (oldIdx < oldLines.length || newIdx < newLines.length) {
		if (oldIdx >= oldLines.length) {
			result.push({ type: 'added', line: newLines[newIdx++] });
		} else if (newIdx >= newLines.length) {
			result.push({ type: 'removed', line: oldLines[oldIdx++] });
		} else if (oldLines[oldIdx] === newLines[newIdx]) {
			result.push({ type: 'context', line: oldLines[oldIdx] });
			oldIdx++; newIdx++;
		} else {
			// Mismatch: peek ahead to decide if lines were inserted or deleted
			const oldLine = oldLines[oldIdx];
			const newLine = newLines[newIdx];
			let foundInNew = -1;
			for (let i = newIdx + 1; i < Math.min(newIdx + 6, newLines.length); i++) {
				if (newLines[i] === oldLine) { foundInNew = i; break; }
			}
			let foundInOld = -1;
			for (let i = oldIdx + 1; i < Math.min(oldIdx + 6, oldLines.length); i++) {
				if (oldLines[i] === newLine) { foundInOld = i; break; }
			}

			if (foundInNew !== -1 && (foundInOld === -1 || foundInNew - newIdx <= foundInOld - oldIdx)) {
				for (let i = newIdx; i < foundInNew; i++) {
					result.push({ type: 'added', line: newLines[i] });
				}
				newIdx = foundInNew;
			} else if (foundInOld !== -1) {
				for (let i = oldIdx; i < foundInOld; i++) {
					result.push({ type: 'removed', line: oldLines[i] });
				}
				oldIdx = foundInOld;
			} else {
				result.push({ type: 'removed', line: oldLines[oldIdx++] });
				result.push({ type: 'added', line: newLines[newIdx++] });
			}
		}
	}
	return result;
}

// ─── FileEditView (single-view unified diff using CodeEditorWidget) ──────────

interface FileEditViewOptions {
	beforeContent: string;
	afterContent: string;
	path: string;
	maxHeight?: number;
	instantiationService: IInstantiationService;
}

export class FileEditView extends Component {
	private _editor: CodeEditorWidget | null = null;

	constructor(options: FileEditViewOptions) {
		super('div', 'sc-file-edit-view');
		const container = this.append('div', 'sc-file-view-container');
		const maxHeight = options.maxHeight ?? 400;

		// Compute unified diff. Use clean (un-prefixed) lines for the model so
		// syntax highlighting works; the +/- type is conveyed by decorations.
		const diffLines = simpleLineDiff(options.beforeContent, options.afterContent);
		const diffText = diffLines.map(dl => dl.line).join('\n');

		const model = createModel(diffText, options.path, options.instantiationService);

		const editor = options.instantiationService.createInstance(CodeEditorWidget, container, {
			...commonEditorOptions,
			folding: false,
		}, {
			isSimpleWidget: true
		});
		editor.setModel(model);
		editor.layout();

		this._editor = editor;

		// Apply decorations: green for added, red for removed
		const decorations = diffLines.map((dl, idx) => {
			const lineNumber = idx + 1;
			if (dl.type === 'added') {
				return {
					range: new Range(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber)),
					options: {
						description: 'diff-added',
						isWholeLine: true,
						className: 'sc-diff-line-added',
						linesDecorationsClassName: 'sc-diff-glyph-added',
					}
				};
			}
			if (dl.type === 'removed') {
				return {
					range: new Range(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber)),
					options: {
						description: 'diff-removed',
						isWholeLine: true,
						className: 'sc-diff-line-removed',
						linesDecorationsClassName: 'sc-diff-glyph-removed',
					}
				};
			}
			return null;
		}).filter((d): d is NonNullable<typeof d> => d !== null);

		editor.deltaDecorations([], decorations);

		// Set height
		const lineCount = diffLines.length;
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
