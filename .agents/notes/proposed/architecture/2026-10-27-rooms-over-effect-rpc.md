# Agent Note: 田头按房间走 Effect RPC，消息不再跟着状态帧

Status: proposed

## Problem

VibeValley 本质上是聊天室加 agent 加工单：主人、管家和帮工在频道和串里说话，工单的事发生在它的串里。现在田头的消息是核心状态的一部分（`WorkspaceState.chat.messages`，全库最近 300 条），跟着 `GET /api/v1/state` 的状态帧推给页面：

- 任何一条事实到来，整份状态连同 300 条消息推一遍；经「连接到本机」推到手机时更重。
- 一个热闹的串把别的对话的消息挤出状态，页面再用 `channel.history` 去补，两份数据要合并。
- 页面只能拿到「最近的」，拿不到「我看到第几号以后的」：断线重连只能重新拿一整帧。
- 页面对 SSE 的数据不解码（`JSON.parse(...) as T`），服务端的形状变了页面不知道。

#119 以后消息写下就不再改，每个对话的消息号就是现成的游标，按房间订阅、按号补齐成了自然的做法。

## Proposal

**一个主人，几台设备。** 这一版只有 `owner` 一个人；连接按设备分，「是谁」留在连接上，以后要多人时加在这里。

### 1. 房间

每个对话（田头、频道、串）是一个房间。房间的事件：

- `Message`：一条写下的消息，带它的号码。持久的：按号码从库里补齐。
- `Reset`：落后太多（超过 `catchUpMax` 条），页面重读这个房间的最新一页，再从那里接着订阅。

正在输入不进房间：管家在哪个对话里想、在写已经是核心状态的 `orchestratorConversation`，农场也要它。

### 2. 契约：Effect RPC

`packages/protocol/src/rpc.ts` 写一个 `RpcGroup`（`Rooms`），第一个是流式的 `rooms.follow({ room, after })`：先补 `after` 以后的，再推实时的。服务端实现它，页面拿到带类型的客户端，两边都照 Schema 解码。

- 服务端：`channel` 的 `Channels.follow(room, after)` 先订阅房间的 `PubSub`，再从库里读漏掉的（`messagesAfter`），按号码去掉重复的，拼成一个 `Stream`。消息照旧先写库、提交以后才发布。`http/rooms.ts` 用 `RpcServer.layerProtocolWebsocket` 挂在 `/api/v1/rooms`，序列化用 JSON。
- 页面：Effect 只在 `apps/web/src/data/gateway.ts`：一个 `ManagedRuntime` 提供 `RpcClient` 和 `Socket.layerWebSocket`，每个房间的订阅是一个纤程，断了带着最后的号码重新订阅。`data/rooms.ts` 是按房间存消息的 Solid store，田头窗口和 `/chat` 页只读它。
- 写仍走 HTTP 的接口表：命令行、`can` 和 curl 都靠它。主人的消息带 `sendKey`，房间里的消息带回它，页面的「发送中」按它换成服务端的那条。

### 3. 状态帧只留对话列表

`WorkspaceState.chat` 只剩 `conversations` 和 `ownerMentions`；`Conversation` 带服务端算的 `unread`（主人没读的、不是自己说的、不是提示）。`message` 事实照旧施加：它把对话的 `lastNumber` 推到这条的号码，游戏和工单串照旧听它。

### 4. 只放农场自己的页面

WebSocket 不受 CORS 管，别的网页能直接连本机的端口。upgrade 之前：

- 本机的服务端：`Host` 是回环地址（`127.0.0.1`、`localhost`），`Origin` 有的话要和 `Host` 同源；经「连接到本机」转来的（带 `x-vibevalley-lan-device`）由转发的那一头查过。
- 「连接到本机」：照现在的规矩认设备（cookie 或 Bearer），`Origin` 和 `Host` 同源，再把 upgrade 原样转给本机的服务端，带上设备头；移除设备时一并断开它的 WebSocket。
- 页面开发时 Vite 的 `/api` 代理打开 `ws`。

### 5. 以后

- 在线：一个一直开着的流式 RPC（`presence.attend`），客户端断开时服务端中断它，收尾里注销；主人在某台设备上看着时，连接器先不往微信推。
- 工单、计划按 Linear 的方式做实体增量，走同一条连接。

## Alternatives considered

- **照 socket.io 自己写一套房间协议**：加入、离开、回执、心跳、重连都要手写；RPC 的流式调用里这些都有（中断就是离开，socket 协议带心跳、指数退避的重连和流的回执）。
- **不上 Effect RPC，页面直接 `JSON.parse`**：页面少带约 160 KB（gzip）；但页面不解码，形状变了不知道，订阅的生命周期要自己管。量过：Effect 核心加 Schema 约 95 KB，加 RPC 和 Socket 约 156 KB，再加 protocol 的 Schema 约 164 KB；页面的主包现在约 453 KB。
- **消息留在核心状态里，只是不进状态帧**：服务端每份状态都多存 300 条没人读的消息，帧和状态成了两种形状，页面的类型要分开。
- **只把帧缩小、页面按号码用 HTTP 拉**：实时性靠帧到了再拉一次，多一个来回；设备多了以后还是要订阅。

## Acceptance criteria

- 状态帧里没有消息：`/api/v1/state` 的 `state.chat` 只有对话列表和 `ownerMentions`，每个对话带 `unread`。
- 页面在田头说一句：「发送中」那一行换成服务端的那条（按 `sendKey`），另一个标签页里同时出现，各只一条。
- 断开再连上，带着号码补齐，不丢不重；落后超过 `catchUpMax` 时页面重读最新一页。
- 别的源连 `/api/v1/rooms` 被拒（403）；`Host` 不是回环地址的被拒；经「连接到本机」配对过的设备能订阅，没配对的被拒，移除设备时它的连接断开。
- 测试：`Channels.follow` 的补齐、去重、`Reset`；RPC 经真的 WebSocket 端到端；`Origin` 和 `Host` 的拒绝；「连接到本机」转发 upgrade；页面的 Playwright 两个页面同看一个对话。
- [田头](docs/subsystems/channel.md)、[客户端](docs/subsystems/app.md)、[核心状态](docs/subsystems/core.md)、[连接到本机](docs/subsystems/lan.md)、[地基](docs/subsystems/foundation.md) 改成这样，第 5 节留在本篇。

## Risks

- `effect/rpc` 在 v4 里标着 unstable；仓库已经用着同样标着的 `effect/http`、`effect/sql`、`effect/cli`。
- 页面多约 160 KB（gzip），手机上多一点解析时间。
- 页面和服务端要是同一版：页面一直由服务端提供，桌面壳把两者一起打包。
- 黄金数据：`reduce` 和游戏的折法里，状态不再带消息，`message` 事实改成推进对话的号码；重写后要看 diff，只该少了消息。
