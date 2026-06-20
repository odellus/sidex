# sidex-acp TODO

## 1. Prompt queue for `acp_chat_prompt` — ✅ DONE

**Problem:** No serialization. When `acp_chat_prompt` (Tauri command in
`src-tauri/src/commands/acp_chat.rs:331`) calls `session.prompt(blocks)`, that
goes straight to `run_prompt()` → `session/prompt` over stdin, blocking until
the agent responds. If a second `acp_chat_prompt` arrives mid-turn (e.g. user
types while agent is working, or a `_send` callback triggers a re-prompt), it
fires a second concurrent `session/prompt` request that races with the first.

**Fix:** A `Vec<QueueItem>` queue already exists on `AcpSession` (`session.queue`)
with `queue_add` / `queue_list` / `queue_clear` / `queue_remove` in
`prompt_2.rs`. But it is never drained — `prompt()` never checks it.

What to do:
- In `prompt()` (or the Tauri command), check `prompt_turn_state`. If `Running`,
  push to `queue` and return `Ok(())` immediately.
- After `run_prompt()` completes (in `prompt()` or at the end of
  `run_task_loop()`), drain the queue: pop the next `QueueItem`, send it as a
  new `session/prompt`, repeat until empty.
- This serializes all inbound prompts and makes `_send` re-prompts safe —
  orchestration just calls `session.prompt()` or `session.queue_add()` and the
  queue handles ordering.

Relevant files:
- `src/prompt_2.rs` — `prompt()`, `run_prompt()`, `run_task_loop()`, queue methods
- `src/session.rs` — `QueueItem` enum, `prompt_turn_state` field
- `src-tauri/src/commands/acp_chat.rs:331` — `acp_chat_prompt` Tauri command


## 2. Architecture wiki: `sidex/docs/crow/sidex-acp-wiki.md`

Create a complete document describing the current state of the sidex-acp crate
and the acpChat frontend contrib. This is a knowledge-transfer doc — a new
contributor (or AI agent) should be able to read it and understand the whole
system.

Should cover:
- **ACP protocol layer** — how JSON-RPC flows over stdin/stdout, the I/O task
  in `session.rs` (`handle_agent_line`), request/response/notification dispatch
- **Session lifecycle** — `AcpSession::spawn` → `initialize` → `new_session` /
  `load_session` → `prompt` → `cancel`. The `prompt_turn_state` state machine.
- **Prompt implementation** — v1 (`prompt.rs`) vs v2 (`prompt_2.rs`), why v2 is
  active (`prompt_impl.rs` re-export). The Ralph loop (`run_task_loop`).
- **Orchestration** — `OrchestrationState` (pure state machine in
  `orchestration_state.rs`), `DelegationState` cycle, the `_send` / `_task/*`
  tools in `tools/orchestration_2.rs`. How `task_send` auto-starts the loop.
  Concurrency guard (`task_loop_running: AtomicBool` + `TaskLoopGuard`).
- **Tool routing** — `tools/mod.rs` `route_tool_request`, the `ToolContext`
  struct, how agent-emitted tool requests are handled in `handle_agent_line`.
- **Frontend (acpChat contrib)** — the notification → view pipeline:
  `acpChatView.ts` / `acpChatEditor.ts` group components by `sessionUpdate`
  type, `AgentMessageGroup` / `ThinkingBlock` / `UserMessage` / `ToolCallGroup`
  render via `StreamingMarkdownRenderer`. Scroll manager, sentinel element.
- **Tauri command layer** — `src-tauri/src/commands/acp_chat.rs` maps frontend
  `invoke()` calls to `AcpSession` methods. `set_manager` is called here.
- **Markdown rendering** — `markdownRenderer.ts` (marked + highlight.js +
  mermaid + katex), `streamingMarkdown.ts` (frozen-block incremental render).
- **Known issues** — the items in this file.

Existing docs in `sidex/docs/crow/`:
- `inter-agent-communication.md` — _send design rationale
- `tripartite-agent-architecture.md` — instructor/orchestrator/worker roles
- `FUTURE.md` — roadmap notes


## 3. Refactor `orchestration_2.rs` `_send` to use the correct workflow — ✅ DONE

**Current (broken) approach in `orchestration_2.rs`:**
- `send_to_session` calls `target.run_prompt(blocks).await` directly — bypasses
  `prompt()` and the queue/task-loop machinery.
- After the worker responds, it calls `target.run_prompt(summary_blocks)` again
  for the summary.
- It captures the summary from the event stream (`event_rx.recv()` loop) and
  sets `OrchestrationState::set_responding(summary)` + `delegation_notify`.
- The Ralph loop in `prompt_2.rs` blocks on `delegation_notify` when in
  `WaitingForResponse`, wakes up, sees `Responding`, and re-prompts the agent.

**Why it was done this way:** To avoid the `_send` notification going back to
the frontend and having to handle it there (frontend → backend roundtrip). v2
keeps everything backend-to-backend via the Notify + OrchestrationState.

**Correct approach (v1 in `orchestration.rs`):**
- `send_to_session` calls `target_session.prompt(blocks).await` — goes through
  the proper `prompt()` → `run_prompt()` → `run_task_loop()` path.
- Sends the `_send` notification to the *caller* via `events_tx` as a
  `SessionEvent::Update` with `sessionUpdate: "_send"`.
- The caller's `DelegationState` is set to `Responding`.
- v1 uses `delegation_state` (the old `Mutex<DelegationState>` on the session);
  v2 moved this into `OrchestrationState`.

**The refactor:** Once the prompt queue (#1) is in place, `send_to_session` can
just call `session.prompt()` (which will queue if busy). The two-step flow
(prompt worker, re-prompt for summary) can call `session.prompt()` for each step
and the queue serializes them. The `_send` callback result goes back to the
caller via either:
  - (a) The current v2 approach: `OrchestrationState::set_responding()` +
    `delegation_notify.notify_one()` (backend-only, no frontend roundtrip), or
  - (b) The v1 approach: send `_send` notification to the caller agent as an
    extension notification, which the agent sees as a new user message.
Option (a) is cleaner now that the Ralph loop exists — keep it.

Relevant files:
- `src/tools/orchestration_2.rs` — current (active) `_send` implementation
- `src/tools/orchestration.rs` — v1 (correct flow, but not compiled)
- `src/prompt_2.rs` — `run_prompt`, `run_task_loop`, queue methods
- `src/session.rs` — `AcpSession`, `DelegationState`, `prompt_turn_state`


## 4. Tool responses — return immediately even for async tools — ✅ AUDITED, NO CHANGES NEEDED

**Problem:** Tool handlers that spawn async work (like `_send`) return a result
to the agent, but some tool paths may not return anything or may block. Per ACP
spec, every agent request (`session/request`) MUST get a JSON-RPC response with
a `result` or `error`. The agent is waiting for this response before it can
continue its turn.

**Current state in `route_tool_request` (`tools/mod.rs`):**
- `_send` → `orchestration_2::send_to_session` — returns `{"status": "sent"}`
  immediately, which is correct. The async work is in `tokio::spawn`.
- `_task/read`, `_task/write`, `_task/send` — return JSON results. OK.
- But any tool that panics or hits an unexpected code path returns nothing,
  and the agent hangs forever waiting for the response.

**Fix:**
- Ensure every `match` arm in `route_tool_request` returns `Ok(json!({ ... }))`
  or `Err(...)`. Never `()` or early return without a result.
- For async tools: the pattern in `send_to_session` is correct — return
  `{"status": "sent"}` immediately, do the work in `tokio::spawn`. Apply this
  pattern everywhere.
- Consider wrapping `route_tool_request` in a catch-all that always returns
  `Err("unhandled")` instead of silently dropping (there's already a `_ =>`
  arm, but make sure spawned tasks inside tools can't swallow errors).
- Filesystem and terminal tools in `tools/filesystem.rs` and `tools/terminal.rs`
  should be audited to confirm they all return results on every path.

Relevant files:
- `src/tools/mod.rs` — `route_tool_request` dispatch
- `src/tools/orchestration_2.rs` — async tool pattern
- `src/tools/filesystem.rs`, `src/tools/terminal.rs` — audit all return paths
- `src/session.rs` `handle_agent_line` — where the response is sent back to the
  agent (the `tokio::spawn` block that calls `route_tool_request` and sends
  the JSON-RPC response via `stdin_tx`)
