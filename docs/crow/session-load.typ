= Session Load — Wiring Proposal

== Context

Session loading in sidex has the backend fully built (`sidex-acp` crate + Tauri commands) and the chat UI fully built (ChatHeader history panel with search, session list, click-to-load). The gap is purely in the **service layer** — the `IAcpChatService` methods are stubs that never call the store.

== How crow-ui Does It

crow-ui has a two-phase session lifecycle:

+ *Phase 1 — Connection:* `init_connection()` spawns the agent, sends `initialize`, and stores the connection (unbound, no session yet). The frontend calls `listConnectionSessions(connectionId, cwd)` which asks the agent for its stored session list via `session/list`.

+ *Phase 2 — Binding:* User picks a session from a dropdown (or "New Session"), then `bind_new_session()` or `bind_load_session()` sends `session/new` or `session/load` to the agent and moves the connection into the active sessions map.

When the agent receives `session/load`, it replays the full conversation history as `session/update` notifications through the same broadcast channel. The frontend's chat rendering pipeline handles these identically to live notifications — no special code needed.

crow-ui also supports *live session switching* on a bound session via `switch_session()`, which sends another `session/load` on the existing agent connection.

== What sidex Already Has

=== Backend — Complete

* `sidex-acp::AcpSessionManager` has all methods: `init_connection`, `bind_new_session`, `bind_load_session`, `switch_session`, `list_sessions_via_connection`.
* `sidex-acp::AcpSession` implements `load_session` (sends `session/load` JSON-RPC) and `list_sessions` (sends `session/list` JSON-RPC).
* All Tauri commands exist: `acp_chat_spawn`, `acp_chat_new_session`, `acp_chat_load_session`, `acp_chat_switch_session`, `acp_chat_list_sessions`.
* The Tauri event bridge (`acp:sessionUpdate`) forwards all `SessionEvent::Update` notifications to the frontend.

=== Frontend Store — Nearly Complete

`acpStore.ts` has:
* `spawnAndConnect()` — spawns agent, creates session, auto-reconnects to previous session if `_sessionId` is set.
* `listSessions(cwd)` — calls `acp_chat_list_sessions` Tauri command. Returns `SessionListEntry[]`.
* `loadSession(sessionId)` — calls `acp_chat_switch_session` Tauri command. Clears notifications, updates `_sessionId`.

=== Chat UI — Complete

* `ChatHeader` has a history panel with search input, session list, click-to-load.
* `setSessions(sessions)` populates the dropdown.
* `onSelectSession` event fires when user clicks a session item.
* `onHistory` event fires when history button is clicked.

=== Chat View — Wired But Broken

* `onHistory` calls `_fetchSessions()` which calls `chatService.getSavedSessions()` which returns `[]`.
* `onSelectSession` calls `chatService.loadSession(sessionId)` which is an empty stub.

== The Gap

Three stub methods in `AcpChatServiceImpl` prevent session loading from working:

#table(
  columns: (1fr, 1fr, 1fr),
  table.header([*Location*], [*Current*], [*Fix*]),
  [`acpChatService.getSavedSessions()`], [Returns `[]`], [Call `_store.listSessions(cwd)` async],
  [`acpChatService.loadSession(id)`], [Empty stub], [Call `_store.loadSession(id)`],
  [`acpChatView._fetchSessions()`], [Sync, calls stub], [Make async, await the store],
)

== Proposed Changes

=== 1. `acpChatService.ts` — Wire the stubs

```typescript
// BEFORE:
loadSession(_sessionId: string): void {
  // For now: close current and reopen
}

getSavedSessions(): Array<{ id: string; title: string; date: number }> {
  return [];
}

// AFTER:
async loadSession(sessionId: string): Promise<void> {
  await this._store.loadSession(sessionId);
}

async getSavedSessions(): Promise<Array<{
  id: string; title: string; date: number
}>> {
  const workspace = this._workspaceContext.getWorkspace();
  const cwd = workspace.folders[0]?.uri?.fsPath || '/home';
  return this._store.listSessions(cwd);
}
```

Also update the `IAcpChatService` interface:
```typescript
loadSession(sessionId: string): Promise<void>;
getSavedSessions(): Promise<Array<{
  id: string; title: string; date: number
}>>;
```

=== 2. `acpChatView.ts` — Make `_fetchSessions` async

```typescript
// BEFORE:
private _fetchSessions(): void {
  const sessions = this.chatService.getSavedSessions();
  this._header.setSessions(sessions.map(s => ({
    id: s.id,
    title: s.title,
    updated_at: new Date(s.date).toISOString(),
  })));
}

// AFTER:
private async _fetchSessions(): Promise<void> {
  try {
    const sessions = await this.chatService.getSavedSessions();
    this._header.setSessions(sessions.map(s => ({
      id: s.id,
      title: s.title,
      updated_at: new Date(s.date).toISOString(),
    })));
  } catch (e) {
    console.warn('[acpChatView] fetchSessions failed:', e);
    this._header.setSessions([]);
  }
}
```

Also update the `loadSession` call site:
```typescript
// BEFORE:
this._viewDisposables.add(
  this._header.onSelectSession(sessionId => {
    this.chatService.loadSession(sessionId);
  })
);

// AFTER:
this._viewDisposables.add(
  this._header.onSelectSession(sessionId => {
    this.chatService.loadSession(sessionId).catch(e => {
      console.error('[acpChatView] loadSession failed:', e);
    });
  })
);
```

=== 3. `acpStore.ts` — No changes needed

The store already has working `listSessions()` and `loadSession()` methods. They call the correct Tauri commands and handle the responses properly.

== Data Flow After Changes

```
User clicks history icon
  → ChatHeader._toggleHistory() fires onHistory
  → AcpChatView._fetchSessions()
    → AcpChatService.getSavedSessions()
      → AcpStore.listSessions(cwd)
        → invoke('acp_chat_list_sessions', { session_id, cwd })
          → AcpSessionManager → AcpSession.list_sessions(cwd)
            → JSON-RPC: session/list → crow-cli agent
              → Agent returns sessions from ~/.crow store
  → ChatHeader.setSessions(sessions)
  → Dropdown renders session list

User clicks a session
  → ChatHeader fires onSelectSession(sessionId)
  → AcpChatView → chatService.loadSession(sessionId)
    → AcpStore.loadSession(sessionId)
      → invoke('acp_chat_switch_session', { ... })
        → AcpSessionManager.switch_session()
          → AcpSession.load_session(target_session_id, cwd, ...)
            → JSON-RPC: session/load → crow-cli agent
              → Agent replays history as session/update notifications
                → Tauri event bridge: acp:sessionUpdate
                  → AcpStore._handleSessionEvent()
                    → notifications array populated
                      → AcpChatView re-renders chat
```

== Regression Analysis

=== What stays the same

* *New session creation:* `spawnAndConnect()` still creates a new session on first connect. No change to the startup flow.
* *Prompt/cancel:* `sendMessage()`, `stopStreaming()` are untouched.
* *Notification rendering:* The view's `_onNotificationAdded()` and all group components (UserMessage, ThinkingBlock, AgentMessageGroup, ToolCallGroup) are unchanged. Session/load notifications flow through the same `_handleSessionEvent` pipeline.
* *Config options:* Model selection via `setConfigOption` is unchanged. `loadSession` already preserves config options from the loaded session's response.
* *Session persistence:* `_sessionId` is already maintained across reconnects. `spawnAndConnect()` already attempts to reload the previous session on reconnect (the `if (this._sessionId)` branch).

=== What could go wrong

* *Notification clear on session switch:* `loadSession()` in the store clears `_notifications` before the session switch. The agent then replays history as new notifications. The view's `_onNotificationAdded` handles this correctly — when `notifications.length === 0` it calls `_resetView()` which disposes all group components and clears the messages container. Subsequent notifications from the replay will trigger fresh group creation. *This is exactly how it should work.*

* *Double-clearing:* If the agent's `session/load` response includes an initial `user_message_chunk` for the user's first message in the old session, the store's `sendMessage` won't interfere because we're not sending — we're loading. The replayed notifications come through the Tauri event bridge, not through `sendMessage`.

* *Async interface change:* Changing `getSavedSessions()` from sync to async and `loadSession()` from sync to async requires updating the interface declaration. All call sites are in the view which already uses fire-and-forget patterns for these events.

* *Agent not supporting session/list:* If the agent doesn't implement `session/list`, the Tauri command returns an error. The store's `listSessions()` catches this and returns `[]`. The header shows "No past chats". Graceful degradation.

* *Session replay volume:* A long session could produce hundreds of `session/update` notifications in rapid succession. Each notification triggers `_onNotificationAdded` → DOM manipulation → `scrollToBottom()`. The `ScrollManager` already batches scroll operations via `requestAnimationFrame`. The group-based rendering (`_lastGroupType` matching) already coalesces consecutive same-type notifications into single DOM elements. This should handle replay traffic efficiently.

== Files to Modify

+ `src/vs/workbench/contrib/acpChat/browser/acpChatService.ts` — wire the two stubs
+ `src/vs/workbench/contrib/acpChat/browser/acpChatView.ts` — make `_fetchSessions` async, update `loadSession` call site

Two files. Approximately 15 lines changed total.

== Future: Connection-Based Flow

The current approach uses session-based switching (create session first, then switch). For a more polished UX like crow-ui's two-phase "Init → List → Connect" pattern, we would need:

+ A new Tauri command `acp_chat_list_connection_sessions` that calls `list_sessions_via_connection` on an unbound connection
+ Split `spawnAndConnect` into separate `spawn` → `listSessions` → `bindSession` steps
+ A session selector dropdown in the ChatHeader or a dedicated connection screen

This is not needed for the initial implementation. The session-based flow works and the UI already exists.
