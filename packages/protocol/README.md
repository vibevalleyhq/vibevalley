# @vibevalley/protocol

The contract between the server and the page: the shapes on the wire, their Schemas, the endpoints, and the few pure
rules both sides run. A rule only the server runs belongs to its module in `apps/server/src`, and so do the core
state's fold and the frame (`apps/server/src/projection`). No files, no network.

| Entry | What |
|---|---|
| `@vibevalley/protocol` | `src/shapes.ts` (the types, and the constants both sides share), `src/stream.ts` (reading a stream), `src/client.ts` (`VibeValleyApi`, written by `vp run api:client` from `api.ts`) |
| `@vibevalley/protocol/schema` | a Schema for every shape, each typed `Codec<T.X>` (`Schema.Codec<T.X, Wire<T.X>>`, the wire side without the ids' brands): it fails to compile when the two differ |
| `@vibevalley/protocol/api` | `endpoints` (method, path, parameters, request and answer Schemas, who may call), `Handlers`, `errorStatus` |
| `@vibevalley/protocol/rules` | the core state's fold (`reduce`, `frameOf`), the inbox, plots and achievements, task graphs, schedules, the doc's order keys, text as JavaScript measures it; `seeds.json`, `template_catalog.json` |

The golden cases of the fold and the frame are the server's (`apps/server/src/core/testdata`, `core/golden.test.ts`).

```bash
vp run test     # vitest: the rules (types: vp check at the root)
```
