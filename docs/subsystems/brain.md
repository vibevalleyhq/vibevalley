# VibeValley 自己的 agent

助手和 `vibevalley` 农机的帮工跑在同一个自研的 agent 上：`crates/vibevalley-agent`。它替代了 TS 版从 pi-ai（DeepSeek 接入）和 pi-durable（循环、先落盘再显示、断点续跑、压缩）拿的东西，只接 DeepSeek（OpenAI 兼容的 chat completions），不做多厂商路由（[原生计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)「砍掉的」）。终端里也能经 `vibevalley chat` 直接和本机农机或助手对话。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 一个对话：模型客户端、工具、先落盘的转写（JSONL）、续跑、压缩 | 模型名称的选择和 DeepSeek 钥匙的存放（[档案和农机](docs/subsystems/agent.md)、[设置和配置](docs/subsystems/setting.md)） |
| 工具的形状（`Tool`：JSON Schema 加执行，会改东西的不重放）、编码工具 | 农场的业务工具（`crates/vibevalley-server/src/modules/tool/`）、跨档案的数据库记忆（[记性](docs/subsystems/memory.md)） |
| 技能按需加载、`MemoryPort`、MCP 客户端、自己的任务图、帮手（`spawn_agent`） | 输入什么时候送、一轮怎样记进会话（[助手](docs/subsystems/orchestrator.md)、[帮工](docs/subsystems/session.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/vibevalley-agent/src/conversation.rs` | `Brain`（模型、系统提示、工具、压缩门槛）与 `Conversation`：`send`、`resume`（接着跑没跑完的一轮）、`compact`、`abort_handle`；转写的每一条 `Entry` 先追加进 JSONL 再显示 |
| `crates/vibevalley-agent/src/model.rs` | 消息与 `ModelClient`；`OpenAiClient::deepseek` 读 DeepSeek 的流，含 `reasoning_content` 与 `reasoning_effort` |
| `crates/vibevalley-agent/src/tool.rs` | `Tool`、`ToolOutput`；`coding_tools`：`read`、`write`、`edit`、`bash`（工作目录是帮工的） |
| `crates/vibevalley-agent/src/kit.rs` | 技能（`default_skill_dirs`、`scan_skills`、`LoadSkill`）、记性（`MemoryPort`、`FileMemory`、`Remember`、`RewriteMemory`）、任务图（`todo_tools`）、帮手（`SpawnAgent`） |
| `crates/vibevalley-agent/src/mcp.rs`、`mcp/client.rs` | 档案挂的 MCP 客户端。官方 Rust SDK 管标准输入输出和流式 HTTP，应用保留工具名、只读提示和结果文字。 |
| `crates/vibevalley-agent/src/price.rs` | DeepSeek 的价目表，花费按它算 |
| `crates/vibevalley-oar/src/vibevalley.rs` | `vibevalley` 农机：照 oar 的 `Runtime` 契约，一个会话一个对话（`<会话>.jsonl`），按会话 ID 找回 |
| `crates/vibevalley-server/src/modules/orchestrator/mod.rs` | 助手：每个助手档案一个对话（`<home>/agent/<id>/conversation.jsonl`），带农场的工具 |
| `crates/vibevalley-cli/src/commands/chat.rs` | `vibevalley chat`：在终端直接驱动本机农机（含 `vibevalley`），或加 `--orchestrator` 在 `#general` 和助手对话 |

内置农机与助手均使用档案的 MCP 配置。一个连接上的工具共用会话和后台运行时。连接和请求限时 120 秒。用户叫停调用时，客户端取消在途请求。其他工具仍可使用该连接。最后一个工具和连接持有者释放后，SDK 关闭标准输入并回收子进程。[客户端](crates/vibevalley-agent/src/mcp/client.rs)

助手按档案复用连接。同一轮生成和工具调用共用工具列表。档案变更后，下一次读取工具时使用新配置。`disallowedTools` 中的 MCP 工具不进入模型的工具列表，其他 MCP 工具仍由执行层判定权限。[档案连接](crates/vibevalley-server/src/modules/orchestrator/mcp.rs)

## 模型和不变量

- **只接 DeepSeek**：模型是 `deepseek-flash`、`deepseek-v4-pro`；钥匙每次请求现取（设置里的优先）。帮工的 effort 原样发成 `reasoning_effort`，没有 effort 不开思考；回带工具调用的回答时带回 `reasoning_content`。
- **先落盘再显示**：输入、每次回答、每个工具开跑（`ToolStarted`）和结果都先追加进转写。进程在一轮中间停掉，重开时 `resume` 接着跑完：只读的工具重跑，会改东西的工具不重放，模型读到它被打断。
- **压缩**：一次请求的提示到 12 万 token（`compact_at`）先压缩：让模型写一段摘要，之前的条目在读回时由 `Compacted` 的摘要代替，这一轮的输入保留。
- **两种宿主**：

| 能力项 | 助手 | 帮工（`vibevalley` 农机） | 帮手（`spawn_agent`） |
|---|---|---|---|
| 农场业务工具 | `modules/tool` 给助手的那组 | 经 `/mcp` 挂的帮工工具 | 无 |
| 编码工具 | 无 | `read`、`write`、`edit`、`bash` | 同帮工 |
| 技能 | `<home>/agent/<id>/skills`（开机时放进内置的） | `~/.agents/skills`、`~/.claude/skills`、`<工作目录>/.agents/skills` | 无 |
| 任务图 | 无 | 有 | 有 |
| `spawn_agent` | 无 | 有 | 无（不嵌套） |

- **技能按需加载**：提示里只列名字和 160 字以内的简介，`load_skill` 时才读正文。
- **自己的任务**：`todo_add|update|list` 维护一张 DAG，加的时候全加或全不加。

## 内置帮工怎样核对验收条件

内置帮工完成带验收条件的工单轮次时，服务端读取本轮交付物。服务端核对厂商会话、业务轮次和工单的归属。评审输入由工单标题、描述、验收条件、帮工汇报、该工单的 Git 改动和 Artifact 组成。交付证据最多 16,000 个字符，超出时附截断标记。独立评审会话只收到评审指令和这份输入，工具列表为空。[输入边界](crates/vibevalley-server/src/modules/orchestrator/execution.rs) · [评审阶段](crates/vibevalley-agent/src/generation/grading.rs)

评审未通过时，缺项回到同一工作轮次。默认最多评审三次。通过后，工单沿用帮工的结构化汇报或最终答复。仍有缺项时，轮次记为失败，摘要包含评审原因。帮工明确提问或报告阻塞时，工单先等用户回答。普通对话、起草轮次和没有验收条件的工单沿用原有结算流程。人工审查和 Git 合并仍由工单板负责。[服务端回归](crates/vibevalley-server/tests/orchestrator/grading.rs)

评审调用也受该会话的预算约束。服务端先保存当次证据，额度用完时暂停模型请求。上调额度后，帮工沿用原证据继续评审。在评审回复已落盘的轮次中，恢复时复用该次判定。[预算与恢复回归](crates/vibevalley-agent/src/generation/tests.rs)

## 为什么这样

- **自己写循环，不追 pi-durable**：要的只是先落盘、续跑、不重放会改东西的工具和压缩，几百行 Rust 就够；省掉 Node 运行时和上游版本的锁定。
- **只接 DeepSeek**：农场默认的模型就是它；多厂商路由、价目表的完整语义没人用，砍掉。

## 还没做的

- 按档案 `toolsets` 分配工具、助手也能加载技能：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `crates/vibevalley-agent/src/tests.rs`：工具调用的一轮、转写经重开喂给下一轮、没跑完的一轮续跑且不重跑会改东西的工具、中断、压缩、DeepSeek 流的读法与请求体、价目、编码工具、技能、记性、任务图、帮手不被重放两次。
- `crates/vibevalley-agent/tests/mcp.rs`：MCP 客户端。
- `crates/vibevalley-server/tests/orchestrator.rs`：助手在测试农场上照脚本回答。
