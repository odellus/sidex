import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import mermaid from 'mermaid';
import 'katex/dist/katex.min.css';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { URI } from '../../../../../base/common/uri.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';

console.log('[MarkdownRenderer] Initializing marked with extensions...');

// Initialize KaTeX extension
marked.use(markedKatex({ throwOnError: false }));
console.log('[MarkdownRenderer] ✓ KaTeX extension registered');

// Initialize Mermaid
console.log('[MarkdownRenderer] Initializing mermaid...');
mermaid.initialize({
	startOnLoad: false,
	theme: 'dark',
	securityLevel: 'loose',
	fontFamily: 'inherit',
});
console.log('[MarkdownRenderer] ✓ Mermaid initialized');

// Language alias map for code blocks
const langAliases: Record<string, string> = {
	js: 'javascript', ts: 'typescript', tsx: 'typescriptreact',
	jsx: 'javascriptreact', py: 'python', rs: 'rust',
	rb: 'ruby', sh: 'shellscript', bash: 'shellscript',
	yml: 'yaml', cs: 'csharp', 'c++': 'cpp', 'c#': 'csharp',
	kt: 'kotlin', pl: 'perl', md: 'markdown',
};

function resolveLang(lang: string): string {
	const lower = lang.toLowerCase();
	return langAliases[lower] || lower || 'plaintext';
}

function escapeHtmlAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Combined code block extension: handles mermaid + syntax-highlighted code blocks
const codeBlockExtension = {
	name: 'code',
	level: 'block' as const,
	renderer(token: { lang: string; text: string }) {
		if (token.lang === 'mermaid') {
			console.log('[MarkdownRenderer] Found mermaid code block:', token.text.substring(0, 50) + '...');
			return `<div class="mermaid">${token.text}</div>\n`;
		}
		const lang = resolveLang(token.lang || '');
		const escaped = escapeHtmlAttr(token.text);
		const langLabel = lang !== 'plaintext' ? `<div class="sc-code-lang">${lang}</div>` : '';
		return `<div class="sc-code-block" data-lang="${lang}">${langLabel}<pre class="sc-code-raw"><code>${escaped}</code></pre><div class="sc-code-editor-host"></div></div>\n`;
	},
};

marked.use({ extensions: [codeBlockExtension as any] });
console.log('[MarkdownRenderer] ✓ Code block extension registered');

export function renderMarkdown(text: string): string {
	console.log('[MarkdownRenderer] Rendering markdown, input length:', text.length);
	const html = marked.parse(text, { async: false }) as string;
	const hasMermaid = html.includes('class="mermaid"');
	console.log('[MarkdownRenderer] ✓ Markdown rendered, length:', html.length, 'hasMermaid:', hasMermaid);
	return html;
}

// Call this after inserting rendered HTML into the DOM
export async function renderMermaidDiagrams(container: HTMLElement): Promise<void> {
	const mermaidDivs = container.querySelectorAll('.mermaid:not([data-processed])');
	console.log('[MarkdownRenderer] renderMermaidDiagrams called, found', mermaidDivs.length, 'unprocessed mermaid elements');
	
	if (mermaidDivs.length === 0) {
		return;
	}

	try {
		console.log('[MarkdownRenderer] Calling mermaid.run() on', mermaidDivs.length, 'elements...');
		await mermaid.run({
			nodes: Array.from(mermaidDivs) as HTMLElement[],
		});
		console.log('[MarkdownRenderer] ✓ Mermaid diagrams rendered successfully');
	} catch (err) {
		console.error('[MarkdownRenderer] ✗ Mermaid rendering failed:', err);
	}
}

// Monaco editor options for code block rendering
const codeBlockEditorOptions = {
	readOnly: true,
	minimap: { enabled: false },
	scrollBeyondLastLine: false,
	scrollBeyondLastColumn: 0,
	scrollbar: { vertical: 'hidden' as const, horizontal: 'auto' as const },
	lineNumbers: 'off' as const,
	wordWrap: 'on' as const,
	automaticLayout: true,
	fontSize: 12,
	fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
	padding: { top: 8, bottom: 8 },
	contextmenu: false,
	overviewRulerLanes: 0,
	hideCursorInOverviewRuler: true,
	renderLineHighlight: 'none' as const,
	selectOnLineNumbers: false,
	folding: false,
	glyphMargin: false,
	lineDecorationsWidth: 8,
	lineNumbersMinChars: 0,
};

/**
 * Replace code block placeholders with Monaco editors for syntax highlighting.
 * Call this after inserting rendered HTML into the DOM.
 * Returns a DisposableStore — caller must dispose when the container is cleared/destroyed.
 */
export function renderCodeBlocks(
	container: HTMLElement,
	instantiationService: IInstantiationService,
): DisposableStore {
	const disposables = new DisposableStore();
	const blocks = container.querySelectorAll('.sc-code-block');

	for (const block of Array.from(blocks)) {
		const host = block.querySelector('.sc-code-editor-host') as HTMLElement | null;
		const rawEl = block.querySelector('.sc-code-raw code') as HTMLElement | null;
		if (!host || !rawEl) { continue; }

		const code = rawEl.textContent || '';
		const lang = (block.getAttribute('data-lang') || 'plaintext');

		if (!code.trim()) { continue; }

		// Create model
		const modelService = instantiationService.invokeFunction(a => a.get(IModelService));
		const languageService = instantiationService.invokeFunction(a => a.get(ILanguageService));
		const langSel = languageService.createById(lang);
		const uri = URI.from({ scheme: 'acp-codeblock', path: '/' + Math.random().toString(36).slice(2, 8) });
		const model = modelService.createModel(code, langSel, uri);
		disposables.add(model);

		// Create editor
		const editor = instantiationService.createInstance(CodeEditorWidget, host, codeBlockEditorOptions, { isSimpleWidget: true });
		editor.setModel(model);
		disposables.add(editor);

		// Size the container to fit content
		const lineCount = model.getLineCount();
		const estimatedHeight = Math.min(lineCount * 18 + 20, 400);
		host.style.height = `${Math.max(estimatedHeight, 36)}px`;

		// Measure and adjust after layout
		setTimeout(() => {
			const contentHeight = editor.getContentHeight();
			const measured = Math.min(contentHeight + 20, 400);
			host.style.height = `${Math.max(measured, 36)}px`;
			editor.layout();
		}, 50);

		// Hide the raw <pre> fallback, show the editor
		rawEl.parentElement!.style.display = 'none';
		host.style.display = '';
	}

	return disposables;
}

function renderTables(html: string): string {
	// Find blocks of lines that start with |
	const lines = html.split('\n');
	const result: string[] = [];
	let tableLines: string[] = [];

	for (const line of lines) {
		if (line.trimStart().startsWith('|')) {
			tableLines.push(line);
		} else {
			if (tableLines.length >= 2) {
				result.push(buildTable(tableLines));
			} else {
				result.push(...tableLines);
			}
			tableLines = [];
			result.push(line);
		}
	}
	if (tableLines.length >= 2) {
		result.push(buildTable(tableLines));
	} else {
		result.push(...tableLines);
	}

	return result.join('\n');
}

function buildTable(lines: string[]): string {
	const rows = lines
		.filter(l => !l.match(/^\|\s*-+/)) // skip separator rows
		.map(l => l.split('|').filter(c => c.trim() !== '').map(c => c.trim()));

	if (rows.length === 0) { return lines.join('\n'); }

	let html = '<table class="sc-table">';
	// First row is header
	html += '<thead><tr>';
	for (const cell of rows[0]) {
		html += `<th>${cell}</th>`;
	}
	html += '</tr></thead>';

	// Remaining rows are body
	if (rows.length > 1) {
		html += '<tbody>';
		for (let i = 1; i < rows.length; i++) {
			html += '<tr>';
			for (const cell of rows[i]) {
				html += `<td>${cell}</td>`;
			}
			html += '</tr>';
		}
		html += '</tbody>';
	}
	html += '</table>';
	return html;
}
