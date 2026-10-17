# Agent Note: 改完旧名字，主键用 uuidv7

Status: proposed

## Problem

[概念先行](2026-10-15-concepts-first.md)和 [Run 是一次干活](2026-10-16-runs-sessions-crews.md)定了代码里该叫什么。2026-10-17 已经把大部分名字改完：核心状态 `CoreState`、服务 `Core`、路由按概念（`issue.*`、`session.*`、`agent.*`……）、协议里 `Agent`、`Session`、`Run`、`Merge`、`PriorityMedium`、`IssueStatus` 的 `backlog`…`canceled`、默认频道 `general`、家目录 `sessions.json`。

还剩两处：

- **主键还是老的**：工单是 `t` 加 8 位随机码（`base.Code`），计划是 `p1`，频道、消息、定时、run、账本用 SQLite 自增整数；协议里一半 `string`、一半 `int64`；消息还有 `seq`。
- **Flutter 还叫 tickets**：`desk/tickets`、`/tickets`、`TicketsPage`、`TicketCard`、`TicketState`，还有读核心状态的 `farmProvider`、`FarmApi`。

没有护栏：旧名字回来时没有检查会报。

## Proposal

### 主键用 uuidv7

- **运行时新建的行，主键都是 uuidv7**：工单、Session、run、频道和串、消息、定时、账本、记性、计划的经过、连接器的发件、院门的设备。由 `base.NewID()` 生成（`github.com/google/uuid` 的 `NewV7`，同一个进程里单调递增），存成 `text`。
- **消息不再有 `seq`**：uuidv7 按时间排序，已读位置、`seen_mark`、投递都改用消息的 id 比先后。
- **工单另有一个顺序号 `number`**：从 1 开始，写下时取最大值加一，唯一。界面上显示成 `#12`，管家的工具也用它指工单和计划，不用把 36 位的 uuid 抄来抄去。计划就是父工单，不再有 `p1`；计划里的一步是有自己 id 的子工单，步骤名在 `step.key` 里。
- **协议里的 id 都是 `string`**：`Issue.Schedule`、频道 id、run id、消息 id 都从 `int64` 改成 `string`。
- **不改的**：从文件来的自然键（agent 档案、技能、项目、农机、连接器）；单例（`user`、`manager`、`system`、`lan_gate`）；由几列组成的主键（`mention`、`follow`、`read_cursor`、`seen_mark`、`delivery`、`connector_inbound`）。
- **表结构**：`0001` 已经推出去以后，照[只有一份表结构](../../implemented/architecture/2026-10-16-one-schema-no-old-data.md)在它后面加迁移；旧的家目录不搬，开发用的先移走，从空的开始。

### Flutter 的名字

- `desk/tickets/` → `desk/issues/`，路由 `/tickets` → `/issues`，`TicketsPage` → `IssuesPage`，`TicketCard` → `IssueCard`，`ticket*()` → `issue*()`。
- `TicketState` → `IssueTag`，`ticketState()` → `issueTag()`：看板的列已经直接读 `Issue.status`，它只把状态和关单原因换成标签和颜色。
- `farmProvider` → `stateProvider`，`FarmApi` → `Api`（`apiProvider` 已经叫这个名字了）；只改读核心状态和接口的，`FarmPanel` 这类画面不改。
- 局部名 `helper`、`turn`、`foreman`、`crew` 的清理。

### 用什么工具改

- **Go：gopls**。`gopls rename -w <file>:<line>:<col> <New>` 按类型改全部引用，包括 `gen.go` 和测试；JSON 标签、枚举的字符串值和注释它不改，手改完再跑 `shapegen`。
- **Dart：生成的代码 + 编译器**。`shapegen` 重写 `lib/gen`，旧名成了编译错误，`flutter analyze` 列出的就是待改处；文件和目录用 `git mv`，再改 import。
- **ast-grep：批量的结构性改写和最后的检查**。同一种写法要批量改时用它的 Go 规则，比如测试名、`t.Run("...")` 里的字符串。

字符串值、SQL、Markdown 和界面上的字不是标识符，用 `rg` 列出来逐处改。

### 护栏

加一个检查（`scripts/stale-names.ts`，挂进 `bun run docs:verify`），在 `server/internal`、`server/cmd`、`app/lib`、`app/test` 里查一张旧名表；`pkg/smith`、`game`、`farm/`、`village/` 和界面文字有白名单。

### 不在这里做

- MCP 服务名 `farm` 和工具名的前缀 `farm_`（`farm_say`、`farm_who`……）：这是 agent 看到的接口，有的农机不给 MCP 工具加命名空间；改之前先查清楚各农机的做法，另议。
- 帮工阶段的 `ripe`、计划的 `ripe` 和配对设备看到的 `LanStatus.farm`：都是画面上的叫法进了协议，等核心状态拆成两份时再看。
- 核心状态拆成两份（[概念先行](2026-10-15-concepts-first.md)第 8 步）、包着 oar 的部分挪进 `runtime`（[Run 是一次干活](2026-10-16-runs-sessions-crews.md)）、管家是一个 agent（概念先行第 7 步）：改的是结构，不只是名字。

## Alternatives considered

**全局的 `sed` 或 `rg --replace`。** 最快。没选：`turn`、`station`、`harvest` 在 smith、游戏和界面文字里都是对的，盲目替换要再花更多时间找回来。

**给 ast-grep 编 Dart 语法。** Dart 也能做结构性改写。没选：生成的 `lib/gen` 改了名，编译器就把每个调用处都找出来了，剩下的局部名不多，不值得维护一份自编的语法。

**一个提交改完。** 少几轮检查。没选：协议、存储、Flutter、文档一起改，出错时看不出是哪一组。

**主键用自增整数，再给工单一个号。** 改动最小。没选：跨表、跨农场导数据时整数 id 会打架，协议里也还得区分 `int64` 和 `string`；uuidv7 带时间、同一进程里单调，两样都省了。

## Acceptance criteria

- 第 9 步的检查在 `server/internal`、`server/cmd`、`app/lib`、`app/test` 里找不到旧名表里的名字。
- 运行时新建的行都是 uuidv7，消息没有 `seq`，协议里没有 `int64` 的 id，工单有 `number`。
- Flutter 没有 `desk/tickets`、`TicketState`、`farmProvider`、`FarmApi`。
- `go vet ./... && go test ./...`、`bun run flutter:check`、`bun run docs:verify` 通过。

## Risks

- **uuidv7 的先后**：已读位置和投递靠 id 比先后。同一个进程里 `NewV7` 单调递增；如果系统时钟往回调，重启后新消息可能排在旧消息前面。只有一个人在本机用，接受这个风险。
- **漏掉字符串**：gopls 和编译器只管标识符；JSON 键、SQL 里的值、`switch` 里的字符串、界面上拼出来的路由（`'/tickets/${…}'`）都要用 `rg` 查。护栏兜底。
- **旧家目录打不开**：主键和消息的先后都变了，旧的工单、聊天、轨迹不搬；开工前把 `$VIBEVALLEY_HOME` 整个备份一份。
- **和正在做的工作冲突**：改名碰的文件多，别的分支和 worktree 里的帮工会大面积冲突。每一步开工前确认没有别的活在改同一片代码。
