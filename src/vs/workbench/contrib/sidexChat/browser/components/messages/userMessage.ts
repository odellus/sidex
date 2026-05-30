import { Component } from '../base.js';
import { IChatMessage } from '../../sidexChatService.js';

export class UserMessage extends Component {
	constructor(msg: IChatMessage) {
		super('div', 'sc-user-msg');
		const contentEl = this.append('div', 'sc-user-msg-content');
		contentEl.textContent = msg.content;
	}
}
