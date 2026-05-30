import { Component, $, DOM } from '../base.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';

export class Collapsible extends Component {
	private _headerEl: HTMLElement;
	private _bodyEl: HTMLElement;
	private _labelEl: HTMLElement;
	private _expanded = false;

	constructor(label: string) {
		super('div', 'sc-collapsible');

		this._headerEl = this.append('div', 'sc-collapsible-header');
		const left = DOM.append(this._headerEl, $('span.sc-collapsible-left'));

		// Chevron icon (codicon)
		const chevron = document.createElement('span');
		chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
		chevron.classList.add('sc-collapsible-chevron');
		left.appendChild(chevron);

		this._labelEl = DOM.append(left, $('span.sc-collapsible-label'));
		this._labelEl.textContent = label;

		this._bodyEl = this.append('div', 'sc-collapsible-body');

		this.on(this._headerEl, 'click', () => this.toggle());
	}

	get body(): HTMLElement { return this._bodyEl; }

	setLabel(label: string): void {
		this._labelEl.textContent = label;
	}

	toggle(force?: boolean): void {
		this._expanded = force ?? !this._expanded;
		this.toggleClass('expanded', this._expanded);
	}

	expand(): void { this.toggle(true); }
	collapse(): void { this.toggle(false); }
}
