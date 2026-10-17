# Agent Note: 定时是一张工单的触发，工单可以派给管家

Status: implemented

## Problem

[频道和定时](../feature/2026-10-11-channels-and-schedules.md)让定时到点后有两个出口：写了帮工档案的每次写一张新工单，没写的直接对管家说一句话。两个出口靠两个订阅者各自看「有没有写档案」来分工，这个约定是隐式的；交给管家的那一半不进看板，也不留下干了什么。

主人的模型是：issue 和 comment 都能触发一次干活（run，见 [Run、Worker、Crew 的提案](../../proposed/architecture/2026-10-16-runs-workers-crews.md)）。定时应该是同一种东西：一种触发。

## Decision

- **一个定时一张工单**：写了档案的派给那个档案，没写的派给管家。工单的 `schedule` 指着它的定时，`issue.Service.OfSchedule` 取最近的那张。
- **每次到点是这张工单的一次 run**：触发是 `schedule`，带着哪个定时、是不是补跑。
  - 第一次到点：写工单并开工。
  - 派给帮工的：帮工还在就带话；工单关了（收获、收工）就重开，派一个新帮工。
  - 派给管家的：关着就重开，交给管家。
- **工单可以派给管家**：`agent` 是 `protocol.ManagerAgent`（`manager`），没有档案能用这个 id（`agent.Service.SaveAgent` 拒绝）。`dispatch` 不派帮工，经 `ForManager` 交给管家；管家把它当一句话开一次 run（`worker` 列是 `manager`），这一轮 settle 时结束 run，工单关成 `answered`。管家的工单只在管家在做时开着，所以开着就是「处理中」；重启时还开着的关成 `lost`。
- **看板上**：派给管家的是一张不能拖的卡片，详情里是要做的和每次干活。
- **改 `issue` 表的约束要重建这张表**：SQLite 改不了 CHECK。迁移第一行写 `-- vibevalley:rebuilds` 的，在事务外关掉外键再跑，提交前 `foreign_key_check` 不能有问题；否则删旧表会连带删掉指着它的行（`issue_worker`、子工单）。

## Alternatives considered

**每次到点写一张新工单（原来写了档案的做法）。** 不用重开、不用找。没选：一个「每 5 分钟」的定时一天写 288 张工单；和「issue 和 comment 都触发 run」的模型对不上，看不出一个定时干过几次。

**交给管家的定时照旧直接说话。** 改得少。没选：两个出口留着，管家的那一半不进看板、没有 run 的记录。

**管家的工单关成已有的 `dismissed`。** 不用重建表。没选：收工是主人请帮工走，意思不一样；看板和统计会把两种混在一起。

**管家的工单答完不关，一直开着。** 一个定时一张卡片一直在。没选：开着的工单在「处理中」，看起来管家一直在做；和帮工的工单收获就关、下次重开也不一样。

## Consequences

- 看板上一个定时只有一张卡片，在「处理中」「等你看」「已关」之间来回；它的 run 在详情里。
- 管家一轮里可能同时处理好几件事（几条话一起进同一轮），这一轮 settle 时，交给它的几张工单一起关。
- 定时交给帮工的话是 `DueText`（「⏰ 定时「…」到点了：…」），和频道里的提示一样。
- 以前每次到点写的那些工单还在，`OfSchedule` 只认最近的一张。
- 改了 `issue` 表的约束或列，照 0010 的样子重建，并写同样的标记。

## Verification

- `workspace` 的 `TestAScheduleKeepsOneIssue`：同一个定时三次到点都是同一张工单；帮工还在时带话、开第二次 run；收获以后重开、派第二个帮工；三次 run 的触发都是这个定时。
- `manager` 的 `TestManagerSchedulesComeDue`：交给管家的定时写一张派给管家的工单，管家答完关成 `answered`，留下一次管家的 run，触发是这个定时。
- `base` 的 `TestDBRemakesIssueKeepingWhatPointsAtIt`：重建 `issue` 表以后，工单、子工单和 `issue_worker` 的行都在，`answered` 写得进去，外键重新打开。
- Flutter 的 `tickets_test.dart`：管家的工单开着在「处理中」，答完是「管家答完了」、在「已关」。
- `go vet ./...`、`go test ./internal/... ./cmd/...`（251 个）、`shapegen -check`、`sqlc diff`、`bun run flutter:check`（346 个）通过。
