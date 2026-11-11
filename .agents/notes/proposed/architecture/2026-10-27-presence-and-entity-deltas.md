# Agent Note: 页面的连接接着带上在线状态和工单的增量

Status: proposed

## Problem

频道消息与块 Artifact 已走 `/api/v1/rpc` WebSocket 增量订阅，但全局同步还缺两块：
- **服务端不知道用户是否正在看屏幕**：消息在工作台未读时外部连接器（微信/飞书/QQ）立即外推，用户在电脑前看页面时手机也会响。
- **工单与帮工每次仍推整份 `StateFrame`**：任何事实变化都会重推全量 `issues` 与 `sessions`，断线重连也只能重拉整帧快照。

## Proposal

1. **设备在线与焦点状态（`presence`）**：在 `/api/v1/rpc` 增加流式 `presence.attend({ device })` 与 `presence.focus({ focused })`，汇总是否有设备处于前台（`userHere`）。`Inbox` 在 `userHere` 为真时暂缓外推连接器；切到后台或断连后再补推仍未读事项。
2. **实体增量同步（`core.entities`）**：出帧处按 `id` 比对前后两帧，仅推送变化的 `Issue`、`Session`、`Cron`、`ChannelSummary` 与删除 ID（带单调 `seq`）；重连时调 `core.entities({ after: seq })` 从环形缓冲补齐，超出窗口再回退整帧快照。

## Alternatives considered

- **心跳轮询判断在线**：需调优间隔与超时；复用 `/api/v1/rpc` WebSocket 生命周期断开即离线。
- **工单按单频道订阅**：看板与像素农场需展示全局工单，按实体 ID 增量同步更直接。

## Acceptance criteria

- 前台打开页面时新汇报不外推连接器，切后台或关页后未读汇报自动补推、已读跳过。
- 页面经 `/api/v1/rpc` 接收实体增量并在断线重连后按 `seq` 补齐。

## Risks

- 用户开着页面离开电脑时 `visibilityState` 仍为可见，需评估结合无输入空闲时长判定离开。
