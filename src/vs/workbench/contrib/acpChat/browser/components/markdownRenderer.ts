import { escapeHtml } from './base.js';

export function renderMarkdown(text: string): string {
	// First escape everything
	let html = escapeHtml(text);

	// Code blocks FIRST (before other replacements touch the content)
	html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
		const label = lang ? `<span class="sc-code-lang">${lang}</span>` : '';
		return `<pre class="sc-code-block">${label}<code>${code.trimEnd()}</code></pre>`;
	});

	// Tables: detect lines starting with | and convert
	html = renderTables(html);

	// Headings (#### before ### before ## before #)
	html = html.replace(/^#### (.+)$/gm, '<h4 class="sc-heading">$1</h4>');
	html = html.replace(/^### (.+)$/gm, '<h3 class="sc-heading">$1</h3>');
	html = html.replace(/^## (.+)$/gm, '<h2 class="sc-heading">$1</h2>');
	html = html.replace(/^# (.+)$/gm, '<h1 class="sc-heading">$1</h1>');

	// Inline code
	html = html.replace(/`([^`]+)`/g, '<code class="sc-inline-code">$1</code>');

	// Bold + italic
	html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
	html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
	html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

	// Links
	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="sc-link" href="$2">$1</a>');

	// Unordered lists (- item)
	html = html.replace(/^- (.+)$/gm, '<li class="sc-li">$1</li>');
	// Wrap consecutive <li> in <ul>
	html = html.replace(/((?:<li class="sc-li">.*<\/li>\n?)+)/g, '<ul class="sc-ul">$1</ul>');

	// Ordered lists (1. item)
	html = html.replace(/^\d+\. (.+)$/gm, '<li class="sc-oli">$1</li>');
	html = html.replace(/((?:<li class="sc-oli">.*<\/li>\n?)+)/g, '<ol class="sc-ol">$1</ol>');

	// Line breaks (but not inside pre/table)
	html = html.replace(/\n/g, '<br>');
	// Clean up extra <br> after block elements
	html = html.replace(/(<\/pre>)<br>/g, '$1');
	html = html.replace(/(<\/table>)<br>/g, '$1');
	html = html.replace(/(<\/ul>)<br>/g, '$1');
	html = html.replace(/(<\/ol>)<br>/g, '$1');
	html = html.replace(/(<\/h[1-4]>)<br>/g, '$1');

	return html;
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
