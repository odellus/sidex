= INSTRUCTIONS

+ when given a task, examine the code deeply and understand the intent of the current code. examine the code surrounding it as well to understand the constraints that the context the code lives in puts on it.
+ understand the problem through this new light of how the code works. understand why it is acting the way it does through mental modeling of the workflow of the code.
+ propose a solution to this in a typst file that will outline what it is you propose to change, highlight how this will not create regressions because you've carefully analyzed code for side effects.
+ execute on the solution you just documented using the approach above after taking one last look around to see if you missed anything. measure twice, cut once.
+ DO NOT rely only on logs to verify behavior. Always test end-to-end in the browser (localhost:1420). Check that the actual UI responds, not just that RPC calls succeed.
+ The user already has `npx tauri dev` running — don't ask them to start it. Rust auto-rebuilds in dev mode.
+ Be extremely careful with git operations. Never use `git revert`. Always `git diff` before destructive operations.

== RESOURCES
+ we will be working with a lot of ACP so always fetch https://agentclientprotocol.com/llms.txt to better understand ACP specs if the topic arises, and it will arise often
+ The crow-cli agent implementation lives in `research/crow-cli/crow-cli/src/crow_cli/agent/main.py` — study it when debugging agent-side behavior
+ ACP protocol log: `~/.local/share/sidex/logs/acp.log` (can be large, use grep/sed to search)

== ARCHITECTURE

=== ACP Chat Pipeline (end-to-end flow)

The chat feature is a 4-layer pipeline. Understanding how data flows through all 4 layers is essential for debugging.

```
Frontend (TypeScript)    →  Tauri Commands (Rust)  →  ACP Session (Rust)  →  Agent Process (Python/crow-cli)
acpStore.ts                 acp_chat.rs                 session.rs              main.py (crow-cli)
acpChatView.ts              (invoke/listen)             manager.rs
```

#strong[Event flow (agent → frontend):]
+ Agent writes JSON-RPC to stdout
+ `session.rs` I/O task reads lines, parses JSON-RPC, broadcasts via `events_tx: broadcast::Sender<SessionEvent>`
+ `manager.rs` forwarding task subscribes to `events_tx`, forwards to `global_events` (the Tauri bridge)
+ `acp_chat.rs` bridge task emits `acp:sessionUpdate` Tauri events
+ `acpStore.ts` `_handleSessionEvent` filters by `sessionId === this._sessionId`, dispatches to UI

#strong[Prompt flow (frontend → agent):]
+ `acpStore.ts` `sendMessage()` → `invoke('acp_chat_prompt', { sessionId, blocks })`
+ `acp_chat.rs` `acp_chat_prompt` → looks up session by `sessionId` → `session.prompt(blocks)`
+ `session.rs` `run_prompt()` → sends `session/prompt` JSON-RPC to agent stdin
+ Agent processes, streams `session/update` notifications back through the event flow

=== Key Files

#table(
  columns: (1fr, 2fr),
  [File], [Purpose],
  [`crates/sidex-acp/src/session.rs`], [AcpSession struct — owns agent connection, JSON-RPC over stdin/stdout, I/O task, event broadcast],
  [`crates/sidex-acp/src/manager.rs`], [AcpSessionManager — session lifecycle, connection pooling, event forwarding setup],
  [`crates/sidex-acp/src/agent.rs`], [AgentManager — spawns/kills agent subprocesses, stdin/stdout pumping],
  [`src-tauri/src/commands/acp_chat.rs`], [Tauri commands — bridge between frontend invoke() and Rust session layer],
  [`src/vs/workbench/contrib/acpChat/browser/acpStore.ts`], [Frontend store — manages chat state, event filtering, sendMessage/loadSession],
  [`src/vs/workbench/contrib/acpChat/browser/acpChatView.ts`], [Chat view — DOM rendering, connecting bar, event bindings],
  [`src/vs/workbench/contrib/acpChat/browser/components/toolbar/chatHeader.ts`], [History dropdown — session list, onSelectSession handler],
  [`src/vs/workbench/contrib/acpChat/browser/media/acpChatView.css`], [Chat CSS — connecting bar animation, message styles],
  [`research/crow-cli/crow-cli/src/crow_cli/agent/main.py`], [crow-cli ACP agent — load_session, prompt, cancel, react_loop],
)

=== Critical Patterns and Gotchas

#strong[Session switching must spawn a fresh agent process.]
`session/load` on an existing connection causes the crow-cli agent to immediately cancel subsequent prompts (`stopReason: "cancelled"` in 2ms). The correct flow is: kill old agent → spawn new → initialize → session/load on fresh connection. This is implemented in `manager.rs` `switch_session()`.

#strong[Event forwarding must be set up per-connection.]
Each `AcpSession` has its own `events_tx` broadcast channel. `bind_new_session`, `bind_load_session`, and `switch_session` all spawn a forwarding task that subscribes to `events_tx` and forwards to `global_events`. Without this, events never reach the frontend.

#strong[Session ID field mapping: `sessionId` not `id`.]
The ACP agent returns camelCase `sessionId` in responses. The frontend store must map `s.sessionId` not `s.id` when building the session list.

#strong[Frontend event filtering by sessionId.]
`acpStore._handleSessionEvent` drops events where `sessionId !== this._sessionId`. After a session switch, if the store's `_sessionId` doesn't match the events' `sessionId`, all events are silently dropped.

#strong[The `session_id_cell` is shared with the I/O task.]
`AcpSession.session_id_cell: Arc<Mutex<String>>` is cloned into the I/O task so it knows the current session ID for tagging events. This must be updated atomically during session operations.

=== Build and Dev Workflow

+ `npx tauri dev` — runs both Vite dev server (localhost:1420) and Rust backend with auto-rebuild
+ `cargo check -p sidex-acp` — quick check of the ACP crate
+ `cargo check` — full workspace check
+ Frontend TypeScript hot-reloads via Vite
+ Rust backend auto-rebuilds when Tauri detects changes
+ No need to restart anything after code changes in dev mode

=== The sidex/vscode Relationship

This codebase is a fork/derivative of VSCode's web workbench. The `src/vs/` directory contains heavily modified VSCode source. Key differences:
+ Uses Vite instead of VSCode's custom build system
+ Tauri provides the native shell (file system, terminal, process management)
+ The `contrib/acpChat/` directory is entirely custom (not from VSCode)
+ Extensions run in a web worker, same as VSCode web
+ `src/vs/sidex-bridge.ts` is the integration point where sidex features (Tauri commands, Rust backends) are wired into the VSCode workbench lifecycle

=== Frontend Architecture Notes

The frontend is NOT React/Vue — it's manual DOM manipulation using VSCode's patterns:
+ Views extend VSCode's `ViewPane` or similar base classes and build DOM in `renderBody()`
+ Components in `contrib/acpChat/browser/components/` are custom classes that create DOM elements directly (no JSX, no virtual DOM)
+ State management is in `acpStore.ts` which uses an event emitter pattern — views subscribe to store events
+ CSS lives in `contrib/acpChat/browser/media/acpChatView.css` and is loaded via VSCode's CSS loader
+ The Tauri webview is at `localhost:1420` — use the browser tools to inspect and test

=== Rust Crate Structure

The workspace has many crates. The most important ones for day-to-day work:
+ `sidex-acp` — ACP protocol client (agent sessions, JSON-RPC, event streaming)
+ `sidex-dap` — Debug Adapter Protocol (similar pattern to ACP but for debuggers)
+ `sidex-lsp` — Language Server Protocol client
+ `sidex-terminal` — Terminal emulation and PTY management
+ `sidex-workspace` — Workspace/project management
+ `sidex-git` — Git integration
+ `sidex-db` — SQLite database layer (session storage, etc.)
+ `sidex-auth` — Authentication (OAuth flows for AI providers)
+ The Tauri binary is in `src-tauri/` — commands are split into modules under `src-tauri/src/commands/`
+ Extension host (Node.js worker for VSCode extensions) lives in `src-tauri/extension-host/`

=== Debugging Strategies

#strong[When frontend doesn't respond to backend events:]
1. Check `acpStore._sessionId` matches the event's `sessionId` (open browser console, add breakpoints)
2. Check the event bridge is running — look for `acp:sessionUpdate` events in browser's Tauri event listener
3. Check the forwarding task is alive in `manager.rs` — if the `events_tx` subscription was dropped, events go nowhere

#strong[When agent returns unexpected results:]
1. Search `acp.log` for the specific method/session to see the raw JSON-RPC exchange
2. Check the crow-cli agent's `main.py` for how it handles that method
3. Remember: the agent process is a subprocess — check if it crashed or was killed unexpectedly

#strong[When Tauri commands fail:]
1. Check the browser console for the invoke() error
2. Check Rust stderr (Tauri dev shows it in the terminal running `npx tauri dev`)
3. Commands are async — make sure the frontend `.catch()` handles rejections

=== Common Pitfalls

+ Don't confuse `sidex` (the editor platform) with `Crow` (the AI product built on top). The Tauri app is named "Crow" but the codebase is "sidex".
+ The `dist/` directory contains pre-built frontend assets — don't edit files there, they get overwritten by Vite builds
+ VSCode's `nls` (national language support) wraps all user-facing strings — `localize('key', 'default')` pattern everywhere
+ `invoke()` calls from frontend to Rust are async and can fail — always handle the error case
+ The `acp.log` file grows fast (60MB+) — always use `grep`, `tail`, or `sed` with line ranges, never try to read the whole thing