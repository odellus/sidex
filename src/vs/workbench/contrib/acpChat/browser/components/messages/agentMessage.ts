import { Component, DOM, $ } from '../base.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { renderMarkdown, renderMermaidDiagrams } from '../markdownRenderer.js';
import type { AcpNotification } from '../../acp-utils.js';

export class AgentMessageGroup extends Component {
	private _text = '';
	private _bodyEl: HTMLElement;
	private _streaming = false;
	private _mermaidTimer: ReturnType<typeof setTimeout> | undefined;

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
		const text = content?.text || '';
		this._text += text;
		this._bodyEl.innerHTML = renderMarkdown(this._text);
		this._streaming = true;
		// Defer mermaid rendering until DOM is ready
		if (this._mermaidTimer) { clearTimeout(this._mermaidTimer); }
		this._mermaidTimer = setTimeout(() => renderMermaidDiagrams(this._bodyEl), 200);
	}

	stopStreaming(): void {
		this._streaming = false;
	}
}
