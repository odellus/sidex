# ACP Tools Refactor Design

## Overview

Refactor the monolithic `handle_agent_request()` function in `session.rs` (currently ~400 lines) into a modular tools directory structure. Add orchestration tools for inter-agent communication. Fix terminal cancellation to support killing individual terminals without cancelling the entire prompt turn.

## Current State

The `handle_agent_request()` function in `crates/sidex-acp/src/session.rs` is a single match statement handling:
- Filesystem operations: `fs/readTextFile`, `fs/writeTextFile`
- Terminal operations: `terminal/create`, `terminal/output`, `terminal/waitForExit`, `terminal/kill`, `terminal/release`
- Permissions: `session/requestPermission`

All logic is inline, making it difficult to:
1. Add new tools (orchestration, queue management)
2. Test individual tools in isolation
3. Maintain complex tool implementations
4. Pass shared context (agent config, manager reference) to tools

## Target Architecture

### Directory Structure

```
crates/sidex-acp/src/
  tools/
    mod.rs              # ToolContext, route_tool_request(), re-exports
    filesystem.rs       # fs/* tools
    terminal.rs         # terminal/* tools (refactored from inline)
    permissions.rs      # session/requestPermission
    orchestration.rs    # _send, _queue/* extension tools
  agent.rs              # (unchanged)
  session.rs            # (updated to use tools::route_tool_request)
  manager.rs            # (updated to pass manager reference to ToolContext)
  lib.rs                # (unchanged)
```

### ToolContext

Shared state passed to every tool handler:

```rust
pub struct ToolContext {
    /// Active terminals created by this session.
    pub active_terminals: Arc<Mutex<HashMap<String, SessionTerminal>>>,
    /// Current session ID.
    pub session_id: String,
    /// Shell environment (PATH, etc.) for spawning terminals.
    pub shell_env: Arc<HashMap<String, String>>,
    /// Broadcast channel for terminal events (data, exit).
    pub terminal_events_tx: broadcast::Sender<TerminalEvent>,
    /// Reference to the session manager (for orchestration tools).
    pub manager: Option<Arc<AcpSessionManager>>,
    /// Agent config used to spawn this session.
    pub agent_config: AgentConfig,
}
```

### Tool Router

The router dispatches by method name and passes context:

```rust
pub async fn route_tool_request(
    method: &str,
    params: &Value,
    ctx: &ToolContext,
) -> Result<Value, String> {
    match method {
        // Standard ACP tools
        "fs/readTextFile" | "fs/read_text_file" => filesystem::read_text_file(params, ctx).await,
        "fs/writeTextFile" | "fs/write_text_file" => filesystem::write_text_file(params, ctx).await,
        "terminal/create" | "terminal/createTerminal" => terminal::create_terminal(params, ctx).await,
        "terminal/output" | "terminal/terminalOutput" => terminal::get_output(params, ctx).await,
        "terminal/waitForExit" | "terminal/wait_for_exit" => terminal::wait_for_exit(params, ctx).await,
        "terminal/kill" | "terminal/killTerminal" => terminal::kill_terminal(params, ctx).await,
        "terminal/release" | "terminal/releaseTerminal" => terminal::release_terminal(params, ctx).await,
        "terminal/cancel" => terminal::cancel_terminal(params, ctx).await,
        "session/requestPermission" | "session/request_permission" => permissions::request_permission(params, ctx).await,
        
        // Extension tools (underscore prefix per ACP spec)
        "_send" => orchestration::send_to_session(params, ctx).await,
        "_queue/add" => orchestration::queue_add(params, ctx).await,
        "_queue/list" => orchestration::queue_list(params, ctx).await,
        "_queue/clear" => orchestration::queue_clear(params, ctx).await,
        "_queue/remove" => orchestration::queue_remove(params, ctx).await,
        
        _ => {
            acp_log!("WARN", "Unhandled agent request: {}", method);
            Err(format!("unsupported method: {}", method))
        }
    }
}
```

## Detailed Implementation

### 1. Create `tools/mod.rs`

```rust
//! ACP tool handlers — modular implementations of client-side tools.

mod filesystem;
mod terminal;
mod permissions;
mod orchestration;

pub use orchestration::*;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use serde_json::Value;

use crate::session::{SessionTerminal, TerminalEvent, acp_log};
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
        "fs/readTextFile" | "fs/read_text_file" => filesystem::read_text_file(params, ctx).await,
        "fs/writeTextFile" | "fs/write_text_file" => filesystem::write_text_file(params, ctx).await,
        "terminal/create" | "terminal/createTerminal" => terminal::create_terminal(params, ctx).await,
        "terminal/output" | "terminal/terminalOutput" => terminal::get_output(params, ctx).await,
        "terminal/waitForExit" | "terminal/wait_for_exit" => terminal::wait_for_exit(params, ctx).await,
        "terminal/kill" | "terminal/killTerminal" => terminal::kill_terminal(params, ctx).await,
        "terminal/release" | "terminal/releaseTerminal" => terminal::release_terminal(params, ctx).await,
        "terminal/cancel" => terminal::cancel_terminal(params, ctx).await,
        "session/requestPermission" | "session/request_permission" => permissions::request_permission(params, ctx).await,
        "_send" => orchestration::send_to_session(params, ctx).await,
        "_queue/add" => orchestration::queue_add(params, ctx).await,
        "_queue/list" => orchestration::queue_list(params, ctx).await,
        "_queue/clear" => orchestration::queue_clear(params, ctx).await,
        "_queue/remove" => orchestration::queue_remove(params, ctx).await,
        _ => {
            acp_log!("WARN", "Unhandled agent request: {}", method);
            Err(format!("unsupported method: {}", method))
        }
    }
}
```

### 2. Create `tools/filesystem.rs`

```rust
//! Filesystem tools: fs/readTextFile, fs/writeTextFile

use serde_json::Value;
use agent_client_protocol_schema as acp;
use acp::{ClientResponse, ReadTextFileResponse, WriteTextFileResponse};

use super::ToolContext;

pub async fn read_text_file(params: &Value, _ctx: &ToolContext) -> Result<Value, String> {
    let path = params.get("path").and_then(|v| v.as_str()).ok_or("missing path")?;
    let line = params.get("line").and_then(|v| v.as_u64()).map(|v| v as usize);
    let limit = params.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
    
    match tokio::task::spawn_blocking({
        let path = path.to_string();
        move || sidex_workspace::file_ops::read_file(std::path::Path::new(&path))
    })
    .await
    {
        Ok(Ok(content)) => {
            let content = if line.is_some() || limit.is_some() {
                let lines: Vec<&str> = content.lines().collect();
                let start = line.map(|l| l.saturating_sub(1)).unwrap_or(0);
                let end = limit.map(|lim| (start + lim).min(lines.len())).unwrap_or(lines.len());
                lines[start..end].join("\n")
            } else {
                content
            };
            let resp = ReadTextFileResponse::new(content);
            serde_json::to_value(ClientResponse::ReadTextFileResponse(resp))
                .map_err(|e| e.to_string())
        }
        Ok(Err(e)) => Err(format!("failed to read file: {e}")),
        Err(e) => Err(format!("task failed: {e}")),
    }
}

pub async fn write_text_file(params: &Value, _ctx: &ToolContext) -> Result<Value, String> {
    let path = params.get("path").and_then(|v| v.as_str()).ok_or("missing path")?;
    let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
    
    match tokio::task::spawn_blocking({
        let path = path.to_string();
        let content = content.to_string();
        move || sidex_workspace::file_ops::write_file(std::path::Path::new(&path), &content)
    })
    .await
    {
        Ok(Ok(())) => {
            let resp = WriteTextFileResponse::new();
            serde_json::to_value(ClientResponse::WriteTextFileResponse(resp))
                .map_err(|e| e.to_string())
        }
        Ok(Err(e)) => Err(format!("failed to write file: {e}")),
        Err(e) => Err(format!("task failed: {e}")),
    }
}
```

### 3. Create `tools/terminal.rs`

```rust
//! Terminal tools: terminal/create, terminal/output, terminal/waitForExit, 
//!                 terminal/kill, terminal/release, terminal/cancel

use serde_json::Value;
use std::collections::HashMap;
use agent_client_protocol_schema as acp;
use acp::{ClientResponse, CreateTerminalResponse, TerminalOutputResponse, 
          TerminalExitStatus, WaitForTerminalExitResponse, 
          KillTerminalResponse, ReleaseTerminalResponse};

use super::ToolContext;
use crate::session::{SessionTerminal, TerminalEvent, acp_log};

pub async fn create_terminal(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let command = params.get("command").and_then(|v| v.as_str()).unwrap_or("");
    let args: Vec<String> = params.get("args")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    
    let mut env: HashMap<String, String> = (*ctx.shell_env).clone();
    if let Some(env_arr) = params.get("env").and_then(|v| v.as_array()) {
        for item in env_arr {
            if let (Some(name), Some(value)) = (
                item.get("name").and_then(|v| v.as_str()), 
                item.get("value").and_then(|v| v.as_str())
            ) {
                env.insert(name.to_string(), value.to_string());
            } else if let Some(s) = item.as_str() {
                if let Some((k, v)) = s.split_once('=') {
                    env.insert(k.to_string(), v.to_string());
                }
            }
        }
    }
    
    let cwd = params.get("cwd").and_then(|v| v.as_str()).map(String::from);
    let shell = sidex_terminal::detect_default_shell();
    let cmd_str = if args.is_empty() {
        command.to_string()
    } else {
        format!("{} {}", command, args.join(" "))
    };

    let spawn_config = sidex_terminal::PtySpawnConfig {
        shell: Some(shell),
        args: Some(vec!["-c".to_string(), cmd_str.clone()]),
        cwd: cwd.clone().map(std::path::PathBuf::from),
        env,
        size: sidex_terminal::TerminalSize { rows: 24, cols: 80 },
    };

    match tokio::task::spawn_blocking(move || sidex_terminal::PtyProcess::spawn(&spawn_config)).await {
        Ok(Ok(pty)) => {
            let handle = sidex_terminal::TermHandle::next();
            let id = format!("term_{}", handle.0);
            let _ = pty.read_output(None);
            
            {
                let mut terminals = ctx.active_terminals.lock().await;
                terminals.insert(id.clone(), SessionTerminal {
                    handle,
                    pty,
                    output: String::new(),
                    exited: false,
                    exit_code: None,
                    command: cmd_str,
                    cwd,
                });
            }
            
            // Spawn drain loop
            let active_terminals_clone = ctx.active_terminals.clone();
            let drain_id = id.clone();
            let events_tx = ctx.terminal_events_tx.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    let (new_data, is_alive, exit_code) = {
                        let mut terminals = active_terminals_clone.lock().await;
                        if let Some(term) = terminals.get_mut(&drain_id) {
                            if term.exited {
                                break;
                            }
                            match term.pty.read_output(None) {
                                Ok(result) => {
                                    let text = result.lines.iter()
                                        .map(|l| l.text.as_str())
                                        .collect::<Vec<_>>()
                                        .join("");
                                    if !text.is_empty() {
                                        term.output.push_str(&text);
                                    }
                                    let exit = if !result.is_alive {
                                        term.exited = true;
                                        term.exit_code = term.pty.exit_code();
                                        term.exit_code
                                    } else {
                                        None
                                    };
                                    (text, result.is_alive, exit)
                                }
                                Err(_) => (String::new(), false, None),
                            }
                        } else {
                            break;
                        }
                    };
                    
                    if !new_data.is_empty() {
                        let _ = events_tx.send(TerminalEvent::Data {
                            terminal_id: drain_id.clone(),
                            data: new_data,
                        });
                    }
                    if !is_alive {
                        let _ = events_tx.send(TerminalEvent::Exit {
                            terminal_id: drain_id.clone(),
                            exit_code,
                        });
                        break;
                    }
                }
            });
            
            let resp = CreateTerminalResponse::new(acp::TerminalId::from(id));
            serde_json::to_value(ClientResponse::CreateTerminalResponse(resp))
                .map_err(|e| e.to_string())
        }
        Ok(Err(e)) => Err(format!("failed to create terminal: {e}")),
        Err(e) => Err(format!("task failed: {e}")),
    }
}

pub async fn get_output(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let id = params.get("terminalId").and_then(|v| v.as_str()).ok_or("missing terminalId")?;
    let terminals = ctx.active_terminals.lock().await;
    
    match terminals.get(id) {
        Some(term) => {
            let output = term.output.clone();
            let truncated = false;
            let mut resp = TerminalOutputResponse::new(output, truncated);
            if term.exited {
                let exit_code = term.exit_code.map(|c| c as u32);
                let exit_status = TerminalExitStatus::new().exit_code(exit_code);
                resp = resp.exit_status(exit_status);
            }
            serde_json::to_value(ClientResponse::TerminalOutputResponse(resp))
                .map_err(|e| e.to_string())
        }
        None => Err("terminal not found".into()),
    }
}

pub async fn wait_for_exit(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let id = params.get("terminalId").and_then(|v| v.as_str()).ok_or("missing terminalId")?;
    
    loop {
        let terminals = ctx.active_terminals.lock().await;
        match terminals.get(id) {
            Some(term) => {
                if !term.pty.is_alive() {
                    let exit_code = term.pty.exit_code().map(|c| c as u32);
                    let exit_status = TerminalExitStatus::new().exit_code(exit_code);
                    let resp = WaitForTerminalExitResponse::new(exit_status);
                    return serde_json::to_value(ClientResponse::WaitForTerminalExitResponse(resp))
                        .map_err(|e| e.to_string());
                }
            }
            None => return Err("terminal not found".into()),
        }
        drop(terminals);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

pub async fn kill_terminal(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let id = params.get("terminalId").and_then(|v| v.as_str()).ok_or("missing terminalId")?;
    let terminals = ctx.active_terminals.lock().await;
    
    if let Some(term) = terminals.get(id) {
        let _ = term.pty.kill_tree();
    }
    
    let resp = KillTerminalResponse::new();
    serde_json::to_value(ClientResponse::KillTerminalResponse(resp))
        .map_err(|e| e.to_string())
}

pub async fn release_terminal(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let id = params.get("terminalId").and_then(|v| v.as_str()).ok_or("missing terminalId")?;
    
    // Kill the PTY but keep the terminal in the map so the frontend
    // can still poll output. Remove after 30s.
    {
        let terminals = ctx.active_terminals.lock().await;
        if let Some(term) = terminals.get(id) {
            let _ = term.pty.kill_tree();
        }
    }
    
    let active_for_cleanup = ctx.active_terminals.clone();
    let release_id = id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let mut terminals = active_for_cleanup.lock().await;
        if let Some(term) = terminals.get(&release_id) {
            if term.exited {
                terminals.remove(&release_id);
            }
        }
    });
    
    let resp = ReleaseTerminalResponse::new();
    serde_json::to_value(ClientResponse::ReleaseTerminalResponse(resp))
        .map_err(|e| e.to_string())
}

/// NEW: Cancel a terminal without cancelling the prompt turn.
/// Useful when agent accidentally launches a long-running server.
pub async fn cancel_terminal(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let id = params.get("terminalId").and_then(|v| v.as_str()).ok_or("missing terminalId")?;
    
    // Kill the PTY
    {
        let mut terminals = ctx.active_terminals.lock().await;
        if let Some(term) = terminals.get(id) {
            let _ = term.pty.kill_tree();
        }
    }
    
    // Broadcast exit event so frontend knows
    let _ = ctx.terminal_events_tx.send(TerminalEvent::Exit {
        terminal_id: id.to_string(),
        exit_code: Some(137), // SIGKILL
    });
    
    acp_log!("INFO", "Cancelled terminal {} (without cancelling prompt turn)", id);
    
    serde_json::to_value(serde_json::json!({ "success": true }))
        .map_err(|e| e.to_string())
}
```

### 4. Create `tools/permissions.rs`

```rust
//! Permission tools: session/requestPermission

use serde_json::Value;
use agent_client_protocol_schema as acp;
use acp::{ClientResponse, RequestPermissionResponse, SelectedPermissionOutcome, PermissionOptionId};

use super::ToolContext;

pub async fn request_permission(params: &Value, _ctx: &ToolContext) -> Result<Value, String> {
    let outcome = SelectedPermissionOutcome::new(PermissionOptionId::from("allow-once"));
    let resp = RequestPermissionResponse::new(acp::RequestPermissionOutcome::Selected(outcome));
    serde_json::to_value(ClientResponse::RequestPermissionResponse(resp))
        .map_err(|e| e.to_string())
}
```

### 5. Create `tools/orchestration.rs`

```rust
//! Orchestration tools: _send (two-step async), _queue/*, task_read, task_write, task_send

use serde_json::{json, Value};
use agent_client_protocol_schema as acp;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::ToolContext;
use crate::session::{acp_log, SessionEvent, DelegationState, Task, TaskStatus};
use crate::manager::AcpSessionManager;

/// Delegation state machine for orchestrator agents.
#[derive(Clone, Debug, Default)]
pub enum DelegationState {
    #[default]
    NotCalled,           // Haven't used _send yet this turn
    WaitingForResponse,  // Called _send, waiting for callback
    Responding,          // Received callback, processing result
}

/// Send a message to another session (two-step async communication).
/// 
/// Flow:
/// 1. Returns immediately with {"status": "sent"}
/// 2. Backend prompts target session with message
/// 3. Target works (react loop, tools, etc.)
/// 4. Target finishes (prompt response with stopReason)
/// 5. Backend re-prompts target: "Summarize what you did, call no tools"
/// 6. Backend captures summary text from target's response
/// 7. Backend sends _send notification to caller with summary
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
        *caller.delegation_state.lock().await = DelegationState::WaitingForResponse;
    }
    
    // Spawn async task to handle the full send flow
    let manager = manager.clone();
    let target_session = target_session.clone();
    let from_session_id_clone = from_session_id.clone();
    let to_session_id_clone = to_session_id.to_string();
    
    tokio::spawn(async move {
        // Step 1: Send prompt to target
        let acp_blocks: Vec<acp::ContentBlock> = blocks.iter()
            .filter_map(|b| serde_json::from_value(b.clone()).ok())
            .collect();
        
        if let Err(e) = target_session.prompt(acp_blocks).await {
            acp_log!("ERROR", "send_to_session: prompt failed: {}", e);
            send_error_callback(&manager, &from_session_id_clone, &to_session_id_clone, &e.to_string()).await;
            return;
        }
        
        // Step 2: Re-prompt for summary (no tools)
        let summary_blocks = vec![acp::ContentBlock::Text(acp::TextContentBlock {
            text: "Summarize what you just accomplished in 2-3 sentences. \
                   Focus on the outcome. Do not call any tools.".into(),
            annotations: None,
        })];
        
        // Subscribe to events before prompting so we don't miss chunks
        let mut event_rx = target_session.subscribe();
        
        if let Err(e) = target_session.prompt(summary_blocks).await {
            acp_log!("ERROR", "send_to_session: summary prompt failed: {}", e);
            send_error_callback(&manager, &from_session_id_clone, &to_session_id_clone, &e.to_string()).await;
            return;
        }
        
        // Step 3: Capture summary text from events
        let mut summary = String::new();
        while let Ok(event) = event_rx.recv().await {
            if let SessionEvent::Update { ref update, .. } = event {
                match update.get("sessionUpdate").and_then(|v| v.as_str()) {
                    Some("agent_message_chunk") => {
                        if let Some(text) = update.get("content")
                            .and_then(|c| c.get("text"))
                            .and_then(|t| t.as_str()) 
                        {
                            summary.push_str(text);
                        }
                    }
                    Some("prompt_complete") => break,
                    _ => {}
                }
            }
        }
        
        // Step 4: Send _send notification to caller
        if let Some(caller_session) = manager.get_session(&from_session_id_clone).await {
            *caller_session.delegation_state.lock().await = DelegationState::Responding;
            
            let update = json!({
                "sessionUpdate": "_send",
                "fromSessionId": to_session_id_clone,
                "toSessionId": from_session_id_clone,
                "summary": summary,
                "status": "completed"
            });
            
            let _ = caller_session.events_tx.send(SessionEvent::Update {
                session_id: from_session_id_clone,
                update,
            });
            
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

/// Send error callback to caller when send fails.
async fn send_error_callback(
    manager: &Arc<AcpSessionManager>,
    from_session_id: &str,
    to_session_id: &str,
    error: &str,
) {
    if let Some(caller_session) = manager.get_session(from_session_id).await {
        *caller_session.delegation_state.lock().await = DelegationState::Responding;
        
        let update = json!({
            "sessionUpdate": "_send",
            "fromSessionId": to_session_id,
            "toSessionId": from_session_id,
            "summary": format!("Error: {}", error),
            "status": "error"
        });
        
        let _ = caller_session.events_tx.send(SessionEvent::Update {
            session_id: from_session_id.to_string(),
            update,
        });
    }
}

/// Read the task list for the current session.
/// Available to all agents (read-only).
pub async fn task_read(_params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;
    
    let tasks = session.task_list.lock().await.clone();
    
    let summary = format_task_summary(&tasks);
    
    serde_json::to_value(json!({
        "tasks": tasks,
        "summary": summary,
    }))
    .map_err(|e| e.to_string())
}

/// Format task list for human-readable summary.
fn format_task_summary(tasks: &[Task]) -> String {
    if tasks.is_empty() {
        return "No tasks".to_string();
    }
    
    let pending = tasks.iter().filter(|t| matches!(t.status, TaskStatus::Pending)).count();
    let in_progress = tasks.iter().filter(|t| matches!(t.status, TaskStatus::InProgress)).count();
    let completed = tasks.iter().filter(|t| matches!(t.status, TaskStatus::Completed)).count();
    let failed = tasks.iter().filter(|t| matches!(t.status, TaskStatus::Failed)).count();
    
    format!("Total: {} | Pending: {} | In Progress: {} | Completed: {} | Failed: {}",
            tasks.len(), pending, in_progress, completed, failed)
}

/// Write/update/delete tasks in the session's task list.
/// Available to orchestrator agents only (does not require session_id input).
pub async fn task_write(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let action = params.get("action")
        .and_then(|v| v.as_str())
        .ok_or("missing action")?;
    
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;
    
    match action {
        "create" => {
            let title = params.get("title")
                .and_then(|v| v.as_str())
                .ok_or("missing title")?;
            let description = params.get("description")
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
            
            session.task_list.lock().await.push(task.clone());
            session.task_queue.lock().await.push_back(task.clone());
            broadcast_task_list(&session).await;
            
            acp_log!("INFO", "Created task: {}", task.title);
            
            serde_json::to_value(json!({ "task": task }))
                .map_err(|e| e.to_string())
        }
        "update" => {
            let task_id = params.get("taskId")
                .and_then(|v| v.as_str())
                .ok_or("missing taskId")?;
            
            let mut tasks = session.task_list.lock().await;
            if let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) {
                if let Some(status) = params.get("status").and_then(|v| v.as_str()) {
                    task.status = serde_json::from_str(&format!("\"{}\"", status))
                        .unwrap_or(TaskStatus::InProgress);
                }
                if let Some(assigned) = params.get("assignedTo").and_then(|v| v.as_str()) {
                    task.assigned_to = Some(assigned.to_string());
                }
                task.updated_at = chrono::Utc::now();
                
                let updated = task.clone();
                drop(tasks);
                broadcast_task_list(&session).await;
                
                acp_log!("INFO", "Updated task {}: {:?}", updated.id, updated.status);
                
                serde_json::to_value(json!({ "task": updated }))
                    .map_err(|e| e.to_string())
            } else {
                Err("task not found".into())
            }
        }
        "delete" => {
            let task_id = params.get("taskId")
                .and_then(|v| v.as_str())
                .ok_or("missing taskId")?;
            
            session.task_list.lock().await.retain(|t| t.id != task_id);
            session.task_queue.lock().await.retain(|t| t.id != task_id);
            broadcast_task_list(&session).await;
            
            acp_log!("INFO", "Deleted task: {}", task_id);
            
            serde_json::to_value(json!({ "success": true }))
                .map_err(|e| e.to_string())
        }
        _ => Err(format!("unknown action: {}", action).into())
    }
}

/// Send a batch of tasks to an orchestrator session.
/// Available to instructor agents only (requires toSessionId input).
pub async fn task_send(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let to_session_id = params.get("toSessionId")
        .and_then(|v| v.as_str())
        .ok_or("missing toSessionId")?;
    let task_defs: Vec<Value> = params.get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let target_session = manager.get_session(to_session_id).await
        .ok_or_else(|| format!("target session not found: {}", to_session_id))?;
    
    // Build tasks from definitions
    let mut tasks = Vec::new();
    for def in &task_defs {
        let title = def.get("title").and_then(|v| v.as_str())
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
        let mut target_tasks = target_session.task_list.lock().await;
        *target_tasks = tasks.clone();
    }
    {
        let mut target_queue = target_session.task_queue.lock().await;
        *target_queue = tasks.iter().cloned().collect();
    }
    
    broadcast_task_list(&target_session).await;
    
    // Send first task as prompt to kick off the orchestrator
    if let Some(first) = tasks.first() {
        let prompt_text = format!("Starting task list. First task: {}", first.title);
        let blocks = vec![acp::ContentBlock::Text(acp::TextContentBlock {
            text: prompt_text,
            annotations: None,
        })];
        
        target_session.prompt(blocks).await
            .map_err(|e| format!("failed to send first task: {}", e))?;
    }
    
    acp_log!("INFO", "Sent {} tasks from {} to {}", 
             tasks.len(), ctx.session_id, to_session_id);
    
    serde_json::to_value(json!({
        "success": true,
        "taskCount": tasks.len(),
        "toSessionId": to_session_id,
    }))
    .map_err(|e| e.to_string())
}

/// Broadcast task list update to all clients viewing this session.
async fn broadcast_task_list(session: &Arc<crate::session::AcpSession>) {
    let tasks = session.task_list.lock().await.clone();
    let update = json!({
        "sessionUpdate": "plan",
        "tasks": tasks,
    });
    let _ = session.events_tx.send(SessionEvent::Update {
        session_id: session.session_id(),
        update,
    });
}

/// Handle orchestrator end-of-turn behavior.
/// Called when prompt_complete is received for an orchestrator session.
pub async fn handle_orchestrator_end_turn(session: &Arc<crate::session::AcpSession>) {
    let state = session.delegation_state.lock().await.clone();
    let task_complete = is_current_task_complete(session).await;
    
    acp_log!("INFO", "Orchestrator end turn: state={:?}, task_complete={}", 
             state, task_complete);
    
    match (state, task_complete) {
        // Delegated and waiting — do nothing, callback will arrive
        (DelegationState::WaitingForResponse, _) => {
            acp_log!("INFO", "Orchestrator waiting for response, no action needed");
        }
        
        // Received callback but didn't update task status
        (DelegationState::Responding, false) => {
            let blocks = vec![acp::ContentBlock::Text(acp::TextContentBlock {
                text: "You received a response from the worker. \
                       If the task is complete, update its status with task_write. \
                       If not, send it back to the worker with feedback.".into(),
                annotations: None,
            })];
            let _ = session.prompt(blocks).await;
        }
        
        // Never delegated — yell at it
        (DelegationState::NotCalled, false) => {
            let blocks = vec![acp::ContentBlock::Text(acp::TextContentBlock {
                text: "You finished your turn without delegating the current task. \
                       Either delegate it to a worker using _send, \
                       or mark it complete with task_write if it's already done.".into(),
                annotations: None,
            })];
            let _ = session.prompt(blocks).await;
        }
        
        // Task complete — dequeue next or summarize
        (DelegationState::Responding, true) | (DelegationState::NotCalled, true) => {
            let next_task = {
                let mut queue = session.task_queue.lock().await;
                queue.pop_front()
            };
            
            if let Some(task) = next_task {
                *session.delegation_state.lock().await = DelegationState::NotCalled;
                let blocks = vec![acp::ContentBlock::Text(acp::TextContentBlock {
                    text: format!("Next task: {}", task.title),
                    annotations: None,
                })];
                let _ = session.prompt(blocks).await;
            } else {
                let blocks = vec![acp::ContentBlock::Text(acp::TextContentBlock {
                    text: "All tasks complete. Provide a final summary of what was accomplished.".into(),
                    annotations: None,
                })];
                let _ = session.prompt(blocks).await;
            }
        }
    }
}

/// Check if the current task (most recently assigned) is marked complete.
async fn is_current_task_complete(session: &Arc<crate::session::AcpSession>) -> bool {
    let tasks = session.task_list.lock().await;
    
    // Find the most recently updated task
    if let Some(current) = tasks.iter()
        .max_by_key(|t| t.updated_at) 
    {
        matches!(current.status, TaskStatus::Completed)
    } else {
        false
    }
}

/// Add a prompt to the session's queue (when another prompt is running).
pub async fn queue_add(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let message = params.get("message")
        .and_then(|v| v.as_array())
        .ok_or("missing message array")?;
    
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;
    
    // Check if a prompt is currently running
    let state = session.prompt_turn_state.lock().await;
    let is_running = matches!(*state, crate::session::PromptTurnState::Running);
    drop(state);
    
    if !is_running {
        return Err("no prompt currently running, send directly instead".into());
    }
    
    // Add to queue
    let blocks: Vec<Value> = message.iter().cloned().collect();
    session.queue_add(blocks).await
        .map_err(|e| format!("failed to queue: {}", e))?;
    
    let queue_len = session.queue_len().await;
    
    acp_log!("INFO", "Queued message for session {}, queue length: {}", 
             ctx.session_id, queue_len);
    
    serde_json::to_value(serde_json::json!({ 
        "success": true,
        "queueLength": queue_len 
    }))
    .map_err(|e| e.to_string())
}

/// List queued prompts for the current session.
pub async fn queue_list(_params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;
    
    let items = session.queue_list().await;
    
    serde_json::to_value(serde_json::json!({ "items": items }))
        .map_err(|e| e.to_string())
}

/// Clear the queue for the current session.
pub async fn queue_clear(_params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;
    
    session.queue_clear().await;
    
    acp_log!("INFO", "Cleared queue for session {}", ctx.session_id);
    
    serde_json::to_value(serde_json::json!({ "success": true }))
        .map_err(|e| e.to_string())
}

/// Remove a specific item from the queue.
pub async fn queue_remove(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let index = params.get("index")
        .and_then(|v| v.as_u64())
        .ok_or("missing index")? as usize;
    
    let manager = ctx.manager.as_ref().ok_or("manager not available")?;
    let session = manager.get_session(&ctx.session_id).await
        .ok_or_else(|| format!("session not found: {}", ctx.session_id))?;
    
    session.queue_remove(index).await
        .ok_or_else(|| format!("invalid queue index: {}", index))?;
    
    acp_log!("INFO", "Removed queue item {} from session {}", index, ctx.session_id);
    
    serde_json::to_value(serde_json::json!({ "success": true }))
        .map_err(|e| e.to_string())
}
```

### 6. Update `session.rs`

Replace the massive `handle_agent_request()` function with a call to the router:

```rust
// In the I/O task loop, replace the call to handle_agent_request:
let result = handle_agent_request(
    &method,
    &params,
    &active_terminals_for_io,
    &session_id_cell_clone.lock().await,
    &shell_env_for_io,
    &terminal_events_for_io,
).await;

// With:
let ctx = ToolContext {
    active_terminals: active_terminals_for_io.clone(),
    session_id: session_id_cell_clone.lock().await.clone(),
    shell_env: shell_env_for_io.clone(),
    terminal_events_tx: terminal_events_for_io.clone(),
    manager: None, // Will be set after session is added to manager
    agent_config: agent_config_for_io.clone(),
};
let result = tools::route_tool_request(&method, &params, &ctx).await;
```

### 7. Add Queue Methods to `AcpSession`

```rust
// Add to session.rs:

/// Add a prompt to the queue.
pub async fn queue_add(&self, blocks: Vec<Value>) -> Result<()> {
    // Store in a queue (needs a new field: queue: Arc<Mutex<Vec<Vec<Value>>>>)
    // Broadcast queue_changed event
    Ok(())
}

/// Get the current queue length.
pub async fn queue_len(&self) -> usize {
    // Return queue.len()
    0
}

/// List queued items.
pub async fn queue_list(&self) -> Vec<Value> {
    // Return queue contents
    vec![]
}

/// Clear the queue.
pub async fn queue_clear(&self) {
    // Clear queue and broadcast
}

/// Remove an item from the queue by index.
pub async fn queue_remove(&self, index: usize) -> Option<()> {
    // Remove and broadcast
    Some(())
}
```

### 8. Update `AcpSession` to Track Queue State

Add a queue field to `AcpSession`:

```rust
pub struct AcpSession {
    // ... existing fields ...
    
    /// Queued prompts (when a prompt is running).
    pub queue: Arc<Mutex<Vec<Vec<Value>>>>,
}
```

Initialize in `spawn()`:

```rust
let queue = Arc::new(Mutex::new(Vec::new()));
```

### 9. Update `manager.rs` to Pass Manager Reference

When creating the `ToolContext` in the I/O task, we need access to the manager. Since the I/O task is spawned before the session is added to the manager, we'll need to set it later:

```rust
// Add to AcpSession:
pub async fn set_manager(&self, manager: Arc<AcpSessionManager>) {
    *self.manager_cell.lock().await = Some(manager);
}

// Add field:
manager_cell: Arc<Mutex<Option<Arc<AcpSessionManager>>>>,

// In manager.rs, after adding session to manager:
pub async fn bind_new_session(&self, ...) -> Result<Arc<AcpSession>> {
    // ... existing code ...
    
    session.set_manager(Arc::new(self.clone())).await; // Need Clone impl
    
    // ... rest of code ...
}
```

Actually, simpler approach: pass manager reference when spawning:

```rust
// In spawn(), add manager parameter:
pub async fn spawn(
    agent_manager: &AgentManager,
    config: AgentConfig,
    cwd: String,
    shell_env: HashMap<String, String>,
    manager: Option<Arc<AcpSessionManager>>, // Add this
) -> Result<Arc<Self>> {
    // ... pass to I/O task ...
}
```

But this creates a chicken-and-egg problem. Better approach: use `Arc<Mutex<Option<Arc<AcpSessionManager>>>>` and set it after the session is added to the manager.

## Migration Steps

1. Create `tools/` directory structure
2. Extract filesystem tools to `tools/filesystem.rs`
3. Extract terminal tools to `tools/terminal.rs` (including new `terminal/cancel`)
4. Extract permissions to `tools/permissions.rs`
5. Create `tools/mod.rs` with `ToolContext` and router
6. Update `session.rs` to use `tools::route_tool_request()`
7. Add queue tracking to `AcpSession`
8. Implement orchestration tools in `tools/orchestration.rs`
9. Update `manager.rs` to pass manager reference to sessions
10. Test all tools work after refactor

## Testing Checklist

- [ ] `fs/readTextFile` works with line/limit params
- [ ] `fs/writeTextFile` creates/overwrites files
- [ ] `terminal/create` spawns PTY with correct env
- [ ] `terminal/output` returns accumulated output
- [ ] `terminal/waitForExit` blocks until exit
- [ ] `terminal/kill` kills PTY process
- [ ] `terminal/release` kills PTY and schedules removal
- [ ] `terminal/cancel` kills PTY without cancelling prompt turn
- [ ] `session/requestPermission` auto-approves
- [ ] `_send` routes message to target session
- [ ] `_send` with `_meta.delegate` logs delegation
- [ ] `_queue/add` queues message when prompt is running
- [ ] `_queue/add` fails when no prompt is running
- [ ] `_queue/list` returns queued items
- [ ] `_queue/clear` empties the queue
- [ ] `_queue/remove` removes specific item
- [ ] Queue broadcasts state changes via `queue_changed` event
- [ ] `session/cancel` still kills all active terminals (existing behavior)
- [ ] `terminal/cancel` does NOT cancel the prompt turn

## Key Differences from Current Implementation

1. **Modular structure**: Each tool category in its own file
2. **ToolContext**: Shared state passed to all tools
3. **terminal/cancel**: New tool that kills terminal without cancelling prompt
4. **Orchestration tools**: `_send`, `_queue/*` for inter-agent communication
5. **Queue tracking**: AcpSession now tracks queued prompts
6. **Manager reference**: Tools can access other sessions via manager

## Backwards Compatibility

- All existing tool methods continue to work unchanged
- No changes to ACP protocol surface
- Frontend continues to be passive observer
- Extension tools use underscore prefix per ACP spec

## Agent Settings Integration

The `AgentConfig` is now available in `ToolContext`, so tools can reference:
- `ctx.agent_config.name`
- `ctx.agent_config.command`
- `ctx.agent_config.args`
- `ctx.agent_config.env`

This allows orchestration tools to know which agent they're working with.

## Future Work

After this refactor is complete:
- Plan persistence to SQLite (for history/recovery)
- Delegation routing (watch for `_meta.delegate` in plan updates)
- Reactive orchestration loop (watch plan state transitions)
- Rich text editor with `@` context references
