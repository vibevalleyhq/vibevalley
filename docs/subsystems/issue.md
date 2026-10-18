# 工单

一件活从写下到关上是一张工单（`Issue`），农场里是一块地。代码相关的工单带一个 worktree 和一条分支；帮工（Session）在这块地上干活，可以换人，地不换。工单按三段走：**聊清楚**、**安排活**、**完成**；每张工单都有一道验收，过了才算结果。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 工单的模型、状态和能挪到哪 | 帮工怎么跑一轮、事件日志（[帮工](docs/subsystems/session.md)） |
| 派活、排队、重开、取消 | 挑哪个档案（[管家](docs/subsystems/manager.md)） |
| 验收、草、缺肥 | 汇报怎么读（`session/rules.go` 读出「结论：」和「要问主人：」交给它） |
| 收获：查冲突、跑检查、本地合或提 PR | 项目和工作目录、worktree 的 git 操作（`internal/project`，[项目](docs/subsystems/project.md)） |
| 工单在看板和农场上的样子由它的状态决定 | 怎么画（[farm-ui.md](docs/reference/farm-ui.md)「地里长什么」、`shared/issue_view.dart`） |
| | 种植计划里的工单（跟着计划走，[种植计划](docs/subsystems/task.md)）；派给管家的工单（管家答完就关） |

## 在哪

- 服务端 `server/internal/issue`（`issue.Service`）：`issue.go` 存取和核心状态、`status.go` 转换表、`dispatch.go` 派活和重开、`queue.go` 排队、`actions.go` 带话和取消、`acceptance.go` 验收和缺肥、`merges.go` 收获和冲突、`pull_request.go` PR 的轮询、`history.go` 执行历史、`manager.go` 派给管家的工单。worktree、检查、推送和 `gh` 的 git 操作在 `server/internal/project`。
- 规则在 `protocol`：`IssueStatusOf`（状态怎么算）、`PlotOf`（地的样子）；只有工单用的规则在 `issue` 里不导出（`statusMove`）。
- 表：`issue`（一张工单一行）、`issue_session`（哪些 Session 干过它）、`issue_queue`（排队的上下文）。
- 接口：`issue.*`（[capabilities.md](docs/reference/capabilities.md)）；命令行 `vibevalley issue …`。
- 客户端：看板 `workbench/issues`，详情是农场和工作台共用的 `shared/issue_view.dart`。

## 模型和不变量

- **一张工单一个 id**，从写下到关上不变；重开是同一张工单的下一个帮工，不是新工单。
- **状态六个**，和 Linear 一样：`backlog`、`todo`、`in_progress`、`in_review`、`done`、`canceled`。只存主人的意思（排没排上队 `queued_at`、怎么关的 `closed`），帮工那一半（在做、交回来了）从核心状态里帮工的阶段算，不另存一份。
- **数据库是家，核心状态有一份**：开着的和最近关的 50 家在 `CoreState.Issues`，`issue` 服务每改一次库就施加一条 `issue` 事实；客户端只读核心状态。
- **主人只挪到 `backlog`、`todo`、`done`、`canceled`**；`in_progress`、`in_review` 是帮工干出来的。每张工单的 `moves` 由服务端算出现在能挪到哪，看板和地块详情照它，不在 Dart 里重写规则。
- **一块地最多一个 worktree**：代码活的分支是 `vibevalley/issue-<号>`，worktree 是 `worktrees/<项目>.<号>`；重开、换帮工、重启都还是这一块。
- **每张工单都有验收**：`in_review` 就是「等验收」。`acceptance` 是 `glance`（收获本身就算验收）或 `required`（没通过 `acceptedAt` 以前不能收获）。
- **派给管家的、种植计划里的工单 `moves` 是空的**，验收和挪状态都拒绝。
- **子工单**带 `parent`、`blockedBy`：种植计划用它，计划里的工单跟着计划走，看板不能单独开工、重开。
- **还没派的能改、能删、能排先后**；派出去以后只能改验收方式。交给帮工的是标题，空一行，再是说明。
- **排队的上下文和排队一起提交**：首次派发的频道和 `RunTrigger`（定时的 id、是不是补跑）写进 `issue_queue`，和 `issue.queued_at` 同一个事务；重试照它恢复来源，开工成功时同一个事务清掉。

## 怎么走

**三段和状态**：

| 段 | 状态 | 地里 |
|---|---|---|
| 聊清楚 | `backlog`；帮工问了主人还没答是「缺肥」（`asks`） | 荒地；缺肥是干裂 |
| 安排活 | `todo`（种子袋，排队等空地）→ `in_progress` | 播种、发芽、长叶；验收没过修的时候是「除草中」 |
| 完成 | `in_review`（等验收）→ 验收过了 → `done` | 开花；没过是杂草（一条意见一棵）；过了结果；收获后是麦茬 |

**挪状态就是派活**（`issue.status`，转换表在 `status.go` 的 `statusMove`）：

| 挪到 | 从 | 做的事 |
|---|---|---|
| 待办 | 备选 | 派给档案；地都占满了就在待办排队，服务端每 5 秒按先后试一遍 |
| 待办 | 等验收 | 带一句话（必填）再干一轮 |
| 待办 | 已完成、已取消（派过的） | 重开：同一个档案派一个新帮工，告诉它原来要做什么、上次怎么关的、分支上有没有上次的提交 |
| 备选 | 待办；没派过就取消的 | 不排了；挪回备选 |
| 已完成 | 等验收 | 收获（见下）；`required` 且没通过时不在 `moves` 里 |
| 已取消 | 在做、等验收；备选、待办 | 叫帮工回家，或没派过的直接关上；分支上有提交就留着 |

**排队的待办马上开工**（`issue.start`，农场播种袋的「开工待办」）：只收排着队的待办；有空就照它排队时记下的来源开工，没空就留在队里原来的位置、说为什么，不重新排。和后台每 5 秒的重试共用一把锁，不会派两次。

**验收**（`issue.accept`）：通过记下 `acceptedAt`，原来的草都拔掉；没过至少一条意见，每条记成一棵草，还没拔的草编号写成一句话交给帮工再修一轮。新的一轮开始（带话、再干一轮）验收作废，草留着，下一次通过才拔。管家用 `accept` 工具也能验，收获照旧要主人说一声。

**缺肥**：帮工汇报里「要问主人：」开头的行，`readReport` 读出来放进 `FactReport.Asks`，工单服务记到 `asks`；主人带一句话就算回答，问题清掉。

**收获**（挪到已完成）：

1. 还在干的不收；关掉会话，没提交的改动替它提交（缓存和依赖目录不提交）。
2. 会冲突就不合：标上 `conflict`，「让它解决冲突」发一句固定的话（`ConflictTask`）交回帮工，在自己的分支上把主分支合进来，下一轮结束时再查。
3. 跑项目的检查：帮工分支上的 `.vibevalley/check`，在 worktree 根目录、项目锁外跑，没有这个文件就跳过；本地合的先把主分支合进帮工分支再检查，PR 和种植计划检查帮工当前的分支。退出码非 0、跑不起来或超时（`project.check_timeout_seconds`，默认 1200）都不合，输出的最后 40 行附在拒绝里交给帮工修。工单留在 `in_review`，帮工、分支、worktree 都在。
4. 进锁以后确认分支没在检查后变过、重新查一次冲突、主分支没有没检查过的提交，才合：
   - **本地合**（项目不在 `github.pr_projects` 里，或 `pullRequest.available` 为假）：合进项目克隆的主分支，删掉 worktree 和分支，帮工离开，账本记 `harvested`。
   - **提 PR**：农场 `git push -u origin <工单分支>`，用工单标题、编号、帮工最后一轮的「结论：」那一段（找不到就放最后一轮原话）和检查结果开 PR；已有开着的 PR 只推分支，开完没存下回执的重试先查已有的 PR。推送或 `gh` 失败就拒绝这次收获。`pullRequest` 记 `url`、`number`、`state`；PR 开着时工单留在等验收，再干一轮再收获更新同一个 PR。

**PR 的结局**：农场每 `github.pr_poll_seconds` 秒（默认 180，`github refresh` 手动）查开着的 PR：合了关成 `merged`、没合就关掉关成 `dismissed`，清掉 worktree 和本地分支，帮工离开；帮工还在干或有待开始的一轮就留着现场，下次再结。远端分支归 GitHub。开新分支或结束 PR 前先 `git fetch origin <主分支>` 快进本地主分支，不干净或不能快进就保留本地的、记日志。

**收工**：关掉会话、帮工离开；分支上有没合的提交就留着，重开接着做。

## 和谁打交道

- **帮工（`session`）**：派活经 `Session.Send` 开一个 Session；帮工离开（`FactLeft`）时，离开的是最后一个就关上工单；汇报（`FactReport`）带来缺肥的问题。
- **项目（`project`）**：worktree、分支、冲突预检（`git merge-tree`，不碰工作区）、检查和合并、推送和 `gh`；工单服务只决定什么时候做。
- **田头（`channel`）**：派活时在频道里开工单串，一张工单一个串，重开、换帮工都在这个串里（[田头](docs/subsystems/channel.md)）；带话和验收没过的意见经它交给帮工。
- **定时（`schedule`）**：一个定时一张工单，到点是它的一次干活（[定时](docs/subsystems/schedule.md)）。
- **种植计划（`task`）**：计划是带 `graph` 的父工单，每一件是带 `task` 的子工单，跟着计划走，不归这里的转换表。
- **管家（`tool`）**：派活、带话、验收、收获都是同一个服务的方法，收获要主人说一声。
- **GitHub 检测（`setting`、`project`）**：开机查 `gh` 装没装、登没登录（`github.status`、`github.refresh`），项目查 origin 是不是 GitHub、有没有写权限，结果缓存在 `Project.pullRequest`；收获只读缓存决定走哪条路。
- **农场的皮（`protocol.PlotOf`、`game`）**：`FarmView.Plots` 按工单做键（`PlotKey`），地的样子看工单和地上帮工的阶段；农具直接调 `issue.status`、`issue.comment`、`issue.accept`，不经帮工找工单；仓库是关成 `merged` 的工单。游戏只读事实算画面和账本，不调工单。

## 为什么这样

- **工单是服务端的一样东西，帮工挂在它下面。** 原来「工单」是客户端从帮工的轨迹拼出来的，重开换 id、几台设备各看各的。放弃了「接回原来的会话来重开」：分支合了、会话可能过期，新派一个帮工、把该知道的写给它，任何一种关法都能用。叫 `Issue` 不叫 `Ticket`，和 Linear、GitHub、Multica 一致，界面上叫工单。
- **状态只存主人的意思，帮工那一半现算。** 存一份完整的状态，帮工半路死掉、农场重启时都要对一遍，违反「核心状态只有一份」；现算的话帮工离开，工单自己回到主人定的那一列。
- **挪状态就是派活，一个接口 `issue.status`。** 原来是 start、unqueue、merge、cancel、reopen 五个动作，主人看到的是列、要做的是动作；看板、命令行、管家都得记哪个动作挪到哪。放弃了「只在拖卡片时翻译成动作」：只有客户端受益，规则写在 Dart 里。in_progress 不让主人挪进去：和挪到待办只差没空地时怎么办，多一个入口没换来什么。
- **一块地是一张工单，不是帮工的位置。** 地跟着帮工走时，重开的工单换地、地块详情和工单详情两页、工具要先找帮工再找工单。也没选「地是 worktree」：主人派的、看的、收的都是工单，worktree 只是代码活的一部分。
- **每张工单都有验收，`in_review` 收窄成「等验收」。** 没有这一关，「交回来」和「做完了」分不开，地的阶段也没法标；没加新状态，因为它和 `in_review` 是同一件事。缺肥从帮工汇报里固定的一行读，不让管家读工单串去判：帮工最清楚自己缺什么，固定的开头读得准，不调模型。草整批拔：汇报里读不准修了哪几条，下一次通过就都拔。
- **一张工单一条分支、一个 worktree，跟着工单不跟着帮工。** 按帮工开时，取消后重开的帮工不在原来的分支上接着干，旧 worktree 还会留着，一张工单两个 worktree。约束放进 `project.Workplace`：按工单开，有就复用，不靠调用方记着。
- **合并在不碰工作区的地方预检，冲突交回帮工。** 遇到冲突再中止要碰主人的工作区；冲突交给主人在终端里解决，不如让最清楚改动的帮工解决、跑测试、说清怎么取舍。
- **检查写在仓库里（`.vibevalley/check`），在锁外跑。** 写在项目设置里会和代码分开，帮工也看不见合并时跑什么。在锁里跑会让同一个项目几分钟开不了新 worktree；锁外跑、进锁再核对分支没变。
- **能提 PR 的项目一律提 PR，开关 `github.pr_projects`。** 本地合和提 PR 都可选会有两套状态，主分支有时在本地动、有时在 GitHub 上动，农场的克隆和 origin 迟早分叉。帮工自己不 push：推送和开 PR 留给农场，帮工照旧只在工作目录里提交。

## 还没做的

- 几个人一起种、派一个看地的、验收标准逐条打勾：[一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)。
- 肥料袋和稻草人的农具：现在施肥是带话，验收在地块详情里点。

## 怎么验证

- `issue/status_test.go` 的 `TestStatusMoves`：每个状态能挪到哪，`required` 没通过时没有 `done`，管家的和计划里的什么都挪不了。
- `workspace/work_test.go`：`TestMovingAnIssueIsTheWork`（挪状态走完开工、再干一轮、收获、取消再挪回）、`TestAPlotGrowsThroughItsAcceptance`（缺肥 → 回答 → 等验收 → 没过长草 → 修 → 通过 → 收获）、`TestIssueClosesAndReopens`。
- `project` 的测试用真的 git 仓库测按工单复用 worktree、锁外检查、PR 的推送和轮询（`pull_request_test.go`）。
- `protocol` 的 `TestAPlotShowsItsIssuesAcceptance`、`TestPlotsAreKeyedByTheirIssue`；客户端的 `test/shared/issue_view_test.dart`。
