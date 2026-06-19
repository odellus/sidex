import { Component, DOM, $ } from '../base.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { renderMarkdown, renderMermaidDiagrams } from '../markdownRenderer.js';
import type { AcpNotification } from '../../acp-utils.js';

export class AgentMessageGroup extends Component {
	private _text = '';
	private _bodyEl: HTMLElement;
	private _streaming = false;
	/** Throttles the markdown reparse during streaming (was per-token → O(n²)). */
	private _renderTimer: ReturnType<typeof setTimeout> | undefined;
	/** Debounces expensive mermaid rendering until streaming settles. */
	private _heavyTimer: ReturnType<typeof setTimeout> | undefined;

	constructor() {
		super('div', 'sc-agent-msg');

		this._bodyEl = this.append('div', 'sc-assistant-body');

		// Three-dot menu (right side, hover)
		const menuBtn = this.append('div', 'sc-msg-menu');
		const dots = DOM.append(menuBtn, $('button.sc-msg-menu-btn'));
		dots.title = 'Copy';
		const dotsIcon = document.createElement('span');
		dotsIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.ellipsis));
		dots.appendChild(dotsIcon);
		this.on(dots, 'click', () => {
			if (this._text) {
				navigator.clipboard.writeText(this._text).catch(() => { /* */ });
				dots.textContent = '✓';
				setTimeout(() => {
					dots.textContent = '';
					dots.appendChild(dotsIcon);
				}, 1200);
			}
		});
	}

	appendNotification(notification: AcpNotification): void {
		const update = notification.data.update;
		const content = update.content as { text?: string } | undefined;
		this._text += content?.text || '';
		this._streaming = true;
		// Always accumulate text, but repaint on a throttle — per-token parsing of
		// the whole accumulated message was the streaming freeze.
		this._scheduleMarkdownRender();
	}

	/** Throttle markdown parse + innerHTML to ~80ms during streaming. */
	private _scheduleMarkdownRender(): void {
		if (this._renderTimer) { return; }
		this._renderTimer = setTimeout(() => {
			this._renderTimer = undefined;
			this._bodyEl.innerHTML = renderMarkdown(this._text);
			this._scheduleHeavyRender();
		}, 80);
	}

	/** Debounce expensive mermaid rendering until streaming settles. */
	private _scheduleHeavyRender(): void {
		if (this._heavyTimer) { clearTimeout(this._heavyTimer); }
		this._heavyTimer = setTimeout(() => {
			renderMermaidDiagrams(this._bodyEl);
		}, 250);
	}

	/** Flush a pending paint so the final text appears immediately on turn end. */
	private _flushRender(): void {
		if (this._renderTimer) {
			clearTimeout(this._renderTimer);
			this._renderTimer = undefined;
			this._bodyEl.innerHTML = renderMarkdown(this._text);
			this._scheduleHeavyRender();
		}
	}

	stopStreaming(): void {
		this._streaming = false;
		this._flushRender();
	}

	override dispose(): void {
		if (this._renderTimer) { clearTimeout(this._renderTimer); }
		if (this._heavyTimer) { clearTimeout(this._heavyTimer); }
		super.dispose();
	}
}
