#set page(width: 8.5in, height: 11in, margin: 1in)
#set text(size: 11pt)

= Extension Loading Fix for Packaged Builds

== Problem

In the packaged .deb build, extension resources (themes, grammars, language configurations) fail to load. This manifests as:
- Crow Purple theme not appearing in the theme picker
- Auto-surround not working for extension-provided languages
- Missing syntax highlighting for some languages

The standalone release binary (`./target/release/Crow`) works because it may fall back to filesystem access for the nearby `dist/extensions/` directory.

== Root Cause

The extension loading pipeline resolves extension file URIs as `https://tauri.localhost/extensions/{name}/...`. These requests go through Tauri's built-in protocol handler, which serves embedded `frontendDist` assets. However, this serving mechanism may fail for deeply nested extension paths.

Meanwhile, the custom `sidex-asset://` protocol handler in `lib.rs` reads from the filesystem only — it has no fallback to Tauri's embedded asset resolver.

== Solution

Route extension resource requests through the `sidex-asset://` protocol handler and add an `AssetResolver` fallback.

=== Changes

+ #text(fill: blue)[\`network.ts — uriToBrowserUri()\`] \
  When in Tauri and the URI is `https://tauri.localhost/extensions/...`, convert to `sidex-asset://localhost/extensions/...`. This routes extension file requests through our custom handler.

+ #text(fill: blue)[\`lib.rs — sidex-asset handler\`] \
  When `std::fs::read()` fails, fall back to `app_handle.asset_resolver().get(path)` which can resolve embedded frontend assets.

+ #text(fill: blue)[\`extensionResourceLoaderService.ts — readExtensionResource()\`] \
  Add `sidex-asset` to the list of schemes that use `fetch()` instead of `_fileService.readFile()`.

== Regression Analysis

- *Dev mode:* Not affected. Extension URIs remain `http://localhost:1420/extensions/...` because the authority is not `tauri.localhost`.
- *Non-extension URIs:* Not affected. The new check only applies to URIs with `extensions/` prefix under `tauri.localhost`.
- *User files via sidex-asset://:* Still work. The filesystem read is tried first; `AssetResolver` is only a fallback.
- *FileAccess.asBrowserUri():* Extension locations are already `https://` — the conversion happens in `uriToBrowserUri()` which is called by `asBrowserUri()`.
