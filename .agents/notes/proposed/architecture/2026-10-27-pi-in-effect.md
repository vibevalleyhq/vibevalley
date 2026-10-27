# Agent Note: pi-ai 和 pi-agent-core 用 Effect 重写：模型一层、循环一层，大脑整个进 Effect

Status: proposed

## Problem

服务端的 Effect 已经管到了外面的库的一次调用（[地基](docs/subsystems/foundation.md)），只剩大脑没收：它搭在 pi-agent-core 的 `Agent` 上，模型经 pi-ai 的 `streamSimple` 调，[地基](docs/subsystems/foundation.md#为什么这样)里写着「交界就是 pi-agent-core 的回调，收进来只是把交界挪进库里」。所以大脑一半在 Effect 外：

- **两套写法**：农场的工具是 `Effect.fn`，参数是 Effect Schema（`tool/schemas.ts`）；大脑自己的工具（`coding.ts`、`self.ts`、`reminders.ts`、`agentTaskTools.ts`、`mcp.ts`）是 async，参数是手写的 JSON Schema（`brain/tool.ts` 的 `objectSchema`），跑之前靠 pi-ai 的 `validateToolArguments`。工具交给 pi-agent-core 时，`effectTool` 再把 Effect 跑成 Promise。
- **停、等、排队在库里**：叫停是 `core.abort()` 加 `finishTurn` 里看 `signal`；插话、追问是 `steer`、`followUp`、`clearAllQueues`、`hasQueuedMessages`；一轮结束靠 `subscribe` 的回调和 `waitForIdle`。这些语义 Effect 本来就有（打断、`Queue`、`Deferred`），在库里就得一处一处对齐它的时机，测也只能经它的回调测。
- **模型的错和用量是库的**：DeepSeek 的请求、SSE 的解析、`prompt_cache_hit_tokens` 折成 `cacheRead`、按价目算钱都在 pi-ai 里；错误是它拼好的一句话，不是带 `_tag` 的错，退避也没有（`maxRetries` 是 0）。
- **测试经它的假模型**：8 个测试文件经 `agent/brain/testing.ts` 用 pi-ai 的 faux，脚本的形状是它的。

我们只用了 pi 很小的一块：一家模型（DeepSeek，OpenAI 的 `chat/completions` 协议）、一个循环。主人定了用 Effect 重写这两块，接口照 pi 的来。

## Proposal

两个 Effect 模块，概念和接口照 pi-ai、pi-agent-core（`Model`、`Context`、流式的事件；`Agent` 的 `prompt`、`continue`、`steer`、`followUp`、`abort`、`waitForIdle`、`prepareRequest`、`finishTurn`、事件），写法是 Effect 的。不用 Effect 自带的 `effect/ai` 和 `@effect/ai-openai-compat`，最多参考它们的接口。

### 模型：`apps/server/src/ai`（pi-ai 的那一块）

- **形状**：`Message`（`user`、`assistant`、`toolResult`，加上大脑自己的 `custom`、`compactionSummary`）、`AssistantMessage`、`ToolCall`、`Usage`、`Model`（价目、`compat`、`thinkingLevelMap`）都是 Effect Schema，字段照 pi-ai 的，对话文件（`session.ts` 一行一条）不用改格式。
- **服务**：`Llm`（`Context.Service`）的 `stream(model, context, options)` 是 `Stream<AssistantEvent, LlmError>`（文字、思考、工具调用的增量，最后是整条 `AssistantMessage`），`complete` 是它的结果。打断就是取消请求，不传 `AbortSignal`。
- **DeepSeek**：`HttpClient` 发 `chat/completions`，SSE 自己按行解（`Stream.splitLines`）。照 pi-ai 现在发的：`thinking: { type }`、`reasoning_effort` 按 `thinkingLevelMap`、助手消息带 `reasoning_content`（没有时是 `""`）、`max_tokens`、`stream_options.include_usage`、工具和 `tool_choice`；读的：思考、文字、按 index 拼的工具调用、`prompt_cache_hit_tokens` 折成 `cacheRead`、停的原因。钱按 `ai/models.ts` 的价目在这里算。
- **错**：`LlmError` 带 `_tag`（连不上、限流、钥匙、请求不对、服务端出错、读不懂回答），分类参考 `effect/ai` 的 `AiError`。退避是一个 `Schedule`，默认和现在一样不重试。
- **工具**：一个工具是名字、说明、Effect Schema 的参数和一个 Effect；给模型的声明由 Schema 生成（农场的工具已经这样，`tool/schemas.ts`），参数用 Schema 解，替掉 `validateToolArguments` 和 `objectSchema`。
- **测试**：`Llm` 的测试 layer 照脚本回答（一步一条：文字、思考、工具调用、出错、挂住），替掉 pi-ai 的 faux。
- **和 `brain/openai.ts` 共用线上的形状**：它对声网说的就是同一个 `chat/completions` 协议，请求和分块的 Schema 放一处。

### 循环：`apps/server/src/agent/loop`（pi-agent-core 的那一块）

- 一个 agent 是一个有作用域的资源（管家、帮工、子 agent 各一个），不是全局的服务：`Agent.make(options)` 在作用域里起来，作用域关了它跟着停。
- 接口照 pi-agent-core 的 `Agent`：`prompt`、`continue`、`steer`（这一轮里插话）、`followUp`（这一轮完了接着说）、`clearQueues`、`abort`、`idle`；`prepareRequest`（每次请求前：压缩、提示开头）、`finishTurn`（一轮工具做完：步数上限、被叫停）是返回 Effect 的钩子；事件照它的种类（`agent_start`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_end`、`turn_end`、`agent_end`）走一个 `Stream`。
- 写法：插话和追问是两条 `Queue`；一轮是一条纤程，`abort` 是打断它，正在跑的工具跟着被打断；一轮里的工具一起跑（`Effect.forEach` 的 `concurrency`，和现在 pi-agent-core 默认的 parallel 一样）；`idle` 是一个 `Deferred`。
- 大脑（`Brain`）整个是 Effect：交界只剩两处，oar 的 runtime（`runtime.ts`，oar 的接口是 Promise）和终端里的对话（`cli/chat.ts`），在那里跑成 Promise。

### 次序：一步一个 PR，每步服务端和页面的测试都过

1. **模型**（做了）：pi-ai 的行为录成了黄金数据（`ai/testdata/deepseek.jsonl.gz`：9 个请求体、8 段流读出的消息），新的 `Llm` 逐字段一样。服务端经它发请求：pi-agent-core 的 `streamFn` 换成 `config.ts` 的 `llmStreamFn`（`Llm` 跑在拥有大脑的服务的纤程上，请求的 signal 打断它），`complete()` 跟着换了；命令行和真模型的评测用 `cli/llm.ts`。测试的假模型留到第 3 步：大脑的测试那时要连着循环一起改。
2. **工具的参数**（做了）：大脑自己的工具（编码、自己、提醒、任务）的参数是 Effect Schema，`schemaTool` 读；给模型看的 JSON Schema 由它生成，和原来逐字节一样（`agent/brain/testdata/declared.json`）。pi-ai 的 `validateToolArguments` 会先把参数改成对的类型（`"10"` 成 10、`true` 成 1、可选字段的 `null` 去掉），照它录了 47 条（`ai/testdata/arguments.jsonl.gz`），`ai/tools.ts` 的 `coerceArguments` 一样；`mcp/mcp.ts` 换成它。工具的身体还是 Promise：大脑还在 Promise 一侧，身体改成 Effect 要给它一个跑的地方，留到第 3 步和循环一起。
3. **循环**（做了）：先把原来的循环钉成测试（`agent/brain/loop.test.ts`：事件的次序、截断的调用、没有的工具和不收的参数、一轮一句、一起跑的工具的次序）；再写 `agent/loop`（`agent.test.ts` 跑同样的情形，外加流里叫停、工具里叫停、`prepareRequest` 里叫停、叫停以后不再开工具、模型出错、经线路的回答被截断、跑着时再开一轮被拒；参数不收时的话照 pi-ai 一字不差，`ai/tools.ts` 的 `toolArguments`）。然后 `Brain` 换到了它上面：`LLM` 带着 `Llm` 服务和拥有大脑的服务的纤程（`run`），`llmStreamFn` 去掉了；工具是循环的 `Tool`，身体是 Effect（`effectTool`）或包一层 `Effect.tryPromise` 的 async（`textTool`、`schemaTool`）；压缩是 Effect，叫停时连带打断摘要的请求，不再把半截的摘要存下。大脑的测试和管家、执行的测试换到了 `ai/testing.ts` 照脚本回答的 `Llm`，`loop.test.ts` 的断言一字没改。`Brain` 对外还是 Promise 的类：它的跑法是主人那边服务的纤程，那些纤程没了，跑着的一轮跟着停。
4. **收尾**：`Brain` 对外的方法换成 Effect（`runtime.ts`、`cli/chat.ts`、执行的宿主在交界处跑成 Promise）；`apps/server` 不再依赖 pi-agent-core（代码里已经不 import 它）；pi-ai 只剩 `runtime/price.ts` 给 pi 的农机算钱用它自带的价目（[地基](docs/subsystems/foundation.md)、[管家](docs/subsystems/orchestrator.md)、AGENTS.md 和 `apps/server/README.md` 已经跟着第 3 步改了）；用真模型跑一遍管家的评测；本 Note 沉淀以后删掉。

## Alternatives considered

- **不动**（[地基](docs/subsystems/foundation.md#为什么这样)的决定：大脑留在 Promise 一侧）：交界确实只是 pi-agent-core 的回调，可上一步把工具收进 Effect 以后，大脑成了唯一一块还要人对齐停、等、排队时机的地方，工具也还是两种写法。本 Note 取代地基里「大脑没有收」那一句，和[管家](docs/subsystems/orchestrator.md#为什么这样)里「循环、工具调用、流式交给 pi-agent-core 和 pi-ai」。
- **包一层 Effect，pi 留在里面**：里面是 pi 的形状、外面是 Effect 的，中间的适配永远要维护；叫停、插话的时机还是库的。
- **用 `effect/ai` 和 `@effect/ai-openai-compat`**：主人不用。另外它们整个标着 unstable；compat 4.0.5 不发 DeepSeek 的 `thinking`、`reasoning_effort`，也不读 `prompt_cache_hit_tokens`；`LanguageModel` 默认替你跑工具，`Chat` 的历史和我们的压缩、提示开头要互相让。接口可以参考（回答的分块、错误的分类）。
- **把 pi-ai 整个照搬**：它有十几家模型、OAuth、价目表；我们只用一家，照搬只是多维护。

## Acceptance criteria

- `ai/testdata` 的黄金数据：同样的对话，新 `Llm` 发出的请求体和 pi-ai 的逐字段一样；同样的 SSE，读出的 `AssistantMessage`（文字、思考、工具调用、用量、`cacheRead`、钱、停的原因）一样。
- 叫停正在跑工具的一轮：工具的纤程被打断，对话里留下 pi-agent-core 现在留下的那些（有测试）。
- 插话在这一轮的下一次请求前进去，追问在这一轮完了以后进去，和现在一样（有测试）。
- `apps/server` 的 `package.json` 里没有 `@earendil-works/pi-agent-core`；`@earendil-works/pi-ai` 只在 `runtime/price.ts` 用。
- `vp check`、`vp run server:check`、页面的 e2e 都过；最后用真模型跑一遍管家的评测（花钱，先问主人），通过的条数不比换之前少。

## Risks

- **和 DeepSeek 对不上**：思考、`reasoning_content` 的往返、缓存命中是最容易差一点的地方，差一点就是钱和答错；靠第 1 步的黄金数据和最后一次真模型评测兜。
- **循环的时机**：插话、追问、叫停、一轮里一起跑的工具，现在的行为由 pi-agent-core 定、由我们的测试间接描述；换之前先把这几样补成直接的测试（第 3 步之前做）。
- **以后 DeepSeek 的新东西要自己跟**：pi-ai 升级不再白来；我们只有一家模型，跟得上。
- **对话文件的格式**：形状照 pi 的，旧的对话文件照样读；要改形状时按「内部不留兼容」直接改。
- **量**：模型一层约千行加黄金数据，循环约千行，测试要换假模型的有 8 个文件；按上面的次序做，每步能单独合、单独回退。
