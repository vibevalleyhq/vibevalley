# @vibevalley/protocol

The farm's shapes and the rules both the server and the page use. Only types, Schemas and pure functions: no files, no
network. Why there is one copy: [foundation](docs/subsystems/foundation.md).

| Entry | What |
|---|---|
| `@vibevalley/protocol` | `src/shapes.ts` (the types, and the constants both sides share), `src/stream.ts` (reading a stream), `VibeValleyApi` |
| `@vibevalley/protocol/schema` | a Schema for every shape, each typed `Schema.Codec<T.X>`: it fails to compile when the two differ |
| `@vibevalley/protocol/api` | `endpoints` (method, path, parameters, request and answer Schemas, who may call), `Handlers`, `errorStatus`, `VibeValleyApi` |
| `@vibevalley/protocol/rules` | the core state's fold (`reduce`, `frameOf`), the inbox, plots and achievements, task graphs, schedules, the doc's order keys, text as JavaScript measures it; `seeds.json`, `template_catalog.json` |

`testdata/*.jsonl.gz` are the rules' golden cases (`src/rules/golden.test.ts`); `bun run golden:update` from the root
rewrites them after a rule changes on purpose.

```bash
bun run check   # types
bun test src    # the rules
```
