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
import { invoke } from '../../../../sidex-bridge.js';
import type { ContentBlock } from '@agentclientprotocol/sdk';

interface AgentConfig {
	name: string;
	command: string;
	args: string[];
	env: string[];
}

// ─── Service interface ─────────────────────────────────────────────────────

export const IAcpChatService = createDecorator<IAcpChatService>('acpChatService');

export interface IAcpChatService {
	readonly _serviceBrand: undefined;

	// Workspace root
	readonly cwd: string;

	// Session ID
	readonly sessionId: string;

	// Connection state
	readonly connectionState: ConnectionStatus;

	// Notifications
	readonly notifications: readonly AcpNotification[];
	readonly isStreaming: boolean;

	// Config options
	readonly configOptions: SessionConfigOption[];

	// Model info
	readonly serverModel: string;

	// Agent management
	readonly availableAgents: AgentConfig[];
	readonly currentAgent: AgentConfig | null;

	// Events
	readonly onDidChangeNotifications: Event<void>;
	readonly onDidChangeStreaming: Event<boolean>;
	readonly onDidChangeConnectionState: Event<void>;
	readonly onDidChangeModels: Event<Array<{ id: string; name: string }>>;
	readonly onDidChangeConfigOptions: Event<SessionConfigOption[]>;
	readonly onDidReceiveControlSignal: Event<ControlSignal>;
	readonly onDidChangeAgents: Event<void>;

	// Actions
	connect(): Promise<void>;
	sendMessage(text: string, blocks?: ContentBlock[]): void;
	stopStreaming(): void;
	setMode(mode: string): void;
	switchAgent(agentName: string): Promise<void>;
	clearMessages(): void;
	loadSession(sessionId: string): Promise<void>;
	setSelectedModel(modelId: string): void;
	setConfigOption(configId: string, value: string): Promise<void>;
	respondToPermission(toolCallId: string, approved: boolean): void;
	getSavedSessions(): Promise<Array<{ id: string; displayId: string; title?: string; date: number }>>;
}

// ─── Implementation ────────────────────────────────────────────────────────

class AcpChatServiceImpl implements IAcpChatService {
	declare readonly _serviceBrand: undefined;

	private _store = new AcpStore();
	private _model: string = '';
	private _cwd: string = '';
	private _agents: AgentConfig[] = [];
	private _currentAgent: AgentConfig | null = null;

	get cwd(): string { return this._cwd; }
	get sessionId(): string { return this._store.sessionId; }
	get availableAgents(): AgentConfig[] { return this._agents; }
	get currentAgent(): AgentConfig | null { return this._currentAgent; }

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

	private readonly _onDidChangeAgents = new Emitter<void>();
	readonly onDidChangeAgents = this._onDidChangeAgents.event;

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

		// Initialize cwd from workspace
		const workspace = this._workspaceContext.getWorkspace();
		this._cwd = workspace.folders[0]?.uri?.fsPath || '';
	}

	async connect(): Promise<void> {
		const workspace = this._workspaceContext.getWorkspace();
		const workspaceRoot = workspace.folders[0]?.uri?.fsPath;
		const cwd = workspaceRoot || '/home';

		// Read agent config from settings (defaults are in builtin_defaults())
		let defaultAgentName = 'crow';
		let agents: AgentConfig[] = [];
		try {
			const nameResult = await invoke<string | null>('settings_get', { section: 'acp.defaultAgent' });
			if (nameResult) { defaultAgentName = nameResult; }
			const agentsResult = await invoke<AgentConfig[] | null>('settings_get', { section: 'acp.agents' });
			if (agentsResult) { agents = agentsResult; }
		} catch (e) {
			console.warn('[acpChatService] Failed to read settings, using defaults:', e);
		}
		const agent = agents.find(a => a.name === defaultAgentName) || agents[0];
		if (!agent) {
			throw new Error('No ACP agents configured in settings (acp.agents)');
		}

		// Store agent list and current agent for UI
		this._agents = agents;
		this._currentAgent = agent;
		this._onDidChangeAgents.fire();

		return this._spawnAgent(agent, cwd);
	}

	private async _spawnAgent(agent: AgentConfig, cwd: string): Promise<void> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await this._store.start();
				await this._store.spawnAndConnect({
					name: agent.name,
					command: agent.command,
					args: agent.args,
					env: agent.env,
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

	sendMessage(text: string, blocks?: ContentBlock[]): void {
		this._store.sendMessage(text, blocks);
	}

	stopStreaming(): void {
		this._store.stopStreaming();
	}

	setMode(mode: string): void {
		// No-op for now — ACP doesn't have explicit mode control
		// Could set a session config option if the agent supports it
	}

	async switchAgent(agentName: string): Promise<void> {
		const agent = this._agents.find(a => a.name === agentName);
		if (!agent) {
			console.warn(`[acpChatService] Agent "${agentName}" not found`);
			return;
		}
		if (agent.name === this._currentAgent?.name) { return; }

		// Close the current session before spawning a new agent
		try {
			await this._store.closeSession();
		} catch (e) {
			console.warn('[acpChatService] closeSession failed during switch:', e);
		}

		// Clear messages
		this.clearMessages();

		// Update current agent
		this._currentAgent = agent;
		this._onDidChangeAgents.fire();

		// Spawn new agent
		const workspace = this._workspaceContext.getWorkspace();
		const cwd = workspace.folders[0]?.uri?.fsPath || '/home';
		await this._spawnAgent(agent, cwd);
	}

	clearMessages(): void {
		this._store.clearMessages();
	}

	async loadSession(sessionId: string): Promise<void> {
		await this._store.loadSession(sessionId);
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

	async getSavedSessions(): Promise<Array<{ id: string; displayId: string; title?: string; date: number }>> {
		const workspace = this._workspaceContext.getWorkspace();
		const cwd = workspace.folders[0]?.uri?.fsPath || '/home';
		return this._store.listSessions(cwd);
	}
}

registerSingleton(IAcpChatService, AcpChatServiceImpl, InstantiationType.Delayed);
