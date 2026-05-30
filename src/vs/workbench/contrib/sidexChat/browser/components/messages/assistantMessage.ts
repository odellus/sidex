import { Component, DOM, $, formatDuration } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IChatMessage, IToolCallInfo } from '../../sidexChatService.js';
import { renderMarkdown } from '../markdownRenderer.js';
import { Collapsible } from '../collapsible/collapsible.js';
import { FilesExplored } from '../tools/filesExplored.js';
import { StepsPlanned } from '../tools/stepsPlanned.js';
import { ToolCallItem, FileEditInfo } from '../tools/toolCallItem.js';
import { ThinkingBlock } from './thinkingBlock.js';

const EDIT_TOOL_NAMES = new Set([
	'edit_file', 'write_file', 'multi_edit', 'create_file',
	'str_replace_editor', 'insert_text', 'replace_in_file',
]);

export class AssistantMessage extends Component {
	private readonly _onCopy = this._register(new Emitter<string>());
	readonly onCopy: Event<string> = this._onCopy.event;
	private _thinkingBlock: ThinkingBlock | null = null;

	get thinkingBlock(): ThinkingBlock | null { return this._thinkingBlock; }

	constructor(msg: IChatMessage, turnDurationMs?: number, onFileClick?: (path: string) => void, isThinking?: boolean) {
		super('div', 'sc-assistant-msg');

		// Thinking block — rendered above everything else
		if (msg.thinkingContent || isThinking) {
			this._thinkingBlock = new ThinkingBlock();
			this._thinkingBlock.appendTo(this.element);
			this._register(this._thinkingBlock);
			if (msg.thinkingContent) {
				this._thinkingBlock.setFullContent(msg.thinkingContent);
			}
			if (isThinking) {
				this._thinkingBlock.startStreaming();
			}
		}

		const hasTools = msg.toolCalls && msg.toolCalls.length > 0;
		const editInfoMap = hasTools ? buildEditInfoMap(msg.toolCalls!) : new Map<string, FileEditInfo>();

		// Only show "Worked for Xs" collapsible when there are actual tool calls
		if (hasTools && turnDurationMs && turnDurationMs > 500) {
			// Partition tool calls: edits shown outside the collapsible, rest inside
			const nonEditCalls = msg.toolCalls!.filter(tc => !EDIT_TOOL_NAMES.has(tc.name));
			const editCalls = msg.toolCalls!.filter(tc => EDIT_TOOL_NAMES.has(tc.name));

			if (nonEditCalls.length > 0) {
				const activitySection = new Collapsible(
					`Worked for ${formatDuration(turnDurationMs)}`,
				);
				activitySection.appendTo(this.element);
				this._register(activitySection);

				for (const tc of nonEditCalls) {
					const item = new ToolCallItem(tc);
					item.appendTo(activitySection.body);
					this._register(item);
				}
			}

			// Render edit tool calls with inline diffs directly in the message
			for (const tc of editCalls) {
				const editInfo = editInfoMap.get(tc.id);
				const item = new ToolCallItem(tc, editInfo);
				item.appendTo(this.element);
				this._register(item);
			}
		}

		// Markdown body
		if (msg.content) {
			const bodyEl = this.append('div', 'sc-assistant-body');
			bodyEl.innerHTML = renderMarkdown(msg.content);
		}

		// Files explored (only if files were actually read)
		const exploredFiles = extractExploredFiles(msg.toolCalls || []);
		if (exploredFiles.length > 0) {
			const filesComp = new FilesExplored(exploredFiles, onFileClick);
			filesComp.appendTo(this.element);
			this._register(filesComp);
		}

		// Steps planned (only if tasks were created)
		const steps = extractSteps(msg.toolCalls || []);
		if (steps.length > 0) {
			const stepsComp = new StepsPlanned(steps);
			stepsComp.appendTo(this.element);
			this._register(stepsComp);
		}

		// Three-dot menu (right side, hover) — uses ellipsis codicon
		const menuBtn = this.append('div', 'sc-msg-menu');
		const dots = DOM.append(menuBtn, $('button.sc-msg-menu-btn'));
		dots.title = 'Copy';
		const dotsIcon = document.createElement('span');
		dotsIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.ellipsis));
		dots.appendChild(dotsIcon);
		this.on(dots, 'click', () => {
			if (msg.content) {
				navigator.clipboard.writeText(msg.content).catch(() => { /* */ });
				dots.textContent = '✓';
				setTimeout(() => {
					dots.textContent = '';
					dots.appendChild(dotsIcon);
				}, 1200);
			}
		});
	}
}

const READ_TOOLS = new Set([
	'read_file', 'grep', 'glob', 'search_files',
	'batch_read', 'lsp_hover', 'lsp_definition', 'lsp_references',
]);

function extractExploredFiles(toolCalls: IToolCallInfo[]): string[] {
	const files: string[] = [];
	for (const tc of toolCalls) {
		if (READ_TOOLS.has(tc.name) && tc.input) {
			try {
				const args = JSON.parse(tc.input);
				if (args.path) { files.push(args.path); }
				if (args.paths) { files.push(...args.paths); }
			} catch { /* ignore */ }
		}
	}
	return [...new Set(files)];
}

function extractSteps(toolCalls: IToolCallInfo[]): string[] {
	const steps: string[] = [];
	for (const tc of toolCalls) {
		if ((tc.name === 'todo_write' || tc.name === 'task_create') && tc.output) {
			const lines = tc.output.split('\n').filter(l => l.trim());
			steps.push(...lines);
		}
	}
	return steps;
}

/**
 * Build a map of tool_call_id -> FileEditInfo by pairing read_file results
 * (old content) with subsequent edit tool calls (new content from output).
 *
 * Strategy:
 * 1. Track the last-read content per file path from read_file calls.
 * 2. For edit tools, parse the file path from the input args.
 * 3. The old content comes from a prior read_file, or defaults to empty.
 * 4. The new content comes from the tool output (the server often echoes the result),
 *    or can be reconstructed from input args for write_file/create_file.
 */
function buildEditInfoMap(toolCalls: IToolCallInfo[]): Map<string, FileEditInfo> {
	const result = new Map<string, FileEditInfo>();
	const fileContents = new Map<string, string>();

	for (const tc of toolCalls) {
		// Track file reads to capture "before" content
		if (READ_TOOLS.has(tc.name) && tc.input && tc.output) {
			try {
				const args = JSON.parse(tc.input);
				if (args.path && typeof tc.output === 'string') {
					fileContents.set(args.path, tc.output);
				}
			} catch { /* ignore */ }
		}

		// Process edit tools
		if (EDIT_TOOL_NAMES.has(tc.name) && tc.input && tc.status === 'done') {
			try {
				const args = JSON.parse(tc.input);
				const filePath = args.path || args.file_path || args.file || '';
				if (!filePath) { continue; }

				const oldContent = fileContents.get(filePath) || '';
				let newContent = '';

				if (tc.name === 'write_file' || tc.name === 'create_file') {
					newContent = args.content || args.text || '';
				} else if (tc.name === 'str_replace_editor' || tc.name === 'edit_file') {
					// For str_replace style edits, apply the replacement to old content
					if (args.old_str != null && args.new_str != null && oldContent) {
						newContent = oldContent.replace(args.old_str, args.new_str);
					} else if (args.content) {
						newContent = args.content;
					} else if (tc.output) {
						newContent = tc.output;
					}
				} else if (tc.name === 'multi_edit') {
					// Multi-edit: apply sequence of replacements
					let content = oldContent;
					const edits = args.edits || [];
					for (const edit of edits) {
						if (edit.old_text != null && edit.new_text != null) {
							content = content.replace(edit.old_text, edit.new_text);
						}
					}
					newContent = content;
				} else {
					newContent = tc.output || '';
				}

				if (newContent && newContent !== oldContent) {
					result.set(tc.id, { filePath, oldContent, newContent });
					// Update tracked content so subsequent edits to the same file see the latest
					fileContents.set(filePath, newContent);
				}
			} catch { /* ignore parse errors */ }
		}
	}

	return result;
}
