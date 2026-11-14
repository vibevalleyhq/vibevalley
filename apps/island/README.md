# apps/island

The island at the notch: a native macOS helper (Swift, AppKit, SwiftUI) that shows the issues in flight beside the
camera and opens one on a click. It is a program of its own: whatever starts it writes glances to its stdin and reads
the issue to open from its stdout. The native app (`apps/mac`) does not start it ([the client](docs/subsystems/app.md)).

```
Sources/IslandCore/Messages.swift   the lines the app and the island exchange: {"glance": …} in, {"open": "<issue>"} out
Sources/IslandCore/Geometry.swift   where the island goes: out of the notch, or a tab from the menu bar without one
Sources/VibeValleyIsland/main.swift an accessory app (no Dock icon) reading its stdin; it quits when stdin closes
Sources/VibeValleyIsland/Island.swift the panel, the hover that opens it, the rows, the pixel font
Tests/IslandCoreTests/              the messages and the placement (Swift Testing)
```

```bash
vp run --filter @vibevalley/island test           # swift test; macOS only, run on the owner's Mac (CI does not run the island)
swift build -c release --package-path apps/island # builds .build/release/VibeValleyIsland
```

To see how it looks without an app feeding it or screen recording, give it a glance and `--snapshot`: it draws the island
closed and open into that folder (it must exist) (`closed.png`, `open.png`) and writes where the panel would go (`frames.txt`).

```bash
mkdir -p /tmp/island && echo '{"glance":{"working":1,"waiting":1,"rows":[{"issue":"i1","number":41,"title":"修登录页","doing":"等你验收","tone":"waiting"}]}}' |
  apps/island/.build/release/VibeValleyIsland --font assets/fonts/fusion-pixel-12px-proportional-zh_hans.otf --snapshot /tmp/island
```
