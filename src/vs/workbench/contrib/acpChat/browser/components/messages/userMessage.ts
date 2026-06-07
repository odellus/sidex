import { Component } from '../base.js';
import { renderMarkdown } from '../markdownRenderer.js';
import type { AcpNotification } from '../../acp-utils.js';

interface ContentBlock {
	type: string;
	text?: string;
	uri?: string;
	name?: string;
	mimeType?: string;
	data?: string;
}

export class UserMessage extends Component {
	private _text = '';
	private _contentEl: HTMLElement;

	constructor() {
		super('div', 'sc-user-msg');
		this._contentEl = this.append('div', 'sc-user-msg-content');
	}

	appendNotification(notification: AcpNotification): void {
		const update = notification.data.update;
		const content = update.content as { text?: string; blocks?: ContentBlock[] } | undefined;

		// Use text field if available, otherwise reconstruct from blocks
		let text = content?.text || '';
		if (!text && content?.blocks) {
			text = content.blocks.map(b => {
				if (b.type === 'text') return b.text || '';
				if (b.type === 'image') {
					if (b.data && b.mimeType) {
						return `![Image](data:${b.mimeType};base64,${b.data})`;
					}
					return '![Image]';
				}
				if (b.type === 'resource_link') return `[@${b.name || 'link'}](${b.uri || ''})`;
				return '';
			}).join('');
		}

		this._text += text;
		this._contentEl.innerHTML = renderMarkdown(this._text);
	}

	stopStreaming(): void {
		// No-op
	}
}
