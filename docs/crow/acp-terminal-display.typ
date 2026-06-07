= ACP Terminal Display in Chat

== The Problem

When the agent runs a terminal command, the chat shows only a status badge ("running..." → "✓") with no terminal output. The user sees nothing.

== How It Works Today

The agent requests `terminal/create` → backend spawns a PTY in `handle_agent_request` (session.rs:833-904) → returns `term_60` to agent.

Two things then read from this PTY:

+ #strong[Drain loop] (line 878-901): Calls `pty.read_output(None)` every 50ms, checks `is_alive`, #emph[discards the output lines]
+ #strong[Agent's `terminal/output`] (line 907-928): Also calls `pty.read_output(None)`, returns output to agent

#strong[These two race for the same output buffer.] The drain loop reads every 50ms and throws the data away. By the time the agent polls `terminal/output`, the drain loop has already consumed the output. The agent often gets empty results.

The frontend has #strong[no way] to get terminal output at all. It receives `tool_call_update` with `{ terminalId: "term_60", type: "terminal" }` but has no Tauri command or event to read the actual output.

== How crow-ui Does It

crow-ui has a single reader pattern:

+ #strong[TerminalManager] reads PTY output and accumulates it in a buffer
+ Emits `acp-terminal-data` WebSocket event to frontend on each read
+ Agent's `terminal/output` reads from the accumulated buffer
+ Frontend polls `acp_terminal_output` every 200ms as a fallback

One reader, one buffer, two consumers.

== The Fix

=== Principle

One reader (drain loop), one buffer (on `SessionTerminal`), two consumers (agent + frontend via Tauri event).

=== Change 1: SessionTerminal gets an output buffer

```rust
// crates/sidex-acp/src/session.rs

pub struct SessionTerminal {
    handle: sidex_terminal::TermHandle,
    pty: sidex_terminal::PtyProcess,
    output_buffer: Arc<Mutex<String>>,  // accumulated output
}
```

=== Change 2: Drain loop stores output and emits Tauri event

Currently (line 878-901):
```rust
tokio::spawn(async move {
    loop {
        tokio::time::sleep(50ms).await;
        let is_alive = {
            let terminals = active_terminals.lock().await;
            if let Some(term) = terminals.get(&drain_id) {
                match term.pty.read_output(None) {
                    Ok(result) => result.is_alive,  // output discarded!
                    Err(_) => false,
                }
            } else { break; }
        };
        if !is_alive { break; }
    }
});
```

Becomes:
```rust
tokio::spawn(async move {
    loop {
        tokio::time::sleep(50ms).await;
        let (output, is_alive, exit_code) = {
            let terminals = active_terminals_clone.lock().await;
            if let Some(term) = terminals.get(&drain_id) {
                match term.pty.read_output(None) {
                    Ok(result) => {
                        let text = result.lines.iter()
                            .map(|l| l.text.as_str())
                            .collect::<Vec<_>>()
                            .join("");
                        // Accumulate in buffer
                        if !text.is_empty() {
                            if let Ok(mut buf) = term.output_buffer.lock() {
                                buf.push_str(&text);
                            }
                        }
                        let exit = if !result.is_alive {
                            term.pty.exit_code()
                        } else { None };
                        (text, result.is_alive, exit)
                    }
                    Err(_) => (String::new(), false, None),
                }
            } else { break; }
        };
        // Emit to frontend
        if !output.is_empty() {
            let _ = app_handle.emit("acp-terminal-data", json!({
                "terminalId": drain_id, "data": output
            }));
        }
        if !is_alive {
            let _ = app_handle.emit("acp-terminal-exit", json!({
                "terminalId": drain_id,
                "exitCode": exit_code
            }));
            break;
        }
    }
});
```

=== Change 3: Agent's `terminal/output` reads from buffer

Currently (line 907-928):
```rust
match term.pty.read_output(None) {  // races with drain loop!
    Ok(result) => { ... }
}
```

Becomes:
```rust
// Read from accumulated buffer instead of PTY
let mut buf = term.output_buffer.lock().await;
let output = buf.clone();
buf.clear();  // consumed
let is_alive = term.pty.is_alive();
let exit_code = if !is_alive { term.pty.exit_code().map(|c| c as u32) } else { None };
// Build response from output, is_alive, exit_code
```

#strong[No more race condition.] The drain loop is the sole PTY reader. The agent reads from the buffer.

=== Change 4: AppHandle access

The drain loop is spawned inside `handle_agent_request`, which is called from `handle_agent_line`, which is called from the I/O task in `AcpSession::new`.

The I/O task already has access to `connection_id`. We need to pass `AppHandle` through:

+ Add `app_handle: AppHandle` to `AcpSession`
+ Clone it into the I/O task
+ Pass it through `handle_agent_line` → `handle_agent_request`
+ Clone it into the drain loop spawn

=== Change 5: Tauri command for frontend polling

Add `acp_terminal_output` in `src-tauri/src/commands/acp_chat.rs`:

```rust
#[tauri::command]
pub async fn acp_terminal_output(
    manager: State<'_, AcpSessionManager>,
    terminal_id: String,
) -> Result<AcpTerminalOutputResponse, String> {
    // Find session owning this terminal
    // Read from output_buffer
    // Return { output, isAlive, exitCode }
}
```

=== Change 6: Frontend InlineTerminal

```typescript
// Listen to acp-terminal-data events (push)
listen('acp-terminal-data', (e) => {
    if (e.payload.terminalId === this._terminalId)
        terminal.write(e.payload.data);
});

// Poll acp_terminal_output every 200ms (pull, like crow-ui)
setInterval(async () => {
    const r = await invoke('acp_terminal_output', {
        terminalId: this._terminalId
    });
    if (r.output) terminal.write(r.output);
    if (!r.isAlive) { ... }
}, 200);
```

== Files Changed

| File | Change |
|------|--------|
| `crates/sidex-acp/src/session.rs` | Add `output_buffer` to `SessionTerminal`, fix drain loop, fix `terminal/output`, thread `AppHandle` |
| `crates/sidex-acp/src/manager.rs` | Pass `AppHandle` to session |
| `src-tauri/src/commands/acp_chat.rs` | Add `acp_terminal_output` command |
| `src-tauri/src/lib.rs` | Register new command |
| `components/tools/inlineTerminal.ts` | Listen to events, poll command |
| `components/tools/toolCallItem.ts` | Pass `terminalId` from content block |

== Regression Risk

#strong[Agent terminal execution]: Currently broken (drain loop races with agent). This fix #emph[improves] it by making the agent read from the buffer instead of racing.

#strong[Main terminal panel]: Unaffected. Uses separate `terminal_spawn`/`terminal-data` system.

#strong[Session cleanup]: Unaffected. Terminals are still killed on session cancel/close.

== Testing

+ Send "run date command" in chat
+ Verify xterm.js shows real-time output
+ Verify agent still gets terminal output (check acp.log for `terminal/output` responses with actual data)
+ Verify exit code displays correctly
