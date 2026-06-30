import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { RichTextEditor } from './richTextEditor.js';
import type { ContentBlock } from '@agentclientprotocol/sdk';

interface AgentConfig {
	name: string;
	command: string;
	args: string[];
	env: string[];
}

export interface QueuedItem {
	id: string;
	text: string;
	blocks: ContentBlock[];
}

export interface PlanEntry {
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

function codicon(c: ThemeIcon): HTMLSpanElement {
	const el = document.createElement('span');
	el.classList.add(...ThemeIcon.asClassNameArray(c));
	return el;
}

export class ChatInput extends Component {
	private _richEditor: RichTextEditor;
	private _sendBtn: HTMLElement;
	private _stopBtn: HTMLElement;
	private _agentLabel: HTMLElement;
	private _modelLabel: HTMLElement;
	private _agentMenu: HTMLElement;
	private _currentAgent: AgentConfig | null = null;
	private _currentModel = '';
	private _queueEl: HTMLElement;
	private _planEl: HTMLElement;
	private _planExpanded: boolean = false;

	private readonly _onSend = this._register(new Emitter<string>());
	readonly onSend: Event<string> = this._onSend.event;

	private readonly _onSendBlocks = this._register(new Emitter<ContentBlock[]>());
	readonly onSendBlocks: Event<ContentBlock[]> = this._onSendBlocks.event;

	private readonly _onStop = this._register(new Emitter<void>());
	readonly onStop: Event<void> = this._onStop.event;

	private readonly _onAgentChange = this._register(new Emitter<string>());
	readonly onAgentChange: Event<string> = this._onAgentChange.event;

	private readonly _onModelChange = this._register(new Emitter<string>());
	readonly onModelChange: Event<string> = this._onModelChange.event;

	private readonly _onRemoveQueuedItem = this._register(new Emitter<number>());
	readonly onRemoveQueuedItem: Event<number> = this._onRemoveQueuedItem.event;

	private readonly _onClearQueue = this._register(new Emitter<void>());
	readonly onClearQueue: Event<void> = this._onClearQueue.event;

	private readonly _onEditQueuedItem = this._register(new Emitter<number>());
	readonly onEditQueuedItem: Event<number> = this._onEditQueuedItem.event;

	private readonly _onSendQueuedItemNow = this._register(new Emitter<number>());
	readonly onSendQueuedItemNow: Event<number> = this._onSendQueuedItemNow.event;

	constructor(workspaceRoot: string = '') {
		super('div', 'sc-input-area');

		const container = this.append('div', 'sc-input-container');

		// Queue items (above the rich text editor, like Zed)
		this._queueEl = DOM.append(container, $('div.sc-queue-items'));
		this._queueEl.style.display = 'none';

		// Plan panel (above queue, collapsible)
		this._planEl = DOM.append(container, $('div.sc-plan-panel'));
		this._planEl.style.display = 'none';

		// Rich text editor
		this._richEditor = new RichTextEditor('Ask anything...', workspaceRoot);
		container.appendChild(this._richEditor.element);
		this._disposables.add(this._richEditor);

		const footer = DOM.append(container, $('div.sc-input-footer'));
		const left = DOM.append(footer, $('div.sc-input-footer-left'));
		const right = DOM.append(footer, $('div.sc-input-footer-right'));

		// Agent dropdown — icon + agent name + chevron
		const agentBtn = DOM.append(left, $('button.sc-mode-dropdown'));
		const agentIconEl = DOM.append(agentBtn, $('span.sc-mode-icon'));
		agentIconEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><g stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="10" cy="10" r="3"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.93 4.93l1.41 1.41M13.66 13.66l1.41 1.41M4.93 15.07l1.41-1.41M13.66 6.34l1.41-1.41"/></g></svg>';
		this._agentLabel = DOM.append(agentBtn, $('span.sc-mode-label'));
		this._agentLabel.textContent = 'Agent';
		const agentChevEl = document.createElement('span');
		agentChevEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown), 'codicon-sm');
		agentBtn.appendChild(agentChevEl);

		// Agent dropdown menu
		this._agentMenu = DOM.append(this.element, $('div.sc-mode-menu'));
		this.on(agentBtn, 'click', () => {
			const isOpening = !this._agentMenu.classList.contains('visible');
			this._agentMenu.classList.toggle('visible');
			if (isOpening) {
				agentIconEl.classList.add('spin');
				setTimeout(() => agentIconEl.classList.remove('spin'), 400);
			}
		});
		this.on(document.body, 'click', (e) => {
			if (!agentBtn.contains(e.target as Node) && !this._agentMenu.contains(e.target as Node)) {
				this._agentMenu.classList.remove('visible');
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

	/** Render queued items above the editor. */
	setQueuedItems(items: QueuedItem[]): void {
		this._queueEl.innerHTML = '';

		if (items.length === 0) {
			this._queueEl.style.display = 'none';
			return;
		}

		this._queueEl.style.display = 'flex';

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const row = DOM.append(this._queueEl, $('div.sc-queue-item'));
			if (i === 0) { row.classList.add('sc-queue-next'); }

			// Status dot — accent for next, muted for others
			const dot = DOM.append(row, $('span.sc-queue-dot'));

			// Text preview
			const text = DOM.append(row, $('span.sc-queue-text'));
			text.textContent = item.text || '(empty)';

			// Action buttons
			const actions = DOM.append(row, $('div.sc-queue-actions'));

			// Edit — moves content to the rich text editor
			const editBtn = DOM.append(actions, $('button.sc-queue-btn'));
			editBtn.title = 'Edit';
			editBtn.appendChild(codicon(Codicon.edit));
			this.on(editBtn, 'click', () => this._onEditQueuedItem.fire(i));

			// Remove
			const delBtn = DOM.append(actions, $('button.sc-queue-btn'));
			delBtn.title = 'Remove from queue';
			delBtn.appendChild(codicon(Codicon.trash));
			this.on(delBtn, 'click', () => this._onRemoveQueuedItem.fire(i));

			// Send Now — cancel current turn + send this immediately
			const sendBtn = DOM.append(actions, $('button.sc-queue-send-now'));
			sendBtn.textContent = 'Send Now';
			this.on(sendBtn, 'click', () => this._onSendQueuedItemNow.fire(i));
		}
	}

	/** Load text into the rich text editor (for "Edit" action). */
	loadTextIntoEditor(text: string): void {
		this._richEditor.setContent(text);
	}

	/** Render the plan/task list panel. */
	setPlanEntries(entries: PlanEntry[]): void {
		this._planEl.innerHTML = '';

		if (entries.length === 0) {
			this._planEl.style.display = 'none';
			return;
		}

		this._planEl.style.display = 'flex';

		const completed = entries.filter(e => e.status === 'completed' || e.status === 'failed').length;
		const inProgress = entries.find(e => e.status === 'in_progress');
		const total = entries.length;

		// Summary bar (collapsible)
		const summary = DOM.append(this._planEl, $('div.sc-plan-summary'));

		const disclosure = DOM.append(summary, $('span.sc-plan-disclosure'));
		disclosure.classList.add('codicon');
		disclosure.classList.add(this._planExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right');

		const label = DOM.append(summary, $('span.sc-plan-label'));
		if (inProgress && !this._planExpanded) {
			label.textContent = `Current: ${inProgress.content}`;
			label.classList.add('sc-plan-current');
			if (total - completed > 0) {
				const badge = DOM.append(summary, $('span.sc-plan-badge'));
				badge.textContent = `${total - completed} left`;
			}
		} else {
			label.textContent = completed === total ? 'All Done' : `Plan  ${completed}/${total}`;
		}

		this.on(summary, 'click', () => {
			this._planExpanded = !this._planExpanded;
			this.setPlanEntries(entries);
		});

		// Entry rows (when expanded)
		if (this._planExpanded) {
			summary.classList.add('sc-plan-summary-expanded');
			const list = DOM.append(this._planEl, $('div.sc-plan-entries'));

			for (const entry of entries) {
				const row = DOM.append(list, $('div.sc-plan-entry'));

				const icon = DOM.append(row, $('span.sc-plan-entry-icon'));
				if (entry.status === 'in_progress') {
					icon.classList.add('codicon', 'codicon-loading', 'sc-plan-in-progress');
				} else if (entry.status === 'completed') {
					icon.classList.add('codicon', 'codicon-check', 'sc-plan-completed');
				} else if (entry.status === 'failed') {
					icon.classList.add('codicon', 'codicon-error', 'sc-plan-failed');
				} else {
					icon.classList.add('codicon', 'codicon-circle', 'sc-plan-pending');
				}

				const text = DOM.append(row, $('span.sc-plan-entry-text'));
				text.textContent = entry.content;
				if (entry.status === 'completed') {
					text.classList.add('sc-plan-strikethrough');
				}
			}
		}
	}

	/** Set the current agent. Called when agent changes. */
	setCurrentAgent(agent: AgentConfig | null): void {
		this._currentAgent = agent;
		this._agentLabel.textContent = agent?.name || 'No Agent';
		this._agentMenu.querySelectorAll('.sc-mode-menu-item').forEach(item => {
			(item as HTMLElement).classList.toggle('active', (item as HTMLElement).dataset.agentName === agent?.name);
		});
	}

	/** Populate the agent dropdown with available agents. */
	setAvailableAgents(agents: AgentConfig[]): void {
		this._agentMenu.innerHTML = '';
		for (const agent of agents) {
			const item = document.createElement('div');
			item.className = 'sc-mode-menu-item';
			item.dataset.agentName = agent.name;
			item.textContent = agent.name;
			if (agent.name === this._currentAgent?.name) { item.classList.add('active'); }
			this.on(item, 'click', () => {
				this.setCurrentAgent(agent);
				this._onAgentChange.fire(agent.name);
				this._agentMenu.classList.remove('visible');
			});
			this._agentMenu.appendChild(item);
		}
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

	private _doSend(): void {
		this._richEditor.send();
	}
}
