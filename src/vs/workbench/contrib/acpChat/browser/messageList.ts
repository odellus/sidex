/*---------------------------------------------------------------------------------------------
 *  MessageList — Shared chat message rendering with sliding-window virtualization.
 *
 *  Both AcpChatViewPane (sidebar) and AcpChatEditor (editor tab) delegate to this
 *  class for message rendering. This ensures both implementations are identical.
 *
 *  Virtualization strategy:
 *  - Keeps a sliding window of the most recent N rendered groups in the DOM.
 *  - When the window exceeds MAX_GROUPS, oldest groups are disposed and replaced
 *    with a height-preserving spacer div so scroll position is unaffected.
 *  - When the user scrolls to the top (near the spacer), older messages are
 *    re-created from the notification data model (acpStore._notifications[]),
 *    inserted before the first rendered group, and the spacer is adjusted.
 *  - The notification data model is never pruned — only the DOM is virtualized.
 *
 *  Inspired by the "measure-once" pattern from production AI chat UIs (Orbit,
 *  react-virtuoso MessageList): completed messages have deterministic height,
 *  so a spacer that captures their measured height is accurate forever.
 *--------------------------------------------------------------------------------------------*/

import { Component, DOM, $ } from './components/base.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ScrollManager } from './scrollManager.js';
import { UserMessage } from './components/messages/userMessage.js';
import { ThinkingBlock } from './components/messages/thinkingBlock.js';
import { AgentMessageGroup } from './components/messages/agentMessage.js';
import { ToolCallGroup } from './components/tools/toolCallGroup.js';
import type { AcpNotification } from './acp-utils.js';

type MessageComponent = UserMessage | ThinkingBlock | AgentMessageGroup | ToolCallGroup;

interface RenderedGroup {
	type: string;
	component: MessageComponent;
	wrapper: HTMLElement;
	notificationCount: number;
}

export interface MessageListDeps {
	instantiationService: IInstantiationService;
	cwd: string;
	getNotifications: () => readonly AcpNotification[];
}

const MAX_GROUPS = 50;
const LOAD_BATCH = 25;
const TOP_THRESHOLD = 100;

export class MessageList extends Component {
	private _welcomeEl: HTMLElement;
	private _sentinelEl: HTMLElement;
	private _scrollManager: ScrollManager;
	private _deps: MessageListDeps;

	private _groups: RenderedGroup[] = [];
	private _lastGroupType: string | null = null;
	private _lastGroupComp: MessageComponent | null = null;

	private _renderedStartIndex = 0;
	private _renderedEndIndex = 0;
	private _spacerEl: HTMLElement | null = null;
	private _spacerHeight = 0;
	private _loadingOlder = false;
	private _scrollRAFPending = false;

	constructor(deps: MessageListDeps) {
		super('div', 'sc-messages');
		this._deps = deps;

		this._welcomeEl = DOM.append(this.element, $('div.sc-welcome'));
		DOM.append(this._welcomeEl, $('div.sc-welcome-title')).textContent = 'crow-cli';
		DOM.append(this._welcomeEl, $('div.sc-welcome-subtitle')).textContent = 'Ask anything';

		this._sentinelEl = DOM.append(this.element, $('div.sc-scroll-sentinel'));

		this._scrollManager = new ScrollManager(this.element, this._sentinelEl);
		this._disposables.add(this._scrollManager);

		this._disposables.add(DOM.addDisposableListener(
			this.element, 'sc:heavy-render-done' as any,
			() => this._scrollManager.scrollToBottom()
		));

		this._disposables.add(DOM.addDisposableListener(
			this.element, 'scroll', () => this._checkScrollNearTop()
		));
	}

	get scrollManager(): ScrollManager { return this._scrollManager; }
	get renderedCount(): number { return this._renderedEndIndex; }

	renderNotification(notification: AcpNotification): void {
		const notifications = this._deps.getNotifications();
		this._welcomeEl.style.display = notifications.length > 0 ? 'none' : 'flex';

		if (notifications.length === 0) {
			this.reset();
			return;
		}

		this._renderNotification(notification);
		this._renderedEndIndex = notifications.length;
		this._trimOldGroups();

		if (!this._scrollRAFPending) {
			this._scrollRAFPending = true;
			requestAnimationFrame(() => {
				this._scrollRAFPending = false;
				this._scrollManager.scrollToBottom();
			});
		}
	}

	catchUp(fromIndex: number): void {
		const notifications = this._deps.getNotifications();

		if (notifications.length === 0) {
			this.reset();
			return;
		}

		if (notifications.length < fromIndex) {
			this.reset();
			fromIndex = 0;
		}

		fromIndex = Math.max(fromIndex, this._renderedEndIndex);

		for (let i = fromIndex; i < notifications.length; i++) {
			this._renderNotification(notifications[i]);
		}
		this._renderedEndIndex = notifications.length;
		this._trimOldGroups();

		this._welcomeEl.style.display = notifications.length > 0 ? 'none' : 'flex';

		if (!this._scrollRAFPending) {
			this._scrollRAFPending = true;
			requestAnimationFrame(() => {
				this._scrollRAFPending = false;
				this._scrollManager.scrollToBottom();
			});
		}
	}

	reset(): void {
		for (const g of this._groups) {
			g.component.dispose();
		}
		this._groups = [];
		this._lastGroupType = null;
		this._lastGroupComp = null;
		this._renderedStartIndex = 0;
		this._renderedEndIndex = 0;

		if (this._spacerEl) {
			this._spacerEl.remove();
			this._spacerEl = null;
			this._spacerHeight = 0;
		}

		DOM.clearNode(this.element);
		this.element.appendChild(this._welcomeEl);
		this.element.appendChild(this._sentinelEl);
		this._welcomeEl.style.display = 'flex';
		this._scrollManager.reset();
	}

	stopStreaming(): void {
		this._lastGroupComp?.stopStreaming();
	}

	detach(): void {
		this.element.remove();
	}

	attachTo(parent: HTMLElement): void {
		parent.appendChild(this.element);
	}

	public override dispose(): void {
		for (const g of this._groups) {
			g.component.dispose();
		}
		this._groups = [];
		super.dispose();
	}

	// ── Private ──

	private _getGroupType(notification: AcpNotification): string {
		const sessionUpdate = notification.data.update.sessionUpdate as string;
		return (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update')
			? 'tool'
			: sessionUpdate;
	}

	private _renderNotification(notification: AcpNotification): void {
		const groupType = this._getGroupType(notification);

		if (groupType === this._lastGroupType && this._lastGroupComp) {
			this._lastGroupComp.appendNotification(notification);
			this._groups[this._groups.length - 1].notificationCount++;
		} else {
			this._lastGroupComp?.stopStreaming();

			const comp = this._createGroupComponent(notification);
			const wrapper = document.createElement('div');
			wrapper.classList.add('sc-message-group');
			this.element.insertBefore(wrapper, this._sentinelEl);
			comp.appendTo(wrapper);
			this._groups.push({ type: groupType, component: comp, wrapper, notificationCount: 1 });
			this._lastGroupComp = comp;
			this._lastGroupType = groupType;
		}
	}

	private _createGroupComponent(notification: AcpNotification): MessageComponent {
		const sessionUpdate = notification.data.update.sessionUpdate as string;
		let comp: MessageComponent;

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
				comp = new ToolCallGroup(this._deps.instantiationService, this._deps.cwd);
				break;
			default:
				comp = new AgentMessageGroup();
				break;
		}

		comp.appendNotification(notification);
		return comp;
	}

	// ── Virtualization ──

	private _trimOldGroups(): void {
		while (this._groups.length > MAX_GROUPS) {
			const group = this._groups[0];
			const groupHeight = group.wrapper.offsetHeight;

			this._spacerHeight += groupHeight;
			if (!this._spacerEl) {
				this._spacerEl = document.createElement('div');
				this._spacerEl.className = 'sc-message-spacer';
				this.element.insertBefore(this._spacerEl, group.wrapper);
			}
			this._spacerEl.style.height = `${this._spacerHeight}px`;

			group.wrapper.remove();
			group.component.dispose();
			this._groups.shift();
			this._renderedStartIndex += group.notificationCount;
		}
	}

	private _checkScrollNearTop(): void {
		if (this._loadingOlder || !this._spacerEl || this._renderedStartIndex === 0) {
			return;
		}
		if (this.element.scrollTop <= TOP_THRESHOLD) {
			this._loadOlderMessages();
		}
	}

	private _loadOlderMessages(): void {
		this._loadingOlder = true;

		const notifications = this._deps.getNotifications();
		const loadStart = Math.max(0, this._renderedStartIndex - LOAD_BATCH);

		if (loadStart >= this._renderedStartIndex) {
			this._loadingOlder = false;
			return;
		}

		const scrollHeightBefore = this.element.scrollHeight;

		this._spacerEl?.remove();
		this._spacerEl = null;

		// Re-group older notifications into components
		const newGroups: RenderedGroup[] = [];
		let currentType: string | null = null;
		let currentComp: MessageComponent | null = null;

		for (let i = loadStart; i < this._renderedStartIndex; i++) {
			const notification = notifications[i];
			if (!notification) { break; }
			const groupType = this._getGroupType(notification);

			if (groupType === currentType && currentComp) {
				currentComp.appendNotification(notification);
				newGroups[newGroups.length - 1].notificationCount++;
			} else {
				currentComp?.stopStreaming();
				const comp = this._createGroupComponent(notification);
				const wrapper = document.createElement('div');
				wrapper.classList.add('sc-message-group');
				comp.appendTo(wrapper);
				newGroups.push({ type: groupType, component: comp, wrapper, notificationCount: 1 });
				currentComp = comp;
				currentType = groupType;
			}
		}
		currentComp?.stopStreaming();

		// Insert new groups before the first existing group
		const insertBefore = this._groups.length > 0
			? this._groups[0].wrapper
			: this._sentinelEl;
		for (const g of newGroups) {
			this.element.insertBefore(g.wrapper, insertBefore);
		}

		this._groups = [...newGroups, ...this._groups];
		this._renderedStartIndex = loadStart;

		// Calculate new spacer height from the scrollHeight delta
		const scrollHeightAfter = this.element.scrollHeight;
		const newSpacerHeight = scrollHeightBefore - scrollHeightAfter;

		if (newSpacerHeight > 0) {
			this._spacerHeight = newSpacerHeight;
			this._spacerEl = document.createElement('div');
			this._spacerEl.className = 'sc-message-spacer';
			this._spacerEl.style.height = `${newSpacerHeight}px`;
			this.element.insertBefore(this._spacerEl, this._groups[0].wrapper);
		} else {
			this._spacerHeight = 0;
		}

		// Show the newly loaded content at the top of the viewport
		this.element.scrollTop = newSpacerHeight > 0 ? newSpacerHeight : 0;

		this._loadingOlder = false;
	}
}
