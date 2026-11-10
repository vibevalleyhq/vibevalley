# 概念

VibeValley 是 AI 版的 [Linear](https://linear.app)，和 [Multica](https://github.com/multica-ai/multica) 是一类东西；不同的是只给一个人在自己的机器上用，多了一个替你派活的助手，外面画成一座农场。对象模型照 Linear（工单、优先级、状态）；空间和代码仓库是我们自己的。

代码、接口和讲服务端的文档用这里的概念；界面用农场的叫法（[用语](docs/README.md#用语)）。每个概念在界面、协议、HTTP、服务端、存储和 oar 里叫什么，见 [concept-map.md](docs/reference/concept-map.md)。

## Host 和 Space

本机有一套 **Host**（`$VIBEVALLEY_HOME`，默认 `~/.vibevalley`）：只放跨空间共用的东西，模型密钥、农机探测、全局档案模板和日志。业务都在 **Space**（`$VIBEVALLEY_WORK_ROOT`，默认 `~/vibevalley-dev`）里：一个 Space 是一套独立的工作，换一个目录就是换一个 Space。

```
Host（~/.vibevalley：密钥、农机、全局模板）
└── Space（<space>/：repos、worktrees、pkm、AGENTS.md）
    ├── Repo（<space>/repos/<name>，一个 git 仓库，大地图上的一座岛）
    │   └── Worktree（<space>/worktrees/<repo>.<issue>，工单的检出）
    ├── Issue（工单，可以指一个 Repo）
    │   ├── Assignment → Agent 档案
    │   └── IssueThread → Channel
    ├── Pkm（<space>/pkm，按 PARA 组织的笔记）
    └── Artifact（Artifact）
```

一个 Space 有若干个 **Repo**、若干个 **Issue** 和一份 **Pkm**。Repo 是仓库本身；Issue 归 Space，用 `repo` 指向它要改的仓库，也可以不指（只调研、只写笔记）；指了仓库且档案开了 worktree 时，才为它切出 **Worktree**。Agent、Session、Run 是在这个 Space 里干活的执行和协同实体。

现在工单、频道这些状态还在 Host 的库里（`$VIBEVALLEY_HOME/db`），所以切换 Space 目前只切 `repos/`、`worktrees/` 和 `pkm/`，看板还没跟着切；让整个 Space 自包含是 [Space 领域模型](.agents/notes/proposed/architecture/2026-11-06-space-domain-model.md) 还没做完的一步。

## 一件活怎么走

1. 用户或助手写下一张**工单**，选一个 **agent 档案**和一个**仓库**，派出去。
2. 服务端开一个 **Session**：档案在一个 runtime 上接的这份活。档案开了 worktree 时，它在这张工单的 worktree 里、工单的分支上干（`vibevalley/issue-<工单号>`）；没开时在仓库目录里干。
3. 每次 **run** 从一次触发开始（派出去、一条 comment、前置子工单完成、定时任务），到一次汇报结束；中间每一**步**都记下来。
4. 用户看**改动**，决定**完成**还是**取消**。完成是工单的结论，交付另记：本地合进主分支、PR 合入、保留分支或没有改动要合；取消是不再做，分支上有提交就留着（[完成和交付](docs/subsystems/issue.md#完成和交付)）。

说话都在**频道**里，结构照 Discord：频道 → 消息 → 挂在消息下面的串，每张工单一个串。现在只有一个人：用户，没有成员和权限；在频道里说话的是用户、助手和档案（经它的 Session）。同时干活的 Session 有上限，派不出去的排队。

## Session 和 oar 会话

单写的 Session 指一个档案持续工作的执行上下文，可以处理工单，也可以承接频道里的聊天。农机那一层（oar 的会话，重启后会换一个）在代码里只经 oar 的 import 出现，文档里写「oar 会话」；中文里我们这一层写 Session，不写「会话」（[Worker 改叫 Session](docs/subsystems/session.md)）。

## 东西

农场里各叫什么、界面上用哪个字，见[用语表](docs/README.md#用语)，这里不再写一遍。

| 概念 | 代码里 | 是什么 |
|---|---|---|
| Host | `ServerConfig` 的 `home` | 本机的 VibeValley：跨空间共用的密钥、农机、全局档案模板和日志都在 `$VIBEVALLEY_HOME` |
| Space | `SpaceState`（核心状态）；目录是服务端 `ServerConfig` 的 `workRoot` | 一套独立的工作：`repos/`、`worktrees/`、`pkm/`；同时干活的上限（6）是它的 |
| 助手 | `Orchestrator` | 用户的助理 agent：听用户说，拆成工单，派出去，转告结果 |
| agent 档案 | `Agent` | 能派活的「同事」：runtime、模型、人设、技能、MCP、环境变量、长相 |
| runtime | `RuntimeInfo` | 本机上的一种编码 agent 程序，由 oar 驱动 |
| 仓库 | `Repo` | 一个 git 仓库，和能同时在里面做的工单数（`repo.max_sessions`，`RepoSummary.maxSessions`） |
| 工作树 | `Workplace` | 一张工单在某个仓库上的检出：`<space>/worktrees/<仓库>.<工单号>`，分支 `vibevalley/issue-<工单号>`；档案不开 worktree 时不切 |
| 工单 | `Issue` | 一件活，从写下到关上一个 id；状态由服务端给，用户挪状态就是派活；代码相关的开不开 worktree 由档案设置决定；每张都有验收，完成就是通过；关上的能重开 |
| 派工关联 | `Assignment` | 工单由哪个档案负责；可以尚未开工，同人继续负责时跨执行上下文保留，换人或清空指派才结束 |
| 执行器 | `Executor` | 管理 oar 执行实例的创建、投递、中断和释放；不替工单保存责任归属 |
| Session | `Session`（服务是 `Session`，派活是 `Issue` 的 `hire`） | 档案的执行上下文；工单使用仓库目录或工单 worktree，聊天使用独立目录并关联频道；跨多轮、休眠和重启保留身份 |
| Run | `Run`（`session_run` 表）；核心状态里由带着 `brief` 的 `sessionPhaseChanged` 事实开始、`sessionReported` 事实结束 | 一轮：一次触发到一次汇报；帮工的一次 run 包着一个 oar turn，进程内 agent 的 loop 也记 Run |
| 事件 | `SessionEvent`，一个 Session 的全部是它的日志 | 日志里的一条：收到的话、想、说、工具调用、重试、用量、出错，和 Run 的边界（`run/start`、`run/end`）；类型照 DeepSeek Harness 写成 `<主体>/<做了什么>` |
| 改动 | `Changes` | 分支上的提交和 diff，合进去会不会冲突 |
| 完成 | 动作 `complete`；工单的 `status` 是 `done` | 用户对工单的结论；交付由 `delivered` 另记。合并只是交付的一种，PR 合入后才完成（[完成和交付](docs/subsystems/issue.md#完成和交付)） |
| 父子工单 | `Issue.parent`、`blockedBy`（拆单输入 `IssueChildDraft`） | 一件大活拆成有先后的子工单：每张子工单是普通工单，前置做完后派发，过了检查先合进父工单分支，最后由父工单统一验收、合进主分支 |
| 频道 | `Channel`（`type: channel`、`direct`、`thread`） | 说话的地方，照 Discord：频道、私聊和串都是 channel；有一个默认频道（`default`，农场画成田头），用户和助手有一个私聊（`peer`），串挂在一个频道（`parent`）的一条消息（`root`）下面；外面的聊天软件经连接器接到一个频道上 |
| 工单串 | `type: thread`、`subjectKind: issue` | 一张工单下的对话，相当于 Linear 的评论 |
| Artifact | `Artifact`（正文 `blocks` 或 `html`） | 留下来要人看的一篇：一起一块一块写的块 Artifact，或交上来一稿一稿换的网页 |
| 笔记 | `Pkm`（`PkmPage`、`PkmBlock`） | 用户的大纲知识库：按 PARA 文件夹与日记组织的 Markdown 页面 |
| 定时任务 | `Cron` | 一张工单的一种触发：一个定时任务一张工单，派给一个档案或助手，每次到点是它的一次 run |
| Inbox | `InboxItem` | 要你处理的事，从核心状态现算 |
| 记忆 | `Memory` | 一个档案记得的事 |
| 技能 | `Skill` | 档案能带的技能 |

## 农场是皮

农场只画上面这些东西现在的样子，自己不管事；每个农场里的东西都对得上一件实际的事。游戏规则只读事件、算画面。

| 农场里 | 画的是 |
|---|---|
| 岛 | 一个仓库 |
| 一块地 | 一张工单；开了 worktree 的代码工单带一个 worktree（岛上围着篱笆的那块）。一座岛上的空位是这个仓库同时在做的工单数 |
| 院门外的种子袋 | 排队等空地的工单（待办） |
| 地里的小动物 | 在这块地上干活的帮工（Session），可以换人 |
| 庄稼 | 这一轮做到哪了；交回来以后看工单：干裂是缺肥，开花是等验收，杂草是没过验收，结出来是验收过了（[farm-ui.md](docs/reference/farm-ui.md)「地里长什么」；叫法见[用语表](docs/README.md#用语)） |
| 一季庄稼 | 一轮（run） |
| 小动物走去哪 | 它正在用的工具 |
| 手、浇水、施肥、杀虫、验收、收获、铲除 | 派活（挪到待办）、带话、回答它问的、让它修、打回（带话挪回待办）、收获（挪到已完成，也就是验收通过）、叫停或请走（挪到已取消） |
| 等级 | 一共提交了多少次 |
| 金币、连胜、成就 | 从账本里的真实事件折出来 |
| 院子里的建筑 | 各个页面的入口 |

一块地上可以有几个帮工（做过这块地的都在「地上的人」里），锄头在现在干活的那个手上；@ 谁就让谁下地、几个人分工、派一个看地的，还没做（[一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)）。
