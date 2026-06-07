/*---------------------------------------------------------------------------------------------
 *  Markdown Preview URI helpers — encode/decode source file URIs in preview tabs.
 *  Scheme: sidex-markdown-preview
 *  Format: sidex-markdown-preview://preview/<encoded-source-uri>
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

export const MARKDOWN_PREVIEW_SCHEME = 'sidex-markdown-preview';

/** Create a preview URI that encodes the source document URI. */
export function createPreviewUri(sourceUri: URI): URI {
	return URI.from({
		scheme: MARKDOWN_PREVIEW_SCHEME,
		authority: 'preview',
		path: '/' + encodeURIComponent(sourceUri.toString()),
	});
}

/** Extract the source document URI from a preview URI. */
export function parseSourceUri(previewUri: URI): URI | undefined {
	if (previewUri.scheme !== MARKDOWN_PREVIEW_SCHEME) {
		return undefined;
	}
	try {
		const encoded = previewUri.path.replace(/^\//, '');
		return URI.parse(decodeURIComponent(encoded));
	} catch {
		return undefined;
	}
}
