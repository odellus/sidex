//! Orchestration tools v2: _send, task_read, task_write, task_send
//!
//! ## Design (v2)
//!
//! - `task_read` / `task_write` are pure CRUD on `OrchestrationState.task_list`.
//! - `_send` sets `WaitingForResponse`, returns immediately, then spawns an
//!   async callback that: prompts the worker, re-prompts for a summary,
//!   captures the summary, sets `Responding`, and sends the summary back to
//!   the caller via `session/prompt` (caller.prompt). The prompt queue
//!   handles serialization — if the caller is busy, the summary is queued.
//!   `delegation_notify` wakes the task loop if one is running.
//! - `task_send` populates a target session's task list.
//! - The task loop in `prompt_2.rs` blocks on `delegation_notify` when
//!   `WaitingForResponse`, so no frontend roundtrip is needed.

use serde_json::{json, Value};
use std::sync::Arc;

use agent_client_protocol_schema as acp;

use super::ToolContext;
use crate::session::{SessionEvent, Task, TaskStatus};
use crate::manager::AcpSessionManager;
use crate::acp_log;

/// Helper: create a text content block as a JSON Value for prompt().
fn text_block(text: impl Into<String>) -> Value {
    serde_json::to_value(&acp::ContentBlock::Text(
        acp::TextContent::new(text)
    )).unwrap()
}

// ─── _send ────────────────────────────────────────────────────────────────

/// Send a prompt to another session (async two-step communication).
///
/// Flow:
/// 1. Sets caller's delegation state to `WaitingForResponse`, returns immediately.
/// 2. Spawned task: prompts worker with the message blocks.
/// 3. Spawned task: re-prompts worker with "summarize, call no tools".
/// 4. Spawned task: captures summary text from the worker's event stream.
/// 5. Spawned task: sets caller's state to `Responding` with the summary,
///    sends the summary back to the caller via `session/prompt`, and wakes
///    the task loop via `delegation_notify`.
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
        caller.orchestration.lock().await.set_waiting_for_response();
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
        let summary_blocks = vec![text_block(
            "Summarize what you just accomplished in a lengthy RESTful markdown in the chat describing what you did and. Do not call any tools."
        )];

        // Subscribe to events before prompting so we don't miss chunks
        let mut event_rx = target_session.subscribe();

        let was_busy = target_session.is_prompt_busy().await;
        if let Err(e) = target_session.prompt(summary_blocks).await {
            acp_log!("ERROR", "send_to_session: summary prompt failed: {}", e);
            send_error_callback(&manager, &from_session_id_clone, &to_session_id_clone, &e.to_string()).await;
            return;
        }
        if was_busy {
            acp_log!("WARN", "send_to_session: target was busy, summary prompt was queued — event capture may see wrong prompt_complete");
        }

        // Step 3: Capture summary text from events
        let mut summary = String::new();
        let mut chunk_count = 0u32;
        while let Ok(event) = event_rx.recv().await {
            if let SessionEvent::Update { ref update, .. } = event {
                match update.get("sessionUpdate").and_then(|v| v.as_str()) {
                    Some("agent_message_chunk") => {
                        if let Some(text) = update.get("content")
                            .and_then(|c| c.get("text"))
                            .and_then(|t| t.as_str())
                        {
                            summary.push_str(text);
                            chunk_count += 1;
                        }
                    }
                    Some("prompt_complete") => {
                        acp_log!(
                            "INFO",
                            "send_to_session: event loop broke on prompt_complete ({} chunks, {} bytes)",
                            chunk_count,
                            summary.len()
                        );
                        break;
                    }
                    _ => {}
                }
            }
        }

        if summary.is_empty() {
            acp_log!("WARN", "send_to_session: captured empty summary from {}", to_session_id_clone);
        }

        // Step 4: Send the summary back to the caller via session/prompt.
        // The prompt queue handles serialization: if the caller is busy
        // (e.g. its task loop is running), the summary is queued and drained
        // after the current turn. If the caller is idle, it's sent immediately.
        // delegation_notify wakes the task loop if one is blocked waiting.
        if let Some(caller_session) = manager.get_session(&from_session_id_clone).await {
            caller_session.orchestration.lock().await.set_responding(summary.clone());

            let reply_blocks = vec![text_block(format!(
                "Response from session {}:\n\n{}",
                to_session_id_clone, summary
            ))];
            if let Err(e) = caller_session.prompt(reply_blocks).await {
                acp_log!("ERROR", "send_to_session: sending reply to calling agent failed: {}", e);
                send_error_callback(&manager, &from_session_id_clone, &to_session_id_clone, &e.to_string()).await;
                return;
            }

            caller_session.delegation_notify.notify_one();

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

/// Send an error back to the calling session via session/prompt.
async fn send_error_callback(
    manager: &Arc<AcpSessionManager>,
    from_session_id: &str,
    to_session_id: &str,
    error: &str,
) {
    if let Some(caller_session) = manager.get_session(from_session_id).await {
        caller_session.orchestration.lock().await
            .set_responding(format!("Error: {}", error));

        let reply_blocks = vec![text_block(format!(
            "Error from session {}: {}",
            to_session_id, error
        ))];
        if let Err(e) = caller_session.prompt(reply_blocks).await {
            acp_log!("ERROR", "send_error_callback: failed to send error to caller: {}", e);
        }

        caller_session.delegation_notify.notify_one();
    }
}

// ─── task_read ────────────────────────────────────────────────────────────

/// Read the task list for the current session.
pub async fn task_read(_params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager
        .get_session(&ctx.session_id)
        .await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;

    let tasks = session.orchestration.lock().await.task_list.clone();
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

    let pending = tasks.iter().filter(|t| t.status == TaskStatus::Pending).count();
    let in_progress = tasks.iter().filter(|t| t.status == TaskStatus::InProgress).count();
    let completed = tasks.iter().filter(|t| t.status == TaskStatus::Completed).count();
    let failed = tasks.iter().filter(|t| t.status == TaskStatus::Failed).count();

    format!(
        "Total: {} | Pending: {} | In Progress: {} | Completed: {} | Failed: {}",
        tasks.len(),
        pending,
        in_progress,
        completed,
        failed,
    )
}

// ─── task_write ───────────────────────────────────────────────────────────

/// Write/update/delete tasks in the session's task list.
pub async fn task_write(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let action = params
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or("missing action")?;

    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager
        .get_session(&ctx.session_id)
        .await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;

    match action {
        "create" => {
            let title = params
                .get("title")
                .and_then(|v| v.as_str())
                .ok_or("missing title")?;
            let description = params
                .get("description")
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

            session.orchestration.lock().await.task_list.push(task.clone());
            session.broadcast_task_list().await;

            acp_log!("INFO", "Created task: {}", task.title);

            serde_json::to_value(json!({ "task": task })).map_err(|e| e.to_string())
        }
        "update" => {
            let task_id = params
                .get("taskId")
                .and_then(|v| v.as_str())
                .ok_or("missing taskId")?;

            let mut orch = session.orchestration.lock().await;
            if let Some(task) = orch.task_list.iter_mut().find(|t| t.id == task_id) {
                if let Some(status) = params.get("status").and_then(|v| v.as_str()) {
                    task.status = parse_status(status)?;
                }
                if let Some(assigned) = params.get("assignedTo").and_then(|v| v.as_str()) {
                    task.assigned_to = Some(assigned.to_string());
                }
                task.updated_at = chrono::Utc::now();

                let updated = task.clone();
                drop(orch);
                session.broadcast_task_list().await;

                acp_log!("INFO", "Updated task {}: {:?}", updated.id, updated.status);

                serde_json::to_value(json!({ "task": updated })).map_err(|e| e.to_string())
            } else {
                Err("task not found".into())
            }
        }
        "delete" => {
            let task_id = params
                .get("taskId")
                .and_then(|v| v.as_str())
                .ok_or("missing taskId")?;

            {
                let mut orch = session.orchestration.lock().await;
                orch.task_list.retain(|t| t.id != task_id);
            }
            session.broadcast_task_list().await;

            acp_log!("INFO", "Deleted task: {}", task_id);

            serde_json::to_value(json!({ "success": true })).map_err(|e| e.to_string())
        }
        _ => Err(format!("unknown action: {}", action)),
    }
}

fn parse_status(s: &str) -> Result<TaskStatus, String> {
    match s {
        "pending" => Ok(TaskStatus::Pending),
        "in_progress" => Ok(TaskStatus::InProgress),
        "completed" => Ok(TaskStatus::Completed),
        "failed" => Ok(TaskStatus::Failed),
        _ => Err(format!("unknown status: {s}")),
    }
}

// ─── task_send ────────────────────────────────────────────────────────────

/// Send a batch of tasks to an orchestrator session.
///
/// Populates the target session's task list, then kicks off the target's
/// task loop (which promotes the first Pending task → InProgress and prompts
/// the orchestrator with it). The loop is concurrency-guarded, so if the
/// orchestrator is already mid-loop this is a safe no-op — the existing loop
/// picks up the freshly-populated tasks on its next `determine_next_prompt`.
pub async fn task_send(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let to_session_id = params
        .get("toSessionId")
        .and_then(|v| v.as_str())
        .ok_or("missing toSessionId")?;
    let task_defs: Vec<Value> = params
        .get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let target_session = manager
        .get_session(to_session_id)
        .await
        .ok_or_else(|| format!("target session not found: {}", to_session_id))?;

    // Build tasks from definitions
    let mut tasks = Vec::new();
    for def in &task_defs {
        let title = def
            .get("title")
            .and_then(|v| v.as_str())
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
        let mut orch = target_session.orchestration.lock().await;
        orch.task_list = tasks.clone();
        orch.summarized = false; // reset in case of re-use
    }

    target_session.broadcast_task_list().await;

    acp_log!(
        "INFO",
        "Sent {} tasks from {} to {}; starting orchestrator loop",
        tasks.len(),
        ctx.session_id,
        to_session_id
    );

    // Kick off the target orchestrator's task loop. It will promote the first
    // Pending task and prompt the orchestrator with it. Guarded so a re-send
    // while the loop is active is a no-op (the live loop drains the new tasks).
    let target = target_session.clone();
    tokio::spawn(async move {
        if let Err(e) = target.run_task_loop().await {
            acp_log!("ERROR", "task_send: orchestrator loop failed: {}", e);
        }
    });

    serde_json::to_value(json!({
        "success": true,
        "taskCount": tasks.len(),
        "toSessionId": to_session_id,
    }))
    .map_err(|e| e.to_string())
}
