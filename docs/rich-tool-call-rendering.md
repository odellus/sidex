# Rich Tool Call Rendering Implementation

## Overview

This implementation adds rich, interactive rendering for ACP tool calls in the chat interface, replacing simple text output with real terminals and syntax-highlighted code diffs.

## Components

### 1. InlineTerminal (`components/tools/inlineTerminal.ts`)

A real xterm.js terminal embedded in chat messages that:
- Spawns a client-side PTY via `terminal_spawn` Tauri command
- Streams output in real-time from the PTY
- Accepts user input (interactive terminal)
- Handles resize events
- Shows command, working directory, and exit status

**Key Features:**
- Uses `@xterm/xterm` and `@xterm/addon-fit`
- Listens to `terminal-data` events for output streaming
- Forwards user input via `terminal_write`
- Updates status when `terminal-exit` event fires
- Proper cleanup on dispose

**Interface:**
```typescript
interface InlineTerminalOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
```

### 2. FileViews (`components/tools/fileViews.ts`)

Monaco-based file renderers for read/write/edit operations:

#### FileReadView
- Read-only Monaco editor with syntax highlighting
- Auto-detects language from file extension
- Responsive height based on content

#### FileWriteView
- Monaco editor with green background decorations
- Shows new file content with "+" markers
- Visual indication of newly created files

#### FileEditView
- Monaco diff editor showing before/after
- Collapsible unchanged regions
- Side-by-side or inline diff display

**Supported Languages:** 30+ including Rust, TypeScript, JavaScript, Python, Go, Java, C/C++, CSS, HTML, JSON, Markdown, YAML, Shell, SQL, and more.

### 3. ToolCallItem (`components/tools/toolCallItem.ts`)

Smart dispatcher that:
- Detects tool kind from name/kind/content
- Routes to appropriate renderer (terminal, read, write, edit)
- Handles collapsible UI with clickable headers
- Tracks tool metadata and status

**Tool Kind Detection:**
- `execute`/`command` → InlineTerminal
- `read` → FileReadView
- `write`/`create` → FileWriteView (or FileEditView if old content exists)
- `edit` → FileEditView (diff view)
- Fallback → Raw JSON display

### 4. ToolCallGroup (`components/tools/toolCallGroup.ts`)

Accumulates tool call updates:
- Tracks content blocks from `tool_call_update` notifications
- Forwards blocks to appropriate ToolCallItem
- Merges rawOutput and metadata

## Data Flow

### Terminal Tool Calls

1. **Tool Call Arrives:**
   ```typescript
   {
     toolCallId: "123",
     name: "run_command",
     kind: "execute",
     rawInput: {
       command: "npm",
       args: ["install"],
       cwd: "/project"
     }
   }
   ```

2. **ToolCallItem Creates InlineTerminal:**
   - Extracts command/args/cwd from rawInput
   - Passes to InlineTerminal constructor

3. **InlineTerminal Spawns PTY:**
   - Calls `terminal_spawn({shell: "npm", args: ["install"], cwd: "/project"})`
   - Gets back numeric `terminal_id`
   - Listens to `terminal-data` events
   - Listens to `terminal-exit` events

4. **Real-Time Streaming:**
   - PTY output → `terminal-data` event → xterm.write()
   - User input → xterm.onData → `terminal_write`
   - Resize → xterm.onResize → `terminal_resize`

5. **Completion:**
   - `terminal-exit` event fires with exit code
   - InlineTerminal updates status indicator
   - Shows "✓ exited 0" or "✗ exited N"

### File Operations

1. **Read Tool:**
   ```typescript
   {
     kind: "read",
     rawInput: { path: "/file.ts" },
     rawOutput: { content: "..." }
   }
   ```
   → FileReadView with syntax highlighting

2. **Write Tool:**
   ```typescript
   {
     kind: "write",
     content: [{
       type: "diff",
       path: "/file.ts",
       newText: "..."
     }]
   }
   ```
   → FileWriteView with green decorations

3. **Edit Tool:**
   ```typescript
   {
     kind: "edit",
     content: [{
       type: "diff",
       path: "/file.ts",
       oldText: "...",
       newText: "..."
     }]
   }
   ```
   → FileEditView with diff editor

## Styling

All components use VSCode theme variables for consistent styling:
- `--vscode-editor-background`
- `--vscode-editor-foreground`
- `--vscode-terminal-background`
- `--vscode-widget-border`
- And many more...

Custom CSS classes:
- `.sc-inline-terminal` - Terminal container
- `.sc-tool-call` - Tool call accordion
- `.sc-file-read-view` - File read container
- `.sc-write-view-line` - Green background for write view
- `.sc-write-view-glyph` - "+" marker for write view

## Dependencies

- `@xterm/xterm` ^5.5.0
- `@xterm/addon-fit` ^0.10.0
- `@tauri-apps/api` (for invoke/listen)
- `monaco-editor` (already in project)

## Testing

To test the implementation:

1. Start dev server: `npm run tauri dev`
2. Open chat panel
3. Send a message that triggers tool calls:
   - "List files in current directory" → should show terminal with `ls` output
   - "Read package.json" → should show FileReadView
   - "Create a new file called test.txt" → should show FileWriteView
   - "Edit src/main.ts to add a comment" → should show FileEditView

## Future Enhancements

- Syntax highlighting in terminal output
- Clickable file paths in terminal
- Copy buttons for code blocks
- Download buttons for file content
- Collapsed previews for large outputs
- Progress indicators for long-running commands
