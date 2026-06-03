import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';

export type ActionType = 'copy' | 'thumbsUp' | 'thumbsDown';

export class MessageActions extends Component {
	private readonly _onAction = this._register(new Emitter<ActionType>());
	readonly onAction: Event<ActionType> = this._onAction.event;

	constructor() {
		super('div', 'sc-msg-actions');

		this._addBtn('📋', 'Copy', 'copy');
		this._addBtn('👍', 'Good response', 'thumbsUp');
		this._addBtn('👎', 'Bad response', 'thumbsDown');
	}

	private _addBtn(icon: string, title: string, action: ActionType): void {
		const btn = DOM.append(this.element, $('button.sc-action-btn'));
		btn.innerHTML = icon;
		btn.title = title;
		this.on(btn, 'click', () => this._onAction.fire(action));
	}
}
