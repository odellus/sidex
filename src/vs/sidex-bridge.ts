/*---------------------------------------------------------------------------------------------
 *  SideX — Low-level Tauri IPC bridge.
 *  Wraps `window.__TAURI__` with a graceful fallback when running outside
 *  the Tauri webview (e.g. in a plain browser during development).
 *--------------------------------------------------------------------------------------------*/

declare global {
	interface Window {
		__TAURI__?: {
			core: {
				invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			};
		};
		__TAURI_INTERNALS__?: {
			invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
		};
	}
}

function getInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
	if (window.__TAURI__?.core?.invoke) {
		return window.__TAURI__.core.invoke;
	}
	if (window.__TAURI_INTERNALS__?.invoke) {
		return window.__TAURI_INTERNALS__.invoke;
	}
	return null;
}

export async function invoke<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
	// Retry on transient proxy disconnections (common after page reload)
	for (let attempt = 0; attempt < 30; attempt++) {
		const fn = getInvoke();
		if (!fn) {
			await new Promise(r => setTimeout(r, 500));
			continue;
		}
		try {
			return await fn(cmd, args) as Promise<T>;
		} catch (e: any) {
			const msg = e?.message || String(e);
			if (msg.includes('proxy disconnected') && attempt < 29) {
				await new Promise(r => setTimeout(r, 1000));
				continue;
			}
			throw e;
		}
	}
	console.warn(`[SideX] invoke(${cmd}) — Tauri not available`);
	return null as unknown as T;
}

export function isTauri(): boolean {
	return !!getInvoke();
}
