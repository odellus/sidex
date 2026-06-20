//! Agent Client Protocol (ACP) integration for SideX.
//!
//! Spawns `crow-cli` agent subprocesses and bridges ACP JSON-RPC over stdio
//! to Tauri events for the frontend. This is the backend client — it owns
//! all session state, queues, and agent processes. The frontend is a passive
//! viewer that receives `acp:sessionUpdate` events.
//!
//! ## Toggle between prompt implementations
//!
//! To switch between the v1 (basic) and v2 (orchestration) prompt modules,
//! change the `use` statement below.

pub mod agent;
pub mod manager;

// ── Toggle prompt implementation ──────────────────────────────────────────
// Use one of the following (comment out the other):
// pub mod prompt;    // v1 — basic prompt + queue, no orchestration
pub mod prompt_2; // v2 — with task orchestration (task loop)

// Re-export the active implementation as `prompt_impl`
pub mod prompt_impl;

pub mod orchestration_state;
pub mod session;
pub mod tools;

pub use agent::{AgentConfig, AgentManager};
pub use manager::{AcpSessionManager, SessionEvent};
pub use session::{PromptTurnState, TerminalEvent};
