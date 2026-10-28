# VibeValley 自己的 agent

VibeValley 自己的 agent（代码里是 `Brain`）是农场里唯一一个从模型请求到工具循环都由我们自己写的 agent，在两个包里：`packages/ai`（`@vibevalley/ai`，模型）和 `packages/agent`（`@vibevalley/agent`，循环和 Brain）。它只接 DeepSeek 的 `chat/completions`，跑在服务端进程里，服务端只组装它。同一份代码有四种用法：管家（[管家](docs/subsystems/orchestrator.md)）、农机 `vibevalley` 上的帮工（[帮工](docs/subsystems/session.md)）、命令行里直接聊、它自己派出的帮手。别的农机（claude、codex、pi……）是别家的程序，农场经 oar 驱动它们，它们的内部不在本篇。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 向模型发请求、读回流（`@vibevalley/ai`） | 用哪个模型、钥匙从哪来（档案和设置：[档案和农机](docs/subsystems/agent.md)、[设置](docs/subsystems/setting.md)） |
| 一轮的循环：问模型、跑工具、再问；插话、追问、叫停（`@vibevalley/agent/core/loop`） | 一条输入什么时候交进来、算不算主人的话（宿主：管家的意图表、oar 的会话） |
| 对话文件、提示的开头、压缩、接着做被打断的一轮 | 一轮记成 Run 和日志、话写进哪个频道（`session/host.ts` 的 `AgentHost`，[帮工](docs/subsystems/session.md)） |
| 自己带的工具：技能、记性、旧账、帮手、提醒、自己的任务、编码工具、MCP 客户端 | 农场的工具（派活、工单、频道……，`tool`，[管家](docs/subsystems/orchestrator.md)） |
| 记性文件 `MEMORY.md` 和旧账 `archive/` 的读写 | 帮工档案的记性、外面的记性来源（[记性](docs/subsystems/memory.md)） |
| | 包成 oar 的农机 `vibevalley`（server 的 `runtime/vibevalley.ts`）、`/v1/chat/completions`（`orchestrator/openai.ts`）、自己的任务存进库（`agent/taskStore.ts`）、给主人看的话；农机的探测、额度、花费（[档案和农机](docs/subsystems/agent.md)、[帮工](docs/subsystems/session.md)） |

## 在哪

三层，下层不认识上层，lint 的 `no-restricted-imports` 查（根目录 `vite.config.ts`）：`packages/ai` 不 import `@vibevalley/agent`；两个包都不 import 应用、`@vibevalley/i18n`、`@vibevalley/protocol`；`core/` 不 import Brain 的文件。

```
apps/server  组装和适配（不在包里）：
             session/host.ts 的 AgentHost（管家）  runtime/vibevalley.ts（农机 vibevalley：帮工）
             cli/chat.ts（命令行）                 orchestrator/openai.ts（/v1/chat/completions）
             agent/taskStore.ts（自己的任务存进库）  agent/model.ts（缺钥匙时对主人说的话）
               │ openBrain(owner, BrainOptions)
packages/agent  Brain：对话文件、提示开头、压缩、自己的工具、帮手、提醒、自己的任务
               │
packages/agent/src/core  一轮的循环：模型 ⇄ 工具，steer / followUp / abort；Tool 和建工具的函数
               │ Llm.stream / complete
packages/ai  DeepSeek chat/completions：请求体、流、工具参数、模型表、ModelClient
```

两个包都按文件导出（`package.json` 的 `"./*": "./src/*.ts"`）：`@vibevalley/ai/messages`、`@vibevalley/agent/core/loop`、`@vibevalley/agent/brain`。

- **`packages/ai`**：`models.ts` 模型表和价格；`client.ts` 的 `ModelClient`（模型、传输的服务、每次请求前现取的钥匙）、`deepseek`、`complete`、`defaultModel`，没钥匙时抛 `MissingKey`（服务端的 `agent/model.ts` 把它说成主人看得懂的话）；`llm.ts` 的 `Llm` 服务发请求、读流；`request.ts` 拼请求、`response.ts` 读流，都是纯函数；`messages.ts` 消息和事件的形状，照 pi-ai；`tools.ts` 由 Effect Schema 生成给模型看的 JSON Schema（`parametersOf`），先改正模型给的参数类型（`coerceArguments`）再交给 Schema 读。`testing.ts` 是照脚本回答的 `Llm`。黄金数据在 `testdata/`。
- **`packages/agent/src/core`**：`loop.ts` 是循环（`make`）。一轮是 agent 作用域里的一条纤程。叫停是一个 `Deferred`，模型的流、`prepareRequest` 和工具都和它赛跑；一次回答里的几个工具同时跑。事件的种类和次序照 pi-agent-core 的 `Agent`。`tool.ts` 把 Schema 写的工具接到循环上（`schemaTool`、`effectTool`），农场的工具表（`tool`）也用它。
- **`packages/agent/src`**：
  - `brain.ts`：`Brain`，以及给 Promise 代码用的 `openBrain`、`BrainHandle`、`standaloneOwner`。
  - `session.ts`：对话文件。`compaction.ts`：压缩。`prefix.ts`：开头按段算哈希。`messages.ts`：自己加的两种消息（`custom`、`compactionSummary`）。`run.ts`：一轮的用量和字（`RunResult` 只带模型自己说的错，主人看的话由宿主说）。
  - 自己的工具：`self.ts`（`load_skill`、`remember`、`rewrite_memory`、`search_archive`、`spawn_agent`），`skills.ts`，`memory.ts`，`mcp.ts`（MCP 客户端和 `mcpServers` 配置），`reminders.ts`（`reminder`、`list_reminders`、`cancel_reminder`），`agentTask.ts`、`agentTaskStore.ts`（接口和内存里的存储）、`agentTaskTools.ts`（`todo_add`、`todo_update`、`todo_list`），`coding.ts`（`read_file`、`write_file`、`edit_file`、`list_dir`、`grep`、`bash`、`web_fetch`）。`coding.ts`、`mcp.ts` 要起子进程，只用 `core` 的地方不加载它们。
  - `dag.ts`：先后的规则（查环、分层），种植计划（`task/graph.ts`）也用。`realTime.ts`：杀子进程和 MCP 超时用的真实时间，包里唯一能碰墙上时钟的文件。
  - `prompts.ts`：对模型说的话，中文；`core/prompts.ts` 是工具结果的那几句。`testing.ts`：照脚本回答的大脑（`withAgent`、`scriptedLLM`）。
- **家目录**（`BrainOptions.home`）：对话 `<session>.jsonl`、`MEMORY.md`、`archive/`、`reminders.json`、管家的 `evals/`。管家的在 `$VIBEVALLEY_HOME/agent/<档案 id>/`（`agentHome`），帮工的在 `$VIBEVALLEY_HOME/helpers/`（对话按 oar 的会话 id 分文件，不带记性），命令行的在 `~/.vibevalley/agent/<名字>/`。

## 模型和不变量

### 四种用法

`BrainOptions` 决定一个 agent 带什么。四个宿主这样配：

| | 管家 | 帮工（农机 `vibevalley`） | 命令行 | 帮手（`spawn_agent`） |
|---|---|---|---|---|
| 说明（`instructions`） | 管家的系统提示，[管家](docs/subsystems/orchestrator.md) | `helperInstructions`，加上档案的人设和技能（追加或替换） | 命令行的说明 | 派它的 agent 的名字和规矩 |
| 农场的工具 | `Tools` 管家那张表 | 经 MCP 接 `/mcp`（帮工那张表） | 无 | 和派它的一样 |
| 编码工具 | 无 | 有 | 有 | 和派它的一样 |
| 技能（扫目录） | 无（`noSkills`） | 有 | 有 | 和派它的一样 |
| 记性 | 有 | 无 | 有 | 无 |
| 帮手 | 无 | 有 | 有 | 无（不能再派） |
| 提醒 | 无 | 无 | 交互时有 | 无 |
| 自己的任务 | 无 | 有（存库里，按会话） | 有（内存里） | 无 |
| 对话文件 | 有 | 有（按会话） | 有 | 无 |

工具表在大脑建好时定下：宿主给的、MCP 的、自己的、提醒的，最后去掉 `disallowedTools`。轮与轮之间不增减，增减会打破提示的开头。

### 提示分三段

| 段 | 放什么 | 什么时候变 |
|---|---|---|
| 开头 | 工具定义；系统提示按段：说明（`instructions`）、`## 环境`（只有工作目录）、技能清单（`skills`）、记性的快照（`memory`），空的段不写 | 大脑起来时、每次压缩以后（`refreshPrefix`） |
| 对话 | 对话文件里的消息 | 每条消息 |
| 最新那条输入 | 宿主拼的这次的话；两次压缩之间变了的东西（时间、现状、记性的变化 `memoryNews`）都放在这里 | 每条输入 |

- **开头在两次压缩之间一字不变。** DeepSeek 按前缀缓存，从第一个不同的字起全价。每次请求都按段（`instructions`、`env`、`skills`、`memory`、`tools`）算 sha256，和上一次比；两次压缩之间哪段变了就发 `prefix_changed`，宿主把它写在用量那一行后面。哈希只在内存里，重启后的第一次请求不比。
- **记性的快照**：`MEMORY.md` 一行一条，快照最多 8000 字（`memoryPromptChars`），超了从上面截，留最新的。快照以后记下、忘掉的，`memoryNews` 按文件的行算出多了的（`+ `）和没了的（`− `），交给宿主放进下一条输入，给过的不再给。

### 对话文件

- 一条消息一行，只往后加（`SessionFile`）。消息在交出它的 `message_end` 之前写下。
- 压缩追加一行 `compactionSummary`：读回来时，它代替它前面除最近 `kept` 条以外的全部消息。压掉的原文按字存进 `archive/`，`search_archive` 能翻。
- 被关掉打断的一轮，取消造出的消息（截断的回答、工具的「停了」）不写；文件停在被打断的地方，和崩溃一样。

### 输入、插话和叫停

- `send`：闲着就开一轮；在跑就插进这一轮（`steer`，下一次请求前进去）。`later`：闲着就开一轮；在跑就等这一轮要停时再进（`followUp`）。`ask`：交进去，等它开的或加入的那一轮说完。
- 一轮最多 40 步（`maxSteps`，帮手 30），到了就停。
- `stop`：叫回在做自己任务的帮手，清掉排着的输入，停掉在跑的模型请求和工具。
- 一轮结束（`agent_settled`）带着这一轮的字、用量、上下文大小、有没有被叫停或出错（`RunAccounting`）。

### 压缩

1. 一次请求估出超过预算（`contextTokens`，默认 12 万 token），在这次请求前压（`prepareRequest` 里），这一轮停下时把摘要写进对话文件。
2. 一轮停下时超过预算的八成（`idleFoldAt`），开一个 10 分钟（`idleFoldAfterMs`）的计时器，有新输入就取消。到点时在忙、有排着的输入，或宿主说马上会被叫醒（`wakeSoon`），就不压；摘要做出来时对话变了，这份丢掉。
3. 摘要用和平常一样的开头和工具，消息是全部对话加一句「就地写摘要」，`toolChoice` 是 `none`；出错、为空或调了工具，退回单独的摘要请求。
4. 切点在一条用户的话开头，最近 12 条（`keepRecent`）原样留下，再往前挪到留下至少 3 条带字的回答（`keepSaid`）；挪到头或留下的超过预算一半，就不压。
5. 压完重拼开头。有自己的任务时，任务图接在摘要后面带过去。

### 接着做被打断的一轮

`unfinished` 看对话的最后一条：用户的话、`custom`、没被叫停的工具结果，或带工具调用的回答，就是没做完；被叫停的、出错的、模型说完了的，是做完了。`resume(maxAgeMs)` 给最后那个回答里没有结果的调用各补一条失败的结果（「服务端在这个工具做完之前重启了，不知道它做没做成……」），写进文件，再接着跑。最后一条比 `maxAgeMs` 旧就不接。什么时候调它由宿主定（管家开机时，30 分钟）。

### 自己带的东西

- **技能**：扫 `skills` 给的目录（默认 `~/.agents/skills`、`~/.claude/skills`、工作目录的 `.agents/skills`），每个子目录一份 `SKILL.md`，读它 frontmatter 的 `name`、`description`，同名的取先扫到的。系统提示只列名字和说明（每条最多 160 字），正文等模型调 `load_skill` 时才读。档案在技能书里勾的技能不走这里，由帮工的说明带进去（[帮工](docs/subsystems/session.md)）。
- **记性**：`remember` 往 `MEMORY.md` 加一行（带日期），`rewrite_memory` 整份重写，`search_archive` 在旧账里搜。
- **帮手**（`spawn_agent`）：起一个同样配置的大脑，不带记性、对话文件和提醒，不能再派帮手，最多 30 步，把它最后说的话交回。
- **自己的任务**（`AgentTask`，和计划里的一件不是一回事）：每件写明做什么（`brief`）、等哪几件（`after`）、谁做（`self` 或交给帮手的 `subagent`）、状态（`waiting`、`working`、`done`、`failed`、`skipped`）和结果。一张图最多 30 件；`todo_add` 整批收或整批不收，回给模型的话说清是哪一条；只有没开始和没做成的能改正文和先后。交给帮手的在它等的都做完以后自动派，最多三个同时做，结果交回；失败重来 1 次；叫回或进程没了，在做的退回等着。一轮停下时还有能做的，提醒它，图不变时最多提醒 3 次。存储：农机 `vibevalley` 的会话存在表 `agent_task`，按会话（`keeper`）分开，做完的盖上 `finished_at`；命令行的在内存里。它不进工单、不进核心状态。
- **提醒**：`reminders.json`，一次（`at`）、每隔几分钟（`every_minutes`）或 cron（本机时区）。每 20 秒看一次，到点的以 `custom` 消息经 `later` 交进来；不在的时候错过的，回来只跑一次。
- **MCP**：照 Claude Code、Cursor 的 `mcpServers` 写法（`command`/`args`/`env` 或 `url`/`headers`），只用 `initialize`、`tools/list`、`tools/call`。连不上的那台不带，原因由 `mcpStatus` 说，别的照样带。工具名是 `<服务>__<工具>`（非字母数字换成 `_`，最多 64 字），说明前面写着来自哪台服务。

### 作用域

`Brain.make` 是作用域里的资源，方法都是 Effect。作用域关了，在跑的一轮、派出去的帮手、提醒和闲时的压缩跟着停。Promise 代码（oar 的农机、管家的宿主、命令行）经 `openBrain` 用它：Effect 跑在那个服务的纤程上，大脑的作用域是那个服务作用域的子作用域，服务关了大脑最晚跟着关。`close` 只关一次，重复调用等同一次。

## 怎么走

**一条输入**：宿主调 `send` 或 `later` → 循环开一轮或把它排进这一轮 → 每次请求前 `prepare`：需要时压缩，取开头和工具表，比较开头的哈希 → `@vibevalley/ai` 发请求、读流，事件一条条交给宿主（字边长边给） → 模型调了工具就跑，结果进对话，再问 → 模型不再调工具，或到了步数上限 → `agent_settled`。

**农机 `vibevalley` 上的一个帮工**（server 的 `runtime/vibevalley.ts`）：oar 每开一个会话，`start` 取当时的钥匙和模型（`llm(model)`，存了的钥匙马上生效），拒绝它接不了的选项（`launchArgs`、`serviceTier`，和不在 `high`、`max` 里的思考强度），起一个大脑；oar 的 `prompt`、`steer`、`queue`、`withdraw`、`abort` 对到 `send` 和自己的排队上；大脑的事件写成 oar 的事件（字、想法、工具的始末、压缩、用量）；一轮结束是 `agent_settled`。

**OpenAI 的协议**（server 的 `orchestrator/openai.ts`，挂在 `POST /v1/chat/completions`）：只读最后一条 `user` 的话，对话由 agent 自己记着；只回字，不带用量。谁能问由挂它的一方定（[管家](docs/subsystems/orchestrator.md)）。

## 和谁打交道

- **宿主**：管家经 `AgentHost`（[帮工](docs/subsystems/session.md)），农机 `vibevalley` 经 oar，命令行经 `standaloneOwner`。宿主给说明、工具、MCP、家目录和工作目录，订阅事件（`subscribe`），决定输入怎么交、什么时候 `resume`。
- **`@vibevalley/ai`**：`Llm` 服务。钥匙每次请求前现取（`ModelClient.apiKey`）。
- **农场的工具**：管家的来自 `tool`；帮工的经 MCP 从 `/mcp` 来，和别的农机上的帮工一样。
- **库**：只有自己的任务（`agent_task`）。对话、记性、提醒是家目录里的文件。

## 为什么这样

- **自己写 agent，管家和帮工用同一份代码，模型和循环也自己写。** 只用一家模型（DeepSeek 的 `chat/completions`）和一个循环，所以照 pi-ai、pi-agent-core 的接口、形状和事件次序，用 Effect 重写成 `@vibevalley/ai` 和 `@vibevalley/agent/core`：叫停、插话、等一轮完是纤程和 `Deferred`，不用在库的回调里对齐时机；测试用照脚本回答的 `Llm`。和 pi 的一致由从 pi 录下的黄金数据（请求体、流读出的消息、参数的改法）和钉住循环的 `loop.test.ts` 守着；代价是 DeepSeek 的新东西要自己跟。pi-ai 只剩 `runtime/price.ts` 给 pi 农机算钱用它的价目。放弃的路：
  - 包一层 Effect、把 pi 留在里面：中间的适配一直要维护，叫停和插话的时机还是库的。
  - Effect 自带的 `effect/ai` 和 `@effect/ai-openai-compat`：标着 unstable；compat 不发 DeepSeek 的 `thinking`、`reasoning_effort`，不读 `prompt_cache_hit_tokens`；`LanguageModel` 默认替你跑工具；`Chat` 的历史和我们的压缩、提示开头互相冲突。
  - 照搬整个 pi-ai：十几家模型、OAuth、价目表，只是多维护。
  - nanobot（Python，自己的总线和渠道会和频道、连接器重复），Vercel AI SDK、LangChain.js（压缩、前缀缓存和取消都要绕过它们）。
- **模型和 agent 各是一个包，服务端只组装。** 服务端有几处只要模型（工具参数的 JSON Schema、价目），不要 agent，所以 `ai` 单独一个包；循环和 Brain 在一个包里，用子路径 `core` 和 lint 分开，不再多一个包。包里不 import 农场的任何东西（应用、给主人看的话、和页面的契约），给主人看的话由服务端说（`MissingKey`、`RunResult.failed`）。放弃了留在 `apps/server/src` 里靠约定（外溢没有检查挡）；放弃了把 `openai.ts`、存进库的任务存储、oar 的适配放进包（它们是管家的入口、农场的库和农场驱动农机的方式）。测试共用的黄金数据、等待和测试金字塔在 `packages/testkit`，金字塔跟着 `@vibevalley/*` 的 import 进包里，服务端的测试经包碰到子进程照样算模块测试。
- **大脑放在服务端进程里。** 它要和档案、计划、频道一起长；管家常驻、电话里插话、提示开头不变，外部农机做不到。
- **一份 `BrainOptions` 配出四种用法，不写四个 agent。** 管家和帮工的差别是带什么（工具、记性、帮手、提醒），不是两套循环。按档案配工具集（`toolsets`）以后也落在这里。
- **提示开头在两次压缩之间不变。** 系统提示里放秒级时间、每次重读的记性、现状，每次请求都从第一段起命不中。放弃了「时间改成到天」（现状和记性照样常变）；放弃了「现状做成每次请求都换、不存下的最后一条」（一轮里每调一次工具就全价带一遍完整现状）。
- **空闲时压缩，用同一个开头。** 一轮结束马上压，主人一分钟后接着问时拿到的已经是有损的摘要；等 10 分钟，主人多半走开了。摘要请求复用开头才读得到缓存；代价是压缩后的对话长一点。
- **技能只在提示里列名字，正文按需读。** 一百个技能的代价是一百行，不是一百个文件；模型知道有什么，用到时再读。
- **重启后接着做完那一轮，不上工作流引擎。** 一轮已经一步一步写进对话文件，读回来就知道停在哪；为本机的单用户服务起 Temporal 太重。做到一半的工具不重跑，告诉模型「不知道做没做成」，让它先查再做。正常关掉时不写取消造出的消息，否则重启后分不出是被叫停的还是被关掉的。
- **工具全部放进提示，不按需加载。** 管家二十几个工具、每个描述不到 500 字，一起放进去代价小；按需加载要多一次读工具的往返。
- **DeepSeek 的工具调用不如 Claude 稳**，靠步数上限和坏参数时给模型一句看得懂的错兜住。

## 还没做的

- 按档案配工具集（`toolsets`）；技能由一个 `skill` 模块发现，管家也带；主人用 `/` 叫技能：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `packages/agent/src/brain.test.ts`：跑工具、回结果、工具失败告诉模型为什么；`send` 插话、`later` 排队；步数上限；接着原来的会话；压长对话；技能；帮手同时干活；提醒到点叫醒；压缩之间系统提示不变、记性的变化放进输入；压缩后重做系统提示；叫停正在跑的一轮和正在跑的工具；工具变了算前缀变了；闲着时压缩开头一样；该写摘要却调了工具就再要一次；快被叫醒时不压；压缩留下最后几句；不给的工具在拼好以后才去掉。
- `packages/agent/src/loop.test.ts`：循环的事件次序、截断的调用、没有的工具和不收的参数、一轮一句、一起跑的工具的次序。`core/loop.test.ts`：同样的情形，外加流里、工具里、准备请求时叫停，模型出错、回答被截断、请求被拒，跑着时再开一轮被拒。
- `run.test.ts`：一轮的用量、字和失败。server 的 `runtime/vibevalley.test.ts`：农机 `vibevalley` 的一轮、插话、排队、撤回、中止、接着、MCP、失败；`orchestrator/openai.test.ts`：只取最新一句、照 OpenAI 的格式分块和结束；`agent/taskStore.test.ts`：自己的任务存进库。`agentTask.test.ts`：自己的任务。`declared.test.ts`、`tools.test.ts`：工具参数的 JSON Schema 逐字节不变。
- `packages/ai`：`deepseek.test.ts`、`tools.test.ts` 的请求体、流读出的消息、参数的改法，逐字对照从 pi-ai 录下的黄金数据（`testdata`，`vp run golden:update -- ai` 重写）；`llm.test.ts`：钥匙和地址、被拒的状态、断掉的流。
