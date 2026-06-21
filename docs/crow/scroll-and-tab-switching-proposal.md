# Scroll & Tab Switching: Unified Fix Proposal

## The Root Cause

All three bugs are the same bug: **the view's rendering state can diverge
from the store's data state, and nothing reconciles them.**

The `AcpStore` is persistent. It survives tab switches, keeps its Tauri
listener, and accumulates notifications. But all rendering state —
`_groupComponents`, `_lastGroupType`, `_lastGroupComp`, the DOM elements,
the scroll position, the `_userScrolledUp` flag — lives on the view, which
is disposable.

When the view is disposed (tab switch) or when rendering is deferred
(StreamingMarkdownRenderer's setTimeout), the view's state goes stale. The
store has the truth; the view has a stale snapshot. That divergence IS the bug.

- **Send doesn't scroll**: Store fires notification synchronously, but
  StreamingMarkdownRenderer defers DOM update 80ms. View scrolls against
  stale DOM.
- **Tab switch loses streaming**: Store keeps receiving notifications, but
  view's listener is disposed. View's `_renderedCount` (if it existed) would
  be behind `store.notifications.length`. And `_sessionDisposables.clear()`
  disposes the components that were saved in SessionView — so even the
  already-rendered content is broken when restored.
- **Scroll yanks during streaming**: CSS `overflow-anchor` moves scroll
  position independently of the view's `_userScrolledUp` flag. The
  `_isProgrammaticScroll` one-shot guard swallows one scroll event but
  overflow-anchor fires multiple. They fight.

## The Unified Fix

**Make the view a dumb renderer that reconciles against the store on bind.**

The store already has `_notifications[]` and fires `onDidChangeNotifications`.
The view already renders notifications into group components. The fix is to
ensure the view always reconciles its rendering state with the store — on
bind, on notification, and on send — using correct timing.

### What changes

**1. Components are NOT in `_sessionDisposables`**

Currently `_renderNotification()` does `this._sessionDisposables.add(comp)`.
When `_bindEvents()` calls `_sessionDisposables.clear()` on tab switch, every
group component is disposed — even though their DOM elements survive in
`SessionView`. When you switch back, `_restoreView()` re-attaches the DOM,
but the components are disposed (event listeners cleaned up, internal state
destroyed). Calling `appendNotification()` on a disposed component is broken.

Remove `this._sessionDisposables.add(comp)` from the render path. Components
are managed by `_groupComponents[]` and disposed by `_resetView()`. Their
lifecycle is tied to the `SessionView`, not to the event binding cycle.

`_sessionDisposables` becomes purely event listeners (store emitters, input
emitters, header emitters) — which is correct. They should be re-bound on
every tab switch.

**2. `SessionView` tracks `renderedCount`**

Add `renderedCount: number` to `SessionView`. In `_saveCurrentView()`, set
it to `this._acpStore.notifications.length`. This records how many
notifications the view had rendered when the tab was switched away.

On restore in `setInput()`, after `_bindEvents()` (which clears
`_sessionDisposables` — now safe because it only has event listeners), call
`_catchUpNotifications(savedView.renderedCount)`. This loops through
`store.notifications` from that index and renders each via the same
`_renderNotification()` path that `_onNotificationAdded()` uses.

For a new session (no savedView), `_catchUpNotifications(0)` renders all
existing notifications (usually none for a new session, but handles the case
where a session was loaded from history).

**Why this didn't break last time**: The earlier attempt had two bugs:
(a) `_sessionDisposables.add(comp)` was still in the render path, so
`_bindEvents()` → `clear()` disposed components created by catch-up; (b)
`_createSessionView()` called `_catchUpNotifications(0)` BEFORE
`_bindEvents()`, so those components were also disposed. With components
removed from `_sessionDisposables`, the ordering issue vanishes —
`_bindEvents()` only clears listeners, not components.

**3. ScrollManager: `scrollTop` direct, no `overflow-anchor`, no guard**

Three sub-changes that are really one thing — stop the scroll mechanism from
having independent state:

- **Replace `scrollIntoView` with `el.scrollTop = el.scrollHeight`**.
  `scrollIntoView` scrolls all ancestors and is intercepted by VS Code's
  parent scroll handlers. `scrollTop` sets the exact element directly.

- **Remove the `_isProgrammaticScroll` guard**. It's a one-shot flag that
  swallows one scroll event. But `overflow-anchor` can fire multiple. The
  guard is unnecessary anyway — `_handleScroll()` already checks if we're
  at the bottom via the threshold. If a programmatic scroll puts us at the
  bottom, the threshold sees `atBottom = true` and doesn't set
  `_userScrolledUp`. If the user then scrolls up, the threshold sees
  `atBottom = false` and sets it. The guard adds nothing but race conditions.

- **Disable `overflow-anchor` in CSS**. Remove `overflow-anchor: auto` from
  `.sc-scroll-sentinel` and `overflow-anchor: none` from `.sc-message-group`.
  The CSS scroll anchoring was supposed to give "free" auto-scroll during
  streaming, but it operates independently of the JS scroll path and the
  `_userScrolledUp` flag. It causes scroll jumps when mermaid SVGs render
  250ms after content. The JS `scrollToBottom()` (via rAF) handles
  auto-scroll correctly and respects user scroll state.

**4. All scroll calls go through `requestAnimationFrame`**

`_onNotificationAdded()` creates the component and calls
`comp.appendNotification()`. For `UserMessage`, this calls
`StreamingMarkdownRenderer.update()` which does `innerHTML = renderMarkdown(text)`
synchronously (the `setTimeout` is only for re-rendering the active tail on
subsequent chunks — the first chunk sets `innerHTML` immediately).

But even synchronous `innerHTML` doesn't guarantee the browser has laid out
the new content when we measure `scrollHeight`. Wrapping the scroll call in
`requestAnimationFrame` ensures the browser has computed layout before we
set `scrollTop`.

This also fixes the send-scroll timing: `sendMessage()` fires the
notification synchronously, `_onNotificationAdded()` runs and renders the
component, then `requestAnimationFrame` fires after layout — the scroll
measures the correct height.

**5. `forceScrollToBottom` on send and tab return**

The editor's `onSendBlocks` handler is missing `forceScrollToBottom()`. The
sidebar has it. Add it to the editor. Also add to `onSendQueuedItemNow` in
both views.

On tab return (`savedView` exists in `setInput()`), after catch-up, call
`forceScrollToBottom()`.

These are not independent fixes — they're the same fix applied at different
points: "reconcile view state with store state using correct timing."

## Why This Won't Regress

- **Components removed from `_sessionDisposables`**: `_resetView()` already
  disposes components from `_groupComponents[]`. No code reads components
  from `_sessionDisposables`. The only effect of removing the `.add(comp)`
  call is that components survive `_sessionDisposables.clear()`.

- **`renderedCount` on SessionView**: Additive field. `_saveCurrentView()`
  already saves all other rendering state. Adding one more number doesn't
  change existing behavior. The catch-up loop uses the exact same
  `_renderNotification()` path — no new rendering logic.

- **`scrollTop` instead of `scrollIntoView`**: Both set scroll position.
  `scrollTop` is more targeted. No behavioral difference except it doesn't
  scroll ancestors.

- **Removing `_isProgrammaticScroll`**: The threshold check in
  `_handleScroll()` is the real guard. Without the flag, a programmatic
  scroll to the bottom triggers `_handleScroll()` which sees `atBottom = true`
  and does nothing. No false `_userScrolledUp`.

- **Removing `overflow-anchor`**: The JS scroll path handles auto-scroll.
  The CSS anchor was redundant and conflicted.

- **`requestAnimationFrame`**: Delays scroll by one frame (~16ms). No visible
  difference. Just ensures layout is computed.

- **`forceScrollToBottom` on send**: The sidebar already does this. Adding
  it to the editor makes behavior consistent.

## Files Changed

| File | Change |
|------|--------|
| `acpChatEditor.ts` | Remove `_sessionDisposables.add(comp)`; add `renderedCount` to SessionView; add `_catchUpNotifications`; rAF scroll; `forceScrollToBottom` on send + tab return |
| `acpChatView.ts` | `forceScrollToBottom` on `onSendQueuedItemNow`; rAF scroll |
| `scrollManager.ts` | `scrollTop` instead of `scrollIntoView`; remove `_isProgrammaticScroll` guard |
| `acpChatView.css` | Remove `overflow-anchor` from sentinel and message groups |
