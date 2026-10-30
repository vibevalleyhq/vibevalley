# Agent Note: Effect 代码还没照最佳实践的几处，和要补的检查

Status: proposed

## Problem

2026-10-31 对服务端、`packages/agent`、`packages/ai` 的 Effect 代码做了一次扫描，对照 `node_modules/effect/AGENTS.md`（effect 4.0.5）和[地基](docs/subsystems/foundation.md)里本仓库的约定。整体是健康的：24 个服务都是 `Context.Service` 的类，`effect:check` 干净，`@effect/tsgo` 抓 LLM 常见错误的规则（漂着的 Effect、少了 `return yield*`、v3 的旧 API、gen 里的 `try/catch`、方法签名漏出依赖）全是 0。

小而确定的问题已经在同一个改动里修了（存附件失败只报 `UnknownError`、定时器在服务的作用域外、模块自己 `provideService(SqlClient)`、按 `instanceof` 分错误、丢掉主人说的话不留日志、手写的对象判断……），今天是 0 的规则也开了。剩下的几处要动的面大，或者要先定写法，记在这里。写 Effect 时怎么做见 [vv-effect](.agents/skills/vv-effect/SKILL.md)。

## Proposal

| 编号 | 问题 | 做法 | 什么时候做 |
|---|---|---|---|
| B1 | 错误通道里有 `unknown`：28 处源码、19 处测试，来自约 15 个类型声明（大头在 `session/host.ts` 的 `HostOptions`、`Caller`、`Build`、`submit`，`Orchestrator.brief`，voice 的 `tunnel` 和 `Run`） | 从这几个根上把错误类型写出来，再把 `anyUnknownInErrorContext` 在 `tsconfig.base.json` 里打开 | 改 `session/host.ts` 或管家的接口时一起做 |
| B2 | 服务的方法缺名字：`Core` 0/11、`Channels` 8/47、`Artifacts` 3/15、`Runtimes` 1/8、`Notices` 0/5、`Game` 0/4，`packages/agent` 没有；OTLP 已经接上，没有名字的方法在追踪里看不见 | 方法用 `Effect.fn("X.m")`，热路径用 `Effect.fnUntraced`；之后加一条检查：`X.of({ … })` 的成员是 `Effect.fn` | 一个模块一个 PR，从 `Core` 开始 |
| B3 | `Effect.tryPromise` 里写了多步的 async 函数（3 处，含 `tool/tool.ts` 的路径越界检查）；`vibevalley/promise-boundary` 放过 `tryPromise` 里任何 async | 把多步的拆回 Effect，只留库的那一次调用；收紧 `promise-boundary`：`tryPromise` 里的 async 函数体只许一个 `await` | 下一次改 `tool/tool.ts` 时 |
| B5 | 模型和记录的 JSON 有两处手写解码（`issue/refinement.ts`、`session/report.ts`），`task/splitting.ts` 用 Schema 做同一件事 | 抽一个 `lastJsonBlock(text, schema)`，三处共用 | 改其中任何一处时 |
| B6 | 外面的 HTTP 还有直接 `fetch` 的（`voice`、`lan`、`http` 共 11 处，3 处在源码里） | 换成 `HttpClient`，然后打开 `globalFetchInEffect` | 改 voice 的隧道或 lan 时 |
| B7 | 手写的重试和轮询（`voice/voice.ts` 两处、connector 的收消息） | 换成 `Effect.retry`、`Effect.repeat` 和 `Schedule`，用 `TestClock` 测 | 和[扩展点只填空](.agents/notes/proposed/process/2026-10-30-whitepaper-checks-that-say-how.md)的 connector 骨架一起 |
| B8 | 「出错了记一笔、接着做」写了五种：`logged`、`kept`、`keptRun` 各有几份，另有约 20 处内联 | `base/log.ts` 加一个 `bestEffort(what)`（跳过打断），换掉各处 | 下一次碰到其中一份时 |
| B9 | `packages/agent` 的测试是 Promise 写法（约 57 个 `it`） | 换成 `@effect/vitest` 的 `it.effect` | 改 `packages/agent` 的测试时 |
| B10 | 25 个 `Data.TaggedError` 只有 `{ message: string }`，`extends Error` 的还有 8 处；`preferSchemaTaggedError`、`extendsNativeError` 因此没开 | 要跨线或要编码的错误换成 `Schema.TaggedError`，原因放进 `cause`；全换完再打开这两条 | 一个模块的错误要过线时 |

同一个改动里没修完的：`project/project.ts` 的 `failed`、`connector/connector.ts` 的 `bridgeError`、`packages/agent/src/core/errors.ts` 的 `toolFailed` 收的是 `unknown`，按标签判断前要先把入参的类型写出来（和 B1 一起）；生成的 `packages/protocol/src/client.ts` 里的手写对象判断要改它的生成器 `scripts/api-client.ts`。

要补的检查（今天有命中，不能直接开）：`processEnvInEffect`（`main.ts` 1 处、测试 3 处）、`cryptoRandomUUIDInEffect`（测试 2 处）、`globalTimersInEffect`（`testing/clock.ts` 1 处），改掉或在那一行写明为什么以后打开；`tryPromise` 必须写 `{ try, catch }`（服务端 15 处还是只传函数的写法）、`vibevalley/no-instanceof-tagged`（按 `instanceof` 分带标签的错误）、手写的 `typeof x === "object" && x !== null`。修掉存量后各写一条 `vibevalley/*` 规则，报错照 `says` 的格式。

## Alternatives considered

**一次全改完。** B1、B2 各要动好几个模块和测试，和别的工作冲突的面大；每一项挂在下一次改那块代码的时候做，改动和理由在一起。

**写成文字规矩，不加检查。** agent 照已有的代码抄，存量不改、只写规矩，新代码还会照着旧的写；所以每一项都以「改完存量、再开检查」收尾。

## Acceptance criteria

- B1 做完：`anyUnknownInErrorContext` 在 `tsconfig.base.json` 里开着，`effect:check` 为 0。
- B2 做完：每个服务的 `X.of({ … })` 成员都有名字，检查守着。
- 其余每项做完从本表删掉那一行；表空了删掉本篇。

## Risks

- 挂在「下次改那块时」的项可能一直没人碰。[vv-effect](.agents/skills/vv-effect/SKILL.md) 的「还没做的」一节指到这里，改到那块的 agent 会看到。
