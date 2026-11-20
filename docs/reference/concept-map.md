# 概念在各层的名字

一个概念在每一层叫什么：从农场里看到的，到页面、协议、HTTP、服务端、存储，最后到 oar。概念定义以 [concepts.md](docs/concepts.md) 为单一真源，叫法与禁用词见[用语表](docs/README.md#用语)。分层和存盘见[架构](docs/architecture.md#分层)与[存了什么](docs/architecture.md#存了什么)，Session、Run 和 oar 会话见[帮工](docs/subsystems/session.md#模型和不变量)。

本页只索引 [concepts.md](docs/concepts.md) 中的一级概念在各层的名字，不重复解释概念含义，也不列附属子字段。完整接口和权限见[能力表](docs/reference/capabilities.md)。

## 看得见的几层

农场、页面、协议和代表 HTTP 入口的对照：

| 概念 | 农场里 | 页面 | 协议 | HTTP |
|---|---|---|---|---|
| Host | — | — | 服务端 `ServerConfig` 的 `home`（`$VIBEVALLEY_HOME`，不进协议） | — |
| 空间 | 大地图（`apps/mac/src/pixel/farm/islands.rs`） | `/repos` | `SpaceState`；目录是服务端 `ServerConfig` 的 `work_root` | `/api/v1/state`、`/api/v1/events` |
| 仓库 | 大地图上的一座岛 | `/repos/:repo`（`features/repo`） | `RepoSummary`、`RepoActivity`、`RepoLanguages` | `/api/v1/repo/…` |
| 助手 | 田头的助手 | `/orchestrator`、`/orchestrator/<档案 id>`（`features/orchestrator`） | `SpaceState.sessions`（`role: "orchestrator"`）、`Channel.orchestrator` | `/api/v1/channel/message/send`、`/api/v1/orchestrator/…` |
| 档案、技能 | 小动物、技能书 | `/agents`（`features/agent`）、`/settings/skills`（`features/runtime/SkillsPage.tsx`） | `Agent`、`AgentTemplate`、`Skill` | `/api/v1/agent/…`、`/api/v1/skill/…` |
| 农机 | 农具 | `/runtimes`（`features/runtime`） | `RuntimeInfo`、`RuntimeSettings` | `/api/v1/runtime/…` |
| 工单、父子工单 | 图纸桌卡片、一块地 | `/issues`（`features/issue`、`FamilyDetail.tsx`） | `Issue`（`assignments`、`parent`、`blockedBy`）、`Changes`、`Landing` | `/api/v1/issue/…` |
| 帮工、一轮 | 地里干活的小动物、一季庄稼 | `features/session/WorkLog.tsx`、`Trajectory.tsx` | `Session`、`Run`、`RunTrigger`、`SessionEvent` | `/api/v1/session/…`、`/api/v1/issue/run/list` |
| 频道、私聊、工单串 | 田头、频道、工单串 | `/chat`（`features/channel`） | `Channel`（`type`：`channel`、`direct`、`thread`）、`ChatMessage`（`actor: Actor`）、`Attachment` | `/api/v1/channel/…`、`/api/v1/attachment/…` |
| Artifact | — | `/artifacts`（`features/artifact`） | `Artifact`、`Block`、`Suggestion` | `/api/v1/artifact/…` |
| 笔记 | — | `/pkm`（`features/pkm`） | `PkmPage`、`PkmBlock` | `/api/v1/pkm/…` |
| 记性 | 记性 | 档案页与助手页（`features/memory/Memory.tsx`） | `Memory`、`MemoryList` | `/api/v1/memory/…` |
| 定时任务 | 定时任务 | 频道菜单、看板带「定时任务」标签的工单 | `Cron`（`Issue.cron`） | `/api/v1/cron/…` |

## 服务端以下

服务、存储和 oar 的对照；服务端的模块在 `crates/vibevalley-server/src/modules/`，存储只列主要归属，完整存盘见[架构](docs/architecture.md#存了什么)。

| 概念 | 服务端 | 存储 | oar |
|---|---|---|---|
| Host、空间 | `ServerConfig`（`home`、`work_root`，`crates/vibevalley-server/src/start.rs` 照次序打开全部模块） | `$VIBEVALLEY_HOME`、`$VIBEVALLEY_WORK_ROOT` | — |
| 仓库 | `Repos`（`repo.rs`），git 经 `crates/vibevalley-git` | Space 的 `repos/` 与工单检出 `worktrees/` | 会话的 `cwd` |
| 助手 | `Orchestrator`（`orchestrator/mod.rs`） | `agent/<档案 id>/conversation.jsonl` | 不经 oar：跑在 `crates/vibevalley-agent` 的对话循环上（[VibeValley 自己的 agent](docs/subsystems/brain.md)） |
| 档案、技能 | `Agents`（`agent/profile.rs`、`presets.rs`） | `config.json`、`agent-templates/` | — |
| 农机 | `Agents` 的农机部分（`agent/runtime.rs`；接口仍是 `runtime.*`） | `config.json` 农机设置 | `Runtime`、`Registry` |
| 工单、父子工单 | `Board`（`crates/vibevalley-server/src/modules/issue/board.rs`），接口在 `issue/mod.rs` | `server.db`、`issues/` | — |
| 帮工、一轮 | `Sessions`（`session/sessions.rs`）与 `runs.rs`，农机经 `drivers.rs` 开会话；轨迹在 `session/journal.rs` | `server.db`、`events/` | 一个帮工是一个 oar `Session`，一轮对应一个 turn |
| 频道、附件 | `Chat`（`channel/mod.rs`）、`Attachments`（`attachment.rs`）；谁听见与投递在 `Watch`（`watch/mod.rs`） | `server.db` 的 `channel*`、`attachment`、`watch_cursor` 表 | 投递成帮工会话里的一段话 |
| Artifact | `Artifacts`（`artifact/mod.rs`） | `server.db` 的 `artifact*` 表 | — |
| 笔记 | `Pkm`（`pkm/mod.rs`） | `pkm/` 下的 Markdown 页面、`pkm_comment`、`pkm_change` 表 | — |
| 记性 | `Memories`（`modules/memory/`） | `memory` 表 | — |
| 定时任务 | `Crons`（`cron/mod.rs`，什么时候跑在 `crates/vibevalley-cron`） | `server.db` 的 `cron` 表 | — |
| PR 与分支发布 | `Pulls`（`pull/mod.rs`、`publish.rs`、`store.rs`、`poll.rs`、`snapshot.rs`） | `server.db` 的 `pull`、`pull_event` 表 | — |

## oar 那一层

oar 是驱动各家编码 agent 的运行时；VibeValley 用的是它的 Rust 实现 `crates/vibevalley-oar`（Claude Code、Codex、ACP、scripted 和自研的 `vibevalley`）。它的术语和 VibeValley 的用法对照：

| oar | 是什么 | 我们这边用在哪 |
|---|---|---|
| `Runtime`、`Registry` | 一种编码 agent 程序和它的安装 | 农机的探测和额度 |
| `Session` | 农机原生的一个会话，可以接着上回的 | 一个帮工的会话 |
| turn | 会话里的一轮：一个 prompt 开始，农机说结束时结束，结果是完成、中止或失败 | 帮工的一轮包着一个 turn |
| `Event` | 一轮里的文字、思考、工具调用、用量 | 读成事实和轨迹 |
| `prompt`、`steer`、`queue`、`abort` | 往会话里送话、插话、排队、叫停 | 带话、叫停 |

档案怎么进 oar 会话见[帮工](docs/subsystems/session.md#模型和不变量)，农机接受哪些选项见[档案和农机](docs/subsystems/agent.md#模型和不变量)。
