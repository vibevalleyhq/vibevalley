# apps/desktop

The desktop app: Electron starts the server (`apps/server`) on its own Node and opens the page it serves. The page
reaches the machine only through `@vibevalley/host`, which the preload gives it. How it starts, quits and is packaged:
[the client](docs/subsystems/app.md).

```
src/main.ts        the window, the tray, notices, the voice shortcut, one instance, quitting
src/server.ts      the server as a child: the login shell's PATH, the ready line, SIGTERM then SIGKILL
src/preload.ts     the host interface, through contextBridge
scripts/build.ts   build/main.cjs and build/preload.cjs
scripts/package.ts the macOS .app and .dmg in dist/: the shell, the page, and the server with its production dependencies
resources/         the app icon
test/              Playwright starting the whole app with a temporary home
```

```bash
bun run dev       # from the repository root: bun run desktop:dev (build the page first)
bun run test      # bun run desktop:test
bun run package   # bun run package:mac
```
