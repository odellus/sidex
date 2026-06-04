/*---------------------------------------------------------------------------------------------
 *  ACP Chat Service — wraps the ACP store for the chat view.
 *  Handles agent lifecycle, model selection, and message streaming.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { AcpStore, ConnectionStatus, PromptTurnState, ControlSignal, SessionConfigOption } from './acpStore.js';
import type { AcpNotification } from './acp-utils.js';

// ─── Service interface ─────────────────────────────────────────────────────

export const IAcpChatService = createDecorator<IAcpChatService>('acpChatService');

export interface IAcpChatService {
	readonly _serviceBrand: undefined;

	// Connection state
	readonly connectionState: ConnectionStatus;

	// Notifications
	readonly notifications: readonly AcpNotification[];
	readonly isStreaming: boolean;

	// Config options
	readonly configOptions: SessionConfigOption[];

	// Model info
	readonly serverModel: string;

	// Events
	readonly onDidChangeNotifications: Event<void>;
	readonly onDidChangeStreaming: Event<boolean>;
	readonly onDidChangeConnectionState: Event<void>;
	readonly onDidChangeModels: Event<Array<{ id: string; name: string }>>;
	readonly onDidChangeConfigOptions: Event<SessionConfigOption[]>;
	readonly onDidReceiveControlSignal: Event<ControlSignal>;

	// Actions
	connect(): Promise<void>;
	sendMessage(text: string): void;
	stopStreaming(): void;
	setMode(mode: string): void;
	clearMessages(): void;
	loadSession(sessionId: string): void;
	setSelectedModel(modelId: string): void;
	setConfigOption(configId: string, value: string): Promise<void>;
	respondToPermission(toolCallId: string, approved: boolean): void;
	getSavedSessions(): Array<{ id: string; title: string; date: number }>;
}

// ─── Implementation ────────────────────────────────────────────────────────

class AcpChatServiceImpl implements IAcpChatService {
	declare readonly _serviceBrand: undefined;

	private _store = new AcpStore();
	private _model: string = '';

	private readonly _onDidChangeNotifications = new Emitter<void>();
	readonly onDidChangeNotifications = this._onDidChangeNotifications.event;

	private readonly _onDidChangeStreaming = new Emitter<boolean>();
	readonly onDidChangeStreaming = this._onDidChangeStreaming.event;

	private readonly _onDidChangeConnectionState = new Emitter<void>();
	readonly onDidChangeConnectionState = this._onDidChangeConnectionState.event;

	private readonly _onDidChangeModels = new Emitter<Array<{ id: string; name: string }>>();
	readonly onDidChangeModels = this._onDidChangeModels.event;

	private readonly _onDidChangeConfigOptions = new Emitter<SessionConfigOption[]>();
	readonly onDidChangeConfigOptions = this._onDidChangeConfigOptions.event;

	private readonly _onDidReceiveControlSignal = new Emitter<ControlSignal>();
	readonly onDidReceiveControlSignal = this._onDidReceiveControlSignal.event;

	get connectionState(): ConnectionStatus { return this._store.connectionStatus; }
	get notifications(): readonly AcpNotification[] { return this._store.notifications; }
	get isStreaming(): boolean { return this._store.isStreaming; }
	get configOptions(): SessionConfigOption[] { return this._store.configOptions; }
	get serverModel(): string { return this._model; }

	constructor(
		@IWorkspaceContextService private readonly _workspaceContext: IWorkspaceContextService,
	) {
		// Forward store events
		this._store.onDidChangeNotifications(() => {
			this._onDidChangeNotifications.fire();
		});
		this._store.onDidChangeStreaming(s => {
			this._onDidChangeStreaming.fire(s);
		});
		this._store.onDidChangeConnectionState(() => {
			this._onDidChangeConnectionState.fire();
		});
		this._store.onDidReceiveControlSignal(signal => {
			this._onDidReceiveControlSignal.fire(signal);
		});
		this._store.onDidChangeConfigOptions(options => {
			this._onDidChangeConfigOptions.fire(options);
		});
	}

	async connect(): Promise<void> {
		const workspace = this._workspaceContext.getWorkspace();
		const workspaceRoot = workspace.folders[0]?.uri?.fsPath;
		const cwd = workspaceRoot || '/home';

		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await this._store.start();
				await this._store.spawnAndConnect({
					name: 'crow',
					command: 'crow-cli',
					args: ['acp'],
					env: [],
					cwd,
				});
				// Agent provides models via session/new response — use defaults until we wire that up
				this._model = '';
				this._onDidChangeModels.fire([]);
				return;
			} catch (e) {
				lastError = e;
				if (attempt < 2) {
					console.warn(`[acpChatService] connect attempt ${attempt + 1} failed, retrying in 2s...`);
					await new Promise(r => setTimeout(r, 2000));
				}
			}
		}
		console.error('[acpChatService] connect failed after 3 attempts:', lastError);
	}

	sendMessage(text: string): void {
		this._store.sendMessage(text);
	}

	stopStreaming(): void {
		this._store.stopStreaming();
	}

	setMode(mode: string): void {
		// No-op for now — ACP doesn't have explicit mode control
		// Could set a session config option if the agent supports it
	}

	clearMessages(): void {
		this._store.clearMessages();
	}

	loadSession(_sessionId: string): void {
		// For now: close current and reopen
		// Full session/load will come later
	}

	setSelectedModel(modelId: string): void {
		this._model = modelId;
	}

	async setConfigOption(configId: string, value: string): Promise<void> {
		await this._store.setConfigOption(configId, value);
	}

	respondToPermission(_toolCallId: string, _approved: boolean): void {
		// ACP handles permissions via session/requestPermission
		// For now, auto-approve is done on the backend
	}

	getSavedSessions(): Array<{ id: string; title: string; date: number }> {
		// Sessions are managed by the agent — query async
		return [];
	}
}

registerSingleton(IAcpChatService, AcpChatServiceImpl, InstantiationType.Delayed);
