# Agent Note: 游戏框架和农场核心分开

Status: implemented

> 已被取代：这三层随 [网页退役](../simplification/2026-10-14-retire-the-web-page.md) 删掉了。农场的规则现在是服务端 Go 的纯函数（`server/internal/protocol`）；客户端是一个 Flutter 包（[客户端迁到 Flutter](2026-10-13-flutter-client-over-ts-server.md)），和 VibeValley 无关的那一半（像素村、素材、音效）在 `app/lib/village/`、`app/lib/shell/`（[framework.md](../../../../docs/framework.md)），和其余部分之间没有边界检查。下面是当时的决策。

## Problem

农场里有一半的东西和 VibeValley 无关：把一张画缩放到窗口、贴图站在地上、角色走过去、前后遮挡、点地块、拿工具、昼夜、合成音效、生图切图。和农场规则、和服务端的协议写在一起，换一个画面或加一个游戏机制都要动全身，规则也没法脱离页面测试。

## Decision

分三层，依赖只往下（[framework.md](../../../../docs/framework.md)）：

- `packages/engine`：和具体游戏无关的框架。`core`（Effect 原语：`state`、`waitFor`、`timedList`、`dayClock`、`toolbox`）、`react`（画面部件）、`audio`（合成音效）、`nav`（寻路）。
- `packages/core`：农场：核心状态的副本、游戏状态和规则、命令。只依赖 effect、protocol 和 engine/core。外面的东西（后端、存档、时间、语音）都是服务。
- `web/`：画面、面板、配置页，用 Layer 把后端和存储接进 core。

边界有检查，不靠自觉：`packages/core` 和 `packages/engine/src/core` 的 tsconfig 不带 DOM 类型；根目录 `vite.config.ts` 的 lint（`packages/core/src` 的 override）禁止引入 react、react-dom、zustand 和 `@heybro/engine/react`。

## Alternatives considered

**全部写在 `web/` 里。** 工地版就是这样，规则散在组件和 store 里，测试要起页面，模拟服务器和画面互相牵扯。

**把农场规则也放进 engine。** engine 就不再能给别的游戏用，规则改动也会碰到通用部件。

## Consequences

规则是纯函数，命令要什么服务写在类型里，测试不用起页面。加东西时要先想清楚它属于哪一层，多一点跨包的导入。
