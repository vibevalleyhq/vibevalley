# smith: OAR in Go

`smith` is a Go port of [`@botiverse/oar`](https://github.com/botiverse/oar), modified for VibeValley and
licensed like oar under the Apache License 2.0 ([LICENSE](LICENSE)). It has the same
contracts, the same record stream and the same runtime adapters, so a Go
program can drive coding-agent runtimes without Node.

```go
import (
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/smith/runtimes/defaults"
)

claude, _ := defaults.Registry().Require("claude")
installation, _ := claude.Installation(ctx)
session, err := claude.Session(ctx, installation.Available, oar.SessionOptions{Cwd: dir, Model: "sonnet"})
if err != nil { ... }
defer session.Dispose(context.Background())

session.Events(func(event oar.Event) {
	if text, ok := event.Body.(oar.TextDelta); ok && event.IsRoot() {
		fmt.Print(text.Text)
	}
}, oar.EventsOptions{})
run, _ := observe.PromptAndWait(ctx, session, "Find and fix the flaky test", observe.PromptRunOptions{Timeout: 10 * time.Minute})
```

## Packages

| Package | What it is |
|---|---|
| `oar` | Contract types: records, events, the `Session` and `Runtime` interfaces, options, typed errors |
| `kernel` | The runtime-author SPI: the record stream (`Kernel`) and the sealed API face (`Seal`) |
| `observe` | Folds over the record stream: status, usage, conversation and session view, turn helpers |
| `runtimes/<id>` | The adapters: claude, codex, grok, kimi, opencode, antigravity, pi |
| `runtimes/defaults` | The built-in registry |
| `agents` | Subagents over a runtime registry |
| `oartest` | A scripted runtime with real `Session` semantics, for tests |
| `voyage` | The `oar-voyage/3` JSONL evidence log |
| `bridge`, `cmd/oar-bridge` | JSON-RPC over stdio, for hosts in other languages and for the behavior suite |
| `cmd/oar` | The CLI |

## Differences from the TS package

- **Not ported:**
  - Cursor (it needs the JS `@cursor/sdk`).
  - Pi Durable and the browser entry (both need a JS host).
  - `ModelCatalogFacade` and `ProviderAuthFacade` (they wrap pi's in-process `ModelRuntime`).
- **Pi runs its SDK in a Node host.** The TS package loads pi's SDK in process; smith runs the same SDK, from the pi you installed, in a small embedded Node host (`runtimes/pi/host`). [`GAPS.md`](GAPS.md) lists the two remaining differences.
- **Observers are asynchronous.** Each subscription has its own delivery goroutine. Records arrive in order, one at a time, with no loss or duplication. Cursor replay runs synchronously inside the subscribing call.
- **Waiting helpers.** For code that waits on the stream, use `kernel.Kernel.WaitFor` or the `observe` helpers instead of observer timing.
- **Absent controls.** A control the runtime lacks returns `oar.ErrControlUnsupported`, where the TS member is absent. Check with `CanSteer` / `CanWithdraw` before calling.

## Validation

- **Unit layer:** `go test -race -p 2 ./...`.
  - Several tests race a node fake CLI against the same short deadlines the TS tests use (1–1.5 s). Running every package at once under `-race` can starve them, so limit package parallelism.
- **Behavior layer:** the unchanged TS suite, run against the Go port through `oar-bridge`. Run `OAR_TEST=go-<backend> pnpm sea-trial`. Last results:

  | Backend | Result | Skipped (capability) |
  |---|---|---|
  | `go-scripted` | 19/19 | account usage, effort levels (none listed) |
  | `go-claude-aimock` | 19/19 | none |
  | `go-codex-aimock` | 19/19 | withdraw (codex holds its own queue) |
  | `go-pi-aimock` | 19/19 | account usage |
  | `go-grok-aimock` | 19/19 | account usage, effort levels |
  | `go-opencode-aimock` (opencode 1.19.0 from npm, `OAR_OPENCODE_BIN`) | 19/19 | account usage, effort levels |
  | `go-kimi-aimock` (kimi 2.1.1, `OAR_KIMI_BIN`) | 19/19 | account usage, steer (kimi cannot steer), effort levels |

  - Each Go run shows the same pass/skip set as its TS twin (`<backend>` without `go-`).
  - antigravity installs only from inside an editor. Its Go tests drive the repo's fake ACP agents. morph was checked end to end against a real Console built from source (see GAPS.md).
  - The TS `sealSession` reads the mirrored stream, so the Go folds need a check of their own.
- **Fold parity:** `smith/parity` holds golden outputs of the TS folds over 35 recorded logs (735 fields). `observe/parity_test.go` compares the Go folds with them. Regenerate the goldens with `pnpm tsx smith/parity/generate.ts`.

[`PORTING.md`](PORTING.md) has the porting conventions. [`GAPS.md`](GAPS.md) lists every known difference from TS.
