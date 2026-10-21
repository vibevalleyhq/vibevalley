# @vibevalley/protocol

The contract between the server and the page: the shapes on the wire, their Schemas, the endpoints, and the few pure
rules both sides run. A rule only the server runs belongs to its module in `apps/server/src`; the ones still here for
the core state's fold and the frame move out by the
[proposal](.agents/notes/proposed/architecture/2026-10-22-ten-modules.md). No files, no network.

| Entry | What |
|---|---|
| `@vibevalley/protocol` | `src/shapes.ts` (the types, and the constants both sides share), `src/stream.ts` (reading a stream), `src/client.ts` (`VibeValleyApi`, written by `bun run api:client` from `api.ts`) |
| `@vibevalley/protocol/schema` | a Schema for every shape, each typed `Schema.Codec<T.X>`: it fails to compile when the two differ |
| `@vibevalley/protocol/api` | `endpoints` (method, path, parameters, request and answer Schemas, who may call), `Handlers`, `errorStatus` |
| `@vibevalley/protocol/rules` | the core state's fold (`reduce`, `frameOf`), the inbox, plots and achievements, task graphs, schedules, the doc's order keys, text as JavaScript measures it; `seeds.json`, `template_catalog.json` |

The golden cases of the fold and the frame are the server's (`apps/server/src/core/testdata`, `core/golden.test.ts`).

```bash
bun run check   # types
bun run test    # vitest: the rules
```
