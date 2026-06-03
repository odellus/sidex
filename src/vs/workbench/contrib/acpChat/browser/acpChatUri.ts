/*---------------------------------------------------------------------------------------------
 *  ACP Chat URI helpers — generate and parse acp-chat:// URIs.
 *  Each editor tab gets a unique URI encoding its session ID.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';

export namespace AcpChatUri {

	const scheme = Schemas.acpChat;

	/** Create a new URI for a fresh chat editor tab. */
	export function getNewEditorUri(): URI {
		const sessionId = `session-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		return URI.from({ scheme, path: `/${sessionId}` });
	}

	/** Create a URI for a specific session ID (used when restoring from serializer). */
	export function getEditorUri(sessionId: string): URI {
		return URI.from({ scheme, path: `/${sessionId}` });
	}

	/** Extract the session ID from an ACP Chat URI, or undefined if not one. */
	export function parseSessionId(resource: URI): string | undefined {
		if (resource.scheme !== scheme) {
			return undefined;
		}
		const parts = resource.path.split('/').filter(Boolean);
		return parts[0];
	}
}
