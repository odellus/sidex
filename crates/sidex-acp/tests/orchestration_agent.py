#!/usr/bin/env python3
"""Scripted ACP test agents for end-to-end orchestration tests.

Pure stdlib, line-based JSON-RPC over stdin/stdout — no asyncio, no SDK.
Role selected via --role.

Bipartite design (v3):
- worker             : marks InProgress task Completed (full-list-replace via todos array)
- worker_fail        : marks InProgress task Failed
- worker_multiturn   : requires --nag-count turns before marking done
- worker_create      : appends a new task on first prompt, then marks current done
- worker_delete      : removes InProgress task from the list
- orchestrator       : sends task batch to --worker, acknowledges callback
- orchestrator_multi : sends to --worker and --worker2
- orchestrator_resend: on first callback, sends a second batch
- sender             : uses _send (fire-and-forget) to message --worker
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


def prompt_text(blocks):
    parts = []
    for b in blocks:
        if isinstance(b, dict):
            t = b.get("text", "")
            if t:
                parts.append(t)
    return "\n".join(parts)


def find_in_progress(tasks):
    for t in tasks:
        if t.get("status") == "in_progress":
            return t
    return None


class Agent:
    def __init__(self, args):
        self.args = args
        self.req_id = 0
        self.nag_counter = 0
        self.created_flag = False
        self.resend_done = False

    def call_tool(self, method, params):
        self.req_id += 1
        rid = self.req_id
        send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
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

    def get_tasks(self):
        return (self.call_tool("_task/read", {}) or {}).get("tasks", [])

    def write_todos(self, todos):
        """Full-list-replace via the new task_write API."""
        return self.call_tool("_task/write", {"todos": todos})

    def tasks_to_todos(self, tasks, in_progress_status=None):
        """Convert task_read output to todos array for task_write.

        If in_progress_status is set, the in_progress task gets that status
        instead (used for marking done/failed).
        """
        todos = []
        for t in tasks:
            status = t.get("status", "pending")
            if status == "in_progress" and in_progress_status:
                status = in_progress_status
            todo = {"content": t.get("title", ""), "status": status}
            if "priority" in t:
                todo["priority"] = t["priority"]
            if t.get("assigned_to"):
                todo["assignedTo"] = t["assigned_to"]
            todos.append(todo)
        return todos

    def mark_in_progress(self, status):
        """Mark the in_progress task as the given status (full-list-replace)."""
        tasks = self.get_tasks()
        todos = self.tasks_to_todos(tasks, in_progress_status=status)
        return self.write_todos(todos)

    def delete_in_progress(self):
        """Remove the in_progress task from the list (full-list-replace)."""
        tasks = self.get_tasks()
        todos = self.tasks_to_todos(
            [t for t in tasks if t.get("status") != "in_progress"])
        return self.write_todos(todos)

    def append_task(self, title):
        """Add a new pending task to the list (full-list-replace)."""
        tasks = self.get_tasks()
        todos = self.tasks_to_todos(tasks)
        todos.append({"content": title, "status": "pending"})
        return self.write_todos(todos)

    # ── Worker dispatch ─────────────────────────────────────────────────

    def handle_worker(self, session_id, text):
        """Act on the InProgress task per the role."""
        task = find_in_progress(self.get_tasks())
        if not task:
            agent_message(session_id, "No task to act on.")
            return

        role = self.args.role

        if role == "worker":
            self.mark_in_progress("completed")
            agent_message(session_id, "Marked task complete.")

        elif role == "worker_fail":
            self.mark_in_progress("failed")
            agent_message(session_id, "Marked task failed.")

        elif role == "worker_multiturn":
            self.nag_counter += 1
            if self.nag_counter >= self.args.nag_count:
                self.mark_in_progress("completed")
                agent_message(session_id,
                              "Marked task done after {} turns.".format(self.nag_counter))
                self.nag_counter = 0
            else:
                agent_message(session_id,
                              "Still working... (turn {}/{})".format(
                                  self.nag_counter, self.args.nag_count))

        elif role == "worker_create":
            if not self.created_flag:
                self.append_task("Dynamically created task")
                self.created_flag = True
            self.mark_in_progress("completed")
            agent_message(session_id, "Marked task complete.")

        elif role == "worker_delete":
            self.delete_in_progress()
            agent_message(session_id, "Deleted task.")

    # ── Orchestrator dispatch ───────────────────────────────────────────

    def handle_orchestrator(self, session_id, text):
        lowered = text.lower()
        is_callback = "has completed its task list" in lowered

        if self.args.role == "orchestrator":
            if is_callback:
                agent_message(session_id, "Worker finished. Orchestration complete.")
            else:
                self.call_tool("_task/send", {
                    "toSessionId": self.args.worker,
                    "tasks": [
                        {"title": "E2E task one", "description": "First scripted task."},
                        {"title": "E2E task two", "description": "Second scripted task."},
                    ],
                })
                agent_message(session_id, "Sent task batch to worker.")

        elif self.args.role == "orchestrator_multi":
            if is_callback:
                agent_message(session_id, "A worker finished.")
            else:
                for target in [self.args.worker, self.args.worker2]:
                    if target:
                        self.call_tool("_task/send", {
                            "toSessionId": target,
                            "tasks": [{"title": "Task for " + target[:8],
                                       "description": "Multi-worker task."}],
                        })
                agent_message(session_id, "Sent tasks to both workers.")

        elif self.args.role == "orchestrator_resend":
            if is_callback:
                if not self.resend_done:
                    self.resend_done = True
                    self.call_tool("_task/send", {
                        "toSessionId": self.args.worker,
                        "tasks": [{"title": "Resent task",
                                   "description": "Second batch task."}],
                    })
                    agent_message(session_id, "Sent second batch to worker.")
                else:
                    agent_message(session_id, "Second batch done. All complete.")
            else:
                self.call_tool("_task/send", {
                    "toSessionId": self.args.worker,
                    "tasks": [{"title": "First batch task",
                               "description": "Initial task."}],
                })
                agent_message(session_id, "Sent first batch to worker.")

    # ── Sender dispatch ─────────────────────────────────────────────────

    def handle_sender(self, session_id, text):
        self.call_tool("_send", {
            "toSessionId": self.args.worker,
            "blocks": [{"type": "text", "text": "fire-and-forget message"}],
        })
        agent_message(session_id, "Sent message to worker via _send.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", required=True, choices=[
        "worker", "worker_fail", "worker_multiturn",
        "worker_create", "worker_delete",
        "orchestrator", "orchestrator_multi", "orchestrator_resend",
        "sender",
    ])
    parser.add_argument("--worker", default="")
    parser.add_argument("--worker2", default="")
    parser.add_argument("--nag-count", type=int, default=3)
    args = parser.parse_args()

    agent = Agent(args)

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

            if args.role in ("worker", "worker_fail", "worker_multiturn",
                             "worker_create", "worker_delete"):
                agent.handle_worker(session_id, text)
            elif args.role in ("orchestrator", "orchestrator_multi", "orchestrator_resend"):
                agent.handle_orchestrator(session_id, text)
            elif args.role == "sender":
                agent.handle_sender(session_id, text)

            send({"jsonrpc": "2.0", "id": msg_id, "result": {"stopReason": "end_turn"}})

        else:
            if msg_id is not None:
                send({"jsonrpc": "2.0", "id": msg_id, "result": {}})


if __name__ == "__main__":
    main()
