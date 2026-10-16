# Agent Note: core 的规则有单元测试

Status: implemented

> 已被取代：`packages/core` 和它的测试随网页删掉了（[网页退役](../simplification/2026-10-14-retire-the-web-page.md)）。地块、计分这些规则现在在 Go 的 `server/internal/protocol`，由黄金数据和直接写的规则测试守着；客户端留着的那部分（工具点在地上的结果 `aimTool`、阶段的说法……，在 `app/lib/game/`、`app/lib/rules/`）用 `flutter test` 测（`app/test/farm_rules_test.dart`）。下面是当时的决策。

## Problem

core 的规则都是纯函数（`plotOf`、`poseOf`、`aimTool`、`score`、`scoreCommits`、`applySiteEvent` 的游戏层），但没有测试；改阶段或计分时只能开页面看。

## Decision

`pnpm --filter @heybro/core test`（`packages/core/test/`，vitest），不起页面：

- `farm.test.ts`：每个阶段和「要你做什么」对应的作物和牌子；一轮里从发芽到开花；姿势；每个工具在空地、干活、成熟、歇着、失败、没开垦的地上的结果；开垦等级；杀虫的话只带一次原工单。
- `rules.test.ts`：页面看到的进度（核心状态里的进度加上 commit 数算出的等级）；`progress` 事实带来的金币和成就变成哪些效果；第一次数 commit 不放升级，之后每升一级放一次。计分本身在 protocol，测在 `server/internal/protocol/progress_rules_test.go`（[achievements](../feature/2026-10-11-achievements.md)）。
- `site.test.ts`：一串工地事件经 `applySiteEvent` 折下来，地块怎么分、这一轮的历史和计数、汇报、一轮做完不给金币、进度事实放的效果、快照后地块不变、干活过程的一步长大后替换自己、提醒。每个测试一个新的 `AtomRegistry` 和 Effect 的 `TestClock`：离开的帮工走一会儿才消失、奖励的特效几秒后消失，都靠 `TestClock.adjust` 拨表，不真等。

测试另有 `test/tsconfig.json`，带 Node 的类型；`src` 的 tsconfig 写明 `"types": []`，所以装了 `@types/node` 以后，core 的代码照样拿不到 `setTimeout` 这些。`pnpm typecheck` 两个都查，根目录的 `pnpm test` 跑服务端和 core 的测试。

## Alternatives considered

**只靠模拟服务器的场景。** 要人看，回归抓不住。

**另用一个测试框架。** 和服务端用同一套就够；断言都是普通的值比较。整个仓库后来一起换成了 vitest（[Vite+ 工具链](../process/2026-10-13-vite-plus-toolchain.md)），core 跟着换，断言没变。

**用真的时钟，测试里等几秒。** 离开的帮工要 3.6 秒才消失，每个这样的测试都要真等，计时器还会拖住进程；`TestClock` 换掉的正是 `Effect.sleep` 用的 Clock，`pushTimed` 和 `removeLater` 分出去的 fiber 也跟着用它。

## Consequences

改地块、姿势、工具或计分时，跑一秒内的测试就知道哪条规则变了。代价是测试写的是具体的值（金币数、牌子上的字），调平衡或改文案要连测试一起改；画面本身（位置、动画）仍然要在调试台里看。
