= Auto-Surround Feature Analysis

== Problem Statement

When text is selected in the editor and the user types a bracket `(`, `[`, `{` or quote `"`, `'`, `` ` ``, the selected text should be surrounded by the matching pair instead of being replaced. This is called "auto-surround" or "surround selection with brackets/quotes".

== How It Works in VSCode

=== Architecture Overview

The auto-surround feature is implemented in the core editor's type handling pipeline:

```
User types character
  ↓
TypeOperations.typeWithInterceptors()
  ↓
SurroundSelectionOperation.getEdits()
  ↓
SurroundSelectionCommand (wraps selection)
```

=== Key Components

==== 1. Configuration Layer

#strong[Editor Options] (`src/vs/editor/common/config/editorOptions.ts`):
+ #code["editor.autoSurround"] — Controls when to surround (defaults to #code["'languageDefined'"])
  + #code["'languageDefined'"] — Use language configuration
  + #code["'quotes'"] — Only surround with quotes
  + #code["'brackets'"] — Only surround with brackets
  + #code["'never'"] — Never surround

#strong[Language Configuration] (e.g., `extensions/typescript-basics/language-configuration.json`):
```json
"surroundingPairs": [
  ["{", "}"],
  ["[", "]"],
  ["(", ")"],
  ["\"", "\""],
  ["'", "'"],
  ["`", "`"],
  ["<", ">"]
]
```

==== 2. Cursor Configuration

#code["src/vs/editor/common/cursorCommon.ts"] — #code["CursorConfiguration"] class:
+ Reads #code["autoSurround"] from editor options
+ Reads #code["surroundingPairs"] from #code["languageConfigurationService.getLanguageConfiguration(languageId).getSurroundingPairs()"]
+ Stores them in #code["this.autoSurround"] and #code["this.surroundingPairs"]

==== 3. Type Operation Pipeline

#code["src/vs/editor/common/cursor/cursorTypeOperations.ts"] — #code["TypeOperations.typeWithInterceptors()"]:

The method tries operations in this order:
1. #code["EnterOperation"] — Handle Enter key
2. #code["AutoIndentOperation"] — Auto-indentation
3. #code["AutoClosingOvertypeOperation"] — Overtype closing bracket
4. #code["AutoClosingOpenCharTypeOperation"] — Auto-close brackets/quotes
5. #strong[#code["SurroundSelectionOperation"]] — Surround selected text
6. #code["InterceptorElectricCharOperation"] — Electric characters
7. #code["SimpleCharacterTypeOperation"] — Fallback plain typing

==== 4. Surround Logic

#code["src/vs/editor/common/cursor/cursorTypeEditOperations.ts"] — #code["SurroundSelectionOperation"]:

#strong[#code["_isSurroundSelectionType()"]] checks:
+ #code["shouldSurroundChar(config, ch)"] — Returns true if #code["autoSurround"] allows this character type
+ #code["config.surroundingPairs.hasOwnProperty(ch)"] — Character is in the language's surrounding pairs
+ Selection is NOT empty
+ Selection is NOT only whitespace
+ Special case: Don't surround quotes on top of other quotes

#strong[#code["_runSurroundSelectionType()"]] creates:
+ #code["SurroundSelectionCommand"] for each selection
+ Uses #code["config.surroundingPairs[ch]"] to get the closing character

==== 5. Command Execution

#code["src/vs/editor/common/commands/surroundSelectionCommand.ts"] — #code["SurroundSelectionCommand"]:

```typescript
getEditOperations(model, builder) {
  // Insert opening character at selection start
  builder.addTrackedEditOperation(
    new Range(startLine, startCol, startLine, startCol),
    this._charBeforeSelection  // e.g., "("
  );
  
  // Insert closing character at selection end
  builder.addTrackedEditOperation(
    new Range(endLine, endCol, endLine, endCol),
    this._charAfterSelection   // e.g., ")"
  );
}

computeCursorState(model, helper) {
  // Cursor ends between the two inserted characters
  return new Selection(
    firstOp.endLine, firstOp.endCol,
    secondOp.endLine, secondOp.endCol - closeCharLength
  );
}
```

=== Language Configuration Loading

#code["src/vs/editor/common/languages/supports/characterPair.ts"] — #code["CharacterPairSupport"]:

```typescript
constructor(config: LanguageConfiguration) {
  // Load autoClosingPairs
  if (config.autoClosingPairs) {
    this._autoClosingPairs = config.autoClosingPairs.map(...);
  } else if (config.brackets) {
    // Fallback to brackets
    this._autoClosingPairs = config.brackets.map(...);
  }
  
  // Load surroundingPairs (fallback to autoClosingPairs)
  this._surroundingPairs = config.surroundingPairs || this._autoClosingPairs;
}
```

=== Extension Host Integration

#code["src/vs/workbench/contrib/extensions/browser/tauriExtensionHost.contribution.ts"]:

The #code["_onLanguageConfigurationChanged()"] method (line ~2460):
+ Receives language configuration from extension host
+ Copies #code["surroundingPairs"] to #code["langConfig"]
+ Registers with #code["langConfigService.register(language, langConfig)"]

== Current State in sidex

=== Infrastructure Present

✅ All VSCode core files are present:
+ #code["cursorTypeOperations.ts"] with #code["SurroundSelectionOperation"]
+ #code["cursorTypeEditOperations.ts"] with surround logic
+ #code["surroundSelectionCommand.ts"] command implementation
+ #code["editorOptions.ts"] with #code["autoSurround"] option
+ #code["cursorCommon.ts"] reading #code["surroundingPairs"]

✅ Language configurations define #code["surroundingPairs"]:
+ TypeScript, JavaScript, Python, Rust, Go, C/C++, etc.
+ All have proper bracket and quote pairs defined

✅ Extension host integration:
+ #code["tauriExtensionHost.contribution.ts"] copies #code["surroundingPairs"]
+ Registers with language configuration service

=== Potential Issues

#strong[1. Extension Host Not Loading Language Configurations]
The extension host may not be sending #code["languageConfigurationChanged"] events for all languages, or the configurations may not include #code["surroundingPairs"].

#strong[2. Language Configuration Service Not Populating]
The #code["languageConfigurationService"] may not be properly storing or retrieving the #code["surroundingPairs"] for a given language ID.

#strong[3. Type Operation Not Being Called]
The #code["typeWithInterceptors()"] method may not be invoked, or a different code path may be used.

#strong[4. Configuration Defaults Overridden]
The #code["autoSurround"] option may be set to #code["'never'"] in user or workspace settings.

#strong[5. Dedentation Conflict]
The user mentioned being "cautious of how that can clash with dedenting". When a user types a closing bracket, VSCode's auto-indent logic may try to dedent the line, potentially interfering with the surround operation.

== Investigation Plan

=== Step 1: Verify Current Behavior
Open the editor and test:
1. Select text: #code["hello"]
2. Type #code["("]
3. Expected: #code["(hello)"] with cursor after "hello"
4. Actual: ???

=== Step 2: Check Browser Console
Open devtools and check:
1. Are there any errors related to language configuration?
2. Is #code["languageConfigurationChanged"] being fired?
3. What is the value of #code["config.surroundingPairs"] when typing?

=== Step 3: Add Debug Logging
Temporarily add logging to:
+ #code["SurroundSelectionOperation._isSurroundSelectionType()"] — Log why surround is/isn't triggered
+ #code["CursorConfiguration"] constructor — Log #code["surroundingPairs"] value
+ #code["_onLanguageConfigurationChanged()"] — Log when language configs are registered

=== Step 4: Check Settings
Verify #code["editor.autoSurround"] is not set to #code["'never'"] in:
+ User settings (#code["~/.config/Crow/User/settings.json"])
+ Workspace settings (#code[".vscode/settings.json"])

== Proposed Solution

Based on the analysis, the feature should already work if:
1. Language configurations are being loaded from extensions
2. The #code["surroundingPairs"] are being registered
3. The #code["autoSurround"] option is not disabled

=== If Surround Is Not Working

#strong[Option A: Fix Extension Host Loading]
Ensure #code["_onLanguageConfigurationChanged()"] is called for all languages with proper #code["surroundingPairs"].

#strong[Option B: Add Fallback Pairs]
If language configurations aren't loading, add a default set of surrounding pairs in #code["CursorConfiguration"]:

```typescript
this.surroundingPairs = {};
const surroundingPairs = this.languageConfigurationService
  .getLanguageConfiguration(languageId)
  .getSurroundingPairs();
if (surroundingPairs && surroundingPairs.length > 0) {
  for (const pair of surroundingPairs) {
    this.surroundingPairs[pair.open] = pair.close;
  }
} else {
  // Fallback for languages without configuration
  this.surroundingPairs = {
    '(': ')',
    '[': ']',
    '{': '}',
    '"': '"',
    "'": "'",
    '`': '`',
    '<': '>',
  };
}
```

#strong[Option C: Fix Dedentation Conflict]
If the issue is with dedentation interfering, modify the order of operations in #code["typeWithInterceptors()"] to check surround BEFORE auto-indent, or add logic to detect when surround should take precedence.

=== If Surround Works But Has Issues

#strong[Issue: Dedentation Conflict]
When typing a closing bracket after selecting text, auto-indent may try to dedent. Solution:
+ In #code["SurroundSelectionOperation"], set a flag to skip auto-indent for this operation
+ Or, modify #code["AutoIndentOperation"] to check if surround is happening

#strong[Issue: Cursor Position Wrong]
If cursor doesn't end up between the brackets, fix #code["SurroundSelectionCommand.computeCursorState()"]

#strong[Issue: Undo/Redo Broken]
Ensure #code["shouldPushStackElementBefore"] and #code["shouldPushStackElementAfter"] are set correctly in the #code["EditOperationResult"]

== Testing Checklist

After implementing fixes:
1. Select word, type #code["("] → #code["(word)"]
2. Select word, type #code["\""] → #code["\"word\""]
3. Select word, type #code["<"] → #code["<word>"] (if in language config)
4. Select multiple words, type #code["{"] → #code["{multiple words}"]
5. Select whitespace only, type #code["("] → Should NOT surround (replaces)
6. Empty selection, type #code["("] → Should auto-close: #code["()"]
7. Select text with quotes, type #code["\""] → Should work
8. Undo after surround → Should undo both brackets
9. Redo after undo → Should redo both brackets
10. Test with different languages (TypeScript, Python, Rust, etc.)

== Files to Modify

If fixes are needed:
+ #code["src/vs/editor/common/cursor/cursorTypeEditOperations.ts"] — Surround logic
+ #code["src/vs/editor/common/cursor/cursorTypeOperations.ts"] — Operation order
+ #code["src/vs/editor/common/commands/surroundSelectionCommand.ts"] — Command implementation
+ #code["src/vs/editor/common/cursorCommon.ts"] — Fallback surrounding pairs
+ #code["src/vs/workbench/contrib/extensions/browser/tauriExtensionHost.contribution.ts"] — Language config loading

== Conclusion

The auto-surround feature is fully implemented in the VSCode core that sidex is built on. If it's not working, the issue is likely:
1. Language configurations not being loaded from extensions
2. A configuration option disabling it
3. A conflict with auto-indentation

The next step is to test the current behavior and add debug logging to identify which component is failing.
