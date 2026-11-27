# apps/shim

Standalone macOS App Shim for VibeValley local note applets: a thin native AppKit process (`VibeValleyShim`) that
gives an installed note its own Dock icon, `Cmd+Tab` identity, menu bar, and window while delegating rendering and
CRDT state to the single running VibeValley host process over `$VIBEVALLEY_HOME/applet.sock`.

```text
Sources/ShimCore/Protocol.swift     NDJSON wire protocol (ShimToHost / HostToShim) matching apps/mac/src/applet/mod.rs
Sources/ShimCore/Config.swift       Bundle Info.plist (VV* keys) + CLI flag + channel home/socket resolution
Sources/ShimCore/Geometry.swift       AppKit-to-GPUI coordinate flip and keystroke name mapping
Sources/VibeValleyShim/main.swift   NSApplication (.regular), native menu bar, and lifecycle delegate
Sources/VibeValleyShim/SocketClient.swift  Unix socket NDJSON client, silent host --background wake, and backoff reconnect
Sources/VibeValleyShim/ShimWindow.swift    NSWindow hosting CALayerHost (readyLayer), sandboxed WKWebView, and status view
Tests/ShimCoreTests/                Wire protocol roundtrips, BundleConfig resolution, and coordinate/key helpers
```

## Protocol

Messages are newline-delimited JSON (`type`-tagged camelCase objects) exchanged over a Unix domain stream socket at
`<serverHome>/applet.sock`:

- **Shim -> Host (`ShimToHost`)**: `attach`, `resize`, `mouseDown`, `mouseUp`, `mouseMove`, `mouseExit`, `scroll`,
  `keyDown`, `keyUp`, `modifiersChanged`, `focus`, `openInHost`, `detach`.
- **Host -> Shim (`HostToShim`)**: `readyLayer`, `readyWebview`, `updateWebview`, `setTitle`, `setAlwaysOnTop`, `error`,
  `closing`.

## Commands

```bash
swift test --package-path apps/shim
swift build -c release --package-path apps/shim
vp run --filter @vibevalley/shim test
```
