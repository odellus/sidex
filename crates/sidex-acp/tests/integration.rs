//! Integration tests for orchestration: spawn a real echo agent subprocess
//! and exercise the full I/O path through AcpSession, run_task_loop, _send, etc.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde_json::json;
use tokio::time::timeout;

use sidex_acp::agent::{AgentConfig, AgentManager};
use sidex_acp::manager::AcpSessionManager;
use sidex_acp::session::{PromptTurnState, SessionEvent, TaskStatus};
use sidex_acp::tools::ToolContext;

use std::collections::HashMap;

/// Build a `ToolContext` for driving tool handlers directly in tests.
async fn build_tool_context(
    manager: &Arc<AcpSessionManager>,
    session_id: String,
) -> ToolContext {
    ToolContext {
        active_terminals: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        session_id,
        shell_env: Arc::new(HashMap::new()),
        terminal_events_tx: tokio::sync::broadcast::channel(256).0,
        manager: Some(manager.clone()),
        agent_config: AgentConfig {
            name: "test".to_string(),
            command: "/usr/bin/python3".to_string(),
            args: vec![echo_agent_path()],
            env: vec![],
        },
    }
}

/// Extract the `terminalId` from a `create_terminal` response value.
/// Handles both flat and externally-tagged enum shapes.
fn extract_terminal_id(resp: &serde_json::Value) -> String {
    if let Some(id) = resp.get("terminalId").and_then(|v| v.as_str()) {
        return id.to_string();
    }
    for (_, v) in resp.as_object().into_iter().flatten() {
        if let Some(id) = v.get("terminalId").and_then(|v| v.as_str()) {
            return id.to_string();
        }
    }
    panic!("create_terminal response had no terminalId: {resp}");
}

/// Convert a tool handler's `Result<_, String>` into `anyhow::Result`.
fn tool<T>(res: std::result::Result<T, String>) -> Result<T> {
    res.map_err(anyhow::Error::msg)
}

/// Recursively find an `exitCode` anywhere in a wait-for-exit response,
/// regardless of how the `ClientResponse` enum is serialized (flat vs tagged).
fn exit_code_of(v: &serde_json::Value) -> Option<u64> {
    if let Some(c) = v.get("exitCode").and_then(|c| c.as_u64()) {
        return Some(c);
    }
    if let Some(obj) = v.as_object() {
        for (_, child) in obj {
            if let Some(c) = exit_code_of(child) {
                return Some(c);
            }
        }
    }
    None
}

/// Path to the minimal echo agent script (no asyncio, no SDK — just stdin/stdout).
fn echo_agent_path() -> String {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .unwrap_or_else(|_| ".".to_string());
    format!("{}/tests/echo_agent.py", manifest_dir)
}

/// Path to the scripted orchestration test agent (roles: worker/orchestrator/instructor).
fn orchestration_agent_path() -> String {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .unwrap_or_else(|_| ".".to_string());
    format!("{}/tests/orchestration_agent.py", manifest_dir)
}

/// Spawn a session connected to the echo agent, fully initialized.
async fn spawn_echo_session(
    manager: &Arc<AcpSessionManager>,
    name: &str,
) -> Result<Arc<sidex_acp::session::AcpSession>> {
    // The echo agent is pure stdlib (no SDK), so run it directly with
    // /usr/bin/python3 — no `uv run` needed. Bypass shell-env capture too:
    // the command is an absolute path and capture spawns a login shell that
    // hangs in this sandbox.
    std::env::set_var("SIDEX_ACP_SKIP_SHELL_ENV", "1");

    let config = AgentConfig {
        name: name.to_string(),
        command: "/usr/bin/python3".to_string(),
        args: vec![echo_agent_path()],
        env: vec![],
    };

    let connection_id = manager.init_connection(config, "/tmp".to_string()).await?;
    let (forward_tx, _forward_rx) = tokio::sync::broadcast::channel::<SessionEvent>(1024);
    let (terminal_tx, _terminal_rx) =
        tokio::sync::broadcast::channel::<sidex_acp::session::TerminalEvent>(256);
    let session = manager
        .bind_new_session(&connection_id, vec![], forward_tx, terminal_tx)
        .await?;
    // Wire the manager into the session so agent-emitted tool requests (_send,
    // _task/*) can resolve other sessions — same step acp_chat.rs does in prod.
    session.set_manager(manager.clone()).await;
    Ok(session)
}

/// Spawn a session connected to the scripted orchestration test agent.
///
/// `role` selects the agent's behavior (worker/orchestrator/instructor).
/// `extra_args` are appended after --role (e.g. --worker <sid>).
async fn spawn_role_session(
    manager: &Arc<AcpSessionManager>,
    name: &str,
    role: &str,
    extra_args: Vec<String>,
) -> Result<Arc<sidex_acp::session::AcpSession>> {
    std::env::set_var("SIDEX_ACP_SKIP_SHELL_ENV", "1");

    let mut args = vec![orchestration_agent_path(), "--role".to_string(), role.to_string()];
    args.extend(extra_args);

    let config = AgentConfig {
        name: name.to_string(),
        command: "/usr/bin/python3".to_string(),
        args,
        env: vec![],
    };

    let connection_id = manager.init_connection(config, "/tmp".to_string()).await?;
    let (forward_tx, _forward_rx) = tokio::sync::broadcast::channel::<SessionEvent>(1024);
    let (terminal_tx, _terminal_rx) =
        tokio::sync::broadcast::channel::<sidex_acp::session::TerminalEvent>(256);
    let session = manager
        .bind_new_session(&connection_id, vec![], forward_tx, terminal_tx)
        .await?;
    session.set_manager(manager.clone()).await;
    Ok(session)
}

#[tokio::test]
async fn echo_agent_basic_prompt() -> Result<()> {
    let agent_manager = Arc::new(AgentManager::new());
    let manager = Arc::new(AcpSessionManager::new(agent_manager));

    let session = spawn_echo_session(&manager, "echo").await?;
    let sid = session.session_id();

    // Subscribe to events to see the echoed message
    let mut rx = session.subscribe();

    // Send a prompt
    let blocks = vec![json!({"type": "text", "text": "hello from test"})];
    let result = session.run_prompt(blocks).await?;

    // Should get end_turn
    assert_eq!(
        result.get("stopReason").and_then(|v| v.as_str()),
        Some("end_turn")
    );

    // Should have received an agent_message_chunk event with our text
    let mut found_echo = false;
    while let Ok(event) = timeout(Duration::from_secs(1), rx.recv()).await {
        match event {
            Ok(SessionEvent::Update { update, .. }) => {
                if update.get("sessionUpdate").and_then(|v| v.as_str()) == Some("agent_message_chunk") {
                    let text = update
                        .get("content")
                        .and_then(|c| c.get("text"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    if text.contains("hello from test") {
                        found_echo = true;
                    }
                }
            }
            _ => {}
        }
    }
    assert!(found_echo, "should have received echoed message");

    // Prompt state should be Complete
    let state = session.prompt_state().await;
    assert!(matches!(state, PromptTurnState::Complete { .. }));

    // Clean up
    manager.close_session(&sid).await;
    Ok(())
}

#[tokio::test]
async fn run_task_loop_processes_tasks_and_summarizes() -> Result<()> {
    let agent_manager = Arc::new(AgentManager::new());
    let manager = Arc::new(AcpSessionManager::new(agent_manager));

    let session = spawn_echo_session(&manager, "orchestrator").await?;
    let sid = session.session_id();

    // Populate the task list with two tasks
    {
        let mut orch = session.orchestration.lock().await;
        orch.task_list.push(sidex_acp::session::Task {
            id: "t1".to_string(),
            title: "First task".to_string(),
            description: Some("Do the first thing".to_string()),
            status: TaskStatus::Pending,
            assigned_to: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        });
        orch.task_list.push(sidex_acp::session::Task {
            id: "t2".to_string(),
            title: "Second task".to_string(),
            description: None,
            status: TaskStatus::Pending,
            assigned_to: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        });
    }

    // Run the task loop — the echo agent will respond to each prompt with end_turn.
    // Since the agent never calls send_prompt or task_write, the loop will nag
    // on the first task (NotCalled + task not done), then nag again, etc.
    // But with the echo agent responding instantly, we should at least see it
    // process the first task and send a prompt.
    //
    // We run with a timeout so the test doesn't hang on the infinite nag loop.
    let result = timeout(Duration::from_secs(5), session.run_task_loop()).await;

    // The loop should either complete (if we add a nag cap) or timeout.
    // For now, timeout is expected because the echo agent never marks tasks done.
    // The important thing is: it didn't deadlock, it sent prompts, and the
    // first prompt was about the first task.
    match result {
        Ok(Ok(())) => {
            // If it completed, all tasks should be done or summarized
            let orch = session.orchestration.lock().await;
            // Either all done, or we got the summary
            println!("Loop completed. summarized={}", orch.summarized);
        }
        Err(_) => {
            // Timeout — expected since echo agent never delegates or marks done.
            // The loop is nagging forever. This is acceptable for this test:
            // we just want to verify it doesn't deadlock.
            println!("Loop timed out (expected — echo agent never marks tasks done)");
        }
        Ok(Err(e)) => {
            panic!("run_task_loop errored: {e}");
        }
    }

    // Verify the first task was promoted to InProgress
    let orch = session.orchestration.lock().await;
    let t1 = orch.task_list.iter().find(|t| t.id == "t1").unwrap();
    assert_eq!(t1.status, TaskStatus::InProgress, "first task should be InProgress");

    manager.close_session(&sid).await;
    Ok(())
}

#[tokio::test]
async fn run_task_loop_stops_when_cancelled() -> Result<()> {
    let agent_manager = Arc::new(AgentManager::new());
    let manager = Arc::new(AcpSessionManager::new(agent_manager));

    let session = spawn_echo_session(&manager, "cancel-test").await?;
    let sid = session.session_id();

    // Set up WaitingForResponse so the loop blocks on delegation_notify
    {
        let mut orch = session.orchestration.lock().await;
        orch.task_list.push(sidex_acp::session::Task {
            id: "t1".to_string(),
            title: "Task that will be cancelled".to_string(),
            description: None,
            status: TaskStatus::InProgress,
            assigned_to: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        });
        orch.current_task = Some(sidex_acp::session::Task {
            id: "t1".to_string(),
            title: "Task that will be cancelled".to_string(),
            description: None,
            status: TaskStatus::InProgress,
            assigned_to: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        });
        orch.set_waiting_for_response();
    }

    // Start the task loop in a background task
    let session_clone = session.clone();
    let loop_handle = tokio::spawn(async move {
        session_clone.run_task_loop().await
    });

    // Give it a moment to enter the blocking notified() call
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Cancel the prompt
    session.cancel_prompt().await?;

    // The loop should wake up (notify_one was called) and exit quickly
    // because is_cancelled() returns true
    let result = timeout(Duration::from_secs(3), loop_handle).await;

    match result {
        Ok(Ok(Ok(()))) => {
            // Loop exited cleanly
            let state = session.prompt_state().await;
            assert!(
                matches!(state, PromptTurnState::Cancelled),
                "prompt state should be Cancelled, got {:?}",
                state
            );
        }
        Ok(Ok(Err(e))) => panic!("run_task_loop errored: {e}"),
        Ok(Err(e)) => panic!("loop task panicked: {e}"),
        Err(_) => panic!("run_task_loop did not stop within 3s after cancel"),
    }

    manager.close_session(&sid).await;
    Ok(())
}

#[tokio::test]
async fn send_to_session_delivers_callback() -> Result<()> {
    let agent_manager = Arc::new(AgentManager::new());
    let manager = Arc::new(AcpSessionManager::new(agent_manager));

    // Spawn two echo sessions: a "caller" and a "worker"
    let caller = spawn_echo_session(&manager, "caller").await?;
    let worker = spawn_echo_session(&manager, "worker").await?;
    let caller_sid = caller.session_id();
    let worker_sid = worker.session_id();

    // Set up the caller with a current task and WaitingForResponse state
    // (simulating that it just delegated)
    {
        let mut orch = caller.orchestration.lock().await;
        orch.task_list.push(sidex_acp::session::Task {
            id: "t1".to_string(),
            title: "Delegate this task".to_string(),
            description: None,
            status: TaskStatus::InProgress,
            assigned_to: Some(worker_sid.clone()),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        });
        orch.current_task = Some(sidex_acp::session::Task {
            id: "t1".to_string(),
            title: "Delegate this task".to_string(),
            description: None,
            status: TaskStatus::InProgress,
            assigned_to: Some(worker_sid.clone()),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        });
    }

    // Call _send directly via the tool handler
    use sidex_acp::tools::ToolContext;
    use std::collections::HashMap;

    let ctx = ToolContext {
        active_terminals: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        session_id: caller_sid.clone(),
        shell_env: Arc::new(HashMap::new()),
        terminal_events_tx: tokio::sync::broadcast::channel(256).0,
        manager: Some(manager.clone()),
        agent_config: AgentConfig {
            name: "caller".to_string(),
            command: "/usr/bin/python3".to_string(),
            args: vec![echo_agent_path()],
            env: vec![],
        },
    };

    let params = json!({
        "toSessionId": worker_sid,
        "blocks": [{"type": "text", "text": "Please do the task"}],
    });

    // Call send_to_session — it should return immediately with "sent"
    let result = sidex_acp::tools::orchestration_2::send_to_session(&params, &ctx)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    assert_eq!(result.get("status").and_then(|v| v.as_str()), Some("sent"));

    // Caller should be in WaitingForResponse
    {
        let orch = caller.orchestration.lock().await;
        assert_eq!(
            orch.delegation_state,
            sidex_acp::session::DelegationState::WaitingForResponse
        );
    }

    // The spawned callback should prompt the worker, re-prompt for summary,
    // then set the caller to Responding with a summary.
    // Wait for the callback to complete (up to 10s).
    let mut waited = 0;
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        waited += 200;
        let orch = caller.orchestration.lock().await;
        if orch.delegation_state == sidex_acp::session::DelegationState::Responding {
            // Callback arrived! Check the summary
            let summary = orch.delegation_summary.as_deref().unwrap_or("");
            println!("Callback arrived after {}ms, summary: {} chars", waited, summary.len());
            // The echo agent echoes back the prompt text and the summary prompt text.
            // The summary should contain something.
            assert!(!summary.is_empty(), "summary should not be empty");
            break;
        }
        if waited > 10000 {
            panic!("_send callback did not arrive within 10s");
        }
    }

    manager.close_session(&caller_sid).await;
    manager.close_session(&worker_sid).await;
    Ok(())
}

#[tokio::test]
async fn task_send_starts_target_loop() -> Result<()> {
    let agent_manager = Arc::new(AgentManager::new());
    let manager = Arc::new(AcpSessionManager::new(agent_manager));

    // Spawn two sessions: an "instructor" (who calls task_send) and an
    // "orchestrator" (the target, whose loop should auto-start).
    let instructor = spawn_echo_session(&manager, "instructor").await?;
    let orchestrator = spawn_echo_session(&manager, "orchestrator").await?;
    let instructor_sid = instructor.session_id();
    let orchestrator_sid = orchestrator.session_id();

    // Build a tool context as the instructor (the caller of task_send).
    use sidex_acp::tools::ToolContext;
    use std::collections::HashMap;

    let ctx = ToolContext {
        active_terminals: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        session_id: instructor_sid.clone(),
        shell_env: Arc::new(HashMap::new()),
        terminal_events_tx: tokio::sync::broadcast::channel(256).0,
        manager: Some(manager.clone()),
        agent_config: AgentConfig {
            name: "instructor".to_string(),
            command: "/usr/bin/python3".to_string(),
            args: vec![echo_agent_path()],
            env: vec![],
        },
    };

    let params = json!({
        "toSessionId": orchestrator_sid,
        "tasks": [
            {"title": "First orchestration task", "description": "Do the first thing"},
            {"title": "Second orchestration task", "description": "Do the second thing"},
        ],
    });

    // task_send should return immediately with success.
    let result = sidex_acp::tools::orchestration_2::task_send(&params, &ctx)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        result.get("taskCount").and_then(|v| v.as_u64()),
        Some(2)
    );

    // The target's task list should be populated.
    {
        let orch = orchestrator.orchestration.lock().await;
        assert_eq!(orch.task_list.len(), 2);
        assert_eq!(orch.task_list[0].title, "First orchestration task");
        assert!(matches!(
            orch.task_list[0].status,
            TaskStatus::Pending | TaskStatus::InProgress
        ));
    }

    // The spawned loop should auto-start and promote the first task to
    // InProgress. Poll for it (the echo agent responds instantly, so this
    // should be quick).
    let mut promoted = false;
    for waited in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let orch = orchestrator.orchestration.lock().await;
        if orch.task_list[0].status == TaskStatus::InProgress {
            promoted = true;
            // current_task should be the promoted first task
            assert!(orch.current_task.is_some());
            assert_eq!(
                orch.current_task.as_ref().unwrap().title,
                "First orchestration task"
            );
            println!("task_send auto-started the loop after {}ms", waited * 100);
            break;
        }
    }
    assert!(
        promoted,
        "task_send should have started the orchestrator's loop, promoting the \
         first task to InProgress"
    );

    // The loop guard should now be set (loop is running — the echo agent never
    // marks tasks done, so it's nagging).
    assert!(
        orchestrator.task_loop_running.load(std::sync::atomic::Ordering::SeqCst),
        "task_loop_running flag should be set while the loop is active"
    );

    // Closing the sessions kills the agent processes, which errors the
    // orchestrator's run_prompt and lets its detached loop exit.
    manager.close_session(&instructor_sid).await;
    manager.close_session(&orchestrator_sid).await;
    Ok(())
}

#[tokio::test]
async fn orchestration_e2e_tripartite_flow() -> Result<()> {
    // Full backend-only end-to-end flow, no frontend / MCP / LLM / crow-cli:
    //   instructor --_task/send--> orchestrator --_send--> worker
    // Three scripted stdio agents exercise the real async tool dispatch.
    let agent_manager = Arc::new(AgentManager::new());
    let manager = Arc::new(AcpSessionManager::new(agent_manager));

    // 1. Worker (no dependencies).
    let worker = spawn_role_session(&manager, "worker", "worker", vec![]).await?;
    let worker_sid = worker.session_id();

    // 2. Orchestrator — told which worker to delegate to.
    let orchestrator = spawn_role_session(
        &manager,
        "orchestrator",
        "orchestrator",
        vec!["--worker".to_string(), worker_sid.clone()],
    )
    .await?;
    let orchestrator_sid = orchestrator.session_id();

    // 3. Instructor — told which orchestrator to send tasks to.
    let instructor = spawn_role_session(
        &manager,
        "instructor",
        "instructor",
        vec!["--target".to_string(), orchestrator_sid.clone()],
    )
    .await?;
    let instructor_sid = instructor.session_id();

    // Kick off the flow: prompt the instructor. Its scripted turn emits a
    // _task/send to the orchestrator, which (per our fix) auto-starts the
    // orchestrator's Ralph loop. From here everything is async + autonomous.
    let blocks = vec![json!({"type": "text", "text": "begin orchestration"})];
    instructor.prompt(blocks).await?;

    // Poll the orchestrator's task list until both tasks are completed and the
    // loop has summarized and exited. The whole async chain (delegate → worker
    // react loop → summary callback → evaluate → task_write → next task →
    // … → summary) should complete in well under the timeout.
    let mut done = false;
    for waited in 0..300 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let orch = orchestrator.orchestration.lock().await;
        let all_completed = !orch.task_list.is_empty()
            && orch
                .task_list
                .iter()
                .all(|t| t.status == TaskStatus::Completed || t.status == TaskStatus::Failed);
        if all_completed && orch.summarized {
            println!("orchestration completed after {}ms", waited * 100);
            done = true;
            break;
        }
    }
    assert!(done, "orchestration did not complete within 30s");

    // Final assertions on the orchestrator's state.
    {
        let orch = orchestrator.orchestration.lock().await;
        assert_eq!(orch.task_list.len(), 2, "two tasks should have been sent");
        assert!(
            orch.task_list.iter().all(|t| t.status == TaskStatus::Completed),
            "both tasks should be Completed"
        );
        assert!(orch.summarized, "orchestrator should have emitted its summary");
    }
    // The loop must have exited and released the guard.
    assert!(
        !orchestrator
            .task_loop_running
            .load(std::sync::atomic::Ordering::SeqCst),
        "task loop should have exited (guard released)"
    );

    // The worker must have actually been prompted (proves the _send path ran).
    let worker_state = worker.prompt_state().await;
    assert!(
        matches!(worker_state, PromptTurnState::Complete { .. }),
        "worker should have completed a prompt turn, got {:?}",
        worker_state
    );

    manager.close_session(&instructor_sid).await;
    manager.close_session(&orchestrator_sid).await;
    manager.close_session(&worker_sid).await;
    Ok(())
}

// ─── Terminal tool tests ─────────────────────────────────────────────────
// These exercise the real PTY lifecycle (create → wait_for_exit → output →
// kill → release) directly through the tool handlers — no agent, no frontend.
// The headline concern is environment-variable propagation after the refactor.

#[tokio::test]
async fn terminal_env_vars_propagate_to_spawned_process() -> Result<()> {
    // The refactor regrouped env handling in create_terminal; this pins that
    // a var injected via the `env` param actually reaches the spawned shell.
    let agent_manager = Arc::new(AgentManager::new());
    let manager = Arc::new(AcpSessionManager::new(agent_manager));
    let _session = spawn_echo_session(&manager, "term-env").await?;
    let ctx = build_tool_context(&manager, "term-env".to_string()).await;

    let params = json!({
        "command": "echo \"$SIDEX_TEST_MARKER\"",
        "env": [{"name": "SIDEX_TEST_MARKER", "value": "env-propagated-42"}],
    });
    let resp = tool(sidex_acp::tools::terminal::create_terminal(&params, &ctx).await)?;
    let term_id = extract_terminal_id(&resp);

    let exit = timeout(
        Duration::from_secs(5),
        sidex_acp::tools::terminal::wait_for_exit(
            &json!({"terminalId": term_id}),
            &ctx,
        ),
    )
    .await
    .expect("terminal did not exit within 5s")
    .map_err(anyhow::Error::msg)?;

    assert_eq!(exit_code_of(&exit), Some(0), "echo should exit 0; got: {exit}");

    let out = tool(sidex_acp::tools::terminal::get_output(&json!({"terminalId": term_id}), &ctx).await)?;
    let text = out.to_string();
    assert!(
        text.contains("env-propagated-42"),
        "injected env var should reach the process; got: {text}"
    );
    Ok(())
}

#[tokio::test]
async fn terminal_exit_code_propagated() -> Result<()> {
    let agent_manager = Arc::new(AgentManager::new());
    let manager = Arc::new(AcpSessionManager::new(agent_manager));
    let _session = spawn_echo_session(&manager, "term-exit").await?;
    let ctx = build_tool_context(&manager, "term-exit".to_string()).await;

    let resp = tool(sidex_acp::tools::terminal::create_terminal(
        &json!({"command": "sh -c 'exit 7'"}),
        &ctx,
    )
    .await)?;
    let term_id = extract_terminal_id(&resp);

    let exit = timeout(
        Duration::from_secs(5),
        sidex_acp::tools::terminal::wait_for_exit(
            &json!({"terminalId": term_id}),
            &ctx,
        ),
    )
    .await
    .expect("terminal did not exit within 5s")
    .map_err(anyhow::Error::msg)?;

    assert_eq!(exit_code_of(&exit), Some(7), "exit code 7 should propagate; got: {exit}");
    Ok(())
}

#[tokio::test]
async fn terminal_kill_stops_long_running_process() -> Result<()> {
    let agent_manager = Arc::new(AgentManager::new());
    let manager = Arc::new(AcpSessionManager::new(agent_manager));
    let _session = spawn_echo_session(&manager, "term-kill").await?;
    let ctx = build_tool_context(&manager, "term-kill".to_string()).await;

    // Start something that won't exit on its own.
    let resp = tool(sidex_acp::tools::terminal::create_terminal(
        &json!({"command": "sleep 30"}),
        &ctx,
    )
    .await)?;
    let term_id = extract_terminal_id(&resp);

    {
        let terminals = ctx.active_terminals.lock().await;
        let term = terminals.get(&term_id).expect("terminal tracked");
        assert!(term.pty.is_alive(), "sleep 30 should be alive");
    }

    tool(sidex_acp::tools::terminal::kill_terminal(&json!({"terminalId": term_id}), &ctx).await)?;

    for _ in 0..50 {
        let terminals = ctx.active_terminals.lock().await;
        let term = terminals.get(&term_id).expect("terminal still tracked");
        if !term.pty.is_alive() {
            return Ok(());
        }
        drop(terminals);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("kill_terminal did not stop sleep 30 within 5s");
}
