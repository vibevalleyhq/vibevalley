# 概念

VibeValley 是 AI 版的 [Linear](https://linear.app)，和 [Multica](https://github.com/multica-ai/multica) 是一类东西；不同的是只给一个人在自己的机器上用，多了一个替你派活的管家，外面画成一座农场。对象模型照 Linear（Workspace、Issue、优先级、状态）；项目是我们自己的，指一个 git 仓库。

代码、接口和讲服务端的文档用这里的概念；界面用农场的叫法（[用语](README.md#用语)）。每个概念在界面、协议、HTTP、服务端、存储和 oar 里叫什么，见 [concept-map.md](reference/concept-map.md)。

## 层次

```
Workspace（工作目录，一张大地图）
├── 项目（一个 git 仓库，大地图上的一座岛）
└── 工单（可以指一个项目）
    ├── 分支和 worktree（岛上的一块地：工单在做时占一块，重开还是这一块）
    └── Session（在这块地上干活的帮工；派一次是一个，重开是下一个）
        └── run（一次干活：一次触发到一次汇报）
```

现在只有一个 Workspace：工作目录 `VIBEVALLEY_WORK_ROOT`（项目在 `projects/`，worktree 在 `worktrees/`）和家目录 `VIBEVALLEY_HOME`。

## 一件活怎么走

1. 主人或管家写下一张**工单**，选一个 **agent 档案**和一个**项目**，派出去。
2. 服务端开一个 **Session**：档案在一个 runtime 上接的这份活，在这张工单的 worktree 里、工单的分支上干（`vibevalley/issue-<工单号>`）。
3. 每次 **run** 从一次触发开始（派出去、一条 comment、计划走到下一步、定时），到一次汇报结束；中间每一**步**都记下来。
4. 主人看**改动**，挪工单的状态：挪到已完成是合进主分支或提 PR（工单关上），带句话挪回待办是再干一轮，挪到已取消是不合就关（[改状态就是派活](../.agents/notes/implemented/architecture/2026-10-18-status-is-the-dispatch.md)）。

说话都在**频道**里，结构照 Discord：频道 → 消息 → 挂在消息下面的串，每张工单一个串。现在只有一个人：主人，没有成员和权限；在频道里说话的是主人、管家和档案（经它的 Session）。同时干活的 Session 有上限，派不出去的排队。

## Session 和 oar 会话

单写的 Session 只指上面这一层：一个档案为一张工单接的活。农机那一层（smith 的 `oar.Session`，重启后会换一个）在代码里只经包名出现，文档里写「oar 会话」；中文里我们这一层写 Session，不写「会话」（[Worker 改叫 Session](../.agents/notes/proposed/architecture/2026-10-17-worker-is-a-session.md)）。

## 东西

| 概念 | 代码里 | 是什么 | 农场里 |
|---|---|---|---|
| Workspace | `Config.WorkRoot`、`Config.Home` | 全部项目、工单、群聊、档案；同时干活的上限（6）是它的 | 大地图（`/map`） |
| 管家 | `Manager` | 主人的助理 agent：听主人说，拆成工单，派出去，转告结果 | 管家 |
| agent 档案 | `Agent` | 能派活的「同事」：runtime、模型、人设、技能、MCP、环境变量、长相 | 一种小动物 |
| runtime | `RuntimeInfo` | 本机上的一种编码 agent 程序，由 smith 驱动 | 农机 |
| 项目 | `Project` | 一个 git 仓库，和能同时在里面做的工单数（`slots`） | 岛，也是一张小地图 |
| 工单 | `Issue` | 一件活，从写下到关上一个 id；状态由服务端给，主人挪状态就是派活；在做时有自己的分支和 worktree，关上的能重开 | 看板上的卡片；在做时是一块地 |
| Session | `Session`（服务是 `session.Service`，派活是 `Issue.Hire`） | 档案为一张工单接的活，在工单的 worktree 和分支上干，直到收获或收工；跨好几次 run，重启后还是同一个 | 帮工：在一块地上干活的小动物 |
| Run | `Run`（`session_run` 表）；核心状态里是 `FactRun` 到 `FactReport` | 一次干活：一次触发到一次汇报，包着一个 oar turn | 一季庄稼 |
| 事件 | `SessionEvent`，一个 Session 的全部是它的日志 | 日志里的一条：收到的话、想、说、工具调用、重试、用量、出错，和 Run 的边界（`run/start`、`run/end`）；类型照 DeepSeek Harness 写成 `<主体>/<做了什么>` | 干活过程 |
| 改动 | `Changes` | 分支上的提交和 diff，合进去会不会冲突 | 收成清单 |
| 合并 | `Issue.SetStatus`（挪到 `done`；`issue/merges.go`） | 把工单的分支合进主分支（`github.pr_projects` 里的项目是提 PR，PR 合了才关），关上工单 | 收获 |
| 频道 | `Conversation`（`kind: general`、`channel`） | 说话的地方；默认的是田头，主人可以再开；外面的聊天软件经连接器接到一个频道上 | 田头和别的频道 |
| 工单串 | `kind: thread`、`subjectKind: issue` | 一张工单下的对话，相当于 Linear 的评论 | 工单串 |
| 计划 | `TaskGraph`：带 `graph` 的父工单 | 一件大活拆成的一张 DAG：每件是带 `task` 的子工单，先后是 `blockedBy`；每件合进计划分支，最后合进主分支 | 种植计划 |
| 定时 | `Schedule` | 一张工单的一种触发：一个定时一张工单，派给一个档案或管家，每次到点是它的一次 run | 定时 |
| Inbox | `InboxItem` | 要你处理的事，从核心状态现算 | 手机来电 |
| 记忆 | `Memory` | 一个档案记得的事 | 记性 |
| 技能 | `Skill` | 档案能带的技能 | 技能书 |

## 农场是皮

农场只画上面这些东西现在的样子，自己不管事；每个农场里的东西都对得上一件实际的事。游戏规则只读事件、算画面。

| 农场里 | 画的是 |
|---|---|
| 岛 | 一个项目 |
| 一块地 | 一张在做的工单：它的分支和 worktree；一座岛上的地和空位是这个项目同时在做的工单数 |
| 院门外的种子袋 | 排队等空地的工单（待办） |
| 地里的小动物 | 在这块地上干活的帮工（Session），可以换人 |
| 庄稼 | 这一轮做到哪了（[farm-ui.md](reference/farm-ui.md)「地里长什么」）；熟了就是工单等你看 |
| 一季庄稼 | 一次干活（run） |
| 小动物走去哪 | 它正在用的工具 |
| 手、浇水、杀虫、收获、铲除 | 派活（挪到待办）、带话、让它修、收获（挪到已完成）、叫停或请走（挪到已取消） |
| 等级 | 一共提交了多少次 |
| 金币、连胜、成就 | 从账本里的真实事件折出来 |
| 院子里的建筑 | 各个页面的入口 |

核心状态里还混着金币和成就；见[提案](../.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)。

还没对上的：地块详情和工单详情还是两页，项目页还把项目画成一块地；见[一块地是一张在做的工单](../.agents/notes/proposed/architecture/2026-10-18-a-plot-is-an-issue.md)。
