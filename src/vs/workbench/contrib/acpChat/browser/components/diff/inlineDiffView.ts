/*---------------------------------------------------------------------------------------------
 *  InlineDiffView — Renders a unified diff inline in the chat panel with
 *  per-hunk Accept/Reject controls and bulk Accept All / Reject All.
 *--------------------------------------------------------------------------------------------*/

import { Component, DOM, $, escapeHtml } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { computeDiff, groupIntoHunks, DiffHunk, DiffLine } from './diffAlgorithm.js';

export interface DiffCallbacks {
	onAccept: (hunk: DiffHunk) => void;
	onReject: (hunk: DiffHunk) => void;
	onAcceptAll: () => void;
	onRejectAll: () => void;
}

export class InlineDiffView extends Component {
	private readonly _hunks: DiffHunk[];
	private readonly _callbacks: DiffCallbacks;
	private readonly _filePath: string;
	private readonly _hunkElements = new Map<number, HTMLElement>();
	private _headerStatusEl!: HTMLElement;

	private readonly _onDidAcceptHunk = this._register(new Emitter<DiffHunk>());
	readonly onDidAcceptHunk: Event<DiffHunk> = this._onDidAcceptHunk.event;
	private readonly _onDidRejectHunk = this._register(new Emitter<DiffHunk>());
	readonly onDidRejectHunk: Event<DiffHunk> = this._onDidRejectHunk.event;

	constructor(
		filePath: string,
		oldContent: string,
		newContent: string,
		callbacks: DiffCallbacks,
	) {
		super('div', 'sc-diff-view');
		this._filePath = filePath;
		this._callbacks = callbacks;

		const diffLines = computeDiff(oldContent, newContent);
		this._hunks = groupIntoHunks(diffLines, 3);

		this._render();
	}

	get hunks(): readonly DiffHunk[] { return this._hunks; }

	private _render(): void {
		this._renderHeader();
		for (const hunk of this._hunks) {
			this._renderHunk(hunk);
		}
	}

	private _renderHeader(): void {
		const header = this.append('div', 'sc-diff-header');

		// File icon + path
		const fileInfo = DOM.append(header, $('div.sc-diff-file-info'));
		const icon = document.createElement('span');
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));
		icon.classList.add('sc-diff-file-icon');
		fileInfo.appendChild(icon);

		const pathEl = DOM.append(fileInfo, $('span.sc-diff-file-path'));
		const segments = this._filePath.split('/');
		const fileName = segments.pop() || this._filePath;
		const dirPath = segments.length > 0 ? segments.slice(-2).join('/') + '/' : '';
		pathEl.innerHTML = `<span class="sc-diff-file-dir">${escapeHtml(dirPath)}</span>${escapeHtml(fileName)}`;

		this._headerStatusEl = DOM.append(header, $('span.sc-diff-header-status'));

		// Bulk actions
		const actions = DOM.append(header, $('div.sc-diff-header-actions'));

		const acceptAllBtn = DOM.append(actions, $('button.sc-diff-btn.sc-diff-btn-accept-all'));
		const acceptIcon = document.createElement('span');
		acceptIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.checkAll));
		acceptAllBtn.appendChild(acceptIcon);
		acceptAllBtn.title = 'Accept All';
		this.on(acceptAllBtn, 'click', () => this._acceptAll());

		const rejectAllBtn = DOM.append(actions, $('button.sc-diff-btn.sc-diff-btn-reject-all'));
		const rejectIcon = document.createElement('span');
		rejectIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.closeAll));
		rejectAllBtn.appendChild(rejectIcon);
		rejectAllBtn.title = 'Reject All';
		this.on(rejectAllBtn, 'click', () => this._rejectAll());

		this._updateHeaderStatus();
	}

	private _renderHunk(hunk: DiffHunk): void {
		const hunkEl = this.append('div', 'sc-diff-hunk');
		hunkEl.dataset.hunkId = String(hunk.id);
		this._hunkElements.set(hunk.id, hunkEl);

		// Hunk header with line range info and actions
		const hunkHeader = DOM.append(hunkEl, $('div.sc-diff-hunk-header'));

		const rangeLabel = DOM.append(hunkHeader, $('span.sc-diff-hunk-range'));
		rangeLabel.textContent = `@@ -${hunk.startLineOld},${hunk.oldLines.length} +${hunk.startLineNew},${hunk.newLines.length} @@`;

		const hunkActions = DOM.append(hunkHeader, $('div.sc-diff-actions'));

		const acceptBtn = DOM.append(hunkActions, $('button.sc-diff-btn.sc-diff-btn-accept'));
		const aIcon = document.createElement('span');
		aIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
		acceptBtn.appendChild(aIcon);
		acceptBtn.title = 'Accept';
		this.on(acceptBtn, 'click', () => this._acceptHunk(hunk));

		const rejectBtn = DOM.append(hunkActions, $('button.sc-diff-btn.sc-diff-btn-reject'));
		const rIcon = document.createElement('span');
		rIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		rejectBtn.appendChild(rIcon);
		rejectBtn.title = 'Reject';
		this.on(rejectBtn, 'click', () => this._rejectHunk(hunk));

		// Diff lines
		const linesContainer = DOM.append(hunkEl, $('div.sc-diff-lines'));
		for (const line of hunk.lines) {
			this._renderLine(linesContainer, line);
		}
	}

	private _renderLine(container: HTMLElement, line: DiffLine): void {
		const lineEl = DOM.append(container, $('div.sc-diff-line'));
		lineEl.classList.add(line.type);

		const oldNoEl = DOM.append(lineEl, $('span.sc-diff-line-number'));
		oldNoEl.textContent = line.oldLineNo != null ? String(line.oldLineNo) : '';

		const newNoEl = DOM.append(lineEl, $('span.sc-diff-line-number'));
		newNoEl.textContent = line.newLineNo != null ? String(line.newLineNo) : '';

		const markerEl = DOM.append(lineEl, $('span.sc-diff-line-marker'));
		if (line.type === 'added') { markerEl.textContent = '+'; }
		else if (line.type === 'removed') { markerEl.textContent = '-'; }
		else { markerEl.textContent = ' '; }

		const contentEl = DOM.append(lineEl, $('span.sc-diff-line-content'));
		contentEl.textContent = line.content;
	}

	private _acceptHunk(hunk: DiffHunk): void {
		if (hunk.status !== 'pending') { return; }
		hunk.status = 'accepted';
		this._updateHunkVisual(hunk);
		this._updateHeaderStatus();
		this._callbacks.onAccept(hunk);
		this._onDidAcceptHunk.fire(hunk);
	}

	private _rejectHunk(hunk: DiffHunk): void {
		if (hunk.status !== 'pending') { return; }
		hunk.status = 'rejected';
		this._updateHunkVisual(hunk);
		this._updateHeaderStatus();
		this._callbacks.onReject(hunk);
		this._onDidRejectHunk.fire(hunk);
	}

	private _acceptAll(): void {
		for (const hunk of this._hunks) {
			if (hunk.status === 'pending') {
				hunk.status = 'accepted';
				this._updateHunkVisual(hunk);
			}
		}
		this._updateHeaderStatus();
		this._callbacks.onAcceptAll();
	}

	private _rejectAll(): void {
		for (const hunk of this._hunks) {
			if (hunk.status === 'pending') {
				hunk.status = 'rejected';
				this._updateHunkVisual(hunk);
			}
		}
		this._updateHeaderStatus();
		this._callbacks.onRejectAll();
	}

	private _updateHunkVisual(hunk: DiffHunk): void {
		const el = this._hunkElements.get(hunk.id);
		if (!el) { return; }

		el.classList.remove('pending', 'accepted', 'rejected');
		el.classList.add(hunk.status);

		// Disable action buttons once resolved
		const btns = el.querySelectorAll<HTMLButtonElement>('.sc-diff-actions button');
		for (const btn of btns) {
			btn.disabled = true;
		}
	}

	private _updateHeaderStatus(): void {
		const total = this._hunks.length;
		const accepted = this._hunks.filter(h => h.status === 'accepted').length;
		const rejected = this._hunks.filter(h => h.status === 'rejected').length;
		const pending = total - accepted - rejected;

		if (pending === 0) {
			this._headerStatusEl.textContent = `${accepted} accepted, ${rejected} rejected`;
			this._headerStatusEl.classList.add('resolved');
		} else {
			this._headerStatusEl.textContent = `${pending} pending`;
			this._headerStatusEl.classList.remove('resolved');
		}
	}
}
