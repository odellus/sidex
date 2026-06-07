# Markdown Preview in .deb: The Path Forward

## Current State

**What works:**
- Markdown preview works in `npx tauri dev` ✅
- Markdown preview works when running the binary directly from `target/release/` ✅
- Language configuration loading works in all contexts ✅
- Auto-surround for all languages works in all contexts ✅

**What doesn't work:**
- Markdown preview in the installed `.deb` package ❌
- Error: `[Warning] The Web Worker Extension Host did not start in 60s, that might be a problem.`

## The Root Cause

The markdown preview feature is implemented in the `markdown-language-features` extension, which runs in the **web worker extension host**. This is VSCode's architecture for running Node.js extensions in a web context.

The web worker extension host requires:
1. An iframe that loads `webWorkerExtensionHostIframe.html`
2. A blob worker that imports `extensionHostWorkerMain.js`
3. Multiple JS modules loaded via relative imports

**Why it works in dev mode:**

Hello!
- Vite serves files from `dist/` directly
- All paths resolve correctly via the dev server
- The iframe and worker can load their dependencies

**Why it breaks in .deb:**
- Tauri embeds the frontend assets in the binary
- Files are served via `tauri://` protocol
- The iframe tries to load `tauri://localhost/assets/webWorkerExtensionHostIframe-DWTsNr7i.html`
- Path resolution fails somewhere in the chain
- The worker never starts
- Extensions never load

**What we've tried:**
- Copied iframe HTML to `public/` directory → file exists but still doesn't load
- Added special cases to `getWorkerUrl()` for other workers but not the iframe
- Multiple agents have investigated but haven't solved the fundamental path resolution issue

**The fundamental problem:**
We're trying to make VSCode's complex web worker infrastructure work inside Tauri's embedded asset system. It's a mismatch between two different architectures.

## Two Paths Forward

### Option 1: Sidex Extension SDK (WASM-based)

**How it works:**
- Rewrite markdown preview as a Rust extension using the sidex SDK
- Compiles to WASM via `cargo build --target wasm32-wasip2`
- Loaded directly by the Rust host via wasmtime
- No iframe, no web worker, no `tauri://` protocol issues

**Pros:**
- Completely bypasses the web worker extension host problem
- Works identically in dev mode and .deb
- Lighter weight than Node.js extensions
- Already have 6 working rust extensions as examples
- Designed for this exact runtime from the start

**Cons:**
- **No `create-webview-panel` in the WIT yet** — can't open preview panels
- Would need to extend the SDK to support webview creation
- Requires implementing preview UI in Rust/WASM or via Tauri commands

**Current WIT capabilities:**
- Language features (completion, hover, diagnostics) ✅
- Commands and UI (input boxes, quick picks) ✅
- Workspace operations ✅
- Webview support (receive messages, visibility) ✅
- **Create webview panel** ❌ (not yet implemented)

**What would need to be added:**
- Add `create-webview-panel` to the WIT
- Implement in the host using Tauri's webview API
- Render markdown HTML in the webview

### Option 2: Contrib (Direct Integration)

**How it works:**
- Build markdown preview as a contrib module in `src/vs/workbench/contrib/`
- TypeScript code that runs in the main webview (not an extension)
- Uses Monaco's webview API directly
- No extension host dependency

**Pros:**
- Proven to work (we did this with ACP chat)
- Full control, tight integration
- No extension loading overhead
- Works in all contexts (dev, binary, .deb)
- Can use existing markdown rendering libraries

**Cons:**
- Tightly coupled to sidex core (not a separate extension)
- Less portable than extension model
- Need to manage markdown rendering ourselves

**Current contrib capabilities:**
- ACP chat (proven pattern) ✅
- Can create webview panels ✅
- Can render HTML ✅
- Can communicate with Rust backend ✅

**What would need to be built:**
- Markdown parser/renderer (or use existing library)
- Preview panel creation
- Live preview updates on edit
- Synchronization with editor

## Recommendation

**Go with Option 2 (Contrib) for now.**

Here's why:

1. **It's proven.** We already built ACP chat in contrib. We know it works in all contexts. We know how to create webview panels, render HTML, and communicate with the backend.

2. **It solves the problem immediately.** The web worker extension host issue is complex and multiple agents have failed to solve it. Contrib bypasses it entirely.

3. **Markdown preview is a core feature.** It's not a marketplace extension — it's table stakes for a modern editor. Having it tightly integrated is actually better than having it as an extension.

4. **We can still use the SDK later.** Once we stabilize the core features, we can extend the SDK to support webview creation and migrate preview features to extensions if needed. But that's a future optimization, not a blocker.

5. **The SDK is missing webview creation.** We'd need to add that to the WIT and implement it in the host. That's additional work on top of building the preview feature. Contrib gets us there faster.

## Implementation Plan

### Phase 1: Basic Markdown Preview (Contrib)

1. **Create contrib module** at `src/vs/workbench/contrib/markdown/`
   - `browser/markdownPreview.ts` — main preview logic
   - `browser/markdownPreview.contribution.ts` — registration
   - `browser/markdown.css` — preview styles

2. **Use an existing markdown renderer**
   - Options: `marked`, `markdown-it`, or roll our own
   - Need to handle: headers, lists, code blocks, links, images, tables

3. **Create preview command**
   - Command ID: `markdown.showPreview`
   - Opens preview panel in same editor area (not split)
   - Renders markdown to HTML
   - Updates on editor change

4. **Handle resources**
   - Images (relative paths)
   - Links (internal and external)
   - Code syntax highlighting (can use existing textmate grammars)

### Phase 2: Live Preview

1. **Editor change listener**
   - Debounce updates (don't re-render on every keystroke)
   - Scroll synchronization (optional)

2. **Preview refresh**
   - Re-render on content change
   - Preserve scroll position

### Phase 3: Polish

1. **Security**
   - Sanitize HTML output
   - CSP for preview panel

2. **Performance**
   - Virtual scrolling for large documents
   - Incremental rendering

3. **Features**
   - Export to HTML/PDF
   - Print support
   - Custom CSS themes

## What This Means for the SDK

We're not abandoning the sidex extension SDK. It's still the right long-term architecture for:
- Language servers (completion, diagnostics, formatting)
- Code actions and refactorings
- Custom commands
- Third-party extensions

But for **markdown preview specifically**, contrib is the faster path to a working solution.

Once we have the SDK webview capabilities implemented, we can:
1. Migrate markdown preview to an extension
2. Add typst preview as an extension
3. Support third-party preview extensions
4. Build a preview extension marketplace

But that's future work. Right now, we need markdown preview to work in the .deb, and contrib gets us there.

## What About the Web Worker Extension Host?

We can leave it broken for now. Here's why:

1. **The 6 rust extensions work.** They don't use the web worker host.

2. **We don't need most VSCode extensions.** The 70+ Node.js extensions in `extensions/` are designed for a marketplace model we don't have. We can selectively enable what we need.

3. **Language configurations are fixed.** We already implemented the `LanguageConfigurationFileHandler` that loads `language-configuration.json` from extensions. This works without the web worker host.

4. **We can fix it later if needed.** Once we have more bandwidth, someone can debug the `tauri://` path resolution issue. But it's not blocking us.

## Next Steps

1. **Create the contrib module structure**
   - Set up the directory and files
   - Register the contribution

2. **Implement basic markdown rendering**
   - Choose a markdown library
   - Create a simple preview command
   - Test in dev mode

3. **Build and test in .deb**
   - Verify it works without the web worker host
   - Confirm no path resolution issues

4. **Polish and ship**
   - Add live preview
   - Handle resources (images, links)
   - Document the feature

## Summary

**Problem:** Markdown preview doesn't work in .deb because the web worker extension host can't load its dependencies via the `tauri://` protocol.

**Solution:** Build markdown preview as a contrib module that runs in the main webview, bypassing the extension host entirely.

**Why this works:** Contrib modules don't use the web worker extension host. They run directly in the editor's webview and can create preview panels using Monaco's webview API. We already proved this pattern works with ACP chat.

**Trade-off:** Tighter coupling to sidex core, but faster path to a working solution. We can migrate to the SDK later once webview support is added to the WIT.

**Action:** Start building markdown preview in contrib. Get it working in all contexts (dev, binary, .deb). Polish and ship. Leave the web worker extension host broken for now — it's not blocking us.