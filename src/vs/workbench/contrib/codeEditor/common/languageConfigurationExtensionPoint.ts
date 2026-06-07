/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ParseError, parse, getNodeType } from '../../../../base/common/json.js';
import * as types from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { CharacterPair, CommentRule, EnterAction, ExplicitLanguageConfiguration, FoldingMarkers, FoldingRules, IAutoClosingPair, IAutoClosingPairConditional, IndentAction, IndentationRule, OnEnterRule } from '../../../../editor/common/languages/languageConfiguration.js';
import { ILanguageConfigurationService } from '../../../../editor/common/languages/languageConfigurationRegistry.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { getParseErrorMessage } from '../../../../base/common/jsonErrorMessages.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

interface IRegExp {
	pattern: string;
	flags?: string;
}

interface IIndentationRules {
	decreaseIndentPattern: string | IRegExp;
	increaseIndentPattern: string | IRegExp;
	indentNextLinePattern?: string | IRegExp;
	unIndentedLinePattern?: string | IRegExp;
}

interface IEnterAction {
	indent: 'none' | 'indent' | 'indentOutdent' | 'outdent';
	appendText?: string;
	removeText?: number;
}

interface IOnEnterRule {
	beforeText: string | IRegExp;
	afterText?: string | IRegExp;
	previousLineText?: string | IRegExp;
	action: IEnterAction;
}

/**
 * Serialized form of a language configuration
 */
export interface ILanguageConfiguration {
	comments?: CommentRule;
	brackets?: CharacterPair[];
	autoClosingPairs?: Array<CharacterPair | IAutoClosingPairConditional>;
	surroundingPairs?: Array<CharacterPair | IAutoClosingPair>;
	colorizedBracketPairs?: Array<CharacterPair>;
	wordPattern?: string | IRegExp;
	indentationRules?: IIndentationRules;
	folding?: {
		offSide?: boolean;
		markers?: {
			start?: string | IRegExp;
			end?: string | IRegExp;
		};
	};
	autoCloseBefore?: string;
	onEnterRules?: IOnEnterRule[];
}

function isStringArr(something: string[] | null): something is string[] {
	if (!Array.isArray(something)) {
		return false;
	}
	for (let i = 0, len = something.length; i < len; i++) {
		if (typeof something[i] !== 'string') {
			return false;
		}
	}
	return true;
}

function isCharacterPair(something: CharacterPair | null): boolean {
	return (
		isStringArr(something)
		&& something.length === 2
	);
}

export class LanguageConfigurationFileHandler extends Disposable {

	private readonly _done = new Map<string, number>();

	constructor(
		@ILanguageService private readonly _languageService: ILanguageService,
		@IExtensionResourceLoaderService private readonly _extensionResourceLoaderService: IExtensionResourceLoaderService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILanguageConfigurationService private readonly _languageConfigurationService: ILanguageConfigurationService,
	) {
		super();

		this._register(this._languageService.onDidRequestBasicLanguageFeatures(async (languageIdentifier) => {
			this._extensionService.whenInstalledExtensionsRegistered().then(() => {
				this._loadConfigurationsForMode(languageIdentifier);
			});
		}));
		this._register(this._languageService.onDidChange(() => {
			for (const [languageId] of this._done) {
				this._loadConfigurationsForMode(languageId);
			}
		}));
	}

	private async _loadConfigurationsForMode(languageId: string): Promise<void> {
		const configurationFiles = this._languageService.getConfigurationFiles(languageId);
		const configurationHash = hash(configurationFiles.map(uri => uri.toString()));

		if (this._done.get(languageId) === configurationHash) {
			return;
		}
		this._done.set(languageId, configurationHash);

		const configs = await Promise.all(configurationFiles.map(configFile => this._readConfigFile(configFile)));
		for (const config of configs) {
			this._handleConfig(languageId, config);
		}
	}

	private async _readConfigFile(configFileLocation: URI): Promise<ILanguageConfiguration> {
		try {
			const contents = await this._extensionResourceLoaderService.readExtensionResource(configFileLocation);
			const errors: ParseError[] = [];
			let configuration = <ILanguageConfiguration>parse(contents, errors);
			if (errors.length) {
				console.error(localize('parseErrors', "Errors parsing {0}: {1}", configFileLocation.toString(), errors.map(e => (`[${e.offset}, ${e.length}] ${getParseErrorMessage(e.error)}`)).join('\n')));
			}
			if (getNodeType(configuration) !== 'object') {
				console.error(localize('formatError', "{0}: Invalid format, JSON object expected.", configFileLocation.toString()));
				configuration = {};
			}
			return configuration;
		} catch (err) {
			console.error(err);
			return {};
		}
	}

	private static _extractValidCommentRule(languageId: string, configuration: ILanguageConfiguration): CommentRule | undefined {
		const source = configuration.comments;
		if (typeof source === 'undefined') {
			return undefined;
		}
		if (!types.isObject(source)) {
			console.warn(`[${languageId}]: language configuration: expected \`comments\` to be an object.`);
			return undefined;
		}

		let result: CommentRule | undefined = undefined;
		if (typeof source.lineComment !== 'undefined') {
			if (typeof source.lineComment === 'string') {
				result = result || {};
				result.lineComment = source.lineComment;
			} else if (types.isObject(source.lineComment)) {
				const lineCommentObj = source.lineComment;
				if (typeof lineCommentObj.comment === 'string') {
					result = result || {};
					result.lineComment = {
						comment: lineCommentObj.comment,
						noIndent: lineCommentObj.noIndent
					};
				} else {
					console.warn(`[${languageId}]: language configuration: expected \`comments.lineComment.comment\` to be a string.`);
				}
			} else {
				console.warn(`[${languageId}]: language configuration: expected \`comments.lineComment\` to be a string or an object with comment property.`);
			}
		}
		if (typeof source.blockComment !== 'undefined') {
			if (!isCharacterPair(source.blockComment)) {
				console.warn(`[${languageId}]: language configuration: expected \`comments.blockComment\` to be an array of two strings.`);
			} else {
				result = result || {};
				result.blockComment = source.blockComment;
			}
		}
		return result;
	}

	private static _extractValidBrackets(languageId: string, configuration: ILanguageConfiguration): CharacterPair[] | undefined {
		const source = configuration.brackets;
		if (typeof source === 'undefined') {
			return undefined;
		}
		if (!Array.isArray(source)) {
			console.warn(`[${languageId}]: language configuration: expected \`brackets\` to be an array.`);
			return undefined;
		}

		let result: CharacterPair[] | undefined = undefined;
		for (let i = 0, len = source.length; i < len; i++) {
			const pair = source[i];
			if (!isCharacterPair(pair)) {
				console.warn(`[${languageId}]: language configuration: expected \`brackets[${i}]\` to be an array of two strings.`);
				continue;
			}

			result = result || [];
			result.push(pair);
		}
		return result;
	}

	private static _extractValidAutoClosingPairs(languageId: string, configuration: ILanguageConfiguration): IAutoClosingPairConditional[] | undefined {
		const source = configuration.autoClosingPairs;
		if (typeof source === 'undefined') {
			return undefined;
		}
		if (!Array.isArray(source)) {
			console.warn(`[${languageId}]: language configuration: expected \`autoClosingPairs\` to be an array.`);
			return undefined;
		}

		let result: IAutoClosingPairConditional[] | undefined = undefined;
		for (let i = 0, len = source.length; i < len; i++) {
			const pair = source[i];
			if (Array.isArray(pair)) {
				if (!isCharacterPair(pair)) {
					console.warn(`[${languageId}]: language configuration: expected \`autoClosingPairs[${i}]\` to be an array of two strings or an object.`);
					continue;
				}
				result = result || [];
				result.push({ open: pair[0], close: pair[1] });
			} else {
				if (!types.isObject(pair)) {
					console.warn(`[${languageId}]: language configuration: expected \`autoClosingPairs[${i}]\` to be an array of two strings or an object.`);
					continue;
				}
				if (typeof pair.open !== 'string') {
					console.warn(`[${languageId}]: language configuration: expected \`autoClosingPairs[${i}].open\` to be a string.`);
					continue;
				}
				if (typeof pair.close !== 'string') {
					console.warn(`[${languageId}]: language configuration: expected \`autoClosingPairs[${i}].close\` to be a string.`);
					continue;
				}
				if (typeof pair.notIn !== 'undefined') {
					if (!isStringArr(pair.notIn)) {
						console.warn(`[${languageId}]: language configuration: expected \`autoClosingPairs[${i}].notIn\` to be a string array.`);
						continue;
					}
				}
				result = result || [];
				result.push({ open: pair.open, close: pair.close, notIn: pair.notIn });
			}
		}
		return result;
	}

	private static _extractValidSurroundingPairs(languageId: string, configuration: ILanguageConfiguration): IAutoClosingPair[] | undefined {
		const source = configuration.surroundingPairs;
		if (typeof source === 'undefined') {
			return undefined;
		}
		if (!Array.isArray(source)) {
			console.warn(`[${languageId}]: language configuration: expected \`surroundingPairs\` to be an array.`);
			return undefined;
		}

		let result: IAutoClosingPair[] | undefined = undefined;
		for (let i = 0, len = source.length; i < len; i++) {
			const pair = source[i];
			if (Array.isArray(pair)) {
				if (!isCharacterPair(pair)) {
					console.warn(`[${languageId}]: language configuration: expected \`surroundingPairs[${i}]\` to be an array of two strings or an object.`);
					continue;
				}
				result = result || [];
				result.push({ open: pair[0], close: pair[1] });
			} else {
				if (!types.isObject(pair)) {
					console.warn(`[${languageId}]: language configuration: expected \`surroundingPairs[${i}]\` to be an array of two strings or an object.`);
					continue;
				}
				if (typeof pair.open !== 'string') {
					console.warn(`[${languageId}]: language configuration: expected \`surroundingPairs[${i}].open\` to be a string.`);
					continue;
				}
				if (typeof pair.close !== 'string') {
					console.warn(`[${languageId}]: language configuration: expected \`surroundingPairs[${i}].close\` to be a string.`);
					continue;
				}
				result = result || [];
				result.push({ open: pair.open, close: pair.close });
			}
		}
		return result;
	}

	private static _extractValidColorizedBracketPairs(languageId: string, configuration: ILanguageConfiguration): CharacterPair[] | undefined {
		const source = configuration.colorizedBracketPairs;
		if (typeof source === 'undefined') {
			return undefined;
		}
		if (!Array.isArray(source)) {
			console.warn(`[${languageId}]: language configuration: expected \`colorizedBracketPairs\` to be an array.`);
			return undefined;
		}

		const result: CharacterPair[] = [];
		for (let i = 0, len = source.length; i < len; i++) {
			const pair = source[i];
			if (!isCharacterPair(pair)) {
				console.warn(`[${languageId}]: language configuration: expected \`colorizedBracketPairs[${i}]\` to be an array of two strings.`);
				continue;
			}
			result.push([pair[0], pair[1]]);
		}
		return result;
	}

	private static _extractValidOnEnterRules(languageId: string, configuration: ILanguageConfiguration): OnEnterRule[] | undefined {
		const source = configuration.onEnterRules;
		if (typeof source === 'undefined') {
			return undefined;
		}
		if (!Array.isArray(source)) {
			console.warn(`[${languageId}]: language configuration: expected \`onEnterRules\` to be an array.`);
			return undefined;
		}

		let result: OnEnterRule[] | undefined = undefined;
		for (let i = 0, len = source.length; i < len; i++) {
			const onEnterRule = source[i];
			if (!types.isObject(onEnterRule)) {
				console.warn(`[${languageId}]: language configuration: expected \`onEnterRules[${i}]\` to be an object.`);
				continue;
			}
			if (!types.isObject(onEnterRule.action)) {
				console.warn(`[${languageId}]: language configuration: expected \`onEnterRules[${i}].action\` to be an object.`);
				continue;
			}
			let indentAction: IndentAction;
			if (onEnterRule.action.indent === 'none') {
				indentAction = IndentAction.None;
			} else if (onEnterRule.action.indent === 'indent') {
				indentAction = IndentAction.Indent;
			} else if (onEnterRule.action.indent === 'indentOutdent') {
				indentAction = IndentAction.IndentOutdent;
			} else if (onEnterRule.action.indent === 'outdent') {
				indentAction = IndentAction.Outdent;
			} else {
				console.warn(`[${languageId}]: language configuration: expected \`onEnterRules[${i}].action.indent\` to be 'none', 'indent', 'indentOutdent' or 'outdent'.`);
				continue;
			}
			const action: EnterAction = { indentAction };
			if (onEnterRule.action.appendText) {
				if (typeof onEnterRule.action.appendText === 'string') {
					action.appendText = onEnterRule.action.appendText;
				} else {
					console.warn(`[${languageId}]: language configuration: expected \`onEnterRules[${i}].action.appendText\` to be undefined or a string.`);
				}
			}
			if (onEnterRule.action.removeText) {
				if (typeof onEnterRule.action.removeText === 'number') {
					action.removeText = onEnterRule.action.removeText;
				} else {
					console.warn(`[${languageId}]: language configuration: expected \`onEnterRules[${i}].action.removeText\` to be undefined or a number.`);
				}
			}
			const beforeText = this._parseRegex(languageId, `onEnterRules[${i}].beforeText`, onEnterRule.beforeText);
			if (!beforeText) {
				continue;
			}
			const resultingOnEnterRule: OnEnterRule = { beforeText, action };
			if (onEnterRule.afterText) {
				const afterText = this._parseRegex(languageId, `onEnterRules[${i}].afterText`, onEnterRule.afterText);
				if (afterText) {
					resultingOnEnterRule.afterText = afterText;
				}
			}
			if (onEnterRule.previousLineText) {
				const previousLineText = this._parseRegex(languageId, `onEnterRules[${i}].previousLineText`, onEnterRule.previousLineText);
				if (previousLineText) {
					resultingOnEnterRule.previousLineText = previousLineText;
				}
			}
			result = result || [];
			result.push(resultingOnEnterRule);
		}

		return result;
	}

	public static extractValidConfig(languageId: string, configuration: ILanguageConfiguration): ExplicitLanguageConfiguration {

		const comments = this._extractValidCommentRule(languageId, configuration);
		const brackets = this._extractValidBrackets(languageId, configuration);
		const autoClosingPairs = this._extractValidAutoClosingPairs(languageId, configuration);
		const surroundingPairs = this._extractValidSurroundingPairs(languageId, configuration);
		const colorizedBracketPairs = this._extractValidColorizedBracketPairs(languageId, configuration);
		const autoCloseBefore = (typeof configuration.autoCloseBefore === 'string' ? configuration.autoCloseBefore : undefined);
		const wordPattern = (configuration.wordPattern ? this._parseRegex(languageId, `wordPattern`, configuration.wordPattern) : undefined);
		const indentationRules = (configuration.indentationRules ? this._mapIndentationRules(languageId, configuration.indentationRules) : undefined);
		let folding: FoldingRules | undefined = undefined;
		if (configuration.folding) {
			const rawMarkers = configuration.folding.markers;
			const startMarker = (rawMarkers && rawMarkers.start ? this._parseRegex(languageId, `folding.markers.start`, rawMarkers.start) : undefined);
			const endMarker = (rawMarkers && rawMarkers.end ? this._parseRegex(languageId, `folding.markers.end`, rawMarkers.end) : undefined);
			const markers: FoldingMarkers | undefined = (startMarker && endMarker ? { start: startMarker, end: endMarker } : undefined);
			folding = {
				offSide: configuration.folding.offSide,
				markers
			};
		}
		const onEnterRules = this._extractValidOnEnterRules(languageId, configuration);

		const richEditConfig: ExplicitLanguageConfiguration = {
			comments,
			brackets,
			wordPattern,
			indentationRules,
			onEnterRules,
			autoClosingPairs,
			surroundingPairs,
			colorizedBracketPairs,
			autoCloseBefore,
			folding,
			__electricCharacterSupport: undefined,
		};
		return richEditConfig;
	}

	private _handleConfig(languageId: string, configuration: ILanguageConfiguration): void {
		const richEditConfig = LanguageConfigurationFileHandler.extractValidConfig(languageId, configuration);
		this._languageConfigurationService.register(languageId, richEditConfig, 50);
	}

	private static _parseRegex(languageId: string, confPath: string, value: string | IRegExp): RegExp | undefined {
		if (typeof value === 'string') {
			try {
				return new RegExp(value, '');
			} catch (err) {
				console.warn(`[${languageId}]: Invalid regular expression in \`${confPath}\`: `, err);
				return undefined;
			}
		}
		if (types.isObject(value)) {
			if (typeof value.pattern !== 'string') {
				console.warn(`[${languageId}]: language configuration: expected \`${confPath}.pattern\` to be a string.`);
				return undefined;
			}
			if (typeof value.flags !== 'undefined' && typeof value.flags !== 'string') {
				console.warn(`[${languageId}]: language configuration: expected \`${confPath}.flags\` to be a string.`);
				return undefined;
			}
			try {
				return new RegExp(value.pattern, value.flags);
			} catch (err) {
				console.warn(`[${languageId}]: Invalid regular expression in \`${confPath}\`: `, err);
				return undefined;
			}
		}
		console.warn(`[${languageId}]: language configuration: expected \`${confPath}\` to be a string or an object.`);
		return undefined;
	}

	private static _mapIndentationRules(languageId: string, indentationRules: IIndentationRules): IndentationRule | undefined {
		const increaseIndentPattern = this._parseRegex(languageId, `indentationRules.increaseIndentPattern`, indentationRules.increaseIndentPattern);
		if (!increaseIndentPattern) {
			return undefined;
		}
		const decreaseIndentPattern = this._parseRegex(languageId, `indentationRules.decreaseIndentPattern`, indentationRules.decreaseIndentPattern);
		if (!decreaseIndentPattern) {
			return undefined;
		}

		const result: IndentationRule = {
			increaseIndentPattern: increaseIndentPattern,
			decreaseIndentPattern: decreaseIndentPattern
		};

		if (indentationRules.indentNextLinePattern) {
			result.indentNextLinePattern = this._parseRegex(languageId, `indentationRules.indentNextLinePattern`, indentationRules.indentNextLinePattern);
		}
		if (indentationRules.unIndentedLinePattern) {
			result.unIndentedLinePattern = this._parseRegex(languageId, `indentationRules.unIndentedLinePattern`, indentationRules.unIndentedLinePattern);
		}

		return result;
	}
}
