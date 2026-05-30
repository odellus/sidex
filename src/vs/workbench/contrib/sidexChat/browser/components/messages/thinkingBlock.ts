import { Component, $, DOM, escapeHtml } from '../base.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';

export class ThinkingBlock extends Component {
	private readonly _headerEl: HTMLElement;
	private readonly _contentEl: HTMLElement;
	private readonly _indicatorEl: HTMLElement;
	private readonly _elapsedEl: HTMLElement;
	private readonly _chevronEl: HTMLElement;
	private _expanded = false;
	private _streaming = false;
	private _startTime = Date.now();
	private _timerHandle: ReturnType<typeof setInterval> | null = null;

	constructor() {
		super('div', 'sc-thinking-block');

		this._headerEl = this.append('div', 'sc-thinking-header');
		const left = DOM.append(this._headerEl, $('span.sc-thinking-header-left'));

		this._chevronEl = document.createElement('span');
		this._chevronEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
		this._chevronEl.classList.add('sc-collapsible-chevron');
		left.appendChild(this._chevronEl);

		this._indicatorEl = DOM.append(left, $('span.sc-thinking-indicator'));
		DOM.append(left, $('span.sc-thinking-label')).textContent = 'Thinking';

		this._elapsedEl = DOM.append(this._headerEl, $('span.sc-thinking-elapsed'));

		this._contentEl = this.append('div', 'sc-thinking-content');

		this.on(this._headerEl, 'click', () => this._toggle());
	}

	startStreaming(): void {
		this._streaming = true;
		this._startTime = Date.now();
		this.element.classList.add('streaming');
		this._timerHandle = setInterval(() => this._updateElapsed(), 1000);
		this._updateElapsed();
	}

	appendContent(text: string): void {
		const escaped = escapeHtml(text);
		this._contentEl.innerHTML += escaped.replace(/\n/g, '<br>');

		if (this._expanded) {
			this._contentEl.scrollTop = this._contentEl.scrollHeight;
		}
	}

	stopStreaming(): void {
		this._streaming = false;
		this.element.classList.remove('streaming');
		if (this._timerHandle) {
			clearInterval(this._timerHandle);
			this._timerHandle = null;
		}
		this._updateElapsed();
	}

	setFullContent(text: string): void {
		this._contentEl.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
	}

	private _toggle(): void {
		this._expanded = !this._expanded;
		this.element.classList.toggle('expanded', this._expanded);
	}

	private _updateElapsed(): void {
		const elapsed = Math.round((Date.now() - this._startTime) / 1000);
		if (elapsed < 60) {
			this._elapsedEl.textContent = `${elapsed}s`;
		} else {
			const m = Math.floor(elapsed / 60);
			const s = elapsed % 60;
			this._elapsedEl.textContent = s > 0 ? `${m}m ${s}s` : `${m}m`;
		}
	}

	override dispose(): void {
		if (this._timerHandle) {
			clearInterval(this._timerHandle);
			this._timerHandle = null;
		}
		super.dispose();
	}
}
