# 概念

VibeValley 是 AI 版的 [Linear](https://linear.app)，和 [Multica](https://github.com/multica-ai/multica) 是一类东西；不同的是只给一个人在自己的机器上用，多了一个替你派活的主助手，外面另有一套像素农场皮肤。对象模型照 Linear（任务、优先级、状态）；空间和代码仓库是我们自己的。

代码、接口和讲服务端的文档用这里的概念；工作台界面用人话用语，农场皮肤用农场的叫法（[用语](docs/README.md#用语)）。每个概念在界面、协议、HTTP、服务端、存储和 oar 里叫什么，见 [concept-map.md](docs/reference/concept-map.md)。

## Host 和 Space

本机有一套 **Host**（`$VIBEVALLEY_HOME`，默认 `~/.vibevalley`）：只放跨空间共用的东西，模型密钥、引擎探测、全局角色模板和日志。业务都在 **Space**（`$VIBEVALLEY_WORK_ROOT`，默认 `~/vibevalley-dev`）里：一个 Space 是一套独立的工作，换一个目录就是换一个 Space。

```
Host（~/.vibevalley：密钥、引擎、全局角色模板）
└── Space（<space>/：repos、worktrees、AGENTS.md）
    ├── Repo（<space>/repos/<name>，一个 git 仓库，地图上的一座岛）
    │   └── Worktree（<space>/worktrees/<repo>.<issue>，任务的检出）
    ├── Issue（任务，可以指一个 Repo）
    │   ├── Assignment → Agent 角色
    │   └── IssueThread → Channel
    └── Artifact（作品，含 outline 大纲笔记）
```

一个 Space 有若干个 **Repo**、若干个 **Issue** 和若干份 **Artifact**。Repo 是仓库本身；Issue 归 Space，用 `repo` 指向它要改的仓库，也可以不指（只调研、只写大纲或文档）；指了仓库且角色开了 worktree 时，才为它切出 **Worktree**。Agent、Session、Run 是在这个 Space 里运行与协同的实体。

现在任务、频道这些状态还在 Host 的库里（`$VIBEVALLEY_HOME/server.db`），所以切换 Space 目前只切 `repos/` 和 `worktrees/`，看板还没跟着切；让整个 Space 自包含是 [Space 领域模型](.agents/notes/proposed/architecture/2026-11-06-space-domain-model.md) 还没做完的一步。

## 一件活怎么走

1. 用户或主助手写下一个**任务**，选一个 **Agent 角色**和一个**仓库**，派出去。
2. 服务端开一个 **Session（执行会话）**：角色在一个引擎（runtime）上接下这份活。角色开了 worktree 时，它在这个任务的 worktree 里、任务的分支上工作（`vibevalley/issue-<任务号>`）；没开时在仓库目录里工作。
3. 每次 **run** 从一次触发开始（派出去、一条 comment、前置子任务完成、定时任务），到一次汇报结束；中间每一步都记下来。
4. 用户看**改动**，决定**完成**还是**取消**。完成是任务的结论，交付另记：本地合进主分支、PR 合入、提交了 PR、保留分支或没有改动要合；取消是不再做，分支上有提交就留着（[完成和交付](docs/subsystems/issue.md#完成和交付)）。

说话都在**频道**里，结构照 Discord：频道 → 消息 → 挂在消息下面的话题，每个任务一个话题。现在只有一个人：用户，没有成员和权限；在频道里说话的是用户、主助手和角色（经它的 Session）。同时运行的 Session 有并发上限，派不出去的排队。

## Session 和 oar 会话

单写的 Session 指一个角色持续运行的执行上下文（工作台叫**执行会话**），可以处理任务，也可以承接频道里的对话。引擎那一层（oar 的会话，重启后会换一个）在代码里只经 oar 的 import 出现，文档里写「oar 会话」；中文里我们这一层写 Session 或执行会话（[Session 概念](docs/subsystems/session.md)）。

## 东西

工作台和农场的具体叫法，见[用语表](docs/README.md#用语)，这里不再写一遍。

| 概念 | 代码里 | 是什么 |
|---|---|---|
| Host | `ServerConfig` 的 `home` | 本机的 VibeValley：跨空间共用的密钥、引擎、全局角色模板和日志都在 `$VIBEVALLEY_HOME` |
| Space | `SpaceState`（核心状态）；目录是服务端 `ServerConfig` 的 `workRoot` | 一套独立的工作：`repos/`、`worktrees/`；同时运行的上限（6）是它的 |
| 主助手 | `Orchestrator` | 用户的统筹 agent：听用户说，拆成任务，派出去，转告结果 |
| Agent 角色 | `Agent` | 能派活的「同事」：引擎、模型、人设、技能、MCP、环境变量、长相 |
| 引擎 | `RuntimeInfo` | 本机上的一种编码 agent 程序，由 oar 驱动 |
| 仓库 | `Repo` | 一个 git 仓库，和能同时在里面做的任务数上限（`repo.max_sessions`，`RepoSummary.maxSessions`） |
| 工作树 | `Workplace` | 一个任务在某个仓库上的检出：`<space>/worktrees/<仓库>.<任务号>`，分支 `vibevalley/issue-<任务号>`；角色不开 worktree 时不切 |
| 任务 | `Issue` | 一件活，从写下到关上一个 id；状态由服务端给，用户挪状态就是派活；代码相关的开不开 worktree 由角色设置决定；每个都有验收，完成就是通过；关上的能重开 |
| 派工关联 | `Assignment` | 任务由哪个角色负责；可以尚未开工，同人继续负责时跨执行上下文保留，换人或清空指派才结束 |
| 执行器 | `Drivers`（`crates/server/src/runtime/session/driver.rs`） | 将指派的角色装配为 oar 引擎参数并开启会话；不替任务保存责任归属 |
| Session | `Session`（服务是 `Session`，派活是 `Issue` 的 `hire`） | 角色的执行上下文（界面叫执行会话）；任务使用仓库目录或任务 worktree，对话使用独立目录并关联频道；跨多轮、休眠和重启保留身份 |
| Run | `Run`（`session_run` 表）；核心状态里由带着 `brief` 的 `sessionPhaseChanged` 事实开始、`sessionReported` 事实结束 | 一轮：一次触发到一次汇报；执行会话的一次 run 包着一个 oar turn，进程内 agent 的 loop 也记 Run |
| 事件 | `SessionEvent`，一个 Session 的全部是它的日志 | 日志里的一条：收到的话、想、说、工具调用、重试、用量、出错，和 Run 的边界（`run/start`、`run/end`）；类型照 DeepSeek Harness 写成 `<主体>/<做了什么>` |
| 改动 | `Changes` | 分支上的提交和 diff，合进去会不会冲突 |
| 完成 | 动作 `complete`；任务的 `status` 是 `done` | 用户对任务的结论；交付去向由 `delivered` 另记，按任务的 `deliver` 判定（[完成和交付](docs/subsystems/issue.md#完成和交付)） |
| 父子任务 | `Issue.parent`、`blockedBy`（拆单输入 `IssueChildDraft`） | 一件大活拆成有先后的子任务：每个子任务是普通任务，前置做完后派发，过了检查先合进父任务分支，最后由父任务统一验收、合进主分支 |
| 频道 | `Channel`（`type: channel`、`direct`、`thread`） | 说话的地方，照 Discord：频道、私聊和话题都是 channel；有一个默认频道（`default`，农场画成田头），用户和主助手有一个私聊（`peer`），话题挂在一个频道（`parent`）的一条消息（`root`）下面；外面的聊天软件经连接器接到一个频道上 |
| 任务话题 | `type: thread`、`subjectKind: issue` | 一个任务下的对话，相当于 Linear 的评论 |
| 作品 | `Artifact`（正文 `blocks`、`store` 或 `html`） | 留下来要人看的作品：协作块文档（含 `outline` 树状大纲与 `.md` 导入）、结构化多条目作品（幻灯片、看板、短片、白板、界面画板、设计体系）或按稿保存的单页网页 |
| 定时任务 | `Cron` | 一个任务的一种触发：一个定时任务对应一个任务，派给一个角色或主助手，每次到点是它的一次 run |
| 收件箱 | `InboxItem` | 要你处理的事，从核心状态现算（[核心状态的收件箱](docs/subsystems/core.md#收件箱)） |
| 记忆 | `Memory` | 一个角色记得的事 |
| 技能 | `Skill` | 角色能带的技能 |

## 农场是皮

农场只画上面这些东西现在的样子，自己不管事；每个农场里的东西都对得上一件实际的事。游戏规则只读事件、算画面。农场里的什么画的是哪件事、农具对应哪个动作，见[农场的皮](docs/subsystems/farm.md)。
