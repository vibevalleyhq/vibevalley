# Agent Note: Run 是一次干活，Session 跨好几次 run，小队（Crew）编排 agent

Status: proposed

## Problem

主人的模型是：先配好一个**小队**，按一份**编排方案**组织不同的 agent 干活；**一次干活叫 run**；一张 issue 下面有好几条 **comment**，issue 和 comment 都能触发 run。

Run 和 Session 这两层已经落了（2026-10-17），差的最后一层是**小队**：现在一张工单只派给一个档案。最接近编排的是种植计划，它是管家临时拆的，用一次就完；挑谁由管家按档案「适合的活」定。

## Proposal

### 已经落了的两层

| 层 | 是什么 | 代码里 |
|---|---|---|
| Session | 一个档案为一张工单接的活：worktree、分支，跨好几次 run，重启后还是同一个 | `protocol.Session`、`session` 表（`issue_session` 记谁在哪张工单上干过）、`sessions.json` |
| Run | 一次干活：一次触发到一次汇报，包着一个 oar turn | `protocol.Run`（`session_run` 表）；核心状态里是 `FactRun` 到 `FactReport` |

- **触发**是 `RunTrigger`：工单（第一次派出去）、comment（说话、@ 它、浇水）、Task 模板 走到下一步、定时、农机自己（后台任务做完以后接着干）。
- 四种边界：干活时来的 comment 用 steer 插进这次 run，不另开；不能 steer 的农机排队，下一次 run；没开成的（叫不醒、钱用完、档案删了）不算 run，原因记在那条 comment 的投递结果上；重启后接不上旧会话，换一个 oar 会话，还是同一次 run。
- 包着 oar 的那部分在 `runtime` 的 `subagents`（开子 agent、发话、叫停、收报告）；事件读成事实在 `session`。

### 还没做：小队（Crew）

- **小队**是配好的一组 agent，照一份 **Task 模板** 干活：谁先、谁接着、谁检查、什么时候交回主人。
- 派给小队时，照 Task 模板 开 Session、触发 run，底下还是 `runtime` 开的 oar 子 agent；每一次 run 的记录和单派一样。
- 现在的种植计划就是一份 Task，只是管家临时拆、用一次；以后可以存成 Task 模板，给小队反复用。
- 小队怎么配、Task 模板 怎么存，另写一篇 Note（上面这些做完再设计）。

### 词

- 业务代码、接口、文档里单写的 Session 只指我们这一层；农机那一层写「oar 会话」。
- 农场的叫法不变：Session 画出来是帮工，run 是一季庄稼。

## Alternatives considered

**照概念先行：run 就是帮工，轮不另存。** 改得少。没选：issue 和 comment 都触发 run，主人要看的是「这条 comment 让它干了什么、花了多少、做成没有」。轮不成为记录就答不了；数据库里 `issue_session` 的名字也会一直误导。

**一次干活叫 turn。** 和 oar 一致，少一个词。没选：turn 是 oar 那一层的词，smith 里有一千多处；业务层也叫 turn，读把 oar 事件读成事实的代码时分不清是谁的 turn。别家农机里 turn 的大小也不一样：codex 的 turn 是我们要的单位，Claude Code 的 `num_turns` 数的是一次提问里模型来回的次数。run 还带着我们要记的东西：触发、结果、花费。

**一次干活叫 operation。** 没选：它太泛，常指一次调用或异步任务的句柄；中文是「操作」，写作规矩不用这个词。

**跨 run 的那层叫 Session。** 它确实包着一个会话。当时没选：Session 是 oar 的核心词，`SubagentReport.sessionId` 也是 oar 会话；重启以后我们这一层不变，底下却会换一个 oar 会话，两个 Session 套在一起读不清。这一条后来被 [Worker 改叫 Session](2026-10-17-worker-is-a-session.md) 取代：主人接受重名，用词规则分开两层。

**跨 run 的那层叫 `Assignment` 或 `Task`。** `Assignment` 说的是派活这个动作，不是派出去以后那个持续的东西。`Task` 和 `Session.Task`（要做的事）、oar 的任务（`TaskStarted`）都撞。

**管帮工的那部分留着 crew 这个名字。** 没选：它管的是全部 issue 上干活的帮工，不是一队；`Crew` 留给小队。

**包着 oar 的那一层叫 `runtime.Crew`。** 和 oar 的 crew 意思一致。没选：小队要用 Crew；那一层用 oar 自己的类型名 `Subagents`，更准。

**包着 oar 的类型加 `Vv` 前缀**（`VvRuntime`、`VvSubagents`）。一眼看出是我们的。没选：整个模块都是 VibeValley 的，前缀只说明「不是 oar 的」，import 的限定符已经说了；Go 也不在类型名里重复命名空间。

**小队叫 Squad、Team，或者 Formation、Lineup、Brigade、Party。** 没选：主人不要 Squad 和 Team（Team 还是 Linear 里装工单的组织单位），其余几个意象不错，但主人选了 Crew：一班人一起干一件活，也和 oar 的 crew 接得上。

**干活时来的 comment 也开一次新的 run。** 一次触发一次 run，规则更整齐。没选：农机把插进来的话和原来的活放在同一轮里做完、一起汇报，分成两次是假的。

**现在就设计小队。** 主人已经说了要有。没选：小队要先有 run 和 Session 这两层，方案的每一步才知道开什么、等什么。先把这两层做对，小队另写。

## Acceptance criteria

- 派活可以派给一支小队；照 Task 模板 开 Session、触发 run，每一步的记录和单派一样。
- 小队的 Task 模板 能存下来，下一次复用。
- `docs/concepts.md` 和用语表里有小队、Task 模板 和其余概念的对照，每个对得上代码里的一样东西。
- `go vet ./... && go test ./...`、`go run ./tool/shapegen -check`、`bun run flutter:check` 通过。

## Risks

- **和种植计划重叠**：现在的计划（父工单、`step`、`blockedBy`）已经是一份临时的 Task 模板；不抽出来，小队会有两套编排。
- **上限**：一支小队同时开几个 Session 要受农场的上限和项目的槽约束。
- **旧的轮不补记**：Run 的记录从 2026-10-17 开始有，以前的轮只在事件日志里。
