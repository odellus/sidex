import { Component } from '../base.js';
import { renderMarkdown } from '../markdownRenderer.js';
import type { AcpNotification } from '../../acp-utils.js';

export class UserMessage extends Component {
	private _text = '';
	private _contentEl: HTMLElement;

	constructor() {
		super('div', 'sc-user-msg');
		this._contentEl = this.append('div', 'sc-user-msg-content');
	}

	appendNotification(notification: AcpNotification): void {
		const update = notification.data.update;
		const content = update.content as { text?: string } | undefined;
		const text = content?.text || '';
		this._text += text;
		this._contentEl.innerHTML = renderMarkdown(this._text);
	}

	stopStreaming(): void {
		// No-op
	}
}
