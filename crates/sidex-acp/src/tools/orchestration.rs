//! Orchestration tools: _send, _queue/*, task_read, task_write, task_send

use serde_json::{json, Value};
use agent_client_protocol_schema as acp;
use std::sync::Arc;

use super::ToolContext;
use crate::session::{SessionEvent, DelegationState, Task, TaskStatus};
use crate::acp_log;
use crate::manager::AcpSessionManager;

/// Helper: create a text content block as a JSON Value for prompt().
fn text_block(text: impl Into<String>) -> Value {
    serde_json::to_value(&acp::ContentBlock::Text(
        acp::TextContent::new(text)
    )).unwrap()
}

/// Send a message to another session (two-step async communication).
///
/// Flow:
/// 1. Returns immediately with {"status": "sent"}
/// 2. Backend prompts target session with message
/// 3. Target works (react loop, tools, etc.)
/// 4. Target finishes (prompt response with stopReason)
/// 5. Backend re-prompts target: "Summarize what you did, call no tools"
/// 6. Backend captures summary text from target's response
/// 7. Backend sends _send notification to caller with summary
pub async fn send_to_session(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let to_session_id = params.get("toSessionId")
        .and_then(|v| v.as_str())
        .ok_or("missing toSessionId")?;
    let blocks: Vec<Value> = params.get("blocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let from_session_id = ctx.session_id.clone();
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;

    // Find target session
    let target_session = manager.get_session(to_session_id).await
        .ok_or_else(|| format!("target session not found: {}", to_session_id))?;

    // Set caller's delegation state to WaitingForResponse
    {
        let caller = manager.get_session(&from_session_id).await
            .ok_or_else(|| format!("caller session not found: {}", from_session_id))?;
        *caller.delegation_state.lock().await = DelegationState::WaitingForResponse;
    }

    // Spawn async task to handle the full send flow
    let manager = manager.clone();
    let target_session = target_session.clone();
    let from_session_id_clone = from_session_id.clone();
    let to_session_id_clone = to_session_id.to_string();

    tokio::spawn(async move {
        // Step 1: Send prompt to target
        let acp_blocks: Vec<Value> = blocks.iter()
            .cloned()
            .collect();

        if let Err(e) = target_session.prompt(acp_blocks).await {
            acp_log!("ERROR", "send_to_session: prompt failed: {}", e);
            send_error_callback(&manager, &from_session_id_clone, &to_session_id_clone, &e.to_string()).await;
            return;
        }

        // Step 2: Re-prompt for summary (no tools)
        let summary_blocks = vec![text_block("Summarize what you just accomplished in a lengthy RESTful markdown in the chat describing what you did and. Do not call any tools.")];

        // Subscribe to events before prompting so we don't miss chunks
        let mut event_rx = target_session.subscribe();

        if let Err(e) = target_session.prompt(summary_blocks).await {
            acp_log!("ERROR", "send_to_session: summary prompt failed: {}", e);
            send_error_callback(&manager, &from_session_id_clone, &to_session_id_clone, &e.to_string()).await;
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

        // Step 4: Send _send notification to caller agent
        if let Some(caller_session) = manager.get_session(&from_session_id_clone).await {
            *caller_session.delegation_state.lock().await = DelegationState::Responding;

            let update = json!({
                "sessionUpdate": "_send",
                "fromSessionId": to_session_id_clone,
                "toSessionId": from_session_id_clone,
                "summary": summary,
                "status": "completed"
            });

            // Send _send notification to the client (UI) via the event stream
            // The client will then inject it as a new user prompt to the caller agent
            let _ = caller_session.events_tx.send(SessionEvent::Update {
                session_id: from_session_id_clone.clone(),
                update,
            });

            acp_log!("INFO", "Sent _send callback from {} to {}: {}",
                     to_session_id_clone, from_session_id_clone, summary);
        }
    });

    // Return immediately — agent's turn continues
    acp_log!("INFO", "send_to_session: initiated async send from {} to {}",
             from_session_id, to_session_id);

    serde_json::to_value(json!({
        "status": "sent",
        "toSessionId": to_session_id
    }))
    .map_err(|e| e.to_string())
}

/// Send error callback to caller when send fails.
async fn send_error_callback(
    manager: &Arc<AcpSessionManager>,
    from_session_id: &str,
    to_session_id: &str,
    error: &str,
) {
    if let Some(caller_session) = manager.get_session(from_session_id).await {
        *caller_session.delegation_state.lock().await = DelegationState::Responding;

        let update = json!({
            "sessionUpdate": "_send",
            "fromSessionId": to_session_id,
            "toSessionId": from_session_id,
            "summary": format!("Error: {}", error),
            "status": "error"
        });

        // Send _send error notification directly to the caller agent via extension method
        if let Err(e) = caller_session.send_ext_notification("_send", update.clone()).await {
            acp_log!("ERROR", "Failed to send _send error notification to agent: {}", e);
        }

        // Also broadcast to UI/frontend
        let _ = caller_session.events_tx.send(SessionEvent::Update {
            session_id: from_session_id.to_string(),
            update,
        });
    }
}

/// Read the task list for the current session.
pub async fn task_read(_params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;

    let tasks = session.task_list.lock().await.clone();
    let summary = format_task_summary(&tasks);

    serde_json::to_value(json!({
        "tasks": tasks,
        "summary": summary,
    }))
    .map_err(|e| e.to_string())
}

fn format_task_summary(tasks: &[Task]) -> String {
    if tasks.is_empty() {
        return "No tasks".to_string();
    }

    let pending = tasks.iter().filter(|t| matches!(t.status, TaskStatus::Pending)).count();
    let in_progress = tasks.iter().filter(|t| matches!(t.status, TaskStatus::InProgress)).count();
    let completed = tasks.iter().filter(|t| matches!(t.status, TaskStatus::Completed)).count();
    let failed = tasks.iter().filter(|t| matches!(t.status, TaskStatus::Failed)).count();

    format!("Total: {} | Pending: {} | In Progress: {} | Completed: {} | Failed: {}",
            tasks.len(), pending, in_progress, completed, failed)
}

/// Write/update/delete tasks in the session's task list.
pub async fn task_write(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let action = params.get("action")
        .and_then(|v| v.as_str())
        .ok_or("missing action")?;

    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;

    match action {
        "create" => {
            let title = params.get("title")
                .and_then(|v| v.as_str())
                .ok_or("missing title")?;
            let description = params.get("description")
                .and_then(|v| v.as_str())
                .map(String::from);

            let task = Task {
                id: uuid::Uuid::new_v4().to_string(),
                title: title.to_string(),
                description,
                status: TaskStatus::Pending,
                assigned_to: None,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            };

            session.task_list.lock().await.push(task.clone());
            session.task_queue.lock().await.push_back(task.clone());
            broadcast_task_list(&session).await;

            acp_log!("INFO", "Created task: {}", task.title);

            serde_json::to_value(json!({ "task": task }))
                .map_err(|e| e.to_string())
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

                acp_log!("INFO", "Updated task {}: {:?}", updated.id, updated.status);

                serde_json::to_value(json!({ "task": updated }))
                    .map_err(|e| e.to_string())
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

            acp_log!("INFO", "Deleted task: {}", task_id);

            serde_json::to_value(json!({ "success": true }))
                .map_err(|e| e.to_string())
        }
        _ => Err(format!("unknown action: {}", action))
    }
}

/// Send a batch of tasks to an orchestrator session.
pub async fn task_send(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let to_session_id = params.get("toSessionId")
        .and_then(|v| v.as_str())
        .ok_or("missing toSessionId")?;
    let task_defs: Vec<Value> = params.get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let target_session = manager.get_session(to_session_id).await
        .ok_or_else(|| format!("target session not found: {}", to_session_id))?;

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
        let blocks = vec![text_block(format!("Starting task list. First task: {}", first.title))];

        target_session.prompt(blocks).await
            .map_err(|e| format!("failed to send first task: {}", e))?;
    }

    acp_log!("INFO", "Sent {} tasks from {} to {}",
             tasks.len(), ctx.session_id, to_session_id);

    serde_json::to_value(json!({
        "success": true,
        "taskCount": tasks.len(),
        "toSessionId": to_session_id,
    }))
    .map_err(|e| e.to_string())
}

/// Broadcast task list as a proper ACP Plan update to all clients viewing this session.
async fn broadcast_task_list(session: &Arc<crate::session::AcpSession>) {
    let tasks = session.task_list.lock().await.clone();
    
    // Convert tasks to ACP PlanEntry format
    let entries: Vec<Value> = tasks.iter().map(|t| {
        let status = match t.status {
            TaskStatus::Pending => "pending",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "completed", // ACP doesn't have "failed", map to completed
        };
        let priority = "medium";
        
        let mut entry = json!({
            "content": t.title,
            "priority": priority,
            "status": status,
        });
        
        // Add _meta with task details for client-side routing
        let mut meta = json!({
            "taskId": t.id,
        });
        if let Some(ref desc) = t.description {
            meta["description"] = json!(desc);
        }
        if let Some(ref assigned) = t.assigned_to {
            meta["assignedTo"] = json!(assigned);
        }
        entry["_meta"] = meta;
        
        entry
    }).collect();
    
    let update = json!({
        "sessionUpdate": "plan",
        "entries": entries,
    });
    let _ = session.events_tx.send(SessionEvent::Update {
        session_id: session.session_id(),
        update,
    });
}

/// Handle orchestrator end-of-turn behavior.
/// Called when prompt_complete is received for an orchestrator session.
pub async fn handle_orchestrator_end_turn(session: &Arc<crate::session::AcpSession>) {
    let state = session.delegation_state.lock().await.clone();
    let task_complete = is_current_task_complete(session).await;

    acp_log!("INFO", "Orchestrator end turn: state={:?}, task_complete={}",
             state, task_complete);

    match (state, task_complete) {
        // Delegated and waiting — do nothing, callback will arrive
        (DelegationState::WaitingForResponse, _) => {
            acp_log!("INFO", "Orchestrator waiting for response, no action needed");
        }

        // Received callback but didn't update task status
        (DelegationState::Responding, false) => {
            let blocks = vec![text_block(
                "You received a response from the worker. \
                 If the task is complete, update its status with task_write. \
                 If not, send it back to the worker with feedback."
            )];
            let _ = session.prompt(blocks).await;
        }

        // Never delegated — yell at it
        (DelegationState::NotCalled, false) => {
            let blocks = vec![text_block(
                "You finished your turn without delegating the current task. \
                 Either delegate it to a worker using _send, \
                 or mark it complete with task_write if it's already done."
            )];
            let _ = session.prompt(blocks).await;
        }

        // Task complete — dequeue next or summarize
        (DelegationState::Responding, true) | (DelegationState::NotCalled, true) => {
            let next_task = {
                let mut queue = session.task_queue.lock().await;
                queue.pop_front()
            };

            if let Some(task) = next_task {
                *session.delegation_state.lock().await = DelegationState::NotCalled;
                let blocks = vec![text_block(format!("Next task: {}", task.title))];
                let _ = session.prompt(blocks).await;
            } else {
                let blocks = vec![text_block("All tasks complete. Provide a final summary of what was accomplished.")];
                let _ = session.prompt(blocks).await;
            }
        }
    }
}

/// Check if the current task (most recently updated) is marked complete.
async fn is_current_task_complete(session: &Arc<crate::session::AcpSession>) -> bool {
    let tasks = session.task_list.lock().await;

    if let Some(current) = tasks.iter()
        .max_by_key(|t| t.updated_at)
    {
        matches!(current.status, TaskStatus::Completed)
    } else {
        false
    }
}

/// Add a prompt to the session's queue.
pub async fn queue_add(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let message = params.get("message")
        .and_then(|v| v.as_array())
        .ok_or("missing message array")?;

    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;

    // Check if a prompt is currently running
    let state = session.prompt_turn_state.lock().await;
    let is_running = matches!(*state, crate::session::PromptTurnState::Running);
    drop(state);

    if !is_running {
        return Err("no prompt currently running, send directly instead".into());
    }

    let blocks: Vec<Value> = message.iter().cloned().collect();
    session.queue_add(blocks).await
        .map_err(|e| format!("failed to queue: {}", e))?;

    let queue_len = session.queue_len().await;

    acp_log!("INFO", "Queued message for session {}, queue length: {}",
             ctx.session_id, queue_len);

    serde_json::to_value(json!({
        "success": true,
        "queueLength": queue_len
    }))
    .map_err(|e| e.to_string())
}

/// List queued prompts for the current session.
pub async fn queue_list(_params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;

    let items = session.queue_list().await;

    serde_json::to_value(json!({ "items": items }))
        .map_err(|e| e.to_string())
}

/// Clear the queue for the current session.
pub async fn queue_clear(_params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;

    session.queue_clear().await;

    acp_log!("INFO", "Cleared queue for session {}", ctx.session_id);

    serde_json::to_value(json!({ "success": true }))
        .map_err(|e| e.to_string())
}

/// Remove a specific item from the queue.
pub async fn queue_remove(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let index = params.get("index")
        .and_then(|v| v.as_u64())
        .ok_or("missing index")? as usize;

    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;

    session.queue_remove(index).await
        .ok_or_else(|| format!("invalid queue index: {}", index))?;

    acp_log!("INFO", "Removed queue item {} from session {}", index, ctx.session_id);

    serde_json::to_value(json!({ "success": true }))
        .map_err(|e| e.to_string())
}
