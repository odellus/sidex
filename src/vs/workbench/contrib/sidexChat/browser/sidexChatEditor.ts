/*---------------------------------------------------------------------------------------------
 *  SidexChatEditor — EditorPane that renders a chat session as an editor tab.
 *  Each tab gets its own AcpStore, providing independent sessions.
 *  Reuses the same DOM components as SidexChatViewPane.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { AcpStore } from './acpStore.js';
import { ScrollManager } from './scrollManager.js';
import { ChatHeader } from './components/toolbar/chatHeader.js';
import { ChatInput } from './components/input/chatInput.js';
import { UserMessage } from './components/messages/userMessage.js';
import { ThinkingBlock } from './components/messages/thinkingBlock.js';
import { AgentMessageGroup } from './components/messages/agentMessage.js';
import { ToolCallGroup } from './components/tools/toolCallGroup.js';
import { sidexChatEditorId } from './sidexChatEditorInput.js';
import { SidexChatEditorInput } from './sidexChatEditorInput.js';
import type { AcpNotification } from './acp-utils.js';
import './media/sidexChatView.css';

const $ = dom.$;

interface GroupComponent {
	type: string;
	component: UserMessage | ThinkingBlock | AgentMessageGroup | ToolCallGroup;
}

export class SidexChatEditor extends EditorPane {

	static readonly ID = sidexChatEditorId;

	private _editorInput?: SidexChatEditorInput;
	private _acpStore?: AcpStore;
	private readonly _sessionDisposables = this._register(new DisposableStore());

	// DOM elements
	private _rootEl!: HTMLElement;
	private _header!: ChatHeader;
	private _messagesEl!: HTMLElement;
	private _welcomeEl!: HTMLElement;
	private _sentinelEl!: HTMLElement;
	private _scrollManager!: ScrollManager;
	private _chatInput!: ChatInput;

	// Group-based rendering state
	private _groupComponents: GroupComponent[] = [];
	private _lastGroupType: string | null = null;
	private _lastGroupComp: UserMessage | ThinkingBlock | AgentMessageGroup | ToolCallGroup | null = null;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly _workspaceContext: IWorkspaceContextService,
	) {
		super(SidexChatEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._rootEl = dom.append(parent, $('div.sidex-chat-view'));
	}

	override async setInput(
		input: SidexChatEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		this._editorInput = input;
		await super.setInput(input, options, context, token);

		// Clear previous session
		this._sessionDisposables.clear();
		this._resetView();

		// Create new store for this tab
		this._acpStore = new AcpStore();
		this._buildUI();
		this._bindEvents();

		// Connect to agent
		this._connect();
	}

	override clearInput(): void {
		super.clearInput();
		this._sessionDisposables.clear();
		this._acpStore?.dispose();
		this._acpStore = undefined;
		this._editorInput = undefined;
	}

	private _buildUI(): void {
		// Clear root
		dom.clearNode(this._rootEl);

		this._header = new ChatHeader();
		this._header.appendTo(this._rootEl);
		this._sessionDisposables.add(this._header);

		this._messagesEl = dom.append(this._rootEl, $('div.sc.messages'));
		this._welcomeEl = dom.append(this._messagesEl, $('div.sc-welcome'));
		dom.append(this._welcomeEl, $('div.sc-welcome-title')).textContent = 'crow-cli';
		dom.append(this._welcomeEl, $('div.sc-welcome-subtitle')).textContent = 'Ask anything';

		// Scroll sentinel
		this._sentinelEl = dom.append(this._messagesEl, $('div.sc-scroll-sentinel'));

		this._scrollManager = new ScrollManager(this._messagesEl, this._sentinelEl);
		this._sessionDisposables.add(this._scrollManager);

		this._chatInput = new ChatInput();
		this._chatInput.appendTo(this._rootEl);
		this._sessionDisposables.add(this._chatInput);
	}

	private _bindEvents(): void {
		const store = this._acpStore;
		if (!store) { return; }

		this._sessionDisposables.add(this._chatInput.onSend(text => {
			store.sendMessage(text);
		}));
		this._sessionDisposables.add(this._chatInput.onStop(() => store.stopStreaming()));
		this._sessionDisposables.add(this._chatInput.onModeChange(_mode => { /* no-op */ }));

		this._sessionDisposables.add(this._header.onNewChat(() => store.clearMessages()));
		this._sessionDisposables.add(this._header.onHistory(() => {
			this._fetchSessions();
		}));
		this._sessionDisposables.add(this._header.onSelectSession(sessionId => {
			store.loadSession(sessionId);
		}));
		this._sessionDisposables.add(this._header.onMenuAction(action => {
			if (action === 'clear_all') {
				store.clearMessages();
			} else if (action === 'export') {
				this._exportChat();
			}
		}));

		this._sessionDisposables.add(store.onDidChangeNotifications(() => this._onNotificationAdded()));
		this._sessionDisposables.add(store.onDidChangeStreaming(s => {
			this._chatInput.setStreaming(s);
			if (!s && this._lastGroupComp) {
				this._lastGroupComp.stopStreaming();
			}
		}));
		this._sessionDisposables.add(store.onDidChangeConnectionState(() => {
			if (store.connectionStatus === 'connected' || store.connectionStatus === 'ready') {
				this._fetchSessions();
			}
		}));
		this._sessionDisposables.add(store.onDidReceiveControlSignal(signal => {
			if (signal.type === 'brief' && signal.content) {
				const text = signal.content.startsWith('BRIEF:') ? signal.content.slice(6) : signal.content;
				this._header.showBrief(text);
			}
		}));
	}

	private async _connect(): Promise<void> {
		const store = this._acpStore;
		if (!store) { return; }

		const workspace = this._workspaceContext.getWorkspace();
		const cwd = workspace.folders[0]?.uri?.fsPath || '/home';

		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await store.start();
				await store.spawnAndConnect({
					name: 'crow',
					command: 'crow-cli',
					args: ['acp'],
					env: [],
					cwd,
				});
				return;
			} catch (e) {
				if (attempt < 2) {
					console.warn(`[SidexChatEditor] connect attempt ${attempt + 1} failed, retrying...`);
					await new Promise(r => setTimeout(r, 2000));
				} else {
					console.error('[SidexChatEditor] connect failed:', e);
				}
			}
		}
	}

	// ── Rendering (same logic as SidexChatViewPane) ──

	private _onNotificationAdded(): void {
		const store = this._acpStore;
		if (!store || !this._messagesEl) { return; }

		const notifications = store.notifications;
		this._welcomeEl.style.display = notifications.length > 0 ? 'none' : 'flex';

		if (notifications.length === 0) {
			this._resetView();
			return;
		}

		const notification = notifications[notifications.length - 1];
		const update = notification.data.update;
		const sessionUpdate = update.sessionUpdate as string;

		const groupType = (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update')
			? 'tool'
			: sessionUpdate;

		if (groupType === this._lastGroupType && this._lastGroupComp) {
			this._lastGroupComp.appendNotification(notification);
		} else {
			if (this._lastGroupComp) {
				this._lastGroupComp.stopStreaming();
			}

			const comp = this._createGroupComponent(notification);
			const wrapper = document.createElement('div');
			wrapper.classList.add('sc-message-group');
			this._messagesEl.insertBefore(wrapper, this._sentinelEl);
			comp.appendTo(wrapper);
			this._sessionDisposables.add(comp);
			this._groupComponents.push({ type: groupType, component: comp });
			this._lastGroupComp = comp;
			this._lastGroupType = groupType;
		}

		this._scrollManager.scrollToBottom();
	}

	private _createGroupComponent(
		notification: AcpNotification,
	): UserMessage | ThinkingBlock | AgentMessageGroup | ToolCallGroup {
		const sessionUpdate = notification.data.update.sessionUpdate as string;
		let comp: UserMessage | ThinkingBlock | AgentMessageGroup | ToolCallGroup;

		switch (sessionUpdate) {
			case 'user_message_chunk':
				comp = new UserMessage();
				break;
			case 'agent_thought_chunk':
				comp = new ThinkingBlock();
				break;
			case 'agent_message_chunk':
				comp = new AgentMessageGroup();
				break;
			case 'tool_call':
			case 'tool_call_update':
				comp = new ToolCallGroup();
				break;
			default:
				comp = new AgentMessageGroup();
				break;
		}

		comp.appendNotification(notification);
		return comp;
	}

	private _resetView(): void {
		for (const gc of this._groupComponents) {
			gc.component.dispose();
		}
		this._groupComponents = [];
		this._lastGroupType = null;
		this._lastGroupComp = null;

		if (this._messagesEl) {
			dom.clearNode(this._messagesEl);
			this._messagesEl.appendChild(this._welcomeEl);
			this._messagesEl.appendChild(this._sentinelEl);
			this._scrollManager?.reset();
		}
	}

	private _fetchSessions(): void {
		const store = this._acpStore;
		if (!store) { return; }
		const cwd = this._workspaceContext.getWorkspace().folders[0]?.uri?.fsPath || '/home';
		store.listSessions(cwd).then(sessions => {
			this._header.setSessions(sessions.map(s => ({
				id: s.id,
				title: s.title,
				updated_at: new Date(s.date).toISOString(),
			})));
		});
	}

	private _exportChat(): void {
		const store = this._acpStore;
		if (!store) { return; }
		const text = store.notifications.map(n => {
			const update = n.data.update;
			const sessionUpdate = update.sessionUpdate as string;
			const content = update.content as { text?: string } | undefined;
			return `[${sessionUpdate}]\n${content?.text || ''}\n`;
		}).join('\n---\n\n');
		navigator.clipboard.writeText(text).catch(() => { /* */ });
	}

	override layout(dimension: dom.Dimension): void {
		// The CSS handles layout; just ensure the root fills the space
		if (this._rootEl) {
			this._rootEl.style.height = `${dimension.height}px`;
			this._rootEl.style.width = `${dimension.width}px`;
		}
	}

	override focus(): void {
		this._chatInput?.focus();
	}
}
