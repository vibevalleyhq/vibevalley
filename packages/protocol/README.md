# @vibevalley/protocol

The contracts: between the server and the page (the shapes on the wire, their Schemas, the endpoints, the rooms' RPCs,
and the few pure rules both sides run), and between the page and the program around it (the host). A rule only the server runs belongs to its module in `apps/server/src`, and so do the core
state's fold and the frame (`apps/server/src/projection`). No files, no network.

| Entry | What |
|---|---|
| `@vibevalley/protocol` | `src/shapes.ts` (the types, and the constants both sides share), `src/stream.ts` (reading a stream), `src/client.ts` (`VibeValleyApi`, written by `vp run api:client` from `api.ts`) |
| `@vibevalley/protocol/schema` | a Schema for every shape, each typed `Codec<T.X>` (`Schema.Codec<T.X, Wire<T.X>>`, the wire side without the ids' brands): it fails to compile when the two differ |
| `@vibevalley/protocol/api` | `endpoints` (method, path, parameters, request and answer Schemas, who may call), `Handlers`, `errorStatus` |
| `@vibevalley/protocol/rpc` | `Rooms`: the RPCs a page follows a conversation's room and the farm's reports by, over the WebSocket at `roomsPath` |
| `@vibevalley/protocol/host` | `Host`: what the page may ask of the desktop's shell or the phone's (below); `ToNative`, `FromNative` and `mobileHost`, the page's end of the phone's bridge |
| `@vibevalley/protocol/words` | what both sides say to the owner, in Chinese (`zh.ts`, the source of the shape) and English (`en.ts`): `wording()`, and `localized`, `setLocale`, `currentLocale` for every other word table ([where words go](docs/subsystems/foundation.md#话放在哪)) |
| `@vibevalley/protocol/rules` | the core state's fold (`reduce`, `frameOf`), the inbox, plots and achievements, task graphs, schedules, the doc's order keys, text as JavaScript measures it |

The golden cases of the fold and the frame are the server's (`apps/server/src/core/testdata`, `core/golden.test.ts`).

## The host

Every host gives the whole `Host`; a capability it lacks is null, and the page draws by that, never by asking which host
it is in. The page finds its host in `apps/web/src/host.ts` (`currentHost()`: the desktop preload's, the phone's built
over the bridge, `browserHost` otherwise).

| Member | Desktop (`apps/desktop`) | Phone (`apps/mobile`) | Browser |
|---|---|---|---|
| `notify(notice)` | a system notification | a local notification | null |
| `tray(summary)` | the menu bar's title and lines | null | null |
| `voiceShortcut` | ⌥⇧Space from anywhere | null | null |
| `rtc(grant, events)` | null (the page's Agora Web SDK) | Agora's native SDK, going on with the screen locked | null |
| `locale(locale)` | the tray's menu and the island follow the page's language | null (the shell speaks the phone's) | null |

On the phone, what the page asks goes out as `ToNative` and is answered by id; the call's events come back as
`FromNative`. Each `RtcLine` keeps its own identity across the bridge: its controls and events cannot act on a later
call, including a join that finishes after the page cancelled it.

```bash
vp run test     # vitest: the rules and the phone's bridge (types: vp check at the root)
```
