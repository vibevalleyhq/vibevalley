# Agent Note: 工地事件走 server-sent events，命令走 HTTP

Status: implemented

## Problem

页面要实时看到农场的变化（帮工在做什么、谁做完了、管家在说什么），也要发命令（说话、带话、收获、改配置）。最早的设计是一条 WebSocket 双向通信。

## Decision

- 命令走普通 HTTP：`VibeValleyApi`，接口定义在 Go 的 `Handlers`（`server/internal/protocol/api.go`），服务端在 `internal/handler/api.go` 实现，Flutter 用生成的客户端（`app/lib/gen/vibevalley.dart`）调，类型两端一致（[形状的源头是 Go](2026-10-15-go-owns-the-shapes.md)）。
- 状态走 `GET /api/v1/events`（server-sent events）：每次连上先发一份快照，然后发事实（[farm-core-state](2026-10-11-farm-core-state.md)），再加几样不属于核心状态的（干活过程、提醒、农机变化）；每 20 秒一行心跳，免得代理关掉空闲的连接。
- Flutter 客户端不折事实，读另一条同样的流 `GET /api/v1/state`：状态变了就推一整份折好的 `StateFrame`，至多每 200 毫秒一份；`/api/v1/events` 它只取核心状态之外的那几样（[客户端迁到 Flutter](2026-10-13-flutter-client-over-ts-server.md)）。

形状见 [architecture.md](../../../../docs/architecture.md)「工地事件」「HTTP 接口」。

## Alternatives considered

**WebSocket。** 命令已经有类型化的 HTTP 接口，事件只往一个方向走；SSE 由浏览器自己重连，重连时又从快照开始，不用自己写重连和补发。

**页面轮询。** 帮工的动作一秒好几次，轮询要么慢要么费。

## Consequences

断线重连不用补发：重连又从快照（或整份状态）开始；当初浏览器自己重连，现在 Flutter 客户端是几行重连的循环（`app/lib/data/server.dart`）。命令和事件各用最简单的机制。代价是事件里不能顺带回复命令：命令的结果要么是 HTTP 的返回，要么是随后的事实或提醒。
