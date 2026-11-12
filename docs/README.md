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
| [issue.md](docs/subsystems/issue.md) | 工单：一块地：工单的模型、状态和派活、验收、完成与 PR 跟进、定时任务 |
| [session.md](docs/subsystems/session.md) | 帮工：触发去重、谁该听到、三道刹车、投递和叫醒、工单蓄水池，Session 和 Run、工作目录、机器执行器、规矩和汇报、事件日志、额度和上限、重启后接着答 |
| [repo.md](docs/subsystems/repo.md) | 仓库：工作目录、worktree、检查、GitHub 检测与 PR 快照、地契 |
| [artifact.md](docs/subsystems/artifact.md) | Artifact：用户和帮工一起写的块、交上来的网页；按块存按 op 改，网页按版本存、隔离着看，带卡片说出来 |
| [pkm.md](docs/subsystems/pkm.md) | 笔记：用户的 Logseq 式大纲页面，按 PARA 分文件夹；文件是真相，读进内存再写回，块引用、反链、搜索、闪念、剪藏、改写和撤销 |
| [channel.md](docs/subsystems/channel.md) | 频道：默认频道、私聊、消息和事件、工单串、连接器 |
| [watch.md](docs/subsystems/watch.md) | 观察层：按游标读频道的事件、谁听见、三道刹车、帮工的串和回执；收件箱：要你处理的事、刚来的、巡查，经通话、手机、系统通知送到用户 |
| [brain.md](docs/subsystems/brain.md) | VibeValley 自己的 agent：模型请求、循环、对话文件、提示开头、压缩、技能、记性、帮手、自己的任务，四种用法 |
| [orchestrator.md](docs/subsystems/orchestrator.md) | 助手：收什么话、现状、工具与 `vv://` 资源读取、谁能让它合并、巡查、评测 |
| [memory.md](docs/subsystems/memory.md) | 记性：想起、记下、主动查、外面的来源 |
| [voice.md](docs/subsystems/voice.md) | 语音：通话（Agora ConvoAI）、听写、语音助手 |
| [lan.md](docs/subsystems/lan.md) | 「连接到本机」：从外面进农场的唯一一道门，按钥匙的来路放行 |
| [attachment.md](docs/subsystems/attachment.md) | 附件：农场留下的一份文件，按 SHA-256 内容寻址落盘存一次；消息、媒体结果和素材库都引用它 |
| [user.md](docs/subsystems/user.md) | 用户和设备：一个用户、名字和密码、每台设备一把钥匙、密码和确认码登录、收回和久不用作废 |
| [setting.md](docs/subsystems/setting.md) | 设置：settings.json、配置和环境变量、钥匙和打码 |
| [provider.md](docs/subsystems/provider.md) | AI 服务：供应商连接、模型目录、默认用途、凭据与配置版本 |
| [media.md](docs/subsystems/media.md) | 媒体和素材库：生图、语音、理解、转写任务与本机输入，独立下载与安全校验；生成的、你上传的、帮工拿回来的文件，一份文件一张卡，记着来路 |
| [game.md](docs/subsystems/game.md) | 游戏：账本、金币和成就、等级、空地和特效 |
| [core.md](docs/subsystems/core.md) | 核心状态：一份状态只因事实而变、SSE 流和全部路由、接口和能力表、重启 |
| [foundation.md](docs/subsystems/foundation.md) | 地基：一个仓库、一块业务一个服务（工厂加接口）、异步原语、Zod 的形状和规则、Postgres 查询生成器、表结构、测试 |
| [app.md](docs/subsystems/app.md) | 客户端：一份 Solid 页面、问服务端、宿主接口、Electron 的桌面版和打包 |
| [farm.md](docs/subsystems/farm.md) | 农场的皮：像素村、地里长什么、走路、手机、音效、图鉴 |
| [agent.md](docs/subsystems/agent.md) | 档案和农机：档案和它的角色、种子、农机的探测和清单、技能书 |
| [process.md](docs/subsystems/process.md) | 工程流程：文档分层、Note 和子系统、检查、skill、写作规范、素材流水线 |
| [site.md](docs/subsystems/site.md) | 官网：Vite + Solid 2 静态生成、图从游戏来 |

查的东西（`reference/`）：

| 文档 | 讲什么 |
|---|---|
| [concept-map.md](docs/reference/concept-map.md) | 概念在各层的名字：农场里、界面、协议、HTTP、服务端、存储、oar |
| [capabilities.md](docs/reference/capabilities.md) | 每个接口谁能调：用户、「连接到本机」、助手；`scripts/gen/capabilities.ts` 写出 |
| [farm-ui.md](docs/reference/farm-ui.md) | 界面清单、角色、轨迹和精力瓶 |
| [primitives.md](docs/reference/primitives.md) | 各地基文件夹导出的共用原语和一句话说明；写帮手之前先查；`scripts/gen/primitives.ts` 写出 |

怎么写（`style/`）：

| 文档 | 讲什么 |
|---|---|
| [module-design.md](docs/style/module-design.md) | 架构、模块边界与测试设计：责任和边界、类型驱动与进门解码、显式状态、错误契约与测试证据、检查工具 |
| [code.md](docs/style/code.md) | 代码：格式、叫法、注释写什么不写什么 |
| [naming.md](docs/style/naming.md) | 命名：名字站在领域的视角，不用的名字，文件、代码、接口、表、词典的键和测试标记的形状，改名 |
| [design.md](docs/style/design.md) | 界面：田间工作台的审美、令牌（表面、颜色、圆角、控件、线和影、字、图标、动效、层）、原子和模式、给 agent 的清单 |
| [writing.md](docs/style/writing.md) | 文字：写什么、删什么，词和格式怎么写；文档、Note、skill、提交说明、注释和回复都用 |

## 用语

叫法分两张表。下面这张是活本身的叫法：工作台、命令行、助手、工具和提醒都用它，中文界面用左边一列，英文界面用 English 一列。「不用」一列只管对用户说的话：中文界面不用其中的词，英文界面不用其中的英文词，English 一列里有的照用；代码和讲服务端的文档照「代码里」一列和实际的概念来（[concepts.md](docs/concepts.md)），代码里碰到「不用」里的词，只有指的是这一行的东西才算错。带括号说明的词只在那个意思上不用，「（中文界面）」的只在中文界面不用。界面上的字写在词典里（`packages/i18n/locales`），中英各一份（[话放在哪](docs/subsystems/foundation.md#话放在哪)）；工单的状态和动作只有一套词，在 `packages/i18n/locales/*/shared.json`（[状态和用语](docs/subsystems/issue.md#状态和用语)）。农场把这些画成种地，种地的词在[第二张表](#农场的皮)，只在农场的画面和游戏里用。`vpx scripts/gen/i18n.ts check` 照「不用」一列和种地的词查皮（农场、记忆树、像素零件、游戏和素材图鉴）以外的词典，`scripts/docs/glossary.ts` 查「代码里」一列的名字都还在代码里。

| 叫法 | English | 代码里 | 不用 |
|---|---|---|---|
| 助手 | assistant | orchestrator（角色是 `orchestrator` 的档案） | 管家（指这个角色时）、manager、工头（指助手时）、主 agent |
| 帮工 | helper | Session（[concepts](docs/concepts.md#session-和-oar-会话)） | 工人、子 agent、worker、执行（指帮工时） |
| 在场 | here | `Session.hired`（核心状态里雇来的会话） | 地里 |
| 一轮 | a round of work | `Run`（`session_run` 表） | 一次干活、turn（指一轮时） |
| 档案 | profile | agent（`Agent`） | 帮工档案、角色（指档案时） |
| 农机 | machine | runtime（`RuntimeInfo`） | harness、引擎、runtime（中文界面） |
| 工单 | ticket | issue（`Issue`） | job、ticket |
| Artifact | artifact | artifact（`Artifact`，正文 `blocks` 或 `html`） | 稿子、草稿（指 Artifact 时）、产出、文档（指 Artifact 时）、doc（指 Artifact 时） |
| 笔记 | notes | pkm（`Pkm`，一页 `PkmPage`，一块 `PkmBlock`） |  |
| 仓库 | repo | repo（`RepoSummary`） | 一块地 |
| 空间 | space | `SpaceState`；目录是 `ServerConfig` 的 `workRoot` | 世界、全图 |
| 宿主 | host | `ServerConfig.home`（`$VIBEVALLEY_HOME`） |  |
| 空位 | spot | `ServerConfig.repo.maxSessions`（配置 `repo.max_sessions`）、`Session.room`；每台农机另有 `maxWorking` | 并发位、空地 |
| 档案模板 | profile template | `AgentTemplate`（`agent.template.*`） | 种子、预设 |
| 工单模板 | ticket template | issue template（`IssueTemplate`、`repo.template.list`） | seed |
| 阶段 | what it is doing | phase（`Session.phase`） | 状态（指阶段时） |
| 核心状态 | core state | `SpaceState` |  |
| VibeValley | VibeValley | 服务端、整个系统 | 农场（指系统时） |
| 事实 | fact | `Fact` | patch |
| 改动 | changes | `Changes`（`issue.diff.get`） | 差异、PR 详情、收成清单 |
| 完成 | complete | 动作 `complete`；工单挪到 `done`（已完成） | 收获、合并（指完成时：合并只是交付的一种） |
| 取消 | cancel | 动作 `close`；工单挪到 `canceled`（已取消） | 收工（指取消时：那是帮工离开） |
| 关上 | closed | `isClosed`：`done` 或 `canceled` |  |
| 聊清楚、安排活、完成 | talk it through, get it worked, finish | 工单的 `backlog`；`todo`、`in_progress`；`in_review` 到 `done` |  |
| 验收 | review; pass, send back | `Issue.review`（`issue.review`；打回是带话挪回待办，`reject`） | 审核 |
| 验收意见 | review note | finding（`Issue.findings`） | 草（农场的皮里用） |
| 验收标准 | criteria | `Issue.criteria`、`CriterionCheck`、`CheckResult` |  |
| 问题 | question | questions（`Issue.questions`、`Question`） | 缺肥 |
| 轨迹 | trajectory | `SessionEvent`（服务端由 `Journal` 记，页面由 `Trajectory`、`WorkLog` 画） | 干活过程、日志（指轨迹时）、trace |
| 记性 | memory | memory（`Memory`） | 记忆库 |
| 技能 | skill | skill（`Skill`） | 插件（指技能时） |
| 人设 | persona | `persona.md`、`PersonaMode` |  |
| 帮手 | subagent | subagent（`agent_todo.executor` 的 `subagent`） |  |
| 自己的任务 | todo | `Todo`（`agent_todo` 表，工具 `todo_add`、`todo_update`、`todo_list`） |  |
| 父工单 | parent issue | `Issue`（有子工单） | 计划图、TaskGraph |
| 子工单 | child issue | `Issue`（带 `parent`、`blockedBy`；拆单输入为 `IssueChildDraft`） | Task、步骤状态机 |
| 派活 | dispatch | hire（`Issue.hire`、事实 `FactSessionChanged`） |  |
| 派工关联 | assignment | `Assignment`（`issue_assignment`） |  |
| 执行器 | executor | `Executions`（`executor.ts`） |  |
| 起草 | refine | refine（`IssueRefinement`、`issue.refine`） |  |
| 用户 | user | user（`User`、`userId`） | 主人、owner |
| 田头 | the farm chat | 默认频道（`Channel.defaultChannel`） | 群（指默认频道时） |
| 私聊 | direct message | direct | 私信 |
| 和帮工私聊 | talk | `Channel.direct`、`Session.channel` |  |
| 频道 | channel | channel（`Channel`） | 群（指频道时）、群聊 |
| 串 | thread | thread | 子频道 |
| 附件 | attachment | `Attachment`（`attachment` 表） |  |
| 素材库 | library | `Media` 的 `libraryItems` 等（`media_library_item` 表） | 媒体（指这一页时） |
| 工作目录 | working folder | `Workplace`（`workdir`） | 工作区 |
| 定时任务 | scheduled task | cron（`Cron`） | 定时（指定时任务时）、schedule（指定时任务时）、recurrence |
| Inbox | inbox | `InboxItem`（`StateFrame.inbox`，服务是 `Inbox`） | 通知（指 Inbox 时）、来电（农场的皮里用） |
| 提醒 | notice | `Core.notice`、`NoticeLevel`（事件流里是 `LiveEventNotice`） |  |
| 巡查 | patrol | `patrolStep`（`Inbox.patrol`） |  |
| 通话 | call | `VoiceCall`（`voice.call.*`） |  |
| 听写 | dictation | dictation（`Dictation`） |  |
| 连接器 | connector | `Connector` |  |
| 花费 | spending | `Spent`、`RuntimeQuota` |  |
| 连接到本机 | connect to this machine | lan | 远程模式 |

### 农场的皮

农场把上面的东西画成种地。这些词只在农场的画面（`apps/web/src/farm`）和游戏（`apps/server/src/modules/game`、账本、成就）里用，工单的状态、动作、拒绝、提醒、工具和助手的话都不用；代码由 `scripts/docs/stale-names.ts` 查，词典由 `vpx scripts/gen/i18n.ts check` 查（皮的命名空间除外）。地长什么样见[农场的皮](docs/subsystems/farm.md)。

| 农场里 | English | 实际是 | 代码里 |
|---|---|---|---|
| 地 | plot | 一张工单（开 worktree 的代码工单带一个 worktree）；一座岛上的空位是这个仓库的空位 | `FarmView.plots` 按工单的 id 做键（`plotKeyOf`：重开的工单还是这块地）；像素村里的位置是 station，画出来的那块地在客户端叫 `Bed` |
| 种子袋 | seed bag | 待办（排队等空位的工单） | `todo`、`queued_at` |
| 播种袋里的种子 | seeds | 工单模板 | `IssueTemplate` |
| 播种、发芽、长叶 | sow, sprout, leafy | 处理中 | `in_progress`，帮工 `working` |
| 开花 | flowering | 等你看 | `in_review`，帮工 `done` |
| 缺肥（地干裂）、施肥 | dry, water | 等你回答、回答 | `questions` |
| 草、除草中 | weeds, weeding | 验收意见、带着意见再修一轮 | `findings` |
| 收获 | harvest | 完成（收之前看改动） | 动作 `complete`、`Changes` |
| 麦茬 | stubble | 已完成 | `done` |
| 仓库 | warehouse | 合进主分支或 PR 合了的工单 | `delivered`：`merged`、`pull_request` |
| 图纸桌 | issue board | 工单 | `Issue` |
| 一季庄稼 | a crop | 一轮 | `Run` |
| 地里 | in the field | 在场的帮工 | `Session.hired` |
| 来电 | call | Inbox 里的一件 | `InboxItem` |
| 农具 | tools | 农机 | `RuntimeInfo` |
| 技能书 | skill book | 技能 | `Skill` |
| 账本 | ledger | 值得记的事；金币、连胜、成就由它折出来 | `LedgerEntry`（`game_ledger` 表） |
| 成就 | achievement | 从账本折出来的里程碑 | `Achievement` |
| 等级 | level | 一共提交了多少次 | `CommitCount`、`FarmView.level` |
| 农场 | the farm | 这张皮本身（`/` 的像素农场）；说系统时是 VibeValley | |
