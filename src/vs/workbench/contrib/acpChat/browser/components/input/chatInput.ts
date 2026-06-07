import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { RichTextEditor } from './richTextEditor.js';
import type { ContentBlock } from '@agentclientprotocol/sdk';

export type AgentMode = 'agent' | 'plan' | 'ask';

function codicon(c: ThemeIcon): HTMLSpanElement {
	const el = document.createElement('span');
	el.classList.add(...ThemeIcon.asClassNameArray(c));
	return el;
}

export class ChatInput extends Component {
	private _richEditor: RichTextEditor;
	private _sendBtn: HTMLElement;
	private _stopBtn: HTMLElement;
	private _modeLabel: HTMLElement;
	private _modelLabel: HTMLElement;
	private _modeMenu: HTMLElement;
	private _currentMode: AgentMode = 'agent';
	private _currentModel = '';

	private readonly _onSend = this._register(new Emitter<string>());
	readonly onSend: Event<string> = this._onSend.event;

	private readonly _onSendBlocks = this._register(new Emitter<ContentBlock[]>());
	readonly onSendBlocks: Event<ContentBlock[]> = this._onSendBlocks.event;

	private readonly _onStop = this._register(new Emitter<void>());
	readonly onStop: Event<void> = this._onStop.event;

	private readonly _onModeChange = this._register(new Emitter<AgentMode>());
	readonly onModeChange: Event<AgentMode> = this._onModeChange.event;

	private readonly _onModelChange = this._register(new Emitter<string>());
	readonly onModelChange: Event<string> = this._onModelChange.event;

	get mode(): AgentMode { return this._currentMode; }

	constructor(workspaceRoot: string = '') {
		super('div', 'sc-input-area');

		const container = this.append('div', 'sc-input-container');

		// Rich text editor
		this._richEditor = new RichTextEditor('Ask anything...', workspaceRoot);
		container.appendChild(this._richEditor.element);
		this._disposables.add(this._richEditor);

		const footer = DOM.append(container, $('div.sc-input-footer'));
		const left = DOM.append(footer, $('div.sc-input-footer-left'));
		const right = DOM.append(footer, $('div.sc-input-footer-right'));

		// Mode dropdown — icon + "Agent" + chevron
		const modeBtn = DOM.append(left, $('button.sc-mode-dropdown'));
		const modeIconEl = DOM.append(modeBtn, $('span.sc-mode-icon'));
		modeIconEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><g stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><line x1="10" y1="3" x2="10" y2="4"/><line x1="6.5" y1="3.9378" x2="7" y2="4.8038"/><line x1="3.9378" y1="6.5" x2="4.8038" y2="7"/><line x1="3" y1="10" x2="4" y2="10"/><line x1="3.9378" y1="13.5" x2="4.8038" y2="13"/><line x1="6.5" y1="16.0622" x2="7" y2="15.1962"/><line x1="10" y1="17" x2="10" y2="16"/><line x1="13.5" y1="16.0622" x2="13" y2="15.1962"/><line x1="16.0622" y1="13.5" x2="15.1962" y2="13"/><line x1="17" y1="10" x2="16" y2="10"/><line x1="16.0622" y1="6.5" x2="15.1962" y2="7"/><line x1="13.5" y1="3.9378" x2="13" y2="4.8038"/></g></svg>';
		this._modeLabel = DOM.append(modeBtn, $('span.sc-mode-label'));
		this._modeLabel.textContent = 'Agent';
		const modeChevEl = document.createElement('span');
		modeChevEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown), 'codicon-sm');
		modeBtn.appendChild(modeChevEl);

		// Mode dropdown menu
		this._modeMenu = DOM.append(this.element, $('div.sc-mode-menu'));
		for (const mode of ['agent', 'plan', 'ask'] as AgentMode[]) {
			const item = DOM.append(this._modeMenu, $('div.sc-mode-menu-item'));
			item.dataset.mode = mode;
			item.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
			if (mode === 'agent') { item.classList.add('active'); }
			this.on(item, 'click', () => {
				this._setMode(mode);
				this._modeMenu.classList.remove('visible');
			});
		}
		this.on(modeBtn, 'click', () => {
			const isOpening = !this._modeMenu.classList.contains('visible');
			this._modeMenu.classList.toggle('visible');
			if (isOpening) {
				modeIconEl.classList.add('spin');
				setTimeout(() => modeIconEl.classList.remove('spin'), 400);
			}
		});
		this.on(document.body, 'click', (e) => {
			if (!modeBtn.contains(e.target as Node) && !this._modeMenu.contains(e.target as Node)) {
				this._modeMenu.classList.remove('visible');
			}
		});

		// Model dropdown — populated dynamically from server
		const modelBtn = DOM.append(left, $('button.sc-model-btn'));
		this._modelLabel = DOM.append(modelBtn, $('span'));
		this._modelLabel.textContent = '';
		const modelChevEl = document.createElement('span');
		modelChevEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown), 'codicon-sm');
		modelBtn.appendChild(modelChevEl);

		// Model dropdown menu
		const modelMenu = DOM.append(this.element, $('div.sc-model-menu'));
		this.on(modelBtn, 'click', () => modelMenu.classList.toggle('visible'));
		this.on(document.body, 'click', (e) => {
			if (!modelBtn.contains(e.target as Node) && !modelMenu.contains(e.target as Node)) {
				modelMenu.classList.remove('visible');
			}
		});
		// Prevent scroll wheel from closing the menu
		this.on(modelMenu, 'wheel', (e) => {
			e.stopPropagation();
		});

		// Attach button — folder icon
		const attachBtn = DOM.append(right, $('button.sc-input-icon-btn'));
		attachBtn.title = 'Attach';
		attachBtn.appendChild(codicon(Codicon.folder));

		// Send button — custom SVG (circle + up arrow)
		this._sendBtn = DOM.append(right, $('button.sc-send-btn'));
		this._sendBtn.title = 'Send';
		this._sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M4.14645 6.14645L6.64645 3.64645C6.84171 3.45118 7.15829 3.45118 7.35355 3.64645L9.8536 6.14645C10.0488 6.34171 10.0488 6.65829 9.8536 6.85355C9.6583 7.04882 9.3417 7.04882 9.1464 6.85355L8.3232 6.03033L7.5 5.20711V10C7.5 10.2761 7.27614 10.5 7 10.5C6.72386 10.5 6.5 10.2761 6.5 10V5.20711L4.85355 6.85355C4.65829 7.04882 4.34171 7.04882 4.14645 6.85355C3.95118 6.65829 3.95118 6.34171 4.14645 6.14645ZM7 0C3.13401 0 0 3.13401 0 7C0 10.866 3.13401 14 7 14C10.866 14 14 10.866 14 7C14 3.13401 10.866 0 7 0Z"/></svg>';

		// Stop button — custom SVG (circle + square)
		this._stopBtn = DOM.append(right, $('button.sc-stop-btn'));
		this._stopBtn.title = 'Stop';
		this._stopBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M5 4C4.44772 4 4 4.44772 4 5V9C4 9.5523 4.44772 10 5 10H9C9.5523 10 10 9.5523 10 9V5C10 4.44772 9.5523 4 9 4H5ZM0 7C0 3.13401 3.13401 0 7 0C10.866 0 14 3.13401 14 7C14 10.866 10.866 14 7 14C3.13401 14 0 10.866 0 7Z"/></svg>';
		this._stopBtn.style.display = 'none';

		// Listen to rich editor events
		this._disposables.add(this._richEditor.onSend(({ blocks, text }) => {
			this._sendBtn.classList.add('disabled');
			this._onSendBlocks.fire(blocks);
			this._onSend.fire(text || '');
		}));

		this._disposables.add(this._richEditor.onUpdate(() => {
			const hasContent = this._richEditor.hasContent;
			this._sendBtn.classList.toggle('disabled', !hasContent);
		}));

		// Keyboard shortcuts
		this.on(this._richEditor.element, 'keydown', (e) => {
			const ke = e as KeyboardEvent;
			if (ke.key === 'Enter' && !ke.shiftKey) {
				ke.preventDefault();
				this._doSend();
			}
		});

		this.on(this._sendBtn, 'click', () => this._doSend());
		this._sendBtn.classList.add('disabled');
		this.on(this._stopBtn, 'click', () => this._onStop.fire());
	}

	focus(): void { this._richEditor.focus(); }

	setStreaming(streaming: boolean): void {
		this._sendBtn.style.display = streaming ? 'none' : 'flex';
		this._stopBtn.style.display = streaming ? 'flex' : 'none';
	}

	setMode(mode: AgentMode): void {
		this._currentMode = mode;
		this._modeLabel.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
		this._modeMenu.querySelectorAll('.sc-mode-menu-item').forEach(item => {
			(item as HTMLElement).classList.toggle('active', (item as HTMLElement).dataset.mode === mode);
		});
	}

	/** Set the model name shown in the footer. Called by the view when server info arrives. */
	setModel(model: string): void {
		this._currentModel = model;
		const short = model
			.replace(/^us\.anthropic\./, '')
			.replace(/-\d{8}-v\d+:\d+$/, '')
			.replace(/-v\d+:\d+$/, '');
		this._modelLabel.textContent = short || model;
	}

	getModel(): string { return this._currentModel; }

	/** Populate the model dropdown with models from the server. */
	setAvailableModels(models: Array<{ id: string; name: string }>): void {
		const menu = this.element.querySelector('.sc-model-menu');
		if (!menu) { return; }
		menu.innerHTML = '';
		for (const m of models) {
			const item = document.createElement('div');
			item.className = 'sc-model-menu-item';
			item.dataset.modelId = m.id;
			item.textContent = m.name;
			if (m.id === this._currentModel) { item.classList.add('active'); }
			this.on(item, 'click', () => {
				this.setModel(m.id);
				this._onModelChange.fire(m.id);
				menu.classList.remove('visible');
				menu.querySelectorAll('.sc-model-menu-item').forEach(el =>
					(el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.modelId === m.id)
				);
			});
			menu.appendChild(item);
		}
	}

	private _setMode(mode: AgentMode): void {
		this.setMode(mode);
		this._onModeChange.fire(mode);
	}

	private _doSend(): void {
		this._richEditor.send();
	}
}
