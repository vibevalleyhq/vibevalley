# VibeValley 自己的 agent

`Brain` 是仓库自研的进程内 agent，由 `packages/provider`（厂商接入）、`packages/ai`（模型调用与消息桥）和 `packages/agent` 组成，支撑助手、`vibevalley` 农机帮工、CLI 对话与子帮手四种宿主。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| DeepSeek 协议与连接（`@vibevalley/provider`）、agent 历史重放、工具 JSON Schema 生成与消息/参数修补（`@vibevalley/ai`） | 模型名称选择与 API Key 存储（[档案和农机](docs/subsystems/agent.md)、[设置和配置](docs/subsystems/setting.md)） |
| 单轮模型⇄工具循环（`loop.ts`）：并发跑工具、插话（`steer`）、追问（`followUp`）与中断（`abort`） | 输入何时送入、是否含用户授权、回合如何记入 `session_run`（[助手](docs/subsystems/orchestrator.md)、[帮工](docs/subsystems/session.md)） |
| 对话 `.jsonl` 持久化、三段式提示与前缀哈希校验、空闲/超限压缩、断点续跑 | 农场业务工具集（`apps/server/src/modules/tool`）与跨档案数据库记忆（[记性](docs/subsystems/memory.md)） |
| 内置工具：技能按需加载、`MemoryPort`、归档检索、子帮手、自身任务（`Todo`）、提醒与编码工具 | |

## 在哪

单向依赖（由 `vite.config.ts` 的 `no-restricted-imports` 守护）：`packages/provider` → `packages/ai` → `packages/agent/src/core` → `packages/agent/src` → `apps/server` 组装层。箭头右边使用左边。

| 位置 | 职责 |
|---|---|
| `packages/provider/src/deepseek/` | 模型目录、请求编码、`Sse.decode` 分帧与厂商增量、显式 `fetch` 连接 |
| `packages/ai/src/` | `models.ts`、`client.ts`（`ModelClient`）、`llm.ts`（`Llm` 服务）、`request.ts`、`response.ts`、`tools.ts`、`testing.ts` |
| `packages/agent/src/core/` | `loop.ts`（单轮循环、默认上限 `8` 的工具并发与取消竞态）、`tool.ts`（`textTool`、`runTool`、`schemaTool`）、`prompts.ts` |
| `packages/agent/src/brain/brain.ts`、`session.ts`、`fs.ts`、`compaction.ts`、`prefix.ts` | `makeBrain` 入口（显式 `BrainState`）、`TranscriptStore` `.jsonl` 端口、`AgentFs` 文件端口、上下文压缩与前缀分段 SHA-256 校验 |
| `packages/agent/src/tools/self.ts`、`skills.ts`、`memory.ts`、`mcp.ts`、`reminders.ts` | 收 `AbortSignal` 的内置工具、技能目录扫描、`MemoryPort`、MCP 客户端与定时提醒 |
| `packages/agent/src/tools/todo.ts`、`todoTools.ts`、`coding.ts`、`dag.ts` | 自身任务图 `Todo`、本地文件/shell 编码工具与通用 DAG 算法 |
| `apps/server/src/modules/session/host.ts`、`runtime/durable.ts`、`runtime/vibevalley.ts`、`chat/chat.ts` | 助手宿主 `AgentHost`、农场唯一的 `Harness`（`durableTool` 把 `Tool` 包成 pi-durable 的工具，模型桥接到 `ModelClient`）、`vibevalley` 农机（oar 的 `Runtime`，一个会话一个 pi-durable 对话，含 `runtime_todo` 表存储）与 CLI 终端对话（同一个农机，跑在自己的 `Harness` 上）；四者都跑在 pi-durable 上 |

## 模型和不变量

### 模型边界

- Provider 的 `makeDeepSeekModel` 只收显式 `model`、`baseUrl`、`key` 与调用者的 `fetch`；不读环境、登录或农场配置，不重试、不换供应商。返回 DeepSeek 增量和带标签错误，不依赖 agent 消息。
- AI 的 `Llm` 保留 `start`、thinking/text/tool 增量、`done/error`，失败保留已到达的内容；消费结束或打断时释放响应 reader。`ModelClient` 每次请求读取调用者提供的当前 key。
- 历史重放、缺失工具结果补齐、图片降级、上下文预算、工具参数修补与成本计算留在 AI；模型目录、wire 字段、usage 和 finish reason 解码归 Provider。
- 官方 `@ai-sdk/deepseek@3.0.80` 不是现有桥的等价替代：离线 fixture 中它将纯工具 assistant 的 `content: null` 编为 `""`，忽略 `reasoning_text` 与 choice 内 usage。现有流还接受迟到的工具 ID。为保持这些契约，语言保留单一专有适配器，不加 SDK 旁路；SDK Core 用于转写，不接管 agent 循环。

### 四种宿主配置（`BrainOptions`）

| 能力项 | 助手 | 帮工（`vibevalley` 农机） | CLI 对话 | 子帮手（`spawn_agent`） |
|---|---|---|---|---|
| 农场业务工具 | `Tool` 助手工具表 | 经 `/mcp` 挂载帮工工具表 | 无 | 继承父 agent |
| 本地编码工具 | 无 | pi-durable 的 `read`、`write`、`edit`、`bash`（工作目录是帮工的，`bash` 带会话的环境变量、默认 120 秒） | 同帮工 | 继承父 agent |
| 目录技能扫描（`SKILL.md`） | 无（`noSkills`） | 有 | 有 | 继承父 agent |
| 记忆（`MemoryPort`） | 数据库 `memory` 表 | 无（由 `Session` 管） | 本地 `MEMORY.md` | 继承父 agent |
| 子帮手（`spawn_agent`） | 无 | 有（调用拥有的子对话） | 有 | 无（禁止嵌套） |
| 自身任务图（`Todo`） | 无 | 有（存 `runtime_todo` 表；只记 `self`，不自动派子帮手） | 有（存内存） | 继承父 agent |
| 对话 | pi-durable，在 `durable.db` | pi-durable，在 `durable.db`（一个 oar 会话一个，`resume` 找回） | pi-durable，在 `agent/<名字>/durable.db` | 父对话的调用拥有的子对话 |

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

- 助手、`vibevalley` 农机和终端对话不走下面两条：它们跑在上游 pi-durable 的 `Harness` 上（`runtime/durable.ts`，`$VIBEVALLEY_HOME/durable.db`，测试农场在内存里），输入、每次回答、每个工具调用先落盘再显示；服务端在助手答到一半时停掉，重开以后这一轮接着答完，`session_run` 里还是同一轮（[计划](.agents/notes/proposed/architecture/2026-11-12-brain-on-upstream-pi-durable.md)）。
- 农机的会话被放下（`dispose`，或服务端关门时它的主人 `owner` 关掉）时停下这一轮，和 oar 的约定一样；进程没来得及放下就没了（崩溃）时，这一轮留在 `durable.db` 里，同一个 oar 会话再打开（`resume`）就接着跑完，作为这个会话的一轮报出来；在那以前别处先让 `Harness` 接着跑（助手开机时有没答完的一轮）的话，这个会话的模型还没接上，这一轮以 `no_model` 结束。农场开机时帮工那一侧仍按「打断了」处理，下一句话来时才用 `resume` 打开。
- 终端对话不用服务端的 `durable.db`：pi-durable 没有跨进程的锁，它在 `agent/<名字>/` 下开自己的，开着时租着这个目录；同名的第二个对话只在内存里。
- 关闭或崩溃打断时，取消产生的半截消息不写入 `.jsonl`。
- 调用 `resume(maxAgeMs)` 时，若最后一条是 `maxAgeMs` 内未完结的用户消息、工具结果或无结果的 `tool_calls`，自动补入「服务端重启，结果未知，请先核实」回执并继续跑完该轮。

### 自己带的东西

- **按需加载技能**：扫描技能目录下的 `SKILL.md` frontmatter，系统提示只列名称与 160 字内简介，调 `load_skill` 时才读正文。
- **记忆与归档**：经 `MemoryPort` 执行 `remember` 与 `rewrite_memory`（服务端接 `memory` 表，独立 CLI 接 `MEMORY.md`），经 `search_archive` 检索归档原文。
- **子帮手与自身任务（`Todo`）**：
  - `spawn_agent` 在子作用域内跑最多 30 步。
  - `todo_add|update|list` 维护最多 30 节点的 DAG，标为 `subagent` 的节点在前置完成后自动并发派生子帮手（最多 3 并发，失败重试 1 次）。
- **打断一路往下传，关了就收干净**：宿主可注入 `AgentFs`、`fetch` 与 `TranscriptStore`；每一轮、每个工具调用收同一个 `AbortSignal`，`Brain` 是 `AsyncDisposable`，`close()` 中止模型流、子帮手、MCP 连接与压缩计时器并等它们结束。

## 怎么走

1. 宿主调 `send`（空闲开新轮，运行中在下一次模型请求前 `steer` 插入）或排入队尾 `later`。
2. 循环执行 `prepare`：按需压缩，组装固定开头、历史消息与最新输入，校验前缀哈希。
3. 调 `Llm.stream` 流式读输出并广播事件；若有工具调用则按并发上限（默认 `8`）执行、追加 `.jsonl` 并继续下一轮请求，直至回答结束或达步数上限（默认 40 步），发出 `agent_settled`。

## 和谁打交道

- **四个宿主**：助手 `session/host.ts`、帮工农机 `runtime/vibevalley.ts`、终端对话 `chat/main.ts` 与内部 `spawn_agent`。
- **资源服务（`resource`）**：助手与帮工的 `resource_read` 工具经 `apps/server/src/resource/` 按会话权限分页读取 `vv://` 资源。

## 为什么这样

- **厂商接入与 agent 契约分开**：语言只接 DeepSeek，协议留在 Provider；AI 和循环用 `AbortSignal` 与 `@vibevalley/async` 的 `TaskGroup` 保证取消与插话。
- **包与服务端解耦，一份 `Brain` 配置出四种用法**：`packages/ai` 与 `packages/agent` 不依赖农场协议或词典，通过 `BrainOptions` 组合工具集与存储端口。
- **严守前缀不变与空闲压缩**：将动态时间、现状和新增记忆全部后置到当轮输入中，并在空闲 10 分钟后复用原前缀写摘要，最大化 DeepSeek 缓存命中率。

## 还没做的

- 按档案 `toolsets` 分配工具、统一技能发现模块并支持助手加载技能：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `packages/provider/src/deepseek/deepseek.test.ts`：请求编码、SSE 与代理字段/usage 的独立解码。
- `packages/ai/src/llm/llm.test.ts`：UTF-8 分片、迟到工具 ID、密钥替换、单请求、错误部分内容与 reader 取消。
- `packages/agent/src/brain/loop.test.ts`、`core/loop.test.ts`、`brain.test.ts`、`todo.test.ts`：工具并发、插话/排队、前缀哈希、空闲压缩、断点续跑与子帮手 DAG 测试。
- `apps/server/src/modules/runtime/vibevalley.test.ts`、`orchestrator/openai.test.ts`：oar 农机适配、任务表持久化与 OpenAI 协议入口测试。
