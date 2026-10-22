# @vibevalley/host

What the page may ask of the program around it. Every host implements all of it; a capability a host does not have is
null, and the page draws by that, never by asking which host it is in ([the client](docs/subsystems/app.md)).

| Member | Desktop (`apps/desktop`) | Phone (`apps/mobile`) | Browser |
|---|---|---|---|
| `notify(notice)` | a system notification | a local notification | null |
| `tray(summary)` | the menu bar's title and lines | null | null |
| `voiceShortcut` | ⌥⇧Space from anywhere | null | null |
| `rtc(grant, events)` | null (the page's Agora Web SDK) | Agora's native SDK, going on with the screen locked | null |

`currentHost()` is the one the page runs in: the preload's on the desktop; on the phone, built over the WebView's
bridge (`src/mobile.ts`: what the page asks goes out as `ToNative` and is answered by id, the call's events come back as
`FromNative`); `browserHost` otherwise. Each `RtcLine` keeps its own identity across the phone's bridge: its controls and
events cannot act on a later call, including a join that finishes after the page cancelled it.

```bash
bun run check
bun run test    # the phone's bridge
```
