# Agent Note: Session、Run、事件：一个 agent loop 的日志，和消息之间只有两个口子

Status: proposed

## Problem

Session 是一个 agent loop（harness）的会话：agent 在这里想、动手，一轮一轮（Run），每轮里是一条条事件。消息是对人说的话，在频道和串里。两者是两套东西；现在的代码把它们搅在一起，Session 自己的三层又存了好几份。

**Session 存了两份。** 活着时是核心状态里的 `Session`，走了以后是 `activities/<id>.head.json` 里的 `TrajectoryHead`。头的 16 个字段里，`ID`、`Name`、`Agent`、`Runtime`、`Project`、`Issue`、`Playbook` 和 `Session` 同名，`Job`、`StartedAt` 是 `Session.Task`、`HiredAt` 换了名字；`Outcome`、`Summary` 是最后一个 Run 的，`Runs`、`CNY` 是 `session_run` 的行数和花费之和；`ReopenedFrom`、`ReopenedAs` 的注释自己说是「工单出现之前的做法」，现在 `issue_session` 的先后就是。只有 `EndedAt`、`Closed` 是它自己的。`Trajectory` 只是把头和步骤包在一起。

**事件不知道自己属于哪一轮。** `Activity` 没有 Run：一个 Session 的记录是一长串，第二层要靠时间猜。它其实是事件不是步：照 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`packages/core/session/src/types.ts`），Session 是一份只追加的 `SessionEvent{type, seq, time, data}` 日志，turn 和 step 是事件标出的边界（`turn/start`…`turn/end`、`step/start`…`step/end`，step 是「one model call plus the tool executions it requested」），一条 `Activity`（一段话、一次工具调用）只是其中一个事件。

**Session 自己往频道里说话。** MCP 的 `farm_say`、`farm_read`、`farm_inbox`、`farm_who` 让 agent 在一轮中间直接发消息、翻串（`session/rules.go` 教它这样用）；一轮结束时服务端又把最后一段话贴成汇报（`channel/deliver.go` 的 `postReport`）。一句对人说的话有两条路出去。

## Proposal

### 日志：Session、Run、事件，照 DeepSeek Harness

2026-10-17 做了第一半：`Activity` 是 `SessionEvent`（`seq`、`time`、`type`），类型照 DeepSeek Harness 写成 `<主体>/<做了什么>`（`user/message`、`memory/recalled`、`assistant/thinking`、`assistant/message`、`tool/call`、`llm/retry`、`run/error`）；每个 Run 由 `run/start` 和 `run/end`（带结果）围起来，中间的事件带 `run`；家目录 `activities/` 是 `events/`，旧的记录加载时改好（`session/moved.go`）。

日志只追加也做了：写下的一条不再改，流式的话和还没拿到输入的调用是草稿，带着将来的 `seq` 实时推、下一条事件之前写下；工具的结果是另一条 `tool/result`（`call` 指它的调用）；旧日志里带着输出的调用拆开、重新编号一次（`splitAllResults`）。还没做：事件的内容放进按 `type` 分的 `data`；Step 这一层（一次调模型和它要的工具）等农机报得出这条边界再加（我们自己的 agent 有，外面的农机多半没有），事件带一个可空的 `step`。照 DeepSeek Harness 的规矩，每个事件都落在一个 Run 里：现在开工前想起的记忆（`memory/recalled`）还在第一个 `run/start` 之前。

| 层 | 类型 | 存在哪 | 是什么 |
|---|---|---|---|
| Session | `Session` | 新表 `session`（session 模块的主表），加 `EndedAt`、`Closed` | 一个档案为一张工单接的活；活着时核心状态带着它的现场（阶段、地块、冲突），走了以后行还在 |
| Run | `Run` | `session_run`（已有） | 一轮：一次触发到一次交代；次数、花费、最后的结果从这里算，不另存 |
| 事件 | `SessionEvent`（原来的 `Activity`） | `events/<id>.json` | 日志里的一条；带 `run` |

- 删掉 `Trajectory`、`TrajectoryHead` 和 `*.head.json`。已有的头文件搬进 `session` 表一次；旧的事件没有 Run，按时间落进对应的 Run，落不进的留空。走了的 Session 也是 `Session`：`Phase` 加一个 `closed`（结束的时间和怎么关的）。
- 接口：`session.list` 返回 `[]Session`（活的和走了的）；`session.get <id>` 返回它和它的 Run；新的 `session.events <id> [--run]` 返回事件。
- 管家也是一个 agent loop，按 [管家是一份内置档案](2026-10-17-manager-is-an-agent.md) 它是档案 `manager`，它的会话是一个 Session，进同一张表；它的事件现在只留最近 1000 条，照旧。

### 和消息之间只有两个口子，都在服务端

```
频道、串、消息 ──进──▶ Session（Run ▶ 事件）──出──▶ 频道、串、消息
```

- **进**：一条消息投递给一个 Session，就是它一个 Run 的输入（`session.Deliver`：prompt、steer 或 queue）。投递带上 Session 要的上文（这个串里它没看过的、@它的那几条），它不用自己去翻。
- **出**：一个 Run 结束，服务端把它整理成一句或几句话：给工单串一条交代；交代里 @ 到的投递过去；要主人拿主意的（`NeedsYou`）进 Inbox。
- 消息记着出自哪个 Run，Run 记着哪条消息触发了它（`RunTrigger` 已有一半），从一句话能追到背后的事件。
- Session 不直接发消息：删掉 `farm_*` 和 `session/tokens.go`。`/mcp` 只对外，给主人机器上的 agent 用农场的能力，工具从能力表来（[先有能力，再有入口](2026-10-17-capabilities-before-surfaces.md)）。

这和 ACP（Agent Client Protocol）的分法一致：客户端 `session/prompt`、`session/cancel`，agent 只回 `session/update` 和结束的原因，请示用 `session/request_permission`；agent 不调客户端的接口说话。

### 顺序

1. 管家成为内置档案（它的会话才能进 `session` 表）。
2. `SessionEvent` 和 Run 的边界（已做）；`session` 表、`Phase` 的 `closed`、`session.list`/`get` 给 `Session`、`session.events`、搬头文件、删 `Trajectory`、`TrajectoryHead`（已做：`session/records.go`，迁移 `0005_session_table.sql`）；日志只追加（已做）。Flutter 的干活记录页和工单详情页改读 `Session` 和 `Run`。
3. 两个口子：投递带上文，交代里的 @ 投递出去；删 `farm_*` 和令牌，改 `session/rules.go` 给帮工的说明。

## Alternatives considered

**留着 `TrajectoryHead`，只删重复的字段。** 一个 Session 还是两种形状、两处存：活着时的 `Session` 和走了以后的头，读的人要知道去哪找。

**事件进表。** 一个 Session 几千条，表会很大；事件只按 Session 读，文件够用。以后要跨 Session 查再进表。

**帮工改用命令行加每次执行一把钥匙**（能力提案原来的选择）。Session 本来就不该自己往外说话，它要的东西由进的口子带进来；钥匙和那几个新操作都不需要。

## Acceptance criteria

- 协议里没有 `Trajectory`、`TrajectoryHead`；家目录里没有 `*.head.json`；`session` 表有活的和走了的 Session。
- 每个 `SessionEvent` 落在一个 Run 里（搬来的旧事件可以没有）；`session.events <id> --run <n>` 只返回那一轮的。
- `mcp.go` 里没有 `farm_*`；帮工被 @ 时，投递的 prompt 里有那几条上文；一轮的交代里 @ 到的人收到投递。
- `go vet ./... && go test ./...`、`shapegen -check`、`bun run flutter:check`、`bun run docs:verify` 通过；旧家目录打开后头文件搬进了表。

## Risks

- 帮工没法在一轮中间说话（边干边回一句「收到」），要说就结束这一轮；群聊里来回会慢一点。
- 投递带多少上文：带少了它不知道在说什么，带多了一轮的 token 变多。先带「这个串里它没看过的」，上限照现在 `farm_read` 一次读的条数。
- 旧事件按时间落进 Run 可能落错（一轮的边界在事件里不总是清楚），所以落不进的留空，不硬猜。
