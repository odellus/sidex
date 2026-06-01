# Sidex Chat URI Schema Plan

## Problem Statement

Currently, sidexChat is registered as a **ViewPane** in the AuxiliaryBar. This means:
- It can only exist in one location (the auxiliary sidebar)
- Users cannot drag it to the editor area to have it alongside code
- You can only have ONE chat session active at a time
- It cannot be split, moved between editor groups, or persisted like other editors

## Key Discovery: Backend Already Supports This!

After analyzing both **crow-ui** and **sidex-acp** codebases:

### What's Already Built

1. **sidex-acp Rust crate** (`crates/sidex-acp/`) is a **direct port** of crow-ui's backend
   - `AcpSessionManager` manages multiple sessions in a `HashMap<String, Arc<AcpSession>>`
   - Each session has its own agent process, stdin/stdout, notification broadcast
   - Methods: `init_connection`, `bind_new_session`, `bind_load_session`, `switch_session`

2. **Tauri commands** (`src-tauri/src/commands/acp_chat.rs`) already accept `session_id`
   - `acp_chat_prompt({ session_id, blocks })` — routes to correct session
   - `acp_chat_cancel({ session_id })` — cancels specific session
   - Event bridge broadcasts with `sessionId` field

3. **Event routing** is already session-scoped
   - Backend sends: `{ type: "update", sessionId: "abc-123", update: {...} }`
   - Frontend acpStore checks `if (sessionId !== this._sessionId) return;`

### What's Missing

The **only gap** is the frontend `acpStore.ts` — it's single-session:
```typescript
// Current: ONE session at a time
private _sessionId: string = '';
private _notifications: AcpNotification[] = [];

// Needed: Map of sessions (like crow-ui)
private _sessions = new Map<string, SessionState>();
```

**And** the Editor infrastructure (EditorInput/EditorPane) to make it a tab.

### Bottom Line

**No backend changes needed for multi-session.** The work is:
1. Register URI scheme + EditorInput + EditorPane (so chat can be a tab)
2. Refactor acpStore from single-session to Map-based multi-session (port from crow-ui)

---

## Solution: Register as an Editor with URI Scheme

VS Code's architecture allows certain UI components to exist as **editors** (tabs in the main editor area) by:
1. Defining a custom URI scheme (like `vscode-terminal`, `vscode-chat-editor`)
2. Creating an `EditorInput` that represents the editor's state
3. Creating an `EditorPane` that renders the UI
4. Registering both with the workbench's editor system

## Research Findings

### Pattern from Terminal (Working Example)

The terminal uses this pattern successfully:

**URI Scheme:** `vscode-terminal`
- Defined in `src/vs/base/common/network.ts` as `Schemas.vscodeTerminal`
- Terminal instances get URIs like: `vscode-terminal://workspace/123`

**Key Components:**
1. **TerminalEditorInput** (`terminalEditorInput.ts`)
   - Extends `EditorInput`
   - Has `typeId = 'workbench.editors.terminal'`
   - Has `editorId = 'terminalEditor'`
   - Holds reference to `ITerminalInstance`
   - Implements `getName()`, `getDescription()`, `getIcon()` for tab display
   - Handles close confirmation via `IEditorCloseHandler`

2. **TerminalEditor** (`terminalEditor.ts`)
   - Extends `EditorPane`
   - Registered with `terminalEditorId`
   - Receives `TerminalEditorInput` via `setInput()`
   - Renders the terminal instance into the editor area

3. **Registration** (`terminal.contribution.ts`)
   ```typescript
   Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
     .registerEditorSerializer(TerminalEditorInput.ID, TerminalInputSerializer);
   
   Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)
     .registerEditorPane(
       EditorPaneDescriptor.create(TerminalEditor, terminalEditorId, terminalStrings.terminal),
       [new SyncDescriptor(TerminalEditorInput)]
     );
   ```

4. **Serializer** (`terminalEditorSerializer.ts`)
   - Implements `IEditorSerializer`
   - Allows terminal tabs to survive window reload
   - Serializes terminal ID, restores on restart

### Pattern from VS Code Chat (Upstream)

VS Code's Copilot Chat uses:

**URI Schemes:**
- `vscode-chat-editor` - For chat sessions in editor area
- `vscode-chat-session` - For local chat sessions (newer)

**Key Components:**
1. **ChatEditorInput** (`chatEditorInput.ts`)
   - Extends `EditorInput`
   - Has `TypeID = 'workbench.input.chatSession'`
   - Has `EditorID = 'workbench.editor.chatSession'`
   - Holds `IChatModelReference`
   - Implements close confirmation for unsaved edits

2. **ChatEditor** (`chatEditor.ts`)
   - Extends `AbstractEditorWithViewState<IChatEditorViewState>`
   - Wraps `ChatWidget`
   - Manages view state (scroll position)

3. **URI Generation:**
   ```typescript
   namespace ChatEditorUri {
     const scheme = Schemas.vscodeChatEditor;
     
     export function getNewEditorUri(): URI {
       const handle = Math.floor(Math.random() * 1e9);
       return URI.from({ scheme, path: `chat-${handle}` });
     }
   }
   ```

## Implementation Plan for Sidex Chat

### Phase 1: Define URI Scheme

**File:** `src/vs/base/common/network.ts`

Add to `Schemas`:
```typescript
export const sidexChat = 'sidex-chat';
```

This gives us URIs like: `sidex-chat://workspace/session-123`

### Phase 2: Create EditorInput

**File:** `src/vs/workbench/contrib/sidexChat/browser/sidexChatEditorInput.ts`

```typescript
export class SidexChatEditorInput extends EditorInput implements IEditorCloseHandler {
  static readonly ID = 'workbench.editors.sidexChat';
  static readonly EditorID = 'workbench.editor.sidexChat';
  
  override readonly closeHandler = this;
  
  constructor(
    readonly resource: URI,
    @ISidexChatService private readonly chatService: ISidexChatService,
  ) {
    super();
  }
  
  override get typeId(): string {
    return SidexChatEditorInput.ID;
  }
  
  override get editorId(): string | undefined {
    return SidexChatEditorInput.EditorID;
  }
  
  override getName(): string {
    // Extract session name or use default
    const sessionId = this.resource.path.split('/').pop();
    return `Sidex Chat ${sessionId || ''}`.trim();
  }
  
  override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
    if (!(otherInput instanceof SidexChatEditorInput)) {
      return false;
    }
    return isEqual(this.resource, otherInput.resource);
  }
  
  // Implement close confirmation if needed
  showConfirm(): boolean {
    return false; // Or check if streaming/has unsaved work
  }
  
  async confirm(editors: ReadonlyArray<IEditorIdentifier>): Promise<ConfirmResult> {
    return ConfirmResult.SAVE;
  }
}
```

### Phase 3: Create EditorPane

**File:** `src/vs/workbench/contrib/sidexChat/browser/sidexChatEditor.ts`

```typescript
export class SidexChatEditor extends EditorPane {
  static readonly ID = 'workbench.editor.sidexChat';
  
  private _editorInput?: SidexChatEditorInput;
  private _chatView?: SidexChatViewPane;
  
  constructor(
    group: IEditorGroup,
    @ITelemetryService telemetryService: ITelemetryService,
    @IThemeService themeService: IThemeService,
    @IStorageService storageService: IStorageService,
    @IInstantiationService private readonly instantiationService: IInstantiationService,
  ) {
    super(SidexChatEditor.ID, group, telemetryService, themeService, storageService);
  }
  
  override async setInput(
    input: SidexChatEditorInput,
    options: IEditorOptions | undefined,
    context: IEditorOpenContext,
    token: CancellationToken
  ): Promise<void> {
    this._editorInput = input;
    await super.setInput(input, options, context, token);
    
    // Create or reuse the chat view
    if (!this._chatView) {
      this._chatView = this.instantiationService.createInstance(
        SidexChatViewPane,
        {} // options
      );
      this._chatView.renderBody(this.element);
    }
    
    // Load the session associated with this input's resource
    const sessionId = input.resource.path.split('/').pop();
    if (sessionId) {
      this.chatService.loadSession(sessionId);
    }
  }
  
  protected override createEditor(parent: HTMLElement): void {
    // Container for the chat view
    this.element = parent;
  }
  
  override layout(dimension: dom.Dimension): void {
    this._chatView?.layout(dimension.height, dimension.width);
  }
  
  override focus(): void {
    this._chatView?.focus();
  }
}
```

### Phase 4: Create URI Helper

**File:** `src/vs/workbench/contrib/sidexChat/browser/sidexChatUri.ts`

```typescript
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';

export namespace SidexChatUri {
  const scheme = Schemas.sidexChat;
  
  export function getNewEditorUri(workspaceId: string): URI {
    const sessionId = `session-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    return URI.from({
      scheme,
      path: `/${workspaceId}/${sessionId}`,
    });
  }
  
  export function parseSessionId(resource: URI): string | undefined {
    if (resource.scheme !== scheme) {
      return undefined;
    }
    const parts = resource.path.split('/');
    return parts[2]; // /workspaceId/sessionId
  }
}
```

### Phase 5: Create Serializer

**File:** `src/vs/workbench/contrib/sidexChat/browser/sidexChatEditorSerializer.ts`

```typescript
export interface ISerializedSidexChatEditorInput {
  readonly resource: URI;
}

export class SidexChatEditorInputSerializer implements IEditorSerializer {
  canSerialize(input: EditorInput): input is SidexChatEditorInput {
    return input instanceof SidexChatEditorInput;
  }
  
  serialize(input: EditorInput): string | undefined {
    if (!this.canSerialize(input)) {
      return undefined;
    }
    
    const obj: ISerializedSidexChatEditorInput = {
      resource: input.resource,
    };
    
    return JSON.stringify(obj);
  }
  
  deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
    const obj: ISerializedSidexChatEditorInput = JSON.parse(serializedEditorInput);
    return instantiationService.createInstance(SidexChatEditorInput, URI.parse(obj.resource));
  }
}
```

### Phase 6: Register Editor

**File:** `src/vs/workbench/contrib/sidexChat/browser/sidexChat.contribution.ts`

Add to existing registrations:

```typescript
// Register editor pane for editor area
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
  .registerEditorSerializer(
    SidexChatEditorInput.ID,
    SidexChatEditorInputSerializer
  );

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)
  .registerEditorPane(
    EditorPaneDescriptor.create(
      SidexChatEditor,
      SidexChatEditor.ID,
      nls.localize('sidexChat', "Sidex Chat")
    ),
    [new SyncDescriptor(SidexChatEditorInput)]
  );
```

### Phase 7: Add Command to Open in Editor

**File:** `src/vs/workbench/contrib/sidexChat/browser/sidexChat.contribution.ts`

```typescript
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.openSidexChatEditor',
      title: nls.localize2('openSidexChatEditor', 'Open Sidex Chat in Editor'),
      f1: true,
    });
  }
  
  async run(accessor: ServicesAccessor): Promise<void> {
    const editorService = accessor.get(IEditorService);
    const workspaceContextService = accessor.get(IWorkspaceContextService);
    const workspace = workspaceContextService.getWorkspace();
    const workspaceId = workspace.folders[0]?.name || 'default';
    
    const uri = SidexChatUri.getNewEditorUri(workspaceId);
    await editorService.openEditor({
      resource: uri,
      options: { pinned: true }
    });
  }
});
```

### Phase 8: Multi-Session Support (Frontend Only!)

**GREAT NEWS:** The backend is already fully multi-session capable! After analyzing both crow-ui and sidex-acp, I discovered:

#### Backend Already Supports Multiple Sessions

**sidex-acp Rust backend** (`crates/sidex-acp/src/manager.rs`) already has:
- `AcpSessionManager` with `sessions: HashMap<String, Arc<AcpSession>>`
- `init_connection()` - spawn + initialize agent
- `bind_new_session()` - create new session
- `bind_load_session()` - load existing session
- `switch_session()` - switch to different session
- Sessions keyed by session_id, events broadcast with session_id

**Tauri commands** (`src-tauri/src/commands/acp_chat.rs`) already expose:
- `acp_chat_spawn` → returns `connection_id`
- `acp_chat_new_session` → takes `connection_id`, returns `session_id`
- `acp_chat_prompt` → takes `session_id` (routes to correct session!)
- `acp_chat_cancel` → takes `session_id`
- `acp_chat_close_session` → takes `session_id`
- `acp_chat_list_sessions` → lists available sessions

**Event bridge** already routes by session:
```rust
SessionEvent::Update { session_id, update } => {
    serde_json::json!({
        "type": "update",
        "sessionId": session_id,  // ← Already session-scoped!
        "update": update,
    })
}
```

#### The Gap: Frontend acpStore is Single-Session

Current sidex `acpStore.ts`:
```typescript
class AcpStore {
  private _sessionId: string = '';           // ← SINGLE session
  private _notifications: AcpNotification[] = [];  // ← SINGLE notification log
  private _isStreaming: boolean = false;     // ← SINGLE streaming state
  
  _handleSessionEvent(payload) {
    if (sessionId !== this._sessionId) { return; }  // ← Drops other sessions!
    // ...
  }
}
```

#### Solution: Port crow-ui's Multi-Session Store

crow-ui's `acp-store.ts` already solves this:
```typescript
// Per-session state
interface SessionState {
  status: ConnectionStatus;
  promptTurnState: PromptTurnState;
  sessionInfo: SessionInfo | null;
  notifications: AcpNotification[];  // ← Per-session notifications
  cwd: string;
  agentConfig: AgentConfig | null;
  queuedItems: QueuedItem[];
}

// Global state
const sessions = new Map<string, SessionState>();  // ← Multiple sessions!
let defaultSessionId: string | null = null;

// Event routing
export function handleSessionEvent(sessionId: string, update: unknown) {
  const state = sessions.get(sessionId);  // ← Routes to correct session
  if (!state) {
    console.warn(`session ${sessionId} not found`);
    return;
  }
  // ... update this specific session
}
```

#### What We Need to Do

**Refactor sidex `acpStore.ts` to match crow-ui pattern:**

1. Replace single-session fields with `Map<string, SessionState>`
2. Each `EditorInput` gets its own session from the map
3. Event handler routes updates by `sessionId` to correct state
4. Each editor tab subscribes to its own session state

**No backend changes required!** The Tauri commands already:
- Accept `session_id` parameters
- Route prompts to correct session
- Broadcast events with `sessionId`

#### Migration Path

```typescript
// BEFORE (single-session)
class AcpStore {
  private _sessionId: string = '';
  private _notifications: AcpNotification[] = [];
  
  async sendMessage(text: string): Promise<void> {
    if (!this._sessionId) { return; }
    await invoke('acp_chat_prompt', {
      request: { session_id: this._sessionId, blocks: [...] }
    });
  }
}

// AFTER (multi-session, like crow-ui)
interface SessionState {
  sessionId: string;
  connectionId: string;
  notifications: AcpNotification[];
  isStreaming: boolean;
  promptTurnState: PromptTurnState;
}

class AcpStore {
  private _sessions = new Map<string, SessionState>();
  
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) { return; }
    await invoke('acp_chat_prompt', {
      request: { session_id: sessionId, blocks: [...] }
    });
  }
  
  private _handleSessionEvent(payload: { sessionId: string; update: any }) {
    const session = this._sessions.get(payload.sessionId);
    if (!session) { return; }  // Not our session
    // Update THIS session's state
    session.notifications.push(/* ... */);
    this._onSessionChanged.fire(payload.sessionId);
  }
}
```

### Phase 9: Keep AuxiliaryBar View Working

The existing `SidexChatViewPane` should continue to work in the auxiliary bar. Options:

**Option A: AuxiliaryBar as "Quick Access"**
- Shows the most recent/default session
- "Open in Editor" button to move to editor area
- Simple, minimal changes

**Option B: AuxiliaryBar as "Session Launcher"**
- Lists all active sessions
- Click session → opens in editor tab
- "New Session" button creates fresh chat
- More like crow-ui's sidebar

**Option C: AuxiliaryBar as "Context-Aware Viewer"**
- Shows whichever session is currently focused
- Auto-switches when you click a chat tab
- Like VS Code's Problems panel

**Recommendation:** Start with Option A (quick access), then evolve to Option B (launcher) once multi-session is working well.

## File Structure

```
sidexChat/
├── browser/
│   ├── sidexChat.contribution.ts          # Update: add editor registration
│   ├── sidexChatEditor.ts                 # NEW: EditorPane
│   ├── sidexChatEditorInput.ts            # NEW: EditorInput
│   ├── sidexChatEditorSerializer.ts       # NEW: Serializer
│   ├── sidexChatUri.ts                    # NEW: URI helpers
│   ├── sidexChatService.ts                # Update: multi-session support
│   ├── sidexChatView.ts                   # Keep: auxiliary bar view
│   ├── acpStore.ts                        # Update: multi-session support
│   └── components/                        # Keep: reusable UI components
```

## Benefits

1. **Multiple Sessions**: Each editor tab = independent chat session
2. **Drag & Drop**: Can move chat between editor groups
3. **Split View**: Can have chat side-by-side with code
4. **Persistence**: Sessions survive window reload via serializer
5. **Flexibility**: Users choose between auxiliary bar or editor area

## Testing Strategy

1. Open chat in auxiliary bar (existing behavior)
2. Open chat in editor area via command palette
3. Open multiple chat sessions in different tabs
4. Drag chat tab between editor groups
5. Split editor to have chat + code side-by-side
6. Reload window and verify chat sessions restore
7. Verify each session has independent state (different agents, different conversations)

## Architecture Mapping: crow-ui → sidex

### What's Already Done (Backend)

| crow-ui Component | sidex Equivalent | Status |
|-------------------|------------------|--------|
| **Rust Backend** | | |
| `crow-ui-server::acp_session::AcpSession` | `sidex-acp::session::AcpSession` | ✅ Identical API |
| `crow-ui-server::acp_session::AcpSessionManager` | `sidex-acp::manager::AcpSessionManager` | ✅ Identical API |
| `AppState.acp_sessions` | `AcpChatState.session_manager` | ✅ Both use manager |
| HTTP API: `POST /api/acp/sessions` | Tauri: `acp_chat_spawn` + `acp_chat_new_session` | ✅ Same flow |
| HTTP API: `POST /api/acp/sessions/:id/prompt` | Tauri: `acp_chat_prompt` | ✅ Session-scoped |
| HTTP API: `POST /api/acp/sessions/:id/cancel` | Tauri: `acp_chat_cancel` | ✅ Session-scoped |
| WebSocket events: `sessionId` in payload | Tauri events: `sessionId` in payload | ✅ Session-scoped |
| **Session Lifecycle** | | |
| `init_connection()` → connection_id | `acp_chat_spawn` → connection_id | ✅ |
| `bind_new_session(connection_id)` → session_id | `acp_chat_new_session(connection_id)` → session_id | ✅ |
| `bind_load_session(connection_id, target_session_id)` | Not yet exposed via Tauri command | ⚠️ Need to add |
| `switch_session(current_id, target_id)` | Not yet exposed via Tauri command | ⚠️ Need to add |
| `list_sessions_via_connection(connection_id, cwd)` | `acp_chat_list_sessions` | ✅ |

### What Needs to Be Done (Frontend)

| crow-ui Frontend | sidex Frontend | Status |
|------------------|----------------|--------|
| **Store Architecture** | | |
| `sessions: Map<string, SessionState>` | `_sessionId: string` (single) | ❌ Needs refactor |
| `SessionState.notifications[]` per session | `_notifications[]` (single) | ❌ Needs refactor |
| `SessionState.isStreaming` per session | `_isStreaming` (single) | ❌ Needs refactor |
| `SessionState.promptTurnState` per session | `_promptTurnState` (single) | ❌ Needs refactor |
| **Event Routing** | | |
| `handleSessionEvent(sessionId, update)` routes by ID | `_handleSessionEvent` filters by `_sessionId` | ❌ Needs refactor |
| `subscribeToSession(sessionId, cb)` | `onDidChangeNotifications` (no session param) | ❌ Needs refactor |
| **Session Lifecycle** | | |
| `createSession(config, cwd)` → sessionId | `spawnAndConnect(config)` → single session | ❌ Needs refactor |
| `closeSession(sessionId)` | `closeSession()` (single) | ❌ Needs refactor |
| `prompt(sessionId, blocks)` | `sendMessage(text)` (uses `_sessionId`) | ❌ Needs refactor |
| **UI Integration** | | |
| ChatPane subscribes to specific session | SidexChatView uses single service | ❌ Needs refactor |
| Multiple ChatPanes can coexist | Single SidexChatView in auxiliary bar | ❌ Needs EditorInput/EditorPane |

### Implementation Checklist

**Phase 1: Editor Infrastructure (URI Schema)**
- [ ] Add `sidexChat` to `Schemas` in `network.ts`
- [ ] Create `SidexChatEditorInput` (holds URI with session_id)
- [ ] Create `SidexChatEditor` (EditorPane that renders chat UI)
- [ ] Create `SidexChatEditorSerializer` (persistence)
- [ ] Register editor pane in `sidexChat.contribution.ts`
- [ ] Add command to open chat in editor area

**Phase 2: Multi-Session Store (Frontend)**
- [ ] Refactor `AcpStore` to use `Map<string, SessionState>`
- [ ] Update `_handleSessionEvent` to route by sessionId
- [ ] Add `getSession(sessionId)` and `subscribeToSession(sessionId, cb)`
- [ ] Update `sendMessage(sessionId, text)` to accept session_id
- [ ] Update `SidexChatService` to be session-aware

**Phase 3: Wire Editor to Session**
- [ ] `SidexChatEditorInput` constructor creates session via store
- [ ] `SidexChatEditor` subscribes to its session's state
- [ ] Each editor tab has independent notifications/streaming state
- [ ] Closing tab calls `closeSession(sessionId)`

**Phase 4: Backend Enhancements (Optional)**
- [ ] Add `acp_chat_load_session` Tauri command (for loading existing sessions)
- [ ] Add `acp_chat_switch_session` Tauri command (for switching sessions)
- [ ] Add session persistence to SQLite (like crow-ui-db)

### Data Flow Comparison

**crow-ui (Multi-Session):**
```
User types in ChatPane #1
  ↓
acpStore.prompt(sessionId_1, blocks)
  ↓
HTTP POST /api/acp/sessions/{sessionId_1}/prompt
  ↓
Backend routes to AcpSession[sessionId_1]
  ↓
Agent processes, sends session/update
  ↓
Backend broadcasts: { sessionId: sessionId_1, update: {...} }
  ↓
Frontend receives event
  ↓
handleSessionEvent(sessionId_1, update)
  ↓
sessions.get(sessionId_1).notifications.push(...)
  ↓
ChatPane #1 re-renders (subscribed to sessionId_1)
```

**sidex (Current - Single Session):**
```
User types in SidexChatView
  ↓
acpStore.sendMessage(text)
  ↓
Tauri invoke: acp_chat_prompt({ session_id: this._sessionId, blocks })
  ↓
Backend routes to AcpSession[this._sessionId]
  ↓
Agent processes, sends session/update
  ↓
Backend emits Tauri event: { sessionId, update }
  ↓
Frontend receives event
  ↓
_handleSessionEvent: if (sessionId !== this._sessionId) return;  ← DROPS!
  ↓
this._notifications.push(...)
  ↓
SidexChatView re-renders
```

**sidex (Target - Multi-Session):**
```
User types in SidexChatEditor #1
  ↓
acpStore.sendMessage(sessionId_1, text)
  ↓
Tauri invoke: acp_chat_prompt({ session_id: sessionId_1, blocks })
  ↓
Backend routes to AcpSession[sessionId_1]
  ↓
Agent processes, sends session/update
  ↓
Backend emits Tauri event: { sessionId: sessionId_1, update }
  ↓
Frontend receives event
  ↓
_handleSessionEvent: session = this._sessions.get(sessionId_1)
  ↓
session.notifications.push(...)
  ↓
this._onSessionChanged.fire(sessionId_1)
  ↓
SidexChatEditor #1 re-renders (subscribed to sessionId_1)
```

## Migration Path

**Phase 1**: Add editor support alongside existing auxiliary bar view
- Both coexist, users can choose
- Auxiliary bar continues to work as single-session
- Editor tabs can open new sessions

**Phase 2**: Refactor store to multi-session
- All sessions use the same Map-based store
- Auxiliary bar becomes "session #0" or "default session"
- Editor tabs each get their own session

**Phase 3**: Make auxiliary bar view a "launcher" or "session picker"
- Lists all active sessions
- Click session → opens in editor tab
- "New Session" button creates fresh chat

**Phase 4**: Add session persistence (optional)
- Store session history in SQLite
- Restore sessions on app restart
- Browse/load old sessions

## References

- VS Code Custom Editor API: https://code.visualstudio.com/api/extension-guides/custom-editors
- Terminal Editor Implementation: `src/vs/workbench/contrib/terminal/browser/terminalEditor*.ts`
- Chat Editor Implementation: `src/vs/workbench/contrib/chat/browser/widgetHosts/editor/`
- Editor Registration Pattern: `src/vs/workbench/browser/parts/editor/editor.contribution.ts`
