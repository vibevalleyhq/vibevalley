# VibeValley 自己的 agent

`Brain` 是仓库自研的进程内 agent，由 `packages/ai`（DeepSeek 客户端）和 `packages/agent` 组成，支撑管家、`vibevalley` 农机帮工、CLI 对话与子帮手四种宿主。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| DeepSeek 请求拼装、SSE 流解析、工具 JSON Schema 生成与参数修补（`@vibevalley/ai`） | 模型名称选择与 API Key 存储（[档案和农机](docs/subsystems/agent.md)、[设置和配置](docs/subsystems/setting.md)） |
| 单轮模型⇄工具循环（`loop.ts`）：并发跑工具、插话（`steer`）、追问（`followUp`）与中断（`abort`） | 输入何时送入、是否含主人授权、回合如何记入 `session_run`（[管家](docs/subsystems/orchestrator.md)、[帮工](docs/subsystems/session.md)） |
| 对话 `.jsonl` 持久化、三段式提示与前缀哈希校验、空闲/超限压缩、断点续跑 | 农场业务工具集（`apps/server/src/tool`）与跨档案数据库记忆（[记性](docs/subsystems/memory.md)） |
| 内置工具：技能按需加载、`MemoryPort`、归档检索、子帮手、自身任务（`Todo`）、提醒与编码工具 | |

## 在哪

三层单向依赖（由 `vite.config.ts` 的 `no-restricted-imports` 守护）：`packages/ai` → `packages/agent/src/core` → `packages/agent/src` → `apps/server` 组装层。

| 位置 | 职责 |
|---|---|
| `packages/ai/src/` | `models.ts`、`client.ts`（`ModelClient`）、`llm.ts`（`Llm` 服务）、`request.ts`、`response.ts`、`tools.ts`、`testing.ts` |
| `packages/agent/src/core/` | `loop.ts`（单轮纤程循环与取消竞态）、`tool.ts`（`schemaTool`、`effectTool`）、`prompts.ts` |
| `packages/agent/src/brain.ts`、`session.ts`、`compaction.ts`、`prefix.ts` | `makeBrain` 入口、`.jsonl` 读写、上下文压缩与前缀分段 SHA-256 校验 |
| `packages/agent/src/self.ts`、`skills.ts`、`memory.ts`、`mcp.ts`、`reminders.ts` | 自身内置工具、技能目录扫描、记忆接口、MCP 客户端与定时提醒 |
| `packages/agent/src/todo.ts`、`todoTools.ts`、`coding.ts`、`dag.ts` | 自身任务图 `Todo`、本地文件/shell 编码工具与通用 DAG 算法 |
| `apps/server/src/session/host.ts`、`runtime/vibevalley.ts`、`chat.ts` | 管家宿主 `AgentHost`、oar 农机适配（含 `runtime_todo` 表存储）与 CLI 终端对话 |

## 模型和不变量

### 四种宿主配置（`BrainOptions`）

| 能力项 | 管家 | 帮工（`vibevalley` 农机） | CLI 对话 | 子帮手（`spawn_agent`） |
|---|---|---|---|---|
| 农场业务工具 | `Tool` 管家工具表 | 经 `/mcp` 挂载帮工工具表 | 无 | 继承父 agent |
| 本地编码工具（`coding.ts`） | 无 | 有 | 有 | 继承父 agent |
| 目录技能扫描（`SKILL.md`） | 无（`noSkills`） | 有 | 有 | 继承父 agent |
| 记忆（`MemoryPort`） | 数据库 `memory` 表 | 无（由 `Session` 管） | 本地 `MEMORY.md` | 无 |
| 子帮手（`spawn_agent`） | 无 | 有 | 有 | 无（禁止嵌套） |
| 自身任务图（`Todo`） | 无 | 有（存 `runtime_todo` 表） | 有（存内存） | 无 |
| 对话文件（`.jsonl`） | 有 | 有（按会话） | 有 | 无 |

### 提示分三段

| 段落 | 内容 | 变化时机 |
|---|---|---|
| 1. 开头（Prefix） | 工具表定义 + 系统提示（`instructions`、`## 环境`、技能目录摘要、记忆快照 `memory`） | 仅在启动与每次压缩后重建（`refreshPrefix`） |
| 2. 历史对话 | 对话文件中的历史消息（含上次压缩摘要及保留的近期消息） | 每条消息追加 |
| 3. 最新输入 | 宿主拼装的本轮输入（含时间戳、农场现状差异、记忆增量 `memoryNews` 与正文） | 每次请求 |

- **两次压缩之间开头一字不变**：`prefix.ts` 在每次请求前对五段开头分别算 SHA-256，若在两次压缩间变化则发 `prefix_changed` 告警；工具表在创建时固定，不动态增减。

### 压缩

1. **触发条件**：单次请求预估超 12 万 token 预算时在请求前立即压缩；或一轮结束超预算 80%（`idleFoldAt`）且空闲满 10 分钟、未预告即将唤醒时后台压缩。
2. **复用前缀写摘要**：压缩请求沿用完全相同的开头与工具定义（`toolChoice: "none"`），直接命中前缀缓存；失败则回退独立摘要请求。
3. **保留近期对话**：切点选在用户消息开头，保留最近至少 12 条消息与 3 条带字回复（`keepRecent` / `keepSaid`）；被压原文存入 `archive/`，对话文件追加 `compactionSummary` 并刷新开头。

### 接着做被打断的一轮

- 关闭或崩溃打断时，取消产生的半截消息不写入 `.jsonl`。
- 调用 `resume(maxAgeMs)` 时，若最后一条是 `maxAgeMs` 内未完结的用户消息、工具结果或无结果的 `tool_calls`，自动补入「服务端重启，结果未知，请先核实」回执并继续跑完该轮。

### 自己带的东西

- **按需加载技能**：扫描技能目录下的 `SKILL.md` frontmatter，系统提示只列名称与 160 字内简介，调 `load_skill` 时才读正文。
- **记忆与归档**：经 `MemoryPort` 执行 `remember` 与 `rewrite_memory`（服务端接 `memory` 表，独立 CLI 接 `MEMORY.md`），经 `search_archive` 检索归档原文。
- **子帮手与自身任务（`Todo`）**：
  - `spawn_agent` 在子作用域内跑最多 30 步。
  - `todo_add|update|list` 维护最多 30 节点的 DAG，标为 `subagent` 的节点在前置完成后自动并发派生子帮手（最多 3 并发，失败重试 1 次）。
- **作用域生命周期**：`makeBrain` 绑定 Effect `Scope`；作用域关闭时自动中断模型流、子帮手、MCP 连接与压缩计时器。

## 怎么走

1. 宿主调 `send`（空闲开新轮，运行中在下一次模型请求前 `steer` 插入）或排入队尾 `later`。
2. 循环执行 `prepare`：按需压缩，组装固定开头、历史消息与最新输入，校验前缀哈希。
3. 调 `Llm.stream` 流式读输出并广播事件；若有工具调用则并发执行、追加 `.jsonl` 并继续下一轮请求，直至回答结束或达步数上限（默认 40 步），发出 `agent_settled`。

## 和谁打交道

- **四个宿主**：管家 `session/host.ts`、帮工农机 `runtime/vibevalley.ts`、终端对话 `chat.ts` 与内部 `spawn_agent`。
- **资源服务（`resource`）**：管家与帮工的 `resource_read` 工具经 `apps/server/src/resource/` 按会话权限分页读取 `vv://` 资源。

## 为什么这样

- **自研 Effect 模型层与循环，黄金数据对齐 `pi-ai`**：只接 DeepSeek 一家模型，用 Effect 纤程与 `Deferred` 实现可控取消与插话，用录制的黄金数据保证协议与参数转换一致。
- **包与服务端解耦，一份 `Brain` 配置出四种用法**：`packages/ai` 与 `packages/agent` 不依赖农场协议或词典，通过 `BrainOptions` 组合工具集与存储端口。
- **严守前缀不变与空闲压缩**：将动态时间、现状和新增记忆全部后置到当轮输入中，并在空闲 10 分钟后复用原前缀写摘要，最大化 DeepSeek 缓存命中率。

## 还没做的

- 按档案 `toolsets` 分配工具、统一技能发现模块并支持管家加载技能：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `packages/ai/src/deepseek.test.ts`、`tools.test.ts`、`llm.test.ts`：请求体、流解析与参数修补黄金数据测试。
- `packages/agent/src/loop.test.ts`、`core/loop.test.ts`、`brain.test.ts`、`todo.test.ts`：工具并发、插话/排队、前缀哈希、空闲压缩、断点续跑与子帮手 DAG 测试。
- `apps/server/src/runtime/vibevalley.test.ts`、`orchestrator/openai.test.ts`：oar 农机适配、任务表持久化与 OpenAI 协议入口测试。
