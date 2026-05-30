import { Component, DOM, $ } from '../base.js';
import { Collapsible } from '../collapsible/collapsible.js';

export class StepsPlanned extends Component {
	private _collapsible: Collapsible;

	constructor(steps: string[]) {
		super('div', 'sc-steps-planned');

		this._collapsible = new Collapsible(`Planned ${steps.length} step${steps.length !== 1 ? 's' : ''}`);
		this._collapsible.appendTo(this.element);
		this._register(this._collapsible);

		for (let i = 0; i < steps.length; i++) {
			const item = DOM.append(this._collapsible.body, $('div.sc-step-item'));
			item.textContent = `${i + 1}. ${steps[i]}`;
		}
	}
}
