# VibeValley 文档

VibeValley 是 AI 版的 [Linear](https://linear.app)，穿着 Papertrails 纸雕农场的皮（[概念](docs/concepts.md)）。这里写现在怎么用、怎么开发、东西怎么工作；未上线的规划与待办见 VibeValley Issue 看板，已沉淀的设计与放弃的路在各篇子系统文档，文档放在哪见 [AGENTS.md](docs/AGENTS.md)。

先读：

| 文档 | 讲什么 |
|---|---|
| [guide.md](docs/guide.md) | 教程：派第一张工单，看着它干，完成它，处理冲突和失败，管住花费 |
| [development.md](docs/development.md) | 教程：本机跑起来（原生应用、单独的服务端、命令行），检查和测试，改形状、规则和表，发版 |
| [concepts.md](docs/concepts.md) | 概念：实际是什么，农场怎么画它们 |
| [architecture.md](docs/architecture.md) | 架构：分层、核心状态、事件流、接口和存储。改 `crates/`、`apps/`、`packages/` 之前读 |
| [architecture-topology.md](docs/architecture-topology.md) | 目标架构与部署拓扑：四平面解耦、单机合体与分布式拓扑、`L0`–`L3` 模块收敛边界、三类主体鉴权与迁移路径 |

子系统（`subsystems/`，从架构的角度写一个子系统沉淀下来的样子，[怎么写](docs/subsystems/README.md)）：

| 文档 | 内容 |
|---|---|
| [issue.md](docs/subsystems/issue.md) | 工单：一块地：工单的模型、状态和派活、验收、完成与交付、定时任务 |
| [pull.md](docs/subsystems/pull.md) | PR 与分支发布：分支预检与推送、GitHub PR / GitLab.com MR、状态轮询、CI/评审去重与 `vv://github/...` 快照 |
| [session.md](docs/subsystems/session.md) | 帮工：Session 和 Run、工作目录、经 oar 开会话、`/mcp`、规矩和汇报、轨迹、额度和上限 |
| [runtime.md](docs/subsystems/runtime.md) | 执行层与运行机器：`Machine`、`LocalMachine`、`RemoteMachine`、无锁 `MachineRegistry`、`/api/v1/machine/ws`、`vibevalley machine up` 与容器沙箱 `SandboxMachine` |
| [repo.md](docs/subsystems/repo.md) | 仓库：工作目录、worktree、检查、本地合并、GitHub 检测、提交统计 |
| [artifact.md](docs/subsystems/artifact.md) | Artifact：八种 `ArtifactType`（含大纲笔记 `outline` 与 `.md` 导入）、结构化多条目作品（`store`）、协作块文档（`blocks`）与单页网页（`html`）；乐观并发、双语指南、全出血原生白板与统一内容中心 |
| [channel.md](docs/subsystems/channel.md) | 频道：默认频道、私聊、消息和事件、工单串、纯受众与环路刹车、持久投递 |
| [brain.md](docs/subsystems/brain.md) | VibeValley 自己的 agent（`vibevalley-runtime::agent`）：模型请求、循环、对话文件、压缩、工具、技能、记性、自己的任务 |
| [orchestrator.md](docs/subsystems/orchestrator.md) | 助手：收什么话、现状、工具与 `vv://` 资源读取、谁能让它合并、巡查、评测 |
| [memory.md](docs/subsystems/memory.md) | 记性：想起、记下、主动查、外面的来源 |
| [voice.md](docs/subsystems/voice.md) | 语音：MOSS Live 原生实时通话、`Voice::speak` 与人设设置 |
| [attachment.md](docs/subsystems/attachment.md) | 附件：农场留下的一份文件，按 SHA-256 内容寻址落盘存一次；消息、媒体结果和素材库都引用它 |
| [setting.md](docs/subsystems/setting.md) | 设置：settings.json、配置和环境变量、钥匙和打码 |
| [provider.md](docs/subsystems/provider.md) | AI 服务：供应商连接、模型目录、默认用途、凭据与配置版本 |
| [media.md](docs/subsystems/media.md) | 媒体和素材库：一个任务机上的生图与语音任务、本机输入、独立下载与安全校验；统一内容中心浏览与原生媒体详情栏 |
| [game.md](docs/subsystems/game.md) | 游戏：账本、金币和成就、等级、空地和特效 |
| [core.md](docs/subsystems/core.md) | 核心状态：一份状态只因事实而变、异步 `EventBus`、收件箱、SSE 流和全部路由、接口和能力表、重启 |
| [foundation.md](docs/subsystems/foundation.md) | 地基：Cargo 与 pnpm 工作区、深模块、边界一次解码的类型、契约的生成、SQLite 存储、测试分层 |
| [app.md](docs/subsystems/app.md) | 客户端：原生应用 `apps/mac`（GPUI 窗口、进程里的服务端、页面和服务端之间的桥、nsh TSX 的工作台、宿主能力） |
| [farm.md](docs/subsystems/farm.md) | 农场的皮：Rust `wgpu` 3D 纸雕江南院落、地里长什么、偶人走位、开场与农场手机 |
| [agent.md](docs/subsystems/agent.md) | 档案和农机：档案和它的角色、种子、农机的探测和清单、技能书 |
| [process.md](docs/subsystems/process.md) | 工程流程：双层 SSOT（Issue 与子系统文档）、`xtask` 导航与 QA 门禁、检查、skill、写作规范、素材流水线 |
| [site.md](docs/subsystems/site.md) | 官网：Vite + Solid 2 静态生成、图从游戏来 |

查的东西（`reference/`）：

| 文档 | 讲什么 |
|---|---|
| [concept-map.md](docs/reference/concept-map.md) | 概念在各层的名字：农场里、界面、协议、HTTP、服务端、存储、oar |
| [capabilities.md](docs/reference/capabilities.md) | 每个接口谁能调；`scripts/gen/capabilities.ts` 写出 |
| [primitives.md](docs/reference/primitives.md) | TS 地基文件夹导出的共用原语和一句话说明；写帮手之前先查；`scripts/gen/primitives.ts` 写出 |

设计系统与界面架构（`design/`）：

| 文档 | 讲什么 |
|---|---|
| [design/README.md](docs/design/README.md) | 设计系统全景：田间工作台与纸雕农场双皮职责、五大渲染载体与分篇索引 |
| [01-philosophy-and-tokens.md](docs/design/01-philosophy-and-tokens.md) | 设计哲学与令牌体系：十条判断准绳、五端色阶与语义四色、圆角边框阴影、字体图标梯级与动效曲线 |
| [02-atomic-components.md](docs/design/02-atomic-components.md) | 基础原子组件与交互控件：按钮、表单、开关、状态标签、弹窗表格分栏、领域原子与外壳组件对照 |
| [03-conversation-and-work-streams.md](docs/design/03-conversation-and-work-streams.md) | 会话核心流、工单板与运行轨迹引擎：频道排版、Composer 斜杠与提及、`/runs` 瀑布图、看板与档案额度 |
| [04-motion-and-pixel-rendering.md](docs/design/04-motion-and-pixel-rendering.md) | 动效物理学、3D 纸雕渲染与光影系统：`wgpu` + WGSL 纸雕管线、昼夜光影、掀顶切面、寻路与行为防抖物理 |
| [05-audiovisual-and-artifacts.md](docs/design/05-audiovisual-and-artifacts.md) | 视听多媒体、Artifact 与终端交互物理：独占音频、程序化音效、素材库灯箱、双轨分栏、Diff/文件/终端链接 |
| [06-desktop-architecture-and-topology.md](docs/design/06-desktop-architecture-and-topology.md) | 桌面架构、全页面清单与状态机拓扑：macOS 多载体宿主、角色与全路由清单、显式 FSM、响应式、快捷键与容灾 |
| [07-engineering-config-and-assets.md](docs/design/07-engineering-config-and-assets.md) | 工程配置、跨平台接口与 Papertrails 资产管线：`nsh` Solid 适配、桌面桥接、素材同步管线与 6 档密级测试报告 |
| [08-agent-ui-guide.md](docs/design/08-agent-ui-guide.md) | AI Agent UI 开发与审查指南：载体判别、样式与状态约束及提交前核对清单 |
| [09-design-system-audit.md](docs/design/09-design-system-audit.md) | 跨载体设计系统横向差异审计：令牌错位、双源组件、手绘图形/手搓控件与静态检查缺口 |

怎么写（`style/`）：

| 文档 | 讲什么 |
|---|---|
| [module-design.md](docs/style/module-design.md) | 架构、模块边界与测试设计：责任和边界、类型驱动与进门解码、显式状态、错误契约与测试证据、检查工具 |
| [rust-async-concurrency.md](docs/style/rust-async-concurrency.md) | Rust 异步并发与网关规范：共享 Tokio 运行时、Axum 提取器、虚拟时钟、Loom 状态机内核、富内容离线程卸载与护栏 |
| [code.md](docs/style/code.md) | 代码：格式、叫法、注释写什么不写什么 |
| [nsh-tsx.md](docs/style/nsh-tsx.md) | NSH TSX 编码与响应式规范：细粒度依赖、`<If>`/`<Each>`/`<List>`、禁止解构与提前求值、输入持久化解耦、乐观发送与静态检查 |
| [naming.md](docs/style/naming.md) | 命名：名字站在领域的视角，不用的名字，文件、代码、接口、表、词典的键和测试标记的形状，改名 |
| [writing.md](docs/style/writing.md) | 文字：写什么、删什么，词和格式怎么写；文档、Issue、skill、提交说明、注释和回复都用 |

## 用语

叫法分两张表。下面这张是活本身的叫法：工作台、命令行、主助手、工具和提醒都用它，中文界面用左边一列，英文界面用 English 一列。「不用」一列只管对用户说的话：中文界面不用其中的词，英文界面不用其中的英文词，English 一列里有的照用；代码和讲服务端的文档照「代码里」一列和实际的概念来（[concepts.md](docs/concepts.md)），代码里碰到「不用」里的词，只有指的是这一行的东西才算错。带括号说明的词只在那个意思上不用，「（中文界面）」的只在中文界面不用。界面上的字写在词典里（`crates/i18n/locales`），中英各一份（[话放在哪](docs/subsystems/foundation.md#话放在哪)）；任务的状态和动作只有一套词，在 `crates/i18n/locales/*/shared.json`（[状态和用语](docs/subsystems/issue.md#状态和用语)）。农场把这些画成种地，种地的词在[第二张表](#农场的皮)，只在农场的画面和游戏里用。`vpx scripts/gen/i18n.ts check` 照「不用」一列和种地的词查皮（农场和游戏）以外的词典，`scripts/docs/glossary.ts` 查「代码里」一列的名字都还在代码里。

| 叫法 | English | 代码里 | 不用 |
|---|---|---|---|
| 主助手 | assistant | orchestrator（角色是 `orchestrator` 的档案） | 管家（指这个角色时）、manager、工头（指主助手时）、主 agent |
| 执行会话 | helper | `Session`（[concepts](docs/concepts.md#session-和-oar-会话)） | 工人、子 agent、worker、执行（指执行会话时）、帮工（中文界面） |
| 在场 | here | `Session.hired`（核心状态里雇来的会话） | 地里 |
| 一轮 | a round of work | `Run` | 一次干活、turn（指一轮时） |
| 角色 | profile | agent（`Agent`） | 帮工档案、档案（中文界面） |
| 引擎 | engine | runtime（`RuntimeInfo`） | harness、runtime（中文界面）、农机（中文界面） |
| 工单 | ticket | issue（`Issue`） | job、ticket（中文界面）、任务（中文界面，指工单时） |
| 作品 | artifact | artifact（`Artifact`，正文 `blocks`、`store` 或 `html`） | 稿子、草稿（指作品时）、产出、文档（指作品时）、doc（指作品时）、Artifact（中文界面） |
| 仓库 | repo | repo（`RepoSummary`） | 一块地 |
| 空间 | space | `SpaceState`；目录是 `work_root`（`VIBEVALLEY_WORK_ROOT`） | 世界、全图 |
| 宿主 | host | `ServerConfig.home`（`$VIBEVALLEY_HOME`） |  |
| 并发上限 | spot | `ServerConfig.repo.maxSessions`（配置 `repo.max_sessions`）、`Session.room`；每个引擎另有 `maxWorking` | 并发位、空地、空位（中文界面） |
| 角色模板 | profile template | `AgentTemplate`（`agent.template.*`） | 种子、预设 |
| 工单模板 | ticket template | issue template（`IssueTemplate`、`repo.template.list`） | seed |
| 阶段 | what it is doing | phase（`Session.phase`） | 状态（指阶段时） |
| 核心状态 | core state | `SpaceState` |  |
| VibeValley | VibeValley | 服务端、整个系统 | 农场（指系统时） |
| 事实 | fact | `Fact` | patch |
| 改动 | changes | `Changes`（`issue.diff.get`） | 差异、PR 详情、收成清单 |
| 完成 | complete | 动作 `complete`；任务挪到 `done`（已完成） | 收获、合并（指完成时：合并只是交付的一种） |
| 取消 | cancel | 动作 `close`；任务挪到 `canceled`（已取消） | 收工（指取消时：那是执行会话离开） |
| 关上 | closed | `is_closed`：`done` 或 `canceled` |  |
| 聊清楚、安排活、完成 | talk it through, get it worked, finish | 任务的 `backlog`；`todo`、`in_progress`；`in_review` 到 `done` |  |
| 验收 | review; pass, send back | `Issue.review`（`issue.review`；打回是带话挪回待办，`reject`） | 审核 |
| 验收意见 | review note | finding（`Issue.findings`） | 草（农场的皮里用） |
| 验收标准 | criteria | `Issue.criteria`、`CriterionCheck`、`CheckResult` |  |
| 问题 | question | questions（`Issue.questions`、`Question`） | 缺肥 |
| 轨迹 | trajectory | `SessionEvent`（服务端由 `Journal` 记，页面由 `Trajectory`、`WorkLog` 画） | 干活过程、日志（指轨迹时）、trace |
| 记忆 | memory | memory（`Memory`） | 记忆库、记性（中文界面） |
| 技能 | skill | skill（`Skill`） | 插件（指技能时） |
| 人设 | persona | `persona.md`、`PersonaMode` |  |
| 子代理 | subagent | subagent（Rust 的自研 agent 还没有） | 帮手（中文界面，指子代理时） |
| 待办清单 | todo | `Todo`（工具 `todo_add`、`todo_update`、`todo_list`） | 自己的任务（中文界面） |
| 父工单 | parent issue | `Issue`（有子工单） | 计划图、TaskGraph、父任务（中文界面） |
| 子工单 | child issue | `Issue`（带 `parent`、`blockedBy`；拆单输入为 `IssueChildDraft`） | Task、步骤状态机、子任务（中文界面） |
| 派活 | dispatch | hire（`Issue.hire`、事实 `FactSessionChanged`） |  |
| 派工关联 | assignment | `Assignment`（`Issue.assignments`） |  |
| 执行器 | executor | `Drivers`（角色经 oar 开会话） |  |
| 起草 | refine | refine（`refine`、`refinement_brief`） |  |
| 用户 | user | user（`User`、`userId`） | 主人、owner |
| 默认频道 | the farm chat | 默认频道（`default_channel`） | 群（指默认频道时）、田头（中文界面） |
| 私聊 | direct message | direct | 私信 |
| 和执行会话私聊 | talk | `Channel.direct`、`Session.channel` |  |
| 频道 | channel | channel（`Channel`） | 群（指频道时）、群聊 |
| 话题 | thread | thread | 子频道、串（指话题时） |
| 附件 | attachment | `Attachment`（`attachment` 表） |  |
| 媒体库 | library | `Library`（`media_library_item` 表） | 媒体（指这一页时）、素材库（中文界面） |
| 工作区 | working folder | `Worktree`（`workdir`） | 工作目录（中文界面） |
| 定时任务 | scheduled task | cron（`Cron`） | 定时（指定时任务时）、schedule（指定时任务时）、recurrence |
| 收件箱 | inbox | `InboxItem`（`InboxSlice.items`，服务是 `Inbox`） | 通知（指收件箱时）、来电（农场的皮里用）、Inbox（中文界面，指收件箱时） |
| 提醒 | notice | `Core.notice`、`NoticeLevel`（事件流里是 `LiveEventNotice`） |  |
| 通话 | call | `VoiceCall`（`voice.call.*`） |  |
| 花费 | spending | `Spent`、`RuntimeQuota` |  |

### 农场的皮

农场把上面的东西画成种地。这些词只在农场的画面（`apps/mac/src/diorama`）和游戏（`crates/server/src/game.rs`、账本、成就）里用，任务的状态、动作、拒绝、提醒、工具和主助手的话都不用；代码由 `scripts/docs/stale-names.ts` 查，词典由 `vpx scripts/gen/i18n.ts check` 查（皮的命名空间除外）。地长什么样见[农场的皮](docs/subsystems/farm.md)。

| 农场里 | English | 实际是 | 代码里 |
|---|---|---|---|
| 地 | plot | 一个任务（开 worktree 的代码任务带一个 worktree）；院里的空位是这个仓库的并发上限 | `FarmView.plots` 按任务的 id 做键（`plotKeyOf`：重开的任务还是这块地）；纸雕院落里的位置是 station，画出来的那块地在客户端叫 `Bed` |
| 种子袋 | seed bag | 待办（排队等并发上限的任务） | `todo`、`queued_at` |
| 播种袋里的种子 | seeds | 任务模板 | `IssueTemplate` |
| 播种、发芽、长叶 | sow, sprout, leafy | 处理中 | `in_progress`，执行会话 `working` |
| 开花 | flowering | 等你看 | `in_review`，执行会话 `done` |
| 缺肥（地干裂）、施肥 | dry, water | 等你回答、回答 | `questions` |
| 草、除草中 | weeds, weeding | 验收意见、带着意见再修一轮 | `findings` |
| 收获 | harvest | 完成（收之前看改动） | 动作 `complete`、`Changes` |
| 麦茬 | stubble | 已完成 | `done` |
| 仓库 | warehouse | 合进主分支或 PR 合了的任务 | `delivered`：`merged`、`pull_request` |
| 图纸桌 | issue board | 工单 | `Issue` |
| 一季庄稼 | a crop | 一轮 | `Run` |
| 地里 | in the field | 在场的执行会话 | `Session.hired` |
| 帮工 | helper | 在农场地里干活的执行会话 | `Session.hired` |
| 来电 | call | 收件箱里的一件 | `InboxItem` |
| 农机、农具 | machine, tools | 引擎 | `RuntimeInfo` |
| 田头 | the farm chat | 默认频道 | `default_channel` |
| 记性 | memory | 记忆 | `Memory` |
| 空位 | spot | 并发上限 | `ServerConfig.repo.maxSessions`、`maxWorking` |
| 技能书 | skill book | 技能 | `Skill` |
| 账本 | ledger | 值得记的事；金币、连胜、成就由它折出来 | `LedgerEntry`（家目录的 `ledger.jsonl`） |
| 成就 | achievement | 从账本折出来的里程碑 | `Achievement` |
| 等级 | level | 一共提交了多少次 | `CommitCount`、`FarmView.level` |
| 农场 | the farm | 这张皮本身（`/farm` 的纸雕农场）；说系统时是 VibeValley | |
