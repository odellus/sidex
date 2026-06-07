# Inter-Agent Communication

Cross-session messaging and multi-agent orchestration for Sidex.

## Overview

Three tiers of agents coordinate through shared task state and async message passing:

| Role | Tools | Behavior |
|------|-------|----------|
| **Worker** | standard crow-cli tools | Executes tasks, no orchestration |
| **Orchestrator** | `list_sessions`, `send`, `task_read`, `task_write` | Delegates to workers, tracks task state |
| **Instructor** | `list_sessions`, `task_read`, `task_send` | Composes task lists, teaches orchestrators |

Communication between agents is **asynchronous**. The calling agent doesn't block — it sends a message, continues working, and receives a callback notification when the target agent finishes.

## Architecture

### How It Works Today (crow-ui reference)

crow-ui's backend (`crow-ui-server`) handles agent tool calls via JSON-RPC over stdio. The agent sends requests like `terminal/create` and the backend executes them client-side:

```
Agent stdout (JSON-RPC request)
  → I/O task parses
  → handle_agent_request() dispatches by method
  → executes tool (fs, terminal, etc.)
  → sends JSON-RPC response back to agent stdin
```

This is the same pattern we'll use for `send`. The `send` tool is a **client-side tool** — the Rust ACP client handles it, not the LLM.

### The `send` Flow (End-to-End)

```
┌──────────┐  send(to=B, msg)   ┌──────────────┐
│ Agent-A  │ ─────────────────► │ Rust ACP     │
│ (caller) │  JSON-RPC request  │ Client       │
└──────────┘                    │ (sidex-acp)  │
     ▲                          └──────┬───────┘
     │                                 │
     │  ① immediate response           │  ② session/prompt
     │  {"status": "sent"}             │     to Agent-B
     │                                 ▼
     │                          ┌──────────┐
     │                          │ Agent-B  │
     │                          │ (worker) │
     │                          └────┬─────┘
     │                               │
     │                               │ react loop, tools, etc.
     │                               │
     │                               ▼
     │                          ┌──────────────────┐
     │                          │ prompt response   │
     │                          │ stopReason: "end" │
     │                          └────┬─────────────┘
     │                               │
     │                               │  ③ re-prompt: "summarize,
     │                               │     call no tools"
     │                               ▼
     │                          ┌──────────┐
     │                          │ Agent-B  │
     │                          │ (summary)│
     │                          └────┬─────┘
     │                               │
     │                               │ text-only response
     │                               │
     │  ④ _send notification         ▼
     │  session/update         ┌──────────────┐
     └──────────────────────── │ Rust ACP     │
       summary text delivered  │ captures     │
       as _send update         │ summary text │
                               └──────────────┘
```

**Step by step:**

1. **Agent-A calls `send`** — JSON-RPC request: `{"id": 42, "method": "session/send", "params": {"toSessionId": "B", "blocks": [...]}}`
2. **Backend responds immediately** — `{"id": 42, "result": {"status": "sent"}}` — Agent-A's turn continues
3. **Backend prompts Agent-B** — sends `session/prompt` with the message blocks
4. **Agent-B works** — full react loop with tools
5. **Agent-B finishes** — `session/prompt` response with `stopReason`
6. **Backend re-prompts Agent-B** — "Summarize what you just did. Call no tools."
7. **Backend captures summary** — subscribes to Agent-B's events, collects `agent_message_chunk` text until `prompt_complete`
8. **Backend sends `_send` to Agent-A** — injects a `session/update` notification into Agent-A's stdin with the summary

### The `_send` Notification

`_send` is a custom extension to the ACP JSON-RPC schema. It's a `session/update` notification with a non-standard `sessionUpdate` type:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "A",
    "update": {
      "sessionUpdate": "_send",
      "fromSessionId": "B",
      "toSessionId": "A",
      "summary": "Refactored auth module. Extracted token validation into separate service. All 47 tests passing.",
      "status": "completed"
    }
  }
}
```

The underscore prefix (`_send`) signals this is a custom extension, not a standard ACP update type. The agent's system prompt instructs it how to handle `_send` updates.

This is built into the Rust ACP client the same way `terminal` and `fs/*` tools are — it's client-side infrastructure that the agent sees as part of its environment.

## Implementation

### Phase 1: `list_sessions` Tool

Agent discovers available sessions it can communicate with.

#### Backend

Add handler in `sidex-acp/src/session.rs` inside `handle_agent_request()`:

```rust
"session/list_sessions" | "session/listSessions" => {
    let cwd = params.get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    
    let manager = self.manager.lock().await;
    let sessions = manager.list_sessions_with_info(cwd).await;
    
    let session_list: Vec<Value> = sessions.iter().map(|info| {
        json!({
            "sessionId": info.session_id,
            "agentName": info.agent_name,
            "cwd": info.cwd,
            "status": info.status,
            "tools": info.available_tools,
        })
    }).collect();
    
    Ok(json!({ "sessions": session_list }))
}
```

The `available_tools` field tells the calling agent what capabilities each session has (e.g., `["task_write"]` for orchestrators, `[]` for workers).

#### Agent Tool Definition (crow-cli)

```python
{
    "name": "list_sessions",
    "description": "List available agent sessions you can communicate with",
    "inputSchema": {
        "type": "object",
        "properties": {
            "cwd": {
                "type": "string",
                "description": "Filter by workspace directory"
            }
        }
    }
}
```

### Phase 2: `send` Tool + `_send` Callback

#### Backend — `send` Request Handler

```rust
"session/send" => {
    let to_session_id = params.get("toSessionId")
        .and_then(|v| v.as_str())
        .ok_or("missing toSessionId")?;
    let blocks: Vec<Value> = params.get("blocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let from_session_id = session_id.to_string();
    
    // Find target session
    let target_session = {
        let manager = self.manager.lock().await;
        manager.get_session(to_session_id).await
            .ok_or("target session not found")?
    };
    
    // Set delegation state on caller
    {
        let caller = self.manager.lock().await
            .get_session(&from_session_id).await
            .ok_or("caller session disappeared")?;
        *caller.delegation_state.lock().await = DelegationState::WaitingForResponse;
    }
    
    // Spawn async relay task
    let manager = self.manager.clone();
    tokio::spawn(async move {
        // Step 1: Send prompt to target
        let acp_blocks: Vec<acp::ContentBlock> = blocks.iter()
            .filter_map(|b| serde_json::from_value(b.clone()).ok())
            .collect();
        
        if let Err(e) = target_session.prompt(acp_blocks).await {
            // Send error callback to caller
            send_send_error(&manager, &from_session_id, to_session_id, &e.to_string()).await;
            return;
        }
        
        // Step 2: Re-prompt for summary (no tools)
        let summary_blocks = vec![acp::ContentBlock::Text(acp::TextContentBlock {
            text: "Summarize what you just accomplished in 2-3 sentences. \
                   Focus on the outcome. Do not call any tools.".into(),
            annotations: None,
        })];
        
        // Subscribe to events before prompting so we don't miss chunks
        let mut event_rx = target_session.subscribe();
        
        if let Err(e) = target_session.prompt(summary_blocks).await {
            send_send_error(&manager, &from_session_id, to_session_id, &e.to_string()).await;
            return;
        }
        
        // Step 3: Capture summary text from events
        let mut summary = String::new();
        while let Ok(event) = event_rx.recv().await {
            if let SessionEvent::Update { ref update, .. } = event {
                match update.get("sessionUpdate").and_then(|v| v.as_str()) {
                    Some("agent_message_chunk") => {
                        if let Some(text) = update.get("content")
                            .and_then(|c| c.get("text"))
                            .and_then(|t| t.as_str()) 
                        {
                            summary.push_str(text);
                        }
                    }
                    Some("prompt_complete") => break,
                    _ => {}
                }
            }
        }
        
        // Step 4: Send _send notification to caller
        if let Some(caller_session) = manager.get_session(&from_session_id).await {
            *caller_session.delegation_state.lock().await = DelegationState::Responding;
            
            let update = json!({
                "sessionUpdate": "_send",
                "fromSessionId": to_session_id,
                "toSessionId": from_session_id,
                "summary": summary,
                "status": "completed"
            });
            
            let _ = caller_session.events_tx.send(SessionEvent::Update {
                session_id: from_session_id,
                update,
            });
        }
    });
    
    // Return immediately — agent's turn continues
    Ok(json!({ "status": "sent", "toSessionId": to_session_id }))
}
```

#### Orchestrator State Machine

```rust
#[derive(Clone, Debug, Default)]
pub enum DelegationState {
    #[default]
    NotCalled,           // Haven't used send yet this turn
    WaitingForResponse,  // Called send, waiting for _send callback
    Responding,          // Received _send callback, processing result
}
```

**State transitions:**

| Trigger | From | To |
|---------|------|----|
| Agent calls `send` tool | any | `WaitingForResponse` |
| `_send` callback arrives | `WaitingForResponse` | `Responding` |
| New prompt arrives (user or task queue) | `Responding` | `NotCalled` |
| New prompt arrives (user or task queue) | `WaitingForResponse` | `NotCalled` |

#### End-of-Turn Behavior

When the orchestrator's turn ends (`end_turn` / `prompt_complete`), the backend checks delegation state and task status:

```rust
async fn handle_orchestrator_end_turn(session: &AcpSession) {
    let state = session.delegation_state.lock().await.clone();
    let task_complete = session.is_current_task_complete().await;
    
    match (state, task_complete) {
        // Agent delegated and is waiting — do nothing, callback will arrive
        (DelegationState::WaitingForResponse, _) => {}
        
        // Agent received callback but didn't update task status
        (DelegationState::Responding, false) => {
            session.prompt(vec![text_block(
                "You received a response from the worker. \
                 If the task is complete, update its status with task_write. \
                 If not, send it back to the worker with feedback."
            )]).await;
        }
        
        // Agent never delegated — yell at it
        (DelegationState::NotCalled, false) => {
            session.prompt(vec![text_block(
                "You finished your turn without delegating the current task. \
                 Either delegate it to a worker using send, \
                 or mark it complete with task_write if it's already done."
            )]).await;
        }
        
        // Task complete — dequeue next or summarize
        (DelegationState::Responding, true) | (DelegationState::NotCalled, true) => {
            if let Some(next_task) = session.task_queue.pop().await {
                *session.delegation_state.lock().await = DelegationState::NotCalled;
                session.prompt(vec![text_block(&format!(
                    "Next task: {}", next_task.title
                ))]).await;
            } else {
                session.prompt(vec![text_block(
                    "All tasks complete. Provide a final summary of what was accomplished."
                )]).await;
            }
        }
    }
}
```

### Phase 3: Task Management

#### Data Model

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub assigned_to: Option<String>,  // session_id of worker
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Blocked { reason: String },
}
```

Task list is stored per-session on the `AcpSession`:

```rust
pub struct AcpSession {
    // ... existing fields ...
    pub task_list: Arc<Mutex<Vec<Task>>>,
    pub task_queue: Arc<Mutex<VecDeque<Task>>>,  // pending tasks to process
    pub delegation_state: Arc<Mutex<DelegationState>>,
}
```

#### `task_read` Tool

Read-only. Available to all agents. Maps to existing ACP `session/plan` update types.

```rust
"session/task_read" | "session/taskRead" => {
    let session = self.manager.lock().await
        .get_session(session_id).await
        .ok_or("session not found")?;
    
    let tasks = session.task_list.lock().await.clone();
    
    Ok(json!({
        "tasks": tasks,
        "summary": format_task_summary(&tasks),
    }))
}
```

#### `task_write` Tool

Orchestrator only. Does NOT require `session_id` as input — the backend knows which session owns the task list.

```rust
"session/task_write" | "session/taskWrite" => {
    let action = params.get("action")
        .and_then(|v| v.as_str())
        .ok_or("missing action")?;
    
    let session = self.manager.lock().await
        .get_session(session_id).await
        .ok_or("session not found")?;
    
    match action {
        "create" => {
            let title = params.get("title")
                .and_then(|v| v.as_str())
                .ok_or("missing title")?;
            let description = params.get("description")
                .and_then(|v| v.as_str());
            
            let task = Task {
                id: uuid::Uuid::new_v4().to_string(),
                title: title.to_string(),
                description: description.map(String::from),
                status: TaskStatus::Pending,
                assigned_to: None,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            };
            
            session.task_list.lock().await.push(task.clone());
            session.task_queue.lock().await.push_back(task.clone());
            broadcast_task_list(&session).await;
            
            Ok(json!({ "task": task }))
        }
        "update" => {
            let task_id = params.get("taskId")
                .and_then(|v| v.as_str())
                .ok_or("missing taskId")?;
            
            let mut tasks = session.task_list.lock().await;
            if let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) {
                if let Some(status) = params.get("status").and_then(|v| v.as_str()) {
                    task.status = serde_json::from_str(&format!("\"{}\"", status))
                        .unwrap_or(TaskStatus::InProgress);
                }
                if let Some(assigned) = params.get("assignedTo").and_then(|v| v.as_str()) {
                    task.assigned_to = Some(assigned.to_string());
                }
                task.updated_at = chrono::Utc::now();
                
                let updated = task.clone();
                drop(tasks);
                broadcast_task_list(&session).await;
                
                Ok(json!({ "task": updated }))
            } else {
                Err("task not found".into())
            }
        }
        "delete" => {
            let task_id = params.get("taskId")
                .and_then(|v| v.as_str())
                .ok_or("missing taskId")?;
            
            session.task_list.lock().await.retain(|t| t.id != task_id);
            session.task_queue.lock().await.retain(|t| t.id != task_id);
            broadcast_task_list(&session).await;
            
            Ok(json!({ "success": true }))
        }
        _ => Err(format!("unknown action: {}", action).into())
    }
}
```

#### `task_send` Tool

Instructor only. Sends a batch of tasks to an orchestrator session. Requires `toSessionId` because the instructor needs to specify which orchestrator receives the work.

```rust
"session/task_send" | "session/taskSend" => {
    let to_session_id = params.get("toSessionId")
        .and_then(|v| v.as_str())
        .ok_or("missing toSessionId")?;
    let task_defs: Vec<Value> = params.get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    
    let target_session = {
        let manager = self.manager.lock().await;
        manager.get_session(to_session_id).await
            .ok_or("target session not found")?
    };
    
    // Build tasks from definitions
    let mut tasks = Vec::new();
    for def in &task_defs {
        let title = def.get("title").and_then(|v| v.as_str())
            .ok_or("task missing title")?;
        tasks.push(Task {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.to_string(),
            description: def.get("description").and_then(|v| v.as_str()).map(String::from),
            status: TaskStatus::Pending,
            assigned_to: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        });
    }
    
    // Set target's task list
    {
        let mut target_tasks = target_session.task_list.lock().await;
        *target_tasks = tasks.clone();
    }
    {
        let mut target_queue = target_session.task_queue.lock().await;
        *target_queue = tasks.iter().cloned().collect();
    }
    
    broadcast_task_list(&target_session).await;
    
    // Send first task as prompt to kick off the orchestrator
    if let Some(first) = tasks.first() {
        target_session.prompt(vec![text_block(&format!(
            "Starting task list. First task: {}", first.title
        ))]).await?;
    }
    
    Ok(json!({
        "success": true,
        "taskCount": tasks.len(),
        "toSessionId": to_session_id,
    }))
}
```

#### Task List Broadcast

When the task list changes, emit a `session/plan` update so the frontend renders it:

```rust
async fn broadcast_task_list(session: &AcpSession) {
    let tasks = session.task_list.lock().await.clone();
    let update = json!({
        "sessionUpdate": "plan",
        "tasks": tasks,
    });
    let _ = session.events_tx.send(SessionEvent::Update {
        session_id: session.session_id(),
        update,
    });
}
```

### Phase 4: Frontend UI

#### Task List Panel

Render task list in the chat sidebar when a `plan` update arrives:

```typescript
// In acpStore.ts
private _handleSessionEvent(event: SessionEvent) {
    const update = event.update;
    
    if (update.sessionUpdate === 'plan') {
        this._taskList = update.tasks;
        this._emitter.fire({ type: 'taskListChanged', tasks: this._taskList });
    }
    
    if (update.sessionUpdate === '_send') {
        this._emitter.fire({ type: 'sendCallback', data: update });
    }
}
```

#### Send Block Component

Render `_send` updates inline in the chat:

```typescript
class SendBlock extends Component {
    constructor(data: { fromSessionId: string; toSessionId: string; summary: string }) {
        super('div', 'sc-send-block');
        
        const header = this.append('div', 'sc-send-header');
        header.textContent = `← Response from ${data.fromSessionId}`;
        
        const body = this.append('div', 'sc-send-body');
        body.innerHTML = renderMarkdown(data.summary);
    }
}
```

## ACP Protocol Extensions Summary

| Method | Direction | Type | Purpose |
|--------|-----------|------|---------|
| `session/list_sessions` | agent → client | request/response | Discover available sessions |
| `session/send` | agent → client | request/response (immediate) | Initiate async send |
| `_send` (in `session/update`) | client → agent | notification | Deliver async callback |
| `session/task_read` | agent → client | request/response | Read task list |
| `session/task_write` | agent → client | request/response | Modify task list |
| `session/task_send` | agent → client | request/response | Send task batch to orchestrator |

## Testing

### Unit Tests

```rust
#[tokio::test]
async fn test_list_sessions_returns_active() {
    let manager = setup_test_manager().await;
    let s1 = create_test_session(&manager, "worker-1").await;
    let s2 = create_test_session(&manager, "worker-2").await;
    
    let sessions = manager.list_sessions_with_info("").await;
    assert_eq!(sessions.len(), 2);
}

#[tokio::test]
async fn test_send_returns_immediately() {
    let manager = setup_test_manager().await;
    let caller = create_test_session(&manager, "orchestrator").await;
    let target = create_test_session(&manager, "worker").await;
    
    // send should return before target completes
    let result = caller.call_tool("session/send", json!({
        "toSessionId": target.session_id(),
        "blocks": [{"type": "text", "text": "do something"}]
    })).await;
    
    assert_eq!(result["status"], "sent");
}

#[tokio::test]
async fn test_delegation_state_transitions() {
    // NotCalled → WaitingForResponse (on send)
    // WaitingForResponse → Responding (on _send callback)
    // Responding → NotCalled (on new prompt)
}

#[tokio::test]
async fn test_task_write_crud() {
    let session = create_test_session().await;
    
    // Create
    session.call_tool("session/task_write", json!({
        "action": "create",
        "title": "Fix auth bug"
    })).await;
    
    assert_eq!(session.task_list.lock().await.len(), 1);
    
    // Update
    let task_id = &session.task_list.lock().await[0].id;
    session.call_tool("session/task_write", json!({
        "action": "update",
        "taskId": task_id,
        "status": "completed"
    })).await;
    
    assert!(matches!(
        session.task_list.lock().await[0].status,
        TaskStatus::Completed
    ));
}
```

### Integration Test

1. Start three agent sessions: Instructor (A), Orchestrator (B), Worker (C)
2. Instructor calls `task_send` with 3 tasks to Orchestrator
3. Orchestrator receives first task, delegates to Worker via `send`
4. Worker completes task, backend sends `_send` callback to Orchestrator
5. Orchestrator marks task complete via `task_write`, processes next task
6. All 3 tasks complete, Orchestrator summarizes
7. Verify task list UI updates in real-time across all sessions

## Future Work

- **Programmatic session spawning** — agents create new sessions via `session/spawn`
- **MCP server for orchestration** — expose tools to external agents
- **Persistent task lists** — SQLite storage survives backend restarts
- **Orchestration graph visualization** — render agent relationships and message flow
- **Session affinity** — orchestrator remembers which worker handled which task type
- **Cost tracking** — aggregate token usage across orchestrated sessions
