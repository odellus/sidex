/*---------------------------------------------------------------------------------------------
 *  ACP Chat Store — notification log for the native ACP chat.
 *  Talks to the Rust `sidex-acp` backend via Tauri invoke/listen.
 *  Ported from crow-ui's acp-store with Sidex's DI & event patterns.
 *
 *  The store is a dumb append-only log. Every session/update event from the
 *  backend gets pushed to the notifications array as-is, preserving arrival order.
 *  The view groups consecutive same-type notifications and renders each group
 *  as its own visual block, maintaining chronological ordering.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock } from '@agentclientprotocol/sdk';
import { invoke } from '../../../../sidex-bridge.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { listen } from '@tauri-apps/api/event';
import type { AcpNotification } from './acp-utils.js';

// ─── Tauri event listener ─────────────────────────────────────────────────

async function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
	for (let attempt = 0; attempt < 30; attempt++) {
		try {
			return await listen<T>(event, (e) => handler(e.payload));
		} catch (e: any) {
			const msg = e?.message || String(e);
			if (msg.includes('proxy disconnected') && attempt < 29) {
				await new Promise(r => setTimeout(r, 1000));
				continue;
			}
			return () => {};
		}
	}
	return () => {};
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'ready';

export interface PromptTurnState {
	status: 'idle' | 'running' | 'complete' | 'cancelled' | 'error';
	stopReason?: string;
	message?: string;
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

export interface ControlSignal {
	type: string;
	content?: string;
	tool_call_id?: string;
	tool_name?: string;
	args?: unknown;
}

// ─── Store ─────────────────────────────────────────────────────────────────

export interface SessionConfigOption {
	id: string;
	name: string;
	category?: string;
	currentValue?: string;
	options: Array<{ name: string; value: string; description?: string }>;
}

export class AcpStore {
	private _connectionId: string = '';
	private _sessionId: string = '';
	private _cwd: string = '';

	private _connectionStatus: ConnectionStatus = 'disconnected';
	private _connectingSafetyTimer: ReturnType<typeof setTimeout> | null = null;
	private _promptTurnState: PromptTurnState = { status: 'idle' };
	private _notifications: AcpNotification[] = [];
	private _isStreaming: boolean = false;
	private _queuedItems: QueuedItem[] = [];
	private _configOptions: SessionConfigOption[] = [];

	private readonly _onDidChangeNotifications = this._registerEmitter<void>();
	readonly onDidChangeNotifications: Event<void> = this._onDidChangeNotifications.event;

	private readonly _onDidChangeStreaming = this._registerEmitter<boolean>();
	readonly onDidChangeStreaming: Event<boolean> = this._onDidChangeStreaming.event;

	private readonly _onDidChangeConnectionState = this._registerEmitter<void>();
	readonly onDidChangeConnectionState: Event<void> = this._onDidChangeConnectionState.event;

	private readonly _onDidReceiveControlSignal = this._registerEmitter<ControlSignal>();
	readonly onDidReceiveControlSignal: Event<ControlSignal> = this._onDidReceiveControlSignal.event;

	private readonly _onDidChangeConfigOptions = this._registerEmitter<SessionConfigOption[]>();
	readonly onDidChangeConfigOptions: Event<SessionConfigOption[]> = this._onDidChangeConfigOptions.event;

	private _unlisteners: (() => void)[] = [];
	private _eventListenerStarted = false;

	private _registerEmitter<T>(): Emitter<T> {
		const e = new Emitter<T>();
		return e;
	}

	// ─── Public getters ────────────────────────────────────────────────────

	get connectionStatus(): ConnectionStatus { return this._connectionStatus; }
	get promptTurnState(): PromptTurnState { return this._promptTurnState; }
	get notifications(): readonly AcpNotification[] { return this._notifications; }
	get isStreaming(): boolean { return this._isStreaming; }
	get sessionId(): string { return this._sessionId; }
	get connectionId(): string { return this._connectionId; }
	get cwd(): string { return this._cwd; }
	get queuedItems(): QueuedItem[] { return this._queuedItems; }
	get configOptions(): SessionConfigOption[] { return this._configOptions; }

	// ─── Lifecycle ─────────────────────────────────────────────────────────

	/** Start listening to Tauri ACP events. Call once after construction. */
	async start(): Promise<void> {
		if (this._eventListenerStarted) { return; }
		this._eventListenerStarted = true;
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
		this._clearConnectingSafetyTimer();
	}

	private _clearConnectingSafetyTimer(): void {
		if (this._connectingSafetyTimer) {
			clearTimeout(this._connectingSafetyTimer);
			this._connectingSafetyTimer = null;
		}
	}

	private _startConnectingSafetyTimer(): void {
		this._clearConnectingSafetyTimer();
		this._connectingSafetyTimer = setTimeout(() => {
			if (this._connectionStatus === 'connecting') {
				console.warn('[AcpStore] Connecting safety timer fired — forcing status back to ready');
				this._connectionStatus = 'ready';
				this._onDidChangeConnectionState.fire();
			}
		}, 10000);
	}

	// ─── Agent lifecycle ───────────────────────────────────────────────────

	/**
	 * Spawn an agent and connect to it. If we already have a session_id,
	 * try to load that existing session first. If that fails, create a new one.
	 */
	async spawnAndConnect(config: {
		name: string;
		command: string;
		args: string[];
		env: string[];
		cwd: string;
	}): Promise<void> {
		// If we already have both IDs and are ready, don't reconnect
		if (this._sessionId && this._connectionId && this._connectionStatus === 'ready') {
			return;
		}

		this._connectionStatus = 'connecting';
		this._startConnectingSafetyTimer();
		this._cwd = config.cwd;
		this._onDidChangeConnectionState.fire();

		try {
			// Spawn the agent process
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

			// If we have a previous session_id, try to load it
			if (this._sessionId) {
				try {
					const loadResp = await invoke<{ session_id: string; config_options?: SessionConfigOption[] }>('acp_chat_load_session', {
						request: {
							connection_id: this._connectionId,
							session_id: this._sessionId,
							cwd: config.cwd,
							mcp_servers: [],
						},
					});
					this._sessionId = loadResp.session_id;
					this._configOptions = loadResp.config_options || [];
					this._onDidChangeConfigOptions.fire(this._configOptions);
					this._connectionStatus = 'ready';
					this._clearConnectingSafetyTimer();
					this._onDidChangeConnectionState.fire();
					return;
				} catch (e) {
					// Load failed (session doesn't exist), fall through to create new
					console.log('[AcpStore] load_session failed, creating new session:', e);
				}
			}

			// Create a new session
			const sessionResp = await invoke<{ session_id: string; config_options?: SessionConfigOption[] }>('acp_chat_new_session', {
				request: {
					connection_id: this._connectionId,
					mcp_servers: [],
				},
			});
			this._sessionId = sessionResp.session_id;
			this._configOptions = sessionResp.config_options || [];
			this._connectionStatus = 'ready';
			this._clearConnectingSafetyTimer();
			this._onDidChangeConfigOptions.fire(this._configOptions);
			this._onDidChangeConnectionState.fire();
		} catch (e) {
			this._connectionStatus = 'disconnected';
			this._clearConnectingSafetyTimer();
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
		this._clearConnectingSafetyTimer();
		this._notifications = [];
		this._onDidChangeConnectionState.fire();
		this._onDidChangeNotifications.fire();
	}

	// ─── Prompt ────────────────────────────────────────────────────────────

	async sendMessage(text: string, contentBlocks?: ContentBlock[]): Promise<void> {
		if (!this._sessionId) { return; }

		this._setStreaming(true);

		// Use provided blocks or create text block from string
		const blocks: ContentBlock[] = contentBlocks || [{ type: 'text' as const, text }];

		// Reconstruct text from blocks if not provided
		const displayText = text || blocks.map(b => {
			if (b.type === 'text') return (b as { text: string }).text;
			if (b.type === 'image') return '![Image]';
			if (b.type === 'resource_link') {
				const link = b as { uri: string; name: string };
				return `[@${link.name}](${link.uri})`;
			}
			return '';
		}).join('');

		// Add user message notification immediately for instant feedback
		const userNotification: AcpNotification = {
			id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			type: 'session_notification',
			data: {
				update: {
					sessionUpdate: 'user_message_chunk',
					content: { text: displayText, blocks },
				},
			},
		};
		this._notifications = [...this._notifications, userNotification];
		this._onDidChangeNotifications.fire();

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
			return;
		}
		// Safety: if prompt_complete event was missed, clean up
		if (this._isStreaming) {
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
			const result = await invoke<{ sessions?: { sessionId: string; title?: string; updatedAt?: string }[] }>('acp_chat_list_sessions', {
				request: { session_id: this._sessionId, cwd },
			});
			console.log('[acpStore] listSessions raw result:', JSON.stringify(result));
			const sessions = (result.sessions || []).map((s: { sessionId: string; title?: string; updatedAt?: string }) => ({
				id: s.sessionId,
				title: s.title || s.sessionId.slice(0, 8),
				date: s.updatedAt ? new Date(s.updatedAt).getTime() : Date.now(),
			}));
			console.log('[acpStore] listSessions mapped:', JSON.stringify(sessions));
			return sessions;
		} catch (e) {
			console.error('[acpStore] listSessions failed:', e);
			return [];
		}
	}

	async loadSession(sessionId: string): Promise<void> {
		if (!this._sessionId) {
			console.warn('[acpStore] loadSession: no active session');
			return;
		}

		console.log('[acpStore] loadSession: switching from', this._sessionId, 'to', sessionId);

		// Show loading state
		this._connectionStatus = 'connecting';
		this._startConnectingSafetyTimer();
		this._onDidChangeConnectionState.fire();

		try {
			const resp = await invoke<{ session_id: string; config_options?: SessionConfigOption[] }>('acp_chat_switch_session', {
				request: {
					current_session_id: this._sessionId,
					target_session_id: sessionId,
					cwd: this._cwd,
					mcp_servers: [],
				},
			});

			console.log('[acpStore] loadSession: switch succeeded, new session_id:', resp.session_id);

			this._notifications = [];
			this._sessionId = resp.session_id;
			this._configOptions = resp.config_options || [];
			this._connectionStatus = 'ready';
			this._clearConnectingSafetyTimer();
			this._onDidChangeConfigOptions.fire(this._configOptions);
			this._onDidChangeNotifications.fire();
			this._onDidChangeConnectionState.fire();
		} catch (e) {
			console.error('[AcpStore] loadSession failed:', e);
			this._connectionStatus = 'ready';
			this._clearConnectingSafetyTimer();
			this._onDidChangeConnectionState.fire();
			throw e;
		}
	}

	async setConfigOption(configId: string, value: string): Promise<void> {
		if (!this._sessionId) {
			throw new Error('No active session');
		}

		const updated = await invoke<SessionConfigOption[]>('acp_chat_set_config_option', {
			request: {
				session_id: this._sessionId,
				config_id: configId,
				value: value,
			},
		});

		this._configOptions = updated || [];
		this._onDidChangeConfigOptions.fire(this._configOptions);
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

		// ── Control signals (NOT appended to notification log) ──

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
			return;
		}

		if (sessionUpdate === 'queue_changed') {
			this._queuedItems = (update.items as QueuedItem[]) || [];
			return;
		}

		// Brief updates (control signal)
		if (sessionUpdate === 'brief') {
			const text = content?.text as string || '';
			this._onDidReceiveControlSignal.fire({ type: 'brief', content: text });
			return;
		}

		// Permission requests (control signal)
		if (sessionUpdate === 'permission_request') {
			const toolCallId = update.toolCallId as string;
			const toolName = update.toolName as string;
			const args = update.args;
			this._onDidReceiveControlSignal.fire({
				type: 'permission_request',
				tool_call_id: toolCallId,
				tool_name: toolName,
				args,
			});
			return;
		}

		// Config option updates (control signal)
		if (sessionUpdate === 'config_option_update') {
			const configOptions = update.configOptions as SessionConfigOption[];
			this._configOptions = configOptions || [];
			this._onDidChangeConfigOptions.fire(this._configOptions);
			return;
		}

		// ── Content events (appended to notification log) ──

		const notificationId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const notification: AcpNotification = {
			id: notificationId,
			type: 'session_notification',
			data: { update },
		};
		this._notifications = [...this._notifications, notification];
		this._onDidChangeNotifications.fire();
	}

	private _setStreaming(streaming: boolean): void {
		if (this._isStreaming !== streaming) {
			this._isStreaming = streaming;
			this._onDidChangeStreaming.fire(streaming);
		}
	}

	clearMessages(): void {
		this._notifications = [];
		this._onDidChangeNotifications.fire();
	}
}
