# Agent Note: 宿主之间的调用走一份契约

Status: proposed

## Problem

页面经 `Host`（`packages/protocol/src/host.ts`）向宿主要东西，宿主把它转给另一个进程：桌面是 preload 到 Electron 的 main，手机是 WebView 里的页面到 React Native 的壳。两条线各写各的，都没有契约：

- 桌面：通道名是裸字符串（`"host:notify"`），preload 和 main 各写一遍；main 的 `(_e, notice: Notice) =>` 只是声明，页面传什么就用什么；校验各写各的（`reveal` 查斜杠开头，`theme`、`locale` 各自判值，`notify`、`tray` 不查）；快捷键 `Alt+Shift+Space` 两边各定义一次。
- 手机：`ToNative`、`FromNative` 是手写的联合，请求和回答靠手写的 `id` 配对，壳读进来的消息 `as ToNative` 断言。

## Proposal

照 oRPC 的做法：一份契约写清每个调用的入参、出参和每个推送的载荷（Effect Schema），两头由契约生成，传输只是适配器。

- **新包 `packages/bridge`（`@vibevalley/bridge`）**，只依赖 effect：
  - `call({ input, output })`、`push(payload)` 定契约。
  - `serve(contract, link, impl)`：被调的一侧。`impl` 按契约的键齐全，漏一个编不过；进门解码入参，坏的回一个拒绝；回答和推送出门前编码。
  - `connect(contract, link)`：调的一侧。`call.<名字>(input)` 有类型，推送用 `on(名字, fn)` 订阅，返回怎么停；回答和推送进门解码。
  - 线上的消息只有三种：请求 `{ id, call, input }`、回答 `{ id, ok, output | error }`、推送 `{ push, payload }`。`id` 由它配对。
  - `Link` 是传输：`send(message)` 和 `receive(fn)`。不认识 Electron 和 React Native。
- **契约在 `packages/protocol/src/host.ts`**，和 `Host` 放在一起：
  - `desktopBridge`：`notify`、`tray`、`locale`、`reveal`、`theme` 五个调用，`voiceShortcut` 一个推送；快捷键的写法也在这里。
  - `mobileBridge`：`notify`、`rtc.join`、`rtc.mute`、`rtc.renew`、`rtc.leave` 五个调用，`rtc.*` 六个推送，各带 `line`。
  - `Notice`、`TraySummary` 的 Schema 和契约放在一起。
- **传输各归各的宿主**：
  - 桌面：一个通道 `vibevalley:bridge`，preload 用 `ipcRenderer.send` 和 `on`，main 用 `ipcMain.on` 和窗口的 `webContents.send`。
  - 手机：页面一端是 `ReactNativeWebView.postMessage` 和 `fromNativeKey` 上的函数（`apps/web/src/base/host.ts`），壳一端是 `onMessage` 和 `injectJavaScript`（`apps/mobile/src/FarmScreen.tsx`）。
- **页面仍然只认 `Host`**：preload 和 `mobileHost` 把 `connect` 的结果包成 `Host`，页面不知道底下是哪条线。`ToNative`、`FromNative` 删掉。

步骤：桥的包和测试 → 契约 → 桌面换过来 → 手机换过来 → 文档。一个 PR，每步一个提交。

## Alternatives considered

**直接用 oRPC**：它的 Electron 做法让页面经 `MessagePort` 自己当客户端，页面就得认识桌面；让 preload 当客户端的话，它只覆盖 preload 到 main 这几十行。仓库已经有两套同样思路的东西（`api.ts` 的端点表、`rpc.ts` 的 `RpcGroup`），都在 Effect Schema 上，再引一套要经 Standard Schema 转一层；它的中间件、OpenAPI、批量这里用不上。

**用 `effect/rpc` 的 `RpcGroup` 定契约，自己写 IPC 的传输**：和 `rpc.ts` 同一套写法，但 main、preload 和手机壳都要跑 Effect 的运行时，`main.ts` 和壳现在是普通的代码；十个调用不值得。

**只给桌面做**：手机那套是同一件事，只有一个用的地方看不出通用层抽得对不对。

## Acceptance criteria

- 桌面和手机的宿主调用都经 `@vibevalley/bridge`，代码里不再有 `"host:*"` 通道名、`ToNative`、`FromNative` 和断言读进来的消息。
- 坏的入参在被调的一侧被拒，调的一侧得到拒绝；桥的测试覆盖配对、拒绝、推送、关掉以后的消息。
- `vp check`、`web:check`、`server:check`、页面 e2e、`desktop:test`、手机壳的测试都过。

## Risks

- preload 要把 effect 的 Schema 打进去：看 `scripts/build.ts` 打包后的大小和沙箱里能不能跑，`desktop:test` 会起整个应用。
- 手机壳在 Hermes 上解码：只验得了单元测试，真机和模拟器这次不跑，写进 PR 的 Not verified。
- 桌面的推送原来是专门的通道，换成同一个通道以后，窗口重建时推送跟着当前窗口走。
