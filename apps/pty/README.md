# apps/pty

Native macOS pseudo-terminal helper (`Swift 6` + `Darwin forkpty`) started by the desktop app (`apps/desktop/src/infra/terminal.ts`) to host workbench shells in repository and issue worktree folders without coupling Node and Electron native module ABIs; see [the client](docs/subsystems/app.md).

```
Sources/CPty/                      Darwin forkpty, TIOCSWINSZ resize, and foreground process cwd/argv inspection
Sources/PtyCore/Messages.swift     JSON-lines protocol between the desktop app and VibeValleyPty
Sources/PtyCore/PtyManager.swift   multiplexed PTY session lifecycle, base64 byte framing, and process-group teardown
Sources/VibeValleyPty/main.swift   reads requests from stdin, writes events on stdout, and stops all sessions when stdin closes
Tests/PtyCoreTests/                message codec, shell I/O, UTF-8, resize, cwd inspection, and teardown tests
```

```bash
vp run --filter @vibevalley/pty test             # swift test; macOS only
vp run --filter @vibevalley/pty build            # swift build -c release
```
