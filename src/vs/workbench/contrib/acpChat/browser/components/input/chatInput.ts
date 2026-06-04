import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { MentionPopup } from './mentionPopup.js';
import { MentionResolver, MentionItem } from '../../context/mentionResolver.js';
import { URI } from '../../../../../../base/common/uri.js';

export type AgentMode = 'agent' | 'plan' | 'ask';

export interface ResolvedMention {
	item: MentionItem;
	resolvedContent: string;
}

function codicon(c: ThemeIcon): HTMLSpanElement {
	const el = document.createElement('span');
	el.classList.add(...ThemeIcon.asClassNameArray(c));
	return el;
}

export class ChatInput extends Component {
	private _textareaEl: HTMLTextAreaElement;
	private _sendBtn: HTMLElement;
	private _stopBtn: HTMLElement;
	private _modeLabel: HTMLElement;
	private _modelLabel: HTMLElement;
	private _modeMenu: HTMLElement;
	private _currentMode: AgentMode = 'agent';
	private _currentModel = '';

	// Mention system
	private _mentionPopup: MentionPopup;
	private _mentionResolver: MentionResolver;
	private _mentionPillsContainer: HTMLElement;
	private _resolvedMentions: ResolvedMention[] = [];
	private _mentionTracking: { active: boolean; startPos: number } = { active: false, startPos: -1 };
	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

	private readonly _onSend = this._register(new Emitter<string>());
	readonly onSend: Event<string> = this._onSend.event;

	private readonly _onSendWithMentions = this._register(new Emitter<{ text: string; mentions: ResolvedMention[] }>());
	readonly onSendWithMentions: Event<{ text: string; mentions: ResolvedMention[] }> = this._onSendWithMentions.event;

	private readonly _onStop = this._register(new Emitter<void>());
	readonly onStop: Event<void> = this._onStop.event;

	private readonly _onModeChange = this._register(new Emitter<AgentMode>());
	readonly onModeChange: Event<AgentMode> = this._onModeChange.event;

	private readonly _onModelChange = this._register(new Emitter<string>());
	readonly onModelChange: Event<string> = this._onModelChange.event;

	get mode(): AgentMode { return this._currentMode; }
	get resolvedMentions(): readonly ResolvedMention[] { return this._resolvedMentions; }

	constructor() {
		super('div', 'sc-input-area');

		const container = this.append('div', 'sc-input-container');

		// Mention pills container — sits above the textarea
		this._mentionPillsContainer = DOM.append(container, $('div.sc-mention-pills'));

		this._textareaEl = DOM.append(container, $('textarea.sc-textarea')) as HTMLTextAreaElement;
		this._textareaEl.placeholder = 'Plan, Build, / for commands, @ for context';
		this._textareaEl.rows = 1;

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

		// Initialize mention system
		this._mentionResolver = new MentionResolver({
			findFiles: async (pattern: string, maxResults: number): Promise<URI[]> => {
				try {
					const vscode = (globalThis as any).vscode;
					if (vscode?.workspace?.findFiles) {
						return await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxResults);
					}
				} catch { /* fallback */ }
				return [];
			},
			readFile: async (uri: URI): Promise<string> => {
				try {
					const vscode = (globalThis as any).vscode;
					if (vscode?.workspace?.fs?.readFile) {
						const bytes = await vscode.workspace.fs.readFile(uri);
						return new TextDecoder().decode(bytes);
					}
				} catch { /* fallback */ }
				return '';
			},
			readDirectory: async (uri: URI): Promise<Array<[string, 'file' | 'directory']>> => {
				try {
					const vscode = (globalThis as any).vscode;
					if (vscode?.workspace?.fs?.readDirectory) {
						const entries = await vscode.workspace.fs.readDirectory(uri);
						return entries.map((e: [string, number]) => [e[0], e[1] === 2 ? 'directory' : 'file'] as [string, 'file' | 'directory']);
					}
				} catch { /* fallback */ }
				return [];
			},
			getWorkspaceFolderPath: (): string | undefined => {
				try {
					const vscode = (globalThis as any).vscode;
					if (vscode?.workspace?.workspaceFolders?.[0]) {
						return vscode.workspace.workspaceFolders[0].uri.fsPath;
					}
				} catch { /* fallback */ }
				return undefined;
			},
		});

		this._mentionPopup = new MentionPopup(this.element, (item) => this._onMentionSelected(item));
		this._disposables.add(this._mentionPopup);

		// Keyboard events — handle mention popup navigation before normal input handling
		this.on(this._textareaEl, 'keydown', (e) => {
			const ke = e as KeyboardEvent;

			if (this._mentionPopup.isVisible) {
				if (ke.key === 'ArrowDown') {
					ke.preventDefault();
					this._mentionPopup.selectNext();
					return;
				}
				if (ke.key === 'ArrowUp') {
					ke.preventDefault();
					this._mentionPopup.selectPrevious();
					return;
				}
				if (ke.key === 'Enter' || ke.key === 'Tab') {
					ke.preventDefault();
					this._mentionPopup.confirmSelection();
					return;
				}
				if (ke.key === 'Escape') {
					ke.preventDefault();
					this._mentionPopup.hide();
					this._mentionTracking.active = false;
					return;
				}
			}

			if (ke.key === 'Enter' && !ke.shiftKey) {
				ke.preventDefault();
				this._doSend();
			}
		});

		this.on(this._textareaEl, 'input', () => {
			this._autoResize();
			const hasText = this._textareaEl.value.trim().length > 0 || this._resolvedMentions.length > 0;
			this._sendBtn.classList.toggle('disabled', !hasText);
			this._handleMentionInput();
		});
		this.on(this._sendBtn, 'click', () => this._doSend());

		this._sendBtn.classList.add('disabled');
		this.on(this._stopBtn, 'click', () => this._onStop.fire());
	}

	focus(): void { this._textareaEl.focus(); }

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

	// --- Mention system ---

	private _handleMentionInput(): void {
		const value = this._textareaEl.value;
		const cursorPos = this._textareaEl.selectionStart;
		const textBefore = value.substring(0, cursorPos);
		const atIndex = textBefore.lastIndexOf('@');

		// Must have an @, and it must be at the start or preceded by whitespace
		if (atIndex === -1) {
			this._mentionTracking.active = false;
			this._mentionPopup.hide();
			return;
		}
		if (atIndex > 0 && textBefore[atIndex - 1] !== ' ' && textBefore[atIndex - 1] !== '\n') {
			this._mentionTracking.active = false;
			this._mentionPopup.hide();
			return;
		}

		const query = textBefore.substring(atIndex + 1);

		// A space within the query terminates the mention
		if (query.includes(' ')) {
			this._mentionTracking.active = false;
			this._mentionPopup.hide();
			return;
		}

		this._mentionTracking = { active: true, startPos: atIndex };
		this._debouncedSearch(query);
	}

	private _debouncedSearch(query: string): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}
		this._debounceTimer = setTimeout(async () => {
			try {
				const suggestions = await this._mentionResolver.getSuggestions(query);
				if (!this._mentionTracking.active) { return; }

				const anchorRect = this._getCaretRect();
				this._mentionPopup.showItems(suggestions, anchorRect);
			} catch {
				this._mentionPopup.hide();
			}
		}, 150);
	}

	private _getCaretRect(): DOMRect {
		// Approximate caret position using a temporary span
		const textarea = this._textareaEl;
		const rect = textarea.getBoundingClientRect();

		// Rough estimation: use textarea position as anchor
		return new DOMRect(
			rect.left + 12,
			rect.top,
			1,
			20
		);
	}

	private async _onMentionSelected(item: MentionItem): Promise<void> {
		if (!this._mentionTracking.active) { return; }

		const value = this._textareaEl.value;
		const cursorPos = this._textareaEl.selectionStart;
		const before = value.substring(0, this._mentionTracking.startPos);
		const after = value.substring(cursorPos);

		// Remove "@query" from textarea and replace with nothing (pill goes above)
		this._textareaEl.value = before + after;
		this._textareaEl.selectionStart = before.length;
		this._textareaEl.selectionEnd = before.length;

		this._mentionTracking.active = false;
		this._autoResize();

		// Resolve the mention content
		let resolvedContent = '';
		try {
			resolvedContent = await this._mentionResolver.resolve(item);
		} catch {
			resolvedContent = `[Could not resolve: ${item.label}]`;
		}

		const mention: ResolvedMention = { item, resolvedContent };
		this._resolvedMentions.push(mention);
		this._renderMentionPill(mention);

		const hasText = this._textareaEl.value.trim().length > 0 || this._resolvedMentions.length > 0;
		this._sendBtn.classList.toggle('disabled', !hasText);

		this._textareaEl.focus();
	}

	private _renderMentionPill(mention: ResolvedMention): void {
		const pill = document.createElement('span');
		pill.className = 'sc-mention-pill';

		const iconEl = document.createElement('span');
		iconEl.className = 'sc-mention-pill-icon';
		if (mention.item.type === 'folder') {
			iconEl.classList.add('codicon', 'codicon-folder');
		} else if (mention.item.type === 'symbol') {
			iconEl.classList.add('codicon', 'codicon-symbol-method');
		} else {
			iconEl.classList.add('codicon', 'codicon-file');
		}
		pill.appendChild(iconEl);

		const labelEl = document.createElement('span');
		labelEl.className = 'sc-mention-pill-label';
		labelEl.textContent = mention.item.label;
		pill.appendChild(labelEl);

		const removeBtn = document.createElement('span');
		removeBtn.className = 'sc-mention-pill-remove';
		removeBtn.innerHTML = '&times;';
		removeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const idx = this._resolvedMentions.indexOf(mention);
			if (idx !== -1) { this._resolvedMentions.splice(idx, 1); }
			pill.remove();
			const hasText = this._textareaEl.value.trim().length > 0 || this._resolvedMentions.length > 0;
			this._sendBtn.classList.toggle('disabled', !hasText);
		});
		pill.appendChild(removeBtn);

		this._mentionPillsContainer.appendChild(pill);
		this._mentionPillsContainer.style.display = '';
	}

	// --- Send ---

	private _doSend(): void {
		const text = this._textareaEl.value.trim();
		if (!text && this._resolvedMentions.length === 0) { return; }

		this._textareaEl.value = '';
		this._autoResize();
		this._sendBtn.classList.add('disabled');

		// Build the full message with mention context prepended
		let fullMessage = '';
		for (const m of this._resolvedMentions) {
			fullMessage += `<context source="@${m.item.label}">\n${m.resolvedContent}\n</context>\n\n`;
		}
		fullMessage += text;

		// Clear mentions
		const mentionsCopy = [...this._resolvedMentions];
		this._resolvedMentions = [];
		DOM.clearNode(this._mentionPillsContainer);
		this._mentionPillsContainer.style.display = 'none';

		this._onSendWithMentions.fire({ text: fullMessage, mentions: mentionsCopy });
		this._onSend.fire(fullMessage);
	}

	private _autoResize(): void {
		this._textareaEl.style.height = 'auto';
		this._textareaEl.style.height = `${Math.min(this._textareaEl.scrollHeight, 120)}px`;
	}
}
