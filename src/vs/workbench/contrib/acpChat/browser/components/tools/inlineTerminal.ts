/*---------------------------------------------------------------------------------------------
 *  InlineTerminal — xterm.js terminal embedded in ACP chat messages.
 *  Connects to an existing backend PTY (created by agent via terminal/create)
 *  and streams output via Tauri push events only (no polling).
 *
 *  Data flow:
 *    1. One-time invoke('acp_terminal_output') fetches any output that arrived
 *       before the listener was registered.
 *    2. listen('acp-terminal-data') receives push events from the backend
 *       drain loop for all subsequent output.
 *    3. listen('acp-terminal-exit') receives the exit notification.
 *--------------------------------------------------------------------------------------------*/

import { Component } from '../base.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const LOG = '[InlineTerminal]';

interface InlineTerminalOptions {
	terminalId: string;
	commandLabel: string;
	cwd?: string;
	exited?: boolean;
	exitCode?: number;
}

export class InlineTerminal extends Component {
	private _terminal: Terminal | null = null;
	private _fitAddon: FitAddon | null = null;
	private _headerEl: HTMLElement;
	private _statusEl: HTMLElement;
	private _containerEl: HTMLElement;
	private _terminalId: string;
	private _exited = false;
	private _exitCode: number | null = null;
	private _observer: ResizeObserver | null = null;
	private _dataListener: (() => void) | null = null;
	private _exitListener: (() => void) | null = null;
	private _initPromise: Promise<void>;

	constructor(options: InlineTerminalOptions) {
		super('div', 'sc-inline-terminal');
		this._terminalId = options.terminalId;
		this._exited = options.exited ?? false;
		this._exitCode = options.exitCode ?? null;

		console.log(`${LOG} CREATED terminalId="${this._terminalId}" command="${options.commandLabel}"`);

		// Header
		this._headerEl = this.append('div', 'sc-inline-terminal-header');
		const titleEl = this._headerEl.appendChild(document.createElement('span'));
		titleEl.className = 'sc-inline-terminal-title';
		titleEl.textContent = `$ ${options.commandLabel}`;

		// Copy command button
		const copyBtn = this._headerEl.appendChild(document.createElement('button'));
		copyBtn.className = 'sc-tool-copy-btn';
		copyBtn.title = 'Copy command';
		const copyIcon = copyBtn.appendChild(document.createElement('span'));
		copyIcon.className = 'codicon codicon-copy';
		copyBtn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			navigator.clipboard.writeText(options.commandLabel).then(() => {
				copyIcon.className = 'codicon codicon-check';
				setTimeout(() => {
					copyIcon.className = 'codicon codicon-copy';
				}, 1500);
			}).catch(() => {
				copyIcon.className = 'codicon codicon-error';
				setTimeout(() => {
					copyIcon.className = 'codicon codicon-copy';
				}, 1500);
			});
		};

		if (options.cwd) {
			const cwdEl = this._headerEl.appendChild(document.createElement('span'));
			cwdEl.className = 'sc-inline-terminal-cwd';
			cwdEl.textContent = options.cwd;
		}

		this._statusEl = this._headerEl.appendChild(document.createElement('span'));
		this._statusEl.className = 'sc-inline-terminal-status';
		this._updateStatus();

		// Container for xterm
		this._containerEl = this.append('div', 'sc-inline-terminal-container');

		// Track init so dispose can await it if needed
		this._initPromise = this._initTerminal();
	}

	private async _initTerminal(): Promise<void> {
		const tid = this._terminalId;

		// 1. Create xterm instance
		const terminal = new Terminal({
			cursorBlink: false,
			fontSize: 12,
			fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
			theme: {
				background: 'var(--vscode-terminal-background, var(--vscode-editor-background))',
				foreground: 'var(--vscode-terminal-foreground, var(--vscode-editor-foreground))',
				cursor: 'var(--vscode-terminal-foreground)',
				selectionBackground: 'var(--vscode-editor-selectionBackground)',
			},
			scrollback: 5000,
			convertEol: true,
			rows: 12,
			cols: 80,
			disableStdin: true,
			wordSeparator: ' \t\r\n"\'`(){}[]<>|&;',
		});

		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);

		// 2. Open xterm in DOM
		terminal.open(this._containerEl);
		setTimeout(() => fitAddon.fit(), 50);

		this._terminal = terminal;
		this._fitAddon = fitAddon;

		console.log(`${LOG} [${tid}] xterm opened in DOM`);

		// 3. Register push listeners BEFORE fetching snapshot.
		//    This way we don't miss any events that arrive between snapshot and listener.
		//    Duplicate data from the snapshot overlap is harmless — xterm just overwrites.

		try {
			this._dataListener = await listen<{ terminalId: string; data: string }>(
				'acp-terminal-data',
				(event) => {
					if (event.payload.terminalId === tid) {
						terminal.write(event.payload.data);
					}
				}
			);
			console.log(`${LOG} [${tid}] acp-terminal-data listener registered`);
		} catch (e) {
			console.error(`${LOG} [${tid}] FAILED to register acp-terminal-data listener:`, e);
			this._showError(`Failed to register data listener: ${e}`);
			return;
		}

		try {
			this._exitListener = await listen<{ terminalId: string; exitCode: number | null }>(
				'acp-terminal-exit',
				(event) => {
					if (event.payload.terminalId === tid) {
						console.log(`${LOG} [${tid}] received exit event, code=${event.payload.exitCode}`);
						this._exited = true;
						this._exitCode = event.payload.exitCode ?? null;
						this._updateStatus();
					}
				}
			);
			console.log(`${LOG} [${tid}] acp-terminal-exit listener registered`);
		} catch (e) {
			console.error(`${LOG} [${tid}] FAILED to register acp-terminal-exit listener:`, e);
			this._showError(`Failed to register exit listener: ${e}`);
			return;
		}

		// 4. Fetch initial output snapshot from backend (catches anything that
		//    arrived before our listener was registered).
		try {
			const result = await invoke<any>('acp_terminal_output', {
				request: { terminal_id: tid },
			});
			console.log(`${LOG} [${tid}] snapshot: output_len=${result?.output?.length ?? 0} exit_code=${result?.exit_code ?? 'null'} is_alive=${result?.is_alive ?? 'unknown'}`);

			if (result?.output) {
				terminal.write(result.output);
			}
			if (result?.cwd) {
				const cwdEl = this._headerEl.querySelector('.sc-inline-terminal-cwd');
				if (cwdEl && !cwdEl.textContent) {
					cwdEl.textContent = result.cwd;
				}
			}
			if (result?.exit_code !== undefined && result?.exit_code !== null) {
				this._exitCode = result.exit_code;
				this._exited = true;
				this._updateStatus();
			}
		} catch (e) {
			console.error(`${LOG} [${tid}] FAILED to fetch initial snapshot:`, e);
			this._showError(`Terminal not found in backend: ${e}`);
			return;
		}

		// 5. Handle resize
		this._observer = new ResizeObserver(() => {
			this._fitAddon?.fit();
		});
		this._observer.observe(this._containerEl);

		// 6. Register disposal
		this._register({
			dispose: () => {
				console.log(`${LOG} [${tid}] disposing`);
				this._observer?.disconnect();
				this._dataListener?.();
				this._exitListener?.();
				terminal.dispose();
			}
		});

		console.log(`${LOG} [${tid}] init complete`);
	}

	private _showError(message: string): void {
		console.error(`${LOG} [${this._terminalId}] ERROR: ${message}`);
		const errorEl = this._containerEl.appendChild(document.createElement('div'));
		errorEl.className = 'sc-inline-terminal-error';
		errorEl.textContent = `⚠ ${message}`;
		errorEl.style.color = 'var(--vscode-errorForeground, #f44)';
		errorEl.style.padding = '8px';
		errorEl.style.fontSize = '12px';
	}

	private _updateStatus(): void {
		this._statusEl.textContent = '';
		this._statusEl.className = 'sc-inline-terminal-status';

		if (this._exited) {
			if (this._exitCode === 0) {
				this._statusEl.textContent = '✓ exited 0';
				this._statusEl.classList.add('success');
			} else {
				this._statusEl.textContent = `✗ exited ${this._exitCode ?? '?'}`;
				this._statusEl.classList.add('error');
			}
		} else {
			this._statusEl.textContent = '⏳ running';
			this._statusEl.classList.add('running');
		}
	}
}
