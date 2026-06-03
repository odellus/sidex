/*---------------------------------------------------------------------------------------------
 *  Crow — Tauri-based VSCode port
 *  Bootstrap: sets globals that VSCode needs BEFORE any VSCode code loads
 *--------------------------------------------------------------------------------------------*/

(globalThis as any)._VSCODE_FILE_ROOT = new URL('.', import.meta.url).href;

(globalThis as any)._VSCODE_NLS_MESSAGES = [];
(globalThis as any)._VSCODE_NLS_LANGUAGE = 'en';

(globalThis as any)._VSCODE_PRODUCT_JSON = {
	nameShort: 'Crow',
	nameLong: 'Crow',
	applicationName: 'crow',
	dataFolderName: '.crow',
	urlProtocol: 'crow',
	version: '1.96.0',
	commit: '',
	date: new Date().toISOString(),
	quality: 'stable'
};

(globalThis as any)._VSCODE_PACKAGE_JSON = {
	version: '1.96.0'
};
