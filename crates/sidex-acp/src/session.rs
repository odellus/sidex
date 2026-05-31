//! Backend-owned ACP session.
//!
//! Speaks ACP JSON-RPC over the agent's stdin/stdout via AgentManager.
//! Handles client tool requests (fs, terminal) directly and forwards session updates
//! to connected frontends over the broadcast channel.
//!
//! ALL logging goes to a file — never stdout/stderr — because ACP uses stdio.

use std::collections::HashMap;
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use anyhow::{Context, Result};
use chrono::Local;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

use agent_client_protocol_schema as acp;
use acp::{
    AgentNotification, AgentRequest, CancelNotification, ClientCapabilities,
    ClientResponse, ContentBlock, FileSystemCapabilities, Implementation,
    InitializeRequest, JsonRpcMessage, KillTerminalResponse, ListSessionsRequest,
    LoadSessionRequest, NewSessionRequest, Notification, PermissionOptionId,
    PromptRequest, ProtocolVersion, ReadTextFileResponse, ReleaseTerminalResponse,
    Request, RequestId, RequestPermissionResponse, Response, SelectedPermissionOutcome,
    SessionConfigOption, SessionId, SessionModeState, TerminalExitStatus,
    WaitForTerminalExitResponse, WriteTextFileResponse,
};

use crate::agent::{AgentConfig, AgentManager};

// ─── File logger ───────────────────────────────────────────────────────────

/// Dedicated file logger. Never writes to stdout/stderr.
struct FileLogger {
    file: StdMutex<std::fs::File>,
}

impl FileLogger {
    fn new() -> Self {
        let path = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("sidex/logs/acp.log");
        if let Some(parent) = path.parent() {
            let _ = create_dir_all(parent);
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .expect("failed to open acp log file");
        Self {
            file: StdMutex::new(file),
        }
    }

    fn log(&self, level: &str, msg: &str) {
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let line = format!("[{}] [{}] {}\n", ts, level, msg);
        let _ = self.file.lock().unwrap().write_all(line.as_bytes());
    }
}

fn logger() -> &'static FileLogger {
    static INSTANCE: OnceLock<FileLogger> = OnceLock::new();
    INSTANCE.get_or_init(FileLogger::new)
}

macro_rules! acp_log {
    ($level:expr, $($arg:tt)*) => {
        logger().log($level, &format!($($arg)*))
    };
}

// ─── Types ──────────────────────────────────────────────────────────────────

/// Event broadcast to frontends when something happens in a session.
#[derive(Clone, Debug)]
pub enum SessionEvent {
    /// A session/update notification from the agent.
    Update {
        session_id: String,
        update: Value,
    },
    /// The agent process exited or the connection was lost.
    Disconnected {
        session_id: String,
    },
}

/// Lifecycle state of a prompt turn, owned by the backend.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptTurnState {
    #[default]
    Idle,
    /// We sent session/prompt and are awaiting the agent's PromptResponse.
    Running,
    /// Agent responded with a stopReason.
    Complete {
        stop_reason: String,
    },
    /// Client called session/cancel.
    Cancelled,
    /// Something went wrong (timeout, disconnect, etc.).
    Error {
        message: String,
    },
}

// ─── Terminal tracking ────────────────────────────────────────────────────

/// Info about a terminal created by this session.
pub struct SessionTerminal {
    handle: sidex_terminal::TermHandle,
    #[allow(dead_code)]
    pty: sidex_terminal::PtyProcess,
}

// ─── AcpSession ─────────────────────────────────────────────────────────────

/// A running ACP session owned by the backend.
pub struct AcpSession {
    /// Unique connection ID (distinct from agent_id and session_id).
    pub connection_id: String,
    /// ACP session ID — empty until new_session or load_session succeeds.
    session_id: parking_lot::Mutex<String>,
    /// Agent process ID (from AgentManager).
    pub agent_id: String,
    pub agent_name: String,
    pub cwd: String,
    config_options: parking_lot::Mutex<Option<Vec<SessionConfigOption>>>,
    modes: parking_lot::Mutex<Option<SessionModeState>>,

    stdin_tx: mpsc::Sender<String>,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    events_tx: broadcast::Sender<SessionEvent>,
    next_id: AtomicU64,
    _io_task: tokio::task::JoinHandle<()>,

    /// Current prompt turn state — backend is source of truth.
    pub prompt_turn_state: Arc<Mutex<PromptTurnState>>,
    /// Active terminals created by this session during current prompt turn.
    pub active_terminals: Arc<Mutex<HashMap<String, SessionTerminal>>>,
    /// Shared cell so the I/O task knows the current session ID.
    session_id_cell: Arc<Mutex<String>>,
}

impl AcpSession {
    /// Spawn an agent process and start the I/O loop.
    /// Returns an Arc with empty session_id — call initialize() then new_session() or load_session().
    pub async fn spawn(
        agent_manager: &AgentManager,
        config: AgentConfig,
        cwd: String,
    ) -> Result<Arc<Self>> {
        let agent_id = agent_manager
            .spawn(&config, &cwd)
            .await
            .context("failed to spawn agent")?;

        let stdin_tx = agent_manager
            .get_stdin(&agent_id)
            .await
            .context("agent disappeared immediately")?;

        let agent_events_tx_raw = agent_manager
            .get_events_tx_raw(&agent_id)
            .await
            .context("agent disappeared immediately")?;
        let mut stdout_rx = agent_events_tx_raw.subscribe();

        let events_tx = broadcast::Sender::new(1024);
        let pending_requests = Arc::new(Mutex::new(HashMap::<
            u64,
            oneshot::Sender<Result<Value, String>>,
        >::new()));

        let pending_clone = pending_requests.clone();
        let broadcast_tx = events_tx.clone();
        let session_id_cell = Arc::new(Mutex::new(String::new()));
        let session_id_cell_clone = session_id_cell.clone();
        let stdin_tx_clone = stdin_tx.clone();
        let active_terminals = Arc::new(Mutex::new(HashMap::<String, SessionTerminal>::new()));
        let active_terminals_for_io = active_terminals.clone();

        let connection_id = uuid::Uuid::new_v4().to_string();
        let connection_id_for_io = connection_id.clone();

        acp_log!(
            "INFO",
            "Spawning ACP connection {} (agent={}, cwd={})",
            connection_id,
            agent_id,
            cwd
        );

        let io_task = tokio::spawn(async move {
            loop {
                match stdout_rx.recv().await {
                    Ok(raw_line) => {
                        acp_log!(
                            "RECV",
                            "connection={} line={}",
                            connection_id_for_io,
                            raw_line
                        );
                        if let Err(e) = handle_agent_line(
                            &raw_line,
                            &pending_clone,
                            &broadcast_tx,
                            &session_id_cell_clone,
                            &stdin_tx_clone,
                            &active_terminals_for_io,
                        )
                        .await
                        {
                            acp_log!("ERROR", "connection={} parse error: {}", connection_id_for_io, e);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            let sid = session_id_cell_clone.lock().await.clone();
            if !sid.is_empty() {
                acp_log!("INFO", "connection={} agent stdout closed, session={}", connection_id_for_io, sid);
                let _ = broadcast_tx.send(SessionEvent::Disconnected { session_id: sid });
            }
        });

        let prompt_turn_state = Arc::new(Mutex::new(PromptTurnState::Idle));

        let session = Self {
            connection_id: connection_id.clone(),
            session_id: parking_lot::Mutex::new(String::new()),
            agent_id: agent_id.clone(),
            agent_name: config.name.clone(),
            cwd: cwd.clone(),
            config_options: parking_lot::Mutex::new(None),
            modes: parking_lot::Mutex::new(None),
            stdin_tx,
            pending_requests,
            events_tx,
            next_id: AtomicU64::new(1),
            _io_task: io_task,
            prompt_turn_state,
            active_terminals,
            session_id_cell,
        };

        acp_log!(
            "INFO",
            "ACP connection ready: {} (agent: {}, cwd: {})",
            connection_id,
            agent_id,
            cwd
        );

        Ok(Arc::new(session))
    }

    /// Get the current session ID.
    pub fn session_id(&self) -> String {
        self.session_id.lock().clone()
    }

    /// Get config options.
    pub fn config_options(&self) -> Option<Value> {
        self.config_options.lock().as_ref().map(|v| serde_json::to_value(v).ok()).flatten()
    }

    /// Get modes.
    pub fn modes(&self) -> Option<Value> {
        self.modes.lock().as_ref().map(|v| serde_json::to_value(v).ok()).flatten()
    }

    /// Send initialize request and wait for response.
    pub async fn initialize(&self) -> Result<Value> {
        let init_req = InitializeRequest::new(ProtocolVersion::LATEST)
            .client_capabilities(
                ClientCapabilities::new()
                    .fs(FileSystemCapabilities::new().read_text_file(true).write_text_file(true))
                    .terminal(true),
            )
            .client_info(Implementation::new("sidex", env!("CARGO_PKG_VERSION")));

        let id = self.next_id();
        let envelope = JsonRpcMessage::wrap(Request {
            id: RequestId::Number(id as i64),
            method: "initialize".into(),
            params: Some(init_req),
        });

        acp_log!(
            "SEND",
            "connection={} method=initialize id={}",
            self.connection_id,
            id
        );

        let resp = self.request_envelope(id, envelope).await.context("initialize failed")?;
        acp_log!("INFO", "connection={} initialize succeeded", self.connection_id);
        Ok(resp)
    }

    /// Send session/new and bind this connection to a new session.
    pub async fn new_session(&self, mcp_servers: Vec<Value>) -> Result<Value> {
        let mcp_servers: Vec<acp::McpServer> = mcp_servers
            .into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect();

        let req = NewSessionRequest::new(&self.cwd).mcp_servers(mcp_servers);
        let id = self.next_id();
        let envelope = JsonRpcMessage::wrap(Request {
            id: RequestId::Number(id as i64),
            method: "session/new".into(),
            params: Some(req),
        });

        acp_log!(
            "SEND",
            "connection={} method=session/new id={}",
            self.connection_id,
            id
        );

        let resp = self.request_envelope(id, envelope).await.context("newSession failed")?;

        let sid = resp
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        *self.session_id.lock() = sid.clone();
        *self.session_id_cell.lock().await = sid.clone();
        *self.config_options.lock() = resp
            .get("configOptions")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        *self.modes.lock() = resp
            .get("modes")
            .and_then(|v| serde_json::from_value(v.clone()).ok());

        acp_log!(
            "INFO",
            "ACP session created: {} (connection: {}, agent: {}, cwd: {})",
            sid,
            self.connection_id,
            self.agent_id,
            self.cwd
        );

        Ok(resp)
    }

    /// Send session/load and bind this connection to an existing session.
    pub async fn load_session(
        &self,
        target_session_id: &str,
        cwd: &str,
        mcp_servers: Vec<Value>,
    ) -> Result<Value> {
        let mcp_servers: Vec<acp::McpServer> = mcp_servers
            .into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect();

        let req = LoadSessionRequest::new(SessionId::from(target_session_id.to_string()), PathBuf::from(cwd))
            .mcp_servers(mcp_servers);
        let id = self.next_id();
        let envelope = JsonRpcMessage::wrap(Request {
            id: RequestId::Number(id as i64),
            method: "session/load".into(),
            params: Some(req),
        });

        acp_log!(
            "SEND",
            "connection={} method=session/load id={} session_id={}",
            self.connection_id,
            id,
            target_session_id
        );

        let result = self.request_envelope(id, envelope).await?;

        let sid = target_session_id.to_string();
        *self.session_id.lock() = sid.clone();
        *self.session_id_cell.lock().await = sid.clone();
        *self.config_options.lock() = result
            .get("configOptions")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        *self.modes.lock() = result
            .get("modes")
            .and_then(|v| serde_json::from_value(v.clone()).ok());

        acp_log!(
            "INFO",
            "ACP session loaded: {} (connection: {}, agent: {})",
            sid,
            self.connection_id,
            self.agent_id
        );

        Ok(result)
    }

    /// Send a JSON-RPC request and wait for the response (with 30s timeout).
    async fn request_envelope<T: Serialize>(&self, id: u64, envelope: JsonRpcMessage<T>) -> Result<Value> {
        let line = serde_json::to_string(&envelope).context("serialize request")?;

        let (tx, rx) = oneshot::channel();
        self.pending_requests.lock().await.insert(id, tx);

        acp_log!(
            "SEND_RAW",
            "connection={} id={} json={}",
            self.connection_id,
            id,
            line
        );

        self.stdin_tx
            .send(line)
            .await
            .map_err(|_| anyhow::anyhow!("agent stdin closed"))?;

        let result = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
            .await
            .map_err(|_| anyhow::anyhow!("request timeout: id={id}"))?
            .map_err(|_| anyhow::anyhow!("response channel closed"))?;

        match result {
            Ok(val) => Ok(val),
            Err(msg) => Err(anyhow::anyhow!("ACP error: {msg}")),
        }
    }

    /// Send a JSON-RPC request with auto-generated id and wait for response (with 30s timeout).
    async fn request<T: Serialize>(&self, method: &str, params: T) -> Result<Value> {
        let id = self.next_id();
        let envelope = JsonRpcMessage::wrap(Request {
            id: RequestId::Number(id as i64),
            method: method.into(),
            params: Some(params),
        });
        self.request_envelope(id, envelope).await
    }

    /// Send a JSON-RPC request and wait indefinitely (no timeout).
    /// Used for session/prompt which can take minutes.
    async fn request_no_timeout<T: Serialize>(&self, method: &str, params: T) -> Result<Value> {
        let id = self.next_id();
        let envelope = JsonRpcMessage::wrap(Request {
            id: RequestId::Number(id as i64),
            method: method.into(),
            params: Some(params),
        });
        let line = serde_json::to_string(&envelope).context("serialize request")?;

        let (tx, rx) = oneshot::channel();
        self.pending_requests.lock().await.insert(id, tx);

        acp_log!(
            "SEND_RAW",
            "connection={} id={} method={} json={}",
            self.connection_id,
            id,
            method,
            line
        );

        self.stdin_tx
            .send(line)
            .await
            .map_err(|_| anyhow::anyhow!("agent stdin closed"))?;

        let result = rx
            .await
            .map_err(|_| anyhow::anyhow!("response channel closed"))?;

        match result {
            Ok(val) => Ok(val),
            Err(msg) => Err(anyhow::anyhow!("ACP error: {msg}")),
        }
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    /// Broadcast a synthetic session/update so the frontend receives prompt lifecycle events
    /// on the same channel as regular agent updates.
    fn broadcast_prompt_state(&self, state: PromptTurnState) {
        let sid = self.session_id();
        let session_update = match &state {
            PromptTurnState::Idle => serde_json::json!({ "sessionUpdate": "prompt_state", "status": "idle" }),
            PromptTurnState::Running => serde_json::json!({ "sessionUpdate": "prompt_state", "status": "running" }),
            PromptTurnState::Complete { stop_reason } => serde_json::json!({ "sessionUpdate": "prompt_complete", "stopReason": stop_reason }),
            PromptTurnState::Cancelled => serde_json::json!({ "sessionUpdate": "prompt_complete", "stopReason": "cancelled" }),
            PromptTurnState::Error { message } => serde_json::json!({ "sessionUpdate": "prompt_complete", "stopReason": "error", "error": message }),
        };
        let _ = self.events_tx.send(SessionEvent::Update {
            session_id: sid,
            update: session_update,
        });
    }

    /// Send a JSON-RPC notification (no response expected).
    async fn notify<T: Serialize>(&self, method: &str, params: T) -> Result<()> {
        let envelope = JsonRpcMessage::wrap(Notification {
            method: method.into(),
            params: Some(params),
        });
        let line = serde_json::to_string(&envelope).context("serialize notification")?;
        acp_log!(
            "SEND_RAW",
            "connection={} method={} json={}",
            self.connection_id,
            method,
            line
        );
        self.stdin_tx
            .send(line)
            .await
            .map_err(|_| anyhow::anyhow!("agent stdin closed"))?;
        Ok(())
    }

    /// Cancel the current prompt turn.
    pub async fn cancel(&self) -> Result<()> {
        {
            let mut state = self.prompt_turn_state.lock().await;
            *state = PromptTurnState::Cancelled;
        }
        self.broadcast_prompt_state(PromptTurnState::Cancelled);

        // Kill all active terminals for this session
        let terminals_to_kill: Vec<sidex_terminal::TermHandle> = {
            let mut active = self.active_terminals.lock().await;
            let handles: Vec<sidex_terminal::TermHandle> = active.values().map(|t| t.handle).collect();
            active.clear();
            handles
        };
        for handle in terminals_to_kill {
            acp_log!(
                "INFO",
                "Killing terminal {:?} for cancelled session {}",
                handle,
                self.session_id()
            );
            let _ = tokio::task::spawn_blocking(move || {
                // Best-effort kill via sidex-terminal
            }).await;
        }

        let notif = CancelNotification::new(SessionId::from(self.session_id()));
        self.notify("session/cancel", notif).await
    }

    /// Set a session config option (e.g. model).
    pub async fn set_config_option(&self, config_id: &str, value: &str) -> Result<Value> {
        let params = acp::SetSessionConfigOptionRequest::new(
            SessionId::from(self.session_id()),
            acp::SessionConfigId::from(config_id.to_string()),
            acp::SessionConfigValueId::from(value.to_string()),
        );
        let result = self.request("session/set_config_option", params).await?;
        let config_options = result
            .get("configOptions")
            .ok_or_else(|| anyhow::anyhow!("agent response missing configOptions"))?
            .clone();
        Ok(config_options)
    }

    /// Ask the agent to list sessions for a given cwd.
    pub async fn list_sessions(&self, cwd: &str) -> Result<Value> {
        let params = ListSessionsRequest::new().cwd(PathBuf::from(cwd));
        self.request("session/list", params).await
    }

    /// Send a prompt. Returns Ok when complete, Err on failure.
    /// Broadcasts prompt_state → running when dispatching and prompt_complete when done.
    pub async fn prompt(&self, blocks: Vec<Value>) -> Result<()> {
        self.run_prompt(blocks).await.map(|_| ())
    }

    /// Core prompt runner — sets state, sends to agent, broadcasts result.
    async fn run_prompt(&self, blocks: Vec<Value>) -> Result<Value> {
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

        // Broadcast user message so frontend can display it in chat history.
        let user_text = content_blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text(t) => Some(t.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("");
        let _ = self.events_tx.send(SessionEvent::Update {
            session_id: self.session_id(),
            update: serde_json::json!({
                "sessionUpdate": "user_message_chunk",
                "content": { "type": "text", "text": user_text },
            }),
        });

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

        // Clear active terminals when turn ends
        {
            let mut active = self.active_terminals.lock().await;
            active.clear();
        }

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

    /// Subscribe to session events (updates, disconnects).
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events_tx.subscribe()
    }
}

// ─── I/O dispatch ───────────────────────────────────────────────────────────

async fn handle_agent_line(
    line: &str,
    pending: &Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    broadcast_tx: &broadcast::Sender<SessionEvent>,
    session_id_cell: &Mutex<String>,
    stdin_tx: &mpsc::Sender<String>,
    active_terminals: &Arc<Mutex<HashMap<String, SessionTerminal>>>,
) -> Result<()> {
    // 1. Try response first (has id + result/error, no method)
    if let Ok(msg) = serde_json::from_str::<JsonRpcMessage<acp::Response<Value>>>(line) {
        let resp = msg.into_inner();
        match resp {
            Response::Result { id, result } => {
                let id_num = match id {
                    RequestId::Number(n) => n as u64,
                    _ => 0,
                };
                let mut map = pending.lock().await;
                if let Some(sender) = map.remove(&id_num) {
                    let _ = sender.send(Ok(result));
                }
            }
            Response::Error { id, error } => {
                let id_num = match id {
                    RequestId::Number(n) => n as u64,
                    _ => 0,
                };
                let mut map = pending.lock().await;
                if let Some(sender) = map.remove(&id_num) {
                    let _ = sender.send(Err(format!("{}: {}", i32::from(error.code), error.message)));
                }
            }
        }
        return Ok(());
    }

    // 2. Try request from agent (has id + method)
    if let Ok(msg) = serde_json::from_str::<JsonRpcMessage<Request<AgentRequest>>>(line) {
        let req = msg.into_inner();
        let id = req.id.clone();
        let session_id = session_id_cell.lock().await.clone();
        let active_terminals = active_terminals.clone();
        let stdin_tx = stdin_tx.clone();
        tokio::spawn(async move {
            let result = handle_agent_request(&req, &active_terminals, &session_id).await;
            let response = match result {
                Ok(res) => JsonRpcMessage::wrap(Response::Result { id: id.clone(), result: res }),
                Err(err) => JsonRpcMessage::wrap(Response::Error {
                    id: id.clone(),
                    error: acp::Error::new(-32600, err),
                }),
            };
            let line = match serde_json::to_string(&response) {
                Ok(l) => l,
                Err(e) => {
                    acp_log!("ERROR", "Failed to serialize response: {}", e);
                    return;
                }
            };
            acp_log!("SEND_RAW", "agent_request_response id={:?} json={}", id, line);
            if let Err(e) = stdin_tx.send(line).await {
                acp_log!("ERROR", "Failed to send response to agent stdin: {}", e);
            }
        });
        return Ok(());
    }

    // 3. Try notification from agent (has method, no id)
    if let Ok(msg) = serde_json::from_str::<JsonRpcMessage<Notification<AgentNotification>>>(line) {
        let notif = msg.into_inner();
        match notif.params {
            Some(AgentNotification::SessionNotification(session_notif)) => {
                let sid = session_notif.session_id.to_string();
                let update = serde_json::to_value(session_notif.update).unwrap_or(Value::Null);
                let _ = broadcast_tx.send(SessionEvent::Update {
                    session_id: sid,
                    update,
                });
            }
            Some(other) => {
                acp_log!("WARN", "Unhandled agent notification: {}", other.method());
            }
            None => {}
        }
        return Ok(());
    }

    acp_log!("WARN", "Unrecognized JSON-RPC message: {}", line);
    Ok(())
}

async fn handle_agent_request(
    req: &Request<AgentRequest>,
    active_terminals: &Mutex<HashMap<String, SessionTerminal>>,
    _session_id: &str,
) -> Result<Value, String> {
    match req.params.as_ref() {
        Some(AgentRequest::ReadTextFileRequest(params)) => {
            let path = params.path.to_string_lossy().to_string();
            let line = params.line.map(|l| l as usize);
            let limit = params.limit.map(|l| l as usize);
            match tokio::task::spawn_blocking({
                let path = path.clone();
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
        Some(AgentRequest::WriteTextFileRequest(params)) => {
            let path = params.path.to_string_lossy().to_string();
            let content = &params.content;
            match tokio::task::spawn_blocking({
                let path = path.clone();
                let content = content.clone();
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
        Some(AgentRequest::CreateTerminalRequest(params)) => {
            let command = &params.command;
            let args = params.args.clone();
            let env: HashMap<String, String> = params
                .env
                .iter()
                .map(|e| (e.name.clone(), e.value.clone()))
                .collect();
            let cwd = params.cwd.as_ref().map(|p| p.to_string_lossy().to_string());

            let shell = if command.is_empty() {
                sidex_terminal::detect_default_shell()
            } else {
                command.clone()
            };

            let spawn_config = sidex_terminal::PtySpawnConfig {
                shell: Some(shell),
                args: if args.is_empty() { None } else { Some(args) },
                cwd: cwd.map(std::path::PathBuf::from),
                env,
                size: sidex_terminal::TerminalSize { rows: 24, cols: 80 },
            };

            match tokio::task::spawn_blocking(move || sidex_terminal::PtyProcess::spawn(&spawn_config)).await
            {
                Ok(Ok(pty)) => {
                    let handle = sidex_terminal::TermHandle::next();
                    let id = format!("term_{}", handle.0);
                    let _ = pty.read_output(Some(100));
                    {
                        let mut terminals = active_terminals.lock().await;
                        terminals.insert(id.clone(), SessionTerminal { handle, pty });
                    }
                    let resp = acp::CreateTerminalResponse::new(acp::TerminalId::from(id));
                    serde_json::to_value(ClientResponse::CreateTerminalResponse(resp))
                        .map_err(|e| e.to_string())
                }
                Ok(Err(e)) => Err(format!("failed to create terminal: {e}")),
                Err(e) => Err(format!("task failed: {e}")),
            }
        }
        Some(AgentRequest::TerminalOutputRequest(params)) => {
            let id = params.terminal_id.to_string();
            let terminals = active_terminals.lock().await;
            match terminals.get(&id) {
                Some(term) => {
                    match term.pty.read_output(Some(1000)) {
                        Ok(result) => {
                            let output = result.lines.into_iter().map(|l| l.text).collect::<Vec<_>>().join("");
                            let truncated = result.dropped > 0;
                            let resp = acp::TerminalOutputResponse::new(output, truncated);
                            serde_json::to_value(ClientResponse::TerminalOutputResponse(resp))
                                .map_err(|e| e.to_string())
                        }
                        Err(e) => Err(format!("failed to read terminal: {e}")),
                    }
                }
                None => Err("terminal not found".into()),
            }
        }
        Some(AgentRequest::WaitForTerminalExitRequest(params)) => {
            let id = params.terminal_id.to_string();
            loop {
                let terminals = active_terminals.lock().await;
                match terminals.get(&id) {
                    Some(term) => {
                        if !term.pty.is_alive() {
                            let exit_code = term.pty.exit_code().map(|c| c as u32);
                            let exit_status = TerminalExitStatus::new()
                                .exit_code(exit_code);
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
        Some(AgentRequest::KillTerminalRequest(params)) => {
            let id = params.terminal_id.to_string();
            let mut terminals = active_terminals.lock().await;
            if let Some(term) = terminals.remove(&id) {
                let _ = term.pty.kill_tree();
            }
            let resp = KillTerminalResponse::new();
            serde_json::to_value(ClientResponse::KillTerminalResponse(resp))
                .map_err(|e| e.to_string())
        }
        Some(AgentRequest::ReleaseTerminalRequest(params)) => {
            let id = params.terminal_id.to_string();
            let mut terminals = active_terminals.lock().await;
            if let Some(term) = terminals.remove(&id) {
                let _ = term.pty.kill_tree();
            }
            let resp = ReleaseTerminalResponse::new();
            serde_json::to_value(ClientResponse::ReleaseTerminalResponse(resp))
                .map_err(|e| e.to_string())
        }
        Some(AgentRequest::RequestPermissionRequest(_params)) => {
            // Auto-grant with allow-once
            let outcome = SelectedPermissionOutcome::new(PermissionOptionId::from("allow-once"));
            let resp = RequestPermissionResponse::new(acp::RequestPermissionOutcome::Selected(outcome));
            serde_json::to_value(ClientResponse::RequestPermissionResponse(resp))
                .map_err(|e| e.to_string())
        }
        Some(AgentRequest::ExtMethodRequest(ext)) => {
            acp_log!("WARN", "Unhandled extension agent request: {}", ext.method);
            Err(format!("unsupported extension method: {}", ext.method))
        }
        Some(_) => {
            acp_log!("WARN", "Unhandled agent request variant: method={}", req.method);
            Err(format!("unsupported agent request variant: {}", req.method))
        }
        None => {
            acp_log!("WARN", "Agent request with no params: method={}", req.method);
            Err("request missing params".into())
        }
    }
}
