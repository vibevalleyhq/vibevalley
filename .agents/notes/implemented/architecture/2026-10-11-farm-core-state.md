# Agent Note: 农场是一份核心状态，只因事实而变

Status: implemented

## Problem

一个帮工的状态曾经拆在好几处：服务端的 `Hand`（行、会话、汇报、token、没动静的时间……）、`Site` 里的一份行副本、页面上从行推出来的 `Worker` 和作物、管家读的 `Roster`。每加一个功能就往行上补一个字段（花费、冲突），「没动静」只有管家看得到，冲突标记靠「开始干活时顺手清掉」这种副作用维持；页面靠比较前后两行来猜「开始了新一轮」；服务端、模拟服务器和页面各写一套同样的逻辑。

## Decision

农场上的一切是一个值 `CoreState`，只因事实而变，由协议里一个纯函数 `Reduce(state, fact)`（`server/internal/protocol/core.go`）折进去（[architecture.md](docs/architecture.md)「核心状态」）。当初服务端、页面和模拟服务器调的是同一个 TypeScript 的 `reduce`；网页退役以后只剩服务端折，客户端读折好的状态（[网页退役](.agents/notes/implemented/simplification/2026-10-14-retire-the-web-page.md)）。

- 帮工的生命周期是一个阶段 `phase`：`arriving`、`working`（带在做什么、没动静、重试）、`ripe`、`failed`、`resting`；离开就从状态里删掉。冲突是帮工分支的属性，以最近一次 git 检查为准，不属于阶段。
- 「在做什么」「要你做什么」「管家怎么描述它」都是从阶段推出来的纯函数（`DoingOf`、`NeedOf`、`PhaseText`；客户端的面板用它们在 `app/lib/rules/sessions.dart` 里的 Dart 移植，能不能收是 `canHarvest`），地块、面板、管家读同一套。
- 服务端只在 `Core.Apply` 改状态，存进 `state.json`（田头、进度、定时和工单除外，它们的家是数据库 `vibevalley.db`）；只有服务端需要的（会话、worktree 目录、原话）在 `sessions.json`；大块的旁路数据（干活过程、diff）不进核心状态。
- 客户端在核心状态之上叠一层只属于游戏、跟着时钟走的状态（帮工走到哪、一闪而过的效果）；地块位置和历史后来也进了核心状态（`Session.Play`，由 `Reduce` 折，[客户端迁到 Flutter](.agents/notes/implemented/architecture/2026-10-13-flutter-client-over-ts-server.md)）。金币和成就也是核心状态：服务端的账本折出来（[achievements](.agents/notes/implemented/feature/2026-10-11-achievements.md)）。

## Alternatives considered

**保留行模型，只补字段。** 每个新状态都要在三处各写一遍，副作用越积越多，这正是要解决的问题。

**线上发 JSON patch。** 页面还是不知道发生了什么（开始一轮还是只改了标签），游戏层要的正是「发生了什么」。

**只在服务端算，页面只收结果。** 模拟服务器要再写一遍；页面也拿不到事实来计分和放动画。

## Consequences

新加一种状态，先在协议里加字段或事实（`shapes.go`）、在 `Reduce` 里折，编译器逼每个视图都处理到；服务端和客户端不会对不上，重启只是读回上一份状态。代价是线上格式变了：以前导出的事件日志不能回放，网页调试台的 `hb.set` 换成了 `hb.fact`（网页删了以后都没有了）；拿一个状态要经过 `Reduce`，不能随手改一个字段。

## Verification

当初由 TypeScript 服务端的 `farm.test.ts` 覆盖 `reduce` 和推导：帮工的一生、对不存在的帮工的事实不改状态、对话的增长和截断、快照过线来回不变。现在 `Reduce` 只在 Go（`server/internal/protocol/core.go`），`server/internal/protocol/reduce_golden_test.go` 的 `TestReduceGolden` 拿几千个随机事实的黄金数据（当年由 TypeScript 的一份折出）逐个比状态、特效和视图。
