# sidex-acp Architecture

A knowledge-transfer document for the `sidex-acp` Rust crate and the `acpChat`
frontend contrib. After reading this, you should understand the full path from
a user typing in the chat input to an agent executing tools and streaming a
response back.

## Table of Contents

1. [System Overview](#1-system-overview)
2. [The Agent: crow-cli](#2-the-agent-crow-cli)
3. [ACP Protocol Layer](#3-acp-protocol-layer)
4. [Agent Process Management](#4-agent-process-management)
5. [Session Lifecycle](#5-session-lifecycle)
6. [Prompt Implementation (v2)](#6-prompt-implementation-v2)
7. [Orchestration: OrchestrationState](#7-orchestration-orchestrationstate)
8. [Orchestration Tools: \_send / \_task/*](#8-orchestration-tools-send--task)
9. [Tool Routing](#9-tool-routing)
10. [Tauri Command Layer](#10-tauri-command-layer)
11. [Frontend: acpChat Contrib](#11-frontend-acpchat-contrib)
12. [Markdown Rendering](#12-markdown-rendering)
13. [Performance: Streaming + Typing](#13-performance-streaming--typing)
14. [Test Layout](#14-test-layout)
15. [Known Issues and Missing Features](#15-known-issues-and-missing-features)

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (TypeScript / VS Code contrib)                │
│                                                         │
│  AcpChatViewPane ←→ AcpChatService ←→ AcpStore          │
│       ↕ Tauri invoke()        ↕ Tauri listen()           │
├─────────────────────────────────────────────────────────┤
│  Tauri Command Layer (Rust)                             │
│                                                         │
│  acp_chat.rs — maps invoke() → AcpSessionManager        │
│       ↕                                                 │
├─────────────────────────────────────────────────────────┤
│  sidex-acp Crate (Rust)                                 │
│                                                         │
│  AcpSessionManager → AcpSession ←→ AgentManager         │
│       ↕                          ↕ stdin/stdout         │
│  OrchestrationState          ┌──────────────┐            │
│  ToolContext                 │  crow-cli    │            │
│  route_tool_request          │  (agent)     │            │
│                              └──────────────┘            │
└─────────────────────────────────────────────────────────┘
```

**Three layers, three responsibilities:**

| Layer | Owns | Doesn't know about |
|-------|------|--------------------|
| **Frontend** | DOM, rendering, user input, notification log | Agent process, orchestration logic, tool dispatch |
| **Tauri commands** | invoke() ↔ AcpSession mapping, event bridge | Rendering, orchestration internals |
| **sidex-acp** | Agent processes, ACP protocol, sessions, orchestration, tools | DOM, Tauri, rendering |

The frontend is a **passive viewer**. It receives `acp:sessionUpdate` Tauri
events and renders them. All state (prompt lifecycle, task list, delegation)
lives in the Rust backend. The frontend never sends raw JSON-RPC to the agent.

---

## 2. The Agent: crow-cli

`sidex-acp` is agent-agnostic — it speaks ACP to any compliant agent process.
The reference agent is **crow-cli**, a minimal native ACP agent written in
pure Python with zero framework abstractions. This section describes what
crow-cli is and how it fits into the sidex-acp stack. For the layered
architecture diagram, see [§1 System Overview](#1-system-overview).

### What crow-cli Is

crow-cli is a reference implementation of the Agent Client Protocol. The
design philosophy is transparency: no LangChain, no CrewAI — just four
packages you can read end-to-end.

| Dependency | Role |
|------------|------|
| `openai` | LLM calls via OpenAI-compatible API (streaming, exponential backoff retries) |
| `acp` | Agent Client Protocol compliance — the `initialize` / `new_session` / `load_session` / `prompt` / `cancel` / `cleanup` interface |
| `fastmcp` | MCP tool client — connects to crow-mcp (and other MCP servers) for tool dispatch |
| `sqlalchemy` | Session and message persistence (SQLite, one row per message) |

crow-cli implements the full ACP Agent interface. On `new_session` it renders
a Jinja2 system prompt, reads `AGENTS.md` from the workspace, builds a
directory tree, and creates an MCP client connection to its toolserver.
Sessions use `coolname` for memorable IDs (e.g. `brave-purple-tiger-a3f2c1`).

The ReAct loop runs up to 50,000 turns, streaming LLM responses back to the
client. When token usage exceeds ~120k, a compaction step asks the LLM to
summarize the conversation middle, creates a new session with
`[first_user_msg, summary, last_user_msg...]`, and atomically swaps the
session ID in the database.

### Two-Layer Architecture

Crow is a two-layer system: an agent that does the thinking and a toolserver
that does the doing.

```
User → sidex-acp (ACP client) → crow-cli (agent brain)
                                   ↓ ReAct loop ↔ LLM (OpenAI-compatible API)
                                   ↓ Tool dispatch
                                 crow-mcp (MCP toolserver)
                                   ├── terminal (PTY)
                                   ├── read / write / edit
                                   ├── web_search (SearXNG)
                                   ├── web_fetch (readabilipy)
                                   ├── query_memory (SQLite)
                                   └── vision (webcam / image files)
```

| Component | Role |
|-----------|------|
| **crow-cli** | The agent brain: ACP protocol implementation, ReAct reasoning loop, session management, context compaction, streaming responses. Detects client capabilities — if the ACP client supports terminals, it uses client-side terminals; otherwise falls back to MCP terminals. |
| **crow-mcp** | The toolserver: a FastMCP server exposing tools for file operations, terminal execution, web access, memory queries, and vision. Runs as a separate process; crow-cli connects to it as an MCP client. |

### crow-mcp Tools

crow-mcp registers tools via `@mcp.tool` decorators in separate modules under
`crow_mcp/`. Each module is imported by `server/main.py` to register with the
shared `FastMCP` instance. The table below lists every registered tool.

| Tool | Module | What it does |
|------|--------|-------------|
| `terminal` | `terminal/` | PTY-backed bash session with custom PS1 (exit code, cwd metadata), supports C-c/C-z/C-d, stdin input, soft timeout (30s no output) and hard timeout |
| `read` | `read/` | Reads files with line numbers, binary detection, 10MB limit, pagination via offset/limit |
| `write` | `write/` | File writer with auto `mkdir -p` |
| `edit` | `editor/` | String replacement with 9 cascading fuzzy matchers: exact → line-trimmed → block-anchor (Levenshtein) → whitespace-normalized → indentation-flexible → escape-normalized → trimmed-boundary → context-aware → multi-occurrence |
| `web_search` | `web_search/` | Queries a local SearXNG instance (self-hosted via Docker Compose, no API keys needed), returns structured results |
| `web_fetch` | `web_fetch/` | Fetches URLs, uses readabilipy + markdownify to extract clean markdown from HTML, supports pagination |
| `query_memory` | `memory/` | Queries the crow SQLite database (`~/.crow/crow.db`) for past agent conversation history. Progressive disclosure: discovery mode (search all sessions), browse mode (list messages in a session), deep dive (search within a session with context window) |
| `capture_webcam` | `vision/` | Captures a single frame from a webcam device via OpenCV, returns a JPEG `Image` |
| `read_image_file` | `vision/` | Reads an image file (jpg, png, bmp) from disk and returns it for vision analysis |

The terminal backend uses a background `threading.Thread` that continuously
reads from the PTY master fd via `select()`, with a `deque` buffer and proper
signal handling (SIGINT to process group, SIGTERM→SIGKILL cleanup).

### Integration with sidex-acp

From sidex-acp's perspective, crow-cli is just another ACP agent process. The
integration points are:

1. **Agent spawning** — `AgentManager.spawn()` (see [§4 Agent Process
   Management](#4-agent-process-management)) starts the crow-cli subprocess
   using the `command` / `args` / `env` declared in SideX settings
   (`acp.agents`). crow-cli's own `--config-file` determines which MCP
   servers (including crow-mcp) it connects to — sidex-acp does not inject
   tool configuration.

2. **ACP protocol** — sidex-acp sends `initialize`, `session/new`,
   `session/prompt`, etc. over the subprocess's stdin/stdout (see [§3 ACP
   Protocol Layer](#3-acp-protocol-layer)). crow-cli responds and streams
   `session/update` notifications back.

3. **Tool dispatch** — When crow-cli's ReAct loop decides to call a tool, it
   sends a JSON-RPC request. For standard ACP tools (`fs/readTextFile`,
   `terminal/create`), sidex-acp's `route_tool_request` handles them
   client-side (see [§9 Tool Routing](#9-tool-routing)). For MCP tools
   (`edit`, `web_search`, `query_memory`, etc.), crow-cli calls its own MCP
   client — these never pass through sidex-acp.

4. **Session management** — sidex-acp creates and tracks `AcpSession`
   objects (see [§5 Session Lifecycle](#5-session-lifecycle)). crow-cli's
   internal SQLAlchemy sessions are independent — sidex-acp doesn't know
   about crow-cli's database. The two layers are decoupled: sidex-acp
   manages the process lifecycle and ACP wire protocol; crow-cli manages its
   own LLM calls, ReAct loop, and MCP tool connections.

5. **Frontend** — The frontend always sends `mcp_servers: []` to
   `session/new` and `session/prompt`. Per-agent tool configuration is
   crow-cli's own concern (via its `--config-file`), not injected by the
   frontend or sidex-acp.

---

## 3. ACP Protocol Layer

ACP (Agent Client Protocol) is JSON-RPC 2.0 over the agent process's
stdin/stdout. The backend is the **client**, the agent is the **server**.

### Message types

1. **Requests** (have `id` + `method` + `params`) — backend sends to agent:
   `initialize`, `session/new`, `session/load`, `session/prompt`,
   `session/list`, `session/set_config_option`
2. **Responses** (have `id` + `result` or `error`) — agent sends back to
   match a pending request
3. **Notifications** (have `method` + `params`, no `id`) — agent sends
   unsolicited: `session/update` (the primary content stream)
4. **Agent requests** (have `id` + `method`) — agent asks the **client**
   to execute a tool: `fs/readTextFile`, `terminal/create`, `_send`, etc.

### I/O dispatch: `handle_agent_line`

Every line from agent stdout is parsed in `session.rs::handle_agent_line`.
The dispatch tries three things in order:

```
parse line
  │
  ├─ 1. JSON-RPC Response? (has id + result/error)
  │     → match to pending_requests[id], send via oneshot channel
  │
  ├─ 2. JSON-RPC Request from agent? (has id + method)
  │     → spawn route_tool_request(method, params, ctx)
  │     → send JSON-RPC response back to agent stdin
  │
  └─ 3. JSON-RPC Notification from agent? (has method, no id)
        → if SessionNotification: broadcast SessionEvent::Update
        → else: log warning
```

### Request/response matching

Each outbound request gets a monotonically increasing `id` (via
`AtomicU64`). The `request_envelope` / `request_no_timeout` methods insert a
`oneshot::Sender` into `pending_requests` keyed by id, send the line, and
await the receiver. When `handle_agent_line` sees a response with that id, it
completes the oneshot.

- `request()` — 30s timeout (for initialize, session/new, etc.)
- `request_no_timeout()` — no timeout (for session/prompt, which can take
  minutes)

### Logging

All ACP traffic is logged to `~/.local/share/sidex/logs/acp.log` via the
`acp_log!` macro. **Never** log to stdout/stderr — that's the JSON-RPC
transport. The log file grows unbounded (no rotation yet).

---

## 4. Agent Process Management

`agent.rs` owns the subprocess lifecycle.

### AgentManager

- `spawn(config, cwd)` — spawns the agent process, returns an `agent_id`
- Captures the user's **shell environment** (PATH from .bashrc/.zshrc) on
  first spawn so fnm/nvm/uv paths are present even when the parent (Tauri/
  Electron) inherited a broken PATH
- Avoids interactive bash (`-i`) which hangs in headless contexts; uses
  `-lc` + explicit `source ~/.bashrc`
- `kill(agent_id)` — terminates the process
- Each agent gets a per-agent `broadcast::Sender<String>` for raw stdout
  lines, so sessions don't cross-read

### AgentConfig

Declared in SideX user settings (`acp.agents` in `settings.json`). Each entry
is a declarative spawn list: `name`, `command`, `args`, `env`. No tool or
role logic — the agent's own config file (e.g. crow-cli's `--config-file`)
determines which MCP tools it gets.

---

## 5. Session Lifecycle

```
AgentManager.spawn(config, cwd)
    │
    ▼
AcpSession::spawn()          ← creates session struct, starts I/O task
    │
    ▼
session.initialize()         ← ACP initialize handshake
    │                         (protocol version, client capabilities)
    ▼
session.new_session(cwd)    ← ACP session/new (fresh session)
    │                       OR
    │  session.load_session(id, cwd)  ← ACP session/load (resume)
    │
    ▼
session.prompt(blocks)       ← send user message, await response
    │
    ▼
session.cancel()             ← kill active turn (session/cancel)
    │
    ▼
manager.close_session(id)    ← kill agent process, remove from map
```

### AcpSession struct

Key fields:

| Field | Type | Purpose |
|-------|------|---------|
| `session_id` | `parking_lot::Mutex<String>` | ACP session ID (empty until new/load) |
| `stdin_tx` | `mpsc::Sender<String>` | Channel to agent stdin |
| `pending_requests` | `Mutex<HashMap<id, oneshot>>` | Pending request/response matching |
| `events_tx` | `broadcast::Sender<SessionEvent>` | Session updates → frontends |
| `prompt_turn_state` | `Arc<Mutex<PromptTurnState>>` | Idle / Running / Complete / Cancelled / Error |
| `active_terminals` | `Arc<Mutex<HashMap>>` | PTYs created this turn |
| `orchestration` | `Arc<Mutex<OrchestrationState>>` | Task list + delegation state machine |
| `delegation_notify` | `Arc<Notify>` | Wake signal for task loop |
| `task_loop_running` | `Arc<AtomicBool>` | Concurrency guard for task loop |
| `queue` | `Arc<Mutex<Vec<QueueItem>>>` | Serialized prompt queue |
| `prompt_busy` | `Arc<Mutex<bool>>` | Serialization guard for `prompt()` |
| `manager_cell` | `Mutex<Option<Arc<Manager>>>` | Reference to session manager (for cross-session tools) |

### PromptTurnState

```
Idle ──prompt()──► Running ──agent responds──► Complete { stop_reason }
                      │                           │
                      │──cancel()──► Cancelled    │
                      │                           │
                      └──error───► Error { msg }  │
                                                   │
Idle ◄─────────────────────────────────────────────┘
```

Broadcast to frontend as synthetic `session/update` events:
- `prompt_state` with `status: "running"` / `"idle"`
- `prompt_complete` with `stopReason`

### AcpSessionManager

Holds two maps:
- `sessions: HashMap<session_id, Arc<AcpSession>>` — bound sessions
- `connections: HashMap<connection_id, Arc<AcpSession>>` — initialized but
  unbound (post-initialize, pre-session/new)

`set_manager()` is called by the Tauri command layer after session creation.
If skipped, every orchestration tool request (`_send`, `_task/*`) silently
errors with "manager not available" — the agent can't reach other sessions.

---

## 6. Prompt Implementation (v2)

Two implementations exist (`prompt.rs` v1, `prompt_2.rs` v2). The active one
is selected in `lib.rs` → `prompt_impl.rs`. **v2 is active.**

### `prompt()` — the serialized entry point

```rust
pub async fn prompt(session: &Arc<AcpSession>, blocks: Vec<Value>) -> Result<()> {
    // 1. Acquire prompt_busy lock. If busy → queue and return Ok.
    // 2. run_prompt(blocks) — sends session/prompt, awaits response
    // 3. If has_active_task_loop() → run_task_loop()
    // 4. Drain queue: each item → run_prompt + maybe run_task_loop
    // 5. Release prompt_busy
}
```

**The prompt queue is critical.** Concurrent calls to `prompt()` (user
typing while agent works, `_send` callback arriving, `task_send` starting a
loop) must never send two `session/prompt` requests over stdin
simultaneously. The `prompt_busy` Mutex serializes them: if busy, the blocks
are pushed to `queue` and the call returns immediately. After the current
turn completes, the queue is drained FIFO.

### `run_prompt()` — single turn

Sends exactly one `session/prompt` request, sets `PromptTurnState::Running`,
awaits the response (no timeout — agent can take minutes), broadcasts
completion. Does **not** check task state or loop.

### `run_task_loop()` — the orchestration loop

```rust
pub async fn run_task_loop(&self) -> Result<()> {
    // Guard: at most one loop per session (task_loop_running AtomicBool)
    loop {
        if is_cancelled() → break
        let decision = orchestration.determine_next_prompt();
        match decision {
            Some(blocks) → run_prompt(blocks)
            None → break  // WaitingForResponse or all done
        }
    }
}
```

**Key design decision:** when `determine_next_prompt()` returns `None` (which
happens when `WaitingForResponse`), the loop **breaks** instead of blocking
on `delegation_notify`. This releases `prompt_busy` so the `_send` callback's
`caller.prompt()` can deliver the worker's summary through the queue. That
new `prompt()` call re-enters `run_task_loop` with `Responding` state, which
sends a nag (without the summary — the summary was already delivered by
`_send`).

If the loop blocked on `Notify` instead, `prompt_busy` would still be held,
and `caller.prompt()` would queue the summary. When the loop woke up, it
would call `nag_evaluate(summary)` which embedded the summary, then drain the
queue which sends the summary again — double-send.

### `reset_delegation()`

Called by the **frontend handler** (`acp_chat_prompt` Tauri command), not by
`prompt()` itself. This means:
- User-initiated prompts reset delegation to `NotCalled` (new turn)
- `_send`'s `caller.prompt()` preserves `Responding` state (the summary is
  a continuation, not a new turn)

If `reset_delegation()` were inside `prompt()`, every `caller.prompt()` call
would wipe the `Responding` state and the task loop would behave as if the
agent had never delegated.

### `has_active_task_loop()`

Returns true if:
- There's a current task (`current_task.is_some()`), OR
- There are pending or in-progress tasks in the list, OR
- The task list is non-empty and hasn't been summarized yet

This gates whether `run_task_loop()` runs after a prompt.

---

## 7. Orchestration: OrchestrationState

`orchestration_state.rs` — a **pure state machine** with no I/O. Fully
unit-testable. The single entry point is `determine_next_prompt()`.

### Fields

| Field | Purpose |
|-------|---------|
| `task_list` | `Vec<Task>` — the plan/TODO, single source of truth |
| `current_task` | `Option<Task>` — promoted from task_list, being worked on |
| `delegation_state` | `DelegationState` — `NotCalled` / `WaitingForResponse` / `Responding` |
| `delegation_summary` | `Option<String>` — stashed worker summary |
| `summarized` | `bool` — guard against infinite summary loop |

### DelegationState cycle

```
                    ┌─────────────┐
          ┌────────►│  NotCalled   │◄─────────────┐
          │         └──────┬───────┘              │
          │                │ agent delegates      │
          │                │ via _send             │ new prompt arrives
          │                ▼                      │ (reset_delegation)
          │         ┌──────────────┐               │
          │         │WaitingForResp│               │
          │         └──────┬───────┘               │
          │                │ _send callback        │
          │                │ sets Responding       │
          │                ▼                       │
          │         ┌──────────────┐               │
          │         │  Responding   │───────────────┘
          │         └──────┬───────┘
          │                │ task done
          │                ▼
          │         advance_current_task()
          └─────────── (next task or summary)
```

### `determine_next_prompt()` decision matrix

| State | Current task done? | Action |
|-------|--------------------|--------|
| `WaitingForResponse` | — | Return `None` (loop breaks, waits for callback) |
| `Responding` | Yes | Advance → start next task (or summary if all done) |
| `Responding` | No | `nag_evaluate()` — "review and mark done or delegate again" |
| `NotCalled` | Yes | Advance → start next task (or summary if all done) |
| `NotCalled` | No (has current task) | `nag_delegate()` — "delegate this task" |
| `NotCalled` | No current task | `start_next_task()` |

### Prompt builders

- **task_prompt(task)** — "Current task: {title}. Delegate this to a worker
  using send_prompt, mark done with task_write."
- **nag_delegate()** — "You have an active task but did not delegate it."
- **nag_evaluate()** — "You received a response from the delegated worker.
  Review it and mark the task done or send it back." **Does not include the
  summary** — the summary was delivered separately by `_send` via
  `caller.prompt()`.
- **summary_prompt()** — "All tasks are complete. Summarize what you did.
  Call no tools." Emitted once per task list (guarded by `summarized` flag).

### Infinite-loop guard

After all tasks are done, the summary prompt fires once. The `summarized`
flag prevents re-emission on subsequent `determine_next_prompt()` calls,
which would loop forever.

---

## 8. Orchestration Tools: \_send / \_task/*

`tools/orchestration_2.rs` — four tool handlers that implement the
inter-agent communication protocol. These are **client-side tools**: the
agent sends a JSON-RPC request, the Rust backend executes it.

### `_send` — async two-step delegation

```
Agent (caller) sends _send(toSessionId=B, blocks=[...])
    │
    ▼
send_to_session():
  1. Set caller's delegation state → WaitingForResponse
  2. Return {"status": "sent"} immediately (agent's turn continues)
  3. [spawned task] target.prompt(blocks) — send message to worker
  4. [spawned task] target.prompt(summary_blocks) — "summarize, no tools"
  5. [spawned task] Capture summary from worker's event stream
  6. [spawned task] caller.orchestration.set_responding(summary)
  7. [spawned task] caller.prompt(reply_blocks) — deliver summary to caller
  8. [spawned task] delegation_notify.notify_one() — wake task loop
```

Steps 3–8 run in a `tokio::spawn` — the agent gets its tool response
instantly and can `end_turn`. The async work completes later.

**Why `caller.prompt()` and not a notification?** The summary is a new
message that the agent needs to process — it goes through the prompt queue
just like any other prompt. If the caller is busy (task loop running), the
queue serializes delivery. `delegation_notify.notify_one()` wakes the task
loop so it re-enters `run_task_loop` with `Responding` state.

### `_task/read` — read task list

Returns the session's `task_list` + a summary string (counts by status).

### `_task/write` — CRUD on tasks

Actions: `create`, `update` (change status/assigned_to), `delete`.
Broadcasts the updated task list to the frontend as an ACP `plan` session
update.

### `_task/send` — instructor → orchestrator handoff

Populates a target session's task list, then **starts the target's task
loop** (`tokio::spawn(target.run_task_loop())`). The loop promotes the first
Pending task → InProgress and prompts the orchestrator with it.

Concurrency-guarded: if the orchestrator is already mid-loop, this is a safe
no-op. The `task_loop_running: AtomicBool` + RAII `TaskLoopGuard` ensure at
most one loop runs per session. A re-send while active just adds tasks; the
existing loop picks them up on its next `determine_next_prompt()`.

---

## 9. Tool Routing

`tools/mod.rs::route_tool_request` dispatches agent tool requests by method
name. Each handler receives a `ToolContext` with shared state:

```rust
pub struct ToolContext {
    pub active_terminals: Arc<Mutex<HashMap<String, SessionTerminal>>>,
    pub session_id: String,
    pub shell_env: Arc<HashMap<String, String>>,
    pub terminal_events_tx: broadcast::Sender<TerminalEvent>,
    pub manager: Option<Arc<AcpSessionManager>>,
    pub agent_config: AgentConfig,
}
```

### Routed tools

| Method | Handler | Notes |
|--------|---------|-------|
| `fs/readTextFile` | `filesystem::read_text_file` | Read file from disk |
| `fs/writeTextFile` | `filesystem::write_text_file` | Write file to disk |
| `terminal/create` | `terminal::create_terminal` | Spawn PTY, return terminalId |
| `terminal/output` | `terminal::get_output` | Read accumulated PTY output |
| `terminal/waitForExit` | `terminal::wait_for_exit` | Block until PTY exits |
| `terminal/kill` | `terminal::kill_terminal` | Kill PTY process tree |
| `terminal/release` | `terminal::release_terminal` | Release PTY (keep output) |
| `session/requestPermission` | `permissions::request_permission` | Auto-approve (for now) |
| `_send` | `orchestration_2::send_to_session` | Async delegation |
| `_task/read` | `orchestration_2::task_read` | Read task list |
| `_task/write` | `orchestration_2::task_write` | CRUD tasks |
| `_task/send` | `orchestration_2::task_send` | Send task batch |

Every match arm returns `Ok(json)` or `Err(String)`. The `handle_agent_line`
spawned task wraps the result in a JSON-RPC response and sends it back to
the agent stdin. Unhandled methods return `Err("unsupported method: ...")`.

### Extension tools

Methods starting with `_` are extension tools (not in the standard ACP
spec). They're implemented entirely in the Rust backend — the agent's MCP
server schema (from crow-cli's config) declares them so the LLM knows they
exist, but execution happens client-side.

---

## 10. Tauri Command Layer

`src-tauri/src/commands/acp_chat.rs` — thin bridge between frontend
`invoke()` calls and `AcpSessionManager`.

### Commands

| Tauri command | Maps to | Notes |
|---------------|---------|-------|
| `acp_chat_spawn` | `manager.init_connection(config, cwd)` | Returns `connection_id` |
| `acp_chat_new_session` | `manager.bind_new_session(conn, mcp)` | Returns `session_id`, calls `set_manager` |
| `acp_chat_load_session` | `manager.bind_load_session(conn, sid, cwd)` | Resume existing session |
| `acp_chat_switch_session` | `manager.switch_session(cur, target, cwd)` | Kill old agent, spawn fresh, load |
| `acp_chat_prompt` | `session.orchestration.reset_delegation()` then `session.prompt(blocks)` | **reset_delegation is here, not in prompt()** |
| `acp_chat_cancel` | `session.cancel()` | Kill terminals, send session/cancel |
| `acp_chat_close_session` | `manager.close_session(sid)` | Kill agent, remove from map |
| `acp_chat_list_sessions` | `session.list_sessions(cwd)` | ACP session/list |
| `acp_chat_set_config_option` | `session.set_config_option(id, val)` | Change model etc. |
| `acp_terminal_output` | Search all sessions for terminal_id | Poll PTY output for frontend |

### Event bridge

`AcpChatState::ensure_bridge()` spawns a tokio task that subscribes to the
global `SessionEvent` broadcast channel and emits Tauri events:

```
SessionEvent::Update { session_id, update }
    → app.emit("acp:sessionUpdate", { type: "update", sessionId, update })

SessionEvent::Disconnected { session_id }
    → app.emit("acp:sessionUpdate", { type: "disconnected", sessionId })
```

The frontend listens to `acp:sessionUpdate` via `@tauri-apps/api/event`.

The frontend always sends `mcp_servers: []` to session/new, session/load,
and session/prompt. Per-agent tool configuration is the agent's own concern
(via crow-cli's `--config-file`), not injected by the frontend.

---

## 11. Frontend: acpChat Contrib

`src/vs/workbench/contrib/acpChat/browser/` — VS Code contribution that
renders the chat panel.

### Two entry points

1. **AcpChatViewPane** (`acpChatView.ts`) — registered as a view in the
   sidebar/panel. Single instance, uses `AcpChatService` (DI service).
2. **AcpChatEditor** (`acpChatEditor.ts`) — registered as an editor pane for
   editor-tab mode. Multiple instances (one per tab), uses `AcpStore`
   directly. Per-session DOM is swapped in/out on tab switch via
   `_sessionViews` map.

Both have the same rendering pipeline; the difference is lifecycle management.

### Notification → View pipeline

```
Tauri event "acp:sessionUpdate"
    │
    ▼
AcpStore._handleSessionEvent(payload)
    │
    ├── Control signal? (prompt_state, prompt_complete, brief,
    │   permission_request, config_option_update, _send, queue_changed)
    │   → fire emitter, do NOT append to notification log
    │
    └── Content event? (agent_message_chunk, agent_thought_chunk,
        user_message_chunk, tool_call, tool_call_update, plan)
        → push to _notifications array
        → fire onDidChangeNotifications
            │
            ▼
        AcpChatViewPane._onNotificationAdded() / AcpChatEditor._onNotificationAdded()
            │
            ├── Get last notification from array
            ├── Determine group type:
            │     tool_call / tool_call_update → "tool"
            │     else → sessionUpdate string
            ├── Same type as last group? → extend it (appendNotification)
            └── Different type? → create new group component
                  → wrap in .sc-message-group div
                  → insert before sentinel
                  → schedule scroll
```

### Group components

| Component | Trigger | Renders |
|-----------|---------|---------|
| `UserMessage` | `user_message_chunk` | User's input text |
| `ThinkingBlock` | `agent_thought_chunk` | Collapsible reasoning block |
| `AgentMessageGroup` | `agent_message_chunk` | Streaming markdown |
| `ToolCallGroup` | `tool_call` / `tool_call_update` | Tool call cards (fs, terminal, inline diff) |

All extend `Component` (`base.ts`) — a lightweight DOM component system with
no React. Each owns its root element, manages children via `DisposableStore`,
and cleans up on dispose.

### AcpStore

The store is a **dumb append-only log**. Every content event is pushed to
`_notifications` as-is, preserving arrival order. The view groups consecutive
same-type notifications and renders each group as its own visual block.

Control signals (prompt lifecycle, brief, permission requests) are handled
inline — they fire emitters but are never appended to the notification log.

### Agent configuration

Agents are loaded from SideX settings via `settings_get('acp.agents')`. Each
entry is a declarative spawn list (name/command/args/env). The frontend reads
this, populates the agent dropdown, and spawns the selected agent. Agent
switching closes the current session, clears messages, and spawns a fresh
agent process.

### ScrollManager

Detects when the user scrolls up during streaming and pauses auto-scroll.
Uses CSS `overflow-anchor: auto` on a bottom sentinel element for free
auto-scroll when content grows (the browser keeps the sentinel in view).
Capture-phase wheel event interception is needed because VS Code's parent
`DomScrollableElement` calls `preventDefault()` on wheel events, killing
native `overflow-y: auto` scrolling.

---

## 12. Markdown Rendering

Two renderers, each with a distinct role:

### `markdownRenderer.ts` — static (complete) rendering

- `marked` with `markedHighlight` (highlight.js) + `marked-katex-extension`
- Custom `renderer.code` wraps output in `.sc-code-block > .sc-code-pre >
  code.hljs` with a language label
- Mermaid passthrough: `lang === 'mermaid'` → `<div class="mermaid">`
- Full highlight.js import (~190 languages). If bundle size matters, switch
  to `highlight.js/lib/core` + curated registration.
- `renderMermaidDiagrams()` is called after DOM insertion (mermaid can't be
  done inline)

### `streamingMarkdown.ts` — incremental streaming

The **frozen-block strategy** fixes O(N²) re-parsing during streaming:

```
Streamed text: "## Hello\n\nSome text\n\n```python\nprint('hi')\n```\n\nMore"
                                       ↑ safe boundary ↑

Frozen container (parsed once, never touched):
  "## Hello\n\nSome text\n\n"

Active container (re-parsed every 80ms tick):
  "```python\nprint('hi')\n```\n\nMore"
```

**Safe boundary detection** — a `\n\n` is safe to split at if:
1. Not inside an open code fence (odd count of `` ``` `` backticks in
   everything up to that point)
2. Not at the end of a list item (the list might gain more items; splitting
   a loose list mid-stream produces separate `<ul>` elements)

Frozen blocks are appended via `insertAdjacentHTML('beforeend')` — never
re-parsed. Only the active tail (last incomplete block) is re-parsed on each
throttled tick.

Mermaid diagrams are rendered 250ms after the last update (deferred heavy
render).

### Edit-diff highlighting

`FileEditView` passes the bare file path (not `path + '-diff'`) to
`createModel` so Monaco detects the correct language. Green/red line
backgrounds come from Monaco decorations, not from `+`/`-` prefixes in the
model content.

---

## 13. Performance: Streaming + Typing

Typing in the chat input while the agent streams caused lag. Four root
causes were identified and fixed:

### 1. Scroll throttling (`acpChatView.ts`)

`scrollToBottom()` was called on every notification — every token chunk.
`scrollIntoView()` forces a synchronous layout reflow. During streaming,
this means hundreds of forced reflows per second.

**Fix:** `_scheduleScroll()` debounces `scrollToBottom()` to 100ms. CSS
`overflow-anchor: auto` on the sentinel handles intermediate scroll
position during streaming.

### 2. CSS `contain: layout` (`acpChatView.css`)

`.sc-messages` and `.sc-input-area` are flex siblings. Without `contain`,
every DOM change inside `.sc-messages` triggered a layout recalculation
that walked up to the flex parent and back down to the input area.

**Fix:** `contain: layout` on `.sc-messages` isolates its layout from
siblings.

### 3. `hasContent` O(1) (`richTextEditor.ts`)

The `hasContent` getter called `getJSON()` (serializes the entire ProseMirror
document) then `extractContentBlocks()` (walks the full tree) on every
keystroke.

**Fix:** `_hasContent` boolean field, updated in `onUpdate` via
`editor.isEmpty` (O(1) property check).

### 4. Notification array push (`acpStore.ts`)

`this._notifications = [...this._notifications, notification]` on every
chunk — O(N) array copy per notification, O(N²) over a streaming response.

**Fix:** `this._notifications.push(notification)` — O(1).

---

## 14. Test Layout

### Unit tests (pure, fast — 0.5s)

- `orchestration_state.rs` — 20 tests for the pure state machine. No I/O,
  no async. Tests `determine_next_prompt()` in all delegation states, task
  promotion, summary guard, status sync.
- `session.rs` — 5 tests for PTY/serialization (terminal output, exit codes,
  response shapes).

### Integration tests (real subprocess — ~6s)

`tests/integration.rs` — 11 tests driving a real echo agent subprocess.

The echo agent (`tests/echo_agent.py`) is pure stdlib Python — no asyncio,
no SDK imports. Reads JSON-RPC line-by-line from stdin, responds
synchronously. This avoids the asyncio EPERM issue in the sandbox.

The orchestration e2e test (`tests/orchestration_agent.py`) is a scripted
agent with three roles (worker, orchestrator, instructor). Each does rote
actions (emit a tool request, read its ack, end_turn) and works because tool
acks return the instant the backend spawns the async work.

### Running tests

```bash
# All tests (unit + integration, ~6s, parallel-safe)
cd sidex && cargo test -p sidex-acp

# Just the e2e tripartite flow
SIDEX_ACP_SKIP_SHELL_ENV=1 cargo test -p sidex-acp --test integration orchestration_e2e_tripartite_flow
```

`SIDEX_ACP_SKIP_SHELL_ENV=1` bypasses shell-env capture (the echo agent is
an absolute path, needs no PATH lookup).

---

## 15. Known Issues and Missing Features

### Missing: `list_sessions` tool

Identified in FUTURE.md as the one real gap. The tool should list available
connected sessions and expose what tooling each agent has. Not yet
implemented in `route_tool_request`.

### Missing: Task list UI

The task list is broadcast to the frontend as ACP `plan` session updates,
but there's no frontend component to render it. The user wants a full task
list UI.

### Unbounded log file

`~/.local/share/sidex/logs/acp.log` grows without rotation. It also records
the **live host app's** ACP session, not `cargo test` subprocesses — don't
use it to debug test hangs.

### v1 files still on disk

`prompt.rs` and `tools/orchestration.rs` are the v1 implementations. They're
not compiled (commented out in `lib.rs` and `tools/mod.rs`). Safe to delete.

### Session config not persisted

Config options (model selection etc.) are received from the agent but not
persisted across session reloads. The frontend re-requests them on each
`spawnAndConnect`.

### `_send` notification in acpStore

The `acpStore._handleSessionEvent` has a handler for `sessionUpdate === '_send'`
that auto-sends a new prompt with the summary. This is vestigial from the v1
design — the v2 backend delivers the summary via `caller.prompt()` directly,
so the frontend should never see an `_send` session update. If it does, the
double-handling could cause duplicate messages. Left in as a fallback but
should be audited.
