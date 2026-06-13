//! Terminal tools: terminal/create, terminal/output, terminal/wait_for_exit,
//!                 terminal/kill, terminal/release, terminal/cancel

use serde_json::Value;
use std::collections::HashMap;
use agent_client_protocol_schema as acp;
use acp::{ClientResponse, CreateTerminalResponse, TerminalOutputResponse, 
          TerminalExitStatus, WaitForTerminalExitResponse, 
          KillTerminalResponse, ReleaseTerminalResponse};

use super::ToolContext;
use crate::session::{SessionTerminal, TerminalEvent};
use crate::acp_log;

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

/// Cancel a terminal without cancelling the prompt turn.
/// Useful when agent accidentally launches a long-running server.
pub async fn cancel_terminal(params: &Value, ctx: &ToolContext) -> Result<Value, String> {
    let id = params.get("terminalId").and_then(|v| v.as_str()).ok_or("missing terminalId")?;
    
    // Kill the PTY
    {
        let terminals = ctx.active_terminals.lock().await;
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
