# 概念在各层的名字

一个概念在每一层叫什么：从农场里看到的，到界面、协议、HTTP、服务端、存储，最后到 oar。概念本身是什么见 [concepts.md](../concepts.md)，叫法见[用语表](../README.md#用语)。几处名字打算改，见[提案](../../.agents/notes/proposed/architecture/2026-10-16-runs-workers-crews.md)。

## 各层

从上往下：

1. **农场里**：像素村里画出来的样子和玩法（[farm-ui.md](farm-ui.md)、[pixel-village.md](pixel-village.md)）。
2. **界面**：Flutter 的页面和组件，在 `app/lib/`。界面只读折好的状态，不折事实。
3. **协议**：`server/internal/protocol` 的形状、事实和规则；Dart 的类型由 shapegen 生成在 `app/lib/gen/`，名字一样。
4. **HTTP 和 MCP**：`/api/...`（`protocol/api.go`），核心状态经 `GET /api/state` 推给客户端；编码 agent 经 `/mcp` 用农场的工具，现在是帮工在频道里说话。
5. **服务端**：每个包一个服务 `<包>.Service`，`Workspace` 上的字段是单数的概念名（`f.Issue`、`f.Worker`……）；下面写成「字段.方法」，一个包里不导出的零件写文件名（[server/README.md](../../server/README.md#服务)）。
6. **存储**：`$VIBEVALLEY_HOME` 下的文件和 `vibevalley.db` 的表（[architecture.md](../architecture.md)「存储」）。
7. **oar**：smith（oar 的 Go 移植）里的类型，名字和 oar 的 TS 一样。

## 看得见的几层

| 概念 | 农场里 | 界面 | 协议 | HTTP |
|---|---|---|---|---|
| Workspace | 大地图 | `/map`（`desk/map`） | `Config.WorkRoot`、`Config.Home`（服务端的配置，不进协议） | |
| 项目 | 大地图上的一座岛 | `/projects`（`desk/projects`）、`/map/:project` | `ProjectSummary`、`ProjectActivity`、`ProjectLanguages`；帮工在哪个项目、目录、分支是服务端的 `project.Workplace` | `/api/projects` |
| 帮工档案 | 一种小动物 | `/agents`（`desk/agents`） | `Agent` | `/api/agents` |
| 农机 | 农具 | `/runtimes`（`desk/runtimes`） | `RuntimeInfo`、`RuntimeSettings` | `/api/runtimes` |
| 技能书 | 技能书 | `/skills`（`desk/skills`） | `Skill` | `/api/skills` |
| 记性 | 记性 | 档案页和管家页（`desk/shared/memory_panels.dart`） | `Memory` | `/api/agents/{id}/memories` |
| 管家 | 管家 | `/manager`（`desk/manager`） | `CoreState.Manager`（管家的状态） | `/api/say`、`/api/manager/...` |
| 工单 | 看板上的卡片 | `/tickets`（`desk/tickets`） | `Issue`、`Issue.Workers`（这张工单用过的帮工） | `/api/issues` |
| 种植计划 | 图纸桌、计划板 | `farm/plans.dart` | `Playbook`（从父工单拼回，`StateFrame.Plans`） | `/api/playbooks` |
| 帮工 | 地里干活的小动物 | 地块和地块详情（`farm/plot_detail.dart`） | `Worker`（`CoreState.Workers`） | `/api/workers/{id}/...` |
| 一次干活（run） | 一季庄稼 | 地里长什么（`Worker.Phase`）；工单详情的「每次干活」 | `Run`、`RunTrigger`；核心状态里是 `FactRun` 到 `FactReport`、`Worker.Runs`、`LastRun` | `/api/issues/{id}/runs` |
| 干活过程 | 干活过程 | `farm/work_log.dart` | `Activity`、`Trajectory`、`TrajectoryHead` | `/api/workers/{id}/activities`、`/api/trajectories` |
| 收成清单、收获 | 收获 | `shared/harvest.dart` | `Changes` | `/api/workers/{id}/changes`、`/api/workers/{id}/merge` |
| 田头、频道 | 田头 | 田头窗口（`farm/chat_window.dart`）、`/chat`（`desk/chat`） | `Conversation`（`kind`：`square`、`channel`）、`ChatMessage`、`CoreState.Chat` | `/api/chat/messages`、`/api/channels` |
| 工单串、评论 | 工单串 | 派活消息下面的串；干活过程里的「评论」 | `Conversation`（`kind: thread`）；评论某一步是 `worker.CommentText` 拼出来的一句话 | `/api/chat/messages`、`/api/workers/{id}/tell` |
| 定时 | 定时 | 频道菜单里；它的工单在看板上，带「定时」标签 | `Schedule`；它的工单是 `Issue.Schedule` 指着它的那张 | `/api/schedules` |
| 来电 | 手机来电 | `phone/calls.dart` | `InboxItem`（`StateFrame.Inbox`，从核心状态现算） | |
| 连接器 | 连接器 | `/connectors`（`desk/connectors`） | `ConnectorStatus` | `/api/connectors` |
| 院门 | 院门 | `/gate`（`desk/gate`） | `LanStatus`、`LanDevice` | `/api/lan` |
| 语音 | 麦克风 | `/voice`（`desk/voice`）、`voice/` | `VoiceSettings` | `/api/voice/...` |
| 进度、成就 | 金币、连胜、任务与成就 | `farm/achievements.dart` | `Progress`、`LedgerEntry`、`CoreState.Progress` | `/api/progress/...` |
| 等级 | 等级、经验 | 农场卡、任务与成就 | `CommitCount`、`FarmView.Level` | |
| 地 | 一块地 | 像素村（`village/`） | `WorkerPlay.Station`、`PlotView`（`StateFrame.View`） | `/api/say` 的 `bed` |

## 服务端以下

| 概念 | 服务端 | 存储 | oar |
|---|---|---|---|
| Workspace | `base.Config`；`workspace` 把全部服务组装成 `Workspace` | `VIBEVALLEY_WORK_ROOT`、`VIBEVALLEY_HOME` | |
| 项目 | `Project`（`project/project.go`、`codebase.go`） | 工作目录下的 git 仓库 | 会话的 `Cwd` |
| 帮工档案、技能书 | `Agent` | `config.json` | |
| 农机 | `Runtime` | `config.json` 里每台农机的设置、`spend.json` | `oar.Runtime`、`AvailableInstallation` |
| 记性 | `Memory` | `memory` 表；管家的在 `manager/MEMORY.md` | |
| 管家 | `Manager` | `manager/` | 不经 oar：跑在 VibeValley 自己的 agent 上（`pkg/agent`） |
| 工单 | `Issue`（`issue/issue.go`、`dispatch.go`；派给管家的在 `manager.go`） | `issue`、`issue_worker` 表（一行是一个帮工） | |
| 种植计划 | `Playbook` | `issue` 表（带 `plan` 的父工单）、`playbook_event` 表 | |
| 帮工 | `Worker`（`worker/workers.go`） | `state.json`（核心状态里的帮工）、`workers.json`（目录、农机的会话 id、最后一轮的原话） | 一个帮工是一个 `agents.Subagent`，包着一个 `oar.Session`；每个帮工有自己的 `agents.Subagents` |
| 一次干活（run） | `Worker`（`worker/runs.go`）；`worker/facts.go` 把会话事件读成事实 | `run` 表 | 一个 oar turn（`TurnStarted` 到 `TurnEnded`），结束时交一份 `SubagentReport` |
| 干活过程 | `Worker`（`worker/trajectories.go`、`activities.go`） | `activities/<id>.json`、`activities/<id>.head.json`；原始记录在 `logs/` | oar 的事件：`TextDelta`、`Reasoning`、`ToolCallStarted`、`ToolCallEnded`…… |
| 收成清单、收获 | `Issue`（`issue/merges.go`） | 帮工的分支和 worktree | |
| 田头、频道、工单串 | `Channel`；帮工在频道里说话经 `MCP`（`/mcp`） | `conversation`、`message`、`participant`、`delivery`、`read_cursor`、`mention`、`follow`、`seen_mark` 表 | 送到帮工的话是 oar 的 `prompt`、`steer`、`queue` |
| 定时 | `Schedule` | `schedule` 表 | |
| 巡查 | `Manager`（`manager/patrol.go`） | 不存：每轮从核心状态算 | |
| 来电 | 不存：`protocol.Inbox` 从核心状态算 | | |
| 连接器 | `Connector`；三家的接口在 `pkg/weixin`、`pkg/feishu`、`pkg/qq` | `connector_account`、`connector_inbound`、`connector_outbox` 表 | |
| 院门 | `Gate` | `lan_gate`、`lan_device` 表 | |
| 语音 | `Voice`（`voice/agora.go`、`line.go`）；声网在 `pkg/agora` | `settings.json` | |
| 钥匙和语音设置 | `Setting` | `settings.json`（只有你能读） | 会话的 `Env` |
| 进度、成就 | `Game`（`game/ledger.go`） | `ledger` 表；进度从它折出来 | |
| 等级 | `Game`（`game/commits.go`） | `state.json` 里的 commit 数 | |
| 地 | `Game`（`game/beds.go`）；规则在 `protocol/game_play.go` | `state.json` 里的 `play.station` | |
| 核心状态 | `Core` | `state.json`（聊天、进度、定时和工单除外） | |

## oar 那一层

smith 是 oar 的 Go 移植（[smith 的 README](../../server/pkg/smith/README.md)），类型名、事件名、控制名和 oar 的 TS 一样。从下往上：

| oar | 是什么 | 我们这边用在哪 |
|---|---|---|
| `Runtime`、`RuntimeRegistry` | 一种编码 agent 程序和它的安装 | `Runtime` 探测、算额度和花费 |
| `Session` | 农机原生的一个会话，可以 `Resume` | 一个帮工的会话；会话 id 存在 `workers.json` |
| turn | 会话里的一轮：一个 prompt 开始，农机的 `turn_ended` 结束，结果是 `completed`、`aborted` 或 `failed` | 一次 run 包着一个 oar turn |
| event | 一轮里的文字、思考、工具调用、用量、任务 | 读成事实和干活过程 |
| `prompt`、`steer`、`queue`、`withdraw`、`abort` | 往会话里送话、插话、排队、撤回、叫停 | 带话、叫停（`Worker.Deliver`、`Worker.Stop`） |
| `Subagents`、`Subagent`、`SubagentReport` | 宿主在任意农机上开的子会话，每结束一轮交一份报告；oar 把这种用法叫 crew | 每个帮工是一个 `Subagent` |

oar 的会话在开的时候能设系统提示词（替换或追加）、MCP、禁用的工具和环境变量；`Subagents.Spawn` 只带农机、任务、名字、目录、模型、思考档位、服务档位、`Resume` 和环境变量。所以 `worker/workers.go` 给每个帮工单独一个 `Subagents`，底下的农机在开会话时带上档案的人设、技能、MCP 和禁用的工具（[agents-and-runtimes.md](agents-and-runtimes.md)）。kimi、opencode、antigravity 不接系统提示词。
