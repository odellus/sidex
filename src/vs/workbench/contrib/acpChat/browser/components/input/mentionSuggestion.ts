/*---------------------------------------------------------------------------------------------
 *  MentionSuggestion — Vanilla DOM suggestion popup for @-mentions in tiptap.
 *  Uses tippy.js for positioning. Works without React.
 *--------------------------------------------------------------------------------------------*/

import tippy, { type Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { invoke } from '@tauri-apps/api/core';
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';

interface FileItem {
	id: string;
	label: string;
	icon: string;
	category: string;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

async function searchFiles(query: string, workspaceRoot: string): Promise<FileItem[]> {
	const staticItems: FileItem[] = [
		{ id: 'selection', label: 'Selection', icon: '🎯', category: 'Context' },
	];

	if (!workspaceRoot) return staticItems;

	try {
		const matches = await invoke<Array<{ path: string; name: string; score: number }>>('search_files', {
			root: workspaceRoot,
			pattern: query.trim(),
			options: {
				max_results: 30,
				include: [],
				exclude: [
					'**/node_modules/**',
					'**/target/**',
					'**/dist/**',
					'**/build/**',
					'**/.git/**',
					'**/__pycache__/**',
					'**/.next/**',
					'**/vendor/**',
					'**/venv/**',
					'**/.venv/**',
				],
			},
		});

		const fileItems = matches.map(m => {
			const name = m.path.split('/').pop() || m.path;
			const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
			const isImage = IMAGE_EXTS.has(ext);
			const relativePath = m.path.startsWith(workspaceRoot)
				? m.path.slice(workspaceRoot.length + 1)
				: m.path;
			return {
				id: m.path,
				label: relativePath,
				icon: isImage ? '🖼️' : '📄',
				category: isImage ? 'Images' : 'Files',
			};
		});

		return [...staticItems, ...fileItems];
	} catch {
		return staticItems;
	}
}

class SuggestionPopup {
	private _element: HTMLElement;
	private _selectedIndex = 0;
	private _items: FileItem[] = [];
	private _command: ((props: { id: string; label: string }) => void) | null = null;
	private _itemElements: HTMLElement[] = [];

	constructor() {
		this._element = document.createElement('div');
		this._element.className = 'sc-suggestions-popup';
	}

	get element(): HTMLElement { return this._element; }

	update(props: SuggestionProps<FileItem>): void {
		console.log('[MentionSuggestion] update called, items:', props.items.length);
		this._items = props.items;
		this._command = props.command as (p: { id: string; label: string }) => void;
		this._selectedIndex = 0;
		this._render();
	}

	onKeyDown(props: SuggestionKeyDownProps): boolean {
		const { event } = props;
		console.log('[MentionSuggestion] onKeyDown:', event.key, 'items:', this._items.length);
		if (this._items.length === 0) return false;

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			this._selectedIndex = (this._selectedIndex + this._items.length - 1) % this._items.length;
			this._updateSelection();
			console.log('[MentionSuggestion] ArrowUp, selected:', this._selectedIndex);
			return true;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			this._selectedIndex = (this._selectedIndex + 1) % this._items.length;
			this._updateSelection();
			console.log('[MentionSuggestion] ArrowDown, selected:', this._selectedIndex);
			return true;
		}
		if (event.key === 'Enter' || event.key === 'Tab') {
			event.preventDefault();
			console.log('[MentionSuggestion] Enter/Tab, selecting:', this._selectedIndex);
			this._selectItem(this._selectedIndex);
			return true;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			return true;
		}
		return false;
	}

	private _selectItem(index: number): void {
		const item = this._items[index];
		console.log('[MentionSuggestion] _selectItem:', index, 'item:', item, 'command:', this._command);
		if (item && this._command) {
			this._command({ id: item.id, label: item.label });
		}
	}

	private _render(): void {
		if (this._items.length === 0) {
			this._element.innerHTML = '<div class="sc-suggestion-item sc-suggestion-no-results">No results</div>';
			this._itemElements = [];
			return;
		}

		// Group by category
		const grouped: Record<string, FileItem[]> = {};
		for (const item of this._items) {
			const cat = item.category || 'Items';
			if (!grouped[cat]) grouped[cat] = [];
			grouped[cat].push(item);
		}

		// Build DOM
		this._element.innerHTML = '';
		this._itemElements = [];

		for (const [category, items] of Object.entries(grouped)) {
			const categoryEl = document.createElement('div');
			categoryEl.className = 'sc-suggestion-category';
			categoryEl.textContent = category;
			this._element.appendChild(categoryEl);

			for (const item of items) {
				const globalIdx = this._items.indexOf(item);
				const itemEl = document.createElement('div');
				itemEl.className = 'sc-suggestion-item';
				itemEl.dataset.index = String(globalIdx);

				const iconEl = document.createElement('span');
				iconEl.className = 'sc-suggestion-icon';
				iconEl.textContent = item.icon;

				const labelEl = document.createElement('span');
				labelEl.className = 'sc-suggestion-label';
				labelEl.textContent = item.label;

				itemEl.appendChild(iconEl);
				itemEl.appendChild(labelEl);

				// Click handler
				itemEl.addEventListener('click', (e) => {
					e.preventDefault();
					e.stopPropagation();
					this._selectItem(globalIdx);
				});

				// Hover handler
				itemEl.addEventListener('mouseenter', () => {
					this._selectedIndex = globalIdx;
					this._updateSelection();
				});

				this._element.appendChild(itemEl);
				this._itemElements.push(itemEl);
			}
		}

		this._updateSelection();
	}

	private _updateSelection(): void {
		this._itemElements.forEach((el, idx) => {
			if (idx === this._selectedIndex) {
				el.classList.add('is-selected');
				// Scroll into view if needed
				el.scrollIntoView({ block: 'nearest' });
			} else {
				el.classList.remove('is-selected');
			}
		});
	}
}

export function makeSuggestionConfig(workspaceRoot: string) {
	return {
		char: '@',
		items: async ({ query }: { query: string }): Promise<FileItem[]> => {
			return searchFiles(query, workspaceRoot);
		},
		render: () => {
			let popup: SuggestionPopup | null = null;
			let tippyInstance: TippyInstance | null = null;

			return {
				onStart: (props: SuggestionProps<FileItem>) => {
					console.log('[MentionSuggestion] onStart called, items:', props.items.length);
					popup = new SuggestionPopup();
					popup.update(props);

					tippyInstance = tippy('body', {
						getReferenceClientRect: props.clientRect as () => DOMRect,
						appendTo: () => document.body,
						content: popup.element,
						showOnCreate: true,
						interactive: true,
						trigger: 'manual',
						placement: 'top-start',
						theme: 'sidex',
						popperOptions: {
							modifiers: [
								{ name: 'preventOverflow', options: { boundary: document.body } },
							],
						},
					})[0];
					console.log('[MentionSuggestion] tippy instance created');
				},
				onUpdate: (props: SuggestionProps<FileItem>) => {
					console.log('[MentionSuggestion] onUpdate called, items:', props.items.length);
					if (popup) popup.update(props);
					if (tippyInstance) {
						tippyInstance.setProps({
							getReferenceClientRect: props.clientRect as () => DOMRect,
						});
					}
				},
				onKeyDown: (props: SuggestionKeyDownProps): boolean => {
					console.log('[MentionSuggestion] onKeyDown callback, popup:', !!popup);
					if (!popup) return false;
					return popup.onKeyDown(props);
				},
				onExit: () => {
					console.log('[MentionSuggestion] onExit called');
					if (tippyInstance) {
						tippyInstance.destroy();
						tippyInstance = null;
					}
					popup = null;
				},
			};
		},
	};
}
