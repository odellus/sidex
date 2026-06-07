import { Component, DOM, $ } from '../base.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { renderMarkdown, renderMermaidDiagrams, renderCodeBlocks } from '../markdownRenderer.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { AcpNotification } from '../../acp-utils.js';

export class AgentMessageGroup extends Component {
	private _text = '';
	private _bodyEl: HTMLElement;
	private _streaming = false;
	private _renderTimer: ReturnType<typeof setTimeout> | undefined;
	private _codeBlockDisposables: DisposableStore = new DisposableStore();
	private readonly _instantiationService: IInstantiationService;

	constructor(instantiationService: IInstantiationService) {
		super('div', 'sc-agent-msg');
		this._instantiationService = instantiationService;

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
		const text = content?.text || '';
		this._text += text;

		// Dispose old code block editors before replacing innerHTML
		if (!this._codeBlockDisposables.isDisposed) {
			this._codeBlockDisposables.clear();
		}
		this._bodyEl.innerHTML = renderMarkdown(this._text);
		this._streaming = true;

		// Debounce heavy rendering (mermaid + Monaco code blocks)
		if (this._renderTimer) { clearTimeout(this._renderTimer); }
		this._renderTimer = setTimeout(() => {
			renderMermaidDiagrams(this._bodyEl);
			// Dispose previous code block editors, then create new ones
			if (!this._codeBlockDisposables.isDisposed) {
				this._codeBlockDisposables.dispose();
			}
			this._codeBlockDisposables = renderCodeBlocks(this._bodyEl, this._instantiationService);
		}, 200);
	}

	stopStreaming(): void {
		this._streaming = false;
	}

	override dispose(): void {
		if (this._renderTimer) { clearTimeout(this._renderTimer); }
		if (!this._codeBlockDisposables.isDisposed) {
			this._codeBlockDisposables.dispose();
		}
		super.dispose();
	}
}
