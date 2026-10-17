# Agent Note: Run 是一次干活，Worker 跨好几次 run，小队（Crew）编排 agent

Status: proposed

## Problem

主人的模型是：先配好一个**小队**，按一份**编排方案**组织不同的 agent 干活；**一次干活叫 run**；一张 issue 下面有好几条 **comment**，issue 和 comment 都能触发 run。

现在的代码和这个模型有三处对不上：

- **「run」指的是另一样东西**：数据库的 `issue_run` 一行是一个帮工（`run` 列存 `w3`），协议的 `Issue.Runs` 是用过的帮工 id，管帮工的包原来叫 `run`，服务叫 `Crew`（现在是 `worker` 包和它的零件 `workers`）。主人说的「一次干活」在代码里叫「轮」（`FactTurn` 到 `FactReport`），没有自己的记录：看不出哪条 comment 触发了哪一轮、这一轮花了多少、结果是什么。
- **跨好几次干活的那一层名字不对**：一个档案在一张 issue 上的会话、worktree 和分支，代码里叫 `Helper`，管它的服务原来叫 `Crew`。这个名字借自 oar：在 oar 里，crew 是一个父 agent 扇出去的子 agent（`agents/crew.ts` 的 `createSubagents`）。我们这一层管的是全部 issue 上干活的帮工，不是一队；这个名字该给以后的小队。[概念先行](2026-10-15-concepts-first.md)打算把 `Helper` 改叫 `Run`，那就和主人说的 run 撞了。
- **没有小队**：现在一张工单只派给一个档案。最接近编排的是种植计划，它是管家临时拆的，用一次就完；挑谁由管家按档案「适合的活」定。

## Proposal

### oar 的词，我们不占

smith 是 oar 的移植，类型名、事件名、控制名和 oar 的 TS 一样（`Subagents` 的选项在 Go 里叫 `agents.Options`，TS 里叫 `SubagentsOptions`；TS 没有的控制在 Go 里是 `CanSteer`、`CanWithdraw`）。oar 的几层：

| oar | 是什么 |
|---|---|
| Runtime | 一种编码 agent 程序（claude、codex、pi……）和它的安装 |
| Session | 农机原生的一个会话：「one ordered, resumable record stream」，可以 `resume` |
| Turn | 会话里的一轮：一个 prompt 请求开始，农机自己的 `turn_ended` 结束，带 `completed`、`aborted`、`failed` |
| Event | 一轮里的文字、思考、工具调用、用量、任务…… |
| Subagent、Subagents（crew） | 宿主在任意农机上开的子会话，每结束一轮交一份 `SubagentReport`；有同时在跑和嵌套深度的上限，没有角色和方案 |

业务层不用 Session、Turn、Subagent、crew 这几个词。代码里提到它们时，写 oar 会话、oar turn。

### 包着 oar 的一层

oar 的概念进到我们这边，先经过 `runtime` 包，再给业务用。类型名不加 `Vv` 之类的前缀：包名已经说明它是我们的（`runtime` 里的 `subagents` 对 `agents.Subagents`）；照[一个包一个 Service](../../implemented/architecture/2026-10-16-one-service-per-package.md)，`runtime` 对外只有 `runtime.Service`，下面两行是它的零件，同一个文件两个都要用时才起 import 别名（像 `vvagent`）。

| 我们的 | 包着 oar 的 | 管什么 |
|---|---|---|
| `runtime.Service`（`runtime.go`） | `oar.Runtime`、`RuntimeRegistry` | 探测、额度、花费、价目表、每个农机的模型 |
| `runtime.Service`（`subagents.go`） | `agents.Subagents`、`oar.Session` | 开子 agent、`resume`、发话（prompt、steer、queue）、叫停、收报告、日志；和 oar 的同名类型一样，是一池子 agent |

`runtime` 不认识 issue、worktree、事实，这些是业务层的事。

### 我们的概念

从下往上：**步骤 < oar turn < run < Worker < Issue（< 小队照着走的 Playbook）**。

| 概念 | 是什么 | 现在代码里 | 农场里 |
|---|---|---|---|
| 小队（Crew） | 配好的一组 agent，照一份 Playbook 干活 | 没有 | 以后定 |
| Playbook | 小队照着走的编排方案：谁先、谁接着、谁检查、什么时候交回主人 | 种植计划（`Playbook`），管家临时拆、用一次 | 种植计划 |
| Issue | 一件活，从写下到关上一个 id；可以有好几个 Worker（重开、计划的每一步） | `Issue` | 看板上的卡片 |
| Comment | issue 下的一句话：工单串里的消息、对某一步的评论、带话 | 工单串里的消息、`CommentText` | 工单串 |
| Worker | 一个 agent 为一张 issue 干活的实体：经 `runtime` 开的一个 oar 子 agent，加上 worktree、分支；从派出到收获或请走，跨好几次 run | `Helper`，由 `worker` 的 `workers` 管 | 帮工 |
| Run | 一次干活：一次触发到一次汇报，包着一个 oar turn | 轮 | 一季庄稼 |
| 步骤 | run 里的每一步 | `WorkStep` | 干活过程 |

中文文档里，「执行」只指 run，Worker 叫 Worker 或帮工。

### run 和 oar turn

一次 run 就是一个 Worker 的一个 oar turn，再记上触发它的是什么、结果和花费。触发它的可以是：

- issue 派出去：Worker 的第一次 run；
- comment：在它的工单串里说话、@ 它、评论某一步、「浇水」；
- 编排：Playbook 走到下一步、让它解决冲突；
- 服务端重启以后，带句话接着干；
- 农机自己：oar 报告的一轮不是我们开的（比如后台任务做完以后它接着干），触发记成农机自己。

四种边界情况：

- **干活时来的 comment**：插进当前这次 run（oar 的 steer），不开新的 run；这次 run 记下它也读到了这条。农机没法把正在进行的一轮切成两半。
- **排队的 comment**：不能 steer 的农机，把它排到下一轮（oar 的 queue）。下一轮是单独的一次 run，由这条 comment 触发。
- **没开成**：叫不醒、钱用完、档案删了时，一个 oar turn 都没有。这不是 run，拒绝的原因记在那条 comment 的投递结果上（现在的 `Delivered{Kind: "refused"}`）。
- **接不上旧会话**：重启以后旧的 oar 会话接不上，换一个新的再发，还是同一次 run。

### 小队只定位置，不在这里设计

issue 可以派给一个 agent，以后也可以派给一个小队。派给小队时，照它的 Playbook 开 Worker、触发 run，底下还是 `runtime` 开的 oar 子 agent。这和 oar 的 crew 接得上：oar 的 crew 是一池子 agent，我们的 Crew 是配好的一池子 agent，再加一份照着走的 Playbook。现在的种植计划就是一份 Playbook，只是管家临时拆、用一次；以后可以存下来，给小队反复用。小队怎么配、Playbook 怎么存，另写一篇 Note。

### 名字

| 现在 | 改成 |
|---|---|
| 协议 `Helper` | `Worker`（协议里已经有 `WorkerAction`、`GameEffect.WorkerID`） |
| `Helper.Turns`、`LastTurn` | `Worker.Runs`（次数）、`LastRun` |
| `FactTurn` | `FactRun`（一次 run 开始，带触发它的东西）；`FactReport` 照旧是它的结束 |
| `worker` 的 `workers` | 拆成两块：开 oar 子 agent、发话、收报告的那部分进 `runtime`（`subagents.go`）；issue、worktree、事实、投递的规矩、记 run 的进包 `worker`（`worker.Service`，`Workspace` 上的 `Worker`） |
| 表 `issue_run`、`Issue.Runs`（帮工 id） | `issue_worker`、`Issue.Workers`；新表 `run` 记每一次 run，`Issue.Runs` 是它们 |
| `crew.json` | `workers.json`（它存的是 Worker） |

农场的叫法不变：Worker 还是帮工，run 还是一季庄稼。这一篇取代[概念先行](2026-10-15-concepts-first.md)里的「`Helper` 改叫 `Run`」和「轮从 activity 里切出来，不另存」。

### 步骤

每一步是一个单独的改动，测试照常通过：

1. **文档**：`docs/concepts.md` 和用语表照上面的概念改，写上 oar 的几层。
2. **服务端内部改名，不动协议（已做）**：包 `run` 改成 `worker`，`Crew` 是它的零件 `workers`，`crew*` 的名字都改了；`farm` 改成 `workspace`，`farmtest` 改成 `testkit`，`farm` 里的 `crew_*_test.go` 按流程改名。
2b. **包 oar 的部分挪进 `runtime`**：`workers` 里开子 agent、发话、叫停、收报告的那部分（`oarSession`、`open`、`withOptions`）挪进 `runtime` 的 `subagents`。事件读成事实、报告等事件读完、卡住检测都缠在这里，单独一步做。
3. **run 成为记录（已做）**：`run` 表和协议的 `Run`、`RunTrigger`，`GET /api/issues/{id}/runs`；`issue_run` 改名 `issue_worker`，`Issue.Runs` 改名 `Issue.Workers`；工单详情列出每次 run 的触发、结果和花费。以前的轮不补记。重启后带一句话就是普通的 comment，没有单独的触发。定时也是一种触发：[定时是一张工单的触发](../../implemented/architecture/2026-10-16-a-schedule-is-a-trigger.md)。
4. **协议改名（已做）**：`Helper` 改成 `Worker`，以及上表的其余几项；`ForemanState`、`FactForeman`、`PlaybookActorForeman`、`SenderKindForeman` 和管家的参与者 id `foreman` 改成 manager，`SenderKindHelper` 改成 worker；生成的 Dart 和两边的局部名字跟着改。线上的名字、存盘的值、`workers.json`、`manager/`、`VIBEVALLEY_MANAGER_*` 一起换了，旧数据不搬：[只有一份表结构，不认旧数据](../../implemented/architecture/2026-10-16-one-schema-no-old-data.md)。黄金数据按同样的规则转写，不用 `-update` 就过。
5. **小队**：另写 Note，连同 Playbook 怎么存下来反复用。

## Alternatives considered

**照概念先行：run 就是帮工，轮不另存。** 改得少。没选：issue 和 comment 都触发 run，主人要看的是「这条 comment 让它干了什么、花了多少、做成没有」。轮不成为记录就答不了；数据库里 `issue_run` 的名字也会一直误导。

**一次干活叫 turn。** 和 oar 一致，少一个词。没选：turn 是 oar 那一层的词，smith 里有一千多处；业务层也叫 turn，读把 oar 事件读成事实的代码时分不清是谁的 turn。别家农机里 turn 的大小也不一样：codex 的 turn 是我们要的单位，Claude Code 的 `num_turns` 数的是一次提问里模型来回的次数。run 还带着我们要记的东西：触发、结果、花费。

**一次干活叫 operation。** 没选：它太泛，常指一次调用或异步任务的句柄；中文是「操作」，写作规矩不用这个词。

**跨 run 的那层叫 Session。** 它确实包着一个会话。没选：Session 是 oar 的核心词，`SubagentReport.sessionId` 也是 oar 会话；重启以后我们这一层不变，底下却会换一个 oar 会话，两个 Session 套在一起读不清。这一条后来被 [Worker 改叫 Session](2026-10-17-worker-is-a-session.md) 取代：主人接受重名，用词规则分开两层。

**跨 run 的那层叫 `Assignment` 或 `Task`。** `Assignment` 说的是派活这个动作，不是派出去以后那个持续的东西。`Task` 和 `Helper.Task`（要做的事）、oar 的任务（`TaskStarted`）都撞。

**管帮工的那部分留着 crew 这个名字。** 没选：它管的是全部 issue 上干活的帮工，不是一队；`Crew` 留给小队。

**包着 oar 的那一层叫 `runtime.Crew`。** 和 oar 的 crew 意思一致。没选：小队要用 Crew；那一层用 oar 自己的类型名 `Subagents`，更准。

**包着 oar 的类型加 `Vv` 前缀**（`VvRuntime`、`VvSubagents`）。一眼看出是我们的。没选：整个模块都是 VibeValley 的，前缀只说明「不是 oar 的」，import 的限定符已经说了；Go 也不在类型名里重复命名空间。

**小队叫 Squad、Team，或者 Formation、Lineup、Brigade、Party。** 没选：主人不要 Squad 和 Team（Team 还是 Linear 里装工单的组织单位），其余几个意象不错，但主人选了 Crew：一班人一起干一件活，也和 oar 的 crew 接得上。

**干活时来的 comment 也开一次新的 run。** 一次触发一次 run，规则更整齐。没选：农机把插进来的话和原来的活放在同一轮里做完、一起汇报，分成两次是假的。

**现在就设计小队。** 主人已经说了要有。没选：小队要先有 run 和 Worker 这两层，方案的每一步才知道开什么、等什么。先把这两层做对，小队另写。

## Acceptance criteria

- `docs/concepts.md` 里有小队、Playbook、Issue、Comment、Worker、Run、步骤，和 oar 的几层、`runtime` 那一层的对照，每个对得上代码里的一样东西。
- 每次 run 有一行记录：触发它的 issue、comment 或农机自己，Worker，开始和结束，结果，花费；工单详情能看到一张 issue 的全部 run。
- 干活时来的 comment 记在当前那次 run 上；排队的 comment 触发下一次 run；没开成的不算 run，原因记在 comment 上。
- `Crew` 只指小队；包着 oar 子 agent 的是 `runtime` 的 `subagents`；`run` 只指一次干活，不用 Session、Turn 指我们自己的东西；表名、包名都是单数。
- `go vet ./... && go test ./...`、`shapegen -check`、`bun run flutter:check` 每一步都通过；旧的家目录照常打开，旧的 `issue_run` 迁成 `issue_worker`。

## Risks

- **改名的面大**：`Helper` 在服务端有四百多处，Dart 七十多处，所以协议改名单独一步，放在 run 成为记录之后。
- **兼容**：经院门连进来的旧客户端读不懂改了名的帧，要和桌面版一起升级。
- **旧数据**：以前的轮没有 run 记录，只有轨迹里的步骤；不补记，工单详情里只从这次改动以后开始有 run。
- **Worker 的旧用法**：`WorkerAction`、`GameEffect.WorkerID` 里的 worker 已经指帮工，意思一致；改名时一起查一遍，别留下另一种意思。
