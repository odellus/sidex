/*---------------------------------------------------------------------------------------------
 *  ACP Chat Store — reactive state for the native ACP chat.
 *  Talks to the Rust `sidex-acp` backend via Tauri invoke/listen.
 *  Ported from crow-ui's acp-store with Sidex's DI & event patterns.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock } from '@agentclientprotocol/sdk';
import { invoke } from '../../../../sidex-bridge.js';
import { Emitter, Event } from '../../../../base/common/event.js';

// ─── Tauri event listener (from sidexLspService pattern) ──────────────────

interface TauriEventWindow {
	__TAURI__?: {
		event?: {
			listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
		};
	};
}

function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
	const w = globalThis as unknown as TauriEventWindow;
	const listen = w.__TAURI__?.event?.listen;
	if (!listen) { return Promise.resolve(() => {}); }
	return listen<T>(event, e => handler(e.payload));
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'ready';

export interface PromptTurnState {
	status: 'idle' | 'running' | 'complete' | 'cancelled' | 'error';
	stopReason?: string;
	message?: string;
}

export interface ToolCallInfo {
	id: string;
	name: string;
	input: string;
	output: string;
	status: string;
}

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	thinkingContent?: string;
	toolCalls?: ToolCallInfo[];
}

export interface QueuedItem {
	id: string;
	text: string;
	blocks: ContentBlock[];
}

export interface SessionInfo {
	sessionId: string;
	connectionId: string;
	agentId: string;
	agentName: string;
	cwd: string;
}

// ─── Internal notification tracking ────────────────────────────────────────

interface RawNotification {
	type: string;
	content?: { text?: string };
	text?: string;
	title?: string;
	status?: string;
	toolCallId?: string;
	name?: string;
	input?: unknown;
	output?: unknown;
	locations?: unknown[];
}

// ─── Store ─────────────────────────────────────────────────────────────────

export class AcpStore {
	private _connectionId: string = '';
	private _sessionId: string = '';
	private _cwd: string = '';

	private _connectionStatus: ConnectionStatus = 'disconnected';
	private _promptTurnState: PromptTurnState = { status: 'idle' };
	private _messages: ChatMessage[] = [];
	private _isStreaming: boolean = false;
	private _queuedItems: QueuedItem[] = [];
	private _rawNotifications: RawNotification[] = [];

	// Tool calls being accumulated for the current assistant message
	private _pendingToolCalls: Map<string, ToolCallInfo> = new Map();
	// Thinking content being accumulated
	private _pendingThinking: string = '';

	private readonly _onDidChange = this._registerEmitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidReceiveChunk = this._registerEmitter<{ type: string; content?: string; tool_call_id?: string; tool_name?: string; args?: unknown }>();
	readonly onDidReceiveChunk: Event<{ type: string; content?: string; tool_call_id?: string; tool_name?: string; args?: unknown }> = this._onDidReceiveChunk.event;

	private readonly _onDidChangeStreaming = this._registerEmitter<boolean>();
	readonly onDidChangeStreaming: Event<boolean> = this._onDidChangeStreaming.event;

	private readonly _onDidChangeConnectionState = this._registerEmitter<void>();
	readonly onDidChangeConnectionState: Event<void> = this._onDidChangeConnectionState.event;

	private _unlisteners: (() => void)[] = [];

	private _registerEmitter<T>(): Emitter<T> {
		const e = new Emitter<T>();
		// Store the dispose function so we can clean up later
		return e;
	}

	// ─── Public getters ────────────────────────────────────────────────────

	get connectionStatus(): ConnectionStatus { return this._connectionStatus; }
	get promptTurnState(): PromptTurnState { return this._promptTurnState; }
	get messages(): readonly ChatMessage[] { return this._messages; }
	get isStreaming(): boolean { return this._isStreaming; }
	get isThinking(): boolean { return this._isStreaming && this._pendingThinking.length > 0; }
	get sessionId(): string { return this._sessionId; }
	get connectionId(): string { return this._connectionId; }
	get cwd(): string { return this._cwd; }
	get queuedItems(): QueuedItem[] { return this._queuedItems; }

	// ─── Lifecycle ─────────────────────────────────────────────────────────

	/** Start listening to Tauri ACP events. Call once after construction. */
	async start(): Promise<void> {
		const unlisten = await tauriListen<{
			type: string;
			sessionId: string;
			update: Record<string, unknown>;
		}>('acp:sessionUpdate', (payload) => {
			this._handleSessionEvent(payload);
		});
		this._unlisteners.push(unlisten);
	}

	dispose(): void {
		for (const u of this._unlisteners) { u(); }
		this._unlisteners = [];
	}

	// ─── Agent lifecycle ───────────────────────────────────────────────────

	async spawnAndConnect(config: {
		name: string;
		command: string;
		args: string[];
		env: string[];
		cwd: string;
	}): Promise<void> {
		this._connectionStatus = 'connecting';
		this._cwd = config.cwd;
		this._onDidChangeConnectionState.fire();

		try {
			const resp = await invoke<{ connection_id: string }>('acp_chat_spawn', {
				request: {
					name: config.name,
					command: config.command,
					args: config.args,
					env: config.env,
					cwd: config.cwd,
				},
			});
			if (!resp || !resp.connection_id) {
				throw new Error('acp_chat_spawn returned no connection_id (Tauri not available?)');
			}
			this._connectionId = resp.connection_id;

			const sessionResp = await invoke<{ session_id: string }>('acp_chat_new_session', {
				request: {
					connection_id: this._connectionId,
					mcp_servers: [],
				},
			});
			this._sessionId = sessionResp.session_id;
			this._connectionStatus = 'ready';
			this._onDidChangeConnectionState.fire();
		} catch (e) {
			this._connectionStatus = 'disconnected';
			this._onDidChangeConnectionState.fire();
			throw e;
		}
	}

	async closeSession(): Promise<void> {
		if (!this._sessionId) { return; }
		await invoke('acp_chat_close_session', {
			request: { session_id: this._sessionId },
		});
		this._sessionId = '';
		this._connectionId = '';
		this._connectionStatus = 'disconnected';
		this._messages = [];
		this._onDidChangeConnectionState.fire();
		this._onDidChange.fire();
	}

	// ─── Prompt ────────────────────────────────────────────────────────────

	async sendMessage(text: string): Promise<void> {
		if (!this._sessionId) { return; }

		this._setStreaming(true);

		// Add user message immediately for instant feedback
		this._messages = [...this._messages, { role: 'user', content: text }];
		this._onDidChange.fire();

		const blocks: ContentBlock[] = [{ type: 'text' as const, text }];

		try {
			await invoke('acp_chat_prompt', {
				request: {
					session_id: this._sessionId,
					blocks,
				},
			});
		} catch (e) {
			console.error('[acpStore] prompt failed:', e);
			this._setStreaming(false);
		}
	}

	async stopStreaming(): Promise<void> {
		if (!this._sessionId) { return; }
		await invoke('acp_chat_cancel', {
			request: { session_id: this._sessionId },
		});
		this._setStreaming(false);
	}

	// ─── Session history ───────────────────────────────────────────────────

	async listSessions(cwd: string): Promise<{ id: string; title: string; date: number }[]> {
		if (!this._sessionId) { return []; }
		try {
			const result = await invoke<{ sessions?: { id: string; title?: string; updatedAt?: string }[] }>('acp_chat_list_sessions', {
				request: { session_id: this._sessionId, cwd },
			});
			return (result.sessions || []).map((s: { id: string; title?: string; updatedAt?: string }) => ({
				id: s.id,
				title: s.title || s.id.slice(0, 8),
				date: s.updatedAt ? new Date(s.updatedAt).getTime() : Date.now(),
			}));
		} catch {
			return [];
		}
	}

	async loadSession(sessionId: string): Promise<void> {
		// For now: close current session, spawn new agent, load session
		// This is a simplified version — proper session/load will come later
		console.log('[acpStore] loadSession:', sessionId);
	}

	// ─── Internal event handling ───────────────────────────────────────────

	private _handleSessionEvent(payload: {
		type: string;
		sessionId: string;
		update: Record<string, unknown>;
	}): void {
		const { sessionId, update } = payload;

		if (sessionId !== this._sessionId) { return; }

		const sessionUpdate = update.sessionUpdate as string | undefined;
		const content = update.content as Record<string, unknown> | undefined;

		// Backend-owned prompt lifecycle
		if (sessionUpdate === 'prompt_state') {
			const status = update.status as string;
			if (status === 'running') {
				this._promptTurnState = { status: 'running' };
				this._setStreaming(true);
			} else if (status === 'idle') {
				this._promptTurnState = { status: 'idle' };
				this._setStreaming(false);
			}
			return;
		}

		if (sessionUpdate === 'prompt_complete') {
			const stopReason = (update.stopReason as string) || 'unknown';
			if (stopReason === 'cancelled') {
				this._promptTurnState = { status: 'cancelled' };
			} else if (stopReason === 'error') {
				this._promptTurnState = { status: 'error', message: (update.error as string) || 'unknown error' };
			} else {
				this._promptTurnState = { status: 'complete', stopReason };
			}
			this._setStreaming(false);
			this._finalizeAssistantMessage();
			return;
		}

		if (sessionUpdate === 'queue_changed') {
			this._queuedItems = (update.items as QueuedItem[]) || [];
			this._onDidChange.fire();
			return;
		}

		// User message chunk
		if (sessionUpdate === 'user_message_chunk') {
			const text = content?.text as string || '';
			this._onDidReceiveChunk.fire({ type: 'text', content: text });
			return;
		}

		// Assistant content streaming
		if (sessionUpdate === 'assistant_message_chunk') {
			const text = content?.text as string || '';
			this._onDidReceiveChunk.fire({ type: 'text', content: text });
			return;
		}

		// Thinking
		if (sessionUpdate === 'thinking') {
			const text = content?.text as string || '';
			this._pendingThinking += text;
			this._onDidReceiveChunk.fire({ type: 'thinking', content: text });
			return;
		}

		if (sessionUpdate === 'thinking_done') {
			this._onDidReceiveChunk.fire({ type: 'thinking_done' });
			return;
		}

		// Tool calls
		if (sessionUpdate === 'tool_call') {
			const toolCallId = update.toolCallId as string || '';
			const name = update.name as string || '';
			const input = update.input as unknown;
			this._pendingToolCalls.set(toolCallId, {
				id: toolCallId,
				name,
				input: typeof input === 'string' ? input : JSON.stringify(input),
				output: '',
				status: 'running',
			});
			this._onDidReceiveChunk.fire({
				type: 'tool_call',
				tool_call_id: toolCallId,
				tool_name: name,
				args: input,
			});
			return;
		}

		if (sessionUpdate === 'tool_call_update') {
			const toolCallId = update.toolCallId as string || '';
			const status = update.status as string;
			const output = update.output as unknown;
			const existing = this._pendingToolCalls.get(toolCallId);
			if (existing) {
				if (status) { existing.status = status; }
				if (output !== undefined) {
					if (typeof output === 'string') {
						existing.output += output;
					} else {
						existing.output = JSON.stringify(output);
					}
				}
			}
			return;
		}

		// Brief/title updates
		if (sessionUpdate === 'brief') {
			const text = content?.text as string || '';
			this._onDidReceiveChunk.fire({ type: 'brief', content: text });
			return;
		}

		// Permission requests
		if (sessionUpdate === 'permission_request') {
			const toolCallId = update.toolCallId as string;
			const toolName = update.toolName as string;
			const args = update.args;
			this._onDidReceiveChunk.fire({
				type: 'permission_request',
				tool_call_id: toolCallId,
				tool_name: toolName,
				args,
			});
			return;
		}
	}

	private _setStreaming(streaming: boolean): void {
		if (this._isStreaming !== streaming) {
			this._isStreaming = streaming;
			if (!streaming) {
				this._pendingThinking = '';
			}
			this._onDidChangeStreaming.fire(streaming);
			this._onDidChange.fire();
		}
	}

	private _finalizeAssistantMessage(): void {
		// Build the assistant message from accumulated chunks
		const toolCalls: ToolCallInfo[] = [];
		for (const tc of this._pendingToolCalls.values()) {
			toolCalls.push({ ...tc });
		}

		const thinkingContent = this._pendingThinking || undefined;

		// The actual content comes from the chat view's chunk accumulation
		// Here we just need to add the structured parts
		const msg: ChatMessage = {
			role: 'assistant',
			content: '', // filled by chunk accumulation in the view
			thinkingContent,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
		};

		this._messages = [...this._messages, msg];
		this._pendingToolCalls.clear();
		this._pendingThinking = '';
		this._onDidChange.fire();
	}

	clearMessages(): void {
		this._messages = [];
		this._pendingToolCalls.clear();
		this._pendingThinking = '';
		this._onDidChange.fire();
	}
}
