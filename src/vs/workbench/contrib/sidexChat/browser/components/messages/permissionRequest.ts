/*---------------------------------------------------------------------------------------------
 *  Permission Request Dialog — shown when the server asks for tool approval
 *--------------------------------------------------------------------------------------------*/

import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';

export interface PermissionRequestData {
	toolCallId: string;
	toolName: string;
	args?: Record<string, unknown>;
}

export interface PermissionResult {
	toolCallId: string;
	approved: boolean;
	alwaysAllow: boolean;
}

const TOOL_LABELS: Record<string, string> = {
	shell: 'Run shell command',
	run_background: 'Run background process',
	kill_shell: 'Kill process',
	write_file: 'Write file',
	edit_file: 'Edit file',
	multi_edit: 'Multi-file edit',
	patch_file: 'Patch file',
	regex_replace: 'Regex replace',
	notebook_edit: 'Edit notebook',
	git_commit: 'Git commit',
	repl: 'Run REPL command',
	powershell: 'Run PowerShell',
	enter_worktree: 'Enter worktree',
	exit_worktree: 'Exit worktree',
	team_create: 'Create team',
	team_delete: 'Delete team',
};

export class PermissionRequestDialog extends Component {
	private readonly _onRespond = this._register(new Emitter<PermissionResult>());
	readonly onRespond: Event<PermissionResult> = this._onRespond.event;

	private _alwaysAllowCheckbox!: HTMLInputElement;

	constructor(data: PermissionRequestData) {
		super('div', 'sc-permission-dialog');

		const shield = this.append('div', 'sc-permission-icon');
		const shieldIcon = document.createElement('span');
		shieldIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.shield));
		shield.appendChild(shieldIcon);

		const label = TOOL_LABELS[data.toolName] || data.toolName;
		this.appendText('div', `Permission required: ${label}`, 'sc-permission-title');

		const toolEl = this.append('div', 'sc-permission-tool');
		const nameSpan = document.createElement('span');
		nameSpan.className = 'sc-permission-tool-name';
		nameSpan.textContent = data.toolName;
		toolEl.appendChild(nameSpan);

		if (data.args && Object.keys(data.args).length > 0) {
			const argsEl = this.append('div', 'sc-permission-args');
			const preview = this._formatArgs(data.toolName, data.args);
			const pre = document.createElement('pre');
			pre.textContent = preview;
			argsEl.appendChild(pre);
		}

		const checkRow = this.append('label', 'sc-permission-always');
		this._alwaysAllowCheckbox = document.createElement('input');
		this._alwaysAllowCheckbox.type = 'checkbox';
		this._alwaysAllowCheckbox.className = 'sc-permission-checkbox';
		checkRow.appendChild(this._alwaysAllowCheckbox);
		const checkLabel = document.createElement('span');
		checkLabel.textContent = `Always allow ${data.toolName} this session`;
		checkRow.appendChild(checkLabel);

		const buttons = this.append('div', 'sc-permission-buttons');

		const denyBtn = DOM.append(buttons, $('button.sc-permission-btn.sc-permission-deny'));
		denyBtn.textContent = 'Deny';
		this.on(denyBtn, 'click', () => {
			this._onRespond.fire({
				toolCallId: data.toolCallId,
				approved: false,
				alwaysAllow: false,
			});
			this._fadeOut();
		});

		const allowBtn = DOM.append(buttons, $('button.sc-permission-btn.sc-permission-allow'));
		allowBtn.textContent = 'Allow';
		this.on(allowBtn, 'click', () => {
			this._onRespond.fire({
				toolCallId: data.toolCallId,
				approved: true,
				alwaysAllow: this._alwaysAllowCheckbox.checked,
			});
			this._fadeOut();
		});

		// Focus the allow button so Enter approves quickly
		requestAnimationFrame(() => allowBtn.focus());
	}

	private _formatArgs(toolName: string, args: Record<string, unknown>): string {
		if (toolName === 'shell' || toolName === 'run_background' || toolName === 'repl' || toolName === 'powershell') {
			const cmd = args['command'] || args['cmd'] || '';
			return typeof cmd === 'string' ? cmd : JSON.stringify(cmd, null, 2);
		}
		if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'patch_file') {
			const path = args['path'] || args['file_path'] || '';
			return typeof path === 'string' ? path : JSON.stringify(args, null, 2);
		}
		if (toolName === 'git_commit') {
			const msg = args['message'] || '';
			return typeof msg === 'string' ? `commit: ${msg}` : JSON.stringify(args, null, 2);
		}
		const keys = Object.keys(args);
		if (keys.length <= 3) {
			return keys.map(k => `${k}: ${JSON.stringify(args[k])}`).join('\n');
		}
		return JSON.stringify(args, null, 2).slice(0, 500);
	}

	private _fadeOut(): void {
		this.element.classList.add('sc-permission-exit');
		setTimeout(() => {
			this.element.remove();
			this.dispose();
		}, 200);
	}
}
