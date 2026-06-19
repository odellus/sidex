#!/usr/bin/env python3
"""Scripted ACP test agents for end-to-end orchestration tests.

Pure stdlib, line-based JSON-RPC over stdin/stdout — no asyncio, no SDK.
Role selected via --role {worker,orchestrator,instructor}.

Each agent does rote, deterministic actions: emit a client-side tool request
(an _send / _task/* JSON-RPC request), read its response, then end the turn.
Because tool calls are made synchronously *before* the turn's end_turn
response, there are no races with the backend's task loop — by the time the
agent ends its turn, the backend has fully applied the tool's effect.

- worker        : echoes prompt text back (agent_message_chunk) then end_turn.
- orchestrator  : delegates each task to the worker via _send, then marks it
                  completed via _task/read + _task/write. Needs --worker SID.
- instructor    : pushes a task batch to the orchestrator via _task/send.
                  Needs --target SID.
"""
import argparse
import json
import sys
import uuid


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def agent_message(session_id, text):
    send({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": text},
            },
        },
    })


def read_response(rid):
    """Read stdin until the JSON-RPC response for request id `rid` arrives."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("id") != rid:
            continue
        if "error" in msg:
            return None
        return msg.get("result")
    return None


def prompt_text(blocks):
    parts = []
    for b in blocks:
        if isinstance(b, dict):
            t = b.get("text", "")
            if t:
                parts.append(t)
    return "\n".join(parts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", required=True,
                        choices=["worker", "orchestrator", "instructor"])
    parser.add_argument("--worker", default="", help="worker session id (orchestrator)")
    parser.add_argument("--target", default="", help="orchestrator session id (instructor)")
    args = parser.parse_args()

    req_id = 0
    delegated = False

    def call_tool(method, params):
        nonlocal req_id
        req_id += 1
        rid = req_id
        send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        return read_response(rid)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        method = msg.get("method")
        msg_id = msg.get("id")

        if method == "initialize":
            send({"jsonrpc": "2.0", "id": msg_id, "result": {"protocolVersion": 1}})

        elif method == "session/new":
            send({"jsonrpc": "2.0", "id": msg_id,
                  "result": {"sessionId": uuid.uuid4().hex}})

        elif method == "session/cancel":
            pass

        elif method == "session/prompt":
            params = msg.get("params", {})
            session_id = params.get("sessionId", "unknown")
            blocks = params.get("prompt", [])
            text = prompt_text(blocks)
            lowered = text.lower()

            if args.role == "worker":
                agent_message(session_id, text or "(worker received task)")
                send({"jsonrpc": "2.0", "id": msg_id, "result": {"stopReason": "end_turn"}})

            elif args.role == "orchestrator":
                if "all tasks are complete" in lowered:
                    agent_message(session_id, "Orchestration complete. All tasks done.")
                    send({"jsonrpc": "2.0", "id": msg_id, "result": {"stopReason": "end_turn"}})

                elif "review it and mark" in lowered or "received a response" in lowered:
                    # Evaluate nag: find the InProgress task and mark it done.
                    result = call_tool("_task/read", {}) or {}
                    marked = False
                    for t in result.get("tasks", []):
                        if t.get("status") == "in_progress":
                            call_tool("_task/write", {
                                "action": "update",
                                "taskId": t.get("id"),
                                "status": "completed",
                            })
                            marked = True
                            break
                    delegated = False
                    agent_message(session_id,
                                  "Marked task complete." if marked else "No task to complete.")
                    send({"jsonrpc": "2.0", "id": msg_id, "result": {"stopReason": "end_turn"}})

                else:
                    # Task prompt / delegate nag.
                    if not delegated:
                        call_tool("_send", {
                            "toSessionId": args.worker,
                            "blocks": [{"type": "text", "text": text or "do the task"}],
                        })
                        delegated = True
                        agent_message(session_id, "Delegated task to worker.")
                    else:
                        agent_message(session_id, "Already delegated; waiting.")
                    send({"jsonrpc": "2.0", "id": msg_id, "result": {"stopReason": "end_turn"}})

            elif args.role == "instructor":
                tasks = [
                    {"title": "E2E task one", "description": "First scripted task."},
                    {"title": "E2E task two", "description": "Second scripted task."},
                ]
                call_tool("_task/send", {
                    "toSessionId": args.target,
                    "tasks": tasks,
                })
                agent_message(session_id, "Sent task batch to orchestrator.")
                send({"jsonrpc": "2.0", "id": msg_id, "result": {"stopReason": "end_turn"}})

        else:
            if msg_id is not None:
                send({"jsonrpc": "2.0", "id": msg_id, "result": {}})


if __name__ == "__main__":
    main()
