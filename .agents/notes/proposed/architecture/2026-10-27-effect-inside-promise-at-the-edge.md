# Agent Note: Effect 管到里面，Promise 只留在外面的库的调用上

Status: proposed

## Problem

[地基](docs/subsystems/foundation.md)定过：连接器、记性的来源、语音的隧道是「Promise 一侧」，构造时接一个 `Time`，改成 Effect「只是换写法」。上一轮审查把这几处交界的错误、取消和资源归属修好了，但没动它们的结构，结果这几块的**里面**也是 Promise：

- **连接器**（`connector/connector.ts`）用 `AbortController` 当一代工作，`stopGeneration` 等它停；`serially` 是手写的 Promise 排队；`wait.ts` 的 `waitFor`、`sleep` 加一个 `wakeInbox` 回调是手写的「睡到时候或被叫醒」；收消息失败 2 秒、三次后 30 秒，发件箱从 `retryFirst` 翻倍到 `retryMost`，都是手写的退避；`pending` 集合加 `Promise.allSettled` 是手写的「等进行中的写完」。`run` 把每个错误变成 `new Error(causeMessage)`，带标签的错误在这一层就没了。
- **记性的来源**（`memory/sources.ts`）的 `Sources` 类自己管代、租约、排队、超时；本地的来源先把 Effect 跑成 Promise，再被服务包回 Effect。
- **农机的探测**（`runtime/runtime.ts`）的 `refresh`、`probe`、`refreshUsage` 是 async，`each` 是手写的四个并发的池，`closed` 标记代替作用域。
- **管家的工具**（`tool/tool.ts`）每个都是 async：`go()` 把服务的 Effect 跑成 Promise，再 `try/catch`，拒绝是 `throw new Error`；`tool()` 丢了 `ToolContext.signal`，一轮被叫停时正在跑的 Effect 不会被打断。工具的参数写了两份：`tool/schemas.ts` 705 行手写的 JSON Schema，和 `tool<{...}>` 的类型参数，执行时 `params as P`。
- **大脑的任务**（`agent/brain/agentTaskTools.ts`）用全局的 `Effect.runPromise` 跑任务库的 Effect，「没有变化」写成一个 `Symbol` 的失败，再递归拆 `cause` 认它；大脑和它的任务出错用 `console.error`，lint 为 `agent/brain/**` 开了豁免。
- **零碎的**：`project/git.ts` 的 `GitError` 走 Effect 的错误通道却没有 `_tag`；`connector.ts` 的 `isFailure` 是手写的 `unknown` 判断；服务的 Effect 代码里还有同步的 `node:fs`（`runtime.ts` 的花费、`session.ts` 的工作目录、`http/page.ts`、`project.ts`），违反地基「文件走 `FileSystem`」那条；服务端的配置（`base/config.ts`）自己合并 YAML 和环境变量、自己转类型、`throw`，命令行却已经用 Effect 的 `Config`。

这些地方每一处都要人记得「打断时停 AbortController、超时清计时器、写完再换代」；Effect 本来就管这些，写在 Promise 里就得一处一处手写、一处一处测。

## Proposal

交界收窄到**外面的库的一次调用**：SDK、`fetch`、oar、pi-agent-core 的 `AgentTool.execute`、MCP 的 SDK。编排（循环、排队、等待、退避、换代、并发、超时）都在 Effect 里。按下面的次序做，一项一个提交：

1. **大脑的任务**：`AgentTaskStore` 是大脑（Promise 一侧）用的接口，由拥有它的服务用自己作用域的运行时给出 Promise 的 `load`、`change`；`change` 的函数返回 `undefined` 是「没变」，不写库，不再是失败。去掉 `Effect.runPromise`、`unchanged` 和 `isUnchanged`。
2. **错误和判断**：`GitError` 改成 `Data.TaggedError`；`isFailure` 换成 `Predicate`。
3. **文件**：服务的 Effect 代码里的同步 `node:fs` 换成 `FileSystem`。
4. **农机的探测**：`Runtimes` 里面改成 Effect：四个并发是 `Effect.forEach(..., { concurrency: 4 })`，关服务由作用域打断；探测的截止仍是真时间（`withinRealTime` 包 oar 的 Promise）。
5. **管家的工具**：工具的身体是 `Effect.fn`，拒绝是带标签的 `ToolRefusal`，只在 `textTool` 一处跑成 Promise，并把 `signal` 交给纤程：一轮被叫停，正在跑的工具跟着被打断。
6. **工具的参数由 Schema 来**：每个工具一个 Effect Schema，类型从它推出，JSON Schema 从它生成；`tool/schemas.ts` 换成生成的结果，测试查它和现在的逐字节一样（管家的提示前缀不变，不用重放 evals）。
7. **记性的来源**：`Source` 的方法返回 Effect；`Sources` 的代是一个 `Scope`，读是 `Effect.forEach` 加 `Effect.timeoutOption`，后台写是一个队列和一个消费它的纤程；Nowledge、EverOS 的 HTTP 走 `HttpClient`。
8. **连接器**：每个应用的一代工作是一个纤程（`FiberMap` 按应用存），换账号打断它、等它收完；命令一个一个来是 `Semaphore`；「睡到时候或被叫醒」是 `Effect.sleep` 和一个 `Latch` 赛跑；退避是 `Schedule`；进行中的写是 `FiberSet`。适配器的 `login`、`receive`、`send` 留在 Promise 交界，用 `Effect.tryPromise({ try: (signal) => ... })` 调。`wait.ts` 删掉。
9. **大脑的日志**：大脑、轨迹构造时接一个日志（像 `Time` 一样，服务给 `callbackLog`，命令行给打到终端的），lint 不再为它们开 `no-console` 的豁免。
10. **服务端的配置**：`loadConfig` 换成 `Config` 加 `ConfigProvider`（环境变量在前、YAML 在后、默认值最后），错误是 Effect 的 `ConfigError`；`main.ts` 的建目录、家目录的租约进 layer。
11. **文档**：`foundation.md` 里「Promise 一侧」的范围、错误、日志、配置跟着改；连接器、记性的子系统文档跟着改；本 Note 沉淀以后删掉。

## Alternatives considered

- **照地基原来的决定不动**：交界的 bug 已经修了，测试也覆盖；但每加一个连接器、一个来源，就要再手写一遍停、等、退避，测试也要再证明一遍它们。主人选了改。
- **把整个大脑改成 Effect**：它搭在 pi-agent-core 上，是 oar 的一个 runtime，也在命令行里单独跑；交界就是 pi-agent-core 的回调，改了只是把交界挪进库里面。不做。
- **`project/git.ts` 换成 `ChildProcess`**：地基里放弃过，理由仍然成立（超时打断时丢掉已经读到的输出，检查超时要说出最后几行）。不做。
- **`ApiError` 换成 `Schema.TaggedErrorClass`、服务的状态换成 `Ref`**：地基里放弃过，理由不变。不做。

## Acceptance criteria

- `apps/server/src` 里除了测试、`base/time.ts` 和命令行，没有 `Effect.runPromise`、`new Promise`、`AbortController` 的手写换代；`connector/wait.ts` 不在了。
- 管家的工具被叫停时，正在跑的 Effect 被打断（有测试）。
- 生成的工具参数和原来的 `schemas.ts` 逐字节一样（有测试）。
- `agent/brain/**`、`session/journal.ts` 不再有 `no-console` 的豁免。
- `vp check`、`vp run server:check`、页面的 e2e 都过；连接器、记性、农机的已有测试不改语义就过。

## Risks

- 连接器的至少一次投递、换代时「写完再换」、发件箱的退避是这次最容易改错的地方；已有的测试是护栏，不改它们断言的行为。
- 生成的 JSON Schema 和手写的在键的次序上可能对不上：用一个把键排成原来次序的规整步骤，测试逐字节比；对不上就是失败，不放过。
- 配置换成 `ConfigProvider` 以后，环境变量的名字（`VIBEVALLEY_SESSION_STALL_SECONDS`、`DEEPSEEK_API_KEY`）不能变；有测试。
