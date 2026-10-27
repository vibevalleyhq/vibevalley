# apps/server

The farm's server: every service, the HTTP API, the three state streams, `/mcp` for the helpers, and the page at `/`.
Effect v4 on Node 24, run from source with tsx (`vp run start`); the database is PGlite. How it is built and why:
[foundation](docs/subsystems/foundation.md); what each service does: [the subsystems](docs/subsystems/README.md).

```
src/main.ts        the server: loads the configuration, takes the home's lease, serves; --ready-json, --web
src/cli.ts         the command line: every endpoint, state and events, issue run, chatting with a runtime or the farm's own agent
src/services.ts    every service in build order, then what runs at start
src/handlers.ts    each endpoint handed to the service that owns it
src/http/          the router over the endpoint table, the streams, /mcp and /v1/chat/completions, the page
src/base/          configuration, database, ids, the home's lease, files, redaction
src/<module>/      one service each: core setting agent project memory doc runtime session channel recurrence issue task tool mcp orchestrator lan voice connector game
src/flows/         tests that go through several services: a whole farm and a helper that works by the words of its job
src/testing/       test layers: a temporary home, an in-memory database, a whole farm, git repositories, golden data
db/                migrations/0001_schema.up.sql (the one schema), queries/<table>.sql, generated/ (effect-sqlc)
```

## Rules

- **One service a module**, `Context.Service` with a `make` and a `layer`; a module uses only those before it in
  `services.ts`, and hears later ones through streams.
- **Shapes and the endpoint table are `@vibevalley/protocol`'s**; `handlers.ts` fails to compile when it misses one.
- **SQL only in `db/queries`**, one file a table, called through `db/generated`; `src/base/schema.test.ts` holds the
  names and the one baseline.
- **Effects started from callback code run on the service's own runtime**: `FiberSet.makeRuntime` /
  `makeRuntimePromise` in `make`, not `Effect.runFork` / `runPromise`, so they end with the service and keep its
  services; a line logged from a callback goes through `callbackLog` (`src/base/log.ts`): lint refuses `console.*`
  outside the command line.
- **Facts are read typed**: a subscriber switches on `SideEvent`'s `type`, without casting its fields.
- **Tests never reach a model or this machine's runtimes**: oar's `scriptedRuntime` plays the helpers, a scripted `Llm`
  (`src/ai/testing.ts`) the model, `gh` answers that it is not there.

## Commands

```bash
vp run start --web ../web/dist    # 127.0.0.1:8787, the page at /
vp run cli help                   # the command line
vp run test                       # vp test（vitest，配置在 vite.config.ts）; types: vp check at the root
vp run db:generate                # after changing db/queries or db/migrations (db:check says whether it is stale)
vp run evals                      # the orchestrator's evals on the real model: costs money, ask first
```
