/*---------------------------------------------------------------------------------------------
 *  ACP Chat View — Composes component classes into the chat panel
 *--------------------------------------------------------------------------------------------*/

import './media/acpChatView.css';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import * as DOM from '../../../../base/browser/dom.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IAcpChatService } from './acpChatService.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ScrollManager } from './scrollManager.js';
import { ChatHeader } from './components/toolbar/chatHeader.js';
import { ChatInput } from './components/input/chatInput.js';
import { UserMessage } from './components/messages/userMessage.js';
import { ThinkingBlock } from './components/messages/thinkingBlock.js';
import { AgentMessageGroup } from './components/messages/agentMessage.js';
import { ToolCallGroup } from './components/tools/toolCallGroup.js';
import type { AcpNotification } from './acp-utils.js';

const $ = DOM.$;

interface GroupComponent {
	type: string;
	component: UserMessage | ThinkingBlock | AgentMessageGroup | ToolCallGroup;
}

export class AcpChatViewPane extends ViewPane {
	private _header!: ChatHeader;
	private _messagesEl!: HTMLElement;
	private _welcomeEl!: HTMLElement;
	private _sentinelEl!: HTMLElement;
	private _scrollManager!: ScrollManager;
	private _input!: ChatInput;
	private _connectingBar!: HTMLElement;
	private readonly _viewDisposables = this._register(new DisposableStore());

	// Group-based rendering state
	private _groupComponents: GroupComponent[] = [];
	private _lastGroupType: string | null = null;
	private _lastGroupComp: UserMessage | ThinkingBlock | AgentMessageGroup | ToolCallGroup | null = null;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IAcpChatService private readonly chatService: IAcpChatService,
		@ICommandService private readonly _commandService: ICommandService,
		@IWorkspaceContextService private readonly _workspaceContext: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		parent.classList.add('acp-chat-view');

		this._header = new ChatHeader();
		this._header.appendTo(parent);
		this._viewDisposables.add(this._header);

		// Connecting status bar — shown between header and messages during session switches
		this._connectingBar = DOM.append(parent, DOM.$('div.sc-connecting-bar'));
		DOM.append(this._connectingBar, DOM.$('div.sc-connecting-dot'));
		const connectingText = DOM.append(this._connectingBar, DOM.$('span'));
		connectingText.textContent = 'Switching session…';

		this._messagesEl = DOM.append(parent, $('div.sc-messages'));
		this._welcomeEl = DOM.append(this._messagesEl, $('div.sc-welcome'));
		DOM.append(this._welcomeEl, $('div.sc-welcome-title')).textContent = 'crow-cli';
		DOM.append(this._welcomeEl, $('div.sc-welcome-subtitle')).textContent = 'Ask anything';

		// Scroll sentinel — always the last child of .sc-messages.
		// overflow-anchor: auto on this element lets the browser keep it in view
		// as content above it grows (free CSS auto-scroll during streaming).
		this._sentinelEl = DOM.append(this._messagesEl, $('div.sc-scroll-sentinel'));

		// Scroll manager — handles user-scroll detection and conditional auto-scroll
		this._scrollManager = new ScrollManager(this._messagesEl, this._sentinelEl);
		this._viewDisposables.add(this._scrollManager);

		const workspaceRoot = this._workspaceContext.getWorkspace().folders[0]?.uri?.fsPath || '';
		this._input = new ChatInput(workspaceRoot);
		this._input.appendTo(parent);
		this._viewDisposables.add(this._input);

		this._bindEvents();
		this.chatService.connect();
	}

	private _bindEvents(): void {
		this._viewDisposables.add(this._input.onSendBlocks(blocks => {
			this.chatService.sendMessage('', blocks);
		}));
		this._viewDisposables.add(this._input.onStop(() => this.chatService.stopStreaming()));
		this._viewDisposables.add(this._input.onModeChange(mode => this.chatService.setMode(mode)));

		this._viewDisposables.add(this._header.onNewChat(() => this.chatService.clearMessages()));

		this._viewDisposables.add(this._header.onHistory(() => {
			this._fetchSessions();
		}));

		this._viewDisposables.add(this._header.onSelectSession(sessionId => {
			console.log('[acpChatView] onSelectSession fired with:', sessionId);
			this.chatService.loadSession(sessionId).catch(e => {
				console.error('[acpChatView] loadSession failed:', e);
			});
		}));

		this._viewDisposables.add(this._header.onMenuAction(action => {
			if (action === 'export') {
				this._exportChat();
			} else if (action === 'clear_all') {
				this.chatService.clearMessages();
			} else if (action === 'open_in_editor') {
				this._openInEditor();
			}
		}));

		this._viewDisposables.add(this.chatService.onDidChangeNotifications(() => this._onNotificationAdded()));
		this._viewDisposables.add(this.chatService.onDidChangeStreaming(s => {
			this._input.setStreaming(s);
			if (!s && this._lastGroupComp) {
				this._lastGroupComp.stopStreaming();
			}
		}));

		this._viewDisposables.add(this.chatService.onDidChangeConnectionState(() => {
			const state = this.chatService.connectionState;
			if (state === 'connected' || state === 'ready') {
				this._connectingBar.classList.remove('visible');
				this._fetchSessions();
			} else if (state === 'connecting') {
				this._connectingBar.classList.add('visible');
			} else {
				this._connectingBar.classList.remove('visible');
			}
			this._updateSessionInfo();
		}));

		this._viewDisposables.add(this.chatService.onDidChangeConfigOptions(options => {
			const modelConfig = options.find(opt => opt.category === 'model' || opt.id === 'model');
			if (modelConfig && modelConfig.options) {
				const models = modelConfig.options.map(opt => ({
					id: opt.value,
					name: opt.name
				}));
				this._input.setAvailableModels(models);
				if (modelConfig.currentValue) {
					this._input.setModel(modelConfig.currentValue);
				}
			}
		}));

		this._viewDisposables.add(this._input.onModelChange(modelId => {
			const modelConfig = this.chatService.configOptions.find(
				opt => opt.category === 'model' || opt.id === 'model'
			);
			if (modelConfig) {
				this.chatService.setConfigOption(modelConfig.id, modelId);
			}
		}));

		this._viewDisposables.add(this.chatService.onDidReceiveControlSignal(signal => {
			if (signal.type === 'brief' && signal.content) {
				const text = signal.content.startsWith('BRIEF:') ? signal.content.slice(6) : signal.content;
				this._header.showBrief(text);
			}
			if (signal.type === 'permission_request' && signal.tool_call_id && signal.tool_name) {
				this._showPermissionDialog({
					toolCallId: signal.tool_call_id,
					toolName: signal.tool_name,
					args: (signal.args as Record<string, unknown>) || {},
				});
			}
		}));
	}

	private _updateSessionInfo(): void {
		this._header.setSessionInfo(this.chatService.sessionId, this.chatService.connectionState);
	}

	private _onNotificationAdded(): void {
		if (!this._messagesEl) { return; }

		const notifications = this.chatService.notifications;
		const hasNotifications = notifications.length > 0;
		this._welcomeEl.style.display = hasNotifications ? 'none' : 'flex';

		// Notifications were cleared — reset everything
		if (notifications.length === 0) {
			this._resetView();
			return;
		}

		// Get the latest notification
		const notification = notifications[notifications.length - 1];
		const update = notification.data.update;
		const sessionUpdate = update.sessionUpdate as string;

		// Determine group type
		const groupType = (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update')
			? 'tool'
			: sessionUpdate;

		// Same type as last group? Extend it
		if (groupType === this._lastGroupType && this._lastGroupComp) {
			this._lastGroupComp.appendNotification(notification);
		} else {
			// Different type — create new group component
			console.log(`[AcpChatView] NEW GROUP: type="${groupType}" (was "${this._lastGroupType}") sessionUpdate="${sessionUpdate}"`);
			if (this._lastGroupComp) {
				this._lastGroupComp.stopStreaming();
			}

			const comp = this._createGroupComponent(notification, groupType);
			// Wrap in .sc-message-group (overflow-anchor: none) and insert before the sentinel
			const wrapper = document.createElement('div');
			wrapper.classList.add('sc-message-group');
			this._messagesEl.insertBefore(wrapper, this._sentinelEl);
			comp.appendTo(wrapper);
			this._viewDisposables.add(comp);
			this._groupComponents.push({ type: groupType, component: comp });
			this._lastGroupComp = comp;
			this._lastGroupType = groupType;
		}

		this._scrollManager.scrollToBottom();
	}

	private _createGroupComponent(
		notification: AcpNotification,
		groupType: string
	): UserMessage | ThinkingBlock | AgentMessageGroup | ToolCallGroup {
		let comp: UserMessage | ThinkingBlock | AgentMessageGroup | ToolCallGroup;

		switch (groupType) {
			case 'user_message_chunk':
				comp = new UserMessage();
				break;
			case 'agent_thought_chunk':
				comp = new ThinkingBlock();
				break;
			case 'agent_message_chunk':
				comp = new AgentMessageGroup();
				break;
			case 'tool':
				comp = new ToolCallGroup(this.instantiationService, this.chatService.cwd);
				break;
			default:
				// Fallback to agent message for unknown types
				comp = new AgentMessageGroup();
				break;
		}

		comp.appendNotification(notification);
		return comp;
	}

	private _resetView(): void {
		// Dispose all group components
		for (const gc of this._groupComponents) {
			gc.component.dispose();
		}
		this._groupComponents = [];
		this._lastGroupType = null;
		this._lastGroupComp = null;

		// Clear messages container and re-add welcome + sentinel
		DOM.clearNode(this._messagesEl);
		this._messagesEl.appendChild(this._welcomeEl);
		this._messagesEl.appendChild(this._sentinelEl);
		this._scrollManager.reset();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override focus(): void {
		this._input?.focus();
	}

	private async _fetchSessions(): Promise<void> {
		try {
			const sessions = await this.chatService.getSavedSessions();
			this._header.setSessions(sessions.map(s => ({
				id: s.id,
				title: s.title,
				updated_at: new Date(s.date).toISOString(),
			})));
		} catch (e) {
			console.warn('[acpChatView] fetchSessions failed:', e);
			this._header.setSessions([]);
		}
	}

	private _openInEditor(): void {
		this._commandService.executeCommand('workbench.action.openAcpChatEditor');
	}

	private _exportChat(): void {
		const notifications = this.chatService.notifications;
		const text = notifications.map(n => {
			const update = n.data.update;
			const sessionUpdate = update.sessionUpdate as string;
			const content = update.content as { text?: string } | undefined;
			const text = content?.text || '';
			return `[${sessionUpdate}]\n${text}\n`;
		}).join('\n---\n\n');
		navigator.clipboard.writeText(text).catch(() => { /* */ });
	}

	private _showPermissionDialog(data: {
		toolCallId: string;
		toolName: string;
		args?: Record<string, unknown>;
	}): void {
		if (!this._messagesEl) { return; }
		// For now, just log permission requests — full implementation later
		console.log('[acpChatView] Permission request:', data);
	}
}
