/*---------------------------------------------------------------------------------------------
 *  ACP Chat View — Composes component classes into the chat panel
 *--------------------------------------------------------------------------------------------*/

import './media/acpChatView.css';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import * as DOM from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { MessageList } from './messageList.js';
import { ChatHeader } from './components/toolbar/chatHeader.js';
import { ChatInput } from './components/input/chatInput.js';
import type { PlanEntry } from './components/input/chatInput.js';

export class AcpChatViewPane extends ViewPane {
	private _header!: ChatHeader;
	private _messageList!: MessageList;
	private _input!: ChatInput;
	private _connectingBar!: HTMLElement;
	private readonly _viewDisposables = this._register(new DisposableStore());

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

		// Catch up on notifications that arrived while the view was hidden.
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this._messageList?.catchUp(0);
			}
		}));

		this._header = new ChatHeader();
		this._header.appendTo(parent);
		this._viewDisposables.add(this._header);

		// Connecting status bar — shown between header and messages during session switches
		this._connectingBar = DOM.append(parent, DOM.$('div.sc-connecting-bar'));
		DOM.append(this._connectingBar, DOM.$('div.sc-connecting-dot'));
		const connectingText = DOM.append(this._connectingBar, DOM.$('span'));
		connectingText.textContent = 'Switching session…';

		this._messageList = new MessageList({
			instantiationService: this.instantiationService,
			cwd: this.chatService.cwd,
			getNotifications: () => this.chatService.notifications,
		});
		this._messageList.attachTo(parent);
		this._viewDisposables.add(this._messageList);

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
			this._messageList.scrollManager.forceScrollToBottom();
		}));
		this._viewDisposables.add(this._input.onStop(() => this.chatService.stopStreaming()));
		this._viewDisposables.add(this._input.onAgentChange(agentName => this.chatService.switchAgent(agentName)));

		this._viewDisposables.add(this._input.onRemoveQueuedItem(index => this.chatService.removeQueuedItem(index)));
		this._viewDisposables.add(this._input.onClearQueue(() => this.chatService.clearQueue()));
		this._viewDisposables.add(this._input.onEditQueuedItem(index => {
			const item = this.chatService.getQueuedItem(index);
			if (item) {
				this.chatService.removeQueuedItem(index);
				this._input.loadTextIntoEditor(item.text);
			}
		}));
		this._viewDisposables.add(this._input.onSendQueuedItemNow(index => {
			const item = this.chatService.getQueuedItem(index);
			if (item) {
				this.chatService.removeQueuedItem(index);
				this.chatService.stopStreaming();
				// Wait a tick for cancel to propagate, then send
				setTimeout(() => {
					this.chatService.sendMessage('', item.blocks);
					this._messageList.scrollManager.forceScrollToBottom();
				}, 100);
			}
		}));

		this._viewDisposables.add(this._header.onNewChat(() => this.chatService.clearMessages()));

		this._viewDisposables.add(this._header.onHistory(() => {
			this._fetchSessions();
		}));

		this._viewDisposables.add(this._header.onSelectSession(sessionId => {
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
			if (!s) {
				this._messageList.stopStreaming();
			}
		}));

		this._viewDisposables.add(this.chatService.onDidChangeQueue(() => {
			this._input.setQueuedItems(this.chatService.queuedItems);
		}));

		this._viewDisposables.add(this.chatService.onDidChangePlan(() => {
			this._input.setPlanEntries(this.chatService.planEntries as PlanEntry[]);
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

		this._viewDisposables.add(this.chatService.onDidChangeAgents(() => {
			this._input.setAvailableAgents(this.chatService.availableAgents);
			this._input.setCurrentAgent(this.chatService.currentAgent);
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
		if (!this.isVisible()) { return; }
		const notifications = this.chatService.notifications;
		if (notifications.length === 0) {
			this._messageList.reset();
			return;
		}
		this._messageList.catchUp(this._messageList.renderedCount);
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
				displayId: s.displayId,
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
		if (!this._messageList) { return; }
		// For now, just log permission requests — full implementation later
		console.log('[acpChatView] Permission request:', data);
	}
}
