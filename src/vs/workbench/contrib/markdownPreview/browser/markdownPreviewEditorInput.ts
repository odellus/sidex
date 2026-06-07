/*---------------------------------------------------------------------------------------------
 *  MarkdownPreviewEditorInput — represents a markdown preview tab.
 *  Holds the source document URI and delegates rendering to MarkdownPreviewEditor.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { isEqual } from '../../../../base/common/resources.js';
import { basename } from '../../../../base/common/path.js';
import { parseSourceUri } from './markdownPreviewUri.js';

export const markdownPreviewEditorId = 'workbench.editor.markdownPreview';

export class MarkdownPreviewEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.markdownPreview';

	/** The source .md document URI this preview renders. */
	readonly sourceUri: URI;

	constructor(
		public readonly resource: URI,
	) {
		super();
		this.sourceUri = parseSourceUri(resource) ?? resource;
	}

	override get typeId(): string {
		return MarkdownPreviewEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return markdownPreviewEditorId;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		const file = basename(this.sourceUri.path);
		return `Preview: ${file}`;
	}

	override getDescription(): string | undefined {
		return this.sourceUri.path;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (otherInput instanceof MarkdownPreviewEditorInput) {
			return isEqual(this.sourceUri, otherInput.sourceUri);
		}
		return super.matches(otherInput);
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: {
				override: markdownPreviewEditorId,
			},
		};
	}
}
