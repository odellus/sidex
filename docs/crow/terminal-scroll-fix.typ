= Terminal Scroll Wheel Fix

== Problem Statement
The scroll wheel on the mouse does not work in the integrated terminal of the Crow/SideX editor. When users attempt to scroll through terminal history or output using the mouse wheel, nothing happens.

== Root Cause Analysis

=== CRITICAL FINDING: Known Tauri/Wayland Bug

The user is running on Wayland (confirmed: #code["XDG_SESSION_TYPE=wayland"]). There is a #strong[known Tauri bug] (#link("https://github.com/tauri-apps/tauri/issues/14427")[Issue #14427]) where mouse wheel scrolling does not work on Wayland or WSL.

The bug report states:
#quote[When running my app on Wayland or through WSL, scrollbars appear, but scrolling with the mouse wheel does not work at all. Scrolling with the bar or arrow keys works, but is very jumpy / laggy.]

This affects Tauri v2.9.3 and later, including the current version (v2.10.3). The bug is in WebKit2GTK's handling of wheel events on Wayland.

=== Current Implementation

The terminal uses xterm.js with the following configuration:

+ #code["scrollback: config.scrollback"] — Controls how many lines are kept in buffer (default: 1000)
+ #code["scrollSensitivity: config.mouseWheelScrollSensitivity"] — Multiplier for wheel deltaY (default: 1)
+ #code["smoothScrolling"] — Animation duration for smooth scrolling (default: false/0ms)
+ #code["fastScrollSensitivity"] — Multiplier when Alt is pressed (default: 5)

The xterm.js instance is created in #code["xtermTerminal.ts"] with these options, and wheel events are tracked via a listener on the xterm element to classify whether the input is from a physical mouse wheel or trackpad.

=== Potential Issues Identified

#strong[1. Tauri/WebKit2GTK Wheel Event Bug on Wayland (CONFIRMED ROOT CAUSE)]
Tauri v2 uses WebKit2GTK on Linux. There is a confirmed bug (#link("https://github.com/tauri-apps/tauri/issues/14427")[#14427]) where wheel events are not delivered to web content on Wayland. The user is confirmed to be running on Wayland.

#strong[2. CSS pointer-events Blocking]
The CSS files contain multiple #code["pointer-events: none"] declarations on overlay elements (overview ruler, accessibility tree, invisible scrollbar). These are intentional and shouldn't affect the main viewport, but they were investigated as a potential cause.

#strong[3. Smooth Scrolling Logic]
The #code["_updateSmoothScrolling()"] method sets #code["smoothScrollDuration"] based on whether a physical mouse wheel is detected. If the classifier never receives wheel events (due to the Wayland bug), it would never activate smooth scrolling — but this is a symptom, not a cause.

=== Investigation Findings

Examining #code["xtermTerminal.ts"] line 604-620:
```typescript
ad.add(
  dom.addDisposableListener(
    this.raw.element,
    dom.EventType.MOUSE_WHEEL,
    (e: IMouseWheelEvent) => {
      const classifier = MouseWheelClassifier.INSTANCE;
      classifier.acceptStandardWheelEvent(new StandardWheelEvent(e));
      const value = classifier.isPhysicalMouseWheel();
      if (value !== this._isPhysicalMouseWheel) {
        this._isPhysicalMouseWheel = value;
        this._updateSmoothScrolling();
      }
    },
    { passive: true }
  )
);
```

This listener is attached to #code["this.raw.element"] (the xterm container) and is marked as #code["{ passive: true }"], which means it should not prevent default behavior. The listener only tracks the wheel event type but doesn't handle the actual scrolling — that's done by xterm.js internally.

The xterm.js library itself should be handling wheel events on the viewport element. If scrolling doesn't work, it suggests:
1. Wheel events are not reaching the xterm viewport element
2. The xterm.js scroll handler is not being triggered
3. There's a platform-specific issue with WebKit2GTK

== Proposed Solution

=== Immediate Fix: Add Explicit Wheel Event Handler (Wayland Workaround)

Since this is a known Tauri/WebKit2GTK bug on Wayland, the workaround is to add an explicit JavaScript wheel event handler that manually triggers xterm.js scroll methods, bypassing the broken native wheel event handling.

#strong[File to modify:] #code["src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts"]

#strong[Changes:]
1. In the #code["attachToElement()"] method, after the existing wheel listener is added (around line 620), add another listener on the xterm element
2. This listener will manually call #code["this.raw.scrollLines()"] based on the wheel deltaY
3. Use #code["{ passive: false }"] and call #code["e.preventDefault()"] to ensure the event is handled
4. Respect the #code["mouseWheelScrollSensitivity"] and #code["fastScrollSensitivity"] configuration

```typescript
// Add after line 620 in attachToElement()
// Workaround for Tauri/Wayland wheel event bug (https://github.com/tauri-apps/tauri/issues/14427)
ad.add(
  dom.addDisposableListener(
    this.raw.element,
    dom.EventType.MOUSE_WHEEL,
    (e: IMouseWheelEvent) => {
      const config = this._terminalConfigurationService.config;
      const sensitivity = e.altKey 
        ? config.fastScrollSensitivity 
        : config.mouseWheelScrollSensitivity;
      const lines = Math.round(e.deltaY * sensitivity / 10);
      if (lines !== 0) {
        this.raw.scrollLines(lines);
      }
      e.preventDefault();
    },
    { passive: false }
  )
);
```

=== Why This Won't Create Regressions

1. #strong[Platform-specific workaround] — This fix specifically addresses the Tauri/Wayland bug. On X11 or other platforms where wheel events work correctly, this handler will still fire but xterm.js will handle the scroll correctly regardless.

2. #strong[Existing functionality preserved] — The existing wheel listener for mouse classification remains unchanged. It continues to track whether input is from a physical mouse or trackpad for smooth scrolling logic.

3. #strong[Configuration respected] — The handler uses the same #code["mouseWheelScrollSensitivity"] and #code["fastScrollSensitivity"] config values that xterm.js uses, so user settings are honored.

4. #strong[Alt key support] — The handler checks for #code["e.altKey"] to apply fast scroll sensitivity when Alt is held, matching the expected behavior.

5. #strong[No side effects on other components] — The listener is scoped to the specific xterm element and is disposed when the terminal is disposed.

=== Long-term Solution

The proper fix is to wait for Tauri/WebKit2GTK to resolve the Wayland wheel event bug. Once fixed upstream, this workaround can be removed or made conditional on the platform.

=== Important Note

If the JavaScript workaround does not fire (because wheel events are not delivered to the webview at all on Wayland), a more complex solution would be required:
1. Intercept wheel events at the Tauri/Rust level using native GTK event handlers
2. Forward them to the frontend via Tauri's event system
3. Handle them in JavaScript to trigger xterm.js scrolling

This would require modifying #code["src-tauri/src/"] to add wheel event interception. However, the JavaScript workaround should be tested first as it's simpler and may be sufficient if wheel events are delivered but the default scroll action is broken.

=== Alternative Workarounds

If the JavaScript workaround is insufficient, users can:
1. Run Crow with #code["GDK_BACKEND=x11"] environment variable (forces X11 instead of Wayland)
2. Use keyboard shortcuts (Shift+PageUp/PageDown) for scrolling
3. Use the scrollbar directly (though this may be jumpy per the bug report)

== Testing Plan

1. Open the integrated terminal in Crow
2. Generate enough output to require scrolling (e.g., #code["ls -la /usr/bin | head -100"])
3. Use mouse wheel to scroll up and down
4. Verify scroll speed matches #code["terminal.integrated.mouseWheelScrollSensitivity"] setting
5. Test with Alt key held for fast scrolling
6. Test on trackpad vs physical mouse to ensure both work

== Files Involved

+ #code["src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts"] — Main xterm wrapper, where fix should be applied
+ #code["src/vs/workbench/contrib/terminal/browser/terminalInstance.ts"] — Terminal instance management
+ #code["src/vs/workbench/contrib/terminal/browser/tauriTerminalBackend.ts"] — Tauri PTY backend (no changes needed)
+ #code["src/vs/workbench/contrib/terminal/browser/media/terminal.css"] — Terminal styles (no changes needed)
+ #code["src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts"] — Configuration defaults (no changes needed)
