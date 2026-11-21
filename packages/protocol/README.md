# @vibevalley/protocol

The contracts between the server and the views (the shapes on the wire, their Schemas, the endpoints, the subscriptions,
and the few pure rules both sides run), and between the page and the program around it (the host). The shapes and the
endpoint table are Rust's: `crates/vibevalley-protocol/src/contract/` is the source, and `src/<concept>/shapes.gen.ts`
and `src/endpoints.gen.ts` are written from it (`vp run protocol:ts`; `cargo test` fails when they are stale). The zod
Schemas, `api.ts`, the rules and the client are hand-written here for the native app's views (`apps/mac/ui`). No files, no network.

| Entry | What |
|---|---|
| `@vibevalley/protocol` | `src/<concept>/shapes.ts`, a folder per concept named as the Rust contract's module: its `shapes.gen.ts` and the constants and paths kept here, gathered by `src/shapes.ts`, and `src/client.ts` (`VibeValleyApi`, written by `vp run api:client` from the endpoint table) |
| `@vibevalley/protocol/schema` | a Schema for every shape, in `src/<concept>/schema.ts` beside it, each typed `Codec<T.X>` (`z.ZodType<T.X, Wire<T.X>>` in `src/codec.ts`, the wire side without the ids' brands): it fails to compile when the two differ |
| `@vibevalley/protocol/api` | `endpoints` (method, path, parameters, request and answer Schemas, who may call) and `Handlers`, put together from each concept's `src/<concept>/api.ts` (`api.test.ts` holds it to the served table, `endpoints.gen.ts`); `BizCode`, `bizCodeMeta`, `ApiError`, `ApiErrorEnvelope`, `ApiVoidEnvelope`, `apiSuccessEnvelope`, `Endpoint` and `input` from `src/endpoint.ts` |
| `@vibevalley/protocol/rpc` | `subscriptions` and `Subscriptions`: what a page follows a channel, the farm's reports and an artifact by, each over SSE at `subscriptionPath` (`GET /api/v1/subscribe/<name>?payload=…`, `subscriptionUrl`) |
| `@vibevalley/protocol/host` | `Host`: what the page may ask of the native macOS shell around it (below), with the Schemas of what crosses (`UpdateState`, `CommandLineState`, `ThemeChoice`) |
| `@vibevalley/protocol/rules` | pure rules both the server and the page run: phase and action words (`phase.ts`), issue titles and stage helpers (`issues.ts`, `stage.ts`), channel lookup (`channel.ts`), block order keys (`order.ts`), sandbox attributes (`display.ts`), repo name validation (`repo.ts`), inbox news (`inbox.ts`), a session's farm (`play.ts`), and small helpers (`same.ts`, `plain.ts`, `omit.ts`, `oneOf.ts`, `cut.ts`) |


## The host

A capability a host lacks is absent, and the page draws by that, never by asking which host it is in. The page finds its
host in `apps/mac/ui/infra/host.ts` (`currentHost()`): inside the native app each member is a `host.<name>` call
over the bridge, answered by the shell (`apps/mac/src/shell/host_bridge.rs`, `host_call`; `host.info` lists what it answers);
headless tests and stories get a host with a name and nothing else ([the client](docs/subsystems/app.md#宿主)).

```bash
vp run test     # vitest: the rules, the Schemas and the endpoint table against the generated ones (types: vp check at the root)
```
