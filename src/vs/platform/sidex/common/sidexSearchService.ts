import { invoke } from '../../../sidex-bridge.js';

export interface SearchMatch {
	path: string;
	lineNumber: number;
	lineText: string;
	matchStart: number;
	matchEnd: number;
}

export interface SearchResult {
	path: string;
	matches: SearchMatch[];
}

export class SideXSearchService {
	async searchText(
		directory: string,
		query: string,
		options?: {
			caseSensitive?: boolean;
			wholeWord?: boolean;
			regex?: boolean;
			include?: string;
			exclude?: string;
			maxResults?: number;
		}
	): Promise<SearchResult[]> {
		try {
			return (
				(await invoke('search_text', {
					root: directory,
					query,
					options: {
						case_sensitive: options?.caseSensitive ?? false,
						whole_word: options?.wholeWord ?? false,
						is_regex: options?.regex ?? false,
						include: options?.include ? [options.include] : [],
						exclude: options?.exclude ? [options.exclude] : [],
						max_results: options?.maxResults ?? 1000,
					},
				})) || []
			);
		} catch (e) {
			console.warn('[SideX] search failed:', e);
			return [];
		}
	}

	async searchFiles(directory: string, pattern: string): Promise<string[]> {
		try {
			const results = await invoke<Array<{ path: string }>>('search_files', { root: directory, pattern });
			return (results || []).map(r => r.path);
		} catch {
			return [];
		}
	}
}
