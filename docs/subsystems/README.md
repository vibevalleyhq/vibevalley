# 子系统

一个子系统一篇，从架构的角度写它沉淀下来的样子：管什么、不管什么，在哪，模型和不变量，一件事怎么走，和谁打交道，为什么这样、放弃了哪些路。计划和正在做的事在 [Agent Notes](.agents/notes/README.md)；做完的计划把仍然成立的部分写进这里，计划本身删掉。

| 子系统 | 管什么 |
|---|---|
| [工单](docs/subsystems/issue.md) | 一块地：工单的模型、状态和派活、验收、收获 |
| [帮工](docs/subsystems/session.md) | Session 和 Run、规矩和汇报、事件日志、额度和上限 |
| [项目](docs/subsystems/project.md) | 工作目录、worktree、检查、GitHub 检测、地契 |
| [田头](docs/subsystems/channel.md) | 频道、谁听见、工单串、连接器 |
| [通知](docs/subsystems/notice.md) | Inbox、刚来的、巡查，经通话、手机、系统通知送到主人 |
| [管家](docs/subsystems/orchestrator.md) | 自己的 agent、提示和工具、来源、评测 |
| [定时](docs/subsystems/recurrence.md) | 一张工单的触发：间隔和 cron、补跑、回头看 |
| [种植计划](docs/subsystems/task.md) | 带子工单的父工单、按图推进；agent 自己的任务图 |
| [记性](docs/subsystems/memory.md) | 想起、记下、主动查、外面的来源 |
| [文档](docs/subsystems/doc.md) | 按块存、按 op 改的文档：块和顺序键、一批一个事务、Markdown |
| [语音](docs/subsystems/voice.md) | 通话（Agora ConvoAI）、听写、语音管家 |
| [连接到本机](docs/subsystems/lan.md) | 局域网里配对过的设备用同一个农场 |
| [设置](docs/subsystems/setting.md) | settings.json、配置和环境变量、钥匙和打码 |
| [游戏](docs/subsystems/game.md) | 账本、金币和成就、等级、空地和特效 |
| [核心状态](docs/subsystems/core.md) | 一份状态只因事实而变、三条流、接口和能力表、重启 |
| [地基](docs/subsystems/foundation.md) | 一个仓库、一块业务一个服务、Effect 的 layer、形状和规则、effect-sqlc、表结构、测试 |
| [客户端](docs/subsystems/app.md) | 一份 Solid 页面、问服务端、宿主接口、Electron 的桌面版和打包 |
| [农场的皮](docs/subsystems/farm.md) | 像素村、地里长什么、走路、手机、音效、图鉴 |
| [档案和农机](docs/subsystems/agent.md) | 帮工档案、种子、农机的探测和清单、技能书 |
| [工程流程](docs/subsystems/process.md) | 文档分层、Note 和子系统、docs:verify、skill、写作规范、素材流水线、名字 |
| [官网](docs/subsystems/site.md) | vibevalley.dev：Astro、island、图从游戏来、没脚本也完整 |

查的东西（界面清单、能力表、概念在各层的名字、农机和档案）在 [reference/](docs/README.md)。

## 一篇怎么写

照这个顺序，用不上的节不写：

1. **一句话**：它是什么，农场里画成什么。
2. **管什么，不管什么**：边界，不管的指到负责的子系统。
3. **在哪**：包、表、接口、客户端的位置。不抄字段和接口清单，链接到代码或生成的 [capabilities.md](docs/reference/capabilities.md)。
4. **模型和不变量**：它的核心概念，和任何时候都要成立的几条。
5. **怎么走**：主要的流程或状态机。
6. **和谁打交道**：依赖谁、谁依赖它、经什么（事实、事件、服务的方法）。
7. **为什么这样**：每个关键的决定一条，写决定和放弃的路，不写过程和日期。
8. **还没做的**：链接到提案。
9. **怎么验证**：哪些测试证明它。
