# apps/desktop

The desktop app: Electron starts the server (`apps/server`) on its own Node and opens the page it serves. The page
reaches the machine only through the host interface (`@vibevalley/protocol/host`), which the preload gives it. How it starts, quits and is packaged:
[the client](docs/subsystems/app.md).

```
src/main.ts                one instance, then each part below started in turn; quitting waits for the server to save
src/base/                  pure rules: boundary.ts (the window's sandbox and title bar, the page's ground in either theme),
                           channel.ts (stable, beta, alpha or dev, and the home that goes with it), devPage.ts (the dev
                           server's port), lines.ts (a child's JSON lines, read by a schema), releases.ts (version order)
src/infra/server.ts        the server as a child: the login shell's PATH (the last one kept, asked again behind), the ready line, SIGTERM then SIGKILL, and its keeper
src/infra/paths.ts         where the server, the page, the island, the logs and the updates are, in the repository or packaged
src/infra/update.ts        the app updating itself from GitHub Releases, by channel
src/infra/island.ts        the island at the notch (apps/island): the state stream read here, the glance it is sent, a click back
src/infra/control.ts       the socket in the farm's home that `vibevalley app` talks to
src/infra/commandLine.ts   installing the `vibevalley` command into ~/.local/bin
src/infra/machine.ts       which running channel holds the Mac's shared things (the island, the shortcuts)
src/infra/workspace.ts     the workspace packages the server needs, for packaging
src/infra/probe.ts         what the desktop test reads, only when it starts the app
src/ui/window.ts           the one window: the bar, the page, the server's origin only, 3 : 2, brought to the front
src/ui/host.ts             main's end of the page's host (desktopBridge): notices, the tray, theme, language, Finder
src/ui/menu.ts             the application menu and the menu bar's summary, in the farm's language
src/ui/dev.ts              development: the server starts again when no helper is working (the page updates itself, from Vite)
src/preload/preload.ts     the host interface, through contextBridge
scripts/build.ts           build/main.cjs and build/preload.cjs; on macOS the island's release build too
scripts/dev.ts             vp run dev: builds the shell and the page, starts Vite, the server and Electron
scripts/package.ts         the macOS .app and .dmg in dist/: the shell, the page, the island, and the server with its production dependencies
scripts/update-check.ts    an update walked through on two real packages
resources/                 the app icon
test/                      Playwright starting the whole app with temporary home and Electron user-data directories
```

The desktop test passes Electron's `--user-data-dir` before the app starts. Its single-instance lock, browser storage
and farm files belong to the temporary directories, so the owner's desktop app can stay open during the test.

Development builds the page once (the window's opening cover is `dist/opening.html`), then starts Vite's dev server on
127.0.0.1 and Electron. The window loads Vite's page, whose changes arrive by hot module replacement; Vite sends `/api`
to the server on a port `scripts/dev.ts` chose first, which stays the same across the server's restarts
(`src/base/devPage.ts`). The page runs Solid's development build there, not the production one.

```bash
vp run dev        # from the repository root: vp run desktop:dev; the page from Vite with hot updates, and the server restarted when its code changes
vp run test       # the main process's rules (src/*.test.ts), also in vp run web:check
vp run e2e        # from the root: vp run desktop:test; builds the page first (dependsOn), then Playwright on the whole app
vp run package    # from the root: vp run package:mac
```
