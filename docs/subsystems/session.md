# 帮工

帮工与执行层协作完成「一个档案（`Agent`）干一件活」的全部流程：触发与投递调度、会话（`Session`）生命周期与每一轮（`Run`）、工作目录交接、`cmd/vibe-machine` 机器执行器以及进程内宿主编排。
- 处理工单时画成地里的小动物，处理私聊或助手编排时关联频道；外部编码代理经 Go 原生 `pkg/oar/` 协议驱动，内部助手与托管会话经 `internal/durable/` 与 `internal/domain/stack/` 驱动。
- 一次触发到一次汇报是一轮 `Run`；一个 `Session` 可跨越多次 `Run` 与重启。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 来源事件幂等记成不可变的 `Trigger`（`internal/domain/watch`），轻量控制头和原始载荷分开 | 频道、串、消息的存储（[频道](docs/subsystems/channel.md)）；GitHub PR 的分页快照（[仓库](docs/subsystems/repo.md)） |
| 按上层定下的收件会话写投递、优先级与叫醒，熔断时拦住叫醒，上层说还不能交的输入先暂缓 | 谁听见一句话、三道刹车（[观察层](docs/subsystems/watch.md)）；一句话是不是工单的、工单蓄水池、状态机、合并和交付（[工单](docs/subsystems/issue.md#蓄水池和路由)） |
| `Session` 的创建、恢复、带话、叫停、交接与离场；工作目录的开、借、清 | git worktree、分支与合并的实现（[仓库](docs/subsystems/repo.md)） |
| 外部执行与机器管理（`internal/machine/`、`cmd/vibe-machine/`）：沙箱环境变量、命令执行与节点租约 | 农机安装探测、模型列表与档案校验（[档案和农机](docs/subsystems/agent.md)） |
| 轨迹日志与轮次结算；事件转核心状态投影与实时流推送 | 记忆的存储与检索算法（[记性](docs/subsystems/memory.md)） |
| 并发槽位上限、腾位置与每日花费记账 | 助手的编排提示词与工具集（[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `internal/domain/stack/dispatch.go`、`stack.go`、`machine_hub.go` | 会话派活编排、机器执行调度、工作目录与执行周期对接及服务装配 |
| `internal/domain/watch/service.go`、`sqlite.go`、`memory.go`、`types.go` | 触发、投递队列、唤醒调度、熔断与游标持久化 |
| `internal/machine/`、`cmd/vibe-machine/` | 机器进程（`node.go`、`exec.go`、`env.go`、`lease.go`、`mounts.go`、`tunnel.go`）与子进程安全隔离 |
| `pkg/oar/` | Go 原生编码代理适配器（`claude.go`、`codex.go`、`qoder.go`、`qwen.go`、`acp.go`、`session.go`、`registry.go`、`subagent.go`） |
| `internal/domain/agent/`、`internal/durable/` | 农机预设登记、每日花费记账与原生持久对话引擎 |
| `apps/web/src/features/session/` | `WorkLog.tsx`、`Trajectory.tsx`、`runs.ts` 瀑布图与 `events.ts` 订阅 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`session.*`、`runtime.*`）。

## 模型和不变量

### 三层概念

| 概念 | 代码与存储 | 含义 |
|---|---|---|
| `Session` | `T.Session` | 档案的持续工作上下文（归属 `scope?: SessionScope`，支持 `"issue"`、`"draft"`、`"channel"`、`"duty"` 四种 `kind`），连同执行策略持久保持；帮工编号 `w<n>` 单调递增 |
| `Run` | `T.Run` | 一次触发到一次结束汇报 |
| 农机会话 | `pkg/oar` 会话与 `Executions` | 底层编码代理的会话与事件流；重启或失联时可在同一 `Session` 下更换或重连 |
| 机器 | `T.Machine`、`internal/machine/` | 帮工干活的执行节点与工作空间租约（本机与独立执行守护 `cmd/vibe-machine`） |

- **助手与帮工统一在 `sessions` 中**：以 `Session.role`（`orchestrator` 或 `worker`）区分，共用阶段与轮次概念；仅 `worker` 参与并发槽位、地块分配与目录恢复。
- **执行器与会话分层隔离**：`internal/machine` 与 `pkg/oar` 负责进程和沙箱生命周期；会话调度控制策略与领域归属，关闭失败时保留占位拒绝误删现场。
- **执行策略由调用方声明（`SessionPolicy`）**：显式区分工作目录（`"checkout" | "context"`）、驱逐策略（`"dismiss" | "suspend"`）、轮末休眠与结构化汇报要求，持久保留供恢复复用。

### 核心协作接口

`internal/domain/stack`、`watch` 与 `issue` 之间围绕清晰的领域接口协作（受根 `arch_test.go` 边界约束）：

| 能力面 | 做什么 | 谁用 |
|---|---|---|
| 触发、投递与派活 | 把已记下的触发按紧迫度写进投递队列并唤醒会话；腾位置、准备检出目录与启动执行 | 工单（含定时任务、跟 PR 和路由）、观察层、助手 |
| 唤醒控制与熔断 | 熔断拦住连续空唤醒的会话，取消撤回尚未消费的投递，读取刹车计数 | 观察层 |
| 会话暂停、放走与交接 | 叫停正在跑的一轮；等帮工歇下并借出工作目录执行检查、合并或提 PR；重设或清理闲置检出 | 工单、网关接口 |
| 运行态检索与事件流 | 在场帮工列表、实时状态、触发状态与事件/投递通知广播 | 工单、观察层、助手、工作台 |

### 触发与投递

- **幂等触发记录**：重复到达的来源事件去重返回首次写入的 `Trigger`（`selfEcho` 直接忽略）；控制头与只读原始载荷分开存（供 `vv://trigger/<id>` 分页读取）。
- **两级缓冲（工单蓄水池 → 会话信箱）**：发往工单的输入先进工单蓄水池（[工单](docs/subsystems/issue.md#蓄水池和路由)），放行时才进入会话投递队列；已关单或在等用户时先暂缓消费。
- **刹车在观察层，投递照做**：跳数上限、冷却和熔断由[观察层](docs/subsystems/watch.md#三道刹车brakests)判定；被拦下的投递随下一次合法唤醒一起带上。

### 在场阶段与回合结算

| 阶段（`Session.phase`） | 含义 | 用户动作 |
|---|---|---|
| `working` | 正在执行一轮（可带 `quietSince` 静默告警或 `retry`） | 静默过久时查看轨迹或叫停 |
| `done` | 上一轮完成并显式交接（`prSubmit=false`） | 验收、完成或打回 |
| `failed` | 上一轮执行失败 | 让它接着修或取消关单 |
| `resting` | 被叫停、重启恢复、私聊休眠，或 PR 在途等待外部事件 | 带话继续，或等待 CI/Review 唤醒 |
| `closed` | 已离场（从核心状态移除，历史记录留存） | — |

- **后台任务收尾与结构化交接（`issue_report`）**：回合结束前先收敛后台命令；报告结构化写入，PR 在途或 `prSubmit=true` 时结束后进 `resting` 并释放槽位，仅 `prSubmit=false` 才进 `done`。
- **触发来源（`RunTrigger`）**：分 `issue`、`comment`、`cron`、`refine` 和 `runtime`；执行中途插入的话记入当前轮次听到的上下文，不另开新轮。

### 容量上限、轨迹与花费

- **三级并发上限**：全农场限制并发在忙帮工数，单台农机按 `maxWorking` 限制，单仓库默认最多 3 个 `repo.max_sessions`；满额再来新活时收工或休眠最久闲置会话。
- **无沙箱与无逐条权限确认**：帮工在 `$VIBEVALLEY_WORK_ROOT` 下直接执行命令，不弹权限确认；安全边界是主服务端仅听 `127.0.0.1`。
- **只追加的轨迹日志**：按序记录事件并按修正号递增推送；额度与花费由档案域记账并拦截超出预算的新派活。

### 重启

- **内置持久引擎（`vibevalley` / `internal/durable`）答到一半关门后接着答**：持久存储留存未完结回合的上下文、工具与回合编号，开机恢复时继续结算同一轮，不重复开轮次计数。
- **外部农机（Claude Code、Codex 等）重启后停在 `resting`**：未完结外部回合记为 `interrupted` 并退回未消费投递，后续消息来时续接。
- **助手**：同使用 `internal/durable` 在重开后继续或按原回合结算（[VibeValley 自己的 agent](docs/subsystems/brain.md)）。

## 怎么走

1. **派活与启动**：检查仓库与农机并发余量、分配 `w<n>` 编号并准备 worktree 或上下文目录，组装规矩、人设、技能与记忆提示后启动 `pkg/oar` 或 `internal/durable` 会话。
2. **带话与投递**：空闲直接唤醒、忙时按间隔攒批插话或排队，中断或失败时回滚输入占位。
3. **交接与离场**：先停下会话并收回执行句柄，把干净工作目录交给工单侧检查、合并或提 PR；失败保留现场，成功或放走后关闭会话并释放槽位。
4. **开机恢复**：清理过期轨迹、检查工作目录完整（缺失标 `lost`）、按持久层续跑或退回未确认投递，之后依次由工单与观察层重放未路由触发。

## 和谁打交道

- **观察层与工单（`watch`、`issue`）**：观察层按事件流投递、算刹车与管串/回执；工单决定何时派活、蓄水与交付交接，底层渠道/会话域边界由 `arch_test.go` 守住。
- **仓库、档案（含农机）与记性（`repo`、`agent`、`memory`）**：打开与回收工作目录检出、探测与解析农机预设及计费、在回合前后读写长期记忆。
- **助手（`orchestrator`）**：共享持久引擎、投递回执与摘要通道。

## 为什么这样

- **工单蓄水、观察刹车与会话执行边界清楚**：谁听见与刹车归观察层，工单蓄水池与交付规则归工单，工作目录隔离与会话生命周期留在帮工执行与机器层。
- **用进程与链接边界隔离执行器，重启后外部农机停在 `resting`**：防止服务重启重跑有副作用的外部 shell 命令，同时允许自带持久引擎恢复半截思维链。
- **回环鉴权 + 独立工作目录划安全边界**：主服务端仅绑定回环地址，不靠地里杂草式的逐条命令弹窗阻断无人值守帮工。

## 还没做的

- 接入 opencode、grok、kimi、antigravity、cursor 等更多农机：[其他农机提案](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)。

## 怎么验证

- `env -u GOROOT CGO_ENABLED=0 go test -count=1 -race ./internal/domain/stack/... ./internal/domain/watch/... ./internal/machine/... ./pkg/oar/... ./cmd/vibe-machine/...`：帮工派发、机器沙箱、投递顺序与熔断刹车、`pkg/oar` 协议与回放、重启恢复及跨边界隔离测试。
- 根包 `arch_test.go`：验证领域层与基础层依赖方向不回流。

## 代理和 MCP 连接

- **回环地址总是绕过代理**：`internal/machine/env.go` 为每个帮工子环境生成去重的 `NO_PROXY` 与 `no_proxy` 清单，始终并入 `127.0.0.1,localhost,::1`，不清除已有代理变量。
- **MCP 连接与工具状态观察**：各档案配置的 MCP 连接状态经 `Session.toolConnections` 同步给页面，失败或取消记录在对应执行错误事件中。

## 帮工接入与 CLI

帮工 MCP 与工作台接口共用服务端签发的会话作用域与权限核查（`internal/domain/stack/tools.go`、`internal/domain/gateway`）。`internal/machine/` 按 `0700`/`0600` 隔离工作目录与凭据传递；本地联调或独立诊断可通过 `vibe doctor --json`（`cmd/vibe/doctor.go`）核对服务端连通性与环境准备。
