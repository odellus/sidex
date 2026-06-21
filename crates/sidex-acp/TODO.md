# sidex-acp TODO

## 1. Prompt queue for `acp_chat_prompt` — ✅ DONE

The `prompt_busy` Mutex + `queue: Vec<QueueItem>` in `prompt_2.rs` serialize
all inbound prompts. Concurrent `prompt()` calls (user typing, `_send`
callbacks, `task_send`) push to the queue and return immediately. After the
current turn completes, the queue is drained FIFO. See the architecture wiki
(§5) for details.

## 2. Architecture wiki — ✅ DONE

Created at `sidex/docs/crow/sidex-acp-wiki.md`. Covers the ACP protocol layer,
session lifecycle, prompt implementation (v2), orchestration state machine,
tool routing, frontend contrib, Tauri command layer, markdown rendering,
performance fixes, test layout, and known issues.

## 3. `_send` refactor — ✅ DONE

`send_to_session` in `orchestration_2.rs` now always calls `caller.prompt()`
to deliver the worker's summary — no fork, no branching. The task loop breaks
(instead of blocking on `delegation_notify`) when `WaitingForResponse`, which
releases `prompt_busy` so the summary can be delivered through the queue.
`nag_evaluate()` no longer includes the summary (it's delivered separately
by `_send`). `reset_delegation()` moved to the frontend handler
(`acp_chat_prompt`) so user-initiated prompts reset delegation but `_send`'s
`caller.prompt()` preserves `Responding` state. See the architecture wiki
(§7) for the full flow.

## 4. Tool responses — ✅ AUDITED, NO CHANGES NEEDED

Every `match` arm in `route_tool_request` returns `Ok(json)` or `Err(String)`.
The `_ =>` catch-all returns `Err("unsupported method: ...")`. Async tools
(`_send`) return immediately with `{"status": "sent"}` and do work in
`tokio::spawn`. No tool silently drops a response.

## 5. Task list UI — 🔲 NOT STARTED

The task list is broadcast to the frontend as ACP `plan` session updates (via
`broadcast_task_list()` in `session.rs`). The frontend `acpStore` handles the
`plan` sessionUpdate type and pushes it to the notification log. There is no
dedicated UI component to render a task list with checkboxes, status badges,
assignment info, etc.

## 6. `list_sessions` tool — 🔲 NOT STARTED

Identified in `FUTURE.md` as the one real gap vs the spec. The tool should list
available connected sessions and expose what tooling each agent has, so the
orchestrator/instructor knows which agents can receive `_send` or `_task_send`.
Not implemented in `route_tool_request`.
