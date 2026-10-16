# Porting OAR to Go: conventions

`smith/` is the Go port of `packages/oar` (baseline: v0.59.1, branch
`smith-go-port`). Every port follows these rules. Read this file before you
touch a package, and follow it before your own preferences.

## Layout

| TS (`packages/oar/src`) | Go (`smith/`) |
|---|---|
| `contracts/*` | `oar` (types only; no I/O) |
| `shared/session-kernel.ts`, `seal-session.ts`, `deliver.ts`, `input-images.ts`, `held-input.ts`, credential redactor | `kernel` |
| `observe/*` | `observe` |
| `shared/executable/*` | `internal/executable` |
| `shared/json.ts` | `internal/jsonx` |
| other `shared/*` | `internal/shared` (one package; one Go file per TS file) |
| `shared/acp/*` | `internal/acp` |
| `runtimes/<id>/*` | `runtimes/<id>` (package `<id>`), one Go file per TS file where practical |
| `community/morph` | `community/morph` |
| `agents/*` | `agents` |
| `testing/*` | `oartest` |
| `voyage.ts` | `voyage` |
| `registry.ts` + `index.ts` defaults | `oar.RuntimeRegistry` + `runtimes/defaults` |
| `packages/cli` | `cmd/oar` |

Not ported: Cursor, which needs the JS `@cursor/sdk`. Pi Durable and the
`browser` entry are JS-hosted. `ModelCatalogFacade` and `ProviderAuthFacade`
wrap pi's in-process `ModelRuntime`. The Go pi runtime drives `pi --mode rpc`
instead of the in-process SDK.

## Semantics come from the TS source

- The TS file is the spec. Port its behavior, comments that state invariants,
  and edge cases. Do not redesign. Where Go forces a change, say so in a
  comment that names the TS file.
- Keep the doc comments that carry contract invariants. Shorten the prose;
  never drop a "must" or "never".
- Native wire handling stays native. Parse runtime frames into
  `map[string]any` (`internal/jsonx` helpers). A frame's `Native` is the raw
  line bytes (`json.RawMessage(line)`) when the whole message is the frame.
  Otherwise use `jsonx.Marshal(value)`.

- Where TS `JSON.stringify`s a native sub-value into a string (a tool
  input, a progress preview), take it from the raw bytes with
  `jsonx.RawFields` + `jsonx.Stringify`. Re-marshalling a decoded map would
  sort its keys, and JS keeps their insertion order.

## Types and unions

- A TS discriminated union is either a Go interface with one struct per kind
  (`oar.EventBody`, matched with a type switch) or a flat struct with a `Kind`
  field and custom JSON. Use what `oar` already does for that type. Never
  invent a second representation.
- Optional fields: `string` with `omitempty` when "" cannot be a real value.
  Use `*string`, `*bool` or `*int64` when "" / false / 0 is meaningful. Use
  `*oar.NullInt` for absent, null or number. Use `json.RawMessage` for
  verbatim JSON (absent = nil).
- JSON output must match the TS shapes field for field (key names, `[]` not
  `null` for arrays the TS always has). Order does not matter.

## Concurrency: one lock per session, the JS event loop made explicit

JS code runs to completion between `await`s, and adapters rely on that. In Go:

1. Each adapter session has one `sync.Mutex` (`s.mu`) guarding all adapter
   state. Code that would run as one JS "tick" runs with `s.mu` held: a line
   handler, an exit handler, a timer callback, a control decision.
2. Release `s.mu` around every blocking wait (an RPC reply, a process exit,
   `kernel.WaitFor`, a sleep), the same places the TS code `await`s. After
   reacquiring it, re-check state the way the TS code does after its `await`.
   Never hold `s.mu` while waiting for something that needs `s.mu`. The line
   reader goroutine takes `s.mu`, so an RPC answer read by it can never
   arrive while you hold it.
3. The kernel lock is a leaf. Call `kernel.*` freely with `s.mu` held. The
   kernel never calls back into the adapter while holding its lock.
4. Observers run on per-subscription delivery goroutines and are never awaited.
   Adapter internals that wait for a record (claude's abort waiting for its
   `control_response`) use `kernel.WaitFor(ctx, fromIndex, match)`, never an
   observer plus a channel. Read `fromIndex := k.Len()` under `s.mu` before
   the action that produces the record.
5. Timers (`time.AfterFunc`) take `s.mu` first. Once the session is disposed
   they do nothing.
6. `Dispose` always settles. It kills the whole process tree
   (`executable.LineProcess.Kill`, with `KillTree` where TS uses it) even when
   its ctx is cancelled. It waits for `<-p.Exited()` with the lock released.
7. `internal/executable.LineProcess` delivers lines one at a time on one
   goroutine. It delivers the exit after the last line. Handlers take `s.mu`
   themselves.
8. Every package must pass `go test -race`.

## Errors

- Control methods (`Prompt`, `Steer`, `Queue`, `Withdraw`, `Abort`) answer
  refusals as rejected responses through `kernel.Control`, never as Go
  errors. A Go error from a control means the adapter could not deliver
  (TS: a thrown transport error). `kernel.Control` already turns a decide
  error into `rejected/error`.
- Open errors: return `*oar.UnsupportedOptionError`, `*oar.SessionNotFoundError`,
  `*oar.SessionUnavailableError` or `*oar.RuntimeFailureError` exactly where
  TS throws them. Other open failures are plain errors whose text matches
  the TS message.
- Every runtime's `Session` is wrapped in `kernel.WithSessionCredentials` and
  builds its kernel with `credentials.Kernel(id)`, as TS does.
- Check `Runtime.RefusedSessionOptions` with `shared.RefuseSessionOptions(...)`
  and `shared.CheckSessionName(options)` (internal/shared) at open, where TS
  does. Their messages match TS.

## Options and environment

- `oar.SessionOptions.Env` is `map[string]*string`, where nil removes a variable. Build a
  child environment with `internal/shared.Environment` (the port of
  `shared/environment.ts`).
- Durations: TS `timeoutMs` becomes `time.Duration` options (`Timeout`); 0 means
  the reader's own default.

## Tests: done means tested

- Port the unit tests in `tests/<area>` and `tests/<runtime>/` that cover the
  code you ported, as Go table tests next to the code. Reuse `tests/fixtures`
  through relative paths (`../../../tests/fixtures/...`). The `.mjs` fake agents
  need `node` on PATH, which is fine.
- A runtime is done when all of these hold:
  - `go vet ./... && go test -race ./...` is green.
  - `OAR_TEST=go-<id>-aimock pnpm sea-trial` passes. For ACP runtimes without
    an aimock backend, a Go test drives the `fake-acp-*.mjs` fixtures.
  - The runtime is registered in `smith/bridge/builtins.go` and
    `runtimes/defaults`.
- Never weaken an assertion to get past a failure. If the TS test asserts it,
  the Go port must satisfy it, or the gap must be written down in
  `smith/GAPS.md` with the reason.

## Ownership while ports run in parallel

Each porting task owns its directories. Do not edit `oar`, `kernel`,
`observe` (except files you were told you own), `internal/executable`,
`internal/jsonx`, `bridge/bridge.go`, or another task's directories. If you
need a change there, stop and report it with the exact change you need. Do
not work around a core gap with a private copy.
