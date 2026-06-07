//! Manager for multiple backend-owned ACP sessions.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use serde_json::Value;
use tokio::sync::{broadcast, Mutex};
use tracing::info;

use crate::agent::{AgentConfig, AgentManager};
use crate::session::{AcpSession, TerminalEvent};

pub use crate::session::SessionEvent;

/// Manager for multiple backend-owned ACP sessions.
pub struct AcpSessionManager {
    /// Active sessions keyed by session_id.
    sessions: Mutex<HashMap<String, Arc<AcpSession>>>,
    /// Initialized but unbound connections keyed by connection_id.
    /// These have completed initialize but not yet session/new or session/load.
    connections: Mutex<HashMap<String, Arc<AcpSession>>>,
    agent_manager: Arc<AgentManager>,
}

impl AcpSessionManager {
    pub fn new(agent_manager: Arc<AgentManager>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            connections: Mutex::new(HashMap::new()),
            agent_manager,
        }
    }

    /// Spawn + initialize a new connection.
    /// Returns the connection_id.
    pub async fn init_connection(&self, config: AgentConfig, cwd: String) -> Result<String> {
        let shell_env = self.agent_manager.shell_env().await;
        let session = AcpSession::spawn(&self.agent_manager, config, cwd, shell_env).await?;
        session.initialize().await?;
        let connection_id = session.connection_id.clone();
        self.connections.lock().await.insert(connection_id.clone(), session);
        Ok(connection_id)
    }

    /// Bind an unbound connection to a new session (session/new).
    /// Moves the connection from `connections` to `sessions`.
    pub async fn bind_new_session(
        &self,
        connection_id: &str,
        mcp_servers: Vec<Value>,
        forward_tx: broadcast::Sender<SessionEvent>,
        terminal_forward_tx: broadcast::Sender<TerminalEvent>,
    ) -> Result<Arc<AcpSession>> {
        let session = {
            let mut conns = self.connections.lock().await;
            conns.remove(connection_id).ok_or_else(|| {
                anyhow::anyhow!("Connection not found: {}", connection_id)
            })?
        };

        session.new_session(mcp_servers).await?;
        let session_id = session.session_id();

        // Forward session events to the global channel
        let mut rx = session.subscribe();
        let sid = session_id.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => { let _ = forward_tx.send(event); }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("[acp] session event forwarder lagged {} events for session {}", n, sid);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            let _ = forward_tx.send(SessionEvent::Disconnected {
                session_id: sid.clone(),
            });
        });

        // Forward terminal events to the global channel
        let mut term_rx = session.subscribe_terminal_events();
        let tid = session_id.clone();
        tokio::spawn(async move {
            loop {
                match term_rx.recv().await {
                    Ok(event) => { let _ = terminal_forward_tx.send(event); }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("[acp] terminal event forwarder lagged {} events for session {}", n, tid);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        self.sessions.lock().await.insert(session_id, session.clone());
        Ok(session)
    }

    /// Bind an unbound connection to an existing session (session/load).
    /// Moves the connection from `connections` to `sessions`.
    pub async fn bind_load_session(
        &self,
        connection_id: &str,
        target_session_id: &str,
        cwd: &str,
        mcp_servers: Vec<Value>,
        forward_tx: broadcast::Sender<SessionEvent>,
        terminal_forward_tx: broadcast::Sender<TerminalEvent>,
    ) -> Result<Arc<AcpSession>> {
        let session = {
            let mut conns = self.connections.lock().await;
            conns.remove(connection_id).ok_or_else(|| {
                anyhow::anyhow!("Connection not found: {}", connection_id)
            })?
        };

        session.load_session(target_session_id, cwd, mcp_servers).await?;
        let session_id = session.session_id();

        // Forward session events to the global channel
        let mut rx = session.subscribe();
        let sid = session_id.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => { let _ = forward_tx.send(event); }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("[acp] session event forwarder lagged {} events for session {}", n, sid);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            let _ = forward_tx.send(SessionEvent::Disconnected {
                session_id: sid.clone(),
            });
        });

        // Forward terminal events
        let mut term_rx = session.subscribe_terminal_events();
        let tid = session_id.clone();
        tokio::spawn(async move {
            loop {
                match term_rx.recv().await {
                    Ok(event) => { let _ = terminal_forward_tx.send(event); }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("[acp] terminal event forwarder lagged {} events for session {}", n, tid);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        self.sessions.lock().await.insert(session_id, session.clone());
        Ok(session)
    }

    /// Switch to a different session by killing the old agent and spawning a fresh one.
    /// session/load on an existing connection causes the agent to cancel subsequent prompts,
    /// so we spawn a new agent process and load the session on the fresh connection.
    pub async fn switch_session(
        &self,
        current_session_id: &str,
        target_session_id: &str,
        cwd: &str,
        mcp_servers: Vec<Value>,
        forward_tx: broadcast::Sender<SessionEvent>,
        terminal_forward_tx: broadcast::Sender<TerminalEvent>,
    ) -> Result<Arc<AcpSession>> {
        // 1. Get old session config before killing it
        let old_session = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(current_session_id).ok_or_else(|| {
                anyhow::anyhow!("Session not found: {}", current_session_id)
            })?
        };
        let agent_config = old_session.agent_config.clone();

        // 2. Kill old agent process
        info!("Switching session: killing old agent {}", old_session.agent_id);
        self.agent_manager.kill(&old_session.agent_id).await;

        // 3. Spawn fresh agent + initialize
        let shell_env = self.agent_manager.shell_env().await;
        let new_session = AcpSession::spawn(&self.agent_manager, agent_config, cwd.to_string(), shell_env).await?;
        new_session.initialize().await?;

        // 4. Load the target session on the fresh connection
        new_session.load_session(target_session_id, cwd, mcp_servers).await?;
        let new_session_id = new_session.session_id();

        // 5. Set up event forwarding
        let mut rx = new_session.subscribe();
        let sid = new_session_id.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => { let _ = forward_tx.send(event); }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("[acp] session event forwarder lagged {} events for session {}", n, sid);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            let _ = forward_tx.send(SessionEvent::Disconnected {
                session_id: sid.clone(),
            });
        });

        // Forward terminal events
        let mut term_rx = new_session.subscribe_terminal_events();
        let tid = new_session_id.clone();
        tokio::spawn(async move {
            loop {
                match term_rx.recv().await {
                    Ok(event) => { let _ = terminal_forward_tx.send(event); }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("[acp] terminal event forwarder lagged {} events for session {}", n, tid);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        info!("Session switched: {} → {}", current_session_id, new_session_id);
        self.sessions.lock().await.insert(new_session_id, new_session.clone());
        Ok(new_session)
    }

    /// List sessions via an unbound or bound connection.
    pub async fn list_sessions_via_connection(
        &self,
        connection_id: &str,
        cwd: &str,
    ) -> Result<Value> {
        let session = {
            let conns = self.connections.lock().await;
            if let Some(s) = conns.get(connection_id) {
                s.clone()
            } else {
                let sessions = self.sessions.lock().await;
                sessions
                    .get(connection_id)
                    .cloned()
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "Connection or session not found: {}",
                            connection_id
                        )
                    })?
            }
        };
        session.list_sessions(cwd).await
    }

    /// Backward compat: spawn + initialize + new_session in one shot.
    pub async fn create_session(
        &self,
        name: String,
        command: String,
        args: Vec<String>,
        env: Vec<String>,
        cwd: String,
        config_file: Option<String>,
        mcp_servers: Vec<Value>,
        forward_tx: broadcast::Sender<SessionEvent>,
        terminal_forward_tx: broadcast::Sender<TerminalEvent>,
    ) -> Result<Arc<AcpSession>> {
        let mut final_args = args;
        if let Some(path) = config_file {
            let expanded = if path.starts_with("~/") {
                std::env::var("HOME")
                    .map(|home| format!("{}{}", home, &path[1..]))
                    .unwrap_or(path)
            } else {
                path
            };
            final_args.push("--config-file".to_string());
            final_args.push(expanded);
        }
        let config = AgentConfig {
            name,
            command,
            args: final_args,
            env,
        };

        let shell_env = self.agent_manager.shell_env().await;
        let session = AcpSession::spawn(&self.agent_manager, config, cwd, shell_env).await?;
        session.initialize().await?;
        session.new_session(mcp_servers).await?;
        let session_id = session.session_id();

        // Forward session events
        let mut rx = session.subscribe();
        let sid = session_id.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => { let _ = forward_tx.send(event); }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("[acp] session event forwarder lagged {} events for session {}", n, sid);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            let _ = forward_tx.send(SessionEvent::Disconnected {
                session_id: sid.clone(),
            });
        });

        // Forward terminal events
        let mut term_rx = session.subscribe_terminal_events();
        let tid = session_id.clone();
        tokio::spawn(async move {
            loop {
                match term_rx.recv().await {
                    Ok(event) => { let _ = terminal_forward_tx.send(event); }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("[acp] terminal event forwarder lagged {} events for session {}", n, tid);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        self.sessions.lock().await.insert(session_id, session.clone());
        Ok(session)
    }

    pub async fn get_session(&self, session_id: &str) -> Option<Arc<AcpSession>> {
        self.sessions.lock().await.get(session_id).cloned()
    }

    pub async fn get_connection(&self, connection_id: &str) -> Option<Arc<AcpSession>> {
        self.connections.lock().await.get(connection_id).cloned()
    }

    pub async fn close_session(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.remove(session_id) {
            info!("Closing ACP session {}", session_id);
            let _ = self.agent_manager.kill(&session.agent_id).await;
        }
    }

    pub async fn close_connection(&self, connection_id: &str) {
        let mut conns = self.connections.lock().await;
        if let Some(session) = conns.remove(connection_id) {
            info!("Closing ACP connection {}", connection_id);
            let _ = self.agent_manager.kill(&session.agent_id).await;
        }
    }

    pub async fn list_active_sessions(&self) -> Vec<String> {
        self.sessions.lock().await.keys().cloned().collect()
    }

    pub async fn list_connections(&self) -> Vec<String> {
        self.connections.lock().await.keys().cloned().collect()
    }
}
