import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import 'katex/dist/katex.min.css';

marked.use(markedKatex({ throwOnError: false }));

export function renderMarkdown(text: string): string {
	return marked.parse(text, { async: false }) as string;
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
