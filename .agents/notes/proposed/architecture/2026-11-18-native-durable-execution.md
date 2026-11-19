# Agent Note: 在原生版复刻 Chord、持久执行、oar 和 Web 农场

Status: proposed

## Problem

计划以原生 macOS 工作台 `refactor/native-vibevalley@275732ef1` 为开发基线，以 `perf/platform-simplification@a2c1851ab` 的 Go 实现为行为参照。前者已有 GPUI 工作区、独立 PTY、文件与 Git 面板、工单和原生农场。后者最先值得带过来的能力是：用户回应一次，服务重启或重投后仍能查到同一次执行及其结果。两条分支的契约、宿主和存储结构已分化，应按用户可观察的行为逐项验证。[原生总体计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)

## Proposal

### 交付范围

四项均以 Go/Web 的 `a2c1851ab` 为核对版本。优先级只决定实施顺序。视觉基准是该提交实际运行的完整 Web 农场，包括世界画布与叠在上面的界面。

| 交付项 | 基线与验收范围 |
| --- | --- |
| Chord | `pkg/chord/{delta,watch,link,ws}` 的严格 JSON、不可变快照、增量合并、历史与慢订阅者、退休与重建、身份握手、双向 RPC、取消、心跳、分块、重连和 WebSocket。以 Go 与 Rust 双向收发、断线续订和生产消费状态为证。 |
| durable | `internal/durable` 及其 store 的事务、提交去重、阶段迁移、信号、睡眠、子任务、取消、恢复、断路、模型生成、工具权限、预算、压缩、代码执行和结果评估。沿真实助手与帮工入口核对故障前后同一轮的结果。涉及 pi agent 的对话或工具语义时，核对所参考版本及对应测试。 |
| oar | `pkg/oar` 的注册表、各驱动、会话控制、模型与用量、子 agent 路径、事件记录和离线回放。逐驱动核对注册、能力声明、启动、运行、插话、取消、恢复和清理，补齐生产选用入口。 |
| 完整农场 | 逐一核对 `apps/web/src/farm`：仓库群岛与院子、日夜与帮工、工具栏、悬停与命中、播种、工单与收获、仓库与成就、手机来电、聊天、小游戏、快捷键与窄窗。固定状态、时刻、窗口与 DPR，在真实的 Web 和 GPUI 窗口截图，对照图像和交互回执。 |

画面先用 1280×800、中文、同一字体与昼夜时刻建立基线，再覆盖窄窗。初始比较门槛为整图与各命名区域 SSIM ≥ 0.985、RGB 最大通道差超过 12 的像素 ≤ 2%、边缘 F1 ≥ 0.97（容差 1 个逻辑像素）；32×32 逻辑像素窗口以 16 为步长，每块中 RGB 最大通道差超过 12 的像素 ≤ 8%。先重复采样固定画面以测量动态噪声。

### 一张工单经过哪些模块

| 环节 | Rust 已实现的职责 | 新版应守住的边界 |
| --- | --- | --- |
| 派活、排队、建目录 | 助手经工具派单，频道追加消息可经观察层送给帮工。工单板按全局和仓库余量、前置工单决定派发；默认并发上限分别为 6 和 3。此基线的 `Board::hire` 对有仓库的工单取基线分支并开 worktree，无仓库则开工单上下文目录。[工单板](crates/vibevalley-server/src/modules/issue/board.rs) | 工单保存交付目标，帮工会话保存实际工作目录，农场右击和用户终端沿用这个目录。终端 shell 与编码 agent 分别持有自己的进程。 |
| 启动编码 agent | 档案解析出农机、模型、人设、工具等选项。会话模块向 oar 的 `Runtime::open` 传入工作目录、恢复 ID 和记录路径，然后通过 `Session` 发起轮次、收事件、插话、排队或中断。Claude 使用 stream-json，Codex 使用 app-server，ACP 按协商能力恢复或加载会话，内置农机使用自己的对话循环。[农机接口](crates/vibevalley-oar/src/lib.rs) · [会话装配](crates/vibevalley-server/src/modules/session/sessions.rs) | oar 统一农机协议。具体农机是否能恢复、是否接受插话，由驱动声明并以实际调用结果为准。工单的调度、验收和交付仍由服务端决定。 |
| 看见进度、收到报告 | 事件带序号、工具调用 ID 或子 agent 路径。会话按当前运行实例筛除旧事件，轨迹合并文本增量及工具调用的开始与结果；根 agent 的轮末事件结合结构化汇报、提问和输出产生工单与会话事实。核心投影决定木牌、作物和可用动作。[轨迹](crates/vibevalley-server/src/modules/session/journal.rs) · [农场投影](crates/vibevalley-core/src/game.rs) | 工单 ID、业务会话 ID、轮次 ID 和厂商会话 ID 分开记录。原始 JSONL 可复核农机事件，SQLite 的轮次记录回答「为什么启动、结果怎样」，任一视图都可追到实际 worktree。 |
| 续跑与交付 | 重开工单板会识别中断轮次。追加一轮时优先复用在线会话，离线时按能力和已保存的厂商 ID 恢复，否则以工单简报重新开始。交付再检查改动、验证命令和合并冲突。内置助手另有未完对话的恢复入口。[助手](crates/vibevalley-server/src/modules/orchestrator/mod.rs) · [交付](crates/vibevalley-server/src/modules/workplace/mod.rs) | 「收到轮末报告」「工单待验收」「改动已合入」应有各自可查的记录。外部命令结果未知时，先查 worktree 和轨迹再决定下一步。 |

### 从 Go 带哪些行为

以下 Go 路径均取自 `a2c1851ab`，可在本地用 `git show a2c1851ab:internal/durable/scheduler.go` 等命令复核。

| 优先级 | 两端已有的证据 | 原生版交付条件 |
| --- | --- | --- |
| 1．执行请求去重与结算 | Rust 的频道表对发送者和 `send_key` 有唯一索引；工单轮次另行写入。Go 的 `internal/durable/store/store_test.go` 覆盖同一对话与请求 ID 跨重启返回同一提交，以及提交结算与通知同事务写入。 | 先从工单串追问这一条真实入口查重投。让原消息、执行请求和业务轮次可以对账；重启后重复提交返回原结果，结算与待投递通知一起持久化。复用现有消息 ID、轮次和账本，按实测缺口补字段或事务。 |
| 2．等待、唤醒与中断 | Go 的 `Scheduler` 可缓存早到信号，等待时释放执行名额，重启扫描未结束任务；还有重启次数上限及先子后父的取消。Rust 已能恢复未完的内置对话，对已启动且不宜重放的工具返回中断结果。[内置对话](crates/vibevalley-agent/src/conversation.rs) | 把一个真实等待点接上，优先选等用户回答。分别检验先回答后进入等待、等待中重启、重复回答。已有业务轮次结算后才开后续轮次。仅在实际使用子任务的路径验证级联取消。 |
| 3．oar 驱动回放 | Rust 已有协议解析、脚本农机、厂商样本及离线测试。Go 的 `pkg/oar/replaytest` 用模拟 CLI 经驱动入口回放，`pkg/oar/registry.go` 可核对各驱动支持范围。[Rust 驱动样本](crates/vibevalley-oar/tests/fixtures) | 先在两端对照 Claude 与 Codex 的启动、工具调用、提问、中断、恢复及异常退出。核对同一调用的起止、事件顺序和轮末结果；再按实际需要补农机。服务端再用脚本农机验证从事件到工单和农场的映射。 |
| 4．执行治理 | Go 的 `internal/durable/governance_test.go` 另测预算暂停与上调续跑、上下文压缩和工具策略。Rust 已有额度探测、日预算与对话压缩，粒度和触发时机需逐项比较。 | 首条执行链稳定后按 Go 测例逐项实现和验收；远程机器、手机宿主和三维渲染有各自的产品范围与验收方式。 |

### Chord 的业务方法

Go 提交 `a2c1851ab` 的 `internal/domain/stack/link_server.go` 注册 16 个方法。原生版已注册 `health.ping`、`space.snapshot`、`issue.list`、`approval.resolve`、`budget.raise`。下表列出其余 11 个方法。原生版现已接入其中的频道读取。[原生注册表](crates/vibevalley-http/src/chord.rs)

| Go 方法 | 请求与返回 | 原生入口或缺口 |
| --- | --- | --- |
| `channel.events` | 频道 ID、起始序号、条数 → `ChannelEventView[]` | 已接入。按频道消息号升序读取正文和帮工报告。旧客户端可按序号续读。编辑、删除和表情沿用[原生频道语义](docs/subsystems/channel.md#chord-读取频道)。 |
| `channel.post` | `AppendRequest` → 社交事件与观察层派单结果 | `Chat::say` 与 `Chat::post` 可写消息。Go 还接收提问、表情和角色，并返回本次观察层唤醒的记录。 |
| `issue.create` | 工单、是否派单 → 工单，派单时附回执 | 工单板支持建单和派活。需核对调用方指定的工单 ID、Go 的工单状态以及派单回执。 |
| `issue.queue` | 工单 ID → 工单与派单回执 | `issue.status.update` 可派活。Go 回执含提交 ID、对话 ID、会话 ID 和去重结果。 |
| `pkm.search` | 文本、向量、范围和排序参数 → 页面命中列表 | `pkm.search` 的原生接口按块返回结果。Go 按页返回全文与向量的名次、摘要和反链数。 |
| `pkm.backlinks` | 目标页或路径 → 反链列表 | 原生页面返回分组的反链块。Go 需要每处引用在源文件的行号及起止字节。 |
| `memory.dream.run` | 范围 ID、会话摘要 → 待审提案 | 原生记忆库记录笔记和每轮结果。缺带基础版本与候选版本的归并提案。 |
| `memory.dream.approve` | 提案 ID → 已采纳提案 | 缺采纳提案并原子切换记忆版本的领域入口。 |
| `memory.dream.rollback` | 提案 ID → 已撤回提案 | 缺按版本撤回提案和恢复记忆内容的领域入口。 |
| `artifact.publish` | 交付物信息、网页源码包或 HTML → 交付物、版本、卡片与去重结果 | 原生 Artifact 可保存和发布 HTML 版本。Go 还编译源码包并返回编译耗时。 |
| `vault.token.issue` | 主体、会话、权限、主机、密钥范围、有效期 → 限权令牌 | 原生 MCP 会话令牌用于调用帮工工具。Go 出站令牌需约束可访问的主机和可取用的密钥。 |

频道回归通过真实 WebSocket 检查跨频道隔离、缺失频道、非法游标、删除正文和报告的会话号。Go 客户端从 Rust 命令行写入的两条消息逐页读取，末页返回空数组。[频道回归](crates/vibevalley-server/tests/channel.rs) · [Go 客户端验收](crates/vibevalley-chord/tests/interop/product.go)

### 外部驱动验收覆盖

Go 基线的八个默认驱动均在 Rust 注册。下表的「模拟 CLI」指驱动启动本地进程，经标准输入输出执行完整开轮。控制回执确认命令已受理，是否完成还以轮末事件为准。「通用队列」已用测试农机核对先后、撤回和重开，厂商列单列各自的证据。[八驱动回放](crates/vibevalley-oar/tests/go_drivers.rs) · [队列与清理回归](crates/vibevalley-oar/tests/lifecycle.rs)

| 驱动 | 开轮与控制回执 | 插话 / 排队 | 取消 | 恢复 | 工具类别与用量样本 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 真实 2.1.322 配回环模型，首轮返回原文并完成。 | 支持插话，使用通用队列。 | 真实 CLI 收到取消后以 `Aborted` 结束。 | 模拟 CLI 续接厂商会话并读取用量基线。 | 采集样本含工具申请、读写和子任务。回环模型报告输入 17、输出 3。 |
| Codex | 真实 0.170.0 的协作通知经驱动回放。模拟 CLI 另核对开轮回执。 | `turn/steer` 插话。模拟 CLI 覆盖压缩期间排队。 | 有 `turn/interrupt` 入口。 | 模拟 CLI 覆盖有基线和缺基线两种续接。 | 样本包含命令、文件、MCP、等待和子线程。Go 对照样本根轮输入 150、输出 55。 |
| OpenCode | 本机 CLI 的 ACP 握手成功，模拟 CLI 完成一轮。 | 支持 `session/steer`，使用通用队列。 | 实现 `session/cancel`。 | 按协商能力选 resume 或 load。 | 共用 ACP 工具投影。模拟样本输入 650、输出 155。 |
| Grok | 本机 CLI 的 ACP 握手成功，模拟 CLI 完成一轮。 | 支持 `session/steer`，使用通用队列。 | 实现 `session/cancel`。 | 模拟 CLI 续接，缺少历史基线时保持未知。 | 650 / 155 来自共用 ACP 样本，厂商独有工具尚待核对。 |
| Kimi | 本机 CLI 的 ACP 握手成功，模拟 CLI 完成一轮。 | 拒绝插话，可排队。 | 实现 `session/cancel`。 | 按协商能力选 resume 或 load。 | 650 / 155 来自共用 ACP 样本，厂商独有工具尚待核对。 |
| CodeBuddy | 模拟 CLI 完成开轮及回执。本机 PATH 未找到厂商程序。 | 拒绝插话，可排队。 | 实现 `session/cancel`。 | 按协商能力选 resume 或 load。 | 650 / 155 来自共用 ACP 样本。 |
| Qwen Code | 模拟 SDK 进程完成 initialize 和开轮，真实本机服务端派单成功。 | 拒绝插话，可排队。 | 实现 stream-json interrupt。 | 驱动接收厂商会话 ID，启动参数支持 `--resume`。 | 真实服务端接模拟 CLI，输入 30、输出 12。重开后工单保留 42 token。 |
| Qoder | 模拟 SDK 进程完成开轮，真实本机服务端派单成功。 | 拒绝插话，可排队。 | 实现 stream-json interrupt。 | 驱动接收厂商会话 ID，启动参数支持 `--resume`。 | SDK 有工具事件通路。样本缺 token，重开后工单仍省略用量。 |

Rust 另外注册 Gemini ACP、内置农机和脚本农机。Gemini 的本机 ACP 握手成功。真实厂商的计费、配额和跨版本账号恢复仍需单独验收。OpenCode、Grok、Kimi 和 CodeBuddy 的通用样本不能证明四家分别接受插话或取消。Qwen、Qoder 本机缺少厂商程序，真实工具类别和续接后的上下文仍待核对。[ACP 驱动](crates/vibevalley-oar/src/acp.rs) · [SDK 回放](crates/vibevalley-oar/tests/sdk_replay.rs) · [Codex 采集样本](crates/vibevalley-oar/tests/fixtures/codex-0.170.0-collaboration.json)

### 第一项实现怎样取证

在隔离目录启动真实 Rust 服务，给临时 Git 仓库派一张工单，脚本农机在 worktree 写文件、提问，用户从原工单串回复。将故障分别放在「消息已保存、轮次尚未登记」和「轮次已结算、结果尚未投递」之间；重启后重送同一条回复。记录请求标识、工单、会话、轮次、汇报条数和 Git 变更。先把当前实现的结果跑出来，再补缺失的持久化边界。已有离线主线覆盖派活、MCP 汇报、追问、合并、定时派单和正常重开，可直接复用其项目与断言。[已有主线测试](crates/vibevalley-server/tests/mainline.rs)

### 持久执行的分层验收

Go 基线为 `a2c1851ab`。在该提交运行 `CGO_ENABLED=0 go test -count=1 ./internal/durable/...`，调度、治理、CodeMode 和存储测试均通过。下表分别记录 Rust 底层行为和能从产品入口观察到的结果。模型回应用离线替身，SQLite、服务、工具、Git 和驱动使用实际实现。

| 范围 | Go 对照与 Rust 底层 | Rust 产品入口与证据边界 |
| --- | --- | --- |
| 任务树、睡眠、早到信号 | Go `scheduler_test.go` 对照 Rust 三种子任务等待方式。Rust 回放覆盖先到的唤醒、定时醒来、休眠让出执行名额。[调度器测试](crates/vibevalley-durable/tests/parity.rs) | 助手和内置帮工用同一个生成调度器。助手审批等待可实际唤醒。厂商自建的子线程有自己的生命周期，不能用这组测试证明 Codex 子线程已经终止。 |
| 级联取消、崩溃断路 | Go 与 Rust 均测试先取消子任务再取消父任务。Rust 检验重启上限、单条告警、取消后迟到的完成事件。[调度器](crates/vibevalley-durable/src/scheduler.rs) | 停止助手和中断内置帮工会调用调度器。内置帮工经过进程退出后能恢复同一工单轮次。实际厂商请求何时停止计费仍需厂商侧证据。[内置帮工恢复](crates/vibevalley-server/tests/orchestrator.rs) |
| 模型生成、工具治理 | Go `governance_test.go` 与 Rust 均覆盖拒绝、停等确认和恢复。Rust 还验证已启动的副作用工具在恢复时保留中断结果。[生成阶段](crates/vibevalley-agent/src/generation/mod.rs) | 真实服务上的助手调用工具建单。经 Chord 审批后，重开仍只看到一张工单。内置帮工在工作目录执行命令后发生进程退出，恢复后的文件只含一次写入。[助手与帮工入口测试](crates/vibevalley-server/tests/orchestrator.rs) |
| 预算 | Go 与 Rust 均在新模型调用前检查上限。Rust 回放覆盖完成在途工具、暂停、上调后唤醒及评审前暂停。[治理](crates/vibevalley-agent/src/generation/governance.rs) | Chord 暴露 `budget.raise`。服务测试覆盖额度更新回执。暂停评审、重启再上调的证据来自生成引擎，厂商账单另行核对。 |
| 压缩 | Go 有手工、软阈值、硬阈值和溢出四级。Rust 生成阶段调用阈值检查。测试覆盖过期软压缩结果和一次溢出重试。[转写与压缩](crates/vibevalley-agent/src/generation/transcript.rs) | 助手和内置帮工共用生成路径。手工级别存在于压缩器。原生界面触发手工压缩以及真实模型触达各阈值仍待验。 |
| CodeMode | Go 使用 Goja。Rust 使用 QuickJS。回放核对随机数、时钟、工具异常、执行限额及重启跳过已完成的调用。[代码回放](crates/vibevalley-durable-codemode/tests/parity.rs) | 生成引擎注册 CodeMode 和工具阶段。现有证据来自调度器创建脚本任务，普通助手或帮工对话创建这类任务的入口仍待验。 |
| 结果评估 | Go 可按验收标准单独评审并要求修正。`stack.go` 默认装配直接通过的 grader，模型评审需要相应装配。Rust 单独保存只读评审会话及判定。[评审](crates/vibevalley-agent/src/generation/grading.rs) | HTTP 派给内置帮工的带条件工单已验证拒绝后修正、次数耗尽和提问停等。评审只读当前工单证据。外部农机和通用助手对话沿用各自结算入口。[工单回归](crates/vibevalley-server/tests/orchestrator/grading.rs) |

## Alternatives considered

**从 Go 分支重建原生壳。** 工作区、文件监视、差异块操作、PTY 生命周期和窗口导航已在 Rust 端接通。对照执行行为的迁移可以把改动限制在服务端和测试，避免重新实现这些桌面能力。

**整套移植 Go 调度器。** Rust 的助手对话、外部农机会话和工单队列各自已有恢复语义。先补具体请求的事务和测试，可以避免同一轮工作同时被工单板和通用调度器认领。

## Acceptance criteria

- 重送同一条追问并经历服务重启后，可查到同一执行请求及一次对应的业务轮次；不同请求仍可正常开启下一轮。工单串只收到一次该轮汇报。
- 内置对话恢复时，已启动但结果未知的有副作用工具不会自动重复执行；外部农机是否续接以其能力及厂商会话 ID 为据。界面可区分继续旧会话、带简报重开和需要用户处理三种结果。
- 核对重复唤醒、取消后抵达的旧事件、恢复失败的轮次。工单状态、会话轨迹与农场木牌一致，同一份变更只交付一次。
- 以真实进程中断检验崩溃窗口；以脚本农机和模拟 CLI 做确定性回归，分别标注真实厂商客户端是否另行验证。

## Risks

SQLite 提交与外部命令执行之间存在崩溃窗口。命令已写文件或提交 Git、工具结果尚未记账时，数据库去重只能约束任务和通知。新版应保留调用 ID、已启动记录、恢复原因及可核对的磁盘证据，由对应工具声明是否可以安全重放。[Rust 的副作用中断回归](crates/vibevalley-agent/src/tests.rs)
