import { Component, DOM, $, formatTokens, formatCost } from '../base.js';
import { ConnectionStatus } from '../../acpStore.js';

export class StatusBar extends Component {
	private _dotEl: HTMLElement;
	private _textEl: HTMLElement;
	private _tokensEl: HTMLElement;
	private _costEl: HTMLElement;

	constructor() {
		super('div', 'sc-statusbar');

		const left = this.append('div', 'sc-statusbar-left');
		this._dotEl = DOM.append(left, $('span.sc-status-dot.disconnected'));
		this._textEl = DOM.append(left, $('span'));
		this._textEl.textContent = 'Disconnected';

		const right = this.append('div', 'sc-statusbar-right');
		this._tokensEl = DOM.append(right, $('span.sc-status-tokens'));
		this._tokensEl.textContent = '0 context';
		this._costEl = DOM.append(right, $('span.sc-status-cost'));
		this._costEl.textContent = '$0.0000';
	}

	setConnectionState(state: ConnectionStatus): void {
		this._dotEl.className = 'sc-status-dot';
		switch (state) {
			case 'connected':
				this._dotEl.classList.add('connected');
				this._textEl.textContent = 'Connected';
				break;
			case 'connecting':
				this._dotEl.classList.add('connecting');
				this._textEl.textContent = 'Connecting...';
				break;
			case 'disconnected':
				this._dotEl.classList.add('disconnected');
				this._textEl.textContent = 'Disconnected';
				break;
		}
	}

	updateTokens(input: number, output: number): void {
		this._tokensEl.textContent = `${formatTokens(input + output)} context`;
	}

	updateCost(cost: number): void {
		this._costEl.textContent = formatCost(cost);
	}

	reset(): void {
		this._tokensEl.textContent = '0 context';
		this._costEl.textContent = '$0.0000';
	}
}
