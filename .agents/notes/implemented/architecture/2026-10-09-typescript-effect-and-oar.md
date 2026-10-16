# Agent Note: 全部用 TypeScript 和 Effect，oar 用它的 TypeScript 包

Status: implemented

> 已被取代：服务端换成了 Go，帮工建在 smith（oar 的 Go 移植，`server/pkg/smith`）上（[服务端用 Go 重写](2026-10-13-go-server-on-smith.md)），客户端是 Flutter（[客户端迁到 Flutter](2026-10-13-flutter-client-over-ts-server.md)），形状也改由 Go 写（[形状的源头是 Go](2026-10-15-go-owns-the-shapes.md)）；TypeScript 的服务端、网页、protocol 和 `tools/` 先后删掉了（[一个服务端、一个客户端](../simplification/2026-10-14-one-server-one-client.md)、[网页退役](../simplification/2026-10-14-retire-the-web-page.md)），仓库里没有 Effect 了。照旧的只有工作目录的约定：新项目用 TypeScript + Effect v4。下面是当时的决策。

## Problem

VibeValley 要同时驱动好几种编码 agent（pi、claude、codex……），要处理会话、流式事件、取消、资源释放、超时和重试，页面还要解码同一份协议。仓库里有一份从 oar 迁来的 Go 代码，但它只对照 oar 0.21.2，按当时的审计接不上任何真实 runtime（当时的审计在 `docs/oar-go/go-port.md`，这份代码和文档后来都删了，见 git 历史）。

## Decision

前后端都用 TypeScript 和 Effect v4（`effect@^4.0.2`）：

- 服务端（`apps/server`）：`HttpApi` 定义接口，`Layer` 组装服务，`Scope` 管会话和帮工的生命周期，`Config` 读环境变量，`Stream` 推工地事件。
- 协议（`packages/protocol`）用 Effect Schema 写一份，服务端编码、页面解码、模拟服务器都用它。
- 页面的状态是 Effect 的原子（`effect/reactivity`），React 只读原子；数据层用 Effect，组件不用。
- oar 用 npm 上的 `@botiverse/oar`：它能直接驱动 claude、codex、grok、kimi、antigravity，还有只有 Node SDK 的 pi 和 cursor；帮工用它的 `@botiverse/oar/agents`。oar 自己用 Promise 和回调，服务端在边界上包成 Effect。
- Go 代码（`go/`、`apps/console/`、`tests/replay/`）留在仓库里作参考，产品不依赖。

工作目录里的新项目也约定用 TypeScript + Effect v4（工作目录的 `AGENTS.md`，见 [server.md](../../../../docs/reference/server.md)「帮工」）。

## Alternatives considered

**接着写 Go 版 oar。** 要先补完移植才能接上任何 runtime，pi 和 cursor 只有 Node SDK，Go 里永远接不上。

**服务端用 TypeScript、不用 Effect。** 插话时取消正在进行的一轮、一次开工的资源一起释放、流式事件、外部接口的超时和重试，用 Promise 手写都要自己管清理和中断；Effect 把这些变成类型里看得见的东西。

**页面也用 zustand 之类的状态库。** 工地版用过 zustand；换成 Effect 原子后，core 的状态和命令可以脱离 React 测试，模拟服务器和真实服务端用同一个 `Backend` 服务接进来。

## Consequences

一套语言、一份协议，类型从服务端一路到页面。代价是 Effect v4 还年轻，API 要以 `node_modules/effect/src` 的源码为准，不能凭 v3 的记忆写。
