# VibeValley 文档

VibeValley 是 AI 版的 [Linear](https://linear.app)，穿着像素农场的皮（[概念](docs/concepts.md)）。这里写现在怎么用、怎么开发、东西怎么工作；为什么这样设计和还没做的提案在 [Agent Notes](.agents/notes/README.md)，文档放在哪见 [AGENTS.md](docs/AGENTS.md)。

先读：

| 文档 | 讲什么 |
|---|---|
| [guide.md](docs/guide.md) | 教程：派第一张工单，看着它干，收获，处理冲突和失败，管住花费，用语音 |
| [development.md](docs/development.md) | 教程：本机跑起来，检查和测试，改形状、规则和表，打包 |
| [concepts.md](docs/concepts.md) | 概念：实际是什么，农场怎么画它们 |
| [architecture.md](docs/architecture.md) | 架构：分层、核心状态、事件流、接口、存储、配置。改 `server/`、`app/` 之前读 |

子系统（`subsystems/`，从架构的角度写一个子系统沉淀下来的样子，[怎么写](docs/subsystems/README.md)）：

| 文档 | 内容 |
|---|---|
| [issue.md](docs/subsystems/issue.md) | 工单：一块地：工单的模型、状态和派活、验收、收获 |
| [session.md](docs/subsystems/session.md) | 帮工：Session 和 Run、规矩和汇报、事件日志、额度和上限 |
| [project.md](docs/subsystems/project.md) | 项目：工作目录、worktree、检查、GitHub 检测、地契 |
| [channel.md](docs/subsystems/channel.md) | 田头：频道、谁听见、工单串、连接器、Inbox |
| [orchestrator.md](docs/subsystems/orchestrator.md) | 管家：自己的 agent、提示和工具、来源、巡查、评测 |
| [schedule.md](docs/subsystems/recurrence.md) | 定时：一张工单的触发：间隔和 cron、补跑、回头看 |
| [task.md](docs/subsystems/task.md) | 种植计划：带子工单的父工单、按图推进；agent 自己的任务图 |
| [memory.md](docs/subsystems/memory.md) | 记性：想起、记下、主动查、外面的来源 |
| [doc.md](docs/subsystems/doc.md) | 文档：按块存、按 op 改、一批一个事务、Markdown 导入导出 |
| [voice.md](docs/subsystems/voice.md) | 语音：通话（Agora ConvoAI）、听写、语音管家 |
| [lan.md](docs/subsystems/lan.md) | 「连接到本机」：局域网里配对过的设备用同一个农场 |
| [setting.md](docs/subsystems/setting.md) | 设置：settings.json、配置和环境变量、钥匙和打码 |
| [game.md](docs/subsystems/game.md) | 游戏：账本、金币和成就、等级、空地和特效 |
| [core.md](docs/subsystems/core.md) | 核心状态：一份状态只因事实而变、三条流、接口和能力表、重启 |
| [foundation.md](docs/subsystems/foundation.md) | 地基：一个仓库、一块业务一个服务、Effect 的 layer、形状和规则、effect-sqlc、表结构、测试 |
| [app.md](docs/subsystems/app.md) | 客户端：一份 Solid 页面、问服务端、宿主接口、Electron 的桌面版和打包 |
| [farm.md](docs/subsystems/farm.md) | 农场的皮：像素村、地里长什么、走路、手机、音效、图鉴 |
| [agent.md](docs/subsystems/agent.md) | 档案和农机：帮工档案、种子、农机的探测和清单、技能书 |
| [process.md](docs/subsystems/process.md) | 工程流程：文档分层、Note 和子系统、检查、skill、写作规范、素材流水线 |
| [site.md](docs/subsystems/site.md) | 官网：Astro、island、图从游戏来 |

查的东西（`reference/`）：

| 文档 | 讲什么 |
|---|---|
| [concept-map.md](docs/reference/concept-map.md) | 概念在各层的名字：农场里、界面、协议、HTTP、服务端、存储、oar |
| [capabilities.md](docs/reference/capabilities.md) | 每个接口谁能调：主人、「连接到本机」、管家；`scripts/capabilities.ts` 写出 |
| [agents-and-runtimes.md](docs/reference/agents-and-runtimes.md) | 帮工档案、农机、技能书 |
| [farm-ui.md](docs/reference/farm-ui.md) | 界面清单、角色、精力瓶和计分的表 |
| [pixel-village.md](docs/reference/pixel-village.md) | 首页、素材的流水线 |

怎么写（`style/`）：

| 文档 | 讲什么 |
|---|---|
| [code.md](docs/style/code.md) | 代码：格式、叫法、注释写什么不写什么 |
| [writing.md](docs/style/writing.md) | 文字：写什么、删什么，词和格式怎么写；文档、Note、skill、提交说明、注释和回复都用 |

## 用语

界面用农场的叫法，代码和讲服务端的文档按实际的概念来（[concepts.md](docs/concepts.md)）。界面上的字用左边一列，不用最右一列。

| 叫法 | 代码里 | 意思 | 不用 |
|---|---|---|---|
| 管家 | orchestrator | 你直接说话的 agent，替你派活 | 工头、主 agent |
| 帮工 | Session（[concepts](docs/concepts.md#session-和-oar-会话)） | 在一块地上干活的：一个档案为一张工单接的活，跨好几次干活；重开的工单换一个帮工，地不换 | 工人、子 agent、worker |
| 一次干活 | run | 一次触发到一次汇报：派出去、带话、计划、定时、农机自己；农场里是一季庄稼 | 一轮、turn |
| 帮工档案 | agent（`Agent`） | 一份配置：农机、模型、人设、技能、哪种小动物 | 角色、profile |
| 农机 | runtime | 机器上的一种编码 agent 程序（pi、claude、codex……） | harness、引擎 |
| 工单 | issue（`Issue`） | 一件活，从写下到关上一个 id；在做时是一块地，每派一次是一个帮工 | job、ticket |
| 项目 | project | 工作目录 `projects/` 下的一个 git 仓库；农场里是一座岛，工作台的「项目」页（`/projects`，「全部」是整张地图） | 一块地 |
| 大地图 | Workspace（`Config.WorkRoot`、`Config.Home`） | 全部项目、工单、群聊和档案；工作台「项目」页的「全部」 | 世界、全图 |
| 地 | issue（`Issue`；`FarmView.Plots` 按工单做键）；代码活的 worktree 是 `project.IssueBranch`；像素村里的位置是 station（画出来的那块地在客户端叫 `Bed`） | 一张工单；代码相关的带一个 worktree。帮工在上面干活；一座岛上的空位是这个项目同时在做的工单数 | 工位、帮工的地、并发位 |
| 种子袋 | 待办的工单（todo，`queued_at`） | 排队等空地的工单，有空地自动开工 | 队列 |
| 播种袋里的种子 | issue template（`IssueTemplate`、`project.templates`） | 写工单的现成模板：一个标题和一行完成线，按项目的栈填好命令；代码里的 seed 只指种子数据（`seeds.json`） | seed |
| 阶段 | phase | 到场、干活、成熟、失败、歇着 | 状态 |
| 核心状态 | `WorkspaceState` | 农场上的一切，只有服务端持有 | |
| 事实 | fact | 改核心状态的一件事 | patch |
| 收成清单 | `Changes`（`issue.changes`） | 工单分支上的提交、改的文件和 diff，合进去会不会冲突 | 差异、PR 详情 |
| 收获 | harvest；工单挪到 `done` | 过了验收的工单收下：代码活合进主分支（`github.pr_projects` 里的项目是推分支、开 PR，PR 合了才关），别的直接关上 | |
| 聊清楚、安排活、完成 | 工单的 `backlog`；`todo`、`in_progress`；`in_review` 到 `done` | 一块地的三段 | |
| 验收 | review（`Issue.review`；动作 `accept`、`reject`） | 每张工单都有：判交回来的活过没过；`glance` 是收获就算，`required` 是先过验收才能收获 | 审核 |
| 草 | finding（`Issue.Findings`） | 没过验收的一条意见；下次验收通过才拔 | |
| 缺肥 | questions（`Issue.questions`、`Question`） | 帮工问了主人、还没回答的；施肥是回答它 | |
| 仓库 | warehouse | 收获了的工单 | |
| 账本 | ledger | 值得记的事；金币、连胜、成就由它折出来 | 事件日志 |
| 轨迹 | trajectory | 一个 agent 干活的每一步 | 日志、trace |
| 干活过程 | `SessionEvent`（一个帮工的日志） | 帮工每一轮收到的话、想、说、工具调用和结果 | 日志、trace |
| 记性 | memory | 一个帮工档案记得的事 | 记忆库 |
| 技能书 | skill（`Skill`） | 帮工档案能带的技能 | 插件 |
| 种植计划 | task graph（`TaskGraph`，带 `graph` 的父工单） | 一件长活拆成的有先后的几件，按 DAG 推进 | 工作流、playbook、plan |
| 一件 | task（`Task`，带 `task` 的子工单） | 种植计划里的一件，一个帮工做 | 步骤、step、节点、node |
| 主人 | user | 你 | |
| 田头 | general | 默认的频道：你、管家和帮工都在 | 群 |
| 频道 | channel | 另开的说话的地方；微信、飞书、QQ 各接一个 | 群 |
| 串 | thread | 挂在一条消息下面的话题串；派活时开的叫工单串 | 子频道 |
| 定时 | recurrence（`Recurrence`） | 一张工单的一种触发：到点开它的一次干活，派给帮工或管家 | cron |
| 来电 | inbox | 要你处理的事 | 通知 |
| 巡查 | patrol | 定时看 Inbox，放久了叫醒管家 | |
| 连接到本机 | lan | 让局域网里的设备用这个农场的监听，默认关 | 远程模式 |
