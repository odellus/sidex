/*---------------------------------------------------------------------------------------------
 *  ACP Chat — The built-in AI panel for Sidex IDE.
 *  Registered in the AuxiliaryBar with its own status bar toggle.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import {
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
} from '../../../common/views.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { AcpChatViewPane } from './acpChatView.js';
import { AcpChatEditor } from './acpChatEditor.js';
import { AcpChatEditorInput, acpChatEditorId } from './acpChatEditorInput.js';
import { AcpChatEditorInputSerializer } from './acpChatEditorSerializer.js';
import { AcpChatUri } from './acpChatUri.js';
import './acpChatService.js';

export const ACP_CHAT_CONTAINER_ID = 'workbench.view.acpChat';
export const ACP_CHAT_VIEW_ID = 'workbench.view.acpChat.main';

const acpChatIcon = registerIcon('acp-chat-icon', Codicon.commentDiscussion, nls.localize('acpChatIcon', 'ACP Chat icon'));

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer(
	{
		id: ACP_CHAT_CONTAINER_ID,
		title: nls.localize2('acpChat', 'ACP Chat'),
		icon: acpChatIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ACP_CHAT_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		order: -100,
	},
	ViewContainerLocation.AuxiliaryBar,
	{ isDefault: true, doNotRegisterOpenCommand: true }
);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[
		{
			id: ACP_CHAT_VIEW_ID,
			name: nls.localize2('acpChat', 'ACP Chat'),
			containerIcon: acpChatIcon,
			ctorDescriptor: new SyncDescriptor(AcpChatViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			hideByDefault: false,
		},
	],
	viewContainer
);

// ── Editor registration (chat as a tab in the editor area) ──

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	AcpChatEditorInput.ID,
	AcpChatEditorInputSerializer,
);
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AcpChatEditor, acpChatEditorId, nls.localize('acpChat', 'ACP Chat')),
	[new SyncDescriptor(AcpChatEditorInput)],
);

// Command: open a NEW chat in editor area (always creates a fresh session)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openAcpChatEditor',
			title: nls.localize2('openAcpChatEditor', 'Open ACP Chat in Editor'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const uri = AcpChatUri.getNewEditorUri();
		const input = new AcpChatEditorInput(uri);
		await editorService.openEditor(input, { pinned: true });
	}
});

// Cmd+Shift+I toggles the Sidex panel
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.toggleAcpChat',
			title: nls.localize2('toggleAcpChat', 'Toggle ACP Chat'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
				weight: KeybindingWeight.WorkbenchContrib,
			},
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		layoutService.setPartHidden(layoutService.isVisible(Parts.AUXILIARYBAR_PART), Parts.AUXILIARYBAR_PART);
	}
});

// Status bar toggle icon (layout-sidebar-right)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.acpChatStatusBarToggle',
			title: nls.localize2('acpChatStatusBarToggle', 'Toggle ACP Chat'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const isVisible = layoutService.isVisible(Parts.AUXILIARYBAR_PART);
		layoutService.setPartHidden(isVisible, Parts.AUXILIARYBAR_PART);
	}
});

// Register the status bar entries on startup
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { AcpCompletionProvider } from './autocomplete/acpCompletionProvider.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { InlineEditController } from './inline/inlineEditController.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';

class AcpChatStatusBarContribution implements IWorkbenchContribution {
	static readonly ID = 'acpChat.statusbar';

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		// ACP Chat panel toggle (far right)
		const acpChatEntry = statusbarService.addEntry(
			{
				name: nls.localize('acpChatToggle', 'ACP Chat'),
				text: this._acpChatIcon(),
				ariaLabel: nls.localize('toggleAcpChat', 'Toggle ACP Chat'),
				command: 'workbench.action.acpChatStatusBarToggle',
				tooltip: this._acpChatTooltip(),
			},
			'acpChat.toggle',
			StatusbarAlignment.RIGHT,
			-1000
		);

		// Secondary sidebar toggle (next to ACP Chat, for Claude Code etc.)
		const auxEntry = statusbarService.addEntry(
			{
				name: nls.localize('auxToggle', 'Secondary Sidebar'),
				text: this._auxIcon(),
				ariaLabel: nls.localize('toggleAux', 'Toggle Secondary Sidebar'),
				command: 'workbench.action.toggleAuxiliaryBar',
				tooltip: this._auxTooltip(),
			},
			'acpChat.aux.toggle',
			StatusbarAlignment.RIGHT,
			-999
		);

		// Update icons when visibility changes
		const update = () => {
			acpChatEntry.update({
				name: nls.localize('acpChatToggle', 'ACP Chat'),
				text: this._acpChatIcon(),
				ariaLabel: nls.localize('toggleAcpChat', 'Toggle ACP Chat'),
				command: 'workbench.action.acpChatStatusBarToggle',
				tooltip: this._acpChatTooltip(),
			});
			auxEntry.update({
				name: nls.localize('auxToggle', 'Secondary Sidebar'),
				text: this._auxIcon(),
				ariaLabel: nls.localize('toggleAux', 'Toggle Secondary Sidebar'),
				command: 'workbench.action.toggleAuxiliaryBar',
				tooltip: this._auxTooltip(),
			});
		};

		// Listen for layout changes
		(layoutService as any).onDidChangePartVisibility?.(() => update());
		// Fallback: poll every 500ms (some layout changes don't fire events)
		const interval = setInterval(update, 500);
		(this as unknown as { dispose?: IDisposable }).dispose = { dispose: () => clearInterval(interval) } as IDisposable;
	}

	private _acpChatIcon(): string {
		return this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)
			? '$(acp-panel-open)'
			: '$(acp-panel-closed)';
	}

	private _acpChatTooltip(): string {
		return this.layoutService.isVisible(Parts.AUXILIARYBAR_PART) ? 'Hide ACP Chat' : 'Show ACP Chat';
	}

	private _auxIcon(): string {
		return this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)
			? '$(layout-sidebar-right)'
			: '$(layout-sidebar-right-off)';
	}

	private _auxTooltip(): string {
		return this.layoutService.isVisible(Parts.AUXILIARYBAR_PART) ? 'Hide Secondary Sidebar' : 'Show Secondary Sidebar';
	}
}

registerWorkbenchContribution2(AcpChatStatusBarContribution.ID, AcpChatStatusBarContribution, WorkbenchPhase.AfterRestored);

class AcpChatInlineCompletionContribution implements IWorkbenchContribution {
	static readonly ID = 'acpChat.inlineCompletion';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		const provider = new AcpCompletionProvider(configurationService);
		languageFeaturesService.inlineCompletionsProvider.register('*', provider);
	}
}

registerWorkbenchContribution2(AcpChatInlineCompletionContribution.ID, AcpChatInlineCompletionContribution, WorkbenchPhase.AfterRestored);

// --- CMD+K Inline Edit ---

// One InlineEditController per editor, lazily created
const controllerMap = new WeakMap<object, InlineEditController>();

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'acpChat.inlineEdit.activate',
			title: nls.localize2('acpChatInlineEdit', 'ACP Chat: Inline Edit'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
				weight: KeybindingWeight.EditorContrib + 100,
				when: EditorContextKeys.editorTextFocus,
			},
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const codeEditorService = accessor.get(ICodeEditorService);
		const configService = accessor.get(IConfigurationService);
		const editor = codeEditorService.getFocusedCodeEditor();
		if (!editor || !isCodeEditor(editor)) {
			return;
		}

		let controller = controllerMap.get(editor);
		if (!controller) {
			controller = new InlineEditController(editor, configService);
			controllerMap.set(editor, controller);
			// Clean up when editor is disposed
			editor.onDidDispose(() => {
				controller?.dispose();
				controllerMap.delete(editor);
			});
		}

		controller.activate();
	}
});
