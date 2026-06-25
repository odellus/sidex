//! Tauri commands for ACP chat integration.
//!
//! These commands bridge the frontend to the `sidex-acp` crate,
//! which owns all session state and agent processes.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use sidex_acp::{AgentConfig, AcpSessionManager, SessionEvent, TerminalEvent};

// ─── State ──────────────────────────────────────────────────────────────────

/// Tauri-managed state for ACP chat.
/// The event bridge is started lazily on the first session bind
/// to ensure the Tokio runtime is running.
pub struct AcpChatState {
    pub session_manager: Arc<AcpSessionManager>,
    pub global_events: tokio::sync::broadcast::Sender<SessionEvent>,
    pub terminal_events: tokio::sync::broadcast::Sender<TerminalEvent>,
    app_handle: Mutex<Option<AppHandle>>,
    bridge_started: Mutex<bool>,
}

impl AcpChatState {
    pub fn new() -> Self {
        let agent_manager = Arc::new(sidex_acp::AgentManager::new());
        let session_manager = Arc::new(AcpSessionManager::new(agent_manager));
        let (global_events, _) = tokio::sync::broadcast::channel(1024);
        let (terminal_events, _) = tokio::sync::broadcast::channel(256);
        Self {
            session_manager,
            global_events,
            terminal_events,
            app_handle: Mutex::new(None),
            bridge_started: Mutex::new(false),
        }
    }

    /// Store the app handle for later use.
    pub fn set_app_handle(&self, app: AppHandle) {
        if let Ok(mut guard) = self.app_handle.lock() {
            *guard = Some(app);
        }
    }

    /// Start the event bridge if not already running.
    /// Safe to call from within a Tauri command (Tokio runtime is active).
    fn ensure_bridge(&self) {
        {
            let mut started = match self.bridge_started.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if *started {
                return;
            }
            *started = true;
        }

        let app = match self.app_handle.lock() {
            Ok(guard) => match guard.clone() {
                Some(app) => app,
                None => {
                    log::error!("[acp_chat] Cannot start bridge: no app handle stored");
                    if let Ok(mut s) = self.bridge_started.lock() { *s = false; }
                    return;
                }
            },
            Err(_) => {
                if let Ok(mut s) = self.bridge_started.lock() { *s = false; }
                return;
            }
        };

        let mut rx = self.global_events.subscribe();
        let app2 = app.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let payload = match event {
                            SessionEvent::Update { session_id, update } => {
                                serde_json::json!({
                                    "type": "update",
                                    "sessionId": session_id,
                                    "update": update,
                                })
                            }
                            SessionEvent::Disconnected { session_id } => {
                                serde_json::json!({
                                    "type": "disconnected",
                                    "sessionId": session_id,
                                })
                            }
                        };
                        let _ = app2.emit("acp:sessionUpdate", payload);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("[acp_chat] session event bridge lagged {} events", n);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        // Forward terminal events to Tauri events
        let mut term_rx = self.terminal_events.subscribe();
        tokio::spawn(async move {
            loop {
                match term_rx.recv().await {
                    Ok(event) => {
                        match event {
                            TerminalEvent::Data { terminal_id, data } => {
                                let _ = app.emit("acp-terminal-data", serde_json::json!({
                                    "terminalId": terminal_id,
                                    "data": data,
                                }));
                            }
                            TerminalEvent::Exit { terminal_id, exit_code } => {
                                let _ = app.emit("acp-terminal-exit", serde_json::json!({
                                    "terminalId": terminal_id,
                                    "exitCode": exit_code,
                                }));
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("[acp_chat] terminal event bridge lagged {} events", n);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}

// ─── Request/response types ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SpawnRequest {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<String>,
    pub cwd: String,
}

#[derive(Debug, Serialize)]
pub struct SpawnResponse {
    pub connection_id: String,
}

#[derive(Debug, Deserialize)]
pub struct NewSessionRequest {
    pub connection_id: String,
    #[serde(default)]
    pub mcp_servers: Vec<Value>,
}

#[derive(Debug, Serialize)]
pub struct NewSessionResponse {
    pub session_id: String,
    pub config_options: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct PromptRequest {
    pub session_id: String,
    pub blocks: Vec<Value>,
}

#[derive(Debug, Deserialize)]
pub struct SessionIdRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ListSessionsRequest {
    pub session_id: String,
    pub cwd: String,
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Spawn an agent process and initialize it.
/// Returns a connection_id — call `acp_chat_new_session` next.
#[tauri::command]
pub async fn acp_chat_spawn(
    state: State<'_, Arc<AcpChatState>>,
    request: SpawnRequest,
) -> Result<SpawnResponse, String> {
    state.ensure_bridge();

    let config = AgentConfig {
        name: request.name,
        command: request.command,
        args: request.args,
        env: request.env,
    };

    state
        .session_manager
        .init_connection(config, request.cwd)
        .await
        .map(|connection_id| SpawnResponse { connection_id })
        .map_err(|e| {
            log::error!("[acp_chat] spawn failed: {e}");
            e.to_string()
        })
}

/// Bind a connection to a new session.
#[tauri::command]
pub async fn acp_chat_new_session(
    state: State<'_, Arc<AcpChatState>>,
    request: NewSessionRequest,
) -> Result<NewSessionResponse, String> {
    state.ensure_bridge();

    let session = state
        .session_manager
        .bind_new_session(
            &request.connection_id,
            request.mcp_servers,
            state.global_events.clone(),
            state.terminal_events.clone(),
        )
        .await
        .map_err(|e| {
            log::error!("[acp_chat] new_session failed: {e}");
            e.to_string()
        })?;

    // Set manager reference so orchestration tools can access other sessions
    session.set_manager(state.session_manager.clone()).await;

    Ok(NewSessionResponse {
        session_id: session.session_id(),
        config_options: session.config_options(),
    })
}

/// Request type for loading an existing session.
#[derive(Deserialize)]
pub struct LoadSessionRequest {
    pub connection_id: String,
    pub session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub mcp_servers: Vec<Value>,
}

/// Bind a connection to an existing session (session/load).
#[tauri::command]
pub async fn acp_chat_load_session(
    state: State<'_, Arc<AcpChatState>>,
    request: LoadSessionRequest,
) -> Result<NewSessionResponse, String> {
    state.ensure_bridge();

    let session = state
        .session_manager
        .bind_load_session(
            &request.connection_id,
            &request.session_id,
            &request.cwd,
            request.mcp_servers,
            state.global_events.clone(),
            state.terminal_events.clone(),
        )
        .await
        .map_err(|e| {
            log::error!("[acp_chat] load_session failed: {e}");
            e.to_string()
        })?;

    // Set manager reference so orchestration tools can access other sessions
    session.set_manager(state.session_manager.clone()).await;

    Ok(NewSessionResponse {
        session_id: session.session_id(),
        config_options: session.config_options(),
    })
}

/// Request type for switching sessions.
#[derive(Deserialize)]
pub struct SwitchSessionRequest {
    pub current_session_id: String,
    pub target_session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub mcp_servers: Vec<Value>,
}

/// Switch an already-bound session to a different session (session/load on existing session).
#[tauri::command]
pub async fn acp_chat_switch_session(
    state: State<'_, Arc<AcpChatState>>,
    request: SwitchSessionRequest,
) -> Result<NewSessionResponse, String> {
    state.ensure_bridge();

    let session = state
        .session_manager
        .switch_session(
            &request.current_session_id,
            &request.target_session_id,
            &request.cwd,
            request.mcp_servers,
            state.global_events.clone(),
            state.terminal_events.clone(),
        )
        .await
        .map_err(|e| {
            log::error!("[acp_chat] switch_session failed: {e}");
            e.to_string()
        })?;

    // Set manager reference so orchestration tools can access other sessions
    session.set_manager(state.session_manager.clone()).await;

    Ok(NewSessionResponse {
        session_id: session.session_id(),
        config_options: session.config_options(),
    })
}

/// Send a prompt to a session.
#[tauri::command]
pub async fn acp_chat_prompt(
    state: State<'_, Arc<AcpChatState>>,
    request: PromptRequest,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get_session(&request.session_id)
        .await
        .ok_or_else(|| {
            log::warn!("[acp_chat] prompt: session {} not found", request.session_id);
            "Session not found".to_string()
        })?;

    // Reset orchestration state for a new user-initiated prompt.
    {
        let mut orch = session.orchestration.lock().await;
        orch.summarized = false;
    }

    session
        .prompt(request.blocks)
        .await
        .map_err(|e| {
            log::error!("[acp_chat] prompt failed: {e}");
            e.to_string()
        })
}

/// Cancel the current prompt turn.
#[tauri::command]
pub async fn acp_chat_cancel(
    state: State<'_, Arc<AcpChatState>>,
    request: SessionIdRequest,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get_session(&request.session_id)
        .await
        .ok_or("Session not found")?;

    session.cancel().await.map_err(|e| {
        log::error!("[acp_chat] cancel failed: {e}");
        e.to_string()
    })
}

/// Close a session and kill its agent.
#[tauri::command]
pub async fn acp_chat_close_session(
    state: State<'_, Arc<AcpChatState>>,
    request: SessionIdRequest,
) -> Result<(), String> {
    state
        .session_manager
        .close_session(&request.session_id)
        .await;
    Ok(())
}

/// Remove a queued prompt by index.
#[tauri::command]
pub async fn acp_chat_queue_remove(
    state: State<'_, Arc<AcpChatState>>,
    request: QueueRemoveRequest,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get_session(&request.session_id)
        .await
        .ok_or("Session not found")?;

    session.queue_remove(request.index).await.ok_or("Index out of range")?;
    Ok(())
}

/// Clear the entire prompt queue.
#[tauri::command]
pub async fn acp_chat_queue_clear(
    state: State<'_, Arc<AcpChatState>>,
    request: SessionIdRequest,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get_session(&request.session_id)
        .await
        .ok_or("Session not found")?;

    session.queue_clear().await;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct QueueRemoveRequest {
    pub session_id: String,
    pub index: usize,
}

/// List agent-managed sessions for a cwd.
#[tauri::command]
pub async fn acp_chat_list_sessions(
    state: State<'_, Arc<AcpChatState>>,
    request: ListSessionsRequest,
) -> Result<Value, String> {
    let session = state
        .session_manager
        .get_session(&request.session_id)
        .await
        .ok_or("Session not found")?;

    session.list_sessions(&request.cwd).await.map_err(|e| {
        log::error!("[acp_chat] list_sessions failed: {e}");
        e.to_string()
    })
}

/// Set a session configuration option (model, mode, etc.).
#[derive(Debug, Deserialize)]
pub struct SetConfigOptionRequest {
    pub session_id: String,
    pub config_id: String,
    pub value: String,
}

#[tauri::command]
pub async fn acp_chat_set_config_option(
    state: State<'_, Arc<AcpChatState>>,
    request: SetConfigOptionRequest,
) -> Result<Value, String> {
    let session = state
        .session_manager
        .get_session(&request.session_id)
        .await
        .ok_or("Session not found")?;

    session
        .set_config_option(&request.config_id, &request.value)
        .await
        .map_err(|e| {
            log::error!("[acp_chat] set_config_option failed: {e}");
            e.to_string()
        })
}

// ─── Terminal output polling ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct TerminalOutputRequest {
    pub terminal_id: String,
}

#[derive(Debug, Serialize)]
pub struct TerminalOutputResponse {
    pub output: String,
    pub is_alive: bool,
    pub exit_code: Option<i32>,
    pub cwd: Option<String>,
    pub command: Option<String>,
}

/// Poll terminal output — frontend calls this to get accumulated output from
/// a backend PTY that the agent created via terminal/create.
#[tauri::command]
pub async fn acp_terminal_output(
    state: State<'_, Arc<AcpChatState>>,
    request: TerminalOutputRequest,
) -> Result<TerminalOutputResponse, String> {
    // Search all active sessions for this terminal
    let sessions = state.session_manager.list_active_sessions().await;
    for session_id in &sessions {
        if let Some(session) = state.session_manager.get_session(session_id).await {
            let terminals = session.active_terminals.lock().await;
            if let Some(term) = terminals.get(&request.terminal_id) {
                return Ok(TerminalOutputResponse {
                    output: term.output.clone(),
                    is_alive: !term.exited,
                    exit_code: term.exit_code,
                    cwd: term.cwd.clone(),
                    command: Some(term.command.clone()),
                });
            }
        }
    }
    Err(format!("Terminal not found: {}", request.terminal_id))
}


