import { renderMarkdown, renderMermaidDiagrams } from './markdownRenderer.js';

/**
 * Streaming markdown renderer using the "frozen block" strategy.
 *
 * Instead of re-parsing the entire accumulated text on every update (O(N²)),
 * this splits the text at safe block boundaries. Completed blocks are parsed
 * once and appended to a "frozen" DOM container — never touched again. Only
 * the incomplete "active tail" (the last block or two) is re-parsed on each
 * tick, making each update O(active_tail_size) instead of O(N).
 *
 * Safe boundary = a double-newline (\n\n) that is:
 *  - Not inside an open code fence (odd count of ``` backticks)
 *  - Not at the end of a list item (the list might gain more items, and
 *    splitting a loose list mid-stream produces separate <ul> elements
 *    instead of one)
 *
 * The frozen/active wrapper divs are transparent — they carry no CSS and
 * existing descendant selectors (e.g. `.sc-assistant-body p`) still match.
 */
export class StreamingMarkdownRenderer {
	private readonly _container: HTMLElement;
	private readonly _frozenEl: HTMLElement;
	private readonly _activeEl: HTMLElement;

	private _text = '';
	private _frozenBoundary = 0;
	private _frozenFenceCount = 0;

	private _renderTimer: ReturnType<typeof setTimeout> | undefined;
	private _heavyTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _renderInterval = 80;

	constructor(container: HTMLElement) {
		this._container = container;
		this._frozenEl = document.createElement('div');
		this._frozenEl.className = 'sc-md-frozen';
		this._activeEl = document.createElement('div');
		this._activeEl.className = 'sc-md-active';
		this._container.appendChild(this._frozenEl);
		this._container.appendChild(this._activeEl);
	}

	get text(): string { return this._text; }

	update(chunk: string): void {
		if (!chunk) { return; }
		this._text += chunk;
		this._scheduleRender();
	}

	/** Flush a pending paint so the final text appears immediately on turn end. */
	flush(): void {
		if (this._renderTimer) {
			clearTimeout(this._renderTimer);
			this._renderTimer = undefined;
		}
		const remaining = this._text.slice(this._frozenBoundary);
		if (remaining) {
			this._frozenEl.insertAdjacentHTML('beforeend', renderMarkdown(remaining));
			this._frozenFenceCount += (remaining.match(/```/g) || []).length;
			this._frozenBoundary = this._text.length;
		}
		this._activeEl.innerHTML = '';
		this._scheduleHeavyRender();
	}

	dispose(): void {
		if (this._renderTimer) { clearTimeout(this._renderTimer); }
		if (this._heavyTimer) { clearTimeout(this._heavyTimer); }
	}

	// ── Internal ──

	private _scheduleRender(): void {
		if (this._renderTimer) { return; }
		this._renderTimer = setTimeout(() => {
			this._renderTimer = undefined;
			this._render();
		}, this._renderInterval);
	}

	private _render(): void {
		const boundary = this._findSafeBoundary();
		if (boundary > this._frozenBoundary) {
			const newlyFrozen = this._text.slice(this._frozenBoundary, boundary);
			this._frozenEl.insertAdjacentHTML('beforeend', renderMarkdown(newlyFrozen));
			this._frozenFenceCount += (newlyFrozen.match(/```/g) || []).length;
			this._frozenBoundary = boundary;
		}
		this._activeEl.innerHTML = renderMarkdown(this._text.slice(this._frozenBoundary));
		this._scheduleHeavyRender();
	}

	private _scheduleHeavyRender(): void {
		if (this._heavyTimer) { clearTimeout(this._heavyTimer); }
		this._heavyTimer = setTimeout(() => {
			this._heavyTimer = undefined;
			renderMermaidDiagrams(this._container).then(() => {
				// Mermaid SVGs are now in the DOM — dispatch after layout.
				// bubbles: true so the event reaches the listener on .sc-messages.
				requestAnimationFrame(() => {
					this._container.dispatchEvent(new CustomEvent('sc:heavy-render-done', { bubbles: true }));
				});
			});
		}, 250);
	}

	/**
	 * Search backward from the end of the text for the latest safe \n\n
	 * boundary after the frozen index. Returns the frozen index if none found.
	 */
	private _findSafeBoundary(): number {
		const text = this._text;
		const from = this._frozenBoundary;

		let pos = text.length;
		while (pos > from) {
			const idx = text.lastIndexOf('\n\n', pos - 1);
			if (idx < 0 || idx < from) { break; }

			// Count ``` only in the new chunk (frozen count tracked separately → O(chunk) not O(N))
			const chunk = text.slice(from, idx);
			const totalFences = this._frozenFenceCount + (chunk.match(/```/g) || []).length;
			if (totalFences % 2 !== 0) {
				pos = idx;            // inside an open code fence
				continue;
			}

			if (this._endsWithListItem(chunk)) {
				pos = idx;            // list might gain more items
				continue;
			}

			return idx + 2;           // include the \n\n in the frozen chunk
		}

		return this._frozenBoundary;
	}

	/** True if the last non-empty line of `chunk` is a markdown list marker. */
	private _endsWithListItem(chunk: string): boolean {
		const trimmed = chunk.trimEnd();
		if (!trimmed) { return false; }
		const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
		return /^[-*+]\s/.test(lastLine) || /^\d+\.\s/.test(lastLine);
	}
}
