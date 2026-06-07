import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import mermaid from 'mermaid';
import 'katex/dist/katex.min.css';

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

// Custom marked extension for mermaid code blocks
const mermaidExtension = {
	name: 'code',
	level: 'block' as const,
	renderer(token: { lang: string; text: string }) {
		if (token.lang !== 'mermaid') {
			return false; // Let default renderer handle it
		}
		console.log('[MarkdownRenderer] Found mermaid code block:', token.text.substring(0, 50) + '...');
		// Return a div that mermaid.run() will process later
		return `<div class="mermaid">${token.text}</div>\n`;
	},
};

marked.use({ extensions: [mermaidExtension] });
console.log('[MarkdownRenderer] ✓ Mermaid extension registered');

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
