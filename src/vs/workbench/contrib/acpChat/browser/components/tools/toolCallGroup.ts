import { Component } from '../base.js';
import { ToolCallItem } from './toolCallItem.js';
import type { AcpNotification } from '../../acp-utils.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';

export interface ToolCallInfo {
	id: string;
	name: string;
	input: string;
	output: string;
	status: string;
	// Extended fields from ACP notifications
	kind?: string;
	content?: Array<Record<string, unknown>>;
	rawInput?: unknown;
	rawOutput?: unknown;
}

export class ToolCallGroup extends Component {
	private _items: Map<string, ToolCallItem> = new Map();
	private _toolData: Map<string, Partial<ToolCallInfo>> = new Map();
	private readonly _instantiationService: IInstantiationService;
	private readonly _cwd: string;

	constructor(instantiationService: IInstantiationService, cwd: string = '') {
		super('div', 'sc-tool-block');
		this._instantiationService = instantiationService;
		this._cwd = cwd;
	}

	appendNotification(notification: AcpNotification): void {
		const update = notification.data.update;
		const sessionUpdate = update.sessionUpdate as string;

		if (sessionUpdate === 'tool_call') {
			const tc = this._extractToolCallInfo(update);
			console.log(`[ToolCallGroup] tool_call: id="${tc.id}" name="${tc.name}" kind="${tc.kind}"`);
			this._toolData.set(tc.id, tc);
			const item = new ToolCallItem(tc, this._instantiationService, this._cwd);
			item.appendTo(this.element);
			this._register(item);
			this._items.set(tc.id, item);
			console.log(`[ToolCallGroup] items map now has ${this._items.size} entries:`, Array.from(this._items.keys()));
		}

		if (sessionUpdate === 'tool_call_update') {
			const toolCallId = (update.tool_call_id ?? update.toolCallId) as string || '';
			console.log(`[ToolCallGroup] tool_call_update: toolCallId="${toolCallId}" status="${update.status}" hasContent=${!!update.content}`);
			const item = this._items.get(toolCallId);
			if (!item) {
				console.error(`[ToolCallGroup] ERROR: tool_call_update for unknown toolCallId="${toolCallId}"! Known IDs:`, Array.from(this._items.keys()));
				return;
			}

			const status = update.status as string;
			if (status) item.updateStatus(status);

			// Forward content blocks to the item (terminal output, text, etc.)
			const newContent = update.content as Array<Record<string, unknown>> | undefined;
			if (newContent) {
				for (const block of newContent) {
					item.appendContentBlock(block);
				}
			}

			// Accumulate data for tracking
			const existingData = this._toolData.get(toolCallId) || {};
			if (newContent) {
				existingData.content = [...(existingData.content || []), ...newContent];
				this._toolData.set(toolCallId, existingData);
			}

			// Merge rawOutput
			const newRawOutput = update.rawOutput as Record<string, unknown> | undefined;
			if (newRawOutput) {
				existingData.rawOutput = {
					...(typeof existingData.rawOutput === 'object' ? existingData.rawOutput : {}),
					...newRawOutput,
				};
				this._toolData.set(toolCallId, existingData);
			}
		}
	}

	private _extractToolCallInfo(update: Record<string, unknown>): ToolCallInfo {
		const toolCallId = (update.toolCallId ?? update.tool_call_id) as string || '';
		const name = (update.title ?? update.name) as string || '';
		const kind = update.kind as string | undefined;
		const rawInput = update.rawInput ?? update.raw_input;
		const content = update.content as Array<Record<string, unknown>> | undefined;

		return {
			id: toolCallId,
			name,
			input: typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput),
			output: '',
			status: 'running',
			kind,
			content: content || [],
			rawInput,
		};
	}

	stopStreaming(): void {
		// No-op for tool groups
	}
}
