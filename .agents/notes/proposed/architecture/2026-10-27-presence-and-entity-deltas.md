# Agent Note: 页面的连接接着带上在线状态和工单的增量

Status: proposed

## Problem

频道消息与块 Artifact 已走 `/api/v1/rpc` WebSocket 按修订号增量订阅（[频道](docs/subsystems/channel.md)、[Artifact](docs/subsystems/artifact.md)），但全局状态同步还缺两块：
- **服务端不知道用户是否正在看屏幕**：只要消息在工作台尚未标为已读，外部连接器（微信/飞书/QQ）就会立即外推；用户坐在电脑前看页面时手机也会同时响。
- **工单与帮工每次仍推整份 `StateFrame`**：工单与会话变多后，任何一条事实都会把全量 `issues` 和 `sessions` 重新序列化推一遍；页面断线重连也只能重拉整帧快照。

## Proposal

### 1. 设备在线与焦点状态（`presence`）

- 在 `/api/v1/rpc` 增加流式方法 `presence.attend({ device })` 与焦点上报 `presence.focus({ focused })`。
- 页面打开时建立流、断开时由服务端纤程收尾自动注销，汇总出 `ownerHere`（是否有设备处于前台激活状态）。
- `Inbox.toOwner` 在 `ownerHere` 为真时暂缓向外部连接器推送；当用户切到后台或关闭页面时，仍未读的事项再外推给连接器，已读的直接跳过。

### 2. 工单与帮工按实体增量推送（`core.entities`）

- 服务端在出帧处按实体 `id` 比对前后两帧，仅推送变化的 `Issue`、`Session`、`Cron`、`ChannelSummary` 及被移除的实体 ID，附带单调递增序号 `seq`。
- 页面记录最后收到的 `seq`，断线重连时调用 `core.entities({ after: seq })` 从服务端内存环形缓冲补齐增量；落后超出缓冲窗口时回退发送整帧快照。

## Alternatives considered

- **用心跳轮询加超时判断在线状态**：需自行调优心跳间隔与过期窗口；复用已有的 `/api/v1/rpc` WebSocket 连接生命周期，断开即离线。
- **工单也按单个频道订阅**：看板与像素农场需要同时展示全局或全仓库的工单，按实体 ID 增量同步比按频道切分更直接。

## Acceptance criteria

- 用户前台打开工作台或农场页时，新汇报不外推到微信/飞书/QQ；切到后台或关页后，未读汇报自动补推，已读汇报不推。
- 页面通过 `/api/v1/rpc` 接收实体增量并在断线重连后按 `seq` 补齐，不再每次事实变化都重传整份 `StateFrame`。

## Risks

- 用户开着页面离开电脑时浏览器 `visibilityState` 仍为可见，需评估是否结合页面无输入空闲时长判定离开。
