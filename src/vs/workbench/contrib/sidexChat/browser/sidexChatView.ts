/*---------------------------------------------------------------------------------------------
 *  Sidex Chat View — Composes component classes into the chat panel
 *--------------------------------------------------------------------------------------------*/

import './media/sidexChatView.css';
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
import { ISidexChatService, IChatMessage } from './sidexChatService.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { ChatHeader } from './components/toolbar/chatHeader.js';
import { ChatInput } from './components/input/chatInput.js';
import { UserMessage } from './components/messages/userMessage.js';
import { AssistantMessage } from './components/messages/assistantMessage.js';
import { PermissionRequestDialog, PermissionRequestData } from './components/messages/permissionRequest.js';

const $ = DOM.$;

export class SidexChatViewPane extends ViewPane {
	private _header!: ChatHeader;
	private _messagesEl!: HTMLElement;
	private _welcomeEl!: HTMLElement;
	private _input!: ChatInput;
	private _turnStartTime = 0;
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
		@ISidexChatService private readonly chatService: ISidexChatService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		parent.classList.add('sidex-chat-view');

		this._header = new ChatHeader();
		this._header.appendTo(parent);
		this._viewDisposables.add(this._header);

		this._messagesEl = DOM.append(parent, $('div.sc-messages'));
		this._welcomeEl = DOM.append(this._messagesEl, $('div.sc-welcome'));
		DOM.append(this._welcomeEl, $('div.sc-welcome-title')).textContent = 'Sidex';
		DOM.append(this._welcomeEl, $('div.sc-welcome-subtitle')).textContent = 'Ask anything about your code';

		this._input = new ChatInput();
		this._input.appendTo(parent);
		this._viewDisposables.add(this._input);

		this._bindEvents();
		this.chatService.connect();
	}

	private _bindEvents(): void {
		this._viewDisposables.add(this._input.onSend(text => {
			this._turnStartTime = Date.now();
			this.chatService.sendMessage(text);
		}));
		this._viewDisposables.add(this._input.onStop(() => this.chatService.stopStreaming()));
		this._viewDisposables.add(this._input.onModeChange(mode => this.chatService.setMode(mode)));

		this._viewDisposables.add(this._header.onNewChat(() => this.chatService.clearMessages()));

		this._viewDisposables.add(this._header.onHistory(() => this._fetchSessions()));

		this._viewDisposables.add(this._header.onSelectSession(sessionId => {
			this.chatService.loadSession(sessionId);
		}));

		this._viewDisposables.add(this._header.onMenuAction(action => {
			if (action === 'export') {
				this._exportChat();
			} else if (action === 'clear_all') {
				this.chatService.clearMessages();
			}
		}));

		this._viewDisposables.add(this.chatService.onDidChangeMessages(msgs => this._renderMessages(msgs)));
		this._viewDisposables.add(this.chatService.onDidChangeStreaming(s => this._input.setStreaming(s)));

		this._viewDisposables.add(this.chatService.onDidChangeConnectionState(() => {
			if (this.chatService.connectionState === 'connected' || this.chatService.connectionState === 'ready') {
				if (this.chatService.serverModel) {
					this._input.setModel(this.chatService.serverModel);
				}
				this._fetchSessions();
			}
		}));

		this._viewDisposables.add(this.chatService.onDidChangeModels(models => {
			this._input.setAvailableModels(models);
			// Show the current model and mark it active in the dropdown
			const currentModel = this.chatService.serverModel;
			if (currentModel) {
				this._input.setModel(currentModel);
			}
		}));

		this._viewDisposables.add(this._input.onModelChange(modelId => {
			this.chatService.setSelectedModel(modelId);
		}));

		// Set model immediately from saved/default (before connection)
		if (this.chatService.serverModel) {
			this._input.setModel(this.chatService.serverModel);
		}

		this._viewDisposables.add(this.chatService.onDidReceiveChunk(chunk => {
			if (chunk.type === 'brief' && chunk.content) {
				const text = chunk.content.startsWith('BRIEF:') ? chunk.content.slice(6) : chunk.content;
				this._header.showBrief(text);
			}
			if (chunk.type === 'mode_change' && (chunk as any).mode) {
				this._input.setMode((chunk as any).mode as 'agent' | 'plan' | 'ask');
			}
			if (chunk.type === 'thinking' && chunk.content) {
				const comp = this._currentAssistantComp;
				if (comp?.thinkingBlock) {
					comp.thinkingBlock.appendContent(chunk.content);
				}
			}
			if (chunk.type === 'thinking_done') {
				const comp = this._currentAssistantComp;
				if (comp?.thinkingBlock) {
					comp.thinkingBlock.stopStreaming();
				}
			}
			if (chunk.type === 'permission_request' && chunk.tool_call_id && chunk.tool_name) {
				this._showPermissionDialog({
					toolCallId: chunk.tool_call_id,
					toolName: chunk.tool_name,
					args: (chunk.args as Record<string, unknown>) || {},
				});
			}
			if (chunk.type === 'text') {
				this._scrollToBottom();
			}
		}));
	}

	private _currentAssistantComp: AssistantMessage | null = null;
	private _renderedMessageCount = 0;
	private _messageComponents: Map<number, UserMessage | AssistantMessage> = new Map();

	private _renderMessages(messages: readonly IChatMessage[]): void {
		if (!this._messagesEl) { return; }

		const hasMessages = messages.length > 0;
		this._welcomeEl.style.display = hasMessages ? 'none' : 'flex';

		// Messages were cleared — reset everything
		if (messages.length < this._renderedMessageCount) {
			DOM.clearNode(this._messagesEl);
			this._messageComponents.clear();
			this._renderedMessageCount = 0;
			this._currentAssistantComp = null;
			this._messagesEl.appendChild(this._welcomeEl);
		}

		if (!hasMessages) { return; }

		// Only the last message changed (streaming content update) — re-render just that one
		const isContentUpdate = messages.length === this._renderedMessageCount && messages.length > 0;
		if (isContentUpdate) {
			const lastIdx = messages.length - 1;
			const lastMsg = messages[lastIdx];
			if (lastMsg.role === 'assistant') {
				const oldComp = this._messageComponents.get(lastIdx);
				if (oldComp) {
					oldComp.element.remove();
				}
				const duration = this._turnStartTime > 0 ? Date.now() - this._turnStartTime : 0;
				const isThinking = this.chatService.isThinking;
				const comp = new AssistantMessage(lastMsg, duration, (filePath) => {
					this._openFile(filePath);
				}, isThinking);
				comp.appendTo(this._messagesEl);
				this._viewDisposables.add(comp);
				this._viewDisposables.add(comp.onCopy(text => {
					navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
				}));
				this._messageComponents.set(lastIdx, comp);
				this._currentAssistantComp = comp;
			}
		} else {
			// Only append new messages
			for (let i = this._renderedMessageCount; i < messages.length; i++) {
				const msg = messages[i];
				if (msg.role === 'user') {
					const comp = new UserMessage(msg);
					comp.appendTo(this._messagesEl);
					this._viewDisposables.add(comp);
					this._messageComponents.set(i, comp);
				} else if (msg.role === 'assistant') {
					const duration = this._turnStartTime > 0 ? Date.now() - this._turnStartTime : 0;
					const isThinking = this.chatService.isThinking && msg === messages[messages.length - 1];
					const comp = new AssistantMessage(msg, duration, (filePath) => {
						this._openFile(filePath);
					}, isThinking);
					comp.appendTo(this._messagesEl);
					this._viewDisposables.add(comp);
					this._viewDisposables.add(comp.onCopy(text => {
						navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
					}));
					this._messageComponents.set(i, comp);
					if (msg === messages[messages.length - 1]) {
						this._currentAssistantComp = comp;
					}
				}
			}
		}

		this._renderedMessageCount = messages.length;

		if (this.chatService.isStreaming) {
			const cursor = document.createElement('span');
			cursor.className = 'sc-streaming-cursor';
			const lastBody = this._messagesEl.querySelector('.sc-assistant-msg:last-child .sc-assistant-body');
			if (lastBody) { lastBody.appendChild(cursor); }
		}

		this._scrollToBottom();
	}

	private _scrollToBottom(): void {
		if (this._messagesEl) {
			this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override focus(): void {
		this._input?.focus();
	}

	private _fetchSessions(): void {
		const sessions = this.chatService.getSavedSessions();
		this._header.setSessions(sessions.map(s => ({
			id: s.id,
			title: s.title,
			updated_at: new Date(s.date).toISOString(),
		})));
	}

	private _exportChat(): void {
		const msgs = this.chatService.messages;
		const text = msgs.map(m => `[${m.role}]\n${m.content}\n`).join('\n---\n\n');
		navigator.clipboard.writeText(text).catch(() => { /* */ });
	}

	private _openFile(filePath: string): void {
		const uri = URI.file(filePath);
		this.editorService.openEditor({ resource: uri }).then(undefined, () => { /* ignore */ });
	}

	private _showPermissionDialog(data: PermissionRequestData): void {
		if (!this._messagesEl) { return; }
		const dialog = new PermissionRequestDialog(data);
		dialog.appendTo(this._messagesEl);
		this._viewDisposables.add(dialog);
		this._viewDisposables.add(dialog.onRespond(result => {
			this.chatService.respondToPermission(result.toolCallId, result.approved);
		}));
		this._scrollToBottom();
	}
}
