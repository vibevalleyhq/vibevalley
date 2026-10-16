# VibeValley 文档

VibeValley 是 AI 版的 [Linear](https://linear.app)，穿着像素农场的皮（[概念](concepts.md)）。这里写现在怎么用、怎么开发、东西怎么工作；为什么这样设计和还没做的提案在 [Agent Notes](../.agents/notes/README.md)，文档放在哪见 [AGENTS.md](AGENTS.md)。

先读：

| 文档 | 讲什么 |
|---|---|
| [guide.md](guide.md) | 教程：派第一张工单，看着它干，收获，处理冲突和失败，管住花费，用语音 |
| [development.md](development.md) | 教程：本机跑起来，检查和测试，改形状、规则和表，打包 |
| [concepts.md](concepts.md) | 概念：实际是什么，农场怎么画它们 |
| [architecture.md](architecture.md) | 架构：分层、核心状态、工地事件、接口、存储、环境变量。改 `server/`、`app/` 之前读 |

各部分现在怎么工作（`reference/`）：

| 文档 | 讲什么 |
|---|---|
| [server.md](reference/server.md) | 服务端的各个服务 |
| [agents-and-runtimes.md](reference/agents-and-runtimes.md) | 帮工档案、农机、技能书 |
| [farm-ui.md](reference/farm-ui.md) | 农场界面和玩法 |
| [pixel-village.md](reference/pixel-village.md) | 像素村、素材和音效 |
| [voice.md](reference/voice.md) | 语音（Agora ConvoAI） |
| [desktop.md](reference/desktop.md) | macOS 应用 |

怎么写（`style/`）：

| 文档 | 讲什么 |
|---|---|
| [code.md](style/code.md) | 代码：格式、叫法、注释写什么不写什么 |
| [writing.md](style/writing.md) | 文字：文档、Note、提交说明和注释的句子怎么写 |

## 用语

界面用农场的叫法，代码和讲服务端的文档按实际的概念来（[concepts.md](concepts.md)）。界面上的字用左边一列，不用最右一列。

| 叫法 | 代码里 | 意思 | 不用 |
|---|---|---|---|
| 管家 | foreman | 你直接说话的 agent，替你派活 | 工头、主 agent |
| 帮工 | helper；接口里叫 worker | 一次执行：为一张工单开的一个编码会话 | 工人、子 agent |
| 帮工档案 | agent（`AgentProfile`） | 一份配置：农机、模型、人设、技能、哪种小动物 | 角色、profile |
| 农机 | runtime | 机器上的一种编码 agent 程序（pi、claude、codex……） | harness、引擎 |
| 工单 | issue（`Issue`） | 一件活，从写下到关上一个 id；每派一次是一次执行 | job、ticket |
| 项目 | project | `VIBEVALLEY_WORK_ROOT` 下的一个 git 仓库 | |
| 地 | station、bed | 帮工干活的位置，也是同时干活的上限 | 工位 |
| 阶段 | phase | 到场、干活、成熟、失败、歇着 | 状态 |
| 核心状态 | `FarmState` | 农场上的一切，只有服务端持有 | |
| 事实 | fact | 改核心状态的一件事 | patch |
| 收获 | harvest | 把帮工的分支合进主分支，工单关上 | |
| 仓库 | warehouse | 收获了的工单 | |
| 账本 | ledger | 值得记的事；金币、连胜、成就由它折出来 | 事件日志 |
| 轨迹 | trajectory | 一个 agent 干活的每一步 | 日志、trace |
| 记性 | memory | 一个帮工档案记得的事 | 记忆库 |
| 种植计划 | playbook（带 `plan` 的父工单） | 一件长活拆成的有先后的子工单 | 工作流、DAG |
| 步骤 | node（带 `step` 的子工单） | 种植计划里的一步 | 节点 |
| 主人 | user | 你 | |
| 田头 | square | 默认的频道：你、管家和帮工都在 | 群 |
| 频道 | channel | 另开的说话的地方；微信、飞书、QQ 各接一个 | 群 |
| 串 | thread | 挂在一条消息下面的话题串；派活时开的叫工单串 | 子频道 |
| 定时 | schedule | 到点对管家说一句话，或写一张新工单 | cron |
| 来电 | inbox | 要你处理的事 | 通知 |
| 巡查 | heartbeat | 定时看 Inbox，放久了叫醒管家 | |
| 院门 | lan | 让局域网里的设备用这个农场的监听，默认关 | 远程模式 |
