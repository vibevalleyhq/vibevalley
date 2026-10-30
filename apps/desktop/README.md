# apps/desktop

The desktop app: Electron starts the server (`apps/server`) on its own Node and opens the page it serves. The page
reaches the machine only through the host interface (`@vibevalley/protocol/host`), which the preload gives it. How it starts, quits and is packaged:
[the client](docs/subsystems/app.md).

```
src/main.ts        one instance, then each part below started in turn; quitting waits for the server to save
src/paths.ts       where the server, the page, the island, the logs and the updates are, in the repository or packaged
src/window.ts      the one window: the bar, the page, the server's origin only, 3 : 2, brought to the front
src/host.ts        main's end of the page's host (desktopBridge): notices, the tray, theme, language, Finder
src/tray.ts        the menu bar's summary
src/menu.ts        the application menu, in the farm's language
src/server.ts      the server as a child: the login shell's PATH, the ready line, SIGTERM then SIGKILL, and its keeper
src/dev.ts         development: the page reloads, the server starts again when no helper is working
src/preload.ts     the host interface, through contextBridge
src/bridge.ts      the bridge's one IPC channel and its two ends
src/chrome.ts      the title strip, the window's buttons and its ground, shared by main and the preload
src/lines.ts       a child's JSON lines, read by a Schema
src/island.ts      the island at the notch (apps/island): the state stream read here, the glance it is sent, a click back
src/probe.ts       what the desktop test reads, only when it starts the app
scripts/build.ts   build/main.cjs and build/preload.cjs; on macOS the island's release build too
scripts/package.ts the macOS .app and .dmg in dist/: the shell, the page, the island, and the server with its production dependencies
resources/         the app icon
test/              Playwright starting the whole app with temporary home and Electron user-data directories
```

The desktop test passes Electron's `--user-data-dir` before the app starts. Its single-instance lock, browser storage
and farm files belong to the temporary directories, so the owner's desktop app can stay open during the test.

```bash
vp run dev        # from the repository root: vp run desktop:dev; builds the page, rebuilds it on change (the window reloads) and restarts the server when its code changes
vp run test       # the main process's rules (src/*.test.ts), also in vp run web:check
vp run e2e        # from the root: vp run desktop:test; builds the page first (dependsOn), then Playwright on the whole app
vp run package    # from the root: vp run package:mac
```
