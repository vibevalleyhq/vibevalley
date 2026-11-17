# 档案、农机和技能书

- **档案（`Agent`）**：一份 agent 配置，含角色、名称、职责 `duty`、匹配词 `tags`、农机、模型、人设、技能、MCP、环境变量与外观（可从 `AgentTemplate` 安装或手工创建）。
- **农机（`Runtime`）**：本机安装的编码 agent 程序，由服务端经 oar 探测安装、模型、额度与支持项。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 档案、技能库（`Skill`）与农机设置的持久化及 SQLite 查询（`agent` 相关表） | 助手如何使用档案（[助手](docs/subsystems/orchestrator.md)）、自有持久引擎实现（[VibeValley 自己的 agent](docs/subsystems/brain.md)） |
| 档案模板的读取、安装与 starter 初始化（`seed_catalog.go`） | 会话如何启动与并发上限（[帮工](docs/subsystems/session.md)） |
| 农机注册表、可用性探测、模型与能力缓存、派活前配置解析 | 档案记忆的存储与召回（[记性](docs/subsystems/memory.md)） |
| 档案可派性预检（农机缺失、选项不兼容、额度/预算耗尽） | 像素角色贴图渲染（[农场的皮](docs/subsystems/farm.md)） |
| 每日花费与农场原生持久对话引擎 | 对话怎么拼提示、怎么压缩（[VibeValley 自己的 agent](docs/subsystems/brain.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `internal/domain/agent/registry.go` | `Agent` 注册表、档案与农机预设解析、可派性检查与挑人规则 |
| `internal/domain/agent/sqlite.go`、`migrations/0001_init.up.sql`、`queries.sql` | 档案、技能库与运行记录的 SQLite 持久化与 `sqlc` 查询 |
| `internal/domain/agent/presets.go` | 农机预设、支持项与平台选项兼容检查 |
| `internal/domain/gateway/seed_catalog.go` | 内置档案模板、自带技能目录与 starter（`VIBEVALLEY_AGENT_STARTERS`）安装 |
| `pkg/oar/`、`internal/domain/stack/machine_hub.go` | 外部编码农机（`claude`、`codex`、`pi` 等）探测、会话拉起与事件订阅 |
| `internal/durable/`、`internal/domain/stack/` | 原生持久对话引擎、模型路由（`llm_adapter.go`）与帮工工具挂载（`tools.go`） |
| `apps/web/src/features/agent/`、`apps/web/src/features/runtime/` | 档案列表、模板目录、捏帮工页、助手档案页、农具页与技能书页 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`agent.*`、`skill.*`、`runtime.*`）。农机在线上仍是自己的概念（`packages/protocol/src/runtime`、`runtime.*` 接口、页面的 `features/runtime`），服务端在网关统一暴露 `agent.*`、`skill.*` 与 `runtime.*` 操作。

## 模型和不变量

- **核心领域归 `internal/domain/agent`，预设与持久化分离**：档案与农机预设分别收敛在 `presets.go`、`registry.go` 与 `sqlite.go`，网关路由与参数校验在 `internal/domain/gateway/handlers_work.go` 与 `handlers_platform.go`，底层持久运行引擎在 `internal/durable`。
- **事务写库，外观确定性补齐**：档案、技能库变更在 SQLite 事务内提交；缺省外观按档案 `id` 哈希确定性补齐，前后端算法一致。
- **角色固定为 `orchestrator` 与 `worker`**：默认助手 `orchestrator` 不可删除或改为帮工；派工候选仅面向可用 `worker` 档案；跨端发言主体统一用 `Actor`（`kind: "user" | "agent" | "system"`）表述，agent 携带角色。
- **`duty` 供阅读，`tags` 供匹配**：`duty` 是一句话职责说明；`tags` 是关键词数组。
- **挑档案顺序**：按点名档案名或 ID → 点名农机上的首个可用档案 → 用户界面选定的档案 → 工单文字命中 `tags` 最多的可用档案。
- **自带技能按 id 引用，只读保护**：`builtIn` 技能随服务端内置目录加载，不允许经更新/删除接口覆盖，模板安装与按模板更新时保留用户自选技能。
- **按需安装内置模板**：新农场默认按需初始化 `orchestrator` 与 `VIBEVALLEY_AGENT_STARTERS` 指定的模板，不强灌未安装的外部农机模板。
- **农机探测与能力合并**：固定登记 `claude`、`codex`、`opencode`、`vibevalley`、`pi`、`cursor`、`grok`、`kimi`、`antigravity`、`dsh` 预设；能力矩阵与会话选项校验在前后端与 `pkg/oar` 间一致，探测变化经 `/api/v1/live` 窄事件推送，不放大 `SpaceState`。

## 内置的模板

内置档案模板由 `internal/domain/gateway/seed_catalog.go` 管理，除默认助手 `orchestrator` 外提供各专业帮工与技能模板，可通过模板目录按需安装到工作台。

## 怎么走

1. 启动后注册或按需探测本机农机与模型可用性，未探完状态与额度更新经 `LiveEvent` 窄流推送。
2. 派活前 `Agent` 校验目标农机、选项兼容性、配额与环境变量合并，交由 `internal/domain/stack` 调度 `pkg/oar` 或内置 `internal/durable` 运行一轮。

## 和谁打交道

- **工作流与会话（`stack`、`watch`）**：派活时解析档案、技能提示与工作目录选项；助手与帮工工具调用经 `internal/domain/stack/tools.go` 落地。
- **网关（`gateway`）**：处理 `agent.*`、`skill.*`、`runtime.*` 接口、推送农机状态窄流并组织 starter 初始化。
- **记性（`memory`）**：结合档案作用域写入与召回历史记忆。

## 为什么这样

- **派活针对档案而非直接针对农机**：同一台农机配不同人设、模型、技能和 `worktree` 策略即构成不同工种，且同一档案可并发派出多个会话。
- **模板按需安装，自带技能只读**：不在首次开机强灌全部帮工，自带技能跟随二进制更新不与用户自建技能冲突。
- **农机观察走 `/api/v1/live` 窄流，不进 `SpaceState`**：避免每次额度或探测状态变动触发全局状态折叠与广播。

## 还没做的

- 启用并验证 opencode、grok、kimi、antigravity、cursor：[其他农机提案](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)。
- 档案配置 `toolsets`，技能库改用 Agent Skills 文件夹按需加载：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `env -u GOROOT CGO_ENABLED=0 go test -count=1 ./internal/domain/agent/... ./internal/domain/gateway/...`：档案预设、SQLite 持久化、starter 初始化与接口测试。
- `apps/web/test/agents.spec.ts`、`runtimes.spec.ts`、`runtime-avatars.spec.ts`：档案增删改、模板安装、农机设置与头像角标端到端测试。
