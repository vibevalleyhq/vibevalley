# Agent Note: 拆出 ai 和 agent-core 两个包，字面量和 pi 对齐

Status: implemented

> 实现已被取代：这三个 TypeScript 包随 [一个服务端、一个客户端](../simplification/2026-10-14-one-server-one-client.md) 删掉了；Go 服务端里的移植（`server/pkg/ai`、`agentcore`、`agent`）保留了同样的三层和 pi 的字面量（[服务端用 Go 重写](2026-10-13-go-server-on-smith.md)）。下面是当时的决策。

## Problem

[自己的 agent](2026-10-12-own-agent-on-effect.md) 最初是一个包里的一大块：调模型（借 `effect/ai`，再加自己写的 DeepSeek）、循环、存会话、压缩、技能、记性、MCP、定时，循环和这些能力挤在一个 `agent.ts` 里。

- **模型这一层的形状是 `effect/ai` 的**：角色叫 `tool`，内容叫 `tool-call`，流事件叫 `text-delta`，结束原因叫 `tool-calls`。DeepSeek 的思考要靠自己的 provider 补回去（`effect/ai-openai-compat` 会丢掉），每接一家都要在它的形状和那家的形状之间翻译一次。
- **循环缺了 pi-agent-core 已经证明有用的几样**：等这一轮做完再处理的 `followUp`、送给模型之前改写上下文的 `transformContext` 和 `convertToLlm`、工具调用前后的钩子、每轮结束时的 `finishTurn`、工具边跑边报进度、`terminate`、应用自己的消息类型。管家当时的两个毛病就是缺这些造成的：农场现状每句都拼进对话、越存越长；定时任务和帮工汇报到了就插进来，打断正在进行的一轮。
- **同一个概念有两套名字**：VibeValley 同时在用 pi（管家的开关、帮工的一种 runtime），读 pi 的会话和读我们自己的会话，得在两套名字之间来回换算。

## Decision

照 pi 的分法分成三层，依赖只往下：

```
@heybro/ai          ≈ pi-ai            消息、模型、流式调用；只依赖 effect
@heybro/agent-core  ≈ pi-agent-core    循环、状态、事件、两种插话、钩子、工具执行；依赖 effect 和 ai
@heybro/agent       ≈ pi-coding-agent  会话、压缩、技能、记性、帮手、MCP、定时、编码工具、命令行
apps/server         管家、帮工 runtime
```

一条原则：**数据的形状和字面量照 pi 1.1.0，API 的形态照 Effect。** 类型名、字段名、`role` 和 `type` 的值、事件名、枚举值和 pi 一样（消息角色 `toolResult`、内容 `toolCall`、流事件 `text_delta`、停的原因 `toolUse`、agent 事件 `tool_execution_end`、队列 `one-at-a-time`……），懂 pi 的人能直接读，存下来的消息和 pi 同形；调用方式是 Effect、Stream、Scope。完整的对照、和 pi 不一样的地方当时在两个包的 README（`packages/ai/README.md`、`packages/agent-core/README.md`，已删，见 git 历史），字面量由各自的 `test/pi-compat.ts` 拿 pi 的类型检查，只编译不运行。

照 Effect 写的地方：返回 Effect 而不是 Promise；停就是中断 fiber，说到一半的回答以 `aborted` 留下、跑着的工具得到「已停下」；事件是 `Stream`，不等订阅者处理完，要按顺序的事放进钩子；状态是 `SubscriptionRef`；工具参数是 Effect Schema（或 MCP 的 JSON Schema）；出错不抛，是一条 `stopReason: 'error'` 的消息。

- `@heybro/ai` 有 `openai-completions`（DeepSeek、Kimi、通义，DeepSeek 的思考带回去）和 `anthropic-messages`（自适应或按预算的思考，签名带回去）两种 provider，共用一层 HTTP（重试、中断）；还有按剧本回答的 faux，给所有测试用。内置的模型表只有 DeepSeek。
- `@heybro/agent-core` 不碰文件和进程（tsconfig 不带 Node 的类型，oxlint 拦 `node:*`）。
- `@heybro/agent` 的会话一行一条 `AgentMessage`；压缩是一条 `compactionSummary`，宿主放进来的话是 `custom`（名字照 pi-coding-agent）；步数上限用 `finishTurn` 做。
- 管家的农场现状由 `prepareRequest` 放在每次请求的系统提示里，不存进对话；没叫醒它的汇报记成 `farmNews`；定时、提醒和汇报走 `followUp`。

## Alternatives considered

**继续用 `effect/ai`，只在它上面加一层 core。** 少写 provider，但字面量没法和 pi 对齐：`effect/ai` 的 `Prompt` 和 `Response` 有自己的形状，思考、`cacheRead`、`toolResult` 都得在它的形状里绕着走；它还标着 unstable。自己写两种 provider 的代价不大。

**直接用 pi-ai 和 pi-agent-core。** 现成、经过检验。但它是 Promise、可变的类和 TypeBox，和仓库里全是 Effect 的写法是两套世界，这正是自己写 agent 的初衷；它还拖着 OAuth、几十家服务商、AWS SDK 这些依赖。对齐它的字面量，拿到的是可读、和 pi 的会话互通；不拿它的运行时。

**只对齐概念，名字按 Effect 的习惯（`tool-call`、`text-delta`）。** VibeValley 同时在用 pi，一个概念两个名字只会让人和模型都犯错。

**一个包里分目录，不拆包。** 拆成包，依赖方向由 package.json 管住：core 不能碰文件、不能知道 DeepSeek；帮工 runtime 和别的宿主只依赖它要的那一层。

**农场现状由 `transformContext` 插到最后一句话前面。** 提案时是这么打算的；放进系统提示一样只给模型看、不存，而且不会被模型当成主人说的话。

## Consequences

- 管家的对话不再存农场现状，定时任务和汇报不再打断正在进行的一轮；帮工 runtime 直接拿 `@heybro/agent` 用。
- 我们对齐的是 pi 1.1.0：pi 改名时类型断言文件编译不过，要么跟着改，要么有意分叉并在包 README 写明。
- provider 自己扛：流式解析、重试、各家的兼容差别都得自己跟着上游改。Anthropic 的 provider 没连过 Anthropic 本家，真跑过的是 DeepSeek 的 Anthropic 兼容接口（`https://api.deepseek.com/anthropic`）：思考带签名送回、连着几次调工具、不开思考、V4 Pro 都对；模型表里没有 Claude，用的时候宿主自己给 `Model`（价钱也是）。
- `effect/ai` 没有全去掉：agent 这三层不用它，但服务端 `/mcp`（`farm-tools.ts`）是 MCP 的服务端，还用它的 `McpServer`。
- 不等事件订阅者：宿主不能假设事件处理完了循环才往下走（`@heybro/agent` 把「存盘、再发事件、运行结束后接着处理」放在同一个按顺序处理事件的 fiber 里）。
- 密钥是 `StreamOptions.apiKey` 的普通字符串，和 pi 一样；不进日志、不进事件。

## Verification

- `packages/ai`：工具参数边流边读、两种 provider 的请求和事件、本机假接口上的真 fetch（重试、出错、中断即断开）、faux；`test/pi-compat.ts`。
- `packages/agent-core`：pi README 写的事件顺序、steer 和 followUp、队列两种取法、钩子、terminate、finishTurn、并行和依次、停下（说话时、工具跑时）、自己的消息；`test/pi-compat.ts`。
- `packages/agent`、服务端的管家和 `heybro` runtime 的测试，见 [自己的 agent](2026-10-12-own-agent-on-effect.md)「Verification」。
