# sidex-acp tool testing plan

A systematic, backend-only test harness for the ACP client-side tools. No
frontend, no MCP, no LLM, no crow-cli — just the real `sidex-acp` crate and
scripted agents. This is how we prove the orchestration + terminal + fs
tools actually work end to end.

## The framework

Two complementary shapes, chosen by what the tool needs:

| Shape | For | How | Where |
|---|---|---|---|
| **Direct handler tests** | single-session tools (fs, terminal, permissions) | build a `ToolContext`, call the handler, assert on the `Value` | `tests/integration.rs` + `#[cfg(test)] mod tests` in each handler |
| **Scripted multi-session tests** | inter-session tools (`_send`, `_task/*`) | 3 scripted stdio agents (`orchestration_agent.py`) drive the real async backend through the tripartite flow | `tests/integration.rs` |

### Shared test helpers (`tests/integration.rs`)

- `spawn_echo_session(manager, name)` — spawn + bind a session on the pure-stdlib echo agent. **Calls `set_manager`** (the production pattern; without it every agent-emitted tool request errors "manager not available").
- `spawn_role_session(manager, name, role, extra_args)` — same, but on the scripted `orchestration_agent.py` with `--role {worker,orchestrator,instructor}`.
- `build_tool_context(manager, session_id)` — a `ToolContext` for calling tool handlers directly.
- `tool(Result<_, String>)` — convert a handler's string-error into `anyhow::Result`.
- `extract_terminal_id(&Value)` / `exit_code_of(&Value)` — robust response field extractors (handle flat + tagged enum shapes).

### Scripted agents (`tests/orchestration_agent.py`)

Pure stdlib, line-based JSON-RPC. Roles do rote actions: emit a client-side
tool request (`_send` / `_task/*`), **read its ack synchronously**, then `end_turn`.
The synchronous read is not a fight with the async backend — the ack returns
the instant the backend *spawns* the async work (e.g. `_send` → `sent` before
the worker loop finishes), so by `end_turn` the tool's immediate effect is
applied and there are no races. Modeled on `python-sdk/examples/echo_agent.py`
+ crow-cli's tool-execution shape.

## Coverage today

### Orchestration (multi-session) — `tests/integration.rs`
- `echo_agent_basic_prompt` — baseline: a prompt round-trips through a real subprocess.
- `run_task_loop_processes_tasks_and_summarizes` — the Ralph loop promotes tasks + nags.
- `run_task_loop_stops_when_cancelled` — `cancel_prompt` wakes the `Notify`.
- `send_to_session_delivers_callback` — `_send` async two-step: prompt worker → summary → `Responding` + notify.
- `task_send_starts_target_loop` — `task_send` auto-starts the target's loop (the fix) + the guard flag.
- `orchestration_e2e_tripartite_flow` — **full chain**: instructor `_task/send` → orchestrator auto-starts → `_send` to worker → worker summary callback → orchestrator `_task/read`+`_task/write` done → next task → summary.

### Terminal (direct handler) — `tests/integration.rs`
- `terminal_env_vars_propagate_to_spawned_process` — a var in the `env` param reaches the spawned shell. **The refactor-regression guard.**
- `terminal_exit_code_propagated` — `exit 7` → `exitCode: 7` in the response.
- `terminal_kill_stops_long_running_process` — `kill_terminal` stops `sleep 30`.

### Filesystem (pure unit) — `src/tools/filesystem.rs` `#[cfg(test)]`
- `slice_lines` × 9 — incl. the `line: 2000`-past-EOF case that **panicked the live app** (`tools/filesystem.rs:25`), now clamped. The crash fix.

### State machine (pure unit) — `src/orchestration_state.rs` `#[cfg(test)]`
- `OrchestrationState::determine_next_prompt` × 20 — the testable core.

## Run

```
SIDEX_ACP_SKIP_SHELL_ENV=1 cargo test -p sidex-acp
```

- `SIDEX_ACP_SKIP_SHELL_ENV=1` bypasses `capture_shell_env` (which would `bash -ilc`-hang in this sandbox). The agents are absolute-path `/usr/bin/python3` scripts — no PATH lookup needed.
- All tests are parallel-safe (each spawns its own subprocesses).

## Next

- **fs round-trip:** `read_text_file` + `write_text_file` against a tempfile (covers the `spawn_blocking` + `file_ops` path, not just `slice_lines`).
- **permissions:** `session/request_permission` response shape.
- **terminal/cancel:** `cancel_terminal` (SIGKILL=137 path) vs `kill_terminal`.
- **orchestration edge cases:** a "stuck worker" agent (never responds) to exercise the `WaitingForResponse` cancel/timeout path; unknown-target error path for `_send`.
