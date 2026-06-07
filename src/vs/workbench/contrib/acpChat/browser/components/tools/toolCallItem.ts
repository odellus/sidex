import { Component } from '../base.js';
import { InlineTerminal } from './inlineTerminal.js';
import { FileReadView, FileWriteView, FileEditView } from './fileViews.js';
import type { ToolCallInfo } from './toolCallGroup.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { URI } from '../../../../../../base/common/uri.js';

/**
 * ToolCallItem renders a single tool call in the chat, dispatching to specialized
 * views based on the tool kind (terminal, file read, file write, file edit).
 */
export class ToolCallItem extends Component {
	readonly toolName: string;
	private _headerEl: HTMLElement;
	private _contentEl: HTMLElement;
	private _statusEl: HTMLElement;
	private _statusIconEl: HTMLElement;
	private _open = true;
	private _inlineTerminal: InlineTerminal | null = null;
	private _tool: ToolCallInfo & {
		kind?: string;
		content?: Array<Record<string, unknown>>;
		rawInput?: Record<string, unknown>;
		rawOutput?: Record<string, unknown> | string;
	};
	private readonly _instantiationService: IInstantiationService;
	private readonly _cwd: string;

	constructor(tc: ToolCallInfo, instantiationService: IInstantiationService, cwd: string = '') {
		super('div', 'sc-tool-call');
		this._instantiationService = instantiationService;
		this._cwd = cwd;
		this._tool = tc as ToolCallInfo & {
			kind?: string;
			content?: Array<Record<string, unknown>>;
			rawInput?: Record<string, unknown>;
			rawOutput?: Record<string, unknown> | string;
		};
		this.toolName = tc.name;

		if (typeof this._tool.rawInput === 'string') {
			try {
				this._tool.rawInput = JSON.parse(this._tool.rawInput);
			} catch {
				// Keep as string
			}
		}

		// Header (clickable to toggle)
		this._headerEl = this.append('div', 'sc-tool-call-header');
		this._headerEl.onclick = () => this._toggle();

		const nameEl = this._headerEl.appendChild(document.createElement('code'));
		nameEl.className = 'sc-tool-call-name';
		nameEl.textContent = this._getDisplayName();

		// For file tools, add clickable file path in header
		const filePath = this._getHeaderFilePath();
		if (filePath) {
			const linkEl = this._headerEl.appendChild(document.createElement('a'));
			linkEl.className = 'sc-file-path';
			linkEl.textContent = filePath;
			linkEl.href = '#';
			linkEl.title = `Open ${filePath}`;
			linkEl.onclick = (e) => {
				e.preventDefault();
				e.stopPropagation();
				const editorService = this._instantiationService.invokeFunction(a => a.get(IEditorService));
				editorService.openEditor({ resource: URI.file(filePath) });
			};
		}

		// For terminal tools, nothing in the header (copy button is inside the terminal)

		this._statusEl = this._headerEl.appendChild(document.createElement('span'));
		this._statusEl.className = 'sc-tool-call-status';
		this._updateStatusElement(tc.status);

		// Status icon (codicon) - positioned after status text, before chevron
		this._statusIconEl = this._headerEl.appendChild(document.createElement('span'));
		this._statusIconEl.className = 'sc-tool-call-status-icon codicon';
		this._updateStatusIcon(tc.status);

		const chevronEl = this._headerEl.appendChild(document.createElement('span'));
		chevronEl.className = 'sc-tool-call-chevron';
		chevronEl.textContent = '▾';

		// Content area
		this._contentEl = this.append('div', 'sc-tool-call-content');

		// Render initial content (file views, etc.)
		this._renderContent();
	}

	private _getDisplayName(): string {
		const kind = this._tool.kind || '';
		const title = this._tool.name || kind || 'Tool call';

		// For terminal/execute tools, show the cwd
		if (kind === 'execute' || this._isTerminal()) {
			return this._cwd || 'terminal';
		}

		// For file tools, strip the path from the title since we show it as a link
		const titleLower = title.toLowerCase();
		if (titleLower.startsWith('read:') || titleLower.startsWith('write:') || titleLower.startsWith('edit:')) {
			return title.split(':')[0];
		}

		return title;
	}

	private _isTerminal(): boolean {
		const content = this._tool.content || [];
		return content.some((c: Record<string, unknown>) => c.type === 'terminal');
	}

	private _isReadTool(): boolean {
		const kind = this._tool.kind || '';
		const titleLower = (this._tool.name || '').toLowerCase();
		return kind === 'read' ||
			titleLower === 'read' ||
			titleLower.startsWith('read:') ||
			titleLower.startsWith('read ') ||
			titleLower.startsWith('read/');
	}

	updateStatus(status: string): void {
		this._updateStatusElement(status);
		this._updateStatusIcon(status);
	}

	private _updateStatusIcon(status: string): void {
		this._statusIconEl.className = 'sc-tool-call-status-icon codicon';
		if (status === 'running' || status === 'in_progress' || status === 'pending') {
			this._statusIconEl.classList.add('codicon-loading', 'codicon-modifier-spin');
		} else if (status === 'error' || status === 'failed') {
			this._statusIconEl.classList.add('codicon-error');
		} else if (status === 'completed') {
			this._statusIconEl.classList.add('codicon-check');
		}
	}

	/**
	 * Append a content block from a tool_call_update notification.
	 * For terminal blocks, creates an InlineTerminal connected to the backend PTY.
	 * For text blocks, appends raw text output.
	 */
	appendContentBlock(block: Record<string, unknown>): void {
		const blockType = block.type as string;
		console.log(`[ToolCallItem] appendContentBlock: toolCallId="${this._tool.id}" type="${blockType}" block=`, JSON.stringify(block));

		// Terminal content block — agent sent { type: "terminal", terminalId: "term_77" }
		if (blockType === 'terminal' && !this._inlineTerminal) {
			const terminalId = block.terminalId as string;
			console.log(`[ToolCallItem] terminal block: terminalId="${terminalId}" for tool="${this._tool.name}"`);
			if (terminalId) {
				this._inlineTerminal = new InlineTerminal({
					terminalId,
					commandLabel: this._tool.name || 'command',
					cwd: (this._tool.rawInput as Record<string, unknown>)?.cwd as string | undefined,
				});
				this._inlineTerminal.appendTo(this._contentEl);
				this._register(this._inlineTerminal);
				console.log(`[ToolCallItem] InlineTerminal created and appended for "${terminalId}"`);
			} else {
				console.error(`[ToolCallItem] ERROR: terminal block missing terminalId!`, block);
			}
		} else if (blockType === 'terminal' && this._inlineTerminal) {
			console.warn(`[ToolCallItem] DUPLICATE terminal block for toolCallId="${this._tool.id}" — already have terminal, ignoring`);
		}

		if (blockType === 'text' && !this._inlineTerminal) {
			const text = block.text as string || block.content as string || '';
			if (text) {
				// For read tools, render a proper FileReadView with clickable header
				if (this._isReadTool() && !this._contentEl.querySelector('.sc-file-read-view')) {
					const rawInput = (this._tool.rawInput as Record<string, unknown>) || {};
					const filePath = this._getFilePath(rawInput);

					// Clear any raw pre that might have been added
					this._contentEl.querySelectorAll('.sc-tool-raw').forEach(el => el.remove());

					const view = new FileReadView({ content: text, path: filePath, instantiationService: this._instantiationService });
					view.appendTo(this._contentEl);
					this._register(view);
				} else {
					const pre = this._contentEl.appendChild(document.createElement('pre'));
					pre.className = 'sc-tool-raw';
					pre.textContent = text;
				}
			}
		}

		// Diff content block — renders Monaco diff view for write/edit tools
		if (blockType === 'diff') {
			// Skip if a file view is already rendered (write tools render at construction time)
			if (this._contentEl.querySelector('.sc-file-write-view, .sc-file-edit-view, .sc-file-read-view')) {
				// Still track the block but don't re-render
			} else {
				const path = block.path as string || '';
				const newText = (block.newText ?? block.new_text) as string || '';
				const oldText = (block.oldText ?? block.old_text) as string | undefined;
				const filePath = this._getFilePath((this._tool.rawInput as Record<string, unknown>) || {}, path);

				// Clear any fallback raw JSON
				this._contentEl.querySelectorAll('.sc-tool-raw').forEach(el => el.remove());

			if (oldText) {
				// Edit tool: show Monaco diff
				const view = new FileEditView({
						beforeContent: oldText,
						afterContent: newText,
						path: filePath,
						instantiationService: this._instantiationService,
					});
					view.appendTo(this._contentEl);
					this._register(view);
			} else {
				// Write tool: show green new-file view
				const view = new FileWriteView({ content: newText, path: filePath, instantiationService: this._instantiationService });
					view.appendTo(this._contentEl);
					this._register(view);
				}
			}
		}

		// Track the block
		if (!this._tool.content) this._tool.content = [];
		this._tool.content.push(block);
	}

	private _getFilePath(rawInput: Record<string, unknown>, diffPath?: string): string {
		return (diffPath ||
			rawInput.path as string ||
			rawInput.file_path as string ||
			rawInput.filePath as string ||
			rawInput.file as string ||
			this._tool.name) as string;
	}

	private _getHeaderFilePath(): string | null {
		const kind = this._tool.kind || '';
		const titleLower = (this._tool.name || '').toLowerCase();

		// Only show file path in header for file operations
		const isFileTool = kind === 'read' || kind === 'write' || kind === 'edit' ||
			titleLower === 'read' || titleLower.startsWith('read:') || titleLower.startsWith('read ') ||
			titleLower === 'write' || titleLower.startsWith('write:') ||
			titleLower === 'edit' || titleLower.startsWith('edit:');

		if (!isFileTool) return null;

		const rawInput = (this._tool.rawInput as Record<string, unknown>) || {};
		return (rawInput.path as string ||
			rawInput.file_path as string ||
			rawInput.filePath as string ||
			rawInput.file as string) || null;
	}

	private _updateStatusElement(status: string): void {
		this._statusEl.className = 'sc-tool-call-status';
		if (status === 'running' || status === 'in_progress') {
			this._statusEl.textContent = 'running...';
			this._statusEl.classList.add('running');
		} else if (status === 'error' || status === 'failed') {
			this._statusEl.textContent = 'error';
			this._statusEl.classList.add('error');
		} else if (status === 'pending') {
			this._statusEl.textContent = 'pending';
			this._statusEl.classList.add('running');
		} else {
			this._statusEl.textContent = '';
			this._statusEl.classList.add('done');
		}
	}

	private _toggle(): void {
		this._open = !this._open;
		this._contentEl.style.display = this._open ? 'block' : 'none';
		const chevron = this._headerEl.querySelector('.sc-tool-call-chevron');
		if (chevron) {
			chevron.textContent = this._open ? '▾' : '▸';
		}
	}

	private _renderContent(): void {
		const kind = this._tool.kind || '';
		const content = this._tool.content || [];
		const rawInput = (this._tool.rawInput as Record<string, unknown>) || {};

		// Determine the effective kind from title patterns
		const titleLower = (this._tool.name || '').toLowerCase();
		const inferredKind = kind ||
			(titleLower === 'read' || titleLower.startsWith('read:') || titleLower.startsWith('read ') ? 'read' :
			(titleLower === 'write' || titleLower === 'create' || titleLower.startsWith('write:') || titleLower.startsWith('create:') ? 'write' :
			(titleLower === 'edit' || titleLower.startsWith('edit:') || titleLower.startsWith('edit ') ? 'edit' :
			(titleLower.startsWith('run:') || titleLower.startsWith('exec:') ||
			 titleLower.startsWith('terminal:') || titleLower.startsWith('command:') ? 'execute' : ''))));

		// For execute/terminal tools, the InlineTerminal is created in appendContentBlock
		// when the terminal content block arrives. Don't render anything here.
		if (inferredKind === 'execute' || kind === 'execute') {
			return;
		}

		// File operations — look for diff content blocks
		const diffContent = content.find((c: Record<string, unknown>) => c.type === 'diff');
		const oldText = (diffContent?.oldText ?? diffContent?.old_text) as string | undefined;
		const newText = (diffContent?.newText ?? diffContent?.new_text) as string | undefined;
		const diffPath = diffContent?.path as string | undefined;

		// Read tool
		if (inferredKind === 'read') {
			let fileContent: string | undefined;
			const filePath = this._getFilePath(rawInput, diffPath);

			const textBlock = content.find((c: Record<string, unknown>) => c.type === 'text');
			if (textBlock) {
				fileContent = (textBlock.text as string) || (textBlock.content as string);
			}

			if (fileContent) {
				const view = new FileReadView({ content: fileContent, path: filePath, instantiationService: this._instantiationService });
				view.appendTo(this._contentEl);
				this._register(view);
			}
			return;
		}

		// Write tool (new file)
		if (inferredKind === 'write' || inferredKind === 'create') {
			const filePath = this._getFilePath(rawInput, diffPath);
			const fileContent = newText || rawInput.content as string || '';

			if (fileContent) {
				if (oldText && oldText !== fileContent) {
					const view = new FileEditView({
						beforeContent: oldText,
						afterContent: fileContent,
						path: filePath,
						instantiationService: this._instantiationService,
					});
					view.appendTo(this._contentEl);
					this._register(view);
				} else {
					const view = new FileWriteView({ content: fileContent, path: filePath, instantiationService: this._instantiationService });
					view.appendTo(this._contentEl);
					this._register(view);
				}
			}
			return;
		}

		// Edit tool (diff)
		if (inferredKind === 'edit') {
			const filePath = this._getFilePath(rawInput, diffPath);

			if (newText && oldText) {
				const view = new FileEditView({
					beforeContent: oldText,
					afterContent: newText,
					path: filePath,
					instantiationService: this._instantiationService,
				});
				view.appendTo(this._contentEl);
				this._register(view);
			}
			// Don't fall through to raw JSON fallback for edit tools —
			// diff content arrives in tool_call_update and is handled by appendContentBlock
			return;
		}

		// Fallback: show raw input/output
		const rawOutput = this._tool.rawOutput;
		if (rawInput && Object.keys(rawInput).length > 0) {
			const pre = this._contentEl.appendChild(document.createElement('pre'));
			pre.className = 'sc-tool-raw';
			pre.textContent = JSON.stringify(rawInput, null, 2);
		}
		if (rawOutput) {
			const pre = this._contentEl.appendChild(document.createElement('pre'));
			pre.className = 'sc-tool-raw';
			pre.textContent = typeof rawOutput === 'string'
				? rawOutput
				: JSON.stringify(rawOutput, null, 2);
		}
	}
}
