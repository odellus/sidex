/*---------------------------------------------------------------------------------------------
 *  AcpChatSessionManager — Global singleton that manages AcpStore instances
 *  across editor tab switches. Each session ID maps to a persistent store
 *  that survives EditorPane lifecycle events (setInput/clearInput).
 *
 *  Architecture: EditorPane = View (rendering), AcpStore = Model (session state).
 *  The SessionManager owns the model; the EditorPane borrows it.
 *--------------------------------------------------------------------------------------------*/

import { AcpStore } from './acpStore.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

interface ManagedSession {
	store: AcpStore;
	lastAccessed: number;
}

export class AcpChatSessionManager implements IDisposable {
	private static _instance: AcpChatSessionManager;
	private _sessions = new Map<string, ManagedSession>();
	private _cleanupInterval: ReturnType<typeof setInterval>;

	static getInstance(): AcpChatSessionManager {
		if (!this._instance) {
			this._instance = new AcpChatSessionManager();
		}
		return this._instance;
	}

	private constructor() {
		// Clean up stale sessions every 5 minutes
		this._cleanupInterval = setInterval(() => this._cleanup(), 300000);
	}

	/** Get existing session or create a new one. */
	getOrCreateSession(sessionId: string): AcpStore {
		let managed = this._sessions.get(sessionId);
		if (!managed) {
			const store = new AcpStore();
			managed = {
				store,
				lastAccessed: Date.now(),
			};
			this._sessions.set(sessionId, managed);
		}
		managed.lastAccessed = Date.now();
		return managed.store;
	}

	/** Check if a session exists. */
	hasSession(sessionId: string): boolean {
		return this._sessions.has(sessionId);
	}

	/** Get an existing session without creating. */
	getSession(sessionId: string): AcpStore | undefined {
		return this._sessions.get(sessionId)?.store;
	}

	/** Remove and dispose a session (e.g. when user explicitly closes). */
	removeSession(sessionId: string): void {
		const managed = this._sessions.get(sessionId);
		if (managed) {
			managed.store.dispose();
			this._sessions.delete(sessionId);
		}
	}

	private _cleanup(): void {
		// Sessions persist indefinitely until explicitly closed by the user.
		// No automatic garbage collection - users may want to keep sessions for days.
	}

	dispose(): void {
		clearInterval(this._cleanupInterval);
		for (const session of this._sessions.values()) {
			session.store.dispose();
		}
		this._sessions.clear();
		AcpChatSessionManager._instance = undefined as any;
	}
}
