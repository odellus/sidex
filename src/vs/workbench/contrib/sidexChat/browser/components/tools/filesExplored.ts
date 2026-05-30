import { Component, DOM, $ } from '../base.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { Collapsible } from '../collapsible/collapsible.js';

// Map file extensions to codicons for common languages
function getFileIcon(filename: string): ThemeIcon {
	const ext = filename.split('.').pop()?.toLowerCase() || '';
	switch (ext) {
		case 'ts': case 'tsx': return Codicon.symbolFile;
		case 'js': case 'jsx': return Codicon.symbolFile;
		case 'json': return Codicon.json;
		case 'md': return Codicon.markdown;
		case 'css': case 'scss': case 'less': return Codicon.symbolColor;
		case 'html': return Codicon.code;
		case 'py': return Codicon.symbolFile;
		case 'rs': return Codicon.symbolFile;
		case 'go': return Codicon.symbolFile;
		case 'svg': return Codicon.symbolFile;
		case 'yaml': case 'yml': return Codicon.symbolFile;
		case 'toml': return Codicon.symbolFile;
		case 'sh': case 'bash': return Codicon.terminal;
		case 'gitignore': return Codicon.sourceControl;
		default: return Codicon.file;
	}
}

export class FilesExplored extends Component {
	private _collapsible: Collapsible;
	private readonly _onFileClick: ((path: string) => void) | undefined;

	constructor(files: string[], onFileClick?: (path: string) => void) {
		super('div', 'sc-files-explored');
		this._onFileClick = onFileClick;

		this._collapsible = new Collapsible(`Explored ${files.length} file${files.length !== 1 ? 's' : ''}`);
		this._collapsible.appendTo(this.element);
		this._register(this._collapsible);

		for (const file of files) {
			const item = DOM.append(this._collapsible.body, $('div.sc-file-item'));
			const filename = file.split('/').pop() || file;

			const icon = document.createElement('span');
			icon.classList.add(...ThemeIcon.asClassNameArray(getFileIcon(filename)));
			icon.classList.add('sc-file-icon');
			item.appendChild(icon);

			const name = DOM.append(item, $('span.sc-file-name'));
			name.textContent = filename;
			name.title = file;

			if (this._onFileClick) {
				item.classList.add('sc-file-item-clickable');
				this.on(item, 'click', () => this._onFileClick!(file));
			}
		}
	}
}
