# 概念在各层的名字

一个概念在每一层叫什么：从农场里看到的，到页面、协议、HTTP、服务端、存储，最后到 oar。概念定义以 [concepts.md](docs/concepts.md) 为单一真源，叫法与禁用词见[用语表](docs/README.md#用语)。分层和存盘见[架构](docs/architecture.md#分层)与[存了什么](docs/architecture.md#存了什么)，Session、Run 和 oar 会话见[帮工](docs/subsystems/session.md#模型和不变量)。

本页只索引 [concepts.md](docs/concepts.md) 中的一级概念在各层的名字，不重复解释概念含义，也不列附属子字段。完整接口和权限见[能力表](docs/reference/capabilities.md)。

## 看得见的几层

农场、页面、协议和代表 HTTP 入口的对照：

| 概念 | 农场里 | 页面 | 协议 | HTTP |
|---|---|---|---|---|
| Host | — | — | `ServerConfig` 的 `home`（`$VIBEVALLEY_HOME`，不进协议） | — |
| 空间 | 大地图 | `/repos` 的「全部」（`farm/map/RepoMap.tsx`） | `SpaceState`；目录是服务端 `ServerConfig` 的 `workRoot` | `/api/v1/state`、`/api/v1/events` |
| 仓库 | 大地图上的一座岛 | `/repos/:repo`（`features/repo`） | `RepoSummary`、`RepoActivity`、`RepoLanguages` | `/api/v1/repo/…` |
| 助手 | 田头的助手 | `/orchestrator`、`/orchestrator/<档案 id>`（`features/orchestrator`） | `SpaceState.sessions`（`role: "orchestrator"`）、`Channel.orchestrator` | `/api/v1/channel/message/send`、`/api/v1/orchestrator/…` |
| 档案、技能 | 小动物、技能书 | `/agents`（`features/agent`）、`/settings/skills`（`features/runtime/SkillsPage.tsx`） | `Agent`、`AgentTemplate`、`Skill` | `/api/v1/agent/…`、`/api/v1/skill/…` |
| 农机 | 农具 | `/runtimes`（`features/runtime`） | `RuntimeInfo`、`RuntimeSettings` | `/api/v1/runtime/…` |
| 工单、父子工单 | 图纸桌卡片、一块地 | `/issues`（`features/issue`、`FamilyDetail.tsx`）、地块详情（`farm/issue/IssueView.tsx`） | `Issue`（`assignments`、`parent`、`blockedBy`）、`Changes`、`Landing` | `/api/v1/issue/…` |
| 帮工、一轮 | 地里干活的小动物、一季庄稼 | 地块详情、`features/session/WorkLog.tsx`、`Trajectory.tsx` | `Session`、`Run`、`RunTrigger`、`SessionEvent` | `/api/v1/session/…`、`/api/v1/issue/run/list` |
| 频道、私聊、工单串 | 田头、频道、工单串 | 田头窗（`farm/chat`）、`/chat`（`features/channel`） | `Channel`（`type`：`channel`、`direct`、`thread`）、`ChatMessage`（`actor: Actor`）、`Attachment` | `/api/v1/channel/…`、`/api/v1/attachment/…` |
| Artifact | — | `/artifacts`（`features/artifact`） | `Artifact`、`Block`、`Suggestion` | `/api/v1/artifact/…` |
| 笔记 | — | `/pkm`（`features/pkm`） | `PkmPage`、`PkmBlock` | `/api/v1/pkm/…` |
| 记性 | 记性 | 档案页与助手页（`features/memory/Memory.tsx`） | `Memory`、`MemoryList` | `/api/v1/memory/…` |
| 定时任务 | 定时任务 | 频道菜单、看板带「定时任务」标签的工单 | `Cron`（`Issue.cron`） | `/api/v1/cron/…` |
| 机器、「连接到本机」 | — | `/settings/devices`（`features/lan/LanPage.tsx`）、`/pair` | `Machine`、`LanStatus`、`UserDevice` | `/api/v1/lan/…` |

## 服务端以下

服务、存储和 oar 的对照；存储只列主要归属，完整存盘见[架构](docs/architecture.md#存了什么)。

| 概念 | 服务端 | 存储 | oar |
|---|---|---|---|
| Host、空间 | `infra/config.ts` 的 `ServerConfig`（`home`、`workRoot`）；`services.ts` 组装全部服务 | `$VIBEVALLEY_HOME`、`$VIBEVALLEY_WORK_ROOT` | — |
| 仓库 | `Repo`（`repo/repo.ts`、`git.ts`、`workplace.ts`、`github.ts`） | Space 的 `repos/` 与工单检出 `worktrees/` | 会话的 `cwd` |
| 助手 | `Orchestrator`（每个助手档案一个 `AgentHost`，`Session.host` 开在 `session/host.ts`） | `session` 表、`durable.db`、`agent/<档案 id>/` | 不经 oar：跑在 pi-durable 上，`AgentHost` 的一个会话是 `agent/durable.ts` 开的 `Harness` 上的一个对话，工具来自 `packages/agent`（[VibeValley 自己的 agent](docs/subsystems/brain.md)） |
| 档案、技能 | `Agent`（`agent/agent.ts`、`template.ts`） | `config.json`、`agent-templates/`、内置 `templates/` 与 `skills/` | — |
| 农机 | `Agent` 的农机部分（`agent/runtime.ts`、`presets.ts`；接口仍是 `runtime.*`） | `config.json` 农机设置、`agent_spend` 表 | `Runtime`、`RuntimeRegistry` |
| 工单、父子工单 | `Issue`（`issue/issue.ts`、`lifecycle.ts`、`dependencies.ts`） | `issue`、`issue_assignment`、`issue_assignment_execution` 表 | 通用 DAG 在 `packages/agent/src/base/dag.ts` |
| 帮工、一轮 | `Session`（`session/session.ts`、`lifecycle.ts`、`inProcessRun.ts`、`journal.ts`），执行器在 `session/executor.ts` | `session`、`session_run` 表、`events/<id>.json` | 一个帮工是一个 `Subagent`，一轮对应一个 oar turn 与 `SubagentReport` |
| 频道、附件、信箱 | `Channel`（`channel/channel.ts`）、`Attachment`（`attachment/attachment.ts`、`storage.ts`）、信箱在 `Session` 里（`session/mailbox.ts`） | `channel`、`channel_participant`（`kind` + `role`）、`channel_message`、`attachment`、`session_trigger`、`session_delivery` 表 | 投递经 `Session.route` 送入执行实例 |
| Artifact | `Artifact`（`artifact/artifact.ts`） | `artifact`、`artifact_version`、`artifact_block`、`artifact_block_revision`、`artifact_change`、`artifact_suggestion` 表 | — |
| 笔记 | `Pkm`（`pkm/pkm.ts`） | `pkm/` 下的 Markdown 页面、`pkm_comment`、`pkm_change` 表 | — |
| 记性 | `Memory`（`memory/memory.ts`） | `memory` 表 | — |
| 定时任务 | 在 `Issue` 里（`issue/cron.ts`、`when.ts`） | `issue_cron` 表 | — |
| 机器、「连接到本机」 | 机器在 `Session` 里（`session/machine.ts`、`executor.ts`）、`Lan`（`lan/lan.ts`） | `session_machine`、`lan`、`user_device` 表 | 本机或远端执行后端 |

## oar 那一层

oar（`@botiverse/oar`）是驱动各家编码 agent 的运行时。它的术语和 VibeValley 的用法对照：

| oar | 是什么 | 我们这边用在哪 |
|---|---|---|
| `Runtime`、`RuntimeRegistry` | 一种编码 agent 程序和它的安装 | `Runtime` 探测、算额度和花费 |
| session | 农机原生的一个会话，可以接着上回的 | 一个帮工的会话；会话 id 存在 `session.oar_session` |
| turn | 会话里的一轮：一个 prompt 开始，农机说结束时结束，结果是完成、中止或失败 | 帮工的一次 run 包着一个 oar turn |
| event | 一轮里的文字、思考、工具调用、用量、任务 | 读成事实和轨迹 |
| `prompt`、`steer`、`queue`、`withdraw`、`abort` | 往会话里送话、插话、排队、撤回、叫停 | 带话、叫停 |
| `Subagents`、`Subagent`、`SubagentReport`（`@botiverse/oar/agents`） | 宿主在任意农机上开的子会话，每结束一轮交一份报告；oar 把这种用法叫 crew | 每个帮工是一个 `Subagent` |

档案怎么进 oar 会话见[帮工](docs/subsystems/session.md#模型和不变量)，农机接受哪些选项见[档案和农机](docs/subsystems/agent.md#模型和不变量)。
