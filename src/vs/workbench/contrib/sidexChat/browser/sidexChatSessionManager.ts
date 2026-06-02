/*---------------------------------------------------------------------------------------------
 *  SidexChatSessionManager — Global singleton that manages AcpStore instances
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

export class SidexChatSessionManager implements IDisposable {
	private static _instance: SidexChatSessionManager;
	private _sessions = new Map<string, ManagedSession>();
	private _cleanupInterval: ReturnType<typeof setInterval>;

	static getInstance(): SidexChatSessionManager {
		if (!this._instance) {
			this._instance = new SidexChatSessionManager();
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
		const now = Date.now();
		for (const [id, session] of this._sessions) {
			// Remove sessions not accessed in 30 minutes
			if (now - session.lastAccessed > 1800000) {
				session.store.dispose();
				this._sessions.delete(id);
			}
		}
	}

	dispose(): void {
		clearInterval(this._cleanupInterval);
		for (const session of this._sessions.values()) {
			session.store.dispose();
		}
		this._sessions.clear();
		SidexChatSessionManager._instance = undefined as any;
	}
}
