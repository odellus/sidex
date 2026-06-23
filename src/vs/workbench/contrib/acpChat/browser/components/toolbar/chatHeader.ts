import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';

function icon(codicon: ThemeIcon): HTMLSpanElement {
	const el = document.createElement('span');
	el.classList.add(...ThemeIcon.asClassNameArray(codicon));
	return el;
}

export interface ISessionItem {
	id: string;
	displayId: string;
	title?: string;
	updated_at?: string;
}

export class ChatHeader extends Component {
	private readonly _onNewChat = this._register(new Emitter<void>());
	readonly onNewChat: Event<void> = this._onNewChat.event;

	private readonly _onHistory = this._register(new Emitter<void>());
	readonly onHistory: Event<void> = this._onHistory.event;

	private readonly _onSelectSession = this._register(new Emitter<string>());
	readonly onSelectSession: Event<string> = this._onSelectSession.event;

	private readonly _onMenuAction = this._register(new Emitter<string>());
	readonly onMenuAction: Event<string> = this._onMenuAction.event;

	private _sessionInfoEl: HTMLElement;
	private _sessionStatusEl: HTMLElement;
	private _sessionIdEl: HTMLElement;
	private _sessionCopyBtn: HTMLElement;
	private _sessionCopyIcon: HTMLElement;
	private _historyPanel: HTMLElement;
	private _historyList: HTMLElement;
	private _menuPanel: HTMLElement;
	private _briefEl: HTMLElement;
	private _briefTimer: ReturnType<typeof setTimeout> | undefined;

	constructor() {
		super('div', 'sc-header');

		// Session info (left side)
		this._sessionInfoEl = this.append('div', 'sc-session-info');
		this._sessionStatusEl = DOM.append(this._sessionInfoEl, $('span.sc-session-status'));
		this._sessionIdEl = DOM.append(this._sessionInfoEl, $('span.sc-session-id'));
		this._sessionIdEl.textContent = 'No session';

		this._sessionCopyBtn = DOM.append(this._sessionInfoEl, $('button.sc-session-copy'));
		this._sessionCopyBtn.title = 'Copy session ID';
		this._sessionCopyIcon = this._sessionCopyBtn.appendChild(icon(Codicon.copy));
		this.on(this._sessionCopyBtn, 'click', async (e) => {
			e.stopPropagation();
			const text = this._sessionIdEl.textContent;
			if (!text || text === 'No session') { return; }
			try {
				await navigator.clipboard.writeText(text);
				this._sessionCopyBtn.classList.add('copied');
				this._sessionCopyBtn.replaceChildren(icon(Codicon.check));
				setTimeout(() => {
					this._sessionCopyBtn.classList.remove('copied');
					this._sessionCopyBtn.replaceChildren(icon(Codicon.copy));
				}, 1500);
			} catch {
				// ignore
			}
		});

		const actions = this.append('div', 'sc-header-actions');

		// + New Chat
		const newBtn = DOM.append(actions, $('button.sc-header-btn'));
		newBtn.title = 'New Chat';
		newBtn.appendChild(icon(Codicon.add));
		this.on(newBtn, 'click', () => this._onNewChat.fire());

		// Clock (history)
		const histBtn = DOM.append(actions, $('button.sc-header-btn'));
		histBtn.title = 'Chat History';
		histBtn.appendChild(icon(Codicon.history));
		this.on(histBtn, 'click', () => this._toggleHistory());

		// ... Menu
		const menuBtn = DOM.append(actions, $('button.sc-header-btn'));
		menuBtn.title = 'More';
		menuBtn.appendChild(icon(Codicon.ellipsis));
		this.on(menuBtn, 'click', () => this._toggleMenu());

		// History dropdown panel
		this._historyPanel = this.append('div', 'sc-history-panel');
		const histSearch = DOM.append(this._historyPanel, $('input.sc-history-search')) as HTMLInputElement;
		histSearch.placeholder = 'Search chats...';
		histSearch.type = 'text';
		this.on(histSearch, 'input', () => this._filterHistory(histSearch.value));
		this._historyList = DOM.append(this._historyPanel, $('div.sc-history-list'));
		// Stop the wheel from bubbling to the ViewPane body's DomScrollableElement,
		// which would preventDefault() and kill native overflow scroll on this list.
		// Same fix the model menu uses (chatInput.ts).
		this.on(this._historyList, 'wheel', (e) => {
			e.stopPropagation();
		});

		// Menu dropdown panel
		this._menuPanel = this.append('div', 'sc-menu-panel');
		const menuItems: Array<{ id: string; label: string; codicon: ThemeIcon }> = [
			{ id: 'new_chat', label: 'New Chat', codicon: Codicon.add },
			{ id: 'open_in_editor', label: 'Open in Editor', codicon: Codicon.linkExternal },
			{ id: 'export', label: 'Export Chat', codicon: Codicon.export },
			{ id: 'separator', label: '', codicon: Codicon.dash },
			{ id: 'clear_all', label: 'Clear All Chats', codicon: Codicon.trashcan },
		];
		for (const item of menuItems) {
			if (item.id === 'separator') {
				DOM.append(this._menuPanel, $('div.sc-menu-separator'));
				continue;
			}
			const row = DOM.append(this._menuPanel, $('div.sc-menu-item'));
			row.appendChild(icon(item.codicon));
			const label = DOM.append(row, $('span'));
			label.textContent = item.label;
			this.on(row, 'click', () => {
				this._menuPanel.classList.remove('visible');
				if (item.id === 'new_chat') {
					this._onNewChat.fire();
				} else {
					this._onMenuAction.fire(item.id);
				}
			});
		}

		// Close panels on outside click
		this.on(document.body, 'click', (e) => {
			if (!this.element.contains(e.target as Node)) {
				this._historyPanel.classList.remove('visible');
				this._menuPanel.classList.remove('visible');
			}
		});

		// Brief banner
		this._briefEl = this.append('div', 'sc-brief-banner');
	}

	showBrief(text: string): void {
		if (this._briefTimer) { clearTimeout(this._briefTimer); }
		this._briefEl.textContent = text;
		this._briefEl.classList.add('visible');
		this._briefTimer = setTimeout(() => {
			this._briefEl.classList.remove('visible');
		}, 5000);
	}

	setSessionInfo(sessionId: string | undefined, connectionStatus: string): void {
		// Update status indicator
		this._sessionStatusEl.className = 'sc-session-status';
		if (connectionStatus === 'ready' && sessionId) {
			this._sessionStatusEl.classList.add('connected');
		} else if (connectionStatus === 'connecting') {
			this._sessionStatusEl.classList.add('connecting');
		} else {
			this._sessionStatusEl.classList.add('disconnected');
		}

		// Update session ID text
		if (sessionId) {
			this._sessionIdEl.textContent = sessionId;
			this._sessionCopyBtn.style.display = '';
		} else {
			this._sessionIdEl.textContent = 'No session';
			this._sessionIdEl.title = '';
			this._sessionCopyBtn.style.display = 'none';
		}
	}

	setSessions(sessions: ISessionItem[]): void {
		DOM.clearNode(this._historyList);
		if (sessions.length === 0) {
			const empty = DOM.append(this._historyList, $('div.sc-history-empty'));
			empty.textContent = 'No past chats';
			return;
		}
		for (let i = 0; i < sessions.length; i++) {
			const s = sessions[i];
			const row = DOM.append(this._historyList, $('div.sc-history-item'));
			if (i % 2 === 1) { row.classList.add('sc-history-alt'); }
			row.dataset.id = s.id;
			
			const headerEl = DOM.append(row, $('div.sc-history-header'));
			const titleEl = DOM.append(headerEl, $('span.sc-history-title'));
			titleEl.textContent = s.displayId;
			
			if (s.updated_at) {
				const dateEl = DOM.append(headerEl, $('span.sc-history-date'));
				dateEl.textContent = new Date(s.updated_at).toLocaleDateString();
			}
			
			if (s.title && s.title !== 'Untitled Chat') {
				const subtitleEl = DOM.append(row, $('div.sc-history-subtitle'));
				subtitleEl.textContent = s.title;
			}
			
			this.on(row, 'click', () => {
				this._historyPanel.classList.remove('visible');
				this._onSelectSession.fire(s.id);
			});
		}
	}

	private _toggleHistory(): void {
		this._menuPanel.classList.remove('visible');
		const wasHidden = !this._historyPanel.classList.contains('visible');
		this._historyPanel.classList.toggle('visible');
		if (wasHidden) {
			this._onHistory.fire();
		}
	}

	private _toggleMenu(): void {
		this._historyPanel.classList.remove('visible');
		this._menuPanel.classList.toggle('visible');
	}

	private _filterHistory(query: string): void {
		const q = query.toLowerCase();
		const items = this._historyList.querySelectorAll('.sc-history-item');
		for (const item of items) {
			const el = item as HTMLElement;
			const title = el.dataset.title || '';
			el.style.display = !q || title.includes(q) ? '' : 'none';
		}
	}
}
