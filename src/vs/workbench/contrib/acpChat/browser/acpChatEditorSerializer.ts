/*---------------------------------------------------------------------------------------------
 *  AcpChatEditorInputSerializer — persists chat editor tabs across reloads.
 *  Serializes the resource URI so sessions can be restored on window reload.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { AcpChatEditorInput } from './acpChatEditorInput.js';

interface ISerializedAcpChatEditorInput {
	readonly resource: string;
}

export class AcpChatEditorInputSerializer implements IEditorSerializer {

	canSerialize(input: EditorInput): input is AcpChatEditorInput {
		return input instanceof AcpChatEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		if (!this.canSerialize(input)) {
			return undefined;
		}
		const obj: ISerializedAcpChatEditorInput = {
			resource: input.resource.toString(),
		};
		return JSON.stringify(obj);
	}

	deserialize(
		_instantiationService: unknown,
		serializedEditorInput: string,
	): EditorInput | undefined {
		try {
			const obj: ISerializedAcpChatEditorInput = JSON.parse(serializedEditorInput);
			const resource = URI.parse(obj.resource);
			return new AcpChatEditorInput(resource);
		} catch {
			return undefined;
		}
	}
}
