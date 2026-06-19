//! Orchestration tools v2: _send, task_read, task_write, task_send
//!
//! ## Design (v2)
//!
//! - `task_read` / `task_write` are pure CRUD on `OrchestrationState.task_list`.
//! - `_send` sets `WaitingForResponse`, returns immediately, then spawns an
//!   async callback that: prompts the worker, re-prompts for a summary,
//!   stashes the summary into `OrchestrationState`, sets `Responding`, and
//!   wakes the caller's task loop via `delegation_notify`.
//! - `task_send` populates a target session's task list.
//! - The Ralph loop in `prompt_2.rs` blocks on `delegation_notify` when
//!   `WaitingForResponse`, so no frontend roundtrip is needed.

use serde_json::{json, Value};
use std::sync::Arc;

use super::ToolContext;
use crate::session::{SessionEvent, Task, TaskStatus};
use crate::acp_log;

// ─── _send ────────────────────────────────────────────────────────────────

/// Send a prompt to another session (async two-step communication).
///
/// Flow:
/// 1. Sets caller's delegation state to `WaitingForResponse`, returns immediately.
/// 2. Spawned task: prompts worker with the message blocks.
/// 3. Spawned task: re-prompts worker with "summarize, call no tools".
/// 4. Spawned task: captures summary text from the worker's event stream.
/// 5. Spawned task: sets caller's state to `Responding` with the summary,
///    then calls `delegation_notify.notify_one()` to wake the Ralph loop.
///
/// The Ralph loop sees `Responding`, nags the agent with the worker's summary,
/// and the agent evaluates and marks the task done (or bounces it back).
pub async fn send_to_session(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let to_session_id = params
        .get("toSessionId")
        .and_then(|v| v.as_str())
        .ok_or("missing toSessionId")?;
    let blocks: Vec<Value> = params
        .get("blocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let from_session_id = ctx.session_id.clone();
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;

    let target_session = manager
        .get_session(to_session_id)
        .await
        .ok_or_else(|| format!("target session not found: {}", to_session_id))?;

    // Set caller's delegation state to WaitingForResponse
    {
        let caller = manager
            .get_session(&from_session_id)
            .await
            .ok_or_else(|| format!("caller session not found: {}", from_session_id))?;
        caller.orchestration.lock().await.set_waiting_for_response();
    }

    // Spawn the async two-step flow
    let manager = manager.clone();
    let target = target_session.clone();
    let from = from_session_id.clone();
    let to = to_session_id.to_string();

    tokio::spawn(async move {
        // Subscribe to worker events BEFORE prompting so we don't miss chunks
        let mut event_rx = target.subscribe();

        // Step 1: Send the work to the worker
        if let Err(e) = target.run_prompt(blocks).await {
            acp_log!("ERROR", "_send: worker prompt failed: {}", e);
            set_responding_and_notify(&manager, &from, &format!("Error sending to worker: {e}")).await;
            return;
        }

        // Step 2: Re-prompt worker for summary (no tools)
        let summary_blocks = vec![json!({
            "type": "text",
            "text": "Summarize what you just accomplished. Do not call any tools. \
                     Provide a RESTful markdown summary of what you did and any files you changed."
        })];

        if let Err(e) = target.run_prompt(summary_blocks).await {
            acp_log!("ERROR", "_send: worker summary prompt failed: {}", e);
            set_responding_and_notify(&manager, &from, &format!("Error getting summary: {e}")).await;
            return;
        }

        // Step 3: Capture summary text from the worker's event stream
        let mut summary = String::new();
        while let Ok(event) = event_rx.recv().await {
            match event {
                SessionEvent::Update { ref update, .. } => {
                    match update.get("sessionUpdate").and_then(|v| v.as_str()) {
                        Some("agent_message_chunk") => {
                            if let Some(text) = update
                                .get("content")
                                .and_then(|c| c.get("text"))
                                .and_then(|t| t.as_str())
                            {
                                summary.push_str(text);
                            }
                        }
                        Some("prompt_complete") | Some("prompt_state") => {
                            if update.get("stopReason").is_some() {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                SessionEvent::Disconnected { .. } => break,
            }
        }

        if summary.is_empty() {
            summary = "(worker produced no summary text)".to_string();
        }

        acp_log!("INFO", "_send: callback from {} to {}: {} chars", to, from, summary.len());

        // Step 4: Set Responding + stash summary, then wake the caller's loop
        set_responding_and_notify(&manager, &from, &summary).await;
    });

    acp_log!("INFO", "_send: initiated from {} to {}", from_session_id, to_session_id);

    serde_json::to_value(json!({
        "status": "sent",
        "toSessionId": to_session_id,
    }))
    .map_err(|e| e.to_string())
}

/// Set the caller's delegation state to Responding with the summary,
/// then wake the task loop.
async fn set_responding_and_notify(
    manager: &Arc<crate::manager::AcpSessionManager>,
    from_session_id: &str,
    summary: &str,
) {
    if let Some(caller) = manager.get_session(from_session_id).await {
        {
            let mut orch = caller.orchestration.lock().await;
            orch.set_responding(summary.to_string());
        }
        caller.delegation_notify.notify_one();
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
/// Ralph loop (which promotes the first Pending task → InProgress and prompts
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

    // Kick off the target orchestrator's Ralph loop. It will promote the first
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
