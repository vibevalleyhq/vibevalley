# apps/server

The farm's server: every service, the HTTP API, the three state streams, `/mcp` for the helpers, and the page at `/`.
Plain TypeScript on Node 24 (async/await, AbortSignal, `@vibevalley/async`; Zod at every boundary; Hono for HTTP), run from source with vpx (`vp run start`) and bundled with `vp pack` for the desktop app (`vp run build`, dist/); the database is Postgres: the one at `database.url`, or else PGlite in the home (the same dialect, in process). How it is built and why:
[foundation](docs/subsystems/foundation.md); what each service does: [the subsystems](docs/subsystems/README.md).

```
src/main.ts          the server: loads the configuration, takes the home's lease, serves; --ready-json, --web
src/chat/            the conversations in a terminal (a runtime, or the farm's own agent): the command line (apps/cli) hands its
                     terminal to this program, as they need the server's runtimes, models and config
src/services.ts      every service in build order (`make<X>(deps)`; buildModules builds them to the issues, for the farm and
                     the module tests), then each one's boot, and the closes in reverse
src/modules.ts       which folders make up which part of the server (Platform, Agents, Issues, Gateway…), checked by modules.test.ts
src/base/            what touches nothing outside: ids, JSON, order, redaction, errors
src/infra/           what deals with the process and the machine: configuration, database, files, the home's lease, logs, time
src/core/            the one core state: Core applies facts through gateway/projection
src/platform/<name>/ the primitives below every module, one service each: setting user attachment provider
src/modules/<name>/  one deep service each: agent (profiles, skills, templates and the runtimes) memory repo session (triggers,
                     deliveries, sessions and runs, workplaces, executions) channel media artifact pkm issue cron inbox tool
                     orchestrator game
src/gateway/         what faces outside, built last: http/ (the router over the endpoint table, handlers/<concept>.ts, the SSE
                     streams, /mcp, the page), mcp/, lan/ (「连接到本机」), connector/ (WeChat, Feishu, QQ), voice/, and
                     projection/ (reduce folds facts into the state, frame.ts builds the frames)
src/flows/           tests that go through several services: a whole farm and a helper that works by the words of its job
src/testing/         test helpers: a temporary home, an in-memory database, a whole farm, git repositories, the scripted model
db/                  migrations/0001_schema.up.sql (the one schema), queries/<table>.sql, generated/ (scripts/pg-generate.ts)
```

The desktop bundle emits `dist/main.mjs` from `src/main.ts` and `dist/chat.mjs` from `src/chat/main.ts`.
Runtime assets resolve from the package root through `#package` in both source and deployed builds.

## Rules

- **One service a module**: an interface `X` and a factory `makeX(deps: XDeps)`; a module uses only those before it in
  `services.ts`, and hears later ones through subscriptions. What it does at startup is `boot()`, what it holds is let go in `close()`.
- **Shapes and the endpoint table are `@vibevalley/protocol`'s**, a folder per concept; `gateway/http/handlers/<concept>.ts` fails to compile when it misses one.
- **SQL only in `db/queries`**, one file a table, called through `db/generated`; `src/infra/schema.test.ts` holds the
  names and the one baseline.
- **Background work belongs to the service**: each runs in the service's `TaskGroup` (`@vibevalley/async`), so `close()`
  aborts it and waits for it; nothing is left as a floating promise. Logs go through `deps.log` (`src/infra/log.ts`): lint
  refuses `console.*` outside the command line.
- **Facts are read typed**: a subscriber switches on `ServerEvent`'s `type`, without casting its fields.
- **Tests never reach a model or this machine's runtimes**: oar's `scriptedRuntime` plays the helpers, a scripted DeepSeek
  (`src/testing/model.ts`, seated on the farm's harness by `src/testing/deepseek.ts`) the model, `gh` answers that it is not there.

## Commands

```bash
vp run start --web ../web/dist    # 127.0.0.1:8787, the page at /
vp run test                       # vp test (vitest, configured in vite.config.ts); types: vp check at the root
vp run db:generate                # after changing db/queries or db/migrations (db:check says whether it is stale)
vp run evals                      # the orchestrator's evals on the real model: costs money, ask first
```
