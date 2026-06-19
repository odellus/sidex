//! Prompt lifecycle and queue management (current / v1 implementation).
//!
//! This module owns the `prompt()` / `run_prompt()` loop and the internal
//! prompt queue. It is intentionally separate from `session.rs` so that
//! alternative implementations (e.g. `prompt_2.rs`) can be swapped in via
//! `lib.rs`.

use std::sync::Arc;

use anyhow::Result;
use serde_json::Value;

use agent_client_protocol_schema as acp;
use acp::{ContentBlock, PromptRequest, SessionId};

use crate::session::{AcpSession, PromptTurnState, QueueItem};
use crate::acp_log;

/// Send a prompt. Returns Ok when complete, Err on failure.
/// Broadcasts prompt_state → running when dispatching and prompt_complete when done.
pub async fn prompt(session: &Arc<AcpSession>, blocks: Vec<Value>) -> Result<()> {
    session.run_prompt(blocks).await.map(|_| ())
}

impl AcpSession {
    /// Core prompt runner — sets state, sends to agent, broadcasts result.
    pub(crate) async fn run_prompt(&self, blocks: Vec<Value>) -> Result<Value> {
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
                let state = PromptTurnState::Complete { stop_reason };
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
    pub(crate) async fn cancel_prompt(&self) -> Result<()> {
        {
            let mut state = self.prompt_turn_state.lock().await;
            *state = PromptTurnState::Cancelled;
        }
        self.broadcast_prompt_state(PromptTurnState::Cancelled);

        // Kill all active terminals for this session
        let terminals_to_kill: Vec<crate::session::SessionTerminal> = {
            let mut active = self.active_terminals.lock().await;
            let terms: Vec<crate::session::SessionTerminal> = active.drain().map(|(_, v)| v).collect();
            terms
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
        self.notify("session/cancel", notif).await
    }
}

// ─── Queue methods ──────────────────────────────────────────────────────

/// Add a prompt to the queue.
pub async fn queue_add(session: &Arc<AcpSession>, blocks: Vec<Value>) -> Result<()> {
    session.queue.lock().await.push(QueueItem::Prompt(blocks));
    Ok(())
}

/// Get the current queue length.
pub async fn queue_len(session: &Arc<AcpSession>) -> usize {
    session.queue.lock().await.len()
}

/// List queued items.
pub async fn queue_list(session: &Arc<AcpSession>) -> Vec<QueueItem> {
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
