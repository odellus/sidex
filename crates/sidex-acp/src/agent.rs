//! Agent process management — spawn/kill agent subprocesses.

use std::collections::HashMap;
use std::process::Stdio;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex};
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Shell environment capture (works even when parent PATH is broken)
// ---------------------------------------------------------------------------

/// Cached shell environment so we only capture it once per manager.
#[derive(Debug, Clone)]
struct ShellEnvCache {
    env: HashMap<String, String>,
    captured: bool,
}

impl ShellEnvCache {
    fn new() -> Self {
        Self {
            env: HashMap::new(),
            captured: false,
        }
    }
}

/// Capture the user's full shell environment by spawning a login+interactive shell.
/// This ensures .bashrc / .zshrc are sourced, so fnm/nvm/uv/etc. set up PATH.
async fn capture_shell_env(cache: &mut ShellEnvCache) {
    if cache.captured {
        return;
    }
    cache.captured = true;

    #[cfg(target_os = "windows")]
    {
        // Windows: inherit parent env as-is for now
        return;
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let shell_name = std::path::Path::new(&shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("bash");

    // Build strategies: -ilc (interactive login) first, then -lc (login only)
    let strategies: Vec<String> = match shell_name {
        "bash" | "sh" => vec![
            format!("{} -ilc 'env -0'", shell),
            format!("{} -lc 'env -0'", shell),
        ],
        "zsh" => vec![
            format!("{} -ilc 'env -0'", shell),
            format!("{} -lc 'env -0'", shell),
        ],
        _ => vec![
            format!("{} -lc 'env -0'", shell),
            format!("{} -c 'env -0'", shell),
        ],
    };

    for cmd_str in &strategies {
        let parts: Vec<&str> = cmd_str.splitn(3, ' ').collect();
        if parts.len() < 3 {
            continue;
        }
        let shell_bin = parts[0];
        let flag = parts[1];
        let env_arg = parts[2].trim_matches('\'');

        let output = match tokio::process::Command::new(shell_bin)
            .arg(flag)
            .arg(env_arg)
            .output()
            .await
        {
            Ok(o) if o.status.success() => o,
            Ok(o) => {
                warn!("capture_shell_env: {} exited with code {:?}", cmd_str, o.status.code());
                continue;
            }
            Err(e) => {
                warn!("capture_shell_env: failed to run {}: {}", cmd_str, e);
                continue;
            }
        };

        let env_output = String::from_utf8_lossy(&output.stdout);
        let mut count = 0;
        for var in env_output.split('\0') {
            if let Some(eq) = var.find('=') {
                let key = &var[..eq];
                let val = &var[eq + 1..];
                if !key.is_empty() {
                    cache.env.insert(key.to_string(), val.to_string());
                    count += 1;
                }
            }
        }

        info!("capture_shell_env: captured {} vars via {}", count, cmd_str);

        if let Some(path) = cache.env.get("PATH") {
            info!("capture_shell_env: captured PATH = {}", path);
        }
        return;
    }

    warn!("capture_shell_env: all strategies failed, using inherited env");
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Configuration for an ACP agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Agent name (e.g. "claude-code", "gemini-cli")
    pub name: String,
    /// Command to spawn the agent (e.g. "npx", "claude")
    pub command: String,
    /// Arguments to pass to the command
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables (key=value pairs)
    #[serde(default)]
    pub env: Vec<String>,
}

/// A running agent subprocess.
pub struct AgentInstance {
    pub process: Child,
    /// JSON-RPC messages to agent stdin
    pub stdin_tx: tokio::sync::mpsc::Sender<String>,
    /// Raw stdout line broadcast channel (per-agent so sessions don't cross-read)
    pub events_tx_raw: broadcast::Sender<String>,
}

/// Manages spawned agent subprocesses.
pub struct AgentManager {
    agents: Mutex<HashMap<String, AgentInstance>>,
    next_id: Mutex<u64>,
    /// Cached shell environment (captured once on first spawn).
    shell_env: Mutex<ShellEnvCache>,
}

impl AgentManager {
    pub fn new() -> Self {
        Self {
            agents: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            shell_env: Mutex::new(ShellEnvCache::new()),
        }
    }

    /// Spawn an agent subprocess connected via JSON-RPC over stdio.
    /// Returns the agent ID and starts background tasks that pump stdout/stderr.
    pub async fn spawn(&self, config: &AgentConfig, cwd: &str) -> Result<String> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = format!("agent_{}", *next);
            *next += 1;
            id
        };

        info!("Spawning agent '{}' (id={}) in {}", config.name, id, cwd);

        // Capture shell environment on first spawn so agents always get
        // the user's full PATH (fnm, nvm, uv, etc.) even when the parent
        // process inherited a broken PATH from Electron.
        let mut shell_env_guard = self.shell_env.lock().await;
        capture_shell_env(&mut shell_env_guard).await;
        let shell_env = shell_env_guard.env.clone();
        drop(shell_env_guard);

        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Apply captured shell env first, then inherited env, then user overrides.
        // Shell env wins for PATH so fnm/nvm/uv entries are present.
        for (k, v) in &shell_env {
            cmd.env(k, v);
        }

        if let Some(ref path) = shell_env.get("PATH").cloned().or_else(|| std::env::var("PATH").ok()) {
            info!("Agent {} PATH (shell-captured): {}", id, path);
        } else {
            warn!("Agent {} has no PATH!", id);
        }

        for env in &config.env {
            if let Some((k, v)) = env.split_once('=') {
                cmd.env(k, v);
            }
        }

        let mut process = cmd
            .spawn()
            .with_context(|| format!("Failed to spawn agent '{}'", config.name))?;

        let mut stdin = process.stdin.take().context("No stdin")?;
        let stdout = process.stdout.take().context("No stdout")?;
        let stderr = process.stderr.take().context("No stderr")?;

        // Channel for sending messages to agent stdin
        let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<String>(1024);
        // Per-agent raw stdout channel so sessions don't cross-read
        let events_tx_raw = broadcast::Sender::<String>::new(1024);

        // Task: pump messages from channel → agent stdin
        tokio::spawn(async move {
            while let Some(msg) = stdin_rx.recv().await {
                let line = format!("{}\n", msg);
                if let Err(e) = stdin.write_all(line.as_bytes()).await {
                    warn!("Failed to write to agent stdin: {e}");
                    break;
                }
            }
        });

        // Task: pump lines from agent stdout → per-agent broadcast
        let events_tx_raw_clone = events_tx_raw.clone();
        let agent_id = id.clone();
        tokio::spawn(async move {
            let mut buf = String::new();
            let mut reader = tokio::io::BufReader::new(stdout);
            loop {
                match reader.read_line(&mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = buf.trim();
                        if !trimmed.is_empty() {
                            let _ = events_tx_raw_clone.send(trimmed.to_string());
                        }
                        buf.clear();
                    }
                    Err(e) => {
                        warn!("Failed to read from agent stdout: {e}");
                        break;
                    }
                }
            }
            info!("Agent {} stdout reader exited", agent_id);
        });

        // Task: pump lines from agent stderr → local logs only (not JSON-RPC)
        let agent_id_err = id.clone();
        tokio::spawn(async move {
            let mut buf = String::new();
            let mut reader = tokio::io::BufReader::new(stderr);
            loop {
                match reader.read_line(&mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = buf.trim_end_matches(['\n', '\r']);
                        if !trimmed.is_empty() {
                            warn!("[{} stderr] {}", agent_id_err, trimmed);
                        }
                        buf.clear();
                    }
                    Err(e) => {
                        warn!("Failed to read from agent stderr: {e}");
                        break;
                    }
                }
            }
        });

        let instance = AgentInstance {
            process,
            stdin_tx,
            events_tx_raw,
        };

        self.agents.lock().await.insert(id.clone(), instance);
        info!("Agent spawned: {} (id={})", config.name, id);
        Ok(id)
    }

    /// Get the stdin sender for an agent.
    pub async fn get_stdin(&self, agent_id: &str) -> Option<tokio::sync::mpsc::Sender<String>> {
        self.agents.lock().await.get(agent_id).map(|a| a.stdin_tx.clone())
    }

    /// Get the raw stdout broadcast sender for an agent.
    pub async fn get_events_tx_raw(&self, agent_id: &str) -> Option<broadcast::Sender<String>> {
        self.agents.lock().await.get(agent_id).map(|a| a.events_tx_raw.clone())
    }

    /// Kill an agent process and remove it from the manager.
    pub async fn kill(&self, agent_id: &str) {
        if let Some(mut instance) = self.agents.lock().await.remove(agent_id) {
            info!("Killing agent {}", agent_id);
            let _ = instance.process.kill().await;
            let _ = instance.process.wait().await;
        }
    }

    /// List all running agent IDs.
    pub async fn list(&self) -> Vec<String> {
        self.agents.lock().await.keys().cloned().collect()
    }
}
