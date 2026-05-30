//! Tauri commands for ACP chat integration.
//!
//! These commands bridge the frontend to the `sidex-acp` crate,
//! which owns all session state, agent processes, and queue management.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use sidex_acp::{AgentConfig, AcpSessionManager, PromptBehavior, SessionEvent};

// ─── State ──────────────────────────────────────────────────────────────────

/// Tauri-managed state for ACP chat.
/// The event bridge is started lazily on the first session bind
/// to ensure the Tokio runtime is running.
pub struct AcpChatState {
    pub session_manager: Arc<AcpSessionManager>,
    pub global_events: tokio::sync::broadcast::Sender<SessionEvent>,
    app_handle: Mutex<Option<AppHandle>>,
    bridge_started: Mutex<bool>,
}

impl AcpChatState {
    pub fn new() -> Self {
        let agent_manager = Arc::new(sidex_acp::AgentManager::new());
        let session_manager = Arc::new(AcpSessionManager::new(agent_manager));
        let (global_events, _) = tokio::sync::broadcast::channel(1024);
        Self {
            session_manager,
            global_events,
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
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
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
                let _ = app.emit("acp:sessionUpdate", payload);
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
}

#[derive(Debug, Deserialize)]
pub struct PromptRequest {
    pub session_id: String,
    pub blocks: Vec<Value>,
    #[serde(default)]
    pub behavior: PromptBehavior,
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
        )
        .await
        .map_err(|e| {
            log::error!("[acp_chat] new_session failed: {e}");
            e.to_string()
        })?;

    Ok(NewSessionResponse {
        session_id: session.session_id(),
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

    session
        .prompt_with_behavior(request.blocks, request.behavior)
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

/// Get the current queue for a session.
#[tauri::command]
pub async fn acp_chat_get_queue(
    state: State<'_, Arc<AcpChatState>>,
    request: SessionIdRequest,
) -> Result<Vec<sidex_acp::QueuedItem>, String> {
    let session = state
        .session_manager
        .get_session(&request.session_id)
        .await
        .ok_or("Session not found")?;

    Ok(session.get_queue().await)
}
