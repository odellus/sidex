//! Agent Client Protocol (ACP) integration for SideX.
//!
//! Spawns `crow-cli` agent subprocesses and bridges ACP JSON-RPC over stdio
//! to Tauri events for the frontend. This is the backend client — it owns
//! all session state, queues, and agent processes. The frontend is a passive
//! viewer that receives `acp:sessionUpdate` events.

mod agent;
pub mod manager;
pub mod session;

pub use agent::{AgentConfig, AgentManager};
pub use manager::{AcpSessionManager, SessionEvent};
pub use session::{PromptTurnState, TerminalEvent};
