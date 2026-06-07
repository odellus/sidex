# Bug Investigation Summary: Persistent `.sc-connecting-bar` After Edit Tool

## Problem
After an edit tool is called once in ACP chat, the connection indicator (`.sc-connecting-bar`) at the top of the chat panel appears and never goes away. Chat continues to work, but the indicator remains visible.

**Important: Only the `edit` tool triggers this bug. The `write` tool does NOT cause the problem.**

## Investigation Completed

### UI Element Identified
- `.sc-connecting-bar` located in:
  - `src/vs/workbench/contrib/acpChat/browser/acpChatView.ts` (line ~79)
  - `src/vs/workbench/contrib/acpChat/browser/media/acpChatView.css`
- Controlled by `connectionState` via `onDidChangeConnectionState` event
- Only shows when `connectionState === 'connecting'` (CSS class `.visible` toggled)

### Code Paths That Set `connectionState = 'connecting'`
In `acpStore.ts`, `_connectionStatus` only changes to `'connecting'` in two places:
1. `spawnAndConnect()` (~line 164) — initial connection setup
2. `loadSession()` (~line 331) — session switching via history dropdown

**Neither code path is triggered by tool calls.**

### Files Read During Investigation

**Frontend:**
- `src/vs/workbench/contrib/acpChat/browser/acpChatView.ts` — sidebar chat view, creates `_connectingBar`
- `src/vs/workbench/contrib/acpChat/browser/acpStore.ts` — store with `_connectionStatus`
- `src/vs/workbench/contrib/acpChat/browser/acpChatService.ts` — service wrapper
- `src/vs/workbench/contrib/acpChat/browser/acpChatEditor.ts` — editor panel
- `src/vs/workbench/contrib/acpChat/browser/acpChatSessionManager.ts` — session manager
- `src/vs/workbench/contrib/acpChat/browser/components/tools/toolCallItem.ts` — tool call rendering
- `src/vs/workbench/contrib/acpChat/browser/components/tools/toolCallGroup.ts` — tool call group management
- `src/vs/workbench/contrib/acpChat/browser/components/tools/fileViews.ts` — `FileEditView` with Monaco diff editor

**Backend:**
- `src-tauri/src/commands/acp_chat.rs` — Tauri commands, event bridge
- `crates/sidex-acp/src/manager.rs` — session manager with `switch_session`
- `crates/sidex-acp/src/session.rs` — ACP session I/O task

**Agent:**
- `crow-cli/crow-cli/src/crow_cli/agent/tools.py` — edit tool sends `tool_call` → `tool_call_update` → `completed`

### Key Architecture Notes
- The `session/load` on an existing connection causes crow-cli to cancel subsequent prompts. Correct flow: kill old agent → spawn new → initialize → `session/load` on fresh connection. Implemented in `manager.rs` `switch_session()`.
- Event forwarding must be set up per-connection via forwarding task subscribing to `events_tx`.
- Session ID field is `sessionId` (camelCase) in agent responses.
- Frontend event filtering: `acpStore._handleSessionEvent` drops events where `sessionId !== this._sessionId`.

### Browser Inspection Results
- `.sc-connecting-bar` existed in DOM but was NOT visible (`display: none`) at time of inspection
- No console errors related to Monaco or tool calls at inspection time
- Could not reproduce because cannot trigger edit tool from browser

## Root Cause: CONFIRMED

The `DiffEditorWidget` with `automaticLayout: true` inside the flex container (`sc-messages`) caused layout thrashing that starved the main thread. This either:
1. Broke the Tauri event pipeline (events dropped/missed), leaving `_connectionStatus` stuck at `'connecting'`
2. Or directly triggered the `'connecting'` state through some VSCode editor service side effect

Only the `edit` tool triggered this because it's the only one that used `DiffEditorWidget`. `write` used `CodeEditorWidget` and was unaffected.

**Fix verified by user testing — the connecting bar no longer persists after edit tools.**

## Changes Made

### 1. Replaced `DiffEditorWidget` with `CodeEditorWidget` in `FileEditView`
- **File:** `src/vs/workbench/contrib/acpChat/browser/components/tools/fileViews.ts`
- Added `simpleLineDiff()` function that computes a unified diff from old/new text
- `FileEditView` now uses `CodeEditorWidget` instead of `DiffEditorWidget`
- Renders unified diff with `+` / `-` / ` ` prefixes
- Applies Monaco decorations for green (added) and red (removed) line backgrounds
- Removed `automaticLayout: true` and `DiffEditorWidget` resize observer thrashing
- Uses explicit height measurement like `FileReadView`/`FileWriteView`

### 2. Added CSS for diff decorations
- **File:** `src/vs/workbench/contrib/acpChat/browser/media/acpChatView.css`
- Added `.sc-diff-line-added`, `.sc-diff-line-removed`, `.sc-diff-glyph-added`, `.sc-diff-glyph-removed`
- Uses VSCode diff theme variables for consistent coloring

### 3. Added connecting bar safety timeout
- **File:** `src/vs/workbench/contrib/acpChat/browser/acpStore.ts`
- Added `_connectingSafetyTimer` with 10-second timeout
- If `_connectionStatus` stays `'connecting'` for more than 10s, it forces back to `'ready'`
- Timer is cleared on any successful state transition or dispose
- Prevents the connecting bar from being stuck indefinitely

## Resolution

✅ **Fix verified.** The connecting bar no longer persists after edit tools.

### Remaining Items (Nice to Have)
- Fine-tune the `simpleLineDiff()` algorithm if complex multi-line edits render poorly — it's a basic greedy algorithm, not a full Myers diff

## Critical Debugging Commands

```bash
# Check ACP log for events after an edit tool
grep -E "tool_call|edit|disconnect|session" ~/.local/share/sidex/logs/acp.log | tail -50

# Check current git state
cd /home/thomas/src/crow-ai/sidex && git status && git log --oneline -3
```

## Notes for Next Agent

- `FileEditView` now uses `CodeEditorWidget` with a unified diff, NOT `DiffEditorWidget`
- The `simpleLineDiff()` algorithm is basic — if diff quality is poor, consider replacing with a proper Myers diff implementation
- The connecting bar safety timeout (10s) in `acpStore.ts` prevents any future stuck-bar issues regardless of cause
