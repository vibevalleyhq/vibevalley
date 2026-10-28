# 概念在各层的名字

一个概念在每一层叫什么：从农场里看到的，到页面、协议、HTTP、服务端、存储，最后到 oar。概念本身是什么见 [concepts.md](docs/concepts.md)，叫法见[用语表](docs/README.md#用语)。分层和存盘见[架构](docs/architecture.md#分层)与[存了什么](docs/architecture.md#存了什么)，Session、Run 和 oar 会话见[帮工](docs/subsystems/session.md#模型和不变量)。

这里只查名字，不补成完整的接口或存储清单。完整接口和权限见[能力表](docs/reference/capabilities.md)。

## 看得见的几层

农场、页面、协议和代表 HTTP 入口的对照：

| 概念 | 农场里 | 页面 | 协议 | HTTP |
|---|---|---|---|---|
| Workspace | 大地图 | `/projects` 的「全部」（`features/project/ProjectMap.tsx`） | `Config.workRoot`、`Config.home`（服务端的配置，不进协议） | |
| 项目 | 大地图上的一座岛 | `/projects/:project`（`features/project`；岛的地和空位是 `ProjectMap.tsx` 的 `IslandDetail`） | `ProjectSummary`、`ProjectActivity`、`ProjectLanguages`；帮工在哪个项目、目录、分支是服务端的 `Workplace` | `/api/v1/project/…` |
| 档案 | 一种小动物（管家是田头的人） | `/agents`（`features/agent`） | `Agent`（`role` 是管家或帮工） | `/api/v1/agent/…` |
| 农机 | 农具 | `/runtimes`（`features/runtime`） | `RuntimeInfo`、`RuntimeSettings` | `/api/v1/runtime/…` |
| 技能书 | 技能书 | `/settings/skills`（`features/runtime/SkillsPage.tsx`） | `Skill` | `/api/v1/skill/…` |
| 记性 | 记性 | 档案页和管家页（`features/memory/Memory.tsx`） | `Memory`、`MemoryList` | `/api/v1/memory/…`（`agent` 是管家的档案时是那个管家的） |
| 管家 | 管家 | `/orchestrator`、`/orchestrator/<档案 id>`（`features/orchestrator`） | `WorkspaceState.orchestrators`（每个管家的状态）、`Channel.orchestrator`（照看那处的管家） | `/api/v1/channel/message/send`、`/api/v1/orchestrator/…` |
| 工单 | 看板上的卡片 | `/issues`（`features/issue`） | `Issue`、`Issue.sessions`（这张工单用过的帮工） | `/api/v1/issue/…` |
| 计划 | 种植计划：图纸桌、计划板 | `farm/panels/TaskBoard.tsx`、工作台 `features/issue/TaskDetail.tsx` | `TaskGraph`（从父工单拼回，`StateFrame.graphs`），每件是 `Task` | `/api/v1/graph/…` |
| 帮工 | 在一块地上干活的小动物 | 地块和地块详情（`farm/issue/IssueView.tsx`） | `Session`（`WorkspaceState.sessions`） | `/api/v1/session/stop`；别的按工单：`/api/v1/issue/…` |
| 一次干活（run） | 一季庄稼 | 地里长什么（`Session.phase`）；工单详情的「每次干活」 | `Run`、`RunTrigger`；核心状态里是 `run` 到 `report` 两个事实、`Session.runs`、`lastRun` | `/api/v1/issue/run/list` |
| 干活过程 | 干活过程 | `features/session/WorkLog.tsx`、`features/session/Trajectory.tsx` | `Session`（走了的阶段是 `closed`）、`SessionEvent`（它的日志） | `/api/v1/session/list`、`/api/v1/session/get`、`/api/v1/session/event/list` |
| 改动、完成 | 收成清单、收获 | 农场 `farm/panels/Harvest.tsx`、工作台 `features/issue/CloseDialog.tsx` | `Changes` | `/api/v1/issue/diff/get`、`/api/v1/issue/status/update`（挪到 `done`） |
| 验收、验收意见、问题 | 抽穗、长草、结果、缺肥 | 工单详情（规则 `features/issue/state.ts`，农场 `farm/issue/IssueView.tsx`、工作台 `features/issue/IssueDetail.tsx`）的状态框、输入框里的验收、意见 | `Issue.review`、`reviewedAt`、`findings`、`questions`；地的样子是 `plotOf`（`apps/server/src/game/view.ts`） | `/api/v1/issue/act`（验收通过是 `act: "accept"`，打回是 `act: "reject"`）；`questions` 来自帮工汇报（`report` 事实的 `questions`） |
| 默认频道、频道、私聊 | 田头、频道 | 田头窗口和它的频道菜单（`farm/chat`）、`/chat`（`features/channel`） | `Channel`（`type`：`channel`、`direct`；默认的带 `default`，私聊带 `peer`）、`ChatMessage`、`WorkspaceState.chat` | `/api/v1/channel/…`、`/api/v1/channel/message/send`、`/api/v1/channel/message/list` |
| 工单串、评论 | 工单串、浇水 | 派活消息下面的串；地块和工单详情里的「浇水：带句话」 | `Channel`（`type: thread`，挂在 `parent` 频道的 `root` 消息下）；评论是对整张工单说的，交给它最新的帮工，不挂在某一步上 | `/api/v1/channel/message/list`、`/api/v1/issue/comment/create` |
| 定时 | 定时 | 频道菜单里；它的工单在看板上，带「定时」标签 | `Recurrence`；它的工单是 `Issue.recurrence` 指着它的那张 | `/api/v1/recurrence/…` |
| 工单模板 | 播种袋里的种子 | 播种袋（`farm/panels/SeedForms.tsx`） | `ProjectTemplates`、`TemplateKind`、`IssueTemplate`；目录是 `apps/server/src/agent/template_catalog.json` | `/api/v1/project/template/list` |
| 来电 | 手机来电 | `farm/phone/calls.ts` | `InboxItem`（`StateFrame.inbox`，`apps/server/src/notice/inbox.ts` 从核心状态现算） | |
| 连接器 | 连接器 | `/settings/connectors`（`features/connector/ConnectorsPage.tsx`） | `ConnectorStatus` | `/api/v1/connector/…` |
| （不画） | 连接到本机 | `/settings/lan`（`features/lan/LanPage.tsx`）、连进来的设备的 `/pair`（`features/lan/PairPage.tsx`） | `LanStatus`、`LanDevice` | `/api/v1/lan/…` |
| 语音 | 麦克风 | `/settings/voice`（`features/voice/VoiceForm.tsx`）、`features/voice/` | `VoiceSettings` | `/api/v1/voice/...` |
| 进度、成就 | 金币、连胜、任务与成就 | `farm/panels/Achievements.tsx` | `Progress`、`LedgerEntry`、`WorkspaceState.progress` | 帧里的 `progress` 和 `view.achievements`；成就的说法 `game.achievement.list` |
| 等级 | 等级、经验 | 农场卡、任务与成就 | `CommitCount`、`FarmView.level` | |
| 地 | 一块地：一张工单 | 像素村（`farm/canvas`）、地块详情（`farm/issue/IssueView.tsx`） | 干活地点是服务端 `Workplace`；开 worktree 时分支由 `issueBranch` 给出，目录是 `worktrees/<项目>.<工单号>`，否则直接在项目目录且 `branch` 为空；`FarmView.plots` 按帮工的 id 做键（服务端 `game/view.ts` 的 `viewOf`）；帮工站在哪块地是 `SessionPlay.station` | `/api/v1/channel/message/send` 的 `station` |

## 服务端以下

服务、存储和 oar 的对照；存储只列主要归属，完整存盘见[架构](docs/architecture.md#存了什么)。

| 概念 | 服务端 | 存储 | oar |
|---|---|---|---|
| Workspace | `base/config.ts` 的 `Config`；`services.ts` 把全部服务叠起来 | `VIBEVALLEY_WORK_ROOT`、`VIBEVALLEY_HOME` | |
| 项目 | `Projects`（`project/project.ts`、`git.ts`、`stack.ts`） | 工作目录下的 git 仓库 | 会话的 `cwd` |
| 档案、技能书 | `Agents` | `config.json` | |
| 农机 | `Runtimes` | `config.json` 里每台农机的设置、`spend.json` | `Runtime`、`RuntimeRegistry` |
| 记性 | `Memories` | `memory` 表；管家的在 `agent/<档案 id>/MEMORY.md` | |
| 管家 | `Orchestrator`（每个管家一个宿主） | `agent/<档案 id>/` | 不经 oar 的子会话：跑在 VibeValley 自己的 agent 上（`agent/brain`） |
| 工单 | `Issues`（`issue/issue.ts`；派给管家的在 `orchestrator/orchestrator.ts`） | `issue`、`issue_session` 表（一行是一个帮工） | |
| 计划 | `Tasks`（`task/task.ts`） | `issue` 表（带 `graph` 的父工单、带 `task` 的子工单）、`task_event` 表 | |
| 帮工 | `Sessions`（`session/session.ts`） | `state.json`（在场帮工的核心状态）、`session` 表（工作目录、oar 会话 id、最后一轮原话和想起过的记性） | 一个帮工是一个 `Subagent`，包着一个 oar 的会话；每个帮工有自己的 `Subagents` |
| 一次干活（run） | `Sessions`（帮工的 run 在 `session/session.ts`；进程内 agent 的 run 在 `session/execution.ts`）；`session/facts.ts` 把会话事件读成事实 | `session_run` 表 | 帮工的一次 run 包着一个 oar turn（开始到结束），结束时交一份 `SubagentReport` |
| 干活过程 | `Sessions`（`session/journal.ts`） | `session` 表、`events/<id>.json`；原始记录在 `logs/` | oar 的事件：文字、思考、工具调用的开始和结束…… |
| 改动、完成 | `Issues`（挪到 `done`、合并、提 PR；`project/project.ts` 管分支和 worktree） | 开 worktree 时的工单分支和 worktree；直接在项目目录干活的没有这两项 | |
| 默认频道、频道、工单串 | `Channels`（`channel/chat.ts`）；帮工在频道里说话经 `/mcp`（`Mcp`、`Tools`） | `channel`、`channel_message`、`channel_participant`、`channel_delivery`、`channel_read_cursor`、`channel_mention`、`channel_follow`、`channel_seen_mark` 表 | 送到帮工的话是 oar 的 `prompt`、`steer`、`queue` |
| 定时 | `Recurrences` | `recurrence` 表 | |
| 巡查 | `Notices`（`notice/notice.ts`；规则在 `notice/rules.ts`） | 不存：每轮从核心状态算 | |
| 来电 | `Notices`（`notice/notice.ts`、`notice/inbox.ts`） | 不存：`StateFrame.inbox` 从核心状态现算 | |
| 连接器 | `Connectors`；三家的接口在 `connector/weixin.ts`、`feishu.ts`、`qq.ts` | `connector_account`、`connector_inbound`、`connector_outbox` 表 | |
| 「连接到本机」 | `Lan` | `lan`、`lan_device` 表 | |
| 语音 | `Voice`（`voice/voice.ts`；声网的令牌和语音 agent 用 npm 的 `agora-token`、`agora-agents`） | `settings.json` | |
| 钥匙和语音设置 | `Setting` | `settings.json`（只有你能读） | 会话的 `env` |
| 进度、成就 | `Game`（`game/game.ts`、`progress.ts`） | `game_ledger` 表；进度从它折出来 | |
| 等级 | `Game` | `state.json` 里的 commit 数 | |
| 地 | `Game`；规则在 `apps/server/src/game/play.ts` | `state.json` 里的 `play.station` | |
| 核心状态 | `Core` | `state.json`（聊天、进度、定时和工单除外） | |

## oar 那一层

oar（`@botiverse/oar`）是驱动各家编码 agent 的运行时。它的术语和 VibeValley 的用法对照：

| oar | 是什么 | 我们这边用在哪 |
|---|---|---|
| `Runtime`、`RuntimeRegistry` | 一种编码 agent 程序和它的安装 | `Runtimes` 探测、算额度和花费 |
| session | 农机原生的一个会话，可以接着上回的 | 一个帮工的会话；会话 id 存在 `session.oar_session` |
| turn | 会话里的一轮：一个 prompt 开始，农机说结束时结束，结果是完成、中止或失败 | 帮工的一次 run 包着一个 oar turn |
| event | 一轮里的文字、思考、工具调用、用量、任务 | 读成事实和干活过程 |
| `prompt`、`steer`、`queue`、`withdraw`、`abort` | 往会话里送话、插话、排队、撤回、叫停 | 带话、叫停 |
| `Subagents`、`Subagent`、`SubagentReport`（`@botiverse/oar/agents`） | 宿主在任意农机上开的子会话，每结束一轮交一份报告；oar 把这种用法叫 crew | 每个帮工是一个 `Subagent` |

档案怎么进 oar 会话见[帮工](docs/subsystems/session.md#模型和不变量)，农机接受哪些选项见[档案和农机](docs/subsystems/agent.md#模型和不变量)。
