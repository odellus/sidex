#set page(width: 8.5in, height: 11in, margin: 1in)
#set text(font: "Inter", size: 11pt, lang: "en")
#set par(leading: 1.2em, first-line-indent: 0em)
#set heading(numbering: "1.1")
#set table(stroke: 0.5pt + luma(200))

#text(size: 20pt, weight: "bold")[Duplicate User Message Fix]
#text(size: 11pt, fill: luma(100))[acpChat editor — user messages rendered twice]
#v(0.5em)

#line(length: 100%, stroke: 0.5pt + luma(180))
#v(1em)

= Root Cause Analysis

The user message appears twice because the backend redundantly echoes back what the frontend just sent:

#v(0.3em)

#table(
  columns: (1fr, 2.2fr, 2fr),
  align: (left, left, left),
  table.header(
    [*Step*], [*Code Location*], [*What Happens*],
  ),
  [*1*], [`AcpStore.sendMessage()`], [Optimistically creates a `user_message_chunk` notification and appends it to `_notifications`. Fires `onDidChangeNotifications` → editor renders user message immediately.],
  [*2*], [`invoke('acp_chat_prompt')`], [Sends the prompt to the Rust backend via Tauri.],
  [*3*], [`session.rs:616-633`], [Backend broadcasts a `user_message_chunk` echo via `events_tx` with comment: _"Broadcast user message so frontend can display it in chat history."_],
  [*4*], [`AcpStore._handleSessionEvent()`], [Receives the backend echo. Falls through all control-signal guards to the "Content events" section. Creates a *second* `user_message_chunk` notification and appends it. Fires `onDidChangeNotifications` again → editor renders a *duplicate*.],
)

#v(0.5em)

The comment in `session.rs` is misleading. It claims the echo is needed "so frontend can display it in chat history," but:

+ The frontend already added the message to the notification log in step 1. It doesn't need the backend to tell it what it just sent.
+ Session replay works independently — when `loadSession()` is called, the backend sends `session/load` to the agent, and *the agent itself* replays the conversation history as events. The Rust backend just forwards those events. It doesn't manually broadcast user messages during replay.

The echo serves no purpose. It's redundant for live sends and irrelevant for replay.

= Proposed Solution

Remove the backend echo entirely. Delete lines 616–633 from `crates/sidex-acp/src/session.rs`:

#raw(lang: "rust", block: true, ```
// Broadcast user message so frontend can display it in chat history.
let user_text = content_blocks
    .iter()
    .filter_map(|b| match b {
        ContentBlock::Text(t) => Some(t.text.clone()),
        _ => None,
    })
    .collect::<Vec<_>>()
    .join("");
let _ = self.events_tx.send(SessionEvent::Update {
    session_id: self.session_id(),
    update: serde_json::json!({
        "sessionUpdate": "user_message_chunk",
        "content": { "type": "text", "text": user_text },
    }),
});
```)

This is a *17-line deletion* in a single file. No frontend changes required.

= Side-Effect Analysis

#v(0.3em)

#table(
  columns: (2fr, 3fr),
  align: (left, left),
  table.header(
    [*Concern*], [*Analysis*],
  ),
  [*Live messages*], [Frontend adds the message optimistically in `sendMessage()`. Without the backend echo, no duplicate. User sees their message instantly. No regression.],
  [*Session replay*], [`loadSession()` → backend sends `session/load` → agent replays conversation as events → backend forwards them. The agent sends `user_message_chunk` events for historical user messages during replay. Removing the echo from `run_prompt` does not affect replay. No regression.],
  [*Backend state*], [The echo is fire-and-forget (`let _ = ...`). No state depends on it. No locks are held. No other code paths reference it. No regression.],
  [*Other event types*], [Only `user_message_chunk` is affected. Agent thoughts, agent messages, tool calls, and all control signals are sent by the agent, not echoed by the backend. No regression.],
  [*Prompt failures*], [If `invoke('acp_chat_prompt')` fails, the optimistic notification remains in the log. Without the echo, there's no second attempt to add it. This is correct behavior. No regression.],
  [*Multiple frontends*], [If multiple frontends share a session, each frontend adds its own optimistic user message when it sends. The echo was redundant for all of them. No regression.],
)

= Why This is the Right Fix

#v(0.3em)

+ *Single source of truth:* The frontend owns the user message. It adds it optimistically for instant feedback. The backend doesn't need to confirm it.
+ *No coordination overhead:* No flags, no deduplication logic, no string matching. Just delete redundant code.
+ *Cleaner separation:* Backend handles agent communication. Frontend handles UI state. The echo blurred that line.
+ *Matches protocol intent:* ACP's `session/load` replays history. Live prompts don't need manual echoing — that's what optimistic UI updates are for.

= Implementation

Single file change:

#raw(lang: "text", block: true, ```
File: crates/sidex-acp/src/session.rs
Action: Delete lines 616-633 (the "Broadcast user message" block)
Lines removed: 17
Lines added: 0
```)

No changes to `acpStore.ts`, `acpChatEditor.ts`, `acpChatView.ts`, or any component files.
