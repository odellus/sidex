/*---------------------------------------------------------------------------------------------
 *  SidexChatEditorInput — represents a single chat session as an editor tab.
 *  Each input holds a URI encoding the session ID and delegates rendering
 *  to SidexChatEditor (the EditorPane).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput, IEditorCloseHandler } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities, IEditorIdentifier, IUntypedEditorInput } from '../../../common/editor.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ConfirmResult } from '../../../../platform/dialogs/common/dialogs.js';
import { SidexChatUri } from './sidexChatUri.js';

export const sidexChatEditorId = 'workbench.editor.sidexChat';

export class SidexChatEditorInput extends EditorInput implements IEditorCloseHandler {

	static readonly ID = 'workbench.editors.sidexChat';

	override readonly closeHandler = this;

	constructor(
		public readonly resource: URI,
	) {
		super();
	}

	override get typeId(): string {
		return SidexChatEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return sidexChatEditorId;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.ForceReveal;
	}

	/** Session ID parsed from the resource URI. */
	get sessionId(): string | undefined {
		return SidexChatUri.parseSessionId(this.resource);
	}

	override getName(): string {
		const id = this.sessionId;
		if (id) {
			// Use the random suffix (after the timestamp) for a short, unique name
			const suffix = id.split('-').pop();
			return `Sidex Chat — #${suffix}`;
		}
		return 'Sidex Chat';
	}

	override getDescription(): string | undefined {
		return undefined;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (otherInput instanceof SidexChatEditorInput) {
			return isEqual(this.resource, otherInput.resource);
		}
		return super.matches(otherInput);
	}

	override canReopen(): boolean {
		return false;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: {
				override: sidexChatEditorId,
				pinned: true,
			},
		};
	}

	// ── IEditorCloseHandler ──

	showConfirm(): boolean {
		// Could check if agent is streaming, but for now always allow close
		return false;
	}

	async confirm(_editors: ReadonlyArray<IEditorIdentifier>): Promise<ConfirmResult> {
		return ConfirmResult.DONT_SAVE;
	}
}
