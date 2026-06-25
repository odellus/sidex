//! Orchestration tools v3: _send, task_read, task_write, task_send
//!
//! ## Design (v3 — bipartite)
//!
//! - `task_read` / `task_write` are pure CRUD on `OrchestrationState.task_list`.
//! - `_send` is fire-and-forget: prompts the target session (via the queue,
//!   which serializes if the target is busy) and returns immediately. No
//!   delegation state, no summary capture, no callback. The calling agent
//!   polls the result via `query_memory(session_id, limit=1)`.
//! - `task_send` populates a target session's task list, records the caller
//!   (so the loop can fire a completion callback), and kicks off the target's
//!   task loop. When the loop exits normally (all tasks done or list empty),
//!   a canned "done" notification is sent to the caller via `caller.prompt()`
//!   — again through the queue.

use serde_json::{json, Value};

use super::ToolContext;
use crate::session::{AcpSession, Task, TaskStatus};
use crate::acp_log;

// ─── _send ────────────────────────────────────────────────────────────────

/// Send a prompt to another session (fire-and-forget).
///
/// Prompts the target via `target.prompt()` — the queue serializes if the
/// target is busy. Returns immediately. The calling agent retrieves the
/// response later via `query_memory(toSessionId, limit=1)`.
pub async fn send_to_session(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let to_session_id = params.get("toSessionId")
        .and_then(|v| v.as_str())
        .ok_or("missing toSessionId")?;
    let blocks: Vec<Value> = params.get("blocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let target_session = manager.get_session(to_session_id).await
        .ok_or_else(|| format!("target session not found: {}", to_session_id))?;

    // Fire and forget. The queue handles serialization if the target is busy.
    target_session.prompt(blocks).await
        .map_err(|e| format!("failed to prompt target session: {e}"))?;

    acp_log!("INFO", "send_to_session: sent from {} to {}",
             ctx.session_id, to_session_id);

    serde_json::to_value(json!({
        "status": "sent",
        "toSessionId": to_session_id,
    }))
    .map_err(|e| e.to_string())
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

/// Send a batch of tasks to another session.
///
/// Populates the target session's task list, records the caller (so the
/// loop can fire a completion callback when done), and kicks off the
/// target's task loop. When the loop exits normally (all tasks done or
/// list empty), `notify_caller_done` sends a canned message to the caller
/// via `caller.prompt()` — through the queue, so it's safe if the caller
/// is busy.
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

    // Set target's task list and record the caller for the completion callback
    {
        let mut orch = target_session.orchestration.lock().await;
        orch.task_list = tasks.clone();
        orch.summarized = false;
        orch.current_task = None;
        orch.set_caller(ctx.session_id.clone());
    }

    target_session.broadcast_task_list().await;

    acp_log!(
        "INFO",
        "Sent {} tasks from {} to {}; starting task loop",
        tasks.len(),
        ctx.session_id,
        to_session_id
    );

    // Kick off the target's task loop. Guarded so a re-send while the loop
    // is active is a no-op (the live loop drains the new tasks).
    // After the loop exits, notify_caller_done sends a canned message to the
    // caller. This is in orchestration_3 (not prompt_2) to break the
    // recursive Send cycle: run_task_loop → notify → caller.prompt() →
    // caller.run_task_loop → notify → ...
    let target = target_session.clone();
    tokio::spawn(async move {
        if let Err(e) = target.run_task_loop().await {
            acp_log!("ERROR", "task_send: target task loop failed: {}", e);
        }
        // Only notify the caller if the loop completed normally (not
        // cancelled). Per the bipartite spec, the completion callback
        // fires when the worker "exits normally" — cancellation is not
        // normal completion.
        let cancelled = matches!(
            target.prompt_state().await,
            crate::session::PromptTurnState::Cancelled
        );
        if !cancelled {
            notify_caller_done(&target).await;
        } else {
            acp_log!(
                "INFO",
                "task_send: target loop cancelled, skipping callback to caller"
            );
        }
    });

    serde_json::to_value(json!({
        "success": true,
        "taskCount": tasks.len(),
        "toSessionId": to_session_id,
    }))
    .map_err(|e| e.to_string())
}

// ─── Completion callback ──────────────────────────────────────────────────

/// Send a canned "done" notification to the caller that registered via
/// `task_send`. Tells the caller to `query_memory` for the final summary.
/// The queue serializes this if the caller is busy.
///
/// Called from `task_send`'s spawned task after `run_task_loop` exits.
/// Lives here (not in `prompt_2.rs`) to break the recursive Send cycle:
/// `run_task_loop` → `notify` → `caller.prompt()` → `caller.run_task_loop`
/// → `notify` → ...  By keeping `run_task_loop` free of notification calls,
/// its future is trivially Send, which makes `prompt()` Send, which makes
/// `notify_caller_done` Send.
async fn notify_caller_done(worker: &AcpSession) {
    let (caller_sid, worker_sid) = {
        let orch = worker.orchestration.lock().await;
        match &orch.caller_session_id {
            Some(sid) => (sid.clone(), worker.session_id()),
            None => return, // no caller — standalone task loop
        }
    };

    if let Some(manager) = worker.get_manager().await {
        if let Some(caller) = manager.get_session(&caller_sid).await {
            let blocks = vec![json!({
                "type": "text",
                "text": format!(
                    "Session {} has completed its task list. \
                     Call query_memory with session_id=\"{}\", limit=1 \
                     to see the final summary of what it did.",
                    worker_sid, worker_sid,
                )
            })];
            if let Err(e) = caller.prompt(blocks).await {
                acp_log!("ERROR", "notify_caller_done: failed to notify caller {}: {}", caller_sid, e);
            } else {
                acp_log!("INFO", "Notified caller {} that session {} is done", caller_sid, worker_sid);
            }
        } else {
            acp_log!("WARN", "notify_caller_done: caller session {} not found", caller_sid);
        }
    }
}
