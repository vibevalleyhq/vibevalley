# Known gaps between smith and the TS package

Every entry names what differs, why, and what it costs a host. TS paths and the `pnpm` commands are oar's: they run in an oar checkout with smith at `smith/`.

## Not ported

- **Cursor.** The runtime is the JS `@cursor/sdk`; there is no Go SDK.
- **Pi Durable**, the `browser` entry and `ModelCatalogFacade` / `ProviderAuthFacade`. They are JS-hosted, or wrap pi's in-process `ModelRuntime`.

## Behavior differences

- **No host-exit backstop.** TS kills every owned process group from a `process.on("exit")` hook. Go has no exit hook. A host calls `executable.KillOwned()` and `shared.RemovePrivateTempDirs()` on its shutdown path. `cli.Main` and `cmd/oar-bridge` do.
- **`McpServer.Env` values are strings.** A JSON `null` in an MCP server's env decodes to `""` through the bridge. TS refuses it at open.
- **Errors are strings.** Diagnostics travel in error messages, not as structured `cause` objects.

## pi runs its SDK in a Node host

The TS package embeds pi's SDK in its own process. smith runs that same SDK in a small Node host, `runtimes/pi/host/pi-host.mjs`, embedded in the Go binary. It loads the SDK of the `pi` you installed (`OAR_PI_BIN`, or `OAR_PI_SDK_DIR` for the package; `OAR_PI_NODE` picks the Node). pi is a Node program, so this adds no runtime. The host opens sessions the way TS `open.ts` does: project trust, pi's MCP extension with no `mcp.json` of its own, credential capture, the env-carrying bash tool, model and effort readback, naming, and the 10 s extension-shutdown deadline. Model listing and inventories run the same SDK paths.

What still differs:

- **Installation.** pi is found as an executable (`via: "executable"` with a version), and the session has `Resources()` (the host process). A `bundled` installation handed in by a TS-style host is accepted and resolved to the installed pi.
- **The dispose answer.** The record is the host's `exited`, where TS (no process of its own) answers `accepted`.

## CLI

- **`--max-running 0` and `--max-depth 0`.** `agents.Options` reads 0 as the default (4 and 1), so an explicit 0 cannot be expressed.
- **Blind input.** `oar login` hides a pasted code with `stty -echo` on a terminal, where TS mutes readline's echo.

## Community: morph

- Ported in `community/morph`, including a minimal RFC 6455 client for `/stream/ws`. It is not in the built-in registry, as in TS. `cli.Runtimes()` registers it, as the TS CLI does.
- **Stale TS test.** `tests/community/morph/morph-projection.test.ts` "turn outcomes" expects `quota` for "…429 rate limit", but TS's `classifyFailure` answers `rate_limited`. That test fails on TS too (`OAR_COMMUNITY_TESTS=1`). The Go test asserts TS's actual behavior.
- No real morph is installed here. The Go tests run against a scripted Console on a loopback server.

## ACP runtimes: grok, kimi, opencode, antigravity

- **Reset instants.** grok's billing period end and kimi's `resetTime` parse as RFC 3339 (or a date-time without zone, read as UTC). TS takes whatever `new Date()` reads, a zone-less time as local time. A value Go cannot parse leaves the window without `resetsAt`.
- **Numeric strings.** kimi's quota numbers given as strings parse as decimal floats. JS `Number()` forms such as `0x10` are not numbers here.
- **Empty menus and lists.** `oar.ModelEntry.EffortLevels` and `oar.ListModelsResult.Models` are `omitempty`: a grok model whose effort menu is `[]`, or a listing with no models, has no key where TS has `[]`.
- **OpenCode prompt overlay.** `OPENCODE_CONFIG_CONTENT` is Go-encoded JSON: U+2028 and U+2029 in prompt text are `\u` escapes where `JSON.stringify` writes them raw. opencode parses the same string.
- **Not ported tests.** The TS tests that mock `startAcpProcess` or `fetch` run against a real scripted agent (`runtimes/testdata/scripted-acp-agent.mjs`) or a replaced HTTP transport. Two TS assertions have no Go reading: the exact budget each grok usage request was handed (the Go test proves it by a request that misses the remainder), and the order in which kimi's `/usages` and `/me` requests start (Go starts them concurrently; the test checks both are sent).

## codex

The behavior suite passes on both: `go-codex-aimock` and `codex-aimock` are 19/19 clean. The Go run skips only `withdraw-before-dispatch`. The TS `codex-aimock` backend also skips `account-usage.snapshot` and `effort-listed-levels-apply-across-resume`, because it declares only the session and the installation; the bridge serves the whole runtime, and both cases pass.

- **Spawn failure wording.** Go spawns synchronously. A codex that cannot start fails the open with `app-server exited: exit code unavailable; signal none; spawn <command>: <Go's error>`. TS says Node's `ENOENT: spawn <command> ENOENT` and carries the diagnostics as a structured `cause`.
- **Structured causes.** An open error codex answered keeps its method and redacted native error inside the package (and on `SessionNotFoundError` / `SessionUnavailableError` as `Method` / `Native`). A plain open error carries only its text, as "Errors are strings" says. Once a session credential appears in its text, the redactor turns it into a plain error.
- **Home identity.** The first-initialization gate tells a replaced `CODEX_HOME` by device and inode (creation time on Windows). TS adds the birth time, which Go's `os.Stat` does not portably expose. A home deleted and recreated with a reused inode counts as initialized.
- **Failed initialize.** When `initialize` fails on an app-server that does not own its home's first initialization, smith kills it. TS leaves it running until the host exits; Go has no exit hook.
- **Empty service tiers.** `oar.ModelEntry.ServiceTiers` is `omitempty`: a model whose `serviceTiers` is `[]` has no key where TS has `[]` (as "Empty menus and lists" says for effort levels). The projection keeps the empty list.
- **Not ported tests.** abort-takeover's "late reply after exit" variant: `executable.LineProcess` reports the exit after the last stdout line, so no reply can follow it. The host-stderr spy of "the app-server's stderr reaches neither the host's stderr nor the result" (the result half is ported). The structured-`cause` assertions on plain open errors (see above). The fake-timer tests run on shortened package timeouts (`abortFallbackTimeout`, `settingsReportTimeout`) instead.

## Verified against real installs

- **Real vendor binary, scripted model provider:** claude 2.1.296, codex 0.162.0, grok 1.0.34, opencode 1.19.0, kimi 2.1.1 and pi 1.1.0. Each passes the behavior suite through the Go port (`go-<id>-aimock`) with the same pass/skip set as the TS adapter.
- **kimi:** installed with its official installer.
- **opencode:** from npm into a scratch prefix. Point the backend at the binary with `OAR_OPENCODE_BIN` / `OAR_KIMI_BIN`.
- **morph v0.3.52:** built from source. `oar run morph` started a real Console against a scripted OpenAI-compatible provider, then ran a turn end to end: topic, task, live `/stream/ws` snapshots, `turn completed`, release and exit. morph has no sea-trial backend in TS, so it has no suite run.
- **antigravity:** installs only from inside an editor (`requires_gui`), so it is tested against the repo's fake ACP agents only.

## Vendor tests (sea-trial/vendor) on the Go port

Run them with `OAR_TEST=go-<id>-aimock CI=1 pnpm vitest run -c smith/vendor/vitest.config.ts`. The unchanged tests import the package entry, and `smith/vendor/oar-go.ts` swaps in the Go runtimes over oar-bridge.

| Runtime | Passed / applicable |
|---|---|
| claude | 44 / 44 |
| codex | 43 / 43 |
| grok | 12 / 12 |
| opencode | 8 / 8 |
| kimi | 7 / 7 |
| pi | 36 / 37 |

- **Not run:**
  - `abort-fallback` mocks TS internals (`vi.mock` of the TS process plumbing), which cannot reach a Go process. The Go claude and codex packages test that path themselves.
  - The pi-durable tests: Pi Durable is not ported.
- **Run as a copy:** `stuck-runtime-tools` runs as `smith/vendor/stuck-runtime-tools.go.test.ts`. The only change is that the runtime is found below oar-bridge, not below the test process.
- **pi:** the one test not passing is `pi-extension-shutdown`. It spies on `AgentSession.prototype.dispose` and `process.emitWarning` inside the test process, which a separate host process cannot trigger. Its timing assertion (the dispose waits out the 10 s deadline) passes.
