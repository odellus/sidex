import { Component } from '../base.js';
import { ToolCallInfo } from './toolCallGroup.js';

export class ToolCallItem extends Component {
	readonly toolName: string;
	private _statusEl: HTMLElement;

	constructor(tc: ToolCallInfo) {
		super('div', 'sc-tool-call');
		this.toolName = tc.name;

		const nameEl = this.append('span', 'sc-tool-name');
		nameEl.textContent = tc.name;

		this._statusEl = this.append('span', 'sc-tool-status');
		this._updateStatusElement(tc.status);
	}

	updateStatus(status: string): void {
		this._updateStatusElement(status);
	}

	private _updateStatusElement(status: string): void {
		this._statusEl.className = 'sc-tool-status';
		if (status === 'running') {
			this._statusEl.textContent = 'running...';
			this._statusEl.classList.add('running');
		} else if (status === 'error') {
			this._statusEl.textContent = 'error';
			this._statusEl.classList.add('error');
		} else {
			this._statusEl.textContent = '✓';
			this._statusEl.classList.add('done');
		}
	}
}
