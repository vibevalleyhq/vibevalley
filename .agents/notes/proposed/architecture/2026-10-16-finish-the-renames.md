# Agent Note: 改完旧名字，主键用 uuidv7

Status: proposed

## Problem

[概念先行](2026-10-15-concepts-first.md)和 [Run 是一次干活](2026-10-16-runs-workers-crews.md)定了代码里该叫什么，但改名是一组一组做的，代码里还混着三代名字：

- **皮的名字**：核心状态叫 `FarmState`，持有它的服务叫 `Site`，推给客户端的是 `SiteFrame`、`SiteEvent`；接口方法全叫 `Farm*`（`FarmAddIssue`、`FarmTell`……，路由 id 是 `farm.*`）；合并叫 `Harvest`；默认频道叫 `square`；存盘的文件叫 `vibevalley.db`、`state.json`。
- **改了一半的名字**：协议的 `Helper` 和 `Foreman` 已经在工作区里改成 `Worker` 和 `Manager`，但局部变量、注释、测试名还叫 `helper`、`turn`、`crew`（服务端几百处）；Flutter 的工单页还叫 `tickets`（目录、路由 `/tickets`、`TicketState`、`TicketCard`……）。
- **还没动的提案名**：`AgentProfile`、`WorkStep`、`Issue.agent`、优先级的 `normal`、工单状态的值、工单串的 `subject_kind = 'job'`。

读代码的人和 agent 会从这些名字去猜实际的事，概念文档的对照表也越写越长。

[只有一份表结构，不认旧数据](../../implemented/architecture/2026-10-16-one-schema-no-old-data.md)已经定了不留兼容：存盘的格式只认现在的名字，改名就直接改。本文按这条把剩下的名字改完。

## Proposal

### 线上和存盘的名字一起改

- 线上的名字（JSON 键、枚举值、路由）、存盘的名字（表里存的值、文件）和 Go、Dart 的名字，在同一步里改齐，不留旧名的读法。
- 经院门连进来的手机和桌面版一起升级。
- [Run 是一次干活](2026-10-16-runs-workers-crews.md)第 4 步里「旧数据这样搬」那一段已经被[只有一份表结构](../../implemented/architecture/2026-10-16-one-schema-no-old-data.md)取代，在第 8 步删掉。

**表结构直接改 `0001_schema.sql`**：`0001` 还没推到远端，这一轮改名做完之前，表的改动都直接并进它，不写 `0002`。SQLite 改 `check` 要重建表，而 `base/db.go` 已经不支持重建；`0001` 推出去以后，才照[只有一份表结构](../../implemented/architecture/2026-10-16-one-schema-no-old-data.md)在它后面加新文件。这一轮里开发用的家目录每一步都可能打不开：先把它移走，从空的开始。

### 主键用 uuidv7

现在的 id 有四套：帮工是 `w3`（`fmt.Sprintf("w%d")`），工单是 `t` 加 8 位随机码（`t` 是 ticket 留下的），计划是 `p1`，计划里的一步是 `p1.key`；频道、消息、定时、run、账本这些是 SQLite 的自增整数。这些 id 有的要数现有的最大值，有的要拼字符串，协议里也一半是 `string`、一半是 `int64`。

- **运行时新建的行，主键都是 uuidv7**：工单、帮工、run、频道和串、消息、定时、账本、记性、计划的经过、连接器的发件、院门的设备。由 `base.NewID()` 生成（`github.com/google/uuid` 的 `NewV7`，同一个进程里单调递增），存成 `text`。
- **消息不再有 `seq`**：uuidv7 按时间排序，已读位置、`seen_mark`、投递都改用消息的 id 比先后。
- **不改的**：从文件来的自然键（agent 档案、技能、项目、农机、连接器）；单例（参与者里的 `user`、`manager`、`system`，`lan_gate`）；由几列组成的主键（`mention`、`follow`、`read_cursor`、`seen_mark`、`delivery`、`connector_inbound`）。
- **工单另有一个顺序号 `number`**：从 1 开始，写下时取最大值加一，唯一。界面上显示成 `#12`，管家的工具也用它指工单和计划，不用把 36 位的 uuid 抄来抄去。计划就是父工单，不再有 `p1`；计划里的一步是有自己 id 的子工单，步骤名在 `step.key` 里。
- **协议里的 id 都是 `string`**：`Issue.Schedule`、频道 id、run id、消息 id 都从 `int64` 改成 `string`。

### 改成什么

农场的叫法只留在画面、游戏规则和界面文字里：`FarmView`、`FarmLevel`、`PlotView`、`Crop`、账本和成就里的 `Harvested`、地（`station`、`bed`）、Flutter 的 `farm/`、`village/` 都是皮，不改。smith（`server/pkg/smith`）照 oar 起名，不改。

| 现在 | 改成 | 说明 |
|---|---|---|
| `FarmState` | `CoreState` | 文档里一直叫「核心状态」；不叫 `State`：Dart 里和 Flutter 的 `State` 撞 |
| 服务 `Site`（包 `site`） | `Core`（包 `core`），`f.Core.Apply` | 不叫 `state`：好几个服务里有叫 `state` 的局部变量 |
| `SiteFrame`、`SiteEvent*`；文档里的「工地事件」 | `StateFrame`、`SideEvent*`；「事件流」 | Flutter 原来的 `StateFrame`（帧加上字节数和解码耗时）改叫 `ReceivedFrame` |
| `GET /api/site/state`、`/api/site/events` | `GET /api/state`、`/api/events` | |
| 计划经过的 actor `farm`（`PlaybookActorFarm`） | `system` | 参与者里本来就有 `system` |
| 路由 id `farm.*`、方法 `Farm*` | 按概念：`issue.add` → `IssueAdd`，`worker.tell`、`playbook.plan`、`channel.open`、`schedule.add`、`agent.save`、`runtime.refresh`、`project.create`、`manager.remember`、`setting.save`、`progress.carry`、`server.health` | 前缀是拥有它的包，单数 |
| `FarmSchedule`、`FarmRefused`、`FarmMissing` | `Schedule`、`Refused`、`Missing` | |
| `AgentProfile` | `Agent` | |
| `WorkStep`；`StepKind` 的 `asked`、`said`、`tool`、`problem` | `Activity`；`prompt`、`response`、`action`、`error` | 不叫 `Step`：计划里的一步已经是 `IssueStep` |
| `Issue.agent` | `Issue.assignee` | |
| `PriorityNormal`（`normal`） | `PriorityMedium`（`medium`） | |
| `IssueStatus`：`todo`、`queued`、`working`、`waiting`、`closed` | `backlog`、`todo`、`in_progress`、`in_review`、`done`、`canceled` | `done`、`canceled` 由关单的原因算出 |
| `IssueClose`：`harvested`、`merged` | `merged`、`merged_into_plan` | `dismissed`、`lost`、`answered` 不变 |
| `Issue.Harvest`、`project.HarvestFailure`、`HarvestInto`、`HarvestBranch` | `Issue.Merge`、`MergeFailure`、`MergeInto`、`MergeBranch` | |
| `InboxKindHarvest`、`PlaybookActionHarvest`、`PlaybookEventKindHarvested` | `merge`、`merge`、`merged` | |
| `POST /api/workers/{id}/harvest` | `POST /api/workers/{id}/merge` | |
| `ConversationKindSquare`（`square`）、`SquareOf`、`DeliveryReasonSquare` | `general`、`GeneralOf`、`DeliveryReasonGeneral` | 界面上照旧叫田头 |
| `subject_kind = 'job'` | `'issue'` | |
| `vibevalley.db`、`state.json` | `vibevalley.db`、`state.json` | |
| 帮工 `w3`、工单 `t…`、计划 `p1`、步骤 `p1.key`、自增整数 | uuidv7；工单另有 `number` | 见上面「主键用 uuidv7」 |
| Flutter `desk/tickets/`、`/tickets`、`TicketsPage`、`TicketCard`、`ticket*()` | `desk/issues/`、`/issues`、`IssuesPage`、`IssueCard`、`issue*()` | |
| Flutter `TicketState`、`ticketState()` | `IssueTag`、`issueTag()` | 看板的列已经直接读 `Issue.status`；它只把状态和关单原因换成标签和颜色 |
| Flutter `farmProvider`、`farmApiProvider`、`FarmApi` | `stateProvider`、`apiProvider`、`Api` | 只改读核心状态和接口的，`FarmPanel` 这类画面不改 |
| 局部名 `helper`、`helperID`、`byHelper`、`turn(s)`、`turnsOf`、`crew`、`lastForemanSaid`、`TurnSteps` | `worker`、`workerID`、`byWorker`、`run(s)`、`runsOf`、`workers`、`lastManagerSaid`、`RunSteps` | 指 oar turn 的（`oar.TurnStarted`、`report.Turn`）不改 |
| 测试名 `TestTicket*`、`farm_*_test.dart` 里讲工单的 | 照概念改 | |

### 用什么工具改

不用全局的 `sed`：`helper`、`turn`、`square`、`station` 在 smith、皮和字符串里都有别的意思。三种工具各管一层：

- **Go：gopls**。`gopls rename -w <file>:<line>:<col> <New>` 按类型改全部引用，包括 `gen.go` 和测试。已经试过：`PriorityNormal` 改成 `PriorityMedium`，用 `-d` 预览，结果改了 `shapes.go`、`gen.go`、`plan_issues.go`、`issue.go` 和 `work_test.go`，没碰字符串。gopls 不改 JSON 标签、枚举的字符串值和注释，这三样在 `shapes.go` 里手改，再跑 `shapegen`。包改名（`site` → `state`）也用 gopls 改包声明和 import。
- **Dart：生成的代码 + 编译器**。ast-grep 0.45 没有内置 Dart 语法（`-l dart` 什么都匹配不到），要用它就得自己编 tree-sitter-dart 再写 `customLanguages`，不值得。办法是：
  1. `shapegen` 重写 `lib/gen`，旧名在 Dart 里一下子都成了编译错误。
  2. `flutter analyze` 列出的错误就是要改的地方。像 `AgentProfile` 这种只有一个意思的名字，按词边界替换；`.agent`、`helper`、`turn` 这种有歧义的名字，逐处改。
  3. 文件和目录（`desk/tickets` → `desk/issues`）用 `git mv`，再改 import。
  4. 只在 Dart 里的局部名，可以用 Dart 分析服务的 LSP 改名（`dart language-server` 的 `textDocument/rename`），也可以照第 2 步逐处改。
- **ast-grep：只做 Go 的结构性改写和最后的检查**。gopls 一次改一个符号；同一种写法要批量改时用 ast-grep 的 Go 规则，比如测试名、`t.Run("...")` 里的字符串、路由注释 `//vibevalley:route farm.x`。最后用一份 ast-grep 或 `rg` 的规则表查旧名有没有回来（见「护栏」）。

字符串值、SQL、Markdown 和界面上的字，不是标识符，用 `rg` 列出来逐处改。

### 步骤

每一步一个提交，提交前跑和它有关的检查：`go vet ./... && go test ./...`、`go run ./tool/shapegen`、`VIBEVALLEY_GOLDEN=update go test ./internal/...`（看 diff 只有名字）、`bun run flutter:check`、`bun run docs:verify`。

0. **先提交工作区里的改动**：`Helper` → `Worker`、`Foreman` → `Manager`、迁移合成一个、表名单数、查询进 sqlc。这批改动是别的会话做的；它全部检查通过后先单独提交，免得两批改名搅在一起。
1. **服务端局部名**：`helper`、`turn`、`crew`、`ticket`、`backlog` 的变量、参数、测试名和注释，不动协议。只用 gopls 和 ast-grep。
2. **合并**：`Harvest` → `Merge` 那一组，连同 `IssueClose`、Inbox、计划的值和 `/harvest` 路由。
3. **工单的 Linear 名字**：`Issue.assignee`、`PriorityMedium`、`IssueStatus` 的新值，`subject_kind = 'issue'`；Flutter 的看板按 `status` 分列。这一步改了看板的分列规则，所以给 `IssueStatus` 的规则补测试。
4. **档案和步骤**：`AgentProfile` → `Agent`，`WorkStep` → `Activity`，`StepKind` 的新值。
5. **核心状态和接口**：`FarmState`、`Site*`、`farm.*` 路由、`Farm*` 方法，包 `site` → `core`，`/api/state`，文件名 `vibevalley.db`、`state.json`；删掉 `channel/chat.go` 里从 `state.json` 搬聊天的代码。
6. **默认频道**：`square` → `general`。
6b. **主键用 uuidv7**：`base.NewID()`，`0001` 里的主键和外键改成 `text`，消息去掉 `seq`；工单加 `number`，管家的工具改用它；删掉 `NextPlaybookID`、`StepIssueID` 和数 `w` 后面数字的代码；协议的 id 改成 `string`。
7. **Flutter 的工单页和局部名**：`desk/tickets` → `desk/issues`、`/tickets` → `/issues`，`farmProvider` 那一组，`helper`、`turn`、`foreman`、`crew` 的局部名。官网 `site/` 里的截图名 `phone-tickets` 跟着改。
8. **文档和 Note**：[concepts.md](../../../../docs/concepts.md) 去掉「代码里有些名字还跟着皮走」那段；[用语表](../../../../docs/README.md#用语)的「代码里」一列；[concept-map.md](../../../../docs/reference/concept-map.md)、[architecture.md](../../../../docs/architecture.md) 的存储表、[server.md](../../../../docs/reference/server.md)；`implemented/` 里提到旧名的 Note 只改事实。[概念先行](2026-10-15-concepts-first.md)第 9 步和 [Run 是一次干活](2026-10-16-runs-workers-crews.md)第 4 步标成已做。
9. **护栏**：加一个检查（`scripts/stale-names.ts`，挂进 `bun run docs:verify` 或单独的 `bun run names:verify`），在 `server/internal`、`server/cmd`、`app/lib`、`app/test` 里查一张旧名表；`pkg/smith`、`game`、`farm/`、`village/` 和界面文字有白名单。

步骤 2–6b 都改协议，每一步都要重跑 `shapegen` 和 `flutter:check`；Flutter 那边只修到能编译，名字的清理留到第 7 步。

### 不在这里做

- 给编码 agent 的 MCP 服务名 `farm` 和工具名的前缀 `farm_`（`farm_say`、`farm_who`……）：这是 agent 看到的接口，有的农机不给 MCP 工具加命名空间，前缀可能是为了这个；改之前先查清楚各农机的做法，另议。
- 帮工的阶段 `ripe`、计划的 `ripe` 和配对设备看到的 `LanStatus.farm`（农场的名字）：都是画面上的叫法进了协议，等核心状态拆成两份时再看。

- 核心状态拆成两份，金币、成就、地块挪进画面（[概念先行](2026-10-15-concepts-first.md)第 8 步）：这一项改的是结构，不只是名字。
- 包着 oar 的部分挪进 `runtime`（[Run 是一次干活](2026-10-16-runs-workers-crews.md)第 2b 步）和小队。
- 管家是一个 agent（概念先行第 7 步）。

## Alternatives considered

**全局的 `sed` 或 `rg --replace`**：最快。没选：`helper`、`turn`、`square`、`station`、`harvest` 在 smith、游戏和界面文字里都是对的，盲目替换要再花更多时间找回来。

**给 ast-grep 编 Dart 语法**：Dart 也能做结构性改写。没选：生成的 `lib/gen` 改了名，编译器就把每个调用处都找出来了，剩下的局部名不多，不值得维护一份自编的语法。

**一个提交改完**：少几轮检查。没选：协议、存储、Flutter、文档一起改，出错时看不出是哪一组。

**`FarmState` 改叫 `State`、`CoreState`**：`State` 在 Dart 里和 Flutter 撞；`CoreState` 说的是地位，不是它装的东西。

## Acceptance criteria

- 第 9 步的检查在 `server/internal`、`server/cmd`、`app/lib`、`app/test` 里找不到旧名表里的名字。
- 线上和存盘里没有 `farm.*` 路由、`/api/site`、`helper`、`foreman`、`square`、`job`、`normal`、`harvested` 这些键和值；家目录里是 `vibevalley.db`、`state.json`、`workers.json`、`manager/`。
- 看板按 `Issue.status` 分列，Flutter 只把它换成标签。
- `go vet ./... && go test ./...`、`bun run flutter:check`、`bun run docs:verify` 通过；重录后黄金数据的 diff 只有名字和值的改名。
- 用语表的「代码里」一列和代码一致，概念文档里没有「还跟着皮走」的名字。

## Risks

- **旧家目录打不开**：改了存盘的名字（`vibevalley.db`、`state.json`、表里的值）以后，旧的工单、聊天、轨迹都不搬。开工前把 `$VIBEVALLEY_HOME` 整个备份一份；新的家目录从空开始。
- **黄金数据**：改了枚举值，重录会重写全部黄金数据，规则的改动可能混在名字里看不出来。所以第 3 步改状态的规则和改名分成两个提交：先改名，后改规则。
- **uuidv7 的先后**：已读位置和投递靠消息 id 比先后。同一个进程里 `NewV7` 单调递增；如果系统时钟往回调，重启后新消息可能排在旧消息前面。只有一个人在本机用，接受这个风险。
- **漏掉字符串**：gopls 和编译器只管标识符；JSON 键、SQL 里的值、`switch` 里的字符串、界面上拼出来的路由（`'/tickets/${…}'`）都要用 `rg` 查。第 9 步的检查兜底。
- **和正在做的工作冲突**：改名碰的文件多，别的分支和 worktree 里的帮工会大面积冲突。每一步开工前确认没有别的活在改同一片代码。
