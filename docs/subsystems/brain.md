# VibeValley 自己的 agent

助手和 `vibevalley` 农机的帮工跑在同一个自研的 agent 上：`crates/runtime/src/agent`。它把内置模型客户端、Durable SQLite 持久引擎、类型化工具、上下文压缩、资源与扩展、运行时挂架与内置 OAR 农机收拢成单向分层的单个 crate，只接 DeepSeek（OpenAI 兼容的 chat completions），不做多厂商路由。终端里也能经 `vibevalley chat` 与服务端助手对话。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 单个对话与子任务树：模型客户端、工具、SQLite 转写与六阶段任务状态机、断点续跑、插话与排队、压缩 | 模型名称的选择和 DeepSeek 钥匙的存放（[档案和农机](docs/subsystems/agent.md)、[设置和配置](docs/subsystems/setting.md)） |
| 工具契约（`TypedTool` / `Tool`：JSON Schema 加执行，`ReplayPolicy::Safe \| Unsafe`）、编码工具 | 农场的业务工具（`crates/server/src/agent/tool/`）、跨档案的数据库记忆（[记性](docs/subsystems/memory.md)） |
| 技能按需加载、上下文文件发现、`MemoryPort`、MCP 客户端、任务图、`Extension` 钩子与实验扩展槽、OAR 双向调度 | 输入什么时候送、一轮怎样记进工单（[助手](docs/subsystems/orchestrator.md)、[帮工](docs/subsystems/session.md)） |

## 在哪

`crates/runtime/src/agent/` 按单向依赖分为 12 个模块（下层不回引上层，`vibevalley-runtime::oar` 零依赖本 crate）：

| 位置 | 职责 |
|---|---|
| `crates/runtime/src/agent/ai/` | 模型通信：消息与 `ModelClient`、`OpenAiClient::deepseek` 流式接入（含 `reasoning_content`、`reasoning_effort`、429/5xx 退避重试与 `CancelToken` 请求取消、余额查询）、`models.rs` 目录与价目表 |
| `crates/runtime/src/agent/durable/` | 持久底座：可插拔 [`StorageBackend`](crates/runtime/src/agent/durable/storage/mod.rs)（`SeaOrmStorage` 含 SQLite `open_sqlite_read_only` 与 PostgreSQL、`MemoryStorage`、`JsonlStorage`：sidecar + commit marker + 崩溃截断 + `read_only` 快照）、合规测试套（[`conformance`](crates/runtime/src/agent/durable/conformance.rs)）、元数据遥测（[`telemetry.rs`](crates/runtime/src/agent/durable/telemetry.rs)：`pi.durable.submit/phase/entry/submission/checkpoint`）、任务树投影（[`graph.rs`](crates/runtime/src/agent/durable/graph.rs)：`TaskGraph`）、SQLite/Store → JSONL 全闭环与 `at_seq` 切片导出（[`export.rs`](crates/runtime/src/agent/durable/export.rs)）、`Scheduler`（恢复扫描、信号唤醒、级联 `abort_tree`、`restart_limit` 断路器）、分支 `fork_conversation` 与乐观并发 `tx.compact` |
| `crates/runtime/src/agent/core/` | 持久执行内核：`engine.rs` 六阶段状态机（`prepare` → `generate` → `tool_dispatch` → `tool_join` → `yield_check` → `follow_up_check`）与 Effect Sandwich；`doc.rs` 文档契约；`inbox.rs`（`WhenBusy::{Steer, Queue, Reject}`）；`pipeline.rs`（转写转换与 `tool_call_id` 配对）；`extension.rs` |
| `crates/runtime/src/agent/tools/` | 类型化工具：`TypedTool`、`TypedToolAdapter`、`ToolOutput`；`coding_tools`（`read`、`write`、`edit`、`bash`、`grep`、`find`、`ls`）；`read_only_tools`（`read`、`grep`、`find`、`ls`） |
| `crates/runtime/src/agent/compaction/` | 上下文压缩：默认 `LlmSummarizer`（`Compactor::with_llm`）、CJK 感知 token 估算、文件读写摘要持久化到 `FileOpsDoc`（`pi.file_ops`）与过期 `base_head` 丢弃 |
| `crates/runtime/src/agent/resources/` | 资源接入：技能（`skills.rs`：`default_skill_dirs`、`scan_skills`、`LoadSkill`）、上下文文件与提示词拼装（`prompts.rs`：`AGENTS.md` / `CLAUDE.md`）、MCP 客户端（`mcp/`：`mod.rs`、`client.rs`） |
| `crates/runtime/src/agent/codemode/` | QuickJS 确定性沙箱引擎：步数/内存/输出限额、确定性随机与虚拟时钟、调用与睡眠 `memo` 重放 |
| `crates/runtime/src/agent/extensions/` | 业务与实验扩展：`governance.rs`（权限门禁与 `PermissionRequested`）、`budget.rs`（树级花费 `tree_spend` 与 `BudgetExtension`）、`grader.rs`（独立只读验收、`ResponseFormat::JsonObject` 与围栏清理）、`memory.rs`（`MemoryPort`、`Remember`、`RewriteMemory`）、`todo.rs`（持久化到 `TodoDoc`）、`subagent.rs`（`SpawnAgent`、`owner_task_id` 与防嵌套）、`oar.rs`（`oar_list` / `oar_run` / `oar_steer` / `oar_stop`）、`codemode.rs`（`RunCode`） |
| `crates/runtime/src/agent/experiments/` | 实验开关：`ExperimentFlags { codemode, tree_branch, oar_delegate }`（默认全关），经 `mount_experiments` / `Harness::with_experiments` 按需挂载实验 `Extension` |
| `crates/runtime/src/agent/harness/` | 运行时挂架：`Harness`、`SharedExecution`、`ExtensionRegistry`、`Workers` 池与 `StandIn` 崩盘替身恢复 |
| `crates/runtime/src/agent/runtime/` | `vibevalley` 农机：照 oar 的 `Runtime` 契约，以 `worker:<session>` 跑在共享 `Harness` / `execution.db` 上，支持断点续跑、实时 `steer`、审批回复、`account_usage` 与子代理事件转发 |
| `crates/runtime/src/agent/eval/` | 评测闭环（对齐 `pi-durable` JSONL 与 `pi-coding-agent-eval`）：[`trace.rs`](crates/runtime/src/agent/eval/trace.rs) 只读轨迹分析 / 时间线 / 离线 HTML 导出、[`profile.rs`](crates/runtime/src/agent/eval/profile.rs) 实验配置（`vanilla` / `codemode`）、[`grader.rs`](crates/runtime/src/agent/eval/grader.rs) 代码 + 轨迹 + Rubric 验收器、[`replay.rs`](crates/runtime/src/agent/eval/replay.rs) L2 前缀切片隔离重放、[`suite.rs`](crates/runtime/src/agent/eval/suite.rs) L3 隔离工作目录与均衡顺序 `EvalRunner`、[`stats.rs`](crates/runtime/src/agent/eval/stats.rs) `pass@k` / `pass^k` 与成对对比统计 |
| `crates/server/src/agent/orchestrator/mod.rs` | 助手：每个助手档案一个对话（共享 SQLite `execution.db`），带农场的工具 |
| `crates/cli/src/domains/collab/chat.rs` 与 [`vibevalley_eval.rs`](crates/cli/src/bin/vibevalley_eval.rs) | `vibevalley chat`：在终端经 HTTP 与频道助手对话；可选二进制 `vibevalley-eval`（`--features eval`，`export` / `inspect` / `replay` / `run`）：SQLite→JSONL 提取、时间线/HTML 检视、切片重放与评测套运行 |

内置农机与助手均使用档案的 MCP 配置。一个连接上的工具共用会话和后台运行时。连接和请求限时 120 秒。用户叫停调用时，客户端取消在途请求。其他工具仍可使用该连接。最后一个工具和连接持有者释放后，SDK 关闭标准输入并回收子进程。[客户端](crates/runtime/src/agent/resources/mcp/client.rs)

助手按档案复用连接。同一轮生成和工具调用共用工具列表。档案变更后，下一次读取工具时使用新配置。`disallowedTools` 中的 MCP 工具不进入模型的工具列表，其他 MCP 工具仍由执行层判定权限。[档案连接](crates/server/src/agent/orchestrator/mcp.rs)

## 模型和不变量

- **只接 DeepSeek**：模型目录在 `ai/models.rs`（`deepseek-flash`、`deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner`）；钥匙每次请求现取（设置里的优先）。帮工的 effort 原样发成 `reasoning_effort`，没有 effort 不开思考；回带工具调用的回答时带回 `reasoning_content`。
- **六阶段持久状态机与九类崩溃恢复**：每次生成按 `prepare` → `generate` → `tool_dispatch` → `tool_join` → `yield_check` → `follow_up_check` 推进：
  - `generate` 落盘 `pi.assistant` 前崩溃则重试，落盘 `nextPhase` 后恢复直接跨 phase 不重复请求模型。
  - `pi.tool` 的只读工具（`ReplayPolicy::Safe`）中断后重跑且受 `restart_limit`（默认 5）断路器保护；已写入 `memo["output"]` 直接复用；会改东西的工具（`ReplayPolicy::Unsafe`）写入 `memo["started"]` 后崩溃不重放，附加 `git status --short` 给模型检查。
  - `steer` 在批量工具执行中于 `tool_join` 交付：为后续未开始调用补齐配对的 `skipped due to user steering` `pi.tool_result` 后跳回 `prepare`；`follow_up` 在 `follow_up_check` 提升为下一轮，全轮完成后才结算主提交。
  - `spawn_agent` 恢复沿用原有 `subagent:*` 对话与 `owner_task_id` 不二次派生，花费计入父对话 `tree_spend()`，取消先子后父级联。
  - `oar_run` 在 `open` 写入 `OarSessionDoc` 后崩溃恢复进 `run`；写入 `memo["turnStarted"]` 后崩溃不重发 prompt，返回 `{ interrupted: true, gitStatus, ... }`。
  - `pi.codemode` 崩溃后重放 JS，已 `memo` 的前序调用跳过不重跑，仅续跑未完成调用。
  - `compaction` 由 `LlmSummarizer` 压缩并写 `pi.file_ops`，过期 `base_head` 并发压缩静默丢弃。
  - `yield_check` 已写入 `pi.verdict` 后崩溃直接复用判定不二次调 grader；`StandIn` 在重启后即使动态扩展暂未重连也保留系统提示分段与工具签名，并在调用时返回可理解的错误说明。
- **OAR 双向对称**：外部应用与 CLI 经 `vibevalley-oar::Registry` 驱动内置 `vibevalley` 或外部农机（人 → OAR）；开启 `OarExtension` 后，内置 Agent 也可经 `oar_list` / `oar_run` / `oar_steer` / `oar_stop` 派生并级联控制外部 OAR 农机，外部 `Usage.cost_usd` 写入父任务树预算（Agent → OAR），并受 `allowed_runtimes`、`allowed_workdirs`、`max_concurrent`、`max_depth` 与同目录并发写入互斥约束。
- **两种宿主**：

| 能力项 | 助手 | 帮工（`vibevalley` 农机） | 帮手（`spawn_agent`） |
|---|---|---|---|
| 农场业务工具 | `team/tool` 给助手的那组 | 经 `/mcp` 挂的帮工工具 | 无 |
| 编码工具 | 无 | `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls`（Plan 模式为 `read`、`grep`、`find`、`ls`） | 同帮工 |
| 技能 | `<home>/agent/<id>/skills`（开机时放进内置的） | `~/.agents/skills`、`~/.claude/skills`、`<工作目录>/.agents/skills` | 无 |
| 任务图 | 无 | 有 | 有 |
| `spawn_agent` | 无 | 有 | 无（不嵌套） |

- **技能按需加载**：提示里只列名字和 160 字以内的简介，`load_skill` 时才读正文。
- **自己的任务**：`todo_add|update|list` 维护一张 DAG，持久化在 `vibevalley.todo` 文档中，加的时候全加或全不加。

## 内置帮工怎样核对验收条件

内置帮工完成带验收条件的工单轮次时，服务端读取本轮交付物。服务端核对厂商会话、业务轮次和工单的归属。评审输入由工单标题、描述、验收条件、帮工汇报、该工单的 Git 改动和 Artifact 组成。交付证据最多 16,000 个字符，超出时附截断标记。独立评审会话只收到评审指令和这份输入，工具列表为空，使用 `ResponseFormat::JsonObject` 约束并剥离代码块围栏。[输入边界](crates/server/src/agent/orchestrator/execution.rs) · [评审扩展](crates/runtime/src/agent/extensions/grader.rs)

评审未通过时，缺项回到同一工作轮次。默认最多评审三次。通过后，工单沿用帮工的结构化汇报或最终答复。仍有缺项时，轮次记为失败，摘要包含评审原因。帮工明确提问或报告阻塞时，工单先等用户回答。普通对话、起草轮次和没有验收条件的工单沿用原有结算流程。人工审查和 Git 合并仍由工单板负责。[服务端回归](crates/server/tests/orchestrator/grading.rs)

评审调用也受该会话的预算约束。服务端先保存当次证据，额度用完时暂停模型请求。上调额度后，帮工沿用原证据继续评审。在评审回复已落盘的轮次中，恢复时复用该次判定。[预算、评审与恢复回归](crates/runtime/src/agent/tests.rs)

## 为什么这样

- **以 Durable SQLite 为唯一执行底座，单向分层**：用 12 个单向分层的模块替代早年平铺的 `conversation.jsonl` 与硬耦合 `generation/` 循环；扩展通过 `Extension` 钩子与 `DocSpec` 接入核心状态机，互不污染全局上下文与权限边界。
- **反转 OAR 依赖并隔离实验能力**：`vibevalley-runtime::oar` 不再依赖 `vibevalley-runtime::agent`，外部农机、Code Mode 与树分支以 `ExperimentFlags` 按需挂载。
- **只接 DeepSeek**：农场默认的模型就是它；多厂商路由、价目表的完整语义没人用，砍掉。

## 还没做的

- 按档案 `toolsets` 分配工具、助手也能加载技能：`#52`。
- 原生界面手工触发压缩、普通对话入口创建 CodeMode 脚本任务与真模型阈值验收：`#55`。

## 怎么验证

- `crates/runtime/src/agent/tests.rs`：工具调用、SQLite 转写恢复、权限/预算/验收/帮手扩展、任务图、技能与记性、DeepSeek 流解析与价目、编码工具。
- `crates/runtime/tests/crash_recovery.rs`：真 SQLite 关库重开九类崩溃恢复回归（`generate`、`ReplayPolicy::Safe` / `restart_limit` / `memo`、`ReplayPolicy::Unsafe` + `git status`、`steer` / `follow_up`、`spawn_agent` / `tree_spend` / `abort_tree`、`oar_run`、`pi.codemode`、`compaction` / `file_ops` / 过期 `base_head`、`grader` / `StandIn`）。
- `crates/runtime/tests/oar_codemode.rs`：人 → OAR、内置 Agent → OAR（策略/花费/深度/并发/级联取消）、Code Mode 组合本地工具 + OAR 及 `ExperimentFlags::default()` 零挂载。
- `crates/runtime/tests/runtime.rs`：`vibevalley` 农机能力、模型目录、SQLite 崩溃恢复、Plan 只读工具、`ask` 审批闭环、`steer` 插话与 subagent 事件转发。
- `crates/runtime/tests/mcp.rs`、`tests/codemode_parity.rs`、`tests/durable_parity.rs`、`tests/storage_conformance.rs`、`tests/eval_harness.rs`：MCP 客户端、Code Mode、持久调度器对账、`SeaOrmStorage` / `MemoryStorage` / `JsonlStorage` / 自定义后端一致性，以及 `pi.durable.*` 遥测、`TaskGraph`、SQLite→JSONL 导出/切片、L2 切片重放与 L3 A/B 评测归因回归。
- `crates/cli/tests/cli.rs`：`vibevalley eval export/inspect/replay/run` 与 SQLite → JSONL → HTML 离线端到端检查。
- `crates/server/tests/orchestrator.rs`：助手在测试农场上照脚本回答。
