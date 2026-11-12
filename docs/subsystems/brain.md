# VibeValley 自己的 agent

助手、`vibevalley` 农机的帮工、终端里的对话和帮工派出的帮手，都跑在上游的 pi-durable（`@earendil-works/pi-durable` 1.5.2）上：一个服务端开一个 `Harness`，一个会话一个 pi-durable 对话，模型是 pi-ai（`@earendil-works/pi-ai` 1.5.2）的 DeepSeek provider。`packages/agent` 只放这些对话用的我们自己的工具（技能、记性、MCP、自己的任务）和工具的形状。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 农场唯一的 `Harness`（`runtime/durable.ts`）：存储、注册一次的 DeepSeek、每个会话的对话、压缩的门槛 | 模型名称的选择和 DeepSeek 密钥的存放（[档案和农机](docs/subsystems/agent.md)、[设置和配置](docs/subsystems/setting.md)） |
| 我们的工具（`Tool`：JSON Schema 加 `execute`）怎样成为 pi-durable 的工具（`durableTool`） | 输入什么时候送、有没有用户的授权、一轮怎样记进 `session_run`（[助手](docs/subsystems/orchestrator.md)、[帮工](docs/subsystems/session.md)） |
| 每种宿主的扩展（提示的几段和工具），以及服务端重启后接着跑的一轮仍有它们 | 农场的业务工具（`apps/server/src/modules/tool`）、跨档案的数据库记忆（[记性](docs/subsystems/memory.md)） |
| 技能按需加载、`MemoryPort`、MCP 客户端、自己的任务图、帮手（`spawn_agent`） | 循环、工具并发、插话和排队、落盘、压缩、断点续跑（pi-durable 自己的） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/modules/runtime/durable.ts` | `openDurable`：开 `Harness`（`$VIBEVALLEY_HOME/durable.db`，测试农场在内存里），注册 `deepseek`（`deepseekAccess`），装上开机就要的扩展，替没装上的扩展站岗；`conversation(key, agent, init)` 按会话找回或新建对话；`durableTool`、`entryMessage`、`messageText` |
| `apps/server/src/modules/runtime/helperExtension.ts` | 帮工的扩展 `vibevalley.helper`（`makeHelpers`）：pi-durable 的 `read`、`write`、`edit`、`bash`，自己的任务、技能、记性和 `spawn_agent`；会话自己的部分记在对话的 `vibevalley.helper` 文档里 |
| `apps/server/src/modules/runtime/vibevalley.ts` | `vibevalley` 农机：照 oar 的 `Runtime` 契约，一个 oar 会话一个对话，出 oar 的事件；会话的 MCP 服务是它自己的扩展 `vibevalley.mcp.<会话>` |
| `apps/server/src/modules/session/host.ts` | 助手的宿主 `AgentHost`：扩展 `vibevalley.<会话>`（助手的工具、提示的几段），读对话的提交喂给 `journal` 和 `InProcessRun` |
| `apps/server/src/chat/chat.ts` | 终端里的对话：同一个农机，跑在 `agent/<名字>/durable.db` 的自己的 `Harness` 上 |
| `packages/agent/src/core/` | `Tool`、`ToolResult`、`runTool`、`schemaTool`（`tool.ts`），参数的 JSON Schema（`schema.ts` 的 `parametersOf`、`coerceArguments`），`ToolFailed` |
| `packages/agent/src/tools/`、`infra/` | `selfTools`（`load_skill`、`remember`、`rewrite_memory`）、`subagentTool` 的说法、技能目录扫描、`MemoryPort` 和 `MEMORY.md`、自己的任务图（`todo.ts`、`todoTools.ts`）、MCP 客户端（`mcp.ts`） |

方向（根目录 `vite.config.ts` 的 `no-restricted-imports` 守着）：`packages/agent` 不认识农场、词典和协议；`apps/server` 用它。

## 模型和不变量

### 模型边界

- `Harness` 开的时候把 pi-ai 的 DeepSeek provider 以 `deepseek` 注册一次（`deepseekAccess`）：每次请求从设置（终端对话从配置和环境）现取钥匙，`fetch` 是农场的；没有钥匙也照样注册，这一轮以「没有 DeepSeek 的密钥」（`server.agent.noDeepSeekKey`）失败，不会是 `no_model`。哪个宿主先让 `Harness` 接着跑，别的会话的一轮都找得到模型。
- 对话写 `{ provider: "deepseek", modelId }`，模型是 pi-ai 目录里的（`deepseek-flash`、`deepseek-v4-pro`），档案写的不在目录里就用 `deepseek-flash`。帮工的 effort `high`、`max` 就是 pi-ai 的 thinking level，原样发成 `reasoning_effort`；助手不思考（`thinkingLevel: "off"`）。失败的回答不重试（`retry.enabled: false`）。
- 纯工具的回答发回时 `content: null`、带回 `reasoning_content`；choice 里的 usage、迟到的工具 ID 都照读（`runtime/durable.test.ts` 用录下的 DeepSeek 流离线核对）。
- 花了多少：token 读 pi-ai 的 usage（缓存不算进 input），人民币由 `runtime/price.ts` 按它自己的 DeepSeek 价目表算，不用 pi-ai 目录里的价。

### 四种宿主

| 能力项 | 助手 | 帮工（`vibevalley` 农机） | 终端对话 | 帮手（`spawn_agent`） |
|---|---|---|---|---|
| 扩展 | `vibevalley.<会话>`，`makeHost` 装 | `vibevalley.helper`（`Harness` 开的时候装）加 `vibevalley.mcp.<会话>` | 同帮工 | 父对话的那几个 |
| 农场业务工具 | 助手的 `Tool` 表 | 经 `/mcp` 挂的帮工工具表 | 无 | 同父对话 |
| 编码工具 | 无 | pi-durable 的 `read`、`write`、`edit`、`bash`（工作目录是帮工的，`bash` 带会话的环境变量、默认 120 秒） | 同帮工 | 同父对话 |
| 技能（`SKILL.md`） | 助手自己的技能目录 | 帮工工作目录和家目录的技能目录 | 同帮工 | 同父对话 |
| 记性（`MemoryPort`） | 数据库 `memory` 表 | 无（由 `Session` 管） | `agent/<名字>/MEMORY.md` | 同父对话 |
| 自己的任务图 | 无 | 有（存 `runtime_todo` 表；只记 `self`） | 有（存内存） | 同父对话 |
| `spawn_agent` | 无 | 有（调用拥有的子对话） | 有 | 无（不嵌套） |
| 对话 | `durable.db` | `durable.db`（一个 oar 会话一个，`resume` 找回） | `agent/<名字>/durable.db` | 父对话的调用拥有的子对话 |

### 提示

提示由扩展的几段（`section`）拼成，每次请求前渲染；pi-durable 只把变了的那段作为系统条目记进转写、发给模型，所以缓存的前缀一直有效。助手的几段是指令、`## 环境`、技能目录、记性快照；记性快照到下次压缩前不变，期间的增减放在这一轮输入里（`memoryNews`）。帮工的几段是指令（记在对话的 `vibevalley.helper` 文档里）、工作目录、技能目录和记性。时间、农场现状这类每次都变的放在输入里，不放进提示。

### 压缩

pi-durable 自己压缩。模型的窗口按目录（100 万 token），一次请求在 12 万 token 处先压缩再问（`compaction.modelOverrides` 的 `reserveTokens`），后台压缩提前 32k 开始。助手读到 `pi.compaction` 条目时重新给出记性快照。

### 接着做被打断的一轮

- 输入、每次回答、每个工具调用先落进 `durable.db` 再显示；服务端在一轮中间停掉，重开以后 `Harness` 接着跑完它，`session_run` 里还是同一轮。会改东西的工具不声明 `replay: "safe"`，断在中间的调用模型读到 `interrupted`；`spawn_agent` 能重放（子对话照 `requestId` 找回）。
- 一个对话按名字选它的扩展，没装上的扩展 pi-durable 不报错、直接没有。所以扩展在任何一轮跑起来以前就在：
  - 帮工的 `vibevalley.helper` 在 `Harness` 开的时候装上；会话自己的部分不在内存里，从对话本身读：工作目录是对话的 `cwd`，指令、环境变量和 oar 会话的 ID 在对话的 `vibevalley.helper` 文档里（建对话的同一个提交写进去，帮手的子对话照抄一份），自己的任务按会话 ID 去 `runtime_todo` 表找。会话没重新打开时，这一轮照样有它全部的提示和工具。
  - 助手的扩展由 `makeHost` 装：助手开机时先给每个助手造好宿主（宿主造的时候就从对话里读回最新输入的去处），再让任何一个接着跑。
  - `openDurable` 开完以后，凡是有没跑完的一轮、却选了没装上的扩展的对话，就照它转写里最后给模型看的样子给那个扩展装一个替身：工具照旧在，调用时回一个失败的结果，说明它所在的会话还没重新打开；提示的那几段照它上次显示的样子不变。宿主装上真的扩展（同名）就替换它。帮工的 MCP 服务是会话自己的进程，会话没打开前它的工具就是这样回答的。
- 农机的会话被放下（`dispose`）时停下这一轮，和 oar 的约定一样；农场关门时例外：会话模块先调 `Durable.leave`，之后放下的会话让这一轮留在 `durable.db` 里，崩溃时也一样留着。开机时帮工那一侧看到对话还有没跑完的一轮，就用同一个 oar 会话再打开（`resume`，输入是 `goOn`：不进对话，那一轮就是这次的回合），答完记在原来那一轮上（[帮工的重启](docs/subsystems/session.md#重启)）。
- 终端对话不用服务端的 `durable.db`：pi-durable 没有跨进程的锁，它在 `agent/<名字>/` 下开自己的，开着时租着这个目录；同名的第二个对话只在内存里。

### 自己带的东西

- **技能按需加载**：扫技能目录下 `SKILL.md` 的 frontmatter，提示里只列名字和 160 字以内的简介，`load_skill` 时才读正文。帮工和终端对话扫的目录是 `~/.agents/skills`、`~/.claude/skills`、`<工作目录>/.agents/skills`（`packages/agent/src/tools/skills.ts` 的 `defaultSkillDirs`，`runtime/helperExtension.ts` 用它）。
- **记性**：`remember`、`rewrite_memory` 经 `MemoryPort`（服务端接 `memory` 表，终端对话接 `MEMORY.md`）。
- **帮手**：`spawn_agent` 开一个这次调用拥有的子对话，抄父对话的 agent、去掉 `spawn_agent`，它的回答就是结果。
- **自己的任务**：`todo_add|update|list` 维护最多 30 件的 DAG（`dag.ts` 查圈和缺的前置），全由自己做；帮工的图变了经 oar 的原始记录（`vibevalley/todos`）进轨迹。

## 怎么走

1. 宿主调 `conversation.submit`：闲时开一轮，忙时插进这一轮（`steer`）或排在后面（`followUp`）；`stop` 是 `abort`。
2. pi-durable 的 `pi.generation` 渲染提示、问模型，把工具调用交给各自的 `pi.tool` 任务，等它们的结果再问，直到回答。
3. 宿主 `watch()` 对话：助手把提交读成 `RunEvent`（开始、回答、工具开始和结束、一轮结束）喂给 `journal` 和 `InProcessRun`，农机照 oar 的契约出 `text_delta`、`tool_call_*`、`turn_ended` 和 `usage`。

## 和谁打交道

- **四个宿主**：助手 `session/host.ts`、农机 `runtime/vibevalley.ts`、终端对话 `chat/chat.ts`、`spawn_agent` 的子对话。
- **资源服务（`resource`）**：助手和帮工的 `resource_read` 经 `apps/server/src/resource/` 按会话的权限分页读 `vv://` 资源。
- **评测**：`vp run --filter @vibevalley/server evals` 在测试农场上照农场的样子跑助手的一轮（`testing/evals.ts` 的 `orchestratorTurn`：助手的宿主、它的提示和工具，经 pi-ai 问真的 DeepSeek），工具答的是用例录下的结果；要 `DEEPSEEK_API_KEY`、花钱，先问用户。

## 为什么这样

- **用上游的 harness，不自己写循环**：持久、断点续跑、压缩、子任务都是现成的，上游以后的新能力（并行工具、新的压缩）不用再追一遍。自己写的那一套不持久，重启后助手答不完这一轮（[计划](.agents/notes/proposed/architecture/2026-11-12-brain-on-upstream-pi-durable.md)）。
- **扩展在开机时就在**：pi-durable 只按名字找扩展，找不到就当没有；一轮在宿主重开以前接着跑时，没有提示和工具的模型会答错。能从持久状态拿到的（工作目录、指令、环境变量、任务）就从那里拿；只能活着才有的（MCP 服务的进程）明说用不了，不让工具消失。
- **DeepSeek 只注册一次**：哪个宿主先让 `Harness` 跑起来，别的对话都找得到模型；钥匙每次请求现取，存了新的立刻用上。
- **价目自己记**：花费按农场的价目表折成人民币，和 pi-ai 目录的价不绑在一起。

## 还没做的

- 按档案 `toolsets` 分配工具、统一技能发现并让助手也能加载技能：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。
- 评测换之前、之后的对照表，Postgres 的存储后端，oar 跟上 pi-durable 1.5 以后换回它的 runtime：[计划](.agents/notes/proposed/architecture/2026-11-12-brain-on-upstream-pi-durable.md)。

## 怎么验证

- `apps/server/src/modules/runtime/durable.test.ts`：pi-ai 的 DeepSeek provider 在 `Harness` 下对录下的 DeepSeek 流的读法和发法、钥匙每次现取、没有钥匙的说法。
- `apps/server/src/modules/runtime/vibevalley.test.ts`：农机的 oar 适配、编码工具、环境变量、帮手、MCP；一轮在会话重开前接着跑时 MCP 的工具回答用不了、提示不变。
- `apps/server/src/flows/restart.test.ts`：助手和帮工都答到一半时崩溃，重开后两个都答完，帮工那一轮有它的提示和工具；帮工答到一半时正常关门，重开后接着答完、记一轮。
- `apps/server/src/modules/orchestrator/evals.test.ts`：评测的判法、录下的用例，以及评测走的那条路（`orchestratorTurn`）离线跑一遍。
- `packages/agent/src/tools/tools.test.ts`、`todo.test.ts`、`declared.test.ts`：技能、记性、MCP、任务图，以及工具给模型看的样子不变。
- 测试农场的 `Harness` 问的是 `testing/deepseek.ts` 照脚本回答的 `deepseek`（`farm.deepseek.use(scriptedLLM(…).llm)`，`testing/model.ts`），不连网。
