import { Component, $, DOM } from '../base.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { renderMarkdown, renderMermaidDiagrams, renderCodeBlocks } from '../markdownRenderer.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { AcpNotification } from '../../acp-utils.js';

export class ThinkingBlock extends Component {
	private readonly _headerEl: HTMLElement;
	private readonly _contentEl: HTMLElement;
	private readonly _indicatorEl: HTMLElement;
	private readonly _elapsedEl: HTMLElement;
	private readonly _chevronEl: HTMLElement;
	private _streaming = false;
	private _collapsed = false;
	private _startTime = Date.now();
	private _timerHandle: ReturnType<typeof setInterval> | null = null;
	private _text = '';
	private _renderTimer: ReturnType<typeof setTimeout> | undefined;
	private _codeBlockDisposables: DisposableStore = new DisposableStore();
	private readonly _instantiationService: IInstantiationService;

	constructor(instantiationService: IInstantiationService) {
		super('div', 'sc-thinking-block');
		this._instantiationService = instantiationService;

		this._headerEl = this.append('div', 'sc-thinking-header');
		this._headerEl.onclick = () => this._toggle();

		const left = DOM.append(this._headerEl, $('span.sc-thinking-header-left'));

		this._indicatorEl = DOM.append(left, $('span.sc-thinking-indicator'));
		DOM.append(left, $('span.sc-thinking-label')).textContent = 'thinking';

		this._elapsedEl = DOM.append(this._headerEl, $('span.sc-thinking-elapsed'));

		this._chevronEl = DOM.append(this._headerEl, $('span.sc-thinking-chevron'));
		this._chevronEl.textContent = '▾';

		this._contentEl = this.append('div', 'sc-thinking-content');
	}

	appendNotification(notification: AcpNotification): void {
		const update = notification.data.update;
		const content = update.content as { text?: string } | undefined;
		const text = content?.text || '';
		this._text += text;

		if (!this._codeBlockDisposables.isDisposed) {
			this._codeBlockDisposables.clear();
		}
		this._contentEl.innerHTML = renderMarkdown(this._text);

		if (this._renderTimer) { clearTimeout(this._renderTimer); }
		this._renderTimer = setTimeout(() => {
			renderMermaidDiagrams(this._contentEl);
			if (!this._codeBlockDisposables.isDisposed) {
				this._codeBlockDisposables.dispose();
			}
			this._codeBlockDisposables = renderCodeBlocks(this._contentEl, this._instantiationService);
		}, 200);

		if (!this._streaming) {
			this.startStreaming();
		}
	}

	startStreaming(): void {
		this._streaming = true;
		this._startTime = Date.now();
		this.element.classList.add('streaming');
		this._timerHandle = setInterval(() => this._updateElapsed(), 1000);
		this._updateElapsed();
	}

	stopStreaming(): void {
		this._streaming = false;
		this.element.classList.remove('streaming');
		if (this._timerHandle) {
			clearInterval(this._timerHandle);
			this._timerHandle = null;
		}
		this._updateElapsed();
		// Auto-collapse after thinking is complete
		this._collapse();
	}

	private _toggle(): void {
		this._collapsed = !this._collapsed;
		this._contentEl.style.display = this._collapsed ? 'none' : 'block';
		this._chevronEl.textContent = this._collapsed ? '▸' : '▾';
		if (this._collapsed) {
			this.element.classList.add('collapsed');
		} else {
			this.element.classList.remove('collapsed');
		}
	}

	private _collapse(): void {
		this._collapsed = true;
		this._contentEl.style.display = 'none';
		this._chevronEl.textContent = '▸';
		this.element.classList.add('collapsed');
	}

	private _updateElapsed(): void {
		const elapsed = Math.round((Date.now() - this._startTime) / 1000);
		if (elapsed < 60) {
			this._elapsedEl.textContent = `(${elapsed}s)`;
		} else {
			const m = Math.floor(elapsed / 60);
			const s = elapsed % 60;
			this._elapsedEl.textContent = s > 0 ? `(${m}m ${s}s)` : `(${m}m)`;
		}
	}

	override dispose(): void {
		if (this._timerHandle) {
			clearInterval(this._timerHandle);
			this._timerHandle = null;
		}
		if (this._renderTimer) {
			clearTimeout(this._renderTimer);
		}
		if (!this._codeBlockDisposables.isDisposed) {
			this._codeBlockDisposables.dispose();
		}
		super.dispose();
	}
}
