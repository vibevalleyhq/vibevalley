# Agent Note: Worker 改叫 Session

Status: proposed

## Problem

一个 agent 档案为一张工单干的那一份活（一个 oar 子 agent，加上自己的 worktree 和分支，从派出去到合并或请走，跨好几次 run），代码里叫 `Worker`。这个词说的是「干活的人」，不是「一个档案在一张工单上的一次接活」：`agent list` 和 `worker list` 并排时，读的人以为是两种人。Linear 把这一层叫 agent session，主人想的也是「后端老周在 tDS4 上的那个会话」。

[Run 是一次干活](2026-10-16-runs-sessions-crews.md)当时没选 Session，理由是和 oar 的 `Session` 重名。2026-10-17 主人定了：重名可以接受，用词规则分开两层，这一层改叫 Session。本篇取代那一篇 Alternatives 里「跨 run 的那层叫 Session。没选」这一条。

## Proposal

### 名字

| 层 | 名字 | 指什么 |
|---|---|---|
| agent 档案 | `Agent` | 谁：农机、模型、人设、技能 |
| 我们这一层 | `Session` | 一个档案为一张工单接的活：worktree、分支、跨好几次 run；重启后还是同一个 |
| 一次干活 | `Run` | 一次触发到一次汇报，包着一个 oar turn |
| oar 那一层 | `oar.Session`、`agents.Subagent` | 农机的一条可续的记录流；重启后会换一个 |

用词规则（写进 [docs/concepts.md](../../../../docs/concepts.md)）：

- 业务代码、接口、文档里单写的 Session 只指我们这一层。
- oar 的那一层在 Go 里只经包名出现（`oar.Session`、`SubagentReport.SessionID`），文档里写「oar 会话」。
- 中文文档里我们这一层写 Session，不写「会话」：「会话」留给 oar。
- 农场的叫法不变：Session 画出来还是帮工。

### 改什么

2026-10-17 的数：Go 里 `Worker` 506 处、`Workers` 119 处、`WorkerAction*` 约 80 处；Go、Dart、SQL 一共 197 个文件、3083 处 worker（不分大小写）。

| 现在 | 改成 |
|---|---|
| 协议 `Worker`、`CoreState.Workers`、`Issue.Workers`、`WorkerOf` | `Session`、`CoreState.Sessions`、`Issue.Sessions`、`SessionOf` |
| `WorkerAction*`、`WorkerPlay`、`WorkerPlaybook`、`GameEffect.WorkerID` | `SessionAction*`、`SessionPlay`、`SessionPlaybook`、`GameEffect.SessionID` |
| `SenderKindWorker`（`"worker"`）、`participant.kind` 的 `'worker'` | `agent`，带档案 id：在频道里说话的是档案。`'manager'` 留着：管家在频道里是另一种参与者（[管家是一份内置档案](2026-10-17-manager-is-an-agent.md) 的 Alternatives） |
| 包 `internal/worker`、`Workspace.Worker`、`worker.Service` | `internal/session`、`Workspace.Session`、`session.Service` |
| 表 `issue_worker`（列 `worker`） | `issue_session`（列 `session`），一个迁移 |
| 家目录 `workers.json` | `sessions.json`，加载时改名写回 |
| 路由 `worker.*`、`/api/workers/{id}/...` | 照 [先有能力，再有入口](2026-10-17-capabilities-before-surfaces.md)：工单的生命周期挪到 `issue.*`，剩下的是 `session.*`、`/api/sessions/{id}/...` |
| Flutter 生成的类型和局部名 | 跟着 shapegen 改 |

不改的：`oar.Session`、`agents.Subagent`、`runtime` 的 `subagents`、smith 里的一切；界面上的「帮工」。

### 顺序

一个改动做完，不留旧名（[只有一份表结构，不认旧数据](../../implemented/architecture/2026-10-16-one-schema-no-old-data.md)）：协议和 shapegen → 服务端的包、表、家目录的文件 → Flutter → 黄金数据转写 → 文档和 Note 的事实。和能力提案里路由的收敛一起做，路由只改一次名。

### 做到哪了

2026-10-17 做了：协议、服务端的包（`internal/session`）、`Workspace.Session`、表（迁移 `0002_session.sql`：`issue_session`，`run`、`memory` 的 `session` 列，发言人 `'agent'`，库里 JSON 的键）、家目录（`base.MoveSessionFiles`：`workers.json` → `sessions.json`，`state.json` 的键）、配置的 `session.stall_seconds`、Flutter 的类型和名字、黄金数据（按同样的规则转写，不用 update 就过）、当前文档。

先做的一步是把原来叫 session 的东西改了名，免得和这一层撞：一次启动（`w3#2`）是 launch（`LaunchActivity`、`delivery.launch`），oar 的会话 id 是 `oarSessionId`。迁移跑的时候关掉外键、提交前查 `foreign_key_check`（`migrations.go`），重建 `participant` 才不会改写别的表的引用。

没改的：管家工具给模型看的参数名还叫 `worker`（对应「帮工」）；农机设置里的 `SessionEnv`、`SessionEffort` 这些指的是 oar 会话的选项，没改名；Note 是历史，里面的 Worker 不改。

## Alternatives considered

**留着 Worker。** 不和 oar 重名。主人不选：`Worker` 说不出这一层是什么，重名靠用词规则分得开。

**叫 Agent。** 和档案撞：一个档案可以同时在几张工单上干活，`agent stop` 停的是档案还是这一份活分不清。

**叫 Task。** Multica 的叫法（daemon 认领 task）。这里工单就是要做的事，Task 和 Issue 撞；oar 也有 `TaskStarted`。

**叫 AgentSession。** 照 Linear 的全称，不和 oar 重名。名字长，`issue.Sessions` 读起来已经够清楚，和档案的关系由字段 `Session.Agent` 表达。

## Acceptance criteria

- 协议、服务端、Flutter、表、家目录里没有指这一层的 `worker`；`grep -rniw worker server/internal app/lib` 只剩指农场画面的、smith 的和注释里引 oar 的。
- `docs/concepts.md` 写了用词规则；`docs/reference/concept-map.md` 的「帮工」一行写 `Session`。
- `go vet ./... && go test ./...`、`shapegen -check`、`bun run flutter:check`、`bun run docs:verify` 通过；旧的家目录打开后 `workers.json` 变成 `sessions.json`，`issue_worker` 迁成 `issue_session`。

## Risks

- 读把 oar 事件读成事实的代码（`facts.go`、`runtime/subagents.go`）时，两种 Session 挨在一起；那几个文件里我们这一层的变量宜写 `sess`，oar 的写 `oarSess`。
- 改动几千处，和别的进行中的改动冲突；先合掉手上的分支再开始。
- 主人以后在文档里读到「Session」，可能当成 oar 会话；用词规则要写在 concepts 开头的表里，不只写在 Note 里。
