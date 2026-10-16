# VibeValley 文档

VibeValley 是一个用语音或打字指挥的编码 agent 团队，画成一座 QQ 农场那样的农场：你对管家说要做什么，管家把活派给帮工，帮工是真实的编码 agent，在这台机器上的项目里改代码、跑测试、提交，地里的庄稼跟着它们的真实进度长。你、管家和帮工在同一个群聊「田头」里说话，每件活下面挂着它的工单串。说到底它是一个跑在本机的小 Raft（人和 agent 在群聊里一起干活），外面包了一层游戏的壳。服务端用 Go 写，客户端是 Flutter。

这里只放文档：现在怎么用、怎么开发、东西是怎么工作的。为什么这样设计、放弃了什么、还没做的提案，在 [Agent Notes](../.agents/notes/README.md)。

## 教程

照着做就能走到一个结果。

| 文档 | 走到哪 |
|---|---|
| [guide.md](guide.md) | 使用指南：派第一张工单，看着它干，收获，处理冲突和失败，管住花费，用语音 |
| [development.md](development.md) | 开发：在本机跑起来，检查和测试，改 protocol 和规则，打包 macOS 应用 |

## 参考

查一个子系统现在的行为和约定。

| 文档 | 讲什么 |
|---|---|
| [concepts.md](concepts.md) | 概念：工单、执行、项目、群聊……实际是什么，农场怎么画它们，代码里还没对齐的地方 |
| [architecture.md](architecture.md) | 架构：分层和目录、核心状态和事实、工地事件、HTTP 接口、存了什么、环境变量。改 `server/`、`app/` 之前读 |
| [server.md](server.md) | 服务端（Go）：服务、管家、帮工、田头、项目和收获、额度和花费、同时干活的上限、重启、搬家 |
| [agents-and-runtimes.md](agents-and-runtimes.md) | 帮工档案和农机：农具房、捏帮工、技能书、派给谁 |
| [game-ui.md](game-ui.md) | 农场界面和玩法：角色、地里长什么、工具、每个界面、精力瓶、计分和成就 |
| [framework.md](framework.md) | 像素村、素材和音效：首页、像素村的画面和光、寻路、合成音效、素材流水线 |
| [voice.md](voice.md) | 语音：和管家说话（Agora ConvoAI），Flutter 客户端 |
| [desktop.md](desktop.md) | macOS 应用（Flutter）：服务端在里面、菜单栏、通知、语音快捷键、渠道、安装 |

## 文档之外

| 在哪 | 是什么 |
|---|---|
| [Agent Notes](../.agents/notes/README.md)（`.agents/notes/`） | 决策和提案；`proposed/` 是还没做的 |
| 根目录 [AGENTS.md](../AGENTS.md)（`CLAUDE.md` 指向它） | 给 agent 的常驻规矩 |
| [docs/AGENTS.md](AGENTS.md) | 文档放在哪、怎么写 |
| 各包的 README | 这个包的对外约定：[server](../server/README.md)、[app](../app/README.md) |

## 用语

界面用农场的叫法；代码、接口和讲服务端的文档按实际的概念来（[concepts.md](concepts.md)），提到时可以注上农场的叫法。下表对照界面上的叫法和代码里的名字，代码里有一些是工地版留下来的。界面上的字用左边一列，不用最右一列。

| 叫法 | 代码里 | 意思 | 不用 |
|---|---|---|---|
| 管家 | foreman（`server/internal/manager/foreman.go`） | 你唯一直接说话的 agent：服务端里 VibeValley 自己的 agent，带派活的工具 | 工头、主 agent、orchestrator |
| 帮工 | helper（`Helper`）；老代码里也叫 worker | 管家派出去的一个编码 session，即 smith（oar 的 Go 移植）的一个子 agent | 工人、子 agent |
| 帮工档案 | agent（`AgentProfile`） | 一份配置：用哪个 runtime 和模型、人设、技能、在农场里是哪种小动物。派活派的是档案，派出去的是帮工 | 角色、profile |
| 农机 | runtime | 机器上的一种编码 agent 程序（pi、claude、codex……），由 smith 发现和驱动；配置在「农具房」 | harness、引擎 |
| 工单 | task；一张工单的全过程是一条轨迹（`TrajectoryHead`） | 交给帮工的一段任务文字；也指它从播种、一轮一轮做，到收获或收工的全过程（「工单」页） | job、ticket |
| 项目 | project | 工作目录（`VIBEVALLEY_WORK_ROOT`）下的一个文件夹，都是 git 仓库 | |
| 地、田地 | station、bed | 帮工干活的位置；6 块，也是同时干活的上限 | 工位 |
| 阶段 | phase（`Phase`） | 帮工在生命周期里的位置：到场、干活、成熟、失败、歇着 | 状态（state） |
| 核心状态 | `FarmState` | 农场上的一切，一个值；只有服务端持有，Flutter 读它折好的 | |
| 事实 | fact（`Fact`） | 改核心状态的一件事：雇了谁、开始一轮、跑了一条命令、这一轮结束…… | 增量、patch |
| 工地事件 | site event（`SiteEvent`） | 服务端经 `/api/site/events` 推的一条消息：快照、事实，以及几样不属于核心状态的（干活过程、提醒、runtime 变化） | 日志、推送 |
| 收获 | harvest | 把帮工的分支合进项目主分支，然后它收工 | |
| 账本 | ledger（`LedgerEntry`） | 服务端记下的值得记的事（活收进主分支、一轮没做成、带了话……），金币、连胜和成就都由它折出来 | 计数器、事件日志 |
| 轨迹、干活过程 | trajectory（`Trajectory`，一步是 `WorkStep`） | 一个 agent 干活的每一步：收到的话、说的话、每次工具调用的输入和输出、重试、问题。每个帮工从接活起一份，收工后步骤留 30 天，它是谁、干了什么（工单）一直留着；管家一份，一直留着 | 日志、trace |
| 记性 | memory（`Memory`） | 一个帮工档案记得的事：帮工在汇报里写的「记住：」、主人替它记的、它的帮工做过的活；每一轮开头想起有关的几条 | 记忆库 |
| 新手任务 | starter（成就的一类） | 第一次在农场上做的几件事：开工、派活、带话、验收、说话、规划、点名 | 教程 |
| 称号 | title | 挂在农场卡上的一个成就档位 | 头衔 |
| 种植计划 | playbook（`Playbook`） | 一件长活拆成的一张图：每步一个帮工，有先后；每步做完合进计划分支，最后整个收获 | 工作流、DAG |
| 步骤 | node（`PlaybookNode`） | 种植计划里的一步：一张工单，带要等的步骤 | 节点 |
| 验收步骤 | acceptance（`PlaybookNode.acceptance`） | 计划里先做的一步，写现在会失败的测试；合进去后冻结，后面的步骤不能改，最后一步要让它通过（新手任务的「验收」是主人看收成清单，不是它） | 测试步骤 |
| 计划分支 | playbook branch | 计划开工时开的分支（`vibevalley/pb-…`），每步做完合进它，收获时它合进主分支 | |
| 通话 | call | 一次开工：从开工到收工；语音时也是一次 Agora 频道会话 | |
| 语音管家 | voice agent | Agora ConvoAI 在频道里启动的那个实例，只负责听和说 | |
| 主人 | user | 你 | 用户（文档里可以用） |
| 田头 | square（`Conversation` 的 `kind: 'square'`） | 农场的群聊：你、管家和地里的帮工都在里面 | 频道、群 |
| 工单串 | job thread（`subjectKind: 'job'` 的 thread） | 派一件活时，挂在田头那条派活消息下面的话题串；这件活的话都在里面 | 子频道 |
| 串 | thread | 挂在田头一条消息下面的话题串，地址写成 `#田头:<消息号>` | |
| @ 名 | mention | 在田头叫一个人：帮工用它的 id（`@w3`），还有 `@管家`、`@主人`、`@所有人` | |
| 院门 | lan（`server/internal/channels/lan.go`） | 让局域网里的手机、另一台电脑用这个农场的那个监听：默认关着，只放主人点过头的设备 | 局域网访问、远程模式 |
| 叫醒 | wake | 一条消息给一个歇着的帮工开新一轮；忙着的只收到一句提示 | |
