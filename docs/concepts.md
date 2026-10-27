# 概念

VibeValley 是 AI 版的 [Linear](https://linear.app)，和 [Multica](https://github.com/multica-ai/multica) 是一类东西；不同的是只给一个人在自己的机器上用，多了一个替你派活的管家，外面画成一座农场。对象模型照 Linear（Workspace、Issue、优先级、状态）；项目是我们自己的，指一个 git 仓库。

代码、接口和讲服务端的文档用这里的概念；界面用农场的叫法（[用语](docs/README.md#用语)）。每个概念在界面、协议、HTTP、服务端、存储和 oar 里叫什么，见 [concept-map.md](docs/reference/concept-map.md)。

## 层次

```
Workspace（工作目录，一张大地图）
├── 项目（一个 git 仓库，大地图上的一座岛）
└── 工单（可以指一个项目）
    ├── 分支和 worktree（代码相关且档案开了 worktree 的工单才有；岛上围着篱笆的那一块，重开还是这一块）
    └── Session（在这块地上干活的帮工；派一次是一个，重开是下一个）
        └── run（一次干活：一次触发到一次汇报）
```

现在只有一个 Workspace：工作目录 `VIBEVALLEY_WORK_ROOT`（项目在 `projects/`，worktree 在 `worktrees/`）和家目录 `VIBEVALLEY_HOME`。

## 一件活怎么走

1. 主人或管家写下一张**工单**，选一个 **agent 档案**和一个**项目**，派出去。
2. 服务端开一个 **Session**：档案在一个 runtime 上接的这份活。档案开了 worktree 时，它在这张工单的 worktree 里、工单的分支上干（`vibevalley/issue-<工单号>`）；没开时在项目目录里干。
3. 每次 **run** 从一次触发开始（派出去、一条 comment、计划走到下一步、定时），到一次汇报结束；中间每一**步**都记下来。
4. 主人看**改动**，决定**完成**还是**取消**。完成是工单的结论，交付另记：本地合进主分支、PR 合入、保留分支或没有改动要合；取消是不再做，分支上有提交就留着（[完成和交付](docs/subsystems/issue.md#完成和交付)）。

说话都在**频道**里，结构照 Discord：频道 → 消息 → 挂在消息下面的串，每张工单一个串。现在只有一个人：主人，没有成员和权限；在频道里说话的是主人、管家和档案（经它的 Session）。同时干活的 Session 有上限，派不出去的排队。

## Session 和 oar 会话

单写的 Session 只指上面这一层：一个档案为一张工单接的活。农机那一层（oar 的会话，重启后会换一个）在代码里只经 oar 的 import 出现，文档里写「oar 会话」；中文里我们这一层写 Session，不写「会话」（[Worker 改叫 Session](docs/subsystems/session.md)）。

## 东西

农场里各叫什么、界面上用哪个字，见[用语表](docs/README.md#用语)，这里不再写一遍。

| 概念 | 代码里 | 是什么 |
|---|---|---|
| Workspace | `Config.workRoot`、`Config.home` | 全部项目、工单、群聊、档案；同时干活的上限（6）是它的 |
| 管家 | `Orchestrator` | 主人的助理 agent：听主人说，拆成工单，派出去，转告结果 |
| agent 档案 | `Agent` | 能派活的「同事」：runtime、模型、人设、技能、MCP、环境变量、长相 |
| runtime | `RuntimeInfo` | 本机上的一种编码 agent 程序，由 oar 驱动 |
| 项目 | `project` | 一个 git 仓库，和能同时在里面做的工单数（`project.max_sessions`，`ProjectSummary.maxSessions`） |
| 工单 | `Issue` | 一件活，从写下到关上一个 id；状态由服务端给，主人挪状态就是派活；代码相关的开不开 worktree 由档案设置决定；每张都有验收，完成就是通过；关上的能重开 |
| Session | `Session`（服务是 `Sessions`，派活是 `Issues` 的 `hire`） | 档案为一张工单接的活，在档案配置的项目目录或工单的 worktree 里干，直到工单完成或它收工；跨好几次 run，重启后还是同一个 |
| Run | `Run`（`session_run` 表）；核心状态里是 `run` 到 `report` 两个事实 | 一次干活：一次触发到一次汇报；帮工的一次 run 包着一个 oar turn，进程内 agent 的 loop 也记 Run |
| 事件 | `SessionEvent`，一个 Session 的全部是它的日志 | 日志里的一条：收到的话、想、说、工具调用、重试、用量、出错，和 Run 的边界（`run/start`、`run/end`）；类型照 DeepSeek Harness 写成 `<主体>/<做了什么>` |
| 改动 | `Changes` | 分支上的提交和 diff，合进去会不会冲突 |
| 完成 | 动作 `complete`；工单的 `status` 是 `done` | 主人对工单的结论；交付由 `delivered` 另记。合并只是交付的一种，PR 合入后才完成（[完成和交付](docs/subsystems/issue.md#完成和交付)） |
| 频道 | `Channel`（`type: channel`、`direct`、`thread`） | 说话的地方，照 Discord：频道、私聊和串都是 channel；有一个默认频道（`default`，农场画成田头），主人和管家有一个私聊（`peer`），串挂在一个频道（`parent`）的一条消息（`root`）下面；外面的聊天软件经连接器接到一个频道上 |
| 工单串 | `type: thread`、`subjectKind: issue` | 一张工单下的对话，相当于 Linear 的评论 |
| 计划 | `TaskGraph`：带 `graph` 的父工单 | 一件大活拆成的一张 DAG：每件是带 `task` 的子工单，先后是 `blockedBy`；每件合进计划分支，最后合进主分支 |
| 定时 | `Recurrence` | 一张工单的一种触发：一个定时一张工单，派给一个档案或管家，每次到点是它的一次 run |
| Inbox | `InboxItem` | 要你处理的事，从核心状态现算 |
| 记忆 | `Memory` | 一个档案记得的事 |
| 技能 | `Skill` | 档案能带的技能 |

## 农场是皮

农场只画上面这些东西现在的样子，自己不管事；每个农场里的东西都对得上一件实际的事。游戏规则只读事件、算画面。

| 农场里 | 画的是 |
|---|---|
| 岛 | 一个项目 |
| 一块地 | 一张工单；开了 worktree 的代码工单带一个 worktree（岛上围着篱笆的那块）。一座岛上的空位是这个项目同时在做的工单数 |
| 院门外的种子袋 | 排队等空地的工单（待办） |
| 地里的小动物 | 在这块地上干活的帮工（Session），可以换人 |
| 庄稼 | 这一轮做到哪了；交回来以后看工单：干裂是缺肥，开花是等验收，杂草是没过验收，结出来是验收过了（[farm-ui.md](docs/reference/farm-ui.md)「地里长什么」；叫法见[用语表](docs/README.md#用语)） |
| 一季庄稼 | 一次干活（run） |
| 小动物走去哪 | 它正在用的工具 |
| 手、浇水、施肥、杀虫、验收、收获、铲除 | 派活（挪到待办）、带话、回答它问的、让它修、打回（带话挪回待办）、收获（挪到已完成，也就是验收通过）、叫停或请走（挪到已取消） |
| 等级 | 一共提交了多少次 |
| 金币、连胜、成就 | 从账本里的真实事件折出来 |
| 院子里的建筑 | 各个页面的入口 |

核心状态里还混着金币和成就；见[提案](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)。

一块地上可以有几个帮工（做过这块地的都在「地上的人」里），锄头在现在干活的那个手上；@ 谁就让谁下地、几个人分工、派一个看地的，还没做（[一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)）。
