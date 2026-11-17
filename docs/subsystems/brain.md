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

### 模型边界

- `internal/provider/router.go` 统一接入兼容的流式模型后端（Anthropic / OpenAI SSE），密钥从设置或环境变量注入并在每次请求边界组装，不在持久化层明文泄露密钥。
- 工具权限评估由 `internal/durable/permission.go` 在每轮工具调用前执行：拒绝但不可客户端覆盖时直接将结果标为拒绝；需要审批时 `Park` 挂起当前轮次并经工作台审批接口恢复或拒绝。
- Token 预算（`budget.go`）与上下文压缩（`compaction.go`）均在同一持久引擎状态机内推进，重启后按库中记录的回合与轨迹恢复。

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
