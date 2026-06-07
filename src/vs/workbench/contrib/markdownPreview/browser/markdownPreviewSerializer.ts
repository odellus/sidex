/*---------------------------------------------------------------------------------------------
 *  MarkdownPreviewSerializer — persists preview tabs across window reloads.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { MarkdownPreviewEditorInput } from './markdownPreviewEditorInput.js';

interface ISerializedMarkdownPreviewEditorInput {
	readonly resource: string;
}

export class MarkdownPreviewSerializer implements IEditorSerializer {

	canSerialize(input: EditorInput): input is MarkdownPreviewEditorInput {
		return input instanceof MarkdownPreviewEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		if (!this.canSerialize(input)) {
			return undefined;
		}
		const obj: ISerializedMarkdownPreviewEditorInput = {
			resource: input.resource.toString(),
		};
		return JSON.stringify(obj);
	}

	deserialize(
		_instantiationService: unknown,
		serializedEditorInput: string,
	): EditorInput | undefined {
		try {
			const obj: ISerializedMarkdownPreviewEditorInput = JSON.parse(serializedEditorInput);
			const resource = URI.parse(obj.resource);
			return new MarkdownPreviewEditorInput(resource);
		} catch {
			return undefined;
		}
	}
}
