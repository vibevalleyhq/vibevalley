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
| [ingress.md](docs/subsystems/ingress.md) | Ingress：把七种来源标准化成一张 Trigger，去重、存载荷、交给信箱 |
| [mailbox.md](docs/subsystems/mailbox.md) | 信箱：谁该听到、三道刹车、投递状态机、叫醒与工单蓄水池 |
| [resource.md](docs/subsystems/resource.md) | Resource：只读、分页、按会话权限裁剪的 `resource_read` |
| [session.md](docs/subsystems/session.md) | 帮工：Session 和 Run、规矩和汇报、事件日志、额度和上限 |
| [repo.md](docs/subsystems/repo.md) | 仓库：工作目录、worktree、检查、GitHub 检测、地契 |
| [artifact.md](docs/subsystems/artifact.md) | 稿子：主人和帮工一起写的块、交上来的网页；按块存按 op 改，网页按版本存、隔离着看，带卡片说出来 |
| [pkm.md](docs/subsystems/pkm.md) | 笔记：主人的 Logseq 式大纲页面，按 PARA 分文件夹；文件是真相，读进内存再写回，块引用、反链、搜索、闪念、剪藏、改写和撤销 |
| [channel.md](docs/subsystems/channel.md) | 频道：默认频道、私聊、谁听见、工单串、连接器、Inbox |
| [inbox.md](docs/subsystems/inbox.md) | Inbox：要你处理的事、刚来的、巡查，经通话、手机、系统通知送到主人 |
| [brain.md](docs/subsystems/brain.md) | VibeValley 自己的 agent：模型请求、循环、对话文件、提示开头、压缩、技能、记性、帮手、自己的任务，四种用法 |
| [orchestrator.md](docs/subsystems/orchestrator.md) | 管家：收什么话、现状、工具、谁能让它合并、巡查、评测 |
| [cron.md](docs/subsystems/cron.md) | 定时任务：一张工单的触发：间隔和 cron、补跑、回头看 |
| [memory.md](docs/subsystems/memory.md) | 记性：想起、记下、主动查、外面的来源 |
| [voice.md](docs/subsystems/voice.md) | 语音：通话（Agora ConvoAI）、听写、语音管家 |
| [lan.md](docs/subsystems/lan.md) | 「连接到本机」：局域网里配对过的设备用同一个农场 |
| [setting.md](docs/subsystems/setting.md) | 设置：settings.json、配置和环境变量、钥匙和打码 |
| [provider.md](docs/subsystems/provider.md) | AI 服务：供应商连接、模型目录、默认用途、凭据与配置版本 |
| [media.md](docs/subsystems/media.md) | 生图：持久化任务、独立下载、安全校验、本机附件与状态投影 |
| [game.md](docs/subsystems/game.md) | 游戏：账本、金币和成就、等级、空地和特效 |
| [core.md](docs/subsystems/core.md) | 核心状态：一份状态只因事实而变、三条流、接口和能力表、重启 |
| [foundation.md](docs/subsystems/foundation.md) | 地基：一个仓库、一块业务一个服务、Effect 的 layer、形状和规则、SQLite 生成器、表结构、测试 |
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
| [primitives.md](docs/reference/primitives.md) | 各地基文件夹导出的共用原语和一句话说明；写帮手之前先查；`scripts/primitives.ts` 写出 |

怎么写（`style/`）：

| 文档 | 讲什么 |
|---|---|
| [module-design.md](docs/style/module-design.md) | 架构、模块边界与测试设计：道（责任与不变量）、术（契约与证据）、器（实现与检查工具） |
| [code.md](docs/style/code.md) | 代码：格式、叫法、注释写什么不写什么 |
| [naming.md](docs/style/naming.md) | 命名：名字站在领域的视角，不用的名字，文件、代码、接口、表、词典的键和测试标记的形状，改名 |
| [design.md](docs/style/design.md) | 界面：田间工作台的审美、令牌（表面、颜色、圆角、控件、线和影、字、图标、动效、层）、原子和模式、给 agent 的清单 |
| [writing.md](docs/style/writing.md) | 文字：写什么、删什么，词和格式怎么写；文档、Note、skill、提交说明、注释和回复都用 |

## 用语

叫法分两张表。下面这张是活本身的叫法：工作台、命令行、管家、工具和提醒都用它，中文界面用左边一列，英文界面用 English 一列。「不用」一列只管对主人说的话：中文界面不用其中的词，英文界面不用其中的英文词，English 一列里有的照用；代码和讲服务端的文档照「代码里」一列和实际的概念来（[concepts.md](docs/concepts.md)），代码里碰到「不用」里的词，只有指的是这一行的东西才算错。带括号说明的词只在那个意思上不用，「（中文界面）」的只在中文界面不用。界面上的字写在词典里（`packages/i18n/locales`），中英各一份（[话放在哪](docs/subsystems/foundation.md#话放在哪)）；工单的状态和动作只有一套词，在 `packages/i18n/locales/*/shared.json`（[状态和用语](docs/subsystems/issue.md#状态和用语)）。农场把这些画成种地，种地的词在[第二张表](#农场的皮)，只在农场的画面和游戏里用。`vpx scripts/i18n.ts check` 照「不用」一列和种地的词查皮（农场、记忆树、像素零件、游戏和素材图鉴）以外的词典，`scripts/glossary.ts` 查「代码里」一列的名字都还在代码里。

| 叫法 | English | 代码里 | 意思 | 不用 |
|---|---|---|---|---|
| 管家 | manager | orchestrator（角色是 `orchestrator` 的档案） | 你直接说话的 agent，替你派活；可以有好几个，内置的是默认管家 | 工头（指管家时）、主 agent |
| 帮工 | helper | Session（[concepts](docs/concepts.md#session-和-oar-会话)） | 一个档案工作的执行上下文；工单里的画成帮工，私聊的关联频道，跨多轮保留身份 | 工人、子 agent、worker、执行（指帮工时） |
| 在场 | here | `presentSessions`（核心状态里的 `sessions`） | 现在还在的帮工：在干活或歇着，没走 | 地里 |
| 一轮 | a round of work | `Run`（`session_run` 表） | 一次触发到一次汇报：派出去、带话、计划、定时任务、农机自己 | 一次干活、turn（指一轮时） |
| 档案 | profile | agent（`Agent`） | 一份 agent：农机、模型、人设、技能、长相；角色（`role`）是管家（`orchestrator`）或帮工（`worker`） | 帮工档案、角色（指档案时） |
| 农机 | machine | runtime（`RuntimeInfo`） | 机器上的一种编码 agent 程序（pi、claude、codex……）；左栏和设置里也叫农机 | harness、引擎、runtime（中文界面） |
| 工单 | ticket | issue（`Issue`） | 一件活，从写下到关上一个 id；每派一次是一个帮工 | job、ticket |
| 稿子 | artifact | artifact（`Artifact`，正文 `blocks` 或 `html`） | 留下来要人看的一篇：一起一块一块写的，或交上来一稿一稿换的网页（第 N 稿）；交上来的带卡片挂在频道和工单上 | 产出、文档（指稿子时）、doc（指稿子时） |
| 笔记 | notes | pkm（`Pkm`，一页 `PkmPage`，一块 `PkmBlock`） | 你自己的知识库：PARA 几个文件夹里的大纲页面和每天的日记，工作台的「笔记」页（`/pkm`）；文件在笔记库里，别的编辑器也能改 | |
| 仓库 | repo | repo（`RepoSummary`） | 空间 `repos/` 下的一个 git 仓库；农场里是一座岛，工作台的「仓库」页（`/repos`，「全部」是整张地图） | 一块地 |
| 空间 | space | `SpaceState`；目录是 `ServerConfig` 的 `workRoot` | 一套独立的仓库、工作树、工单、频道和笔记；工作台「仓库」页的「全部」 | 世界、全图 |
| 宿主 | host | `ServerConfig.home`（`$VIBEVALLEY_HOME`） | 本机跨空间共用的运行状态：密钥、农机、全局档案模板和日志 | |
| 空位 | spot | `ServerConfig.repo.maxSessions`（配置 `repo.max_sessions`）、`Session.makeRoom`；每台农机另有 `maxWorking` | 一个仓库（和整个 VibeValley）同时能在做的工单数；满了的待办排队，有空位自动开工 | 并发位、空地 |
| 档案模板 | profile template | `AgentTemplate`（`agent.template.*`） | 一份 agent 的配方：`agent.json` 加人设 `persona.md`；装一份就多一份档案，界面上在档案页叫「模板」 | 种子、预设 |
| 工单模板 | ticket template | issue template（`IssueTemplate`、`repo.template.list`） | 写工单的现成模板：一个标题和一行完成线，按仓库的栈填好命令；代码里的 seed 只指种子数据（`seeds.json`） | seed |
| 阶段 | what it is doing | phase（`Session.phase`） | 帮工到哪了：刚派出去、在干活、交回来了、没做成、歇着、走了 | 状态（指阶段时） |
| 核心状态 | core state | `SpaceState` | 大地图上的一切，只有服务端持有 | |
| VibeValley | VibeValley | 服务端、整个系统 | 说系统做了什么时的叫法（「VibeValley 会建好」「VibeValley 重启了」）；农场是它的一张皮，不是它的名字 | 农场（指系统时） |
| 事实 | fact | `Fact` | 改核心状态的一件事 | patch |
| 改动 | changes | `Changes`（`issue.diff.get`） | 工单分支上的提交、改的文件和 diff，合进去会不会冲突 | 差异、PR 详情、收成清单 |
| 完成 | complete | 动作 `complete`；工单挪到 `done`（已完成） | 主人点头，工单关成已完成；交付了什么另记（`delivered`）：合进了主分支（`github.pr_repos` 里的仓库是推分支、开 PR，PR 合了才关）、分支留着没合、没有改动要合 | 收获、合并（指完成时：合并只是交付的一种） |
| 取消 | cancel | 动作 `close`；工单挪到 `canceled`（已取消） | 不做了：帮工收工，分支上有提交就留着 | 收工（指取消时：那是帮工离开） |
| 关上 | closed | `isClosed`：`done` 或 `canceled` | 已完成和已取消的合称：看板的「已关」一列 | |
| 聊清楚、安排活、完成 | talk it through, get it worked, finish | 工单的 `backlog`；`todo`、`in_progress`；`in_review` 到 `done` | 一张工单的三段 | |
| 验收 | review; pass, send back | `Issue.review`（`issue.review`；打回是带话挪回待办，`reject`） | 每张工单都有：判交回来的活过没过；挪到已完成就是通过，管家验过的记在 `Issue.reviewedAt` | 审核 |
| 验收意见 | review note | finding（`Issue.findings`） | 没过验收的一条意见；下次验收通过才算解决 | 草（农场的皮里用） |
| 验收标准 | criteria | `Issue.criteria`、`CriterionCheck`、`CheckResult` | 工单写下的完成线，一条一条；帮工交回来时逐条说过没过 | |
| 问题 | question | questions（`Issue.questions`、`Question`） | 帮工问了主人、还没回答的；有问题时工单「等你回答」 | 缺肥 |
| 轨迹 | trajectory | `SessionEvent`（服务端由 `Journal` 记，页面由 `Trajectory`、`WorkLog` 画） | 一个帮工或管家每一轮收到的话、想、说、工具调用和结果 | 干活过程、日志（指轨迹时）、trace |
| 记性 | memory | memory（`Memory`） | 一份档案记得的事 | 记忆库 |
| 技能 | skill | skill（`Skill`） | 档案能带的技能；农场里画成技能书 | 插件（指技能时） |
| 人设 | persona | `persona.md`、`PersonaMode` | 档案的性格和说话的方式：当系统提示，或放在每一轮的开头 | |
| 帮手 | subagent | subagent（`runtime_todo.executor` 的 `subagent`） | 帮工或管家在自己的进程里另开的 agent，替它查一件事，答完就走 | |
| 自己的任务 | todo | `Todo`（`runtime_todo` 表，工具 `todo_add`、`todo_update`、`todo_list`） | agent 给自己记的待办，不是工单 | |
| 父工单 | parent issue | `Issue`（有子工单） | 子单通过检查后汇入父分支，父单统一验收 | 计划图、TaskGraph |
| 子工单 | child issue | `Issue`（带 `parent`、`blockedBy`；拆单输入为 `IssueChildDraft`） | 一个帮工负责的原生工单，前置完成后派发 | Task、步骤状态机 |
| 派活 | dispatch | hire（`Issue.hire`、事实 `FactSessionChanged`） | 把一张工单交给一个档案、开一个帮工；工单挪到待办就是派活 | |
| 派工关联 | assignment | `Assignment`（`issue_assignment`） | 一张工单由哪个档案负责，执行上下文挂在这条关系下 | |
| 执行器 | executor | `Executor` | 创建、投递、中断和释放 oar 的执行实例 | |
| 起草 | refine | refine（`IssueRefinement`、`issue.refine`） | 一个帮工读代码，把待规划的工单写成标题、描述和验收标准，写完就走 | |
| 主人 | owner | owner | 你 | |
| 田头 | the farm chat | 默认频道（`Channel.default`） | 农场的皮对默认频道的叫法；工作台里写它的名字（`#general`） | 群（指默认频道时） |
| 私聊 | direct message | direct | 你和一个管家两个人说话的地方，帮工不在 | 私信 |
| 和帮工私聊 | talk | `Channel.direct`、`Session.channel` | 和一个档案直接说话，Session 回到原私聊，闲置时休眠，不创建工单 | |
| 频道 | channel | channel（`Channel`） | 另开的说话的地方；微信、飞书、QQ 各接一个 | 群（指频道时）、群聊 |
| 串 | thread | thread | 挂在一条消息下面的话题串；派活时开的叫工单串 | 子频道 |
| 附件 | attachment | `Attachment`（`channel_attachment` 表） | 一条消息带的文件和图 | |
| 工作目录 | working folder | `Workplace`（`workdir`） | 帮工干活的目录：仓库目录或工单的 worktree；VibeValley 自己的是 `VIBEVALLEY_WORK_ROOT` | 工作区 |
| 定时任务 | scheduled task | cron（`Cron`） | 一张工单的一种触发：到点开它的一轮，派给帮工或管家 | 定时（指定时任务时）、schedule（指定时任务时）、recurrence |
| Inbox | inbox | `InboxItem`（`StateFrame.inbox`，服务是 `Inbox`） | 要你处理的事，从核心状态现算 | 通知（指 Inbox 时）、来电（农场的皮里用） |
| 提醒 | notice | `Core.notice`、`NoticeLevel`（事件流里是 `ServerEventNotice`） | VibeValley 一闪而过地告诉你一句：信息、警告或出错；不进 Inbox | |
| 巡查 | patrol | `patrolStep`（`Inbox.patrol`） | 定时看 Inbox，放久了叫醒管家 | |
| 通话 | call | `VoiceCall`（`voice.call.*`） | 和管家打电话 | |
| 听写 | dictation | dictation（`Dictation`） | 说话变成输入框里的字 | |
| 连接器 | connector | `Connector` | 把微信、飞书、QQ 各接到一个频道 | |
| 花费 | spending | `Spent`、`RuntimeQuota` | 农机花了多少钱、还剩多少额度 | |
| 连接到本机 | connect to this machine | lan | 让局域网里的设备用这台电脑上的 VibeValley 的监听，默认关 | 远程模式 |

### 农场的皮

农场把上面的东西画成种地。这些词只在农场的画面（`apps/web/src/farm`）和游戏（`apps/server/src/game`、账本、成就）里用，工单的状态、动作、拒绝、提醒、工具和管家的话都不用；代码由 `scripts/stale-names.ts` 查，词典由 `vpx scripts/i18n.ts check` 查（皮的命名空间除外）。地长什么样见[农场的皮](docs/subsystems/farm.md)。

| 农场里 | English | 实际是 | 代码里 |
|---|---|---|---|
| 地 | plot | 一张工单（开 worktree 的代码工单带一个 worktree）；一座岛上的空位是这个仓库的空位 | `FarmView.plots` 按工单的 id 做键（`plotKeyOf`：重开的工单还是这块地）；像素村里的位置是 station，画出来的那块地在客户端叫 `Bed` |
| 种子袋 | seed bag | 待办（排队等空位的工单） | `todo`、`queued_at` |
| 播种袋里的种子 | seeds | 工单模板 | `IssueTemplate` |
| 播种、发芽、长叶 | sow, sprout, leafy | 处理中 | `in_progress`，帮工 `working` |
| 开花 | flowering | 等你看 | `in_review`，帮工 `done` |
| 缺肥（地干裂）、施肥 | dry, water | 等你回答、回答 | `questions` |
| 草、除草中 | weeds, weeding | 验收意见、带着意见再修一轮 | `findings` |
| 收获、收成清单 | harvest, harvest list | 完成、改动 | 动作 `complete`、`Changes` |
| 麦茬 | stubble | 已完成 | `done` |
| 仓库 | warehouse | 合进主分支或 PR 合了的工单 | `delivered`：`merged`、`pull_request` |
| 图纸桌 | issue board | 工单 | `Issue` |
| 一季庄稼 | a crop | 一轮 | `Run` |
| 地里 | in the field | 在场的帮工 | `presentSessions` |
| 来电 | call | Inbox 里的一件 | `InboxItem` |
| 农具 | tools | 农机 | `RuntimeInfo` |
| 技能书 | skill book | 技能 | `Skill` |
| 账本 | ledger | 值得记的事；金币、连胜、成就由它折出来 | `LedgerEntry`（`game_ledger` 表） |
| 成就 | achievement | 从账本折出来的里程碑 | `Achievement` |
| 等级 | level | 一共提交了多少次 | `CommitCount`、`FarmView.level` |
| 农场 | the farm | 这张皮本身（`/` 的像素农场）；说系统时是 VibeValley | |
