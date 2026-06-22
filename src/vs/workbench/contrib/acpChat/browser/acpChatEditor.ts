/*---------------------------------------------------------------------------------------------
 *  AcpChatEditor — EditorPane that renders a chat session as an editor tab.
 *  Uses AcpChatSessionManager to persist sessions across tab switches.
 *
 *  Lifecycle: createEditor() → setInput() → [tab switch] → setInput() again
 *
 *  Key insight: VSCode reuses ONE EditorPane instance for all tabs of the same
 *  type. On tab switch it calls setInput() with the new input on the same pane.
 *  This means the DOM is shared — we must swap per-session DOM elements in/out
 *  of the live container so each tab shows its own conversation.
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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AcpStore } from './acpStore.js';
import { ScrollManager } from './scrollManager.js';
import { AcpChatSessionManager } from './acpChatSessionManager.js';
import { ChatHeader } from './components/toolbar/chatHeader.js';
import { ChatInput } from './components/input/chatInput.js';
import type { PlanEntry } from './components/input/chatInput.js';
import { UserMessage } from './components/messages/userMessage.js';
import { ThinkingBlock } from './components/messages/thinkingBlock.js';
import { AgentMessageGroup } from './components/messages/agentMessage.js';
import { ToolCallGroup } from './components/tools/toolCallGroup.js';
import { acpChatEditorId } from './acpChatEditorInput.js';
import { AcpChatEditorInput } from './acpChatEditorInput.js';
import type { AcpNotification } from './acp-utils.js';
import { invoke } from '../../../../sidex-bridge.js';
import './media/acpChatView.css';

interface AgentConfig {
	name: string;
	command: string;
	args: string[];
	env: string[];
}

const $ = dom.$;

interface GroupComponent {
	type: string;
	component: UserMessage | ThinkingBlock | AgentMessageGroup | ToolCallGroup;
}

/** Per-session view state — DOM elements and rendering state that are swapped on tab switch. */
interface SessionView {
	messagesEl: HTMLElement;
	welcomeEl: HTMLElement;
	sentinelEl: HTMLElement;
	scrollManager: ScrollManager;
	chatInput: ChatInput;
	groupComponents: GroupComponent[];
	lastGroupType: string | null;
	lastGroupComp: UserMessage | ThinkingBlock | AgentMessageGroup | ToolCallGroup | null;
	/** How many notifications were rendered when this view was saved.
	 *  On restore, notifications past this index are replayed to catch up. */
	renderedCount: number;
}

export class AcpChatEditor extends EditorPane {
	static readonly ID = acpChatEditorId;

	private _sessionManager = AcpChatSessionManager.getInstance();
	private _editorInput?: AcpChatEditorInput;
	private _acpStore?: AcpStore;
	private _currentSessionId?: string;

	// Agent management — loaded from settings, independent of chatService
	private _agents: AgentConfig[] = [];
	private _currentAgent: AgentConfig | null = null;

	// Disposables for the UI components that live for the pane lifetime.
	private readonly _uiDisposables = this._register(new DisposableStore());
	// Disposables for event listeners tied to the current store/session.
	// Cleared on tab switch so we don't leak listeners or hold stale references.
	private readonly _sessionDisposables = this._register(new DisposableStore());

	// Per-session view storage — keyed by session ID
	private _sessionViews = new Map<string, SessionView>();

	// Live DOM elements (currently visible)
	private _rootEl!: HTMLElement;
	private _header!: ChatHeader;
	private _messagesEl!: HTMLElement;
	private _welcomeEl!: HTMLElement;
	private _sentinelEl!: HTMLElement;
	private _scrollManager!: ScrollManager;
	private _chatInput!: ChatInput;

	// Live rendering state (for the currently visible session)
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
		@ICommandService private readonly _commandService: ICommandService
	) {
		super(AcpChatEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._rootEl = dom.append(parent, $('div.acp-chat-view'));

		// Header is shared across sessions (stateless toolbar)
		this._header = new ChatHeader();
		this._header.appendTo(this._rootEl);
		this._uiDisposables.add(this._header);
	}

	override async setInput(
		input: AcpChatEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken
	): Promise<void> {
		this._editorInput = input;
		await super.setInput(input, options, context, token);

		const sessionId = input.sessionId;
		if (!sessionId) {
			throw new Error('AcpChatEditorInput must have a sessionId');
		}

		// Save the current session's view state before switching
		if (this._currentSessionId && this._messagesEl) {
			this._saveCurrentView();
		}

		// Get or create the persistent store for this session
		this._acpStore = this._sessionManager.getOrCreateSession(sessionId);
		this._currentSessionId = sessionId;

		// Restore or create this session's view
		const savedView = this._sessionViews.get(sessionId);
		if (savedView) {
			this._restoreView(savedView);
		} else {
			this._createSessionView();
		}

		this._bindEvents();

		// Catch up on notifications that arrived while this tab was hidden.
		// The store kept receiving Tauri events, but the view's listener was
		// disposed — so notifications accumulated unrendered. Replay them now.
		// Must come after _bindEvents() since that clears _sessionDisposables
		// (catch-up adds components to _groupComponents, not _sessionDisposables).
		const renderedSoFar = savedView ? savedView.renderedCount : 0;
		this._catchUpNotifications(renderedSoFar);

		// Sync live state — streaming, queue, plan may have changed while away
		this._chatInput.setStreaming(this._acpStore.isStreaming);
		this._chatInput.setQueuedItems(this._acpStore.queuedItems);
		this._chatInput.setPlanEntries(this._acpStore.planEntries as PlanEntry[]);
		if (!this._acpStore.isStreaming && this._lastGroupComp) {
			this._lastGroupComp.stopStreaming();
		}

		// Scroll to bottom when returning to a previously viewed tab.
		// Wrapped in rAF because _restoreView() re-attaches DOM elements and
		// _catchUpNotifications() may render new content — the browser needs a
		// layout pass before scrollHeight is correct.
		if (savedView) {
			requestAnimationFrame(() => this._scrollManager.forceScrollToBottom());
		}

		// Connect to agent if not already connected
		if (this._acpStore.connectionStatus === 'disconnected') {
			await this._connect();
		}

		// Update session info in header
		this._header.setSessionInfo(this._acpStore.sessionId, this._acpStore.connectionStatus);
	}

	override clearInput(): void {
		// Save and detach DOM before clearing references — VS Code may call
		// clearInput() before setInput() when switching editor tabs.
		if (this._currentSessionId && this._messagesEl) {
			this._saveCurrentView();
		}
		super.clearInput();
		this._sessionDisposables.clear();
		this._acpStore = undefined;
		this._editorInput = undefined;
	}

	/** Save current DOM elements and rendering state into the session views map. */
	private _saveCurrentView(): void {
		if (!this._currentSessionId) {
			return;
		}

		// Detach elements from the live container (they stay alive in memory)
		this._messagesEl.remove();
		this._chatInput.element.remove();

		this._sessionViews.set(this._currentSessionId, {
			messagesEl: this._messagesEl,
			welcomeEl: this._welcomeEl,
			sentinelEl: this._sentinelEl,
			scrollManager: this._scrollManager,
			chatInput: this._chatInput,
			groupComponents: this._groupComponents,
			lastGroupType: this._lastGroupType,
			lastGroupComp: this._lastGroupComp,
			renderedCount: this._acpStore?.notifications.length ?? 0,
		});
	}

	/** Restore a previously saved session view into the live container. */
	private _restoreView(view: SessionView): void {
		this._messagesEl = view.messagesEl;
		this._welcomeEl = view.welcomeEl;
		this._sentinelEl = view.sentinelEl;
		this._scrollManager = view.scrollManager;
		this._chatInput = view.chatInput;
		this._groupComponents = view.groupComponents;
		this._lastGroupType = view.lastGroupType;
		this._lastGroupComp = view.lastGroupComp;

		// Re-attach to the live container
		this._rootEl.appendChild(this._messagesEl);
		this._chatInput.appendTo(this._rootEl);
	}

	/** Build a fresh session view (messages + input) and attach to the live container. */
	private _createSessionView(): void {
		this._messagesEl = dom.append(this._rootEl, $('div.sc-messages'));
		this._welcomeEl = dom.append(this._messagesEl, $('div.sc-welcome'));
		dom.append(this._welcomeEl, $('div.sc-welcome-title')).textContent = 'crow-cli';
		dom.append(this._welcomeEl, $('div.sc-welcome-subtitle')).textContent = 'Ask anything';
		this._sentinelEl = dom.append(this._messagesEl, $('div.sc-scroll-sentinel'));
		this._scrollManager = new ScrollManager(this._messagesEl, this._sentinelEl);

		const workspaceRoot = this._workspaceContext.getWorkspace().folders[0]?.uri?.fsPath || '';
		this._chatInput = new ChatInput(workspaceRoot);
		this._chatInput.appendTo(this._rootEl);

		this._groupComponents = [];
		this._lastGroupType = null;
		this._lastGroupComp = null;
	}

	private _bindEvents(): void {
		const store = this._acpStore;
		if (!store) {
			return;
		}

		this._sessionDisposables.clear();

		this._sessionDisposables.add(
			this._chatInput.onSendBlocks(blocks => {
				store.sendMessage('', blocks);
				this._scrollManager.forceScrollToBottom();
			})
		);
		this._sessionDisposables.add(this._chatInput.onStop(() => store.stopStreaming()));
		this._sessionDisposables.add(this._chatInput.onRemoveQueuedItem(index => store.removeQueuedItem(index)));
		this._sessionDisposables.add(this._chatInput.onClearQueue(() => store.clearQueue()));
		this._sessionDisposables.add(this._chatInput.onEditQueuedItem(index => {
			const item = store.getQueuedItem(index);
			if (item) {
				store.removeQueuedItem(index);
				this._chatInput.loadTextIntoEditor(item.text);
			}
		}));
		this._sessionDisposables.add(this._chatInput.onSendQueuedItemNow(index => {
			const item = store.getQueuedItem(index);
			if (item) {
				store.removeQueuedItem(index);
				store.stopStreaming();
				setTimeout(() => {
					store.sendMessage('', item.blocks);
					this._scrollManager.forceScrollToBottom();
				}, 100);
			}
		}));

		this._sessionDisposables.add(this._header.onNewChat(() => store.clearMessages()));
		this._sessionDisposables.add(
			this._header.onHistory(() => {
				this._fetchSessions();
			})
		);
		this._sessionDisposables.add(
			this._header.onSelectSession(sessionId => {
				store.loadSession(sessionId).catch(e => {
					console.error('[acpChatEditor] loadSession failed:', e);
				});
			})
		);
		this._sessionDisposables.add(
			this._header.onMenuAction(action => {
				if (action === 'clear_all') {
					store.clearMessages();
				} else if (action === 'export') {
					this._exportChat();
				} else if (action === 'open_in_editor') {
					this._commandService.executeCommand('workbench.action.openAcpChatEditor');
				}
			})
		);

		this._sessionDisposables.add(store.onDidChangeNotifications(() => this._onNotificationAdded()));
		this._sessionDisposables.add(dom.addDisposableListener(
			this._messagesEl, 'sc:heavy-render-done' as any,
			() => this._scrollManager.scrollToBottom()
		));
		this._sessionDisposables.add(
			store.onDidChangeStreaming(s => {
				this._chatInput.setStreaming(s);
				if (!s && this._lastGroupComp) {
					this._lastGroupComp.stopStreaming();
				}
			})
		);
		this._sessionDisposables.add(
			store.onDidChangeQueue(() => {
				this._chatInput.setQueuedItems(store.queuedItems);
			})
		);
		this._sessionDisposables.add(
			store.onDidChangePlan(() => {
				this._chatInput.setPlanEntries(store.planEntries as PlanEntry[]);
			})
		);
		this._sessionDisposables.add(
			store.onDidChangeConnectionState(() => {
				if (store.connectionStatus === 'connected' || store.connectionStatus === 'ready') {
					this._fetchSessions();
				}
				this._header.setSessionInfo(store.sessionId, store.connectionStatus);
			})
		);
		this._sessionDisposables.add(
			store.onDidChangeConfigOptions(options => {
				const modelConfig = options.find(opt => opt.category === 'model' || opt.id === 'model');
				if (modelConfig && modelConfig.options) {
					const models = modelConfig.options.map(opt => ({
						id: opt.value,
						name: opt.name
					}));
					this._chatInput.setAvailableModels(models);
					if (modelConfig.currentValue) {
						this._chatInput.setModel(modelConfig.currentValue);
					}
				}
			})
		);
		this._sessionDisposables.add(
			this._chatInput.onModelChange(modelId => {
				const modelConfig = store.configOptions.find(
					opt => opt.category === 'model' || opt.id === 'model'
				);
				if (modelConfig) {
					store.setConfigOption(modelConfig.id, modelId);
				}
			})
		);
		this._sessionDisposables.add(this._chatInput.onAgentChange(agentName => {
			this._switchAgent(agentName);
		}));
		this._sessionDisposables.add(
			store.onDidReceiveControlSignal(signal => {
				if (signal.type === 'brief' && signal.content) {
					const text = signal.content.startsWith('BRIEF:') ? signal.content.slice(6) : signal.content;
					this._header.showBrief(text);
				}
			})
		);
	}

	private async _switchAgent(agentName: string): Promise<void> {
		const store = this._acpStore;
		if (!store) {
			return;
		}

		// Find the agent in the available agents list
		const agent = this._agents.find(a => a.name === agentName);
		if (!agent) {
			console.warn(`[AcpChatEditor] Agent "${agentName}" not found`);
			return;
		}

		// Check if it's already the current agent
		if (agent.name === this._currentAgent?.name) {
			return;
		}

		const workspace = this._workspaceContext.getWorkspace();
		const cwd = workspace.folders[0]?.uri?.fsPath || '/home';

		// Close the current session before spawning a new agent
		try {
			await store.closeSession();
		} catch (e) {
			console.warn('[AcpChatEditor] closeSession failed during switch:', e);
		}

		// Clear messages
		store.clearMessages();

		// Update current agent
		this._currentAgent = agent;
		this._chatInput.setCurrentAgent(agent);

		// Spawn the new agent with its actual configuration
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await store.start();
				await store.spawnAndConnect({
					name: agent.name,
					command: agent.command,
					args: agent.args,
					env: agent.env,
					cwd
				});
				return;
			} catch (e) {
				if (attempt < 2) {
					console.warn(`[AcpChatEditor] switchAgent attempt ${attempt + 1} failed, retrying...`);
					await new Promise(r => setTimeout(r, 2000));
				} else {
					console.error('[AcpChatEditor] switchAgent failed:', e);
				}
			}
		}
	}

	private async _connect(): Promise<void> {
		const store = this._acpStore;
		if (!store) {
			return;
		}

		// Load agent configuration from settings
		await this._loadAgentConfig();

		const agent = this._currentAgent;
		if (!agent) {
			console.error('[AcpChatEditor] No agent configured');
			return;
		}

		// Update the UI with available agents
		this._chatInput.setAvailableAgents(this._agents);
		this._chatInput.setCurrentAgent(agent);

		const workspace = this._workspaceContext.getWorkspace();
		const cwd = workspace.folders[0]?.uri?.fsPath || '/home';

		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await store.start();
				await store.spawnAndConnect({
					name: agent.name,
					command: agent.command,
					args: agent.args,
					env: agent.env,
					cwd
				});
				return;
			} catch (e) {
				if (attempt < 2) {
					console.warn(`[AcpChatEditor] connect attempt ${attempt + 1} failed, retrying...`);
					await new Promise(r => setTimeout(r, 2000));
				} else {
					console.error('[AcpChatEditor] connect failed:', e);
				}
			}
		}
	}

	private async _loadAgentConfig(): Promise<void> {
		let defaultAgentName = 'crow';
		let agents: AgentConfig[] = [];

		try {
			const nameResult = await invoke<string | null>('settings_get', { section: 'acp.defaultAgent' });
			if (nameResult) { defaultAgentName = nameResult; }

			const agentsResult = await invoke<AgentConfig[] | null>('settings_get', { section: 'acp.agents' });
			if (agentsResult) { agents = agentsResult; }
		} catch (e) {
			console.warn('[AcpChatEditor] Failed to read settings, using defaults:', e);
		}

		this._agents = agents;
		this._currentAgent = agents.find(a => a.name === defaultAgentName) || agents[0] || null;
	}

	// ── Rendering ──

	/** Replay notifications that arrived while this tab was hidden. */
	private _catchUpNotifications(fromIndex: number): void {
		const store = this._acpStore;
		if (!store || !this._messagesEl) { return; }

		const notifications = store.notifications;
		this._welcomeEl.style.display = notifications.length > 0 ? 'none' : 'flex';

		if (notifications.length === 0) {
			this._resetView();
			return;
		}

		// Store was cleared while we were away — start fresh
		if (notifications.length < fromIndex) {
			this._resetView();
			fromIndex = 0;
		}

		for (let i = fromIndex; i < notifications.length; i++) {
			this._renderNotification(notifications[i]);
		}
	}

	private _onNotificationAdded(): void {
		const store = this._acpStore;
		if (!store || !this._messagesEl) { return; }

		const notifications = store.notifications;
		this._welcomeEl.style.display = notifications.length > 0 ? 'none' : 'flex';

		if (notifications.length === 0) {
			this._resetView();
			return;
		}

		this._renderNotification(notifications[notifications.length - 1]);

		// Scroll after the browser has laid out the new content
		requestAnimationFrame(() => this._scrollManager.scrollToBottom());

		// Mermaid scroll is handled by the 'sc:heavy-render-done' event listener
		// in _bindEvents() — fires when async mermaid.run() actually completes
	}

	/** Render a single notification into the current view (grouping logic). */
	private _renderNotification(notification: AcpNotification): void {
		const update = notification.data.update;
		const sessionUpdate = update.sessionUpdate as string;

		const groupType = sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update' ? 'tool' : sessionUpdate;

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
			this._groupComponents.push({ type: groupType, component: comp });
			this._lastGroupComp = comp;
			this._lastGroupType = groupType;
		}
	}

	private _createGroupComponent(
		notification: AcpNotification
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
			comp = new ToolCallGroup(this._instantiationService, this._workspaceContext.getWorkspace().folders[0]?.uri?.fsPath || '');
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
		if (!store) {
			return;
		}
		const cwd = this._workspaceContext.getWorkspace().folders[0]?.uri?.fsPath || '/home';
		store.listSessions(cwd).then(sessions => {
			this._header.setSessions(
				sessions.map(s => ({
					id: s.id,
					displayId: s.displayId,
					title: s.title,
					updated_at: new Date(s.date).toISOString()
				}))
			);
		});
	}

	private _exportChat(): void {
		const store = this._acpStore;
		if (!store) {
			return;
		}
		const text = store.notifications
			.map(n => {
				const update = n.data.update;
				const sessionUpdate = update.sessionUpdate as string;
				const content = update.content as { text?: string } | undefined;
				return `[${sessionUpdate}]\n${content?.text || ''}\n`;
			})
			.join('\n---\n\n');
		navigator.clipboard.writeText(text).catch(() => {
			/* */
		});
	}

	override layout(dimension: dom.Dimension): void {
		if (this._rootEl) {
			dom.size(this._rootEl, dimension.width, dimension.height);
		}
	}

	override focus(): void {
		this._chatInput?.focus();
	}
}
