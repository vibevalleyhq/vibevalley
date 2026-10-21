# 概念在各层的名字

一个概念在每一层叫什么：从农场里看到的，到页面、协议、HTTP、服务端、存储，最后到 oar。概念本身是什么见 [concepts.md](docs/concepts.md)，叫法见[用语表](docs/README.md#用语)。小队还没做，见[提案](docs/subsystems/session.md)。

## 各层

从上往下：

1. **农场里**：像素村里画出来的样子和玩法（[farm-ui.md](docs/reference/farm-ui.md)、[pixel-village.md](docs/reference/pixel-village.md)）。
2. **页面**：Solid 的页面和组件，在 `apps/web/src/`（农场在 `farm/`，工作台在 `pages/`）。页面只读折好的状态，不折事实。
3. **协议**：`packages/protocol` 的形状（`shapes.ts`）、事实和规则（`src/rules`）；服务端和页面 import 同一份。
4. **HTTP 和 MCP**：`/api/v1/...`（`packages/protocol/src/api.ts` 的 `endpoints`），核心状态经 `GET /api/v1/state` 推给页面；编码 agent 经 `/mcp` 用农场的工具，现在是帮工在频道里说话。
5. **服务端**：`apps/server/src/<模块>` 一个模块一个服务（`Issues`、`Sessions`……），下面写成「服务.方法」或文件名（[地基](docs/subsystems/foundation.md)）。
6. **存储**：`$VIBEVALLEY_HOME` 下的文件和库里的表（[architecture.md](docs/architecture.md)「存储」）。
7. **oar**：npm 的 `@botiverse/oar` 里的类型。

## 看得见的几层

| 概念 | 农场里 | 页面 | 协议 | HTTP |
|---|---|---|---|---|
| Workspace | 大地图 | `/projects` 的「全部」（`pages/projects/ProjectMap.tsx`） | `Config.workRoot`、`Config.home`（服务端的配置，不进协议） | |
| 项目 | 大地图上的一座岛 | `/projects/:project`（`pages/projects`；岛的地和空位是 `ProjectMap.tsx` 的 `IslandDetail`） | `ProjectSummary`、`ProjectActivity`、`ProjectLanguages`；帮工在哪个项目、目录、分支是服务端的 `Workplace` | `/api/v1/projects` |
| 帮工档案 | 一种小动物 | `/agents`（`pages/agents`） | `Agent` | `/api/v1/agents` |
| 农机 | 农具 | `/runtimes`（`pages/runtimes`） | `RuntimeInfo`、`RuntimeSettings` | `/api/v1/runtimes` |
| 技能书 | 技能书 | `/settings/skills`（`pages/settings/SkillsPage.tsx`） | `Skill` | `/api/v1/skills` |
| 记性 | 记性 | 档案页和管家页（`pages/Memory.tsx`） | `Memory`、`MemoryList` | `/api/v1/memories/{agent}`（管家是 `manager`） |
| 管家 | 管家 | `/manager`（`pages/manager`） | `CoreState.manager`（管家的状态） | `/api/v1/say`、`/api/v1/manager/...` |
| 工单 | 看板上的卡片 | `/issues`（`pages/issues`） | `Issue`、`Issue.sessions`（这张工单用过的帮工） | `/api/v1/issues` |
| 种植计划 | 图纸桌、计划板 | `farm/panels/TaskBoard.tsx` | `TaskGraph`（从父工单拼回，`StateFrame.graphs`），每件是 `Task` | `/api/v1/graphs` |
| 帮工 | 在一块地上干活的小动物 | 地块和地块详情（`farm/issue/IssueView.tsx`） | `Session`（`CoreState.sessions`） | `/api/v1/sessions/{id}/stop`；别的按工单：`/api/v1/issues/{id}/...` |
| 一次干活（run） | 一季庄稼 | 地里长什么（`Session.phase`）；工单详情的「每次干活」 | `Run`、`RunTrigger`；核心状态里是 `run` 到 `report` 两个事实、`Session.runs`、`lastRun` | `/api/v1/issues/{id}/runs` |
| 干活过程 | 干活过程 | `pages/chat/WorkLog.tsx`、`pages/Trajectory.tsx` | `Session`（走了的阶段是 `closed`）、`SessionEvent`（它的日志） | `/api/v1/sessions`、`/api/v1/sessions/{id}`、`/api/v1/sessions/{id}/events` |
| 收成清单、收获 | 收获 | 农场 `farm/panels/Harvest.tsx`、工作台 `pages/issues/CloseDialog.tsx` | `Changes` | `/api/v1/issues/{id}/changes`、`/api/v1/issues/{id}/status`（挪到 `done`） |
| 验收、草、缺肥 | 抽穗、长草、结果、缺肥 | 工单详情（规则 `rules/issueState.ts`，农场 `farm/issue/IssueView.tsx`、工作台 `pages/issues/IssueDetail.tsx`）的状态框、输入框里的验收、草 | `Issue.acceptance`、`acceptedAt`、`findings`、`asks`；地的样子是 `plotOf`（`rules/view.ts`） | `/api/v1/issues/{id}/accept`；`asks` 来自帮工汇报（`report` 事实的 `asks`） |
| 田头、频道 | 田头 | 田头窗口（`farm/chat/ChatWindow.tsx`）、`/chat`（`pages/chat`） | `Conversation`（`kind`：`general`、`channel`）、`ChatMessage`、`CoreState.chat` | `/api/v1/channels`、`/api/v1/channels/{id}/messages` |
| 工单串、评论 | 工单串、浇水 | 派活消息下面的串；地块和工单详情里的「浇水：带句话」 | `Conversation`（`kind: thread`）；评论是对整张工单说的，交给它最新的帮工，不挂在某一步上 | `/api/v1/channels/{id}/messages`、`/api/v1/issues/{id}/comment` |
| 定时 | 定时 | 频道菜单里；它的工单在看板上，带「定时」标签 | `Schedule`；它的工单是 `Issue.schedule` 指着它的那张 | `/api/v1/schedules` |
| 工单模板 | 播种袋里的种子 | 播种袋（`farm/panels/SeedForms.tsx`） | `ProjectTemplates`、`TemplateKind`、`IssueTemplate`；目录是 `packages/protocol/src/rules/template_catalog.json` | `/api/v1/projects/{id}/templates` |
| 来电 | 手机来电 | `farm/phone/calls.ts` | `InboxItem`（`StateFrame.inbox`，`rules/inbox.ts` 从核心状态现算） | |
| 连接器 | 连接器 | `/settings/connectors`（`pages/settings/ConnectorsPage.tsx`） | `ConnectorStatus` | `/api/v1/connectors` |
| （不画） | 连接到本机 | `/settings/lan`（`pages/settings/LanPage.tsx`）、连进来的设备的 `/pair`（`pages/pair`） | `LanStatus`、`LanDevice` | `/api/v1/lan` |
| 语音 | 麦克风 | `/settings/voice`（`pages/settings/VoiceForm.tsx`）、`src/voice/` | `VoiceSettings` | `/api/v1/voice/...` |
| 进度、成就 | 金币、连胜、任务与成就 | `farm/panels/Achievements.tsx` | `Progress`、`LedgerEntry`、`CoreState.progress` | 帧里的 `progress` 和 `view.achievements`；成就的说法 `game.achievements` |
| 等级 | 等级、经验 | 农场卡、任务与成就 | `CommitCount`、`FarmView.level` | |
| 地 | 一块地：一张工单 | 像素村（`farm/canvas`）、地块详情（`farm/issue/IssueView.tsx`） | 工单的分支和 worktree（服务端 `issueBranch`、`worktrees/<项目>.<工单号>`）；地里长什么按工单做键（`FarmView.plots`、`plotKey`）；帮工站在哪块地是 `SessionPlay.station` | `/api/v1/say` 的 `bed` |

## 服务端以下

| 概念 | 服务端 | 存储 | oar |
|---|---|---|---|
| Workspace | `base/config.ts` 的 `Config`；`services.ts` 把全部服务叠起来 | `VIBEVALLEY_WORK_ROOT`、`VIBEVALLEY_HOME` | |
| 项目 | `Projects`（`project/project.ts`、`git.ts`、`stack.ts`） | 工作目录下的 git 仓库 | 会话的 `cwd` |
| 帮工档案、技能书 | `Agents` | `config.json` | |
| 农机 | `Runtimes` | `config.json` 里每台农机的设置、`spend.json` | `Runtime`、`RuntimeRegistry` |
| 记性 | `Memories` | `memory` 表；管家的在 `manager/MEMORY.md` | |
| 管家 | `Manager` | `manager/` | 不经 oar 的子会话：跑在 VibeValley 自己的 agent 上（`agent/brain`） |
| 工单 | `Issues`（`issue/issue.ts`；派给管家的在 `manager/manager.ts`） | `issue`、`issue_session` 表（一行是一个帮工） | |
| 种植计划 | `Tasks`（`task/task.ts`、`engine.ts`） | `issue` 表（带 `graph` 的父工单、带 `task` 的子工单）、`task_graph`、`task_event` 表 | |
| 帮工 | `Sessions`（`session/session.ts`） | `state.json`（核心状态里的帮工）、`sessions.json`（目录、农机的会话 id、最后一轮的原话） | 一个帮工是一个 `Subagent`，包着一个 oar 的会话；每个帮工有自己的 `Subagents` |
| 一次干活（run） | `Sessions`（`session/execution.ts`）；`session/facts.ts` 把会话事件读成事实 | `session_run` 表 | 一个 oar turn（开始到结束），结束时交一份 `SubagentReport` |
| 干活过程 | `Sessions`（`session/journal.ts`） | `session` 表、`events/<id>.json`；原始记录在 `logs/` | oar 的事件：文字、思考、工具调用的开始和结束…… |
| 收成清单、收获 | `Issues`（挪到 `done`、合并、提 PR；`project/project.ts` 管分支和 worktree） | 工单的分支和 worktree | |
| 田头、频道、工单串 | `Channels`（`channel/chat.ts`）；帮工在频道里说话经 `/mcp`（`Mcp`、`Tools`） | `channel_conversation`、`channel_message`、`channel_participant`、`channel_delivery`、`channel_read_cursor`、`channel_mention`、`channel_follow`、`channel_seen_mark` 表 | 送到帮工的话是 oar 的 `prompt`、`steer`、`queue` |
| 定时 | `Schedules` | `schedule` 表 | |
| 巡查 | `Manager`（规则在 `manager/rules.ts`） | 不存：每轮从核心状态算 | |
| 来电 | 不存：`inbox` 从核心状态算 | | |
| 连接器 | `Connectors`；三家的接口在 `connector/weixin.ts`、`feishu.ts`、`qq.ts` | `connector_account`、`connector_inbound`、`connector_outbox` 表 | |
| 「连接到本机」 | `Lan` | `lan`、`lan_device` 表 | |
| 语音 | `Voice`（`voice/voice.ts`；声网的令牌和语音 agent 用 npm 的 `agora-token`、`agora-agents`） | `settings.json` | |
| 钥匙和语音设置 | `Setting` | `settings.json`（只有你能读） | 会话的 `env` |
| 进度、成就 | `Game`（`game/game.ts`、`progress.ts`） | `game_ledger` 表；进度从它折出来 | |
| 等级 | `Game` | `state.json` 里的 commit 数 | |
| 地 | `Game`；规则在 `packages/protocol/src/rules/play.ts` | `state.json` 里的 `play.station` | |
| 核心状态 | `Core` | `state.json`（聊天、进度、定时和工单除外） | |

## oar 那一层

oar 是驱动各家编码 agent 的运行时（npm 的 `@botiverse/oar`，钉在一个版本上：`runtime/dsh.ts` 用到它的内部文件）。从下往上：

| oar | 是什么 | 我们这边用在哪 |
|---|---|---|
| `Runtime`、`RuntimeRegistry` | 一种编码 agent 程序和它的安装 | `Runtimes` 探测、算额度和花费 |
| session | 农机原生的一个会话，可以接着上回的 | 一个帮工的会话；会话 id 存在 `sessions.json` |
| turn | 会话里的一轮：一个 prompt 开始，农机说结束时结束，结果是完成、中止或失败 | 一次 run 包着一个 oar turn |
| event | 一轮里的文字、思考、工具调用、用量、任务 | 读成事实和干活过程 |
| `prompt`、`steer`、`queue`、`withdraw`、`abort` | 往会话里送话、插话、排队、撤回、叫停 | 带话、叫停 |
| `Subagents`、`Subagent`、`SubagentReport`（`@botiverse/oar/agents`） | 宿主在任意农机上开的子会话，每结束一轮交一份报告；oar 把这种用法叫 crew | 每个帮工是一个 `Subagent` |

oar 的会话在开的时候能设系统提示词（替换或追加）、MCP、禁用的工具和环境变量；`Subagents` 的 `spawn` 只带农机、任务、名字、目录、模型、思考档位、服务档位、接着哪个会话和环境变量。所以 `session/session.ts` 给每个帮工单独一个 `Subagents`，底下的农机在开会话时带上档案的人设、技能、MCP 和禁用的工具（[agents-and-runtimes.md](docs/reference/agents-and-runtimes.md)）。kimi、opencode、antigravity、dsh 不接系统提示词。
