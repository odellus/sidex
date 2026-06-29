//! Orchestration tools v3: _send, task_read, task_write, task_send
//!
//! ## Design (v3 — bipartite)
//!
//! - `task_read` reads `OrchestrationState.task_list`.
//! - `task_write` wholesale-replaces `task_list` with a new `todos` array
//!   (full-replace model, like OpenCode's TodoWrite). No CRUD, no action
//!   field — the agent regenerates the entire list each call.
//! - `_send` is fire-and-forget: spawns `target.prompt()` and returns
//!   immediately. When the target finishes, a canned "done" notification is
//!   sent to the caller via the same queue, telling it to `query_memory` for
//!   results. No delegation state, no summary capture.
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
/// Spawns `target.prompt()` so this call returns immediately. When the
/// target finishes (success or error), `notify_caller_send_done` sends a
/// canned message to the caller through the same queue, telling it to
/// `query_memory` for results. The queue serializes if either the target
/// or the caller is busy.
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

    // Fire and forget: spawn the prompt so this call returns immediately.
    // When the target finishes, notify the caller via the queue.
    let target = target_session.clone();
    let caller_session_id = ctx.session_id.clone();
    tokio::spawn(async move {
        let result = target.prompt(blocks).await;
        notify_caller_send_done(&target, &caller_session_id, &result).await;
    });

    acp_log!("INFO", "send_to_session: sent from {} to {}",
             ctx.session_id, to_session_id);

    serde_json::to_value(json!({
        "status": "sent",
        "toSessionId": to_session_id,
    }))
    .map_err(|e| e.to_string())
}

// ─── Completion notification for _send ─────────────────────────────────────

/// Notify the caller that a `_send` target has finished processing.
///
/// Sends a canned message telling the caller to `query_memory` for results.
/// Called from `send_to_session`'s spawned task after `prompt()` returns
/// (both success and error paths). Uses `caller.prompt()` so the queue
/// serializes if the caller is busy.
async fn notify_caller_send_done(
    worker: &AcpSession,
    caller_session_id: &str,
    result: &anyhow::Result<()>,
) {
    let manager = match worker.get_manager().await {
        Some(m) => m,
        None => {
            acp_log!(
                "WARN",
                "notify_caller_send_done: manager unavailable, cannot notify caller {}",
                caller_session_id
            );
            return;
        }
    };
    let caller = match manager.get_session(caller_session_id).await {
        Some(c) => c,
        None => {
            acp_log!(
                "WARN",
                "notify_caller_send_done: caller session {} not found",
                caller_session_id
            );
            return;
        }
    };

    let worker_sid = worker.session_id();
    let text = match result {
        Ok(()) => format!(
            "Session {} has finished. \
             Call query_memory with session_id=\"{}\", limit=1 \
             to see what it did.",
            worker_sid, worker_sid,
        ),
        Err(e) => format!(
            "Session {} finished with an error: {}. \
             Call query_memory with session_id=\"{}\" to check for partial results.",
            worker_sid, e, worker_sid,
        ),
    };

    let blocks = vec![json!({
        "type": "text",
        "text": text,
    })];

    if let Err(e) = caller.prompt(blocks).await {
        acp_log!(
            "ERROR",
            "notify_caller_send_done: failed to notify caller {}: {}",
            caller_session_id,
            e
        );
    } else {
        acp_log!(
            "INFO",
            "Notified caller {} that session {} is done",
            caller_session_id,
            worker_sid
        );
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
    let cancelled = tasks.iter().filter(|t| t.status == TaskStatus::Cancelled).count();

    format!(
        "Total: {} | Pending: {} | In Progress: {} | Completed: {} | Failed: {} | Cancelled: {}",
        tasks.len(),
        pending,
        in_progress,
        completed,
        failed,
        cancelled,
    )
}

// ─── task_write ───────────────────────────────────────────────────────────

/// Wholesale-replace the session's task list.
///
/// Takes a `todos` array (like OpenCode's TodoWrite). Each call replaces the
/// entire task list — the agent regenerates the full list with updated
/// statuses each time. No CRUD, no action field.
pub async fn task_write(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let todos = params
        .get("todos")
        .and_then(|v| v.as_array())
        .ok_or("missing todos")?;

    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager
        .get_session(&ctx.session_id)
        .await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;

    // Build the new task list from the todos array
    let now = chrono::Utc::now();
    let tasks: Vec<Task> = todos
        .iter()
        .enumerate()
        .map(|(i, todo)| Task {
            id: uuid::Uuid::new_v4().to_string(),
            title: todo
                .get("content")
                .or_else(|| todo.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or(&format!("Task {}", i + 1))
                .to_string(),
            description: None,
            status: todo
                .get("status")
                .and_then(|v| v.as_str())
                .and_then(parse_status)
                .unwrap_or(TaskStatus::Pending),
            priority: todo
                .get("priority")
                .and_then(|v| v.as_str())
                .unwrap_or("medium")
                .to_string(),
            assigned_to: todo
                .get("assignedTo")
                .and_then(|v| v.as_str())
                .map(String::from),
            created_at: now,
            updated_at: now,
        })
        .collect();

    // Full replace: clear both task_list and current_task.
    // The loop will re-sync via determine_next_prompt on its next iteration.
    {
        let mut orch = session.orchestration.lock().await;
        orch.task_list = tasks.clone();
        orch.current_task = None;
    }

    session.broadcast_task_list().await;

    acp_log!("INFO", "task_write: replaced task list with {} items", tasks.len());

    serde_json::to_value(json!({ "tasks": tasks })).map_err(|e| e.to_string())
}

fn parse_status(s: &str) -> Option<TaskStatus> {
    match s {
        "pending" => Some(TaskStatus::Pending),
        "in_progress" => Some(TaskStatus::InProgress),
        "completed" => Some(TaskStatus::Completed),
        "failed" => Some(TaskStatus::Failed),
        "cancelled" => Some(TaskStatus::Cancelled),
        _ => None,
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
            priority: "medium".to_string(),
            assigned_to: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        });
    }

    // Set target's task list and record the caller for the completion callback
    {
        let mut orch = target_session.orchestration.lock().await;
        orch.task_list = tasks.clone();
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
