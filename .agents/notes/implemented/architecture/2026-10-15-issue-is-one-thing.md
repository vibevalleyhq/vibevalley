# Agent Note: 工单是一样东西

Status: implemented

## Problem

[一次种植是一张工单](../feature/2026-10-14-tickets.md) 当初决定「工单就是帮工的轨迹，不另建一样东西」。这在一张工单只对着一个帮工时够用，可是工单其实分在三处：

- 写下来还没派时，是待办表里的一行，有自己的 id；
- 派出去以后，变成帮工和它的轨迹头，id 换成了帮工的 id；
- 重开的话，又是一个新帮工、新 id，两个轨迹头互相记着，一张只能重开一次。

工单处在什么状态，是客户端从待办、帮工的阶段、轨迹头里推出来的。主人看了说「工单还不是一个东西」。照 [概念先行](../../proposed/architecture/2026-10-15-concepts-first.md)，工单是 VibeValley 最核心的概念（和 Multica、Linear 的 issue 一样），应该是一样东西。

## Decision

行为见 [server.md](../../../../docs/server.md)「工单」和 [concepts.md](../../../../docs/concepts.md)。

- **工单是服务端的一样东西**：代码里叫 `Issue`（服务 `Issues`，`server/internal/tickets/issues.go`），界面上叫工单。它从写下到关上始终是同一个 id，带着要做什么、项目、帮工档案、优先级、排的先后、什么时候排上队、什么时候怎么关的、属于哪个计划。
- **执行挂在工单下面**：每派一次帮工是这张工单的一次执行（`runs`，帮工 id，旧的在前）。直接派的活（管家、计划）在 `Dispatch.Hire` 里各开一张新工单，id 是 `t` 加 8 位。
- **重开是同一张工单的下一次执行**：不再生新 id、不再有「只能重开一次」。合进了计划分支的工单跟着计划走，仍然不能单独重开。
- **状态由服务端算**（`protocol.IssueStatusOf`，纯函数）：`todo`、`queued`、`working`、`waiting`、`closed`，和 Linear 的状态分类对得上。看板只读它；关了的怎么关的（收获、合进计划、收工、丢了）照 `closed`。
- **工单随最后一次执行关上**：`Issues` 听帮工离开的事实（`FactLeft`，带着怎么关的），离开的是最后一次执行就关上工单。`Crew` 不知道工单，只把 `HireOptions.Issue` 记在帮工和轨迹头上。
- **存在数据库**：`issue` 表和 `issue_run` 表（表名用单数）。查询用 sqlc 生成（[查询由 sqlc 生成](2026-10-15-sqlc-queries.md)）。当初不进核心状态、看板隔几秒问一次；后来被 [工单进核心状态](2026-10-15-issues-in-core-state.md) 取代。
- **老数据迁过来**：迁移 `0006_issue.sql` 把待办表搬进 `issue`（id 不变）。轨迹头在文件里，所以开机时由 `Issues.adopt` 收：头上记着工单的进那张，从前重开出来的进原来那张，其余各自一张、id 用帮工 id。跑几遍都一样。迁移前数据库先复制一份到 `farm.db.v<N>`。
- **找工单可以用帮工 id**：`GET /api/issues/{id}`、重开、看板的 `/tickets/<id>` 都认工单 id 和它任何一次执行的帮工 id，农场和地图上从帮工点进来照样打开它的工单。

## Alternatives considered

**保持「工单就是轨迹」，只在客户端把链拼起来。** 改动最小，但状态还是客户端推，id 还是会变，管家和别的设备看不到同一张工单。

**重开时接回原来的帮工。** 原来的分支收获以后已经合进主分支、删掉了，会话也可能过期；新派一个帮工、把该知道的写进去，任何一种关法都能用。这一点沿用原来的决定，只是新的帮工挂在同一张工单下。

**把工单放进核心状态。** 几台设备能马上看到变化，但工单会越积越多，每个事实都要带着它；工单的状态又可以从核心状态里的帮工算出来，没必要再存一份。

**叫 `Ticket`。** 主人起初说 ticket。Linear、GitHub、Multica 都叫 issue，状态分类也照 Linear，代码里用 `Issue` 和这些工具的说法一致；界面上的「工单」不变。

## Consequences

- 看板不再拼待办和轨迹，一张卡片就是一张工单；卡片上显示做过几次（「第 N 次」），详情里列出每次执行，干活过程显示最后一次的。
- 工单的状态曾经跟着看板的轮询走，最多晚 3 秒；工单进了核心状态以后又是实时的。
- 从前重开出来的那些帮工 id 仍然能打开工单，但轨迹头上的 `reopenedFrom`、`reopenedAs` 只留给老数据，新的不再写。

## Verification

- `server/internal/protocol/issues_test.go`：状态怎么算。
- `server/internal/farm/crew_test.go`：`TestCrewIssueClosesAndReopens`（随最后一次执行关上、用帮工 id 或工单 id 重开、同一张工单两次执行、重开交给帮工的文字、开着的和合进计划的不能重开）；`TestCrewIssueWrittenDownStarts`（写下、改、开工、开工后不能再改、排先后）；`TestCrewIssueWaitsForAFreeBed`（排队、有空地自己开工、手动排上拿出）；`TestCrewIssueAdoptsTheRunsOfBefore`（老的轨迹头按重开的链收成工单，重启后不重复）。
- `app/test/tickets_test.dart`：看板读 `/api/issues`，用帮工 id 打开它的工单，重开发到 `/api/issues/{id}/reopen`。
