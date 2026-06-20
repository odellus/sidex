//! Prompt lifecycle and queue management (v2 — with task orchestration).
//!
//! This module owns the `prompt()` entry point and the internal task loop.
//! It is intentionally separate from `session.rs` so that alternative
//! implementations (e.g. `prompt.rs` for v1) can be swapped in via `lib.rs`.
//!
//! ## Design (v2)
//!
//! - `run_prompt` executes exactly one `session/prompt` turn and returns.
//! - `prompt()` calls `run_prompt`, then — if the session has active tasks —
//!   hands off to `run_task_loop()`.
//! - `run_task_loop()` repeatedly calls `run_prompt` according to the
//!   delegation state machine in `OrchestrationState`.
//! - When `WaitingForResponse`, the task loop breaks (returns). This releases
//!   `prompt_busy` so the `_send` callback's `caller.prompt()` can deliver the
//!   worker's summary. That new `prompt()` call re-enters `run_task_loop`
//!   with `Responding` state, which sends a nag (without the summary — the
//!   summary was already delivered by `_send`).
//! - `reset_delegation()` is called by the frontend handler (for
//!   user-initiated prompts), NOT by `prompt()` itself, so `_send`'s
//!   `caller.prompt()` preserves the `Responding` state.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Result;
use serde_json::Value;

use agent_client_protocol_schema as acp;
use acp::{ContentBlock, PromptRequest, SessionId};

use crate::session::{AcpSession, PromptTurnState, QueueItem};
use crate::acp_log;

/// RAII guard that resets the `task_loop_running` flag on drop, so the flag is
/// cleared on every exit path (normal completion, early `break`, error via `?`,
/// or panic).
struct TaskLoopGuard(Arc<AtomicBool>);

impl Drop for TaskLoopGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Send a prompt. Returns Ok when complete, Err on failure.
///
/// If a prompt turn is already in progress (including queue draining), the
/// blocks are queued and this returns Ok immediately — they will be sent
/// after the current turn and all previously-queued prompts complete.
/// This serializes all inbound prompts so concurrent calls (user typing
/// while agent works, _send callbacks, task_send) never race.
pub async fn prompt(session: &Arc<AcpSession>, blocks: Vec<Value>) -> Result<()> {
    // Try to acquire the busy lock. If already busy, queue and return.
    {
        let mut busy = session.prompt_busy.lock().await;
        if *busy {
            session.queue.lock().await.push(QueueItem::Prompt(blocks));
            acp_log!(
                "INFO",
                "prompt: session {} busy, queued (queue len={})",
                session.session_id(),
                session.queue.lock().await.len()
            );
            return Ok(());
        }
        *busy = true;
    }

    // We hold the busy lock. Run the prompt, drain the queue, then release.
    session.run_prompt(blocks).await?;

    if session.has_active_task_loop().await {
        session.run_task_loop().await?;
    }

    // Drain queued prompts
    loop {
        let next = {
            let mut q = session.queue.lock().await;
            if q.is_empty() {
                break;
            }
            q.remove(0)
        };
        match next {
            QueueItem::Prompt(blocks) => {
                acp_log!(
                    "INFO",
                    "prompt: draining queued prompt for session {}",
                    session.session_id()
                );
                session.run_prompt(blocks).await?;
                if session.has_active_task_loop().await {
                    session.run_task_loop().await?;
                }
            }
            QueueItem::Task(task) => {
                acp_log!(
                    "INFO",
                    "prompt: draining queued task for session {}",
                    session.session_id()
                );
                // Treat a queued task as a text prompt with its title
                let blocks = vec![serde_json::json!({
                    "type": "text",
                    "text": format!("Task: {}", task.title),
                })];
                session.run_prompt(blocks).await?;
                if session.has_active_task_loop().await {
                    session.run_task_loop().await?;
                }
            }
        }
    }

    // Release the busy lock
    *session.prompt_busy.lock().await = false;

    Ok(())
}

impl AcpSession {
    /// Execute exactly one `session/prompt` turn.
    ///
    /// Sets `prompt_turn_state`, sends the request, broadcasts completion,
    /// and returns. It does **not** check task state or loop.
    pub async fn run_prompt(&self, blocks: Vec<Value>) -> Result<Value> {
        // Clear any stale active terminals from previous turns
        {
            let mut active = self.active_terminals.lock().await;
            active.clear();
        }

        // Deserialize frontend blocks into typed ContentBlocks
        let content_blocks: Vec<ContentBlock> = blocks
            .into_iter()
            .filter_map(|v| match serde_json::from_value(v) {
                Ok(b) => Some(b),
                Err(e) => {
                    acp_log!("WARN", "Failed to deserialize ContentBlock: {}", e);
                    None
                }
            })
            .collect();

        {
            let mut state = self.prompt_turn_state.lock().await;
            *state = PromptTurnState::Running;
        }
        self.broadcast_prompt_state(PromptTurnState::Running);

        let req = PromptRequest::new(SessionId::from(self.session_id()), content_blocks);

        // log the outgoing prompt for diagnostics
        acp_log!(
            "SEND",
            "connection={} method=session/prompt session_id={} blocks_count={}",
            self.connection_id,
            self.session_id(),
            req.prompt.len()
        );

        let result = self.request_no_timeout("session/prompt", req).await;

        match &result {
            Ok(resp) => {
                let stop_reason = resp
                    .get("stopReason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let state = PromptTurnState::Complete {
                    stop_reason: stop_reason.clone(),
                };
                {
                    let mut s = self.prompt_turn_state.lock().await;
                    *s = state.clone();
                }
                self.broadcast_prompt_state(state);
            }
            Err(e) => {
                let state = PromptTurnState::Error {
                    message: e.to_string(),
                };
                {
                    let mut s = self.prompt_turn_state.lock().await;
                    *s = state.clone();
                }
                self.broadcast_prompt_state(state);
            }
        }

        result
    }

    /// Cancel the current prompt turn.
    pub async fn cancel_prompt(&self) -> Result<()> {
        {
            let mut state = self.prompt_turn_state.lock().await;
            *state = PromptTurnState::Cancelled;
        }
        self.broadcast_prompt_state(PromptTurnState::Cancelled);

        // Kill all active terminals for this session
        let terminals_to_kill: Vec<crate::session::SessionTerminal> = {
            let mut active = self.active_terminals.lock().await;
            active.drain().map(|(_, v)| v).collect()
        };
        for term in terminals_to_kill {
            acp_log!(
                "INFO",
                "Killing terminal {:?} for cancelled session {}",
                term.handle,
                self.session_id()
            );
            let _ = tokio::task::spawn_blocking(move || {
                let _ = term.pty.kill_tree();
            }).await;
        }

        let notif = acp::CancelNotification::new(SessionId::from(self.session_id()));
        self.notify("session/cancel", notif).await?;

        // Wake the task loop in case it's blocked waiting for a _send callback
        self.delegation_notify.notify_one();

        Ok(())
    }

    /// True if the prompt turn was cancelled (used by run_task_loop guard).
    async fn is_cancelled(&self) -> bool {
        matches!(
            *self.prompt_turn_state.lock().await,
            PromptTurnState::Cancelled
        )
    }

    /// True if this session has tasks that should drive the task loop.
    pub async fn has_active_task_loop(&self) -> bool {
        let orch = self.orchestration.lock().await;
        orch.current_task.is_some()
            || orch.task_list.iter().any(|t| {
                t.status == crate::session::TaskStatus::Pending
                    || t.status == crate::session::TaskStatus::InProgress
            })
            || (!orch.task_list.is_empty() && !orch.summarized)
    }

    /// Run the task-aware task loop.
    ///
    /// Repeatedly prompts the agent according to the current task and
    /// delegation state. When the agent delegates via `_send`, the loop
    /// breaks (returns) — this releases `prompt_busy` so the `_send`
    /// callback's `caller.prompt()` can deliver the worker's summary.
    /// That new `prompt()` call re-enters `run_task_loop` with `Responding`
    /// state, which sends a nag (without the summary — the summary was
    /// already delivered by `_send`).
    /// Stops when there's nothing left to do or the user cancels.
    pub async fn run_task_loop(&self) -> Result<()> {
        // Concurrency guard: at most one task loop per session. If `task_send`
        // already started the orchestrator's loop (or a user prompt is driving
        // it), don't start a second — the existing loop picks up new tasks via
        // `determine_next_prompt`.
        if self.task_loop_running.swap(true, Ordering::SeqCst) {
            acp_log!(
                "DEBUG",
                "run_task_loop already running for {}, skipping",
                self.session_id()
            );
            return Ok(());
        }
        let _guard = TaskLoopGuard(self.task_loop_running.clone());

        loop {
            // Cancel guard: stop dequeuing if the user cancelled
            if self.is_cancelled().await {
                acp_log!("INFO", "Task loop cancelled for session {}", self.session_id());
                break;
            }

            let decision = {
                let mut orch = self.orchestration.lock().await;
                orch.determine_next_prompt()
            };

            match decision {
                Some(blocks) => {
                    // Broadcast the (possibly updated) task list to the frontend
                    self.broadcast_task_list().await;

                    if let Err(e) = self.run_prompt(blocks).await {
                        acp_log!("ERROR", "Task loop run_prompt failed: {}", e);
                        break;
                    }
                }
                None => {
                    // WaitingForResponse: the agent delegated via _send.
                    // Break out of the loop so prompt() can release
                    // prompt_busy. When _send's callback delivers the summary
                    // via caller.prompt(), that new prompt() call will
                    // re-enter run_task_loop with Responding state.
                    // NotCalled with nothing to do: just break.
                    break;
                }
            }
        }
        Ok(())
    }
}

// ─── Queue methods ──────────────────────────────────────────────────────

/// Add a prompt to the queue.
pub async fn queue_add(session: &Arc<AcpSession>, blocks: Vec<Value>) -> Result<()> {
    session.queue.lock().await.push(crate::session::QueueItem::Prompt(blocks));
    Ok(())
}

/// Get the current queue length.
pub async fn queue_len(session: &Arc<AcpSession>) -> usize {
    session.queue.lock().await.len()
}

/// List queued items.
pub async fn queue_list(session: &Arc<AcpSession>) -> Vec<crate::session::QueueItem> {
    session.queue.lock().await.clone()
}

/// Clear the queue.
pub async fn queue_clear(session: &Arc<AcpSession>) {
    session.queue.lock().await.clear();
}

/// Remove an item from the queue by index.
pub async fn queue_remove(session: &Arc<AcpSession>, index: usize) -> Option<()> {
    let mut queue = session.queue.lock().await;
    if index < queue.len() {
        queue.remove(index);
        Some(())
    } else {
        None
    }
}
