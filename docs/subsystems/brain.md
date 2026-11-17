# VibeValley 自己的 agent

助手、`vibevalley` 农机的帮工以及终端对话，均运行在平台原生的持久对话与调度引擎（`internal/durable`）之上：以 SQLite 与 `sqlc` 持久化每一轮对话、工具权限评估、预算与压缩；外部编码农机通过 `pkg/oar` 协议驱动，内部助手与托管帮工工具则由 `internal/domain/stack` 提供。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 持久生成循环、会话队列调度、Token 预算、上下文压缩、权限门禁与代码执行沙箱（`internal/durable/`） | 模型名称选择与 Provider 密钥界面配置（[档案和农机](docs/subsystems/agent.md)、[设置和配置](docs/subsystems/setting.md)） |
| 持久化后端（`internal/durable/store/`）：内存替身与 SQLite 事务存储 | 频道触发规则与派活队列（[助手](docs/subsystems/orchestrator.md)、[帮工](docs/subsystems/session.md)） |
| LLM SSE 流式路由与协议适配（`internal/provider/`）：Anthropic 与 OpenAI SSE 解析及路由 | 跨档案数据库记忆的存储与召回（[记性](docs/subsystems/memory.md)） |
| 平台业务工具注册、提示拼接与助手调度（`internal/domain/stack/`） | 外部编码农机安装探测与 MCP 外壳细节（[档案和农机](docs/subsystems/agent.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `internal/durable/driver.go`、`generation.go`、`scheduler.go` | 持久驱动器、多轮流式生成、工具并行与并发调度 |
| `internal/durable/budget.go`、`compaction.go`、`permission.go`、`grader.go`、`codemode.go` | 成本与 Token 预算、上下文压缩、工具权限门禁（`PermissionEvaluator` / `Park`）、评分器与 JS 代码执行器 |
| `internal/durable/store/` | `store.go`、`sqlite.go`、`memory.go`、`tx.go`、`clock.go`、`migrations/0001_init.up.sql`、`queries.sql` |
| `internal/provider/` | `router.go`、`anthropic_sse.go`、`openai_sse.go`、`types.go` |
| `internal/domain/stack/` | `orchestrator.go`、`tools.go`、`prompts.go`、`llm_adapter.go`、`dispatch.go`、`stack.go` |
| `cmd/vibe/chat.go` | 终端 `vibe chat` 交互入口 |

## 模型和不变量

### 持久存储与显式阶段状态机（`internal/durable`）

- **六张正交表与单一写者组提交（`internal/durable/store`）**：存储兼容内存后端与零 CGO `modernc.org/sqlite`（WAL + `synchronous=NORMAL`），收敛为 `durable_conversation`、`durable_entry`（只追加不可变账本，压缩和重置推进 `head_seq`）、`durable_document`（按 `(scope_kind, scope_id, doc_kind)` 存 `pi.agent`、`pi.live`、`pi.inbox`、`pi.usage`、`pi.governance`）、`durable_submission`（`UNIQUE(conversation_id, request_id)` 保障跨重启幂等）、`durable_task` 与 `durable_signal` 六张表。写路径经单一写协程执行批量组提交（上限 `64` 项），事务落盘后才更新内存文档与通知 `SubscribeDocuments` 观察者；仅 `pi.live` 流式输出允许 `deferred` 合批（`100 ms` 推内存视图、`1,000 ms` 合并落盘）。
- **零空转阶段迁移与熔断**：休眠（`TransSleep`）与子任务汇合（`TransWaitTasks`，支持 `allSettled`、`failFast`、`any`）均落盘释放 Goroutine；早到信号在 `durable_signal` 持久缓存并单次消费。重启后未推进检查点的非模型任务递增 `restart_count`，达到 `restartLimit`（默认 `5` 次）即熔断并自底向上级联中止子任务。
- **缓存亲和与四级压缩（`compaction.go`）**：透传固定 `provider_affinity`，工具或提示变化仅在尾部追加 `pi.system` 增量条目以保住前缀缓存，内置四级上下文压缩。
- **`CodeMode` 确定性 JS 重放（`codemode.go`）**：内嵌纯 Go [`dop251/goja`](https://github.com/dop251/goja) 引擎并限制默认步数（`10,000`）、变量数（`256`）、内存（`16 MiB`）、输出（`1 MiB`）与 `5 s` 看门狗超时，锁定虚拟时钟与种子；脚本工具调用映射为带 `dedup_key` 的持久化子任务 `pi.codemode.tool`，崩溃重启可零耗时快进跳过已完成步骤。

### 模型路由与三大治理闭环

- **SSE 模型路由（`internal/provider/`）**：`Router` 封装 Anthropic 与 OpenAI（兼容 OpenAI / DeepSeek / 自定义端点）SSE 客户端，按显式供应商或模型前缀路由，密钥仅在请求边界注入。
- **会话花费硬熔断（`budget.go`）**：`BudgetGate` 核算会话及派生子任务在 `pi.usage` 的累计花费；在发起新模型请求前检查 `maxCostMicros`，跨线后发出 `budget_reached` 告警并将任务转入 `sleeping`（保留工作目录租约），用户调高额度后投递 `budget.updated` 信号恢复执行。
- **三态工具权限风控（`permission.go`）**：内置工具默认 `always_allow`，外部 MCP 工具默认 `always_ask`，支持按单工具覆写。`always_ask` 通过 `Park` 挂起并推送审批卡片至收件箱与灵动岛，由 `permission.decision` 信号唤醒；`auto` 模式经 `ExtractTrustedUserIntent` 严格只提取 `pi.user` 意图与工具参数（剔除 `pi.tool_result`、网页与 MCP 返回内容以阻断间接提示词注入），交 `RiskClassifier` 判定：`safe` 放行、`high_risk` 硬拒且禁止客户端绕过、`indeterminate` 降级为 `ask`。
- **独立上下文验收裁判（`grader.go`）**：当会话配置验收标准 `RubricSpec` 时，`OutcomeGrader` 在 `pi.generation` 的 `onYield` 拦截点创建无任何写工具的只读独立裁判会话（仅传入任务描述、`RubricMarkdown` 与交付产物，隔离主会话推理路径），最多评估 `maxIterations`（默认 `3` 轮），返回 `needs_revision` 时将未达标项注入主会话返工。

### 提示、恢复与去重

- 提示词分节组织于 `internal/domain/stack/prompts.go`，动态变化的环境现状随每轮输入注入，保持稳定的前置缓存前缀。
- 每一轮输入、模型回答、工具调用与权限判决先行写入 SQLite（`internal/durable/store/migrations/0001_init.up.sql`），服务重启或从异常停机恢复后按状态对账继续或结算，不重复计数与重放有副作用的操作。

## 怎么走

1. `internal/domain/stack` 将频道或用户提交写入持久对话并触发生成。
2. `internal/durable/generation.go` 读取上下文与工具清单、请求模型流（`internal/provider`），对每次工具调用先经 `permission.go` 鉴权、再路由给 `internal/domain/stack/tools.go` 执行并落库。
3. 回合事件向网关实时流广播，助手或托管帮工回复经频道写回对应话题串或私聊。

## 和谁打交道

- **工作台与 CLI**：工作台界面与终端 `cmd/vibe/chat.go` 对接同一个服务端对话与事件流模型。
- **网关（`internal/domain/gateway`）**：处理错轮录入（`/api/v1/orchestrator/eval/create`）与模型连接事件推送。

## 为什么这样

- **持久引擎与平台网关统一用纯 Go 实现**：消除 Node/TypeScript 运行时进程边界，以单库 SQLite 事务加内存替身覆盖会话恢复、权限阻塞与预算控制，支持桌面端零外部依赖单二进制分发。
- **权限门禁内建进每轮生成循环**：确保审批与预算拦截在任何工具执行之前生效，而不是散落在各个工具实现中。

## 还没做的

- 按档案 `toolsets` 分配工具、统一技能发现并让助手也能加载技能：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `env -u GOROOT CGO_ENABLED=0 go test -count=1 -race ./internal/durable/... ./internal/provider/... ./internal/domain/stack/...`：持久生成、预算、压缩、权限停靠、SQLite 存储与 SSE 解析测试。
- `env -u GOROOT CGO_ENABLED=0 go test -count=1 ./cmd/vibe/...`：终端聊天与命令行交互测试。
