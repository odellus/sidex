/*---------------------------------------------------------------------------------------------
 *  SideX Syntax Service (browser)
 *  Thin wrapper around the Rust `sidex-syntax` crate via Tauri IPC. Provides
 *  language detection, language configuration, and tree-sitter based
 *  tokenization.
 *
 *  Registration note: VS Code's ILanguageService (editor/common/languages/
 *  language.ts) is a stateful, event-emitting service for the monaco language
 *  registry and is not replaced here. This bridge exposes a simpler async API
 *  via its own decorator; higher-level code can adapt it as needed.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../sidex-bridge.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';

export interface LanguageInfo {
	id: string;
	name: string;
	extensions: string[];
	filenames: string[];
}

export interface AutoClosePair {
	open: string;
	close: string;
	not_in: string[];
}

export interface SurroundPair {
	open: string;
	close: string;
}

export interface LanguageConfig {
	line_comment: string | null;
	block_comment: [string, string] | null;
	brackets: [string, string][];
	auto_closing_pairs: AutoClosePair[];
	surrounding_pairs: SurroundPair[];
}

export interface SyntaxToken {
	line: number;
	start: number;
	length: number;
	scope: string;
}

export const ISideXSyntaxBrowserService = createDecorator<ISideXSyntaxBrowserService>('sidexSyntaxBrowserService');

export interface ISideXSyntaxBrowserService extends SideXSyntaxBrowserService {
	readonly _serviceBrand: undefined;
}

export class SideXSyntaxBrowserService {
	declare readonly _serviceBrand: undefined;
	private languageCache = new Map<string, LanguageInfo>();

	async getLanguages(): Promise<LanguageInfo[]> {
		try {
			const languages = await invoke<LanguageInfo[]>('syntax_get_languages');
			if (Array.isArray(languages)) {
				for (const lang of languages) {
					this.languageCache.set(lang.id, lang);
				}
				return languages;
			}
		} catch (e) {
			console.warn('[SideX] syntax_get_languages failed:', e);
		}
		return [];
	}

	getCachedLanguage(id: string): LanguageInfo | undefined {
		return this.languageCache.get(id);
	}

	async detectLanguage(filename: string): Promise<string> {
		try {
			const result = await invoke<string>('syntax_detect_language', { filename });
			return typeof result === 'string' ? result : 'plaintext';
		} catch {
			return 'plaintext';
		}
	}

	async getLanguageConfig(languageId: string): Promise<LanguageConfig | null> {
		try {
			return await invoke<LanguageConfig>('syntax_get_language_config', { languageId });
		} catch {
			return null;
		}
	}

	async tokenize(language: string, source: string): Promise<SyntaxToken[]> {
		try {
			return (await invoke<SyntaxToken[]>('syntax_tokenize', { language, source })) ?? [];
		} catch (e) {
			console.warn('[SideX] syntax_tokenize failed:', e);
			return [];
		}
	}
}

registerSingleton(ISideXSyntaxBrowserService, SideXSyntaxBrowserService, InstantiationType.Delayed);
