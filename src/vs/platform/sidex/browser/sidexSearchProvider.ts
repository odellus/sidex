/*---------------------------------------------------------------------------------------------
 *  SideX — Search provider backed by our Rust ripgrep integration.
 *  Provides a lightweight API for components that need search results without
 *  going through the full VS Code ISearchService machinery.
 *
 *  Registration note: VS Code's ISearchService is already provided by
 *  `TauriSearchService` (see services/search/browser/tauriSearchService.ts).
 *  This bridge complements it via its own decorator ISideXSearchProviderService
 *  for components that want the simpler string-based API.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../sidex-bridge.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';

export interface FileSearchResult {
	path: string;
	matches: Array<{
		lineNumber: number;
		lineText: string;
		matchStart: number;
		matchEnd: number;
	}>;
}

export const ISideXSearchProviderService = createDecorator<ISideXSearchProviderService>('sidexSearchProviderService');

export interface ISideXSearchProviderService extends SideXSearchProvider {
	readonly _serviceBrand: undefined;
}

export class SideXSearchProvider {
	declare readonly _serviceBrand: undefined;
	async textSearch(
		directory: string,
		query: string,
		options: {
			caseSensitive?: boolean;
			wholeWord?: boolean;
			regex?: boolean;
			include?: string;
			exclude?: string;
			maxResults?: number;
		} = {}
	): Promise<FileSearchResult[]> {
		try {
			const results = await invoke('search_text', {
				root: directory,
				query,
				options: {
					case_sensitive: options.caseSensitive ?? false,
					whole_word: options.wholeWord ?? false,
					is_regex: options.regex ?? false,
					include: options.include ? [options.include] : [],
					exclude: options.exclude ? [options.exclude] : [],
					max_results: options.maxResults ?? 2000,
				},
			});
			return (results as FileSearchResult[]) || [];
		} catch (e) {
			console.error('[SideX] Search failed:', e);
			return [];
		}
	}

	async fileSearch(directory: string, pattern: string): Promise<string[]> {
		try {
			const results = await invoke<Array<{ path: string }>>('search_files', { root: directory, pattern });
			return (results || []).map(r => r.path);
		} catch {
			return [];
		}
	}
}

registerSingleton(ISideXSearchProviderService, SideXSearchProvider, InstantiationType.Delayed);
