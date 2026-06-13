# Plan

## Phase 1: Multi-Agent Orchestration via Plan Delegation

**This is the core product. Everything else is infrastructure or polish.**

### The Model

Three-tier hierarchy: **Instructor → Orchestrator → Workers**

- **Instructor**: receives human intent, creates high-level plan, delegates to orchestrator
- **Orchestrator**: receives plan, decomposes into sub-tasks, delegates to workers, tracks progress
- **Workers**: receive specific tasks, execute them, report completion via plan updates

Plans are the communication mechanism. No HTTP endpoints, no custom tools, no extension methods. Just ACP's native `sessionUpdate: "plan"` with `_meta` for routing.

### Delegation Protocol

When an agent sends a plan with `_meta.delegate.sessionId`, the client routes it:

```json
{
  "sessionUpdate": "plan",
  "_meta": {
    "delegate": {
      "sessionId": "sess_orchestrator_001"
    }
  },
  "entries": [
    {
      "content": "Research authentication best practices for OAuth 2.0",
      "status": "pending",
      "priority": "high"
    },
    {
      "content": "Design the API schema for user management",
      "status": "pending", 
      "priority": "high"
    }
  ]
}
```

The client extracts `sessionId` from `_meta.delegate`, finds that session in `AcpSessionManager`, and sends the plan entries as a `session/prompt`. The target agent receives the plan as its task list.

### 1A: Plan Persistence (Backend)

**Scope:**
- Add `session_plans` table to sidex-db: `session_id`, `plan_json`, `timestamp`, `version`
- When a `sessionUpdate: "plan"` arrives, persist it to SQLite
- On session load, retrieve the latest plan for that session
- Plans are append-only history — each update creates a new row

**Key files:**
- `crates/sidex-db/src/schema.rs` — add `session_plans` table
- `crates/sidex-db/src/plans.rs` — insert/query plan history
- `crates/sidex-acp/src/session.rs` — persist plans when they arrive

### 1B: Delegation Routing (Backend)

**Scope:**
- In `AcpSession::handle_session_update`, detect `_meta.delegate.sessionId` on plan updates
- Extract the target session ID
- Look up the target session in `AcpSessionManager`
- Convert plan entries to a `session/prompt` request and send it to the target session
- Maintain a delegation graph: which session delegated to which (for tracking responses)

**Key files:**
- `crates/sidex-acp/src/session.rs` — delegation detection and routing
- `crates/sidex-acp/src/manager.rs` — session lookup and prompt sending

### 1C: Orchestration Loop (Backend)

**Scope:**
- Watch plan state transitions across all sessions
- When all entries in a delegated plan reach `completed`, notify the delegating session
- Reactive, not polling: only intervene when state changes or agents stall
- If a worker session has no pending tasks and hasn't received new delegation, it can be terminated

**Key files:**
- `crates/sidex-acp/src/session.rs` — state transition monitoring
- `crates/sidex-acp/src/manager.rs` — coordination across sessions

### 1D: Crow-CLI Support (Agent)

**Scope:**
- Update crow-cli to detect `_meta.delegate` in plan updates and emit delegation requests
- Add system prompt guidance for the three-tier model
- When crow-cli receives a delegated plan, treat it as its task list
- Support `session/list` to discover available sessions for delegation

**Key files:**
- `research/crow-cli/crow-cli/src/crow_cli/agent/main.py` — delegation handling
- `research/crow-cli/crow-cli/src/crow_cli/agent/system_prompt.py` — add orchestration guidance

### 1E: Plan Viewer (Frontend)

**Scope:**
- Display plan updates in the chat view as they arrive
- Show entries with status indicators (pending/in_progress/completed)
- Visualize delegation: show which session delegated to which
- Allow human to inspect plans at any level of the hierarchy

**Key files:**
- `src/vs/workbench/contrib/acpChat/browser/components/planView.ts` (new)
- `src/vs/workbench/contrib/acpChat/browser/acpStore.ts` — plan state management

---

## Phase 2: Chat View Lifecycle + Streaming Syntax Highlighting

**Same pipeline, same DOM, fix both while you're in there.**

### 2A: Chat View Lifecycle

The chat view currently tears down or suspends when it loses focus. Three symptoms of the same root cause:

- Scroll position resets when returning to chat
- Editors lose content on tab switch
- Streaming responses that arrive while unfocused are lost

**Scope:**
- Audit how `AcpChatView` (extends `ViewPane`?) is created/destroyed/suspended on focus change. Check if the DOM is being detached or the view is being disposed.
- Keep the chat DOM alive (detached but not destroyed) when switching away. VSCode has patterns for this with panel views.
- Ensure `AcpStore`'s Tauri event listeners (`acp:sessionUpdate`) remain registered regardless of view visibility. Currently `tauriListen` has retry logic — verify listeners aren't being torn down on view dispose.
- Verify the `_handleSessionEvent` filtering logic doesn't drop events during transitions. The `sessionId` must match — if `_sessionId` is stale after a switch, events are silently dropped.
- On return: scroll to bottom, restore editor content.

**Key files:**
- `src/vs/workbench/contrib/acpChat/browser/acpChatView.ts`
- `src/vs/workbench/contrib/acpChat/browser/acpStore.ts`
- Whatever VSCode ViewPane lifecycle controls are in play

### 2B: Streaming Syntax Highlighting

**Scope:**
- Audit the current rendering pipeline: how do agent text blocks get parsed and displayed? Trace from `AcpNotification` → markdown rendering → DOM.
- Replace Monaco-based code block highlighting with `marked` + a lightweight highlighter (shiki or highlight.js).
- Design for incremental highlighting: partial code blocks must render as they stream in without flickering or layout shifts.
- Handle: unterminated code blocks mid-stream, language detection from fence info strings, nested backticks.
- Ensure the markdown renderer doesn't re-render the entire message on every chunk. Diff-based DOM updates or at minimum, only re-render the last block.

**Key files:**
- `src/vs/workbench/contrib/acpChat/browser/components/markdownRenderer.ts`
- `src/vs/workbench/contrib/acpChat/browser/components/messages/agentMessage.ts`

---

## Phase 3: Agent Configuration + MCP Server Configuration + LLM Provider Configuration

**This is the core product surface. Crow-ui already has all three — port and adapt to sidex's VSCode workbench patterns.**

### 3A: Agent Configuration

Currently sidex hardcodes `crow-cli acp` in `AcpChatServiceImpl.connect()`. No UI for configuring agents.

**Scope:**
- Define an `AgentConfig` type in the frontend (name, command, args, env, configFile, mcpServerIds). Crow-ui uses this shape:
  ```ts
  interface AgentConfig {
    id?: string;
    name: string;
    command: string;
    args?: string[];
    env?: string[];
    configFile?: string;
    mcpServerIds?: string[];
  }
  ```
- Store agent configs in settings (sidex has `IConfigurationService` — use `settings.json` patterns).
- Build an agent configuration view as a `contrib` pane (not an extension). Needs: agent list sidebar, agent editor form (name, command, args, env vars), MCP server assignment checkboxes.
- Wire `AcpChatService.connect()` to read from configured agents instead of hardcoding.
- Backend (`sidex-acp`): the Rust `AgentManager` already spawns agents from config — verify the Tauri commands support passing agent config (name, command, args, env) dynamically.

### 3B: MCP Server Configuration

Sidex has zero MCP configuration UI or backend support. The crow-cli agent receives MCP servers via `session/new` — so the IDE needs to pass them.

**Scope:**
- Define `McpServerConfig` type:
  ```ts
  type McpTransport =
    | { type: "stdio"; command: string; args: string[]; env: EnvVar[] }
    | { type: "http"; url: string; headers: HttpHeader[] }
    | { type: "sse"; url: string; headers: HttpHeader[] };
  
  interface McpServerConfig {
    name: string;
    transport: McpTransport;
  }
  ```
- Build MCP server configuration view: server list sidebar, transport type selector (stdio/http/sse), per-transport editor forms.
- Store in settings. Wire into `AcpStore.spawnAndConnect()` — pass enabled MCP servers to the `session/new` call.
- Backend: verify the `acp_chat_spawn` Tauri command accepts and forwards `mcpServers` to the ACP `session/new` request. If not, add it.

### 3C: LLM Provider/Model Configuration

The LLM config (providers + models) lives in crow-cli's config.yaml, not in the IDE. Crow-ui's `LlmConfigPane` talks to crow-cli via RPC to read/write config.

**Scope:**
- Determine if LLM config should live in the IDE (settings.json) or remain in crow-cli (config.yaml). Crow-ui bridges both — stores API keys in `~/.crow/.env`, config in `config.yaml`.
- If IDE-side: build a provider/model configuration view. If crow-cli-side: build a thin view that reads/writes crow-cli config via Tauri commands (like crow-ui's `crowCliConfigApi`).
- Provider config: name, base_url, api_key (stored as env var reference `${PROVIDER_API_KEY}`).
- Model config: name, provider reference, model ID.
- "Fetch Models" button that queries the provider's `/models` endpoint.
- Wire model selection into the chat session — currently model selection happens via `setConfigOption` on the ACP session. The config pane should make this discoverable.

**Key files (new):**
- `src/vs/workbench/contrib/acpChat/browser/components/config/` (new directory)
- Agent config view, MCP config view, LLM config view

---

## Phase 4: Dirty Indicator + Editor Sync

**Two related problems: tracking unsaved changes, and keeping editors in sync with disk.**

### 4A: Dirty Indicator

**Scope:**
- VSCode already has dirty state tracking in its editor model — audit how it works in this fork. The `ITextFileService` and `IUntitledTextEditorService` likely track dirty state.
- Add visual indicator to tab/title (dot, bold, or similar). Check if VSCode's tab rendering code already supports this and it's just not wired up.
- The dirty state must be queryable by the agent's `read_file` tool. In crow-ui, the client-side `readTextFile` handler checks Monaco's model registry first (returning in-memory content including unsaved changes) before falling back to disk. Sidex needs the same pattern.

### 4B: Editor Sync

**Scope:**
- When an agent writes a file via `writeTextFile`, detect if the file is currently open in an editor. If so, update the editor's model content.
- Handle conflicts: user has unsaved changes, agent writes the same file. Options: auto-accept agent's version, prompt user, or merge.
- When a file changes on disk (git checkout, external editor), detect and either auto-reload or prompt.
- Wire the `readTextFile` client handler (in the ACP client implementation) to return in-memory editor content when available, matching crow-ui's pattern.

**Key files:**
- Editor model layer (wherever `ITextModel` instances live)
- ACP client tool handlers (the `readTextFile`/`writeTextFile` callbacks)
- Tab/title rendering for dirty indicator

---

## Phase 5: Rich Text Editor (Monaco++)

**Standalone feature. Needs a design doc before implementation.**

The current chat input is a basic text area. The vision is a full editor with Typst WYSIWYG, `@` context references, drafts/autosave, and local autocomplete.

**Scope:**
- **URI schema:** Define a custom URI scheme (e.g., `chat-prompt:///session/{id}`) so the editor can be detached into its own editor tab/window. This integrates with VSCode's editor system.
- **Typst support:** Full Typst syntax highlighting. The tinymist project (in `research/tinymist/`) has a Typst language server — investigate if its tokenizer/parser can be adapted for the editor, or if a TextMate grammar approach works.
- **`@` context mechanism:** Typing `@` triggers a completion picker for context references (files, sessions, tasks, symbols). Selected items become inline chips/references in the document. Sidex already has `mentionPopup.ts`, `mentionSuggestion.ts`, and `mentionResolver.ts` — extend these.
- **Drafts/autosave:** Save the editor buffer per-session so closing and returning restores the unfinished prompt. Use VSCode's `IStorageService` or a simple file-based approach.
- **Message as bubble:** When sent, the message appears as a chat bubble in the history. This connects the editor's document model to the chat rendering.
- **Window splitting:** The editor can be opened in its own tab/window via the URI schema.
- **Autocomplete:** Local model inline suggestions (like Zed). This is its own sub-feature and may be deferred.
- **Scroll wheel and resize:** Enable proper scroll, handle resize when the editor is inline vs. split out.

**Start with a design doc** that defines the document model, URI schema, and data flow.

**Key files:**
- `src/vs/workbench/contrib/acpChat/browser/components/input/richTextEditor.ts`
- `src/vs/workbench/contrib/acpChat/browser/components/input/mentionPopup.ts`
- `src/vs/workbench/contrib/acpChat/browser/acpChatUri.ts`
- `src/vs/workbench/contrib/acpChat/browser/acpChatEditor.ts`
- `src/vs/workbench/contrib/acpChat/browser/acpChatEditorInput.ts`
- `src/vs/workbench/contrib/acpChat/browser/acpChatEditorSerializer.ts`

---

## Phase 5: Plan-Based Orchestration + Delegation + Queue Management

**The plan is the task list. Delegation is metadata on the plan. Everything flows through standard ACP — no extension methods, no HTTP endpoints, no custom tool definitions.**

### Background: Plans ARE Tasks

ACP already has `sessionUpdate: "plan"` — entries with content, status (`pending`/`in_progress`/`completed`), and priority. The agent sends plans, the client receives them, displays them. That's the task system.

Crow-ui built a separate HTTP-backed task CRUD system (`task.rs`, `relay_state.rs`). We're not porting that. Instead, the plan itself is the source of truth. The agent updates the plan as it works. The client watches plan state transitions and orchestrates accordingly.

### Inter-Agent Delegation via `_meta`

The ACP spec allows `_meta` on any object in the protocol. We use `_meta` at the plan level to signal delegation:

```json
{
  "sessionUpdate": "plan",
  "_meta": {
    "delegate": {
      "sessionId": "sess_worker_001"
    }
  },
  "entries": [
    {
      "content": "Refactor the auth module to use the new token validation logic",
      "status": "pending",
      "priority": "high"
    },
    {
      "content": "Add unit tests for the refactored module",
      "status": "pending",
      "priority": "high"
    }
  ]
}
```

The client sees `delegate.sessionId` in the plan's `_meta`, extracts the target session ID, and routes the entire plan to that session via `session/prompt`. The `content` field of each entry is the instruction — no duplication.

### 5A: Client-Side Plan Persistence

**Scope:**
- Persist incoming plans to SQLite (for history, recovery, cross-session queries).
- Schema: `session_plans` table — session_id, plan JSON, timestamp.
- When the client starts, load the latest plan for each active session.
- This replaces crow-ui's `task.rs` SQLite CRUD — but the plan is the source of truth, not separate task rows.

### 5B: Delegation Routing

**Scope:**
- When a plan arrives with `_meta.delegate.sessionId`, the client extracts the target session ID.
- Find the target session in `AcpSessionManager`.
- Send the plan's entries as a `session/prompt` to the target session. The prompt text is derived from the entries (e.g., "You have been delegated the following tasks: [entries]").
- The target agent works, sends its own plan updates back. The delegating session can observe the target's plan to track progress.
- State tracking: maintain a delegation graph (who delegated to whom) so the client can correlate plan updates and route responses back if needed.

### 5C: Orchestration Loop

**Scope:**
- The client watches plan state transitions from all active sessions.
- When a plan entry moves from `pending` → `in_progress`, note it.
- When entries move to `completed`, check if all entries are done. If so, and the session was delegated, notify the delegating session (via its plan or a follow-up prompt).
- The orchestration loop is reactive: it doesn't actively prompt the agent unless the agent has stalled or all tasks are done and the next action needs to be determined.
- This replaces crow-ui's `run_task_loop` — but instead of driving the agent via HTTP, the client just watches plans and intervenes when needed.

### 5D: `session/list` (Already in Protocol)

The ACP protocol already has `session/list` — the agent can call it to discover active sessions. No work needed unless the client needs to expose this to the UI.

**Scope:**
- Verify `session/list` is handled by the client and returns active sessions.
- If the UI needs a session list (e.g., for the delegation picker), wire it through a Tauri command.

### 5E: Queue Management

Sidex-acp's `AcpSession` already has queue management (`prompt_with_behavior`, `queue_push`, `queue_remove`, `queue_reorder`, `queue_clear`, `drain_queue`).

**Scope:**
- Queue state is broadcast via `sessionUpdate: "queue_changed"` (already implemented).
- Build a queue viewer contrib view — shows queued items, allows reordering/removal.
- Wire queue operations through Tauri commands for the UI.
- The queue viewer should be live — updates arrive via the event stream.

### 5F: Granular Cancellation

**Scope:**
- Agent cancellation (`session/cancel`) should kill running terminals. Crow-ui's `AcpSession.cancel()` already drains `active_terminals` and kills them — verify sidex-acp matches.
- Add a cancel button on running terminal tool calls in the chat UI. This kills only that terminal via `terminal/kill`, letting the agent's react loop continue.
- The `terminal/kill` response should be a normal exit so the agent's prompt handler doesn't error out.

**Key files:**
- `crates/sidex-acp/src/session.rs` — plan persistence, delegation routing, orchestration loop
- `crates/sidex-db/src/` — plan SQLite tables
- `src/vs/workbench/contrib/acpChat/browser/` — plan viewer, queue viewer, delegation UI

---

## Phase 6: Independent Features

No ordering dependencies between these. Do them as they come up.

### Log Rotation + Path Rename

- Audit all code for log paths still referencing `sidex` directories.
- Rename to `~/.local/share/crow/acp.log`.
- Implement rotation (e.g., max 10MB, keep 3 rotated files). The current log has hit 60MB+.

### ATProto PDS-Based Auth

- Standalone auth feature. No dependencies on other phases.

### Preview Robustness (Typst + Markdown)

- Typst and Markdown previews crash when the editor is resized.
- The preview component violates layout constraints assumed by the VSCode editor system.
- Fix resize handling so previews don't throw errors.

### Bring Tinymist into Contrib

- Integrate tinymist as a built-in contribution so `.typ` files get a proper preview by default.
- Consider enabling the same preview pattern for Markdown.

---

## Context: Market Positioning

**Where Crow fits in the AI coding tool landscape (as of late 2025/early 2026):**

- **Cursor, Windsurf, Trae, Antigravity**: All proprietary, closed-source, single-model or limited multi-model. They have polish and funding but no protocol-based multi-agent orchestration.
- **Cline, Aider**: Open source but single-agent, no structured delegation.
- **GitHub Agent HQ**: Multi-agent control plane but proprietary and GitHub-specific.

**Crow's differentiators:**
1. **ACP-native**: First IDE built on the Agent Client Protocol. Swappable agents, not locked to a specific model provider.
2. **Hierarchical multi-agent**: Instructor → Orchestrator → Worker with plan-based delegation. This architecture doesn't exist in any competitor.
3. **Plans as communication**: Agents coordinate through plan updates with `_meta` routing, not through custom APIs or HTTP endpoints.
4. **Open source + local-first**: Your keys, your infrastructure, auditable code.

**What's not a gap:**
- "Background agents" (Cursor Bug Finder, Google scheduled tasks): These are just async agents. Crow already does this — switch tabs, agents keep working. The Phase 2 lifecycle fixes make it seamless.
- Inline completion (Tab): Nice-to-have for an editor, not core to an ADE where agents do the heavy lifting.

**What matters:**
- The orchestration model working end-to-end (Phase 1)
- Long-term research indexing (Graphiti/knowledge graphs for accumulated context across sessions)
- The rich text editor as the human-agent planning interface (Phase 5)
