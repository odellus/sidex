# Compaction Message — ACP Terminal Display Session

## What Was Attempted

Display real xterm.js terminal output inside chat bubbles when the agent runs terminal commands via ACP `terminal/create`. The goal: each command execution shows a live terminal widget in the chat, streaming output from the backend PTY.

## The Approach Taken

1. **Backend**: Added `output_buffer` to `SessionTerminal`, fixed drain loop to be sole PTY reader (accumulate output, emit `acp-terminal-data` / `acp-terminal-exit` Tauri events), fixed `terminal/output` handler to read from buffer instead of racing with drain loop, added `acp_terminal_output` command for frontend polling.

2. **Frontend**: Rewrote `InlineTerminal` to take a `terminalId` (from content blocks) instead of spawning its own PTY. Listens to `acp-terminal-data` events + polls `acp_terminal_output`.

3. **Data flow**: Agent calls `terminal/create` → backend spawns PTY → returns `term_N` → `tool_call_update` sends `{ type: "terminal", terminalId: "term_N" }` → frontend creates `InlineTerminal` for that ID.

## Why It Was Wrong

The code compiles, builds, and the first terminal works. But **only the first terminal ever shows**. Every subsequent terminal call produces nothing in the chat.

## What Was Tried With Zero Success

Removed `active_terminals.clear()` from `run_prompt()` — suspected terminals were being killed before frontend could read them. This changed nothing. The problem was never premature cleanup.

## The Real Problem (User's Intuition)

The user believes this is an **event mapping problem** between backend terminal IDs and frontend xterm.js instances. Their hypothesis:

> "It's just not mapping from the backend terminal id to the frontend xterm.js identity properly because of the way it's set up. The event to be passed in the code — I think it's only good for a single event but I also don't know much about rust or tauri, but I mean you pass in an event handler and then something doesn't work past first event well god dammit I think it's a problem with the event handler."

**Likely root cause**: The `terminal_events_tx: broadcast::Sender` is created **once per session** and shared across ALL terminals. Every terminal's drain loop pushes events to this same channel. The Tauri bridge subscribes once and forwards all events to the frontend. The frontend `InlineTerminal` instances each `listen()` for `acp-terminal-data` and filter by their own `terminalId`.

The problem is almost certainly in how the **Tauri event listener** in the browser handles multiple subscriptions, or how the `listen()` calls in each `InlineTerminal` constructor interact. Each new `InlineTerminal` calls `listen('acp-terminal-data', ...)` — if the Tauri event system only fires the first registered handler, or if something about the listener lifecycle is breaking on subsequent calls, that would explain "first terminal works, rest don't."

**Another possibility**: The `tool_call_update` content block with `terminalId` is only being delivered to the first `ToolCallItem`, and subsequent terminal updates are being lost somewhere in the notification pipeline between `acpStore` → `ToolCallGroup` → `ToolCallItem` → `appendContentBlock`.

## Status

**Completely broken**. First terminal works. Zero subsequent terminals. No output visible. User is extremely frustrated. The event pipeline needs debugging end-to-end: verify Tauri events are actually emitted for terminal 2+, verify frontend receives them, verify `InlineTerminal` is actually created for terminal 2+.
