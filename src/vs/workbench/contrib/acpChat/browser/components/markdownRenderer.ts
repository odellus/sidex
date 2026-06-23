import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import mermaid from 'mermaid';
import 'katex/dist/katex.min.css';

// Language alias map — fills gaps highlight.js's own aliases don't cover.
const langAliases: Record<string, string> = {
	tsx: 'typescript', jsx: 'javascript', cs: 'csharp',
	'c#': 'csharp', 'c++': 'cpp', sh: 'bash', shell: 'bash',
	zsh: 'bash', kt: 'kotlin', kts: 'kotlin', md: 'markdown',
};

function resolveLang(lang: string): string {
	const lower = (lang || '').toLowerCase();
	return langAliases[lower] || lower || '';
}

// KaTeX for math rendering
marked.use(markedKatex({ throwOnError: false }));

// Syntax highlighting via highlight.js, applied during token walking so the
// renderer code receives already-highlighted HTML.
marked.use(markedHighlight({
	emptyLangClass: 'hljs',
	langPrefix: 'hljs language-',
	highlight(code, lang) {
		if (lang === 'mermaid') { return code; } // passthrough — renderer handles mermaid
		const resolved = resolveLang(lang);
		const language = resolved && hljs.getLanguage(resolved) ? resolved : 'plaintext';
		return hljs.highlight(code, { language }).value;
	},
}));

// Custom code renderer: mermaid → <div class="mermaid">, otherwise wrap the
// highlighted output from walkTokens in our code-block shell.
marked.use({
	renderer: {
		code({ text, lang }: { text: string; lang?: string }) {
			const rawLang = (lang || '').match(/\S*/)?.[0] || '';
			if (rawLang === 'mermaid') {
				return `<div class="mermaid">${text}</div>\n`;
			}
			const resolved = resolveLang(rawLang);
			const langLabel = resolved ? `<div class="sc-code-lang">${resolved}</div>` : '';
			const codeClass = resolved ? `hljs language-${resolved}` : 'hljs';
			const copyBtn = '<button class="sc-code-copy-btn" title="Copy"><span class="codicon codicon-copy"></span></button>';
			return `<div class="sc-code-block">${langLabel}${copyBtn}<pre class="sc-code-pre"><code class="${codeClass}">${text}</code></pre></div>\n`;
		},
	},
});

// Mermaid (rendered lazily, after markdown is in the DOM)
mermaid.initialize({
	startOnLoad: false,
	theme: 'dark',
	securityLevel: 'loose',
	fontFamily: 'inherit',
});

export function renderMarkdown(text: string): string {
	// NOTE: this runs on a throttled cadence from the streaming component,
	// not per-token — keep it allocation-free and quiet (no console output).
	return marked.parse(text, { async: false }) as string;
}

// Call this after inserting rendered HTML into the DOM
export async function renderMermaidDiagrams(container: HTMLElement): Promise<void> {
	const mermaidDivs = container.querySelectorAll('.mermaid:not([data-processed])');
	if (mermaidDivs.length === 0) {
		return;
	}
	try {
		await mermaid.run({ nodes: Array.from(mermaidDivs) as HTMLElement[] });
	} catch (err) {
		console.error('[MarkdownRenderer] Mermaid rendering failed:', err);
	}
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
