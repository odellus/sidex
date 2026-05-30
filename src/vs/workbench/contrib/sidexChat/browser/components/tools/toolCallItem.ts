import { Component, DOM, $ } from '../base.js';
import { IToolCallInfo } from '../../sidexChatService.js';
import { InlineDiffView, DiffCallbacks } from '../diff/inlineDiffView.js';
import { DiffHunk } from '../diff/diffAlgorithm.js';

const EDIT_TOOLS = new Set([
	'edit_file', 'write_file', 'multi_edit', 'create_file',
	'str_replace_editor', 'insert_text', 'replace_in_file',
]);

export interface FileEditInfo {
	filePath: string;
	oldContent: string;
	newContent: string;
}

export class ToolCallItem extends Component {
	private _diffView: InlineDiffView | null = null;

	constructor(tc: IToolCallInfo, editInfo?: FileEditInfo) {
		super('div', 'sc-tool-call');

		const nameEl = this.append('span', 'sc-tool-name');
		nameEl.textContent = tc.name;

		const statusEl = this.append('span', 'sc-tool-status');
		if (tc.status === 'running') {
			statusEl.textContent = 'running...';
			statusEl.classList.add('running');
		} else if (tc.status === 'error') {
			statusEl.textContent = 'error';
			statusEl.classList.add('error');
		} else {
			statusEl.textContent = '✓';
			statusEl.classList.add('done');
		}

		if (editInfo && tc.status === 'done' && EDIT_TOOLS.has(tc.name)) {
			this._renderDiff(editInfo);
		}
	}

	private _renderDiff(editInfo: FileEditInfo): void {
		const callbacks: DiffCallbacks = {
			onAccept: (_hunk: DiffHunk) => {
				// Accept is a no-op — the edit is already applied
			},
			onReject: (hunk: DiffHunk) => {
				this._revertHunk(editInfo, hunk);
			},
			onAcceptAll: () => {
				// All accepted — edits already applied, nothing to do
			},
			onRejectAll: () => {
				this._revertFile(editInfo);
			},
		};

		this._diffView = new InlineDiffView(
			editInfo.filePath,
			editInfo.oldContent,
			editInfo.newContent,
			callbacks,
		);
		this._register(this._diffView);
		this._diffView.appendTo(this.element);
	}

	private _revertHunk(editInfo: FileEditInfo, hunk: DiffHunk): void {
		// For per-hunk reject we rewrite the file, replacing the new lines with old lines.
		// This requires reconstructing the file content by applying partial reverts.
		this._invokeRevert(editInfo.filePath, this._buildPartialRevert(editInfo, hunk));
	}

	private _revertFile(editInfo: FileEditInfo): void {
		this._invokeRevert(editInfo.filePath, editInfo.oldContent);
	}

	private _buildPartialRevert(editInfo: FileEditInfo, rejectedHunk: DiffHunk): string {
		// Reconstruct the file: for the rejected hunk, use old lines; for others, keep new lines.
		const newLines = editInfo.newContent.split('\n');
		const oldLines = editInfo.oldContent.split('\n');

		// Collect which new-file line ranges belong to the rejected hunk
		const removedNewLines = new Set<number>();
		const insertions: Map<number, string[]> = new Map();

		for (const line of rejectedHunk.lines) {
			if (line.type === 'added' && line.newLineNo != null) {
				removedNewLines.add(line.newLineNo);
			}
		}

		// Find where to insert old lines (at the position of first change in the hunk)
		let insertAt: number | null = null;
		const oldLinesToInsert: string[] = [];
		for (const line of rejectedHunk.lines) {
			if (line.type === 'removed' && line.oldLineNo != null) {
				oldLinesToInsert.push(line.content);
				if (insertAt === null) {
					// Insert before the first added line, or at first change position
					for (const l of rejectedHunk.lines) {
						if (l.type === 'added' && l.newLineNo != null) {
							insertAt = l.newLineNo;
							break;
						}
					}
					if (insertAt === null) {
						// Pure deletion — find the context line just before
						const lastCtx = rejectedHunk.lines.filter(l => l.type === 'context' && l.newLineNo != null);
						insertAt = lastCtx.length > 0 ? (lastCtx[lastCtx.length - 1].newLineNo! + 1) : 1;
					}
				}
			}
		}

		if (insertAt !== null && oldLinesToInsert.length > 0) {
			insertions.set(insertAt, oldLinesToInsert);
		}

		const result: string[] = [];
		for (let i = 0; i < newLines.length; i++) {
			const lineNo = i + 1;
			const inserts = insertions.get(lineNo);
			if (inserts) {
				result.push(...inserts);
			}
			if (!removedNewLines.has(lineNo)) {
				result.push(newLines[i]);
			}
		}

		return result.join('\n');
	}

	private _invokeRevert(filePath: string, content: string): void {
		// Write the reverted content back via Tauri IPC
		const g = globalThis as unknown as {
			__TAURI_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			__TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
		};
		const invoke = g.__TAURI_INVOKE__ ?? g.__TAURI_INTERNALS__?.invoke;
		if (invoke) {
			invoke('agent_execute_tool', {
				request: {
					tool_call_id: `revert-${Date.now()}`,
					name: 'write_file',
					arguments: JSON.stringify({ path: filePath, content }),
					cwd: '.',
				},
			}).catch(() => { /* revert failed silently */ });
		}
	}
}
