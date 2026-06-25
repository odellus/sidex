#!/usr/bin/env python3
"""Scripted ACP test agents for end-to-end orchestration tests.

Pure stdlib, line-based JSON-RPC over stdin/stdout — no asyncio, no SDK.
Role selected via --role.

Bipartite design (v3):
- worker             : marks InProgress task Completed on prompt/nag, summarizes
- worker_fail        : marks InProgress task Failed
- worker_multiturn   : requires --nag-count turns before marking done
- worker_create      : creates a new task on first prompt, then marks done
- worker_delete      : deletes InProgress task
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

    def mark_task(self, tid, status):
        return self.call_tool("_task/write", {
            "action": "update", "taskId": tid, "status": status,
        })

    def delete_task(self, tid):
        return self.call_tool("_task/write", {
            "action": "delete", "taskId": tid,
        })

    def create_task(self, title, description=""):
        return self.call_tool("_task/write", {
            "action": "create", "title": title, "description": description,
        })

    def get_tasks(self):
        return (self.call_tool("_task/read", {}) or {}).get("tasks", [])

    # ── Worker dispatch ─────────────────────────────────────────────────

    def handle_worker(self, session_id, text, is_nag):
        """Act on the InProgress task per the role."""
        if "all tasks are complete" in text.lower():
            agent_message(session_id, "Worker done. All tasks completed.")
            return

        task = find_in_progress(self.get_tasks())
        if not task:
            agent_message(session_id, "No task to act on.")
            return

        role = self.args.role

        if role == "worker":
            self.mark_task(task["id"], "completed")
            agent_message(session_id, "Marked task complete.")

        elif role == "worker_fail":
            self.mark_task(task["id"], "failed")
            agent_message(session_id, "Marked task failed.")

        elif role == "worker_multiturn":
            self.nag_counter += 1
            if self.nag_counter >= self.args.nag_count:
                self.mark_task(task["id"], "completed")
                agent_message(session_id,
                              "Marked task done after {} turns.".format(self.nag_counter))
                self.nag_counter = 0
            else:
                agent_message(session_id,
                              "Still working... (turn {}/{})".format(
                                  self.nag_counter, self.args.nag_count))

        elif role == "worker_create":
            if not self.created_flag:
                self.create_task("Dynamically created task",
                                 "Created by worker during processing.")
                self.created_flag = True
                agent_message(session_id, "Created new task and marked current done.")
            else:
                agent_message(session_id, "Marked task complete.")
            self.mark_task(task["id"], "completed")

        elif role == "worker_delete":
            self.delete_task(task["id"])
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
                agent.handle_worker(session_id, text, "incomplete task" in text.lower())
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
