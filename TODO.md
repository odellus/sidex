# TO DO

## ACP Chat specific

- [x] Returning to a previously viewed chat tab should scroll to the very bottom
- [x] Returning to a previously viewed tab shows all editors still populated — per-session DOM swap in `acpChatEditor.ts` (`_sessionViews` map)
- [x] Switching away from a chat tab should not stop streaming — backend events must continue flowing and be visible when you return
- [x] Messages sent to chat do not appear fully rendered, you only see the top of them and focus only moves to bottom as text streams in. focus needs to be on the bottom of the message that was sent
- [x] Syntax highlighting during streaming — frozen-block strategy in `streamingMarkdown.ts` uses highlight.js (not Monaco). See wiki §11–12.
- [x] Cancellation kills running terminals — `cancel_prompt()` in `prompt_2.rs` kills all `active_terminals` + sends `session/cancel`
- [ ] **Log rotation.** Move log path from `~/.local/share/sidex/` to `~/.local/share/crow/acp.log`. Add rotation so it doesn't grow unbounded (currently 500MB+). See `session.rs::FileLogger`.
- [ ] Per-terminal cancel button — cancel just the terminal command, not the whole react loop

### Rich Text Editor

- [ ] Enable scroll wheel in rich text editor
- [ ] Highlighting context and adding to rich text editor — most crucial item

### Tools

- [x] Add diff fixtures for edit and write
- [x] Add terminal fixture — xterm.js real terminal
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
  - [x] Editor/view for the normal prompt queue
  - [ ] Editor/view for the task/todo list (instructor/orchestrator/worker iterate over)

- [x] **DO NOT SHOW `...` WHEN COMMAND OVERRUNS — SHOW THE WHOLE THING**

## IDE specific

- [x] Rebrand to Crow with crow logo
- [x] Add scroll to terminal
- [x] Autosurround: highlighting text + adding quotes/parens surrounds instead of replacing
- [x] GitHub workflow for release builds
- [x] `crow-cli install desktop` flag
- [ ] Dirty indicator — when file differs from disk (agent edits, other editors). Use in `read_file` tool.
- [ ] ATProto PDS based auth
- [x] Add `` ` `` to typst LSP autoclose/autosurround characters
- [ ] Make preview robust to editor size changes (CSS). Current resizing violates VS Code component constraints.
- [ ] Keep editors in sync with backend — agent edits, other editors, anything. Add dirty indicator when there's a difference.
- [ ] Fix issue with remote explorer not connecting via SSH
  ```
  state not managed for field `store` on command `remote_connect_ssh`. You must call `.manage()` before using this command
  ```
- [x]  editor is slowing down as long contexts in the editor pane acpChat grow, which is precisely what we do NOT want
- [x] Cannot paste directly into terminal from outside editor, can paste from outside editor into rich text editor of chat or monaco editor component, cut from there, and then paste into xterm.js terminal
- [x] everything is slowing down BADLY. It's so bad. Like holy shit this isn't useable it is slowing down so badly. 


## CROW-CLI SPECIFIC CHANGES

- [ ] Make modifying crow-cli and crow-mcp the core use case of this IDE?
- [x] Add `last-content` method to query_memory for inter-agent communication to replace summarization prompt
- [ ] Add tool for listing active sessions

## BUGS

So it's not slow when we're not streaming anything. Memory use goes back up but streaming is fighting the editor and everything. we need to look at this much more carefully.

So I'm going to be typing in a new window while these two agents go to town. And this seems to be sustainable. They're both streaming in and I am not seeing any slowdown yet. It only really happens after a long time though, but the key issue is that they're not causing any problems and as far as  I can see they both work exactly the same as before right? it's just a matter of virtualizing the DOM so we don't see the whole huge conversation just part of it

The conversations are growing and both of them are going and I can still type quickly into the editor. This is really really big win.


Yeah this is working flawlessly. I hardly EVER go back up I mean sometimes I do but the editor needs to be responsive that's like the highest priority. Eventually I am going to want to bring the chat into a monaco editor or something probably. I mean I should be editing here and then copying and pasting into the chat. I need the button that adds selected text 


So is it still slowing things down? I mean I guess sort of kinda? looks and feels like it might be tbh. It's not nearly as bad as before though.

Might want to shorted the size of the DOM a bit? I just checked. It's totally doing what I wanted.

It's just laggy and shitty. Motherfucker. I feel like we need to fork zed next and work inside of there. Just put a chat agent from zed inside the window. add that stuff in there. Because I don't know what else to do. I think it might have to do with the fact that the chat has so many different types of 

I closed the chat in the editor window and am using the chat in secondary side bar now to see if that's why the whole thing is slowing down.