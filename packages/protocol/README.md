# @vibevalley/protocol

The contracts: between the server and the page (the shapes on the wire, their Schemas, the endpoints, the subscriptions,
and the few pure rules both sides run), and between the page and the program around it (the host). A rule only the server runs belongs to its module in `apps/server/src`, and so do the core
state's fold and the frame (`apps/server/src/gateway/projection`). No files, no network.

| Entry | What |
|---|---|
| `@vibevalley/protocol` | `src/<concept>/shapes.ts`, a folder per concept named as the server's module, gathered by `src/shapes.ts` (the types, and the constants both sides share), `src/stream.ts` (reading a stream), `src/client.ts` (`VibeValleyApi`, written by `vp run api:client` from the endpoint table) |
| `@vibevalley/protocol/schema` | a Schema for every shape, in `src/<concept>/schema.ts` beside it, each typed `Codec<T.X>` (`z.ZodType<T.X, Wire<T.X>>` in `src/codec.ts`, the wire side without the ids' brands): it fails to compile when the two differ |
| `@vibevalley/protocol/api` | `endpoints` (method, path, parameters, request and answer Schemas, who may call) and `Handlers`, put together from each concept's `src/<concept>/api.ts`; `BizCode`, `bizCodeMeta`, `ApiError`, `ApiErrorEnvelope`, `ApiVoidEnvelope`, `apiSuccessEnvelope`, `Endpoint` and `input` from `src/endpoint.ts` |
| `@vibevalley/protocol/rpc` | `subscriptions` and `Subscriptions`: what a page follows a channel, the farm's reports and an artifact by, each over SSE at `subscriptionPath` (`GET /api/v1/subscribe/<name>?payload=…`, `subscriptionUrl`) |
| `@vibevalley/protocol/host` | `Host`: what the page may ask of the desktop's shell or the phone's (below); `desktopBridge` and `mobileBridge`, the contracts each host's calls go over (`@vibevalley/bridge`), and `mobileHost`, the page's end of the phone's |
| `@vibevalley/protocol/rules` | pure rules both the server and the page run: phase and action words (`phase.ts`), issue titles and stage helpers (`issues.ts`, `stage.ts`), channel lookup (`channel.ts`), block order keys (`order.ts`), sandbox attributes (`display.ts`), repo name validation (`repo.ts`), inbox news (`inbox.ts`), a session's farm (`play.ts`), and small helpers (`same.ts`, `plain.ts`, `omit.ts`, `oneOf.ts`, `cut.ts`) |


## The host

Every host gives the whole `Host`; a capability it lacks is null, and the page draws by that, never by asking which host
it is in. The page finds its host in `apps/web/src/infra/host.ts` (`currentHost()`: the desktop preload's, the phone's built
over the bridge, `browserHost` otherwise).

| Member | Desktop (`apps/desktop`) | Phone (`apps/mobile`) | Browser |
|---|---|---|---|
| `notify(notice)` | a system notification | a local notification | null |
| `tray(summary)` | the menu bar's title and lines | null | null |
| `voiceShortcut` | ⌥⇧Space from anywhere | null | null |
| `rtc(grant, events)` | null (the page's Agora Web SDK) | Agora's native SDK, going on with the screen locked | null |
| `locale(locale)` | the tray's menu and the island follow the page's language | null (the shell speaks the phone's) | null |

What a host carries to another program goes by a contract here over `@vibevalley/bridge`: the desktop's preload to
Electron's main by `desktopBridge`, the phone's page to its shell by `mobileBridge`, the call's events coming back as
pushes with their line. Each `RtcLine` keeps its own line across the bridge: its controls and events cannot act on a
later call, including a join that finishes after the page cancelled it.

```bash
vp run test     # vitest: the rules and the phone's bridge (types: vp check at the root)
```
