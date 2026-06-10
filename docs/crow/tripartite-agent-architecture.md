# Tripartite Agent Architecture

A spec-driven development system built on ACP v1 extensions with prompt queues and Ralph loop orchestration.

```mermaid
flowchart TB
    subgraph Human["👤 Human"]
        User["User<br/><i>specs, priorities, sign-off</i>"]
    end

    subgraph Instructor["🎓 Instructor Agent"]
        InstPrompt["Conversation Loop"]
        InstSpec["Spec Refinement"]
        InstPlan["Emit plan with _meta.toSessionId"]
    end

    subgraph Orchestrator["🎯 Orchestrator Agent"]
        subgraph Ralph["Ralph Loop"]
            direction TB
            Pick["1. Pick next pending task"]
            Delegate["2. _send() to worker"]
            Wait["3. WaitingForResponse"]
            Eval["4. Evaluate response"]
            Decision{"Done?"}
            MarkDone["5. Emit plan update: completed ✓"]
            Bounce["5. Bounce back to worker"]
            Pick --> Delegate --> Wait --> Eval --> Decision
            Decision -->|No| Bounce --> Pick
            Decision -->|Yes| MarkDone --> Pick
        end
    end

    subgraph Worker["⚒️ Worker Agent"]
        WorkCtx["Fresh context per task"]
        Implement["Implement"]
        Commit["Commit"]
    end

    User -->|conversation| InstPrompt
    InstPrompt --> InstSpec
    InstSpec -->|serialize TODO.md| InstPlan
    InstPlan -->|plan + _meta.toSessionId| Orchestrator

    Pick -->|_send| Worker
    Implement --> Commit
    Commit -->|end_turn| Eval
```

---

## State Machine: Orchestrator Delegation Loop

```mermaid
stateDiagram-v2
    [*] --> NotCalled: session/prompt from Instructor
    
    NotCalled --> WaitingForResponse: agent calls _send()
    NotCalled --> NagDelegate: end_turn without delegating
    
    WaitingForResponse --> Responding: worker completes
    WaitingForResponse --> WaitingForResponse: worker still working
    
    Responding --> NotCalled: task_write(completed) + dequeue next
    Responding --> NagEvaluate: end_turn without task_write
    
    NagDelegate --> NotCalled: "delegate the task!"
    NagEvaluate --> Responding: "evaluate and mark status!"
```

---

## Prompt Queue: The Core Primitive

$$Q = \langle p_1, p_2, \dots, p_n \rangle \quad \text{where } p_i \in \text{session/prompt inputs}$$

The prompt queue is the fundamental primitive. Everything else is logic on top:

- **Task list** = prompt queue + plan status tracking
- **Compaction** = enqueue "summarize what you did" prompt after task list completes
- **Instructor → Orchestrator** = `_task_send` enqueues prompts to orchestrator's queue
- **Orchestrator → Worker** = `_send` enqueues a single prompt to worker's queue

```mermaid
sequenceDiagram
    participant H as 👤 Human
    participant I as 🎓 Instructor
    participant O as 🎯 Orchestrator
    participant W as ⚒️ Worker
    participant Q as Queue

    H->>I: "Let's do the IDE improvements"
    I->>I: Refine spec, build TODO.md
    H->>I: ✅ Sign off

    I->>Q: _task_send (sessionId: orchestrator)
    Q->>O: session/prompt [task 1: refactor auth]

    O->>Q: _send (sessionId: worker)
    Q->>W: session/prompt [implement auth refactor]
    Note over O: state = WaitingForResponse

    W->>W: Implement + Commit
    W-->>O: end_turn (response)
    Note over O: state = Responding

    O->>O: Evaluate diff
    O->>O: task_write [task 1: completed ✓]
    Note over O: state = NotCalled

    Q->>O: session/prompt [task 2: fix scroll]
    O->>Q: _send (sessionId: worker)
    Q->>W: session/prompt [fix scroll behavior]
    Note over O: state = WaitingForResponse
```

---

## The Invariants

$$\boxed{\text{Plan} \equiv \text{TODO.md} \equiv \text{Queue State}}$$

| Principle | Why |
|-----------|-----|
| **One worker, one orchestrator, one instructor** | Each has a dedicated context window for its one job |
| **Fresh context per task** | No pollution — worker only sees the current task spec |
| **Orchestrator never implements** | Evaluation is adversarial — you can't grade your own homework |
| **Instructor never evaluates code** | Human interaction is a full-time job, code review is another |
| **TODO.md is the source of truth** | User edits it, instructor serializes it, orchestrator loops over it |

---

## ACP Extensions (v1)

We only need **two** custom methods using the reserved underscore prefix:

$$\text{Extensions:} \;\; \{\texttt{\_list\_sessions},\; \texttt{\_send}\}$$

### `_list_sessions`
Discover available agent sessions. Returns list of session IDs with metadata.

### `_send`
Orchestrator delegates work to worker by enqueuing a single prompt to worker's queue. `_meta` carries target `sessionId`.

---

## Metadata-Driven Orchestration

Everything else uses **standard `session/update` plan notifications** with `_meta` for routing and state:

### Instructor → Orchestrator (Task Assignment)

```json
{
  "sessionUpdate": "plan",
  "entries": [
    {
      "content": "Refactor auth module",
      "priority": "high",
      "status": "pending"
    }
  ],
  "_meta": {
    "toSessionId": "sess_orchestrator_7"
  }
}
```

Backend sees the plan + `toSessionId` in `_meta`, enqueues the prompts to that session.

### Orchestrator Status Updates

```json
{
  "sessionUpdate": "plan",
  "entries": [
    {
      "content": "Refactor auth module",
      "priority": "high",
      "status": "in_progress",
      "_meta": {
        "assignedSession": "sess_worker_42",
        "orchestratorState": "WaitingForResponse"
      }
    }
  ]
}
```

Standard plan update with `_meta` on individual entries carrying orchestration state.

### Why Only Two Custom Methods?

- **Plans are plans** — standard `sessionUpdate: "plan"` needs no modification
- **Routing is metadata** — `_meta.toSessionId` tells backend where to send it
- **State is metadata** — `_meta` on plan entries tracks orchestration state
- **`_send` is different** — it's "execute this single prompt now", not "here's a task list"

---

## The Full Stack

$$\underbrace{\text{User} \leftrightarrow \text{Instructor}}_{\text{conversation}} \;\;\xrightarrow{\text{plan + \_meta}}\;\; \underbrace{\text{Orchestrator}}_{\text{Ralph loop}} \;\;\xrightarrow{\texttt{\_send}}\;\; \underbrace{\text{Worker}}_{\text{fresh context}}$$

---

## Implementation Strategy

**Build on v1, adopt upstream when stable.** No coupling to moving targets.

- **Plans** = standard `sessionUpdate: "plan"` with entries, no modifications needed
- **Orchestration** = backend state management in Rust (`session.rs`, `manager.rs`)
- **Queue** = backend primitive, not a protocol extension
- **Custom methods** = underscore-prefixed JSON-RPC methods per ACP extensibility

The protocol only sees `session/prompt` going in and `session/update` coming out. The orchestration state machine, nagging logic, and queue management all live in the client backend.

---

## Why Tripartite?

**Worker** — just does the work. No evaluation, no planning, no human interaction. Pure implementation agent.

**Orchestrator** — just evaluates. "Did the worker actually do what the task asked? Is it good enough? Does it need to try again? Or is it done and we move on?" That's a full-time job because you have to read diffs, understand intent, judge quality.

**Instructor** — just talks to the human. Understands what they want, refines the spec, translates vague ideas into concrete tasks. That's also a full-time job because humans are messy and iterative.

Collapse orchestrator into instructor, and you get an agent trying to hold a conversation while simultaneously reviewing code diffs. Context gets polluted, priorities conflict.

Collapse orchestrator into worker, and you lose the adversarial evaluation step — the worker just marks its own work as done, which is the whole thing Ralph loops struggle with.

Three focused agents, each with one job, each with a fresh context window dedicated to that one job.
