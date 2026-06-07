/*---------------------------------------------------------------------------------------------
 *  RichTextEditor — Tiptap-based rich text editor for ACP chat input.
 *  Provides rich text editing, @-mentions, image support, and more.
 *--------------------------------------------------------------------------------------------*/

import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import type { ContentBlock } from '@agentclientprotocol/sdk';

export interface ResolvedMention {
	uri: string;
	label: string;
	content: string;
}

interface JSONNode {
	type?: string;
	attrs?: Record<string, unknown>;
	text?: string;
	content?: JSONNode[];
	marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

/** Convert inline marks to markdown syntax */
function applyMarks(text: string, marks?: JSONNode["marks"]): string {
	if (!marks || marks.length === 0) return text;
	for (const mark of [...marks].reverse()) {
		switch (mark.type) {
			case "bold":
				text = `**${text}**`;
				break;
			case "italic":
				text = `*${text}*`;
				break;
			case "code":
				text = `\`${text}\``;
				break;
			case "link": {
				const href = String(mark.attrs?.href ?? "");
				text = `[${text}](${href})`;
				break;
			}
			case "strike":
				text = `~~${text}~~`;
				break;
		}
	}
	return text;
}

/** Walk a Tiptap JSON doc and produce ACP ContentBlocks. */
function extractContentBlocks(doc: unknown): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	let currentText = "";

	const flushText = () => {
		if (currentText) {
			const trimmed = currentText.trimEnd();
			if (trimmed) {
				blocks.push({ type: "text", text: trimmed });
			}
			currentText = "";
		}
	};

	const appendText = (s: string) => {
		currentText += s;
	};

	const processInline = (nodes: JSONNode[] | undefined) => {
		for (const node of nodes ?? []) {
			switch (node.type) {
				case "text": {
					const text = applyMarks(node.text ?? "", node.marks);
					appendText(text);
					break;
				}
				case "hardBreak":
					appendText("\n");
					break;
				case "mention": {
					flushText();
					const id = String(node.attrs?.id ?? "");
					const label = String(node.attrs?.label ?? id);
					blocks.push({
						type: "resource_link",
						uri: `file://${id}`,
						name: label,
					});
					break;
				}
				case "image": {
					flushText();
					const src = String(node.attrs?.src ?? "");
					if (src.startsWith("data:")) {
						const match = src.match(/^data:([^;]+);base64,(.+)$/);
						if (match) {
							blocks.push({
								type: "image",
								mimeType: match[1],
								data: match[2],
							});
						}
					} else {
						blocks.push({ type: "resource_link", uri: src, name: "Image" });
					}
					break;
				}
			}
		}
	};

	const processBlock = (node: JSONNode) => {
		switch (node.type) {
			case "paragraph": {
				processInline(node.content);
				appendText("\n\n");
				break;
			}
			case "heading": {
				const level = Math.min(Math.max((node.attrs?.level as number) ?? 1, 1), 6);
				appendText("#".repeat(level) + " ");
				processInline(node.content);
				appendText("\n\n");
				break;
			}
			case "bulletList": {
				for (const item of node.content ?? []) {
					if (item.type === "listItem") {
						appendText("- ");
						for (const child of item.content ?? []) {
							processBlock(child);
						}
						currentText = currentText.trimEnd() + "\n";
					}
				}
				appendText("\n");
				break;
			}
			case "orderedList": {
				let num = (node.attrs?.start as number) ?? 1;
				for (const item of node.content ?? []) {
					if (item.type === "listItem") {
						appendText(`${num}. `);
						for (const child of item.content ?? []) {
							processBlock(child);
						}
						currentText = currentText.trimEnd() + "\n";
						num++;
					}
				}
				appendText("\n");
				break;
			}
			case "blockquote": {
				for (const child of node.content ?? []) {
					const saved = currentText;
					currentText = "";
					processBlock(child);
					const inner = currentText.trimEnd();
					currentText = saved;
					for (const line of inner.split("\n")) {
						if (line.trim()) {
							appendText("> " + line + "\n");
						}
					}
				}
				appendText("\n");
				break;
			}
			case "codeBlock": {
				const lang = String(node.attrs?.language ?? "");
				appendText("```" + lang + "\n");
				processInline(node.content);
				appendText("\n```\n\n");
				break;
			}
			case "horizontalRule": {
				appendText("---\n\n");
				break;
			}
			default: {
				for (const child of node.content ?? []) {
					processBlock(child);
				}
			}
		}
	};

	const root = doc as JSONNode;
	for (const node of root.content ?? []) {
		processBlock(node);
	}

	flushText();
	return blocks;
}

export class RichTextEditor extends Component {
	private _editor: Editor | null = null;
	private _editorEl: HTMLElement;
	private _disabled = false;

	private readonly _onSend = this._register(new Emitter<{ blocks: ContentBlock[]; text?: string }>());
	readonly onSend: Event<{ blocks: ContentBlock[]; text?: string }> = this._onSend.event;

	private readonly _onUpdate = this._register(new Emitter<void>());
	readonly onUpdate: Event<void> = this._onUpdate.event;

	constructor(placeholder: string) {
		super('div', 'sc-rich-editor');

		this._editorEl = DOM.append(this.element, $('div.sc-editor-content'));

		// Inject a style tag to nuke ProseMirror's default outlines/borders
		const styleEl = document.createElement('style');
		styleEl.textContent = `
			.sc-prosemirror.ProseMirror,
			.sc-prosemirror.ProseMirror-focused,
			.sc-prosemirror.ProseMirror-selectednode {
				outline: none !important;
				border: none !important;
				box-shadow: none !important;
			}
			.ProseMirror-selectednode {
				outline: none !important;
			}
		`;
		this._editorEl.appendChild(styleEl);

		this._editor = new Editor({
			element: this._editorEl,
			extensions: [
				StarterKit.configure({
					// Disable markdown formatting - we want plain text input, not WYSIWYG
					bold: false,
					italic: false,
					code: false,
					strike: false,
					heading: false,
					bulletList: false,
					orderedList: false,
					listItem: false,
					blockquote: false,
					codeBlock: false,
					horizontalRule: false,
				}),
				Placeholder.configure({
					placeholder,
				}),
				Image.configure({
					allowBase64: true,
				}),
			],
			editorProps: {
				attributes: {
					class: 'sc-prosemirror',
				},
				handlePaste: (view, event) => {
					const data = event.clipboardData;
					if (!data) return false;

					// Handle image paste
					if (data.files && data.files.length > 0) {
						for (const file of data.files) {
							if (file.type.startsWith("image/")) {
								event.preventDefault();
								const reader = new FileReader();
								reader.onload = (e) => {
									const dataUrl = e.target?.result as string;
									if (dataUrl && this._editor) {
										this._editor.chain().focus().setImage({ src: dataUrl }).run();
									}
								};
								reader.readAsDataURL(file);
								return true;
							}
						}
					}

					return false;
				},
				handleDrop: (view, event) => {
					const dt = event.dataTransfer;
					if (!dt) return false;

					// Handle image drop
					const files = dt.files;
					if (files && files.length > 0) {
						event.preventDefault();
						for (const file of files) {
							if (file.type.startsWith("image/")) {
								const reader = new FileReader();
								reader.onload = (e) => {
									const dataUrl = e.target?.result as string;
									if (dataUrl && this._editor) {
										this._editor.chain().focus().setImage({ src: dataUrl }).run();
									}
								};
								reader.readAsDataURL(file);
							}
						}
						return true;
					}

					return false;
				},
			},
			onUpdate: () => {
				this._onUpdate.fire();
			},
		});
	}

	get editor(): Editor | null {
		return this._editor;
	}

	get hasContent(): boolean {
		if (!this._editor) return false;
		const json = this._editor.getJSON();
		const blocks = extractContentBlocks(json);
		return blocks.some(b => {
			if (b.type === 'text') return (b.text || '').trim().length > 0;
			return true;
		});
	}

	setEditable(editable: boolean): void {
		this._disabled = !editable;
		this._editor?.setEditable(editable);
	}

	focus(): void {
		this._editor?.commands.focus();
	}

	clear(): void {
		this._editor?.commands.clearContent();
	}

	send(): void {
		if (!this._editor || this._disabled) return;

		const json = this._editor.getJSON();
		const blocks = extractContentBlocks(json);

		const hasContent = blocks.some(b => {
			if (b.type === 'text') return (b.text || '').trim().length > 0;
			return true;
		});

		if (!hasContent) return;

		const text = blocks
			.map(b => {
				if (b.type === 'text') return b.text;
				if (b.type === 'image') return '[Image]';
				if (b.type === 'resource_link') return `[@${b.name}](${b.uri})`;
				return '';
			})
			.join('');

		this._onSend.fire({ blocks, text });
		this.clear();
	}

	override dispose(): void {
		this._editor?.destroy();
		super.dispose();
	}
}
