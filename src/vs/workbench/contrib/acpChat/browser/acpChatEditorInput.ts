/*---------------------------------------------------------------------------------------------
 *  AcpChatEditorInput — represents a single chat session as an editor tab.
 *  Each input holds a URI encoding the session ID and delegates rendering
 *  to AcpChatEditor (the EditorPane).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput, IEditorCloseHandler } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities, IEditorIdentifier, IUntypedEditorInput } from '../../../common/editor.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ConfirmResult } from '../../../../platform/dialogs/common/dialogs.js';
import { AcpChatUri } from './acpChatUri.js';

export const acpChatEditorId = 'workbench.editor.acpChat';

export class AcpChatEditorInput extends EditorInput implements IEditorCloseHandler {

	static readonly ID = 'workbench.editors.acpChat';

	override readonly closeHandler = this;

	constructor(
		public readonly resource: URI,
	) {
		super();
	}

	override get typeId(): string {
		return AcpChatEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return acpChatEditorId;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.ForceReveal;
	}

	/** Session ID parsed from the resource URI. */
	get sessionId(): string | undefined {
		return AcpChatUri.parseSessionId(this.resource);
	}

	override getName(): string {
		const id = this.sessionId;
		if (id) {
			// Use the random suffix (after the timestamp) for a short, unique name
			const suffix = id.split('-').pop();
			return `ACP Chat — #${suffix}`;
		}
		return 'ACP Chat';
	}

	override getDescription(): string | undefined {
		return undefined;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (otherInput instanceof AcpChatEditorInput) {
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
				override: acpChatEditorId,
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
