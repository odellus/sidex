import { Component, $, DOM } from '../base.js';

export class Section extends Component {
	private _bodyEl: HTMLElement;
	private _labelEl: HTMLElement;

	constructor(label: string) {
		super('div', 'sc-section');

		const headerEl = this.append('div', 'sc-section-header');
		this._labelEl = DOM.append(headerEl, $('span.sc-section-label'));
		this._labelEl.textContent = label;

		this._bodyEl = this.append('div', 'sc-section-body');
	}

	get body(): HTMLElement { return this._bodyEl; }

	setLabel(label: string): void {
		this._labelEl.textContent = label;
	}
}
