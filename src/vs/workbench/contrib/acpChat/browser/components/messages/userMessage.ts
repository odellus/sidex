import { Component } from '../base.js';
import { StreamingMarkdownRenderer } from '../streamingMarkdown.js';
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
	private _mdRenderer: StreamingMarkdownRenderer;
	private _contentEl: HTMLElement;

	constructor() {
		super('div', 'sc-user-msg');
		this._contentEl = this.append('div', 'sc-user-msg-content');
		this._mdRenderer = new StreamingMarkdownRenderer(this._contentEl);
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

		this._mdRenderer.update(text);
		this._mdRenderer.flush();
	}

	stopStreaming(): void {
		this._mdRenderer.flush();
	}

	override dispose(): void {
		this._mdRenderer.dispose();
		super.dispose();
	}
}
