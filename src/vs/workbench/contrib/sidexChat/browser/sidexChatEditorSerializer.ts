/*---------------------------------------------------------------------------------------------
 *  SidexChatEditorInputSerializer — persists chat editor tabs across reloads.
 *  Serializes the resource URI so sessions can be restored on window reload.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { SidexChatEditorInput } from './sidexChatEditorInput.js';

interface ISerializedSidexChatEditorInput {
	readonly resource: string;
}

export class SidexChatEditorInputSerializer implements IEditorSerializer {

	canSerialize(input: EditorInput): input is SidexChatEditorInput {
		return input instanceof SidexChatEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		if (!this.canSerialize(input)) {
			return undefined;
		}
		const obj: ISerializedSidexChatEditorInput = {
			resource: input.resource.toString(),
		};
		return JSON.stringify(obj);
	}

	deserialize(
		_instantiationService: unknown,
		serializedEditorInput: string,
	): EditorInput | undefined {
		try {
			const obj: ISerializedSidexChatEditorInput = JSON.parse(serializedEditorInput);
			const resource = URI.parse(obj.resource);
			return new SidexChatEditorInput(resource);
		} catch {
			return undefined;
		}
	}
}
