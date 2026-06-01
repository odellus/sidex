/*---------------------------------------------------------------------------------------------
 *  Sidex Chat URI helpers — generate and parse sidex-chat:// URIs.
 *  Each editor tab gets a unique URI encoding its session ID.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';

export namespace SidexChatUri {

	const scheme = Schemas.sidexChat;

	/** Create a new URI for a fresh chat editor tab. */
	export function getNewEditorUri(): URI {
		const sessionId = `session-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		return URI.from({ scheme, path: `/${sessionId}` });
	}

	/** Create a URI for a specific session ID (used when restoring from serializer). */
	export function getEditorUri(sessionId: string): URI {
		return URI.from({ scheme, path: `/${sessionId}` });
	}

	/** Extract the session ID from a sidex-chat URI, or undefined if not one. */
	export function parseSessionId(resource: URI): string | undefined {
		if (resource.scheme !== scheme) {
			return undefined;
		}
		const parts = resource.path.split('/').filter(Boolean);
		return parts[0];
	}
}
