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
	title: string;
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

	private _historyPanel: HTMLElement;
	private _historyList: HTMLElement;
	private _menuPanel: HTMLElement;
	private _briefEl: HTMLElement;
	private _briefTimer: ReturnType<typeof setTimeout> | undefined;

	constructor() {
		super('div', 'sc-header');

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

		// Menu dropdown panel
		this._menuPanel = this.append('div', 'sc-menu-panel');
		const menuItems: Array<{ id: string; label: string; codicon: ThemeIcon }> = [
			{ id: 'new_chat', label: 'New Chat', codicon: Codicon.add },
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

	setSessions(sessions: ISessionItem[]): void {
		DOM.clearNode(this._historyList);
		if (sessions.length === 0) {
			const empty = DOM.append(this._historyList, $('div.sc-history-empty'));
			empty.textContent = 'No past chats';
			return;
		}
		for (const s of sessions) {
			const row = DOM.append(this._historyList, $('div.sc-history-item'));
			row.dataset.id = s.id;
			row.dataset.title = (s.title || '').toLowerCase();
			const titleEl = DOM.append(row, $('span.sc-history-title'));
			titleEl.textContent = s.title || 'Untitled';
			if (s.updated_at) {
				const dateEl = DOM.append(row, $('span.sc-history-date'));
				dateEl.textContent = new Date(s.updated_at).toLocaleDateString();
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
