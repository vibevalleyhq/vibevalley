# 概念在各层的名字

一个概念在每一层叫什么：从农场里看到的，到界面、协议、HTTP、服务端、存储，最后到 oar。概念本身是什么见 [concepts.md](docs/concepts.md)，叫法见[用语表](docs/README.md#用语)。小队还没做，见[提案](docs/subsystems/session.md)。

## 各层

从上往下：

1. **农场里**：像素村里画出来的样子和玩法（[farm-ui.md](docs/reference/farm-ui.md)、[pixel-village.md](docs/reference/pixel-village.md)）。
2. **界面**：Flutter 的页面和组件，在 `app/lib/`。界面只读折好的状态，不折事实。
3. **协议**：`server/internal/protocol` 的形状、事实和规则；Dart 的类型由 shapegen 生成在 `app/lib/gen/`，名字一样。
4. **HTTP 和 MCP**：`/api/v1/...`（`protocol/api.go`），核心状态经 `GET /api/v1/state` 推给客户端；编码 agent 经 `/mcp` 用农场的工具，现在是帮工在频道里说话。
5. **服务端**：每个包一个服务 `<包>.Service`，`Workspace` 上的字段是单数的概念名（`f.Issue`、`f.Session`……）；下面写成「字段.方法」，一个包里不导出的零件写文件名（[server/README.md](server/README.md#服务)）。
6. **存储**：`$VIBEVALLEY_HOME` 下的文件和 `vibevalley.db` 的表（[architecture.md](docs/architecture.md)「存储」）。
7. **oar**：smith（oar 的 Go 移植）里的类型，名字和 oar 的 TS 一样。

## 看得见的几层

| 概念 | 农场里 | 界面 | 协议 | HTTP |
|---|---|---|---|---|
| Workspace | 大地图 | `/projects` 的「全部」（`workbench/map` 的 `ProjectMap`） | `Config.WorkRoot`、`Config.Home`（服务端的配置，不进协议） | |
| 项目 | 大地图上的一座岛 | `/projects/:project`（`workbench/projects`；岛的地和空位是 `workbench/map` 的 `IslandDetail`） | `ProjectSummary`、`ProjectActivity`、`ProjectLanguages`；帮工在哪个项目、目录、分支是服务端的 `project.Workplace` | `/api/v1/projects` |
| 帮工档案 | 一种小动物 | `/agents`（`workbench/agents`） | `Agent` | `/api/v1/agents` |
| 农机 | 农具 | `/runtimes`（`workbench/runtimes`） | `RuntimeInfo`、`RuntimeSettings` | `/api/v1/runtimes` |
| 技能书 | 技能书 | `/settings/skills`（`workbench/skills`） | `Skill` | `/api/v1/skills` |
| 记性 | 记性 | 档案页和管家页（`workbench/shared/memory_panels.dart`） | `Memory`、`MemoryList` | `/api/v1/memories/{agent}`（管家是 `manager`） |
| 管家 | 管家 | `/manager`（`workbench/manager`） | `CoreState.Manager`（管家的状态） | `/api/v1/say`、`/api/v1/manager/...` |
| 工单 | 看板上的卡片 | `/issues`（`workbench/issues`） | `Issue`、`Issue.Sessions`（这张工单用过的帮工） | `/api/v1/issues` |
| 种植计划 | 图纸桌、计划板 | `farm/task_board.dart` | `TaskGraph`（从父工单拼回，`StateFrame.Graphs`），每件是 `Task` | `/api/v1/graphs` |
| 帮工 | 在一块地上干活的小动物 | 地块和地块详情（`farm/plot_detail.dart`） | `Session`（`CoreState.Sessions`） | `/api/v1/sessions/{id}/stop`；别的按工单：`/api/v1/issues/{id}/...` |
| 一次干活（run） | 一季庄稼 | 地里长什么（`Session.Phase`）；工单详情的「每次干活」 | `Run`、`RunTrigger`；核心状态里是 `FactRun` 到 `FactReport`、`Session.Runs`、`LastRun` | `/api/v1/issues/{id}/runs` |
| 干活过程 | 干活过程 | `chat/turn_steps.dart` | `Session`（走了的阶段是 `closed`）、`SessionEvent`（它的日志） | `/api/v1/sessions`、`/api/v1/sessions/{id}`、`/api/v1/sessions/{id}/events` |
| 收成清单、收获 | 收获 | `shared/harvest.dart` | `Changes` | `/api/v1/issues/{id}/changes`、`/api/v1/issues/{id}/status`（挪到 `done`） |
| 验收、草、缺肥 | 抽穗、长草、结果、缺肥 | 工单详情（`shared/issue_view.dart`）的「这块地现在需要你」、验收、草 | `Issue.Acceptance`、`AcceptedAt`、`Findings`、`Asks`；地的样子是 `protocol.PlotOf` | `/api/v1/issues/{id}/accept`；`asks` 来自帮工汇报（`FactReport.Asks`） |
| 田头、频道 | 田头 | 田头窗口（`farm/chat_window.dart`）、`/chat`（`workbench/chat`） | `Conversation`（`kind`：`general`、`channel`）、`ChatMessage`、`CoreState.Chat` | `/api/v1/channels`、`/api/v1/channels/{id}/messages` |
| 工单串、评论 | 工单串、浇水 | 派活消息下面的串；地块和工单详情里的「浇水：带句话」 | `Conversation`（`kind: thread`）；评论是对整张工单说的，交给它最新的帮工，不挂在某一步上 | `/api/v1/channels/{id}/messages`、`/api/v1/issues/{id}/comment` |
| 定时 | 定时 | 频道菜单里；它的工单在看板上，带「定时」标签 | `Schedule`；它的工单是 `Issue.Schedule` 指着它的那张 | `/api/v1/schedules` |
| 来电 | 手机来电 | `phone/calls.dart` | `InboxItem`（`StateFrame.Inbox`，从核心状态现算） | |
| 连接器 | 连接器 | `/settings/connectors`（`workbench/connectors`） | `ConnectorStatus` | `/api/v1/connectors` |
| （不画） | 连接到本机 | `/settings/gate`（`workbench/gate`） | `LanStatus`、`LanDevice` | `/api/v1/gate` |
| 语音 | 麦克风 | `/settings/voice`（`workbench/voice`）、`voice/` | `VoiceSettings` | `/api/v1/voice/...` |
| 进度、成就 | 金币、连胜、任务与成就 | `farm/achievements.dart` | `Progress`、`LedgerEntry`、`CoreState.Progress` | 帧里的 `progress` 和 `view.achievements`；成就的说法 `game.achievements` |
| 等级 | 等级、经验 | 农场卡、任务与成就 | `CommitCount`、`FarmView.Level` | |
| 地 | 一块地：一张工单 | 像素村（`village/`）、地块详情（`farm/plot_detail.dart`） | 工单的分支和 worktree（服务端 `project.IssueBranch`、`worktrees/<项目>.<工单号>`）；地里长什么按工单做键（`FarmView.Plots`、`protocol.PlotKey`）；帮工站在哪块地是 `SessionPlay.Station` | `/api/v1/say` 的 `bed` |

## 服务端以下

| 概念 | 服务端 | 存储 | oar |
|---|---|---|---|
| Workspace | `base.Config`；`workspace` 把全部服务组装成 `Workspace` | `VIBEVALLEY_WORK_ROOT`、`VIBEVALLEY_HOME` | |
| 项目 | `Project`（`project/project.go`、`codebase.go`） | 工作目录下的 git 仓库 | 会话的 `Cwd` |
| 帮工档案、技能书 | `Agent` | `config.json` | |
| 农机 | `Runtime` | `config.json` 里每台农机的设置、`spend.json` | `oar.Runtime`、`AvailableInstallation` |
| 记性 | `Memory` | `memory` 表；管家的在 `manager/MEMORY.md` | |
| 管家 | `Manager` | `manager/` | 不经 oar：跑在 VibeValley 自己的 agent 上（`internal/agent/brain`） |
| 工单 | `Issue`（`issue/issue.go`、`dispatch.go`；派给管家的在 `manager.go`） | `issue`、`issue_session` 表（一行是一个帮工） | |
| 种植计划 | `TaskGraph`、`Task` | `issue` 表（带 `graph` 的父工单、带 `task` 的子工单）、`task_event` 表 | |
| 帮工 | `Session`（`session/sessions.go`） | `state.json`（核心状态里的帮工）、`sessions.json`（目录、农机的会话 id、最后一轮的原话） | 一个帮工是一个 `agents.Subagent`，包着一个 `oar.Session`；每个帮工有自己的 `agents.Subagents` |
| 一次干活（run） | `Session`（`session/runs.go`）；`session/facts.go` 把会话事件读成事实 | `session_run` 表 | 一个 oar turn（`TurnStarted` 到 `TurnEnded`），结束时交一份 `SubagentReport` |
| 干活过程 | `Session`（`session/trajectories.go`、`events.go`） | `session` 表、`events/<id>.json`；原始记录在 `logs/` | oar 的事件：`TextDelta`、`Reasoning`、`ToolCallStarted`、`ToolCallEnded`…… |
| 收成清单、收获 | `Issue`（`issue/status.go` 挪到 `done`、`merges.go`；提 PR 在 `issue/pull_request.go`、`project/pull_request.go`） | 工单的分支和 worktree | |
| 田头、频道、工单串 | `Channel`；帮工在频道里说话经 `MCP`（`/mcp`） | `channel_conversation`、`channel_message`、`channel_participant`、`channel_delivery`、`channel_read_cursor`、`channel_mention`、`channel_follow`、`channel_seen_mark` 表 | 送到帮工的话是 oar 的 `prompt`、`steer`、`queue` |
| 定时 | `Schedule` | `schedule` 表 | |
| 巡查 | `Manager`（`manager/patrol.go`） | 不存：每轮从核心状态算 | |
| 来电 | 不存：`protocol.Inbox` 从核心状态算 | | |
| 连接器 | `Connector`；三家的接口在 `pkg/weixin`、`pkg/feishu`、`pkg/qq` | `connector_account`、`connector_inbound`、`connector_outbox` 表 | |
| 「连接到本机」 | `Gate` | `gate`、`gate_device` 表 | |
| 语音 | `Voice`（`voice/agora.go`、`line.go`）；声网在 `pkg/agora` | `settings.json` | |
| 钥匙和语音设置 | `Setting` | `settings.json`（只有你能读） | 会话的 `Env` |
| 进度、成就 | `Game`（`game/ledger.go`） | `game_ledger` 表；进度从它折出来 | |
| 等级 | `Game`（`game/commits.go`） | `state.json` 里的 commit 数 | |
| 地 | `Game`（`game/stations.go`）；规则在 `protocol/game_play.go` | `state.json` 里的 `play.station` | |
| 核心状态 | `Core` | `state.json`（聊天、进度、定时和工单除外） | |

## oar 那一层

smith 是 oar 的 Go 移植（[smith 的 README](server/pkg/smith/README.md)），类型名、事件名、控制名和 oar 的 TS 一样。从下往上：

| oar | 是什么 | 我们这边用在哪 |
|---|---|---|
| `Runtime`、`RuntimeRegistry` | 一种编码 agent 程序和它的安装 | `Runtime` 探测、算额度和花费 |
| `Session` | 农机原生的一个会话，可以 `Resume` | 一个帮工的会话；会话 id 存在 `sessions.json` |
| turn | 会话里的一轮：一个 prompt 开始，农机的 `turn_ended` 结束，结果是 `completed`、`aborted` 或 `failed` | 一次 run 包着一个 oar turn |
| event | 一轮里的文字、思考、工具调用、用量、任务 | 读成事实和干活过程 |
| `prompt`、`steer`、`queue`、`withdraw`、`abort` | 往会话里送话、插话、排队、撤回、叫停 | 带话、叫停（`Session.Deliver`、`Session.Stop`） |
| `Subagents`、`Subagent`、`SubagentReport` | 宿主在任意农机上开的子会话，每结束一轮交一份报告；oar 把这种用法叫 crew | 每个帮工是一个 `Subagent` |

oar 的会话在开的时候能设系统提示词（替换或追加）、MCP、禁用的工具和环境变量；`Subagents.Spawn` 只带农机、任务、名字、目录、模型、思考档位、服务档位、`Resume` 和环境变量。所以 `session/sessions.go` 给每个帮工单独一个 `Subagents`，底下的农机在开会话时带上档案的人设、技能、MCP 和禁用的工具（[agents-and-runtimes.md](docs/reference/agents-and-runtimes.md)）。kimi、opencode、antigravity、dsh 不接系统提示词。
