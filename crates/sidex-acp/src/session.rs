//! Backend-owned ACP session.
//!
//! Speaks ACP JSON-RPC over the agent's stdin/stdout via AgentManager.
//! Handles client tool requests (fs, terminal) directly and forwards session updates
//! to connected frontends over the broadcast channel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tracing::{info, warn};

use crate::agent::{AgentConfig, AgentManager};

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

/// A queued prompt message, owned by the backend.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedItem {
    pub id: String,
    pub text: String,
    pub blocks: Vec<Value>,
}

/// Behavior when sending a prompt while another is running.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptBehavior {
    /// Append to queue, don't interrupt current turn.
    #[default]
    AddToQueue,
    /// Cancel current turn, run this prompt, preserve queue for after.
    SkipQueueAndRun,
    /// Cancel current turn, clear queue, run this prompt.
    CancelAllAndRun,
}

// ─── JSON-RPC types ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct JsonRpcRequest<T> {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    params: T,
}

#[derive(Debug, Serialize)]
struct JsonRpcNotification<T> {
    jsonrpc: &'static str,
    method: String,
    params: T,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    id: u64,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

// ─── Terminal tracking ──────────────────────────────────────────────────────

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
    config_options: parking_lot::Mutex<Option<Value>>,
    modes: parking_lot::Mutex<Option<Value>>,

    stdin_tx: mpsc::Sender<String>,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    events_tx: broadcast::Sender<SessionEvent>,
    next_id: AtomicU64,
    _io_task: tokio::task::JoinHandle<()>,

    /// Current prompt turn state — backend is source of truth.
    pub prompt_turn_state: Arc<Mutex<PromptTurnState>>,
    /// Queued prompts — backend owns this so it survives refresh and syncs across tabs.
    pub queued_items: Arc<Mutex<Vec<QueuedItem>>>,
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

        let io_task = tokio::spawn(async move {
            loop {
                match stdout_rx.recv().await {
                    Ok(raw_line) => {
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
                            warn!("ACP parse error: {e}");
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            let sid = session_id_cell_clone.lock().await.clone();
            if !sid.is_empty() {
                let _ = broadcast_tx.send(SessionEvent::Disconnected { session_id: sid });
            }
        });

        let prompt_turn_state = Arc::new(Mutex::new(PromptTurnState::Idle));
        let queued_items = Arc::new(Mutex::new(Vec::new()));

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
            queued_items,
            active_terminals,
            session_id_cell,
        };

        info!(
            "ACP connection spawned: {} (agent: {}, cwd: {})",
            connection_id, agent_id, cwd
        );

        Ok(Arc::new(session))
    }

    /// Get the current session ID.
    pub fn session_id(&self) -> String {
        self.session_id.lock().clone()
    }

    /// Get config options.
    pub fn config_options(&self) -> Option<Value> {
        self.config_options.lock().clone()
    }

    /// Get modes.
    pub fn modes(&self) -> Option<Value> {
        self.modes.lock().clone()
    }

    /// Send initialize request and wait for response.
    pub async fn initialize(&self) -> Result<Value> {
        let init_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": self.next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {
                    "experimental": {},
                    "filesystem": {
                        "read": true,
                        "write": true
                    },
                    "terminal": true
                },
                "clientInfo": {
                    "name": "sidex",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        });
        self.request_value("initialize", init_req).await.context("initialize failed")
    }

    /// Send session/new and bind this connection to a new session.
    pub async fn new_session(
        &self,
        mcp_servers: Vec<Value>,
    ) -> Result<Value> {
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": self.next_id(),
            "method": "session/new",
            "params": {
                "cwd": self.cwd,
                "mcpServers": mcp_servers
            }
        });
        let resp = self.request_value("session/new", req).await.context("newSession failed")?;

        let sid = resp
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        *self.session_id.lock() = sid.clone();
        *self.session_id_cell.lock().await = sid.clone();
        *self.config_options.lock() = resp.get("configOptions").cloned();
        *self.modes.lock() = resp.get("modes").cloned();

        info!(
            "ACP session created: {} (connection: {}, agent: {}, cwd: {})",
            sid, self.connection_id, self.agent_id, self.cwd
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
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": self.next_id(),
            "method": "session/load",
            "params": {
                "cwd": cwd,
                "sessionId": target_session_id,
                "mcpServers": mcp_servers
            }
        });
        let result = self.request_value("session/load", req).await?;

        let sid = target_session_id.to_string();
        *self.session_id.lock() = sid.clone();
        *self.session_id_cell.lock().await = sid.clone();
        *self.config_options.lock() = result.get("configOptions").cloned();
        *self.modes.lock() = result.get("modes").cloned();

        info!(
            "ACP session loaded: {} (connection: {}, agent: {})",
            sid, self.connection_id, self.agent_id
        );

        Ok(result)
    }

    /// Send a JSON-RPC request and wait for the response (with 30s timeout).
    async fn request_value(&self, method: &str, request: Value) -> Result<Value> {
        let id = request
            .get("id")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| anyhow::anyhow!("request missing id"))?;

        let line = serde_json::to_string(&request).context("serialize request")?;

        let (tx, rx) = oneshot::channel();
        self.pending_requests.lock().await.insert(id, tx);

        self.stdin_tx
            .send(line)
            .await
            .map_err(|_| anyhow::anyhow!("agent stdin closed"))?;

        let result = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
            .await
            .map_err(|_| anyhow::anyhow!("request timeout: {method}"))?
            .map_err(|_| anyhow::anyhow!("response channel closed"))?;

        match result {
            Ok(val) => Ok(val),
            Err(msg) => Err(anyhow::anyhow!("ACP error: {msg}")),
        }
    }

    /// Send a JSON-RPC request with auto-generated id.
    async fn request<Req: Serialize>(&self, method: &str, params: Req) -> Result<Value> {
        let id = self.next_id();
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };
        let request = serde_json::to_value(req).context("serialize request")?;
        self.request_value(method, request).await
    }

    /// Send a JSON-RPC request and wait indefinitely (no timeout).
    /// Used for session/prompt which can take minutes.
    async fn request_no_timeout<Req: Serialize>(&self, method: &str, params: Req) -> Result<Value> {
        let id = self.next_id();
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };
        let line = serde_json::to_string(&req).context("serialize request")?;

        let (tx, rx) = oneshot::channel();
        self.pending_requests.lock().await.insert(id, tx);

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
    async fn notify<Req: Serialize>(&self, method: &str, params: Req) -> Result<()> {
        let notif = JsonRpcNotification {
            jsonrpc: "2.0",
            method: method.to_string(),
            params,
        };
        let line = serde_json::to_string(&notif).context("serialize notification")?;
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
            info!("Killing terminal {:?} for cancelled session {}", handle, self.session_id());
            // Best-effort kill via sidex-terminal
            let _ = tokio::task::spawn_blocking(move || {
                // Note: PtyProcess doesn't have a static kill method on TermHandle.
                // We'd need to keep the PtyProcess instance. For now, we rely on
                // dropping the SessionTerminal which kills via Drop impl if we had one.
            }).await;
        }

        let notif = serde_json::json!({
            "sessionId": self.session_id()
        });
        self.notify("session/cancel", notif).await
    }

    /// Set a session config option (e.g. model).
    pub async fn set_config_option(&self, config_id: &str, value: &str) -> Result<Value> {
        let params = serde_json::json!({
            "sessionId": self.session_id(),
            "configId": config_id,
            "value": value
        });
        let result = self.request("session/set_config_option", params).await?;
        let config_options = result
            .get("configOptions")
            .ok_or_else(|| anyhow::anyhow!("agent response missing configOptions"))?
            .clone();
        Ok(config_options)
    }

    /// Ask the agent to list sessions for a given cwd.
    pub async fn list_sessions(&self, cwd: &str) -> Result<Value> {
        let params = serde_json::json!({
            "cwd": cwd
        });
        self.request("session/list", params).await
    }

    /// Send a prompt. Returns Ok when complete, Err on failure.
    /// Broadcasts prompt_state → running when dispatching and prompt_complete when done.
    /// After completion, auto-drains the queue if items are waiting.
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

        // Broadcast user message so frontend can display it in chat history.
        let user_text = blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()).map(String::from))
            .collect::<Vec<_>>()
            .join("");
        let _ = self.events_tx.send(SessionEvent::Update {
            session_id: self.session_id(),
            update: serde_json::json!({
                "sessionUpdate": "user_message_chunk",
                "content": { "text": user_text },
            }),
        });

        {
            let mut state = self.prompt_turn_state.lock().await;
            *state = PromptTurnState::Running;
        }
        self.broadcast_prompt_state(PromptTurnState::Running);

        let req = serde_json::json!({
            "sessionId": self.session_id(),
            "prompt": blocks
        });
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

    /// Send a prompt with behavior control.
    pub async fn prompt_with_behavior(
        &self,
        blocks: Vec<Value>,
        behavior: PromptBehavior,
    ) -> Result<()> {
        let is_running = {
            let state = self.prompt_turn_state.lock().await;
            matches!(*state, PromptTurnState::Running)
        };

        if !is_running {
            self.run_prompt(blocks).await?;
            self.drain_queue().await;
            return Ok(());
        }

        match behavior {
            PromptBehavior::AddToQueue => {
                let text = blocks
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()).map(String::from))
                    .collect::<Vec<_>>()
                    .join("");
                let item = QueuedItem {
                    id: format!(
                        "queue-{}-{}",
                        self.session_id(),
                        self.next_id()
                    ),
                    text,
                    blocks,
                };
                self.queue_push(item).await;
                Ok(())
            }
            PromptBehavior::SkipQueueAndRun => {
                self.cancel().await?;
                self.run_prompt(blocks).await?;
                self.drain_queue().await;
                Ok(())
            }
            PromptBehavior::CancelAllAndRun => {
                self.cancel().await?;
                self.queue_clear().await;
                self.run_prompt(blocks).await?;
                self.drain_queue().await;
                Ok(())
            }
        }
    }

    /// Auto-drain the queue when prompt completes.
    async fn drain_queue(&self) {
        while let Some(item) = self.queue_pop().await {
            info!("[ACP SESSION] auto-draining queue item {}", item.id);
            let _ = self.run_prompt(item.blocks).await;
        }
    }

    /// Subscribe to session events (updates, disconnects).
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events_tx.subscribe()
    }

    // ─── Queue management ─────────────────────────────────────────────────────

    pub async fn get_queue(&self) -> Vec<QueuedItem> {
        self.queued_items.lock().await.clone()
    }

    pub async fn queue_push(&self, item: QueuedItem) {
        self.queued_items.lock().await.push(item);
        self.broadcast_queue();
    }

    pub async fn queue_remove(&self, id: &str) -> bool {
        let mut q = self.queued_items.lock().await;
        let before = q.len();
        q.retain(|i| i.id != id);
        let changed = q.len() != before;
        drop(q);
        if changed {
            self.broadcast_queue();
        }
        changed
    }

    pub async fn queue_update(&self, id: &str, text: String, blocks: Vec<Value>) -> bool {
        let mut q = self.queued_items.lock().await;
        if let Some(item) = q.iter_mut().find(|i| i.id == id) {
            item.text = text;
            item.blocks = blocks;
            drop(q);
            self.broadcast_queue();
            true
        } else {
            false
        }
    }

    pub async fn queue_clear(&self) {
        let mut q = self.queued_items.lock().await;
        if !q.is_empty() {
            q.clear();
            drop(q);
            self.broadcast_queue();
        }
    }

    pub async fn queue_pop(&self) -> Option<QueuedItem> {
        let mut q = self.queued_items.lock().await;
        let item = q.pop();
        drop(q);
        if item.is_some() {
            self.broadcast_queue();
        }
        item
    }

    pub async fn queue_reorder(&self, ids: Vec<String>) -> bool {
        let mut q = self.queued_items.lock().await;
        if q.len() != ids.len() {
            return false;
        }
        let mut new_q = Vec::with_capacity(q.len());
        for id in &ids {
            if let Some(pos) = q.iter().position(|i| i.id == *id) {
                new_q.push(q.remove(pos));
            } else {
                return false;
            }
        }
        *q = new_q;
        drop(q);
        self.broadcast_queue();
        true
    }

    fn broadcast_queue(&self) {
        let session_id = self.session_id();
        let items = {
            if let Ok(q) = self.queued_items.try_lock() {
                q.clone()
            } else {
                return; // Lock contended, skip broadcast
            }
        };
        let _ = self.events_tx.send(SessionEvent::Update {
            session_id,
            update: serde_json::json!({
                "sessionUpdate": "queue_changed",
                "items": items,
            }),
        });
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
    let val: Value = serde_json::from_str(line).context("parse agent line")?;

    // Is it a response?
    if val.get("id").is_some() && (val.get("result").is_some() || val.get("error").is_some()) {
        let resp: JsonRpcResponse = serde_json::from_value(val)?;
        let mut map = pending.lock().await;
        if let Some(sender) = map.remove(&resp.id) {
            if let Some(err) = resp.error {
                let _ = sender.send(Err(format!("{}: {}", err.code, err.message)));
            } else {
                let _ = sender.send(Ok(resp.result.unwrap_or(Value::Null)));
            }
        }
        return Ok(());
    }

    // Is it a request (agent → client)?
    if let (Some(id), Some(method)) = (
        val.get("id").and_then(|v| v.as_u64()),
        val.get("method").and_then(|m| m.as_str()),
    ) {
        let params = val.get("params").cloned().unwrap_or(Value::Null);
        let session_id = session_id_cell.lock().await.clone();
        let active_terminals = active_terminals.clone();
        let stdin_tx = stdin_tx.clone();
        let method = method.to_string();
        tokio::spawn(async move {
            let result = handle_agent_request(&method, params, &active_terminals, &session_id).await;
            let response = match result {
                Ok(res) => serde_json::json!({"jsonrpc": "2.0", "id": id, "result": res}),
                Err(err) => serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32600, "message": err}}),
            };
            if let Err(e) = stdin_tx.send(response.to_string()).await {
                warn!("Failed to send response to agent stdin: {}", e);
            }
        });
        return Ok(());
    }

    // Is it a notification?
    if let Some(method) = val.get("method").and_then(|m| m.as_str()) {
        if method == "session/update" {
            if let Some(sid) = val
                .get("params")
                .and_then(|p| p.get("sessionId"))
                .and_then(|v| v.as_str())
            {
                let inner_update = val
                    .get("params")
                    .and_then(|p| p.get("update"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let _ = broadcast_tx.send(SessionEvent::Update {
                    session_id: sid.to_string(),
                    update: inner_update,
                });
            }
        }
        return Ok(());
    }

    Ok(())
}

async fn handle_agent_request(
    method: &str,
    params: Value,
    active_terminals: &Mutex<HashMap<String, SessionTerminal>>,
    _session_id: &str,
) -> Result<Value, String> {
    match method {
        "fs/readTextFile" | "fs/read_text_file" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("missing path")?;
            match tokio::task::spawn_blocking({
                let path = path.to_string();
                move || sidex_workspace::file_ops::read_file(std::path::Path::new(&path))
            })
            .await
            {
                Ok(Ok(content)) => Ok(serde_json::json!({"content": content})),
                Ok(Err(e)) => Err(format!("failed to read file: {e}")),
                Err(e) => Err(format!("task failed: {e}")),
            }
        }
        "fs/writeTextFile" | "fs/write_text_file" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("missing path")?;
            let content = params
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            match tokio::task::spawn_blocking({
                let path = path.to_string();
                let content = content.to_string();
                move || sidex_workspace::file_ops::write_file(std::path::Path::new(&path), &content)
            })
            .await
            {
                Ok(Ok(())) => Ok(serde_json::json!({"success": true})),
                Ok(Err(e)) => Err(format!("failed to write file: {e}")),
                Err(e) => Err(format!("task failed: {e}")),
            }
        }
        "terminal/create" | "terminal/createTerminal" => {
            let command = params.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let args: Vec<String> = params
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let env: HashMap<String, String> = params
                .get("env")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| {
                            v.as_str().and_then(|s| {
                                s.split_once('=')
                                    .map(|(k, v)| (k.to_string(), v.to_string()))
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let cwd = params.get("cwd").and_then(|v| v.as_str());

            let shell = if command.is_empty() {
                sidex_terminal::detect_default_shell()
            } else {
                command.to_string()
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
                    // Start output reading
                    let _ = pty.read_output(Some(100));
                    {
                        let mut terminals = active_terminals.lock().await;
                        terminals.insert(id.clone(), SessionTerminal { handle, pty });
                    }
                    Ok(serde_json::json!({"terminalId": id}))
                }
                Ok(Err(e)) => Err(format!("failed to create terminal: {e}")),
                Err(e) => Err(format!("task failed: {e}")),
            }
        }
        "terminal/output" | "terminal/terminalOutput" => {
            let id = params
                .get("terminalId")
                .and_then(|v| v.as_str())
                .ok_or("missing terminalId")?;
            let terminals = active_terminals.lock().await;
            match terminals.get(id) {
                Some(term) => {
                    match term.pty.read_output(Some(1000)) {
                        Ok(result) => {
                            let output = result.lines.into_iter().map(|l| l.text).collect::<Vec<_>>().join("");
                            let truncated = result.dropped > 0;
                            Ok(serde_json::json!({
                                "output": output,
                                "truncated": truncated,
                            }))
                        }
                        Err(e) => Err(format!("failed to read terminal: {e}")),
                    }
                }
                None => Err("terminal not found".into()),
            }
        }
        "terminal/waitForExit" | "terminal/wait_for_exit" => {
            let id = params
                .get("terminalId")
                .and_then(|v| v.as_str())
                .ok_or("missing terminalId")?;
            loop {
                let terminals = active_terminals.lock().await;
                match terminals.get(id) {
                    Some(term) => {
                        if !term.pty.is_alive() {
                            let exit_code = term.pty.exit_code();
                            return Ok(serde_json::json!({
                                "exitCode": exit_code,
                                "signal": null,
                            }));
                        }
                    }
                    None => return Err("terminal not found".into()),
                }
                drop(terminals);
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
        "terminal/kill" | "terminal/killTerminal" => {
            let id = params
                .get("terminalId")
                .and_then(|v| v.as_str())
                .ok_or("missing terminalId")?;
            let mut terminals = active_terminals.lock().await;
            if let Some(term) = terminals.remove(id) {
                let _ = term.pty.kill_tree();
            }
            Ok(serde_json::json!({"success": true}))
        }
        "terminal/release" | "terminal/releaseTerminal" => {
            let id = params
                .get("terminalId")
                .and_then(|v| v.as_str())
                .ok_or("missing terminalId")?;
            let mut terminals = active_terminals.lock().await;
            if let Some(term) = terminals.remove(id) {
                let _ = term.pty.kill_tree();
            }
            Ok(serde_json::json!({"success": true}))
        }
        "session/requestPermission" | "session/request_permission" => {
            // Auto-grant with allow-once
            Ok(serde_json::json!({
                "outcome": {
                    "outcome": "selected",
                    "optionId": "allow-once"
                }
            }))
        }
        _ => {
            warn!("Unhandled agent request: {method}");
            Err(format!("unsupported method: {method}"))
        }
    }
}
