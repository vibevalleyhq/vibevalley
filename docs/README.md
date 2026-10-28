# VibeValley 文档

VibeValley 是 AI 版的 [Linear](https://linear.app)，穿着像素农场的皮（[概念](docs/concepts.md)）。这里写现在怎么用、怎么开发、东西怎么工作；为什么这样设计和还没做的提案在 [Agent Notes](.agents/notes/README.md)，文档放在哪见 [AGENTS.md](docs/AGENTS.md)。

先读：

| 文档 | 讲什么 |
|---|---|
| [guide.md](docs/guide.md) | 教程：派第一张工单，看着它干，完成它，处理冲突和失败，管住花费，用语音 |
| [development.md](docs/development.md) | 教程：本机跑起来，检查和测试，改形状、规则和表，打包 |
| [concepts.md](docs/concepts.md) | 概念：实际是什么，农场怎么画它们 |
| [architecture.md](docs/architecture.md) | 架构：分层、核心状态、事件流、接口和存储。改 `apps/`、`packages/` 之前读 |

子系统（`subsystems/`，从架构的角度写一个子系统沉淀下来的样子，[怎么写](docs/subsystems/README.md)）：

| 文档 | 内容 |
|---|---|
| [issue.md](docs/subsystems/issue.md) | 工单：一块地：工单的模型、状态和派活、验收、收获 |
| [session.md](docs/subsystems/session.md) | 帮工：Session 和 Run、规矩和汇报、事件日志、额度和上限 |
| [project.md](docs/subsystems/project.md) | 项目：工作目录、worktree、检查、GitHub 检测、地契 |
| [channel.md](docs/subsystems/channel.md) | 频道：默认频道、私聊、谁听见、工单串、连接器、Inbox |
| [notice.md](docs/subsystems/notice.md) | 通知：Inbox、刚来的、巡查，经通话、手机、系统通知送到主人 |
| [orchestrator.md](docs/subsystems/orchestrator.md) | 管家：自己的 agent、提示和工具、来源、巡查、评测 |
| [schedule.md](docs/subsystems/recurrence.md) | 定时：一张工单的触发：间隔和 cron、补跑、回头看 |
| [task.md](docs/subsystems/task.md) | 计划：带子工单的父工单、按图推进；agent 自己的任务 |
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
| [agent.md](docs/subsystems/agent.md) | 档案和农机：档案和它的角色、种子、农机的探测和清单、技能书 |
| [process.md](docs/subsystems/process.md) | 工程流程：文档分层、Note 和子系统、检查、skill、写作规范、素材流水线 |
| [site.md](docs/subsystems/site.md) | 官网：Astro、island、图从游戏来 |

查的东西（`reference/`）：

| 文档 | 讲什么 |
|---|---|
| [concept-map.md](docs/reference/concept-map.md) | 概念在各层的名字：农场里、界面、协议、HTTP、服务端、存储、oar |
| [capabilities.md](docs/reference/capabilities.md) | 每个接口谁能调：主人、「连接到本机」、管家；`scripts/capabilities.ts` 写出 |
| [farm-ui.md](docs/reference/farm-ui.md) | 界面清单、角色、轨迹和精力瓶 |

怎么写（`style/`）：

| 文档 | 讲什么 |
|---|---|
| [code.md](docs/style/code.md) | 代码：格式、叫法、注释写什么不写什么 |
| [writing.md](docs/style/writing.md) | 文字：写什么、删什么，词和格式怎么写；文档、Note、skill、提交说明、注释和回复都用 |

## 用语

叫法分两张表。下面这张是活本身的叫法：工作台、命令行、管家、工具和提醒都用它，中文界面用左边一列，英文界面用 English 一列，不用最右一列；代码和讲服务端的文档按实际的概念来（[concepts.md](docs/concepts.md)）。界面上的字写在词表里，中英各一份（[话放在哪](docs/subsystems/foundation.md#话放在哪)）；工单的状态和动作只有一套词，在 `packages/protocol/src/words`（[状态和用语](docs/subsystems/issue.md#状态和用语)）。农场把这些画成种地，种地的词在[第二张表](#农场的皮)，只在农场的画面和游戏里用。

| 叫法 | English | 代码里 | 意思 | 不用 |
|---|---|---|---|---|
| 管家 | manager | orchestrator（角色是 `orchestrator` 的档案） | 你直接说话的 agent，替你派活；可以有好几个，内置的是默认管家 | 工头、主 agent |
| 帮工 | helper | Session（[concepts](docs/concepts.md#session-和-oar-会话)） | 一个档案为一张工单接的活，跨好几次干活；重开的工单换一个帮工，工单不换 | 工人、子 agent、worker |
| 在场 | here | `presentSessions`（核心状态里的 `sessions`） | 现在还在的帮工：在干活或歇着，没走 | 地里 |
| 一次干活 | a round of work | run | 一次触发到一次汇报：派出去、带话、计划、定时、农机自己 | 一轮、turn |
| 档案 | profile | agent（`Agent`） | 一份 agent：农机、模型、人设、技能、长相；角色（`role`）是管家或帮工 | 帮工档案、角色 |
| 农机 | machine | runtime | 机器上的一种编码 agent 程序（pi、claude、codex……） | harness、引擎 |
| 工单 | ticket | issue（`Issue`） | 一件活，从写下到关上一个 id；每派一次是一个帮工 | job、ticket |
| 项目 | project | project | 工作目录 `projects/` 下的一个 git 仓库；农场里是一座岛，工作台的「项目」页（`/projects`，「全部」是整张地图） | 一块地 |
| 大地图 | the map | Workspace（`Config.WorkRoot`、`Config.Home`） | 全部项目、工单、群聊和档案；工作台「项目」页的「全部」 | 世界、全图 |
| 空位 | spot | `project.max_sessions`、农场的上限 | 一个项目（和整个农场）同时能在做的工单数；满了的待办排队，有空位自动开工 | 并发位、空地 |
| 档案模板 | profile template | `AgentTemplate`（`agent.template.*`） | 一份 agent 的配方：`agent.json` 加人设 `persona.md`；装一份就多一份档案，界面上在档案页叫「模板」 | 种子、预设 |
| 工单模板 | ticket template | issue template（`IssueTemplate`、`project.template.list`） | 写工单的现成模板：一个标题和一行完成线，按项目的栈填好命令；代码里的 seed 只指种子数据（`seeds.json`） | seed |
| 阶段 | what it is doing | phase（`Session.phase`） | 帮工到哪了：刚派出去、在干活、交回来了、没做成、歇着、走了 | 状态 |
| 核心状态 | core state | `WorkspaceState` | 工作区里的一切，只有服务端持有 | |
| VibeValley | VibeValley | 服务端、整个系统 | 说系统做了什么时的叫法（「VibeValley 会建好」「VibeValley 重启了」）；农场是它的一张皮，不是它的名字 | 农场（指系统时） |
| 事实 | fact | fact | 改核心状态的一件事 | patch |
| 改动 | changes | `Changes`（`issue.diff.get`） | 工单分支上的提交、改的文件和 diff，合进去会不会冲突 | 差异、PR 详情、收成清单 |
| 完成 | complete | 动作 `complete`；工单挪到 `done`（已完成） | 主人点头，工单关成已完成；交付了什么另记（`delivered`）：合进了主分支（`github.pr_projects` 里的项目是推分支、开 PR，PR 合了才关）、分支留着没合、没有改动要合 | 收获；合并只是交付的一种 |
| 取消 | cancel | 动作 `close`；工单挪到 `canceled`（已取消） | 不做了：帮工收工，分支上有提交就留着 | 收工（那是帮工离开） |
| 关上 | closed | `isClosed`：`done` 或 `canceled` | 已完成和已取消的合称：看板的「已关」一列 | |
| 聊清楚、安排活、完成 | talk it through, get it worked, finish | 工单的 `backlog`；`todo`、`in_progress`；`in_review` 到 `done` | 一张工单的三段 | |
| 验收 | acceptance; accept, send back | review（完成就是通过；打回是带话挪回待办，`reject`） | 每张工单都有：判交回来的活过没过；挪到已完成就是通过，管家验过的记在 `Issue.reviewedAt` | 审核 |
| 验收意见 | review note | finding（`Issue.findings`） | 没过验收的一条意见；下次验收通过才算解决 | 草 |
| 问题 | question | questions（`Issue.questions`、`Question`） | 帮工问了主人、还没回答的；有问题时工单「等你回答」 | 缺肥 |
| 账本 | ledger | ledger | 值得记的事；金币、连胜、成就由它折出来 | 事件日志 |
| 轨迹 | trajectory | trajectory | 一个 agent 干活的每一步 | 日志、trace |
| 干活过程 | work steps | `SessionEvent`（一个帮工的日志） | 帮工每一轮收到的话、想、说、工具调用和结果 | 日志、trace |
| 记性 | memory | memory | 一份档案记得的事 | 记忆库 |
| 技能书 | skill book | skill（`Skill`） | 档案能带的技能 | 插件 |
| 计划 | plan | task graph（`TaskGraph`，带 `graph` 的父工单） | 一件长活拆成的有先后的几件，按 DAG 推进；都做完了一次合进主分支 | 工作流、playbook、plan、种植计划 |
| 一件 | step | task（`Task`，带 `task` 的子工单） | 计划里的一件，一个帮工做 | 步骤、step、节点、node |
| 主人 | owner | owner | 你 | |
| 田头 | the farm chat | 默认频道（`Channel.default`） | 农场的皮对默认频道的叫法；工作台里写它的名字（`#general`） | 群 |
| 私聊 | direct message | direct | 你和管家两个人说话的地方，帮工不在 | 私信 |
| 频道 | channel | channel | 另开的说话的地方；微信、飞书、QQ 各接一个 | 群 |
| 串 | thread | thread | 挂在一条消息下面的话题串；派活时开的叫工单串 | 子频道 |
| 定时 | schedule | recurrence（`Recurrence`） | 一张工单的一种触发：到点开它的一次干活，派给帮工或管家 | cron |
| 来电 | inbox | inbox | 要你处理的事 | 通知 |
| 巡查 | patrol | patrol | 定时看 Inbox，放久了叫醒管家 | |
| 连接到本机 | connect to this machine | lan | 让局域网里的设备用这台电脑上的 VibeValley 的监听，默认关 | 远程模式 |

### 农场的皮

农场把上面的东西画成种地。这些词只在农场的画面（`apps/web/src/farm`）和游戏（`apps/server/src/game`、账本、成就）里用，工单的状态、动作、拒绝、提醒、工具和管家的话都不用；`scripts/stale-names.ts` 查。地长什么样见[农场的皮](docs/subsystems/farm.md)。

| 农场里 | English | 实际是 | 代码里 |
|---|---|---|---|
| 地 | plot | 一张工单（开 worktree 的代码工单带一个 worktree）；一座岛上的空位是这个项目的空位 | `FarmView.plots` 按工单做键；像素村里的位置是 station，画出来的那块地在客户端叫 `Bed` |
| 种子袋 | seed bag | 待办（排队等空位的工单） | `todo`、`queued_at` |
| 播种袋里的种子 | seeds | 工单模板 | `IssueTemplate` |
| 播种、发芽、长叶 | sow, sprout, leafy | 处理中 | `in_progress`，帮工 `working` |
| 开花 | flowering | 等你看 | `in_review`，帮工 `done` |
| 缺肥（地干裂）、施肥 | dry, water | 等你回答、回答 | `questions` |
| 草、除草中 | weeds, weeding | 验收意见、带着意见再修一轮 | `findings` |
| 收获、收成清单 | harvest, harvest list | 完成、改动 | 动作 `complete`、`Changes` |
| 麦茬 | stubble | 已完成 | `done` |
| 仓库 | warehouse | 合进主分支或 PR 合了的工单 | `delivered`：`merged`、`pull_request` |
| 种植计划、图纸桌 | planting plan | 计划 | `TaskGraph` |
| 一季庄稼 | a crop | 一次干活 | `Run` |
| 地里 | in the field | 在场的帮工 | `presentSessions` |
| 农场 | the farm | 这张皮本身（`/` 的像素农场）；说系统时是 VibeValley | |
