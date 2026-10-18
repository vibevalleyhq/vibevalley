# smith: OAR in Go

`smith` is a Go port of [`@botiverse/oar`](https://github.com/botiverse/oar), modified for VibeValley and
licensed like oar under the Apache License 2.0 ([LICENSE](server/pkg/smith/LICENSE)). It has the same
contracts, the same record stream and the same runtime adapters, so a Go
program can drive coding-agent runtimes without Node.

```go
import (
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/smith/runtimes/defaults"
)

claude, _ := defaults.Registry().Require("claude")
installation, _ := claude.Installation(ctx, oar.InstallationOptions{})
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
| `community/morph` | The morph runtime: not in the built-in registry; `cli.Runtimes()` registers it |
| `community/dsh` | DeepSeek Harness (`dsh --profile acp`, 0.2.1-rc.2) over the shared ACP layer; no oar port; `cli.Runtimes()` and the VibeValley server register it |
| `brands` | Offline runtime branding, generated from oar's `brands.ts` |
| `agents` | Subagents over a runtime registry |
| `oartest` | A scripted runtime with real `Session` semantics, for tests |
| `voyage` | The `oar-voyage/3` JSONL evidence log |
| `bridge`, `cmd/oar-bridge` | JSON-RPC over stdio, for hosts in other languages and for the behavior suite |
| `cli` | The CLI (`cli.Main`), over the runtimes a host gives it: `cmd/oar` with `cli.Runtimes()`, `vibevalley oar` with the farm's |
| `cmd/oar` | The `oar` command |

## Differences from the TS package

- **Not ported:** Cursor, Pi Durable, the browser entry, `ModelCatalogFacade` and `ProviderAuthFacade`: they need a JS host or pi's in-process `ModelRuntime`.
- **Pi runs its SDK in a Node host.** The TS package loads pi's SDK in process; smith runs the same SDK, from the pi you installed, in a small embedded Node host (`runtimes/pi/host`).
- **Observers are asynchronous.** Each subscription has its own delivery goroutine. Records arrive in order, one at a time, with no loss or duplication. Cursor replay runs synchronously inside the subscribing call.
- **Explicit installation input.** `InstallationOptions.Binary` pins an executable for that probe without changing process environment. `nil` keeps the runtime’s `OAR_*_BIN` default; an explicit empty string uses PATH and fallback candidates. A missing nonempty pin does not fall back. `SpawnOptions.Installation` carries an already accepted installation into the session without probing a different executable; normal runtime and subagent admission checks still apply.
- **Ordered subagent completion.** Go hosts can use `Subagent.Follow(events, reports)` to replay and consume events and completion reports together. Reports wait for the consumer to finish every event in their source record, including trailing usage. Canceling a follower leaves `OnReport`, `Wait`, and other subscribers intact. Only completion anchors are retained in addition to the session’s existing record log.
- **Asynchronous controls.** Runtime adapters can use `Kernel.BeginControl` for reachability checks, request identity, a single response and a cancelable waiter; native reply parsing and fallback policy remain in the adapter.
- **Consumer completion.** `observe.SubscribeEvents` and `SubscribeRecords` own delivery progress. After disposing the source, `Close(ctx)` drains its tail and flushes coalesced text; `Cancel` abandons pending output. `Session.Events` keeps its unsubscribe API and cancels its text timer with the raw subscription.
- **Waiting helpers.** For code that waits on the stream, use `kernel.Kernel.WaitFor` or the `observe` helpers instead of observer timing.
- **Absent controls.** A control the runtime lacks returns `oar.ErrControlUnsupported`, where the TS member is absent. Check with `CanSteer` / `CanWithdraw` before calling.

## Validation

- **Unit layer:** `go test -race -p 2 ./...`.
  - Several tests race a node fake CLI against the same short deadlines the TS tests use (1–1.5 s). Running every package at once under `-race` can starve them, so limit package parallelism.
- **Behavior layer:** the unchanged TS suite, run against the Go port through `oar-bridge`. It runs in an oar checkout with smith at `smith/`: `OAR_TEST=go-<backend> pnpm sea-trial`. Last results:

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
- **Fold parity:** `parity/golden` holds golden outputs of the TS folds over 35 recorded logs (735 fields). `observe/parity_test.go` compares the Go folds with them. Regenerate the goldens in an oar checkout with smith at `smith/`: `pnpm tsx smith/parity/generate.ts`.

[`PORTING.md`](server/pkg/smith/PORTING.md) has the porting conventions. [`GAPS.md`](server/pkg/smith/GAPS.md) lists every known difference from TS, and what is not ported.
