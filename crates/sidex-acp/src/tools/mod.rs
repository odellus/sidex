//! ACP tool handlers — modular implementations of client-side tools.

pub mod filesystem;
pub mod terminal;
pub mod permissions;
pub mod orchestration_3;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use serde_json::Value;

use crate::session::{SessionTerminal, TerminalEvent};
use crate::acp_log;
use crate::manager::AcpSessionManager;
use crate::agent::AgentConfig;

/// Shared context passed to all tool handlers.
pub struct ToolContext {
    pub active_terminals: Arc<Mutex<HashMap<String, SessionTerminal>>>,
    pub session_id: String,
    pub shell_env: Arc<HashMap<String, String>>,
    pub terminal_events_tx: broadcast::Sender<TerminalEvent>,
    pub manager: Option<Arc<AcpSessionManager>>,
    pub agent_config: AgentConfig,
}

/// Route a tool request to the appropriate handler.
pub async fn route_tool_request(
    method: &str,
    params: &Value,
    ctx: &ToolContext,
) -> Result<Value, String> {
    match method {
        // Filesystem
        "fs/readTextFile" | "fs/read_text_file" => filesystem::read_text_file(params, ctx).await,
        "fs/writeTextFile" | "fs/write_text_file" => filesystem::write_text_file(params, ctx).await,
        
        // Terminal
        "terminal/create" | "terminal/createTerminal" => terminal::create_terminal(params, ctx).await,
        "terminal/output" | "terminal/terminalOutput" => terminal::get_output(params, ctx).await,
        "terminal/waitForExit" | "terminal/wait_for_exit" => terminal::wait_for_exit(params, ctx).await,
        "terminal/kill" | "terminal/killTerminal" => terminal::kill_terminal(params, ctx).await,
        "terminal/release" | "terminal/releaseTerminal" => terminal::release_terminal(params, ctx).await,
        "terminal/cancel" => terminal::cancel_terminal(params, ctx).await,
        
        // Permissions
        "session/requestPermission" | "session/request_permission" => permissions::request_permission(params, ctx).await,
        
        // Orchestration v3 (extension tools, underscore prefix per ACP spec)
        "_send" => orchestration_3::send_to_session(params, ctx).await,
        "_task/read" => orchestration_3::task_read(params, ctx).await,
        "_task/write" => orchestration_3::task_write(params, ctx).await,
        "_task/send" => orchestration_3::task_send(params, ctx).await,
        
        _ => {
            acp_log!("WARN", "Unhandled agent request: {}", method);
            Err(format!("unsupported method: {}", method))
        }
    }
}
