import { Component } from '../base.js';
import { ToolCallItem } from './toolCallItem.js';
import type { AcpNotification } from '../../acp-utils.js';

export interface ToolCallInfo {
	id: string;
	name: string;
	input: string;
	output: string;
	status: string;
}

export class ToolCallGroup extends Component {
	private _items: Map<string, ToolCallItem> = new Map();

	constructor() {
		super('div', 'sc-tool-block');
	}

	appendNotification(notification: AcpNotification): void {
		const update = notification.data.update;
		const sessionUpdate = update.sessionUpdate as string;

		if (sessionUpdate === 'tool_call') {
			const tc = this._extractToolCallInfo(update);
			const item = new ToolCallItem(tc);
			item.appendTo(this.element);
			this._register(item);
			this._items.set(tc.id, item);
		}

		if (sessionUpdate === 'tool_call_update') {
			const toolCallId = (update.tool_call_id ?? update.toolCallId) as string || '';
			const item = this._items.get(toolCallId);
			if (!item) return;

			const status = update.status as string;
			if (status) item.updateStatus(status);
		}
	}

	private _extractToolCallInfo(update: Record<string, unknown>): ToolCallInfo {
		const toolCallId = update.toolCallId as string || '';
		const name = update.title as string || '';
		const input = update.rawInput as unknown;
		return {
			id: toolCallId,
			name,
			input: typeof input === 'string' ? input : JSON.stringify(input),
			output: '',
			status: 'running',
		};
	}

	stopStreaming(): void {
		// No-op for tool groups
	}
}
