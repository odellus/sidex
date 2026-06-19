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
//! - Tool handlers (`_task/write`, `_send`, etc.) only mutate state. They do
//!   not spawn loops or call `session/prompt` themselves — except `_send`,
//!   which spawns an async callback that re-enters `run_task_loop`.
//!
//! ## Delegation state machine
//!
//! ```text
//! NotCalled → WaitingForResponse → Responding → NotCalled
//!     ↑___________________________________________|
//! ```
//!
//! - `NotCalled`: Agent is free to delegate the current task via `send_prompt`.
//! - `WaitingForResponse`: Agent delegated; we wait for the worker's summary.
//! - `Responding`: Worker summary received; agent must evaluate and mark done.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Result;
use serde_json::Value;

use agent_client_protocol_schema as acp;
use acp::{ContentBlock, PromptRequest, SessionId};

use crate::session::{AcpSession, PromptTurnState};
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
/// After the turn completes, if the session has an active task list, this
/// hands control to `run_task_loop()`.
pub async fn prompt(session: &Arc<AcpSession>, blocks: Vec<Value>) -> Result<()> {
    // Reset delegation state for a new user-initiated prompt
    {
        let mut orch = session.orchestration.lock().await;
        orch.reset_delegation();
    }

    session.run_prompt(blocks).await?;

    if session.has_active_task_loop().await {
        session.run_task_loop().await?;
    }

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

    /// Run the task-aware Ralph loop.
    ///
    /// Repeatedly prompts the agent according to the current task and
    /// delegation state. When the agent delegates via `_send`, the loop
    /// blocks on `delegation_notify` until the callback arrives (instead
    /// of stopping and relying on an external re-trigger).
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
                    // Check if we're waiting for an async _send callback
                    let is_waiting = {
                        let orch = self.orchestration.lock().await;
                        orch.delegation_state == crate::session::DelegationState::WaitingForResponse
                    };
                    if is_waiting {
                        // Block until the callback arrives or the user cancels
                        self.delegation_notify.notified().await;
                    } else {
                        break;
                    }
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
