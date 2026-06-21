# TO DO

## ACP Chat specific

- [ ] Returning to a previously viewed chat tab should scroll to the very bottom
- [x] Returning to a previously viewed tab shows all editors still populated — per-session DOM swap in `acpChatEditor.ts` (`_sessionViews` map)
- [ ] Switching away from a chat tab should not stop streaming — backend events must continue flowing and be visible when you return
- [ ] **Log rotation.** Move log path from `~/.local/share/sidex/` to `~/.local/share/crow/acp.log`. Add rotation so it doesn't grow unbounded (currently 500MB+). See `session.rs::FileLogger`.
- [x] Syntax highlighting during streaming — frozen-block strategy in `streamingMarkdown.ts` uses highlight.js (not Monaco). See wiki §11–12.
- [x] Cancellation kills running terminals — `cancel_prompt()` in `prompt_2.rs` kills all `active_terminals` + sends `session/cancel`
- [ ] Per-terminal cancel button — cancel just the terminal command, not the whole react loop
- [ ] Messages sent to chat do not appear fully rendered, you only see the top of them and focus only moves to bottom as text streams in. focus needs to be on the bottom of the message that was sent

### Rich Text Editor

- [ ] Enable scroll wheel in rich text editor
- [ ] Highlighting context and adding to rich text editor — most crucial item
### Tools

- [x] ~~Add diff fixtures for edit and write~~
- [x] ~~Add terminal fixture — xterm.js real terminal~~
- [x] Orchestration tools implemented in `tools/orchestration_2.rs`:
  - [x] `_send` — async two-step delegation (prompt worker → summarize → deliver summary to caller). See wiki §7.
  - [x] `_task/read` — read the session's task list
  - [x] `_task/write` — create/update/delete tasks (CRUD)
  - [x] `_task/send` — instructor → orchestrator task batch + auto-start loop
- [ ] `list_sessions` — list active sessions + expose each agent's tooling. **Not yet implemented.** See `TODO.md` item #6 in the crate.
- [ ] Fixtures for orchestration tools + integrate into crow-cli's MCP schema
- [ ] ACP agent configuration and debugging view
- [ ] MCP server configuration and debugging view
- [ ] Prompt editor configuration (part of contrib, not an extension)
- [ ] Make "everything" configurable in settings.json
- [ ] Queue/task list viewer:
  - [ ] Editor/view for the normal prompt queue
  - [ ] Editor/view for the task/todo list (instructor/orchestrator/worker iterate over)

- [x] **DO NOT SHOW `...` WHEN COMMAND OVERRUNS — SHOW THE WHOLE THING**

## IDE specific

- [x] ~~Rebrand to Crow with crow logo~~
- [x] ~~Add scroll to terminal~~
- [x] ~~Autosurround: highlighting text + adding quotes/parens surrounds instead of replacing~~
- [x] ~~GitHub workflow for release builds~~
- [x] ~~`crow-cli install desktop` flag~~
- [ ] Dirty indicator — when file differs from disk (agent edits, other editors). Use in `read_file` tool.
- [ ] ATProto PDS based auth
- [x] ~~Add `` ` `` to typst LSP autoclose/autosurround characters~~
- [ ] Make preview robust to editor size changes (CSS). Current resizing violates VS Code component constraints.
- [ ] Keep editors in sync with backend — agent edits, other editors, anything. Add dirty indicator when there's a difference.
- [ ] Fix issue with remote explorer not connecting via SSH
  ```
  state not managed for field `store` on command `remote_connect_ssh`. You must call `.manage()` before using this command
  ```

## CROW-CLI SPECIFIC CHANGES

- [ ] Make modifying crow-cli and crow-mcp the core use case of this IDE?
- [ ] Add `last-content` method to query_memory for inter-agent communication to replace summarization prompt

## BUGS
