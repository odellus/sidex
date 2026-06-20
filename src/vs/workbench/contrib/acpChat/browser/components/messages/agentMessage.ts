import { Component, DOM, $ } from '../base.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { StreamingMarkdownRenderer } from '../streamingMarkdown.js';
import type { AcpNotification } from '../../acp-utils.js';

export class AgentMessageGroup extends Component {
	private _mdRenderer: StreamingMarkdownRenderer;
	private _bodyEl: HTMLElement;
	private _streaming = false;

	constructor() {
		super('div', 'sc-agent-msg');

		this._bodyEl = this.append('div', 'sc-assistant-body');
		this._mdRenderer = new StreamingMarkdownRenderer(this._bodyEl);

		// Three-dot menu (right side, hover)
		const menuBtn = this.append('div', 'sc-msg-menu');
		const dots = DOM.append(menuBtn, $('button.sc-msg-menu-btn'));
		dots.title = 'Copy';
		const dotsIcon = document.createElement('span');
		dotsIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.ellipsis));
		dots.appendChild(dotsIcon);
		this.on(dots, 'click', () => {
			if (this._mdRenderer.text) {
				navigator.clipboard.writeText(this._mdRenderer.text).catch(() => { /* */ });
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
		this._streaming = true;
		this._mdRenderer.update(content?.text || '');
	}

	stopStreaming(): void {
		this._streaming = false;
		this._mdRenderer.flush();
	}

	override dispose(): void {
		this._mdRenderer.dispose();
		super.dispose();
	}
}
