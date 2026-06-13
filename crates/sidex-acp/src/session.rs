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
    AgentNotification, CancelNotification, ClientCapabilities,
    ContentBlock, FileSystemCapabilities, Implementation,
    InitializeRequest, JsonRpcMessage, ListSessionsRequest,
    LoadSessionRequest, NewSessionRequest, Notification,
    PromptRequest, ProtocolVersion,
    Request, RequestId, Response,
    SessionConfigOption, SessionId, SessionModeState,
};

use crate::agent::{AgentConfig, AgentManager};

// ─── File logger ───────────────────────────────────────────────────────────

/// Dedicated file logger. Never writes to stdout/stderr.
pub(crate) struct FileLogger {
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

    pub(crate) fn log(&self, level: &str, msg: &str) {
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let line = format!("[{}] [{}] {}\n", ts, level, msg);
        let _ = self.file.lock().unwrap().write_all(line.as_bytes());
    }
}

pub(crate) fn logger() -> &'static FileLogger {
    static INSTANCE: OnceLock<FileLogger> = OnceLock::new();
    INSTANCE.get_or_init(FileLogger::new)
}

#[macro_export]
macro_rules! acp_log {
    ($level:expr, $($arg:tt)*) => {
        $crate::session::logger().log($level, &format!($($arg)*))
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

/// Events broadcast when ACP session terminal state changes.
#[derive(Clone, Debug)]
pub enum TerminalEvent {
    Data {
        terminal_id: String,
        data: String,
    },
    Exit {
        terminal_id: String,
        exit_code: Option<i32>,
    },
}

/// Info about a terminal created by this session.
pub struct SessionTerminal {
    pub handle: sidex_terminal::TermHandle,
    pub pty: sidex_terminal::PtyProcess,
    /// Accumulated output — drain loop writes, agent + frontend read.
    pub output: String,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub command: String,
    pub cwd: Option<String>,
}

// ─── Orchestration types ────────────────────────────────────────────────────

/// Delegation state machine for orchestrator agents.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum DelegationState {
    #[default]
    NotCalled,
    WaitingForResponse,
    Responding,
}

/// A task in the orchestrator's task list.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub assigned_to: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// Task execution status.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
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
    /// Agent config used to spawn this session (for re-spawn on session switch).
    pub agent_config: AgentConfig,
    config_options: parking_lot::Mutex<Option<Vec<SessionConfigOption>>>,
    modes: parking_lot::Mutex<Option<SessionModeState>>,

    stdin_tx: mpsc::Sender<String>,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    pub events_tx: broadcast::Sender<SessionEvent>,
    next_id: AtomicU64,
    _io_task: tokio::task::JoinHandle<()>,

    /// Current prompt turn state — backend is source of truth.
    pub prompt_turn_state: Arc<Mutex<PromptTurnState>>,
    /// Active terminals created by this session during current prompt turn.
    pub active_terminals: Arc<Mutex<HashMap<String, SessionTerminal>>>,
    /// Shared cell so the I/O task knows the current session ID.
    session_id_cell: Arc<Mutex<String>>,
    /// Broadcast channel for terminal events (data, exit) — manager subscribes to forward to frontend.
    terminal_events_tx: broadcast::Sender<TerminalEvent>,
    
    /// Orchestration: delegation state machine
    pub delegation_state: Arc<Mutex<DelegationState>>,
    /// Orchestration: task list
    pub task_list: Arc<Mutex<Vec<Task>>>,
    /// Orchestration: task queue (pending tasks to process)
    pub task_queue: Arc<Mutex<std::collections::VecDeque<Task>>>,
    /// Orchestration: queued prompts
    queue: Arc<Mutex<Vec<Vec<Value>>>>,
    /// Orchestration: manager reference (set after session is added to manager)
    manager_cell: Arc<Mutex<Option<Arc<crate::manager::AcpSessionManager>>>>,
}

impl AcpSession {
    /// Spawn an agent process and start the I/O loop.
    /// Returns an Arc with empty session_id — call initialize() then new_session() or load_session().
    pub async fn spawn(
        agent_manager: &AgentManager,
        config: AgentConfig,
        cwd: String,
        shell_env: HashMap<String, String>,
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
        let terminal_events_tx = broadcast::Sender::<TerminalEvent>::new(256);
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
        let terminal_events_for_io = terminal_events_tx.clone();
        let shell_env = Arc::new(shell_env);
        let shell_env_for_io = shell_env.clone();
        let manager_cell = Arc::new(Mutex::new(None::<Arc<crate::manager::AcpSessionManager>>));
        let manager_cell_for_io = manager_cell.clone();
        let agent_config_for_io = config.clone();

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
                            &shell_env_for_io,
                            &terminal_events_for_io,
                            &manager_cell_for_io,
                            &agent_config_for_io,
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
            agent_config: config,
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
            terminal_events_tx,
            delegation_state: Arc::new(Mutex::new(DelegationState::NotCalled)),
            task_list: Arc::new(Mutex::new(Vec::new())),
            task_queue: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            queue: Arc::new(Mutex::new(Vec::new())),
            manager_cell,
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
        let terminals_to_kill: Vec<SessionTerminal> = {
            let mut active = self.active_terminals.lock().await;
            let terms: Vec<SessionTerminal> = active.drain().map(|(_, v)| v).collect();
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

        // NOTE: active_terminals are NOT cleared here. They persist until
        // the agent calls terminal/release or the session is cancelled.
        // The frontend needs to access them after the prompt turn ends.

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

    /// Subscribe to terminal events (data, exit) for this session's terminals.
    pub fn subscribe_terminal_events(&self) -> broadcast::Receiver<TerminalEvent> {
        self.terminal_events_tx.subscribe()
    }

    /// Set manager reference (called after session is added to manager).
    pub async fn set_manager(&self, manager: Arc<crate::manager::AcpSessionManager>) {
        *self.manager_cell.lock().await = Some(manager);
    }

    /// Get manager reference.
    pub async fn get_manager(&self) -> Option<Arc<crate::manager::AcpSessionManager>> {
        self.manager_cell.lock().await.clone()
    }

    // ─── Queue methods ──────────────────────────────────────────────────────

    /// Add a prompt to the queue.
    pub async fn queue_add(&self, blocks: Vec<Value>) -> Result<()> {
        self.queue.lock().await.push(blocks);
        Ok(())
    }

    /// Get the current queue length.
    pub async fn queue_len(&self) -> usize {
        self.queue.lock().await.len()
    }

    /// List queued items.
    pub async fn queue_list(&self) -> Vec<Vec<Value>> {
        self.queue.lock().await.clone()
    }

    /// Clear the queue.
    pub async fn queue_clear(&self) {
        self.queue.lock().await.clear();
    }

    /// Remove an item from the queue by index.
    pub async fn queue_remove(&self, index: usize) -> Option<()> {
        let mut queue = self.queue.lock().await;
        if index < queue.len() {
            queue.remove(index);
            Some(())
        } else {
            None
        }
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
    shell_env: &Arc<HashMap<String, String>>,
    terminal_events_tx: &broadcast::Sender<TerminalEvent>,
    manager_cell: &Arc<Mutex<Option<Arc<crate::manager::AcpSessionManager>>>>,
    agent_config: &AgentConfig,
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
    if let Ok(val) = serde_json::from_str::<Value>(line) {
        if let (Some(id_val), Some(method)) = (
            val.get("id"),
            val.get("method").and_then(|m| m.as_str()),
        ) {
            let id = serde_json::from_value::<RequestId>(id_val.clone()).unwrap_or(RequestId::Number(0));
            let params = val.get("params").cloned().unwrap_or(Value::Null);
            let session_id = session_id_cell.lock().await.clone();
            let active_terminals = active_terminals.clone();
            let stdin_tx = stdin_tx.clone();
            let shell_env = shell_env.clone();
            let terminal_events_tx = terminal_events_tx.clone();
            let manager = manager_cell.lock().await.clone();
            let agent_config = agent_config.clone();
            let method = method.to_string();
            tokio::spawn(async move {
                let ctx = crate::tools::ToolContext {
                    active_terminals,
                    session_id,
                    shell_env,
                    terminal_events_tx,
                    manager,
                    agent_config,
                };
                let result = crate::tools::route_tool_request(&method, &params, &ctx).await;
                let response = match result {
                    Ok(res) => serde_json::json!({"jsonrpc": "2.0", "id": id, "result": res}),
                    Err(err) => serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32600, "message": err}}),
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


// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use acp::{ClientResponse, ReadTextFileResponse};

    /// Verify that TerminalOutputResponse serializes to the exact JSON shape
    /// the crow-cli agent expects, including exit_status.
    #[test]
    fn terminal_output_response_serializes_correctly() {
        let resp = acp::TerminalOutputResponse::new("hello\nworld", false)
            .exit_status(acp::TerminalExitStatus::new().exit_code(Some(0u32)));
        let val = serde_json::to_value(ClientResponse::TerminalOutputResponse(resp)).unwrap();

        assert_eq!(val["output"], "hello\nworld");
        assert_eq!(val["truncated"], false);
        assert!(val["exitStatus"].is_object());
        assert_eq!(val["exitStatus"]["exitCode"], 0);
    }

    /// Verify TerminalOutputResponse without exit_status omits the field.
    #[test]
    fn terminal_output_response_omits_exit_status_when_none() {
        let resp = acp::TerminalOutputResponse::new("hello", false);
        let val = serde_json::to_value(ClientResponse::TerminalOutputResponse(resp)).unwrap();

        assert_eq!(val["output"], "hello");
        assert_eq!(val["truncated"], false);
        assert!(val.get("exitStatus").is_none());
    }

    /// Verify ReadTextFileResponse serializes to the expected shape.
    #[test]
    fn read_text_file_response_serializes_correctly() {
        let resp = ReadTextFileResponse::new("file contents here");
        let val = serde_json::to_value(ClientResponse::ReadTextFileResponse(resp)).unwrap();

        assert_eq!(val["content"], "file contents here");
    }

    /// Spawn a real PTY, run a short command, and assert we can read the
    /// full output including exit status — no e2e app required.
    #[test]
    fn pty_read_output_returns_full_output_and_exit_status() {
        let config = sidex_terminal::PtySpawnConfig {
            shell: Some(sidex_terminal::detect_default_shell()),
            args: Some(vec!["-c".to_string(), "echo hello world".to_string()]),
            cwd: None,
            env: std::collections::HashMap::new(),
            size: sidex_terminal::TerminalSize { rows: 24, cols: 80 },
        };

        let pty = sidex_terminal::PtyProcess::spawn(&config).expect("spawn pty");

        // Give the shell time to execute the command and exit.
        std::thread::sleep(std::time::Duration::from_millis(500));

        // read_output(None) must return the complete output (not truncated).
        let result = pty.read_output(None).expect("read output");
        let output = result.lines.iter().map(|l| l.text.as_str()).collect::<String>();

        assert!(
            output.contains("hello world"),
            "expected 'hello world' in PTY output, got: {output:?}"
        );

        // Process should have exited.
        assert!(!result.is_alive, "PTY should not be alive after echo exits");

        // Exit code should be available.
        let exit_code = pty.exit_code();
        assert_eq!(exit_code, Some(0), "echo should exit with code 0");
    }

    /// Verify that a command producing many lines of output is NOT truncated
    /// when read with read_output(None).
    #[test]
    fn pty_read_output_none_does_not_truncate() {
        let config = sidex_terminal::PtySpawnConfig {
            shell: Some(sidex_terminal::detect_default_shell()),
            args: Some(vec!["-c".to_string(), "for i in $(seq 1 2000); do echo line_$i; done".to_string()]),
            cwd: None,
            env: std::collections::HashMap::new(),
            size: sidex_terminal::TerminalSize { rows: 24, cols: 80 },
        };

        let pty = sidex_terminal::PtyProcess::spawn(&config).expect("spawn pty");

        // Periodically drain the channel into the ring buffer while the
        // command runs, mirroring the background task in production.
        let start = std::time::Instant::now();
        while pty.is_alive() && start.elapsed() < std::time::Duration::from_secs(5) {
            let _ = pty.read_output(None);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // Final drain after process exits.
        let result = pty.read_output(None).expect("read output");
        let output = result.lines.iter().map(|l| l.text.as_str()).collect::<String>();

        // Should contain line_1, line_2000, etc.
        assert!(output.contains("line_1"), "output should contain line_1");
        assert!(output.contains("line_2000"), "output should contain line_2000");
        assert_eq!(result.dropped, 0, "no lines should be dropped with read_output(None)");
    }
}
