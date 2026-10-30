# Agent Note: Effect 代码还没照最佳实践的几处，和要补的检查

Status: proposed

## Problem

2026-10-31 对服务端、`packages/agent`、`packages/ai` 的 Effect 代码做了一次扫描，对照 `node_modules/effect/AGENTS.md`（effect 4.0.5）和[地基](docs/subsystems/foundation.md)里本仓库的约定。整体是健康的：24 个服务都是 `Context.Service` 的类，`effect:check` 干净，`@effect/tsgo` 抓 LLM 常见错误的规则（漂着的 Effect、少了 `return yield*`、v3 的旧 API、gen 里的 `try/catch`、方法签名漏出依赖）全是 0。

小而确定的问题已经在同一个改动里修了（存附件失败只报 `UnknownError`、定时器在服务的作用域外、模块自己 `provideService(SqlClient)`、按 `instanceof` 分错误、丢掉主人说的话不留日志、手写的对象判断……），今天是 0 的规则也开了。剩下的几处要动的面大，或者要先定写法，记在这里。写 Effect 时怎么做见 [vv-effect](.agents/skills/vv-effect/SKILL.md)。

## Proposal

| 编号 | 问题 | 做法 | 什么时候做 |
|---|---|---|---|
| B1 | 错误通道里有 `unknown`：28 处源码、19 处测试，来自约 15 个类型声明（大头在 `session/host.ts` 的 `HostOptions`、`Caller`、`Build`、`submit`，`Orchestrator.brief`，voice 的 `tunnel` 和 `Run`） | 从这几个根上把错误类型写出来，再把 `anyUnknownInErrorContext` 在 `tsconfig.base.json` 里打开 | 改 `session/host.ts` 或管家的接口时一起做 |
| B7 | 手写的重试和轮询（`voice/voice.ts` 两处、connector 的收消息） | 换成 `Effect.retry`、`Effect.repeat` 和 `Schedule`，用 `TestClock` 测 | 和[扩展点只填空](.agents/notes/proposed/process/2026-10-30-whitepaper-checks-that-say-how.md)的 connector 骨架一起 |
| B9 | `packages/agent` 的测试是 Promise 写法（约 57 个 `it`） | 换成 `@effect/vitest` 的 `it.effect` | 改 `packages/agent` 的测试时 |
| B10 | 25 个 `Data.TaggedError` 只有 `{ message: string }`，`extends Error` 的还有 8 处；`preferSchemaTaggedError`、`extendsNativeError` 因此没开 | 要跨线或要编码的错误换成 `Schema.TaggedError`，原因放进 `cause`；全换完再打开这两条 | 一个模块的错误要过线时 |

## Alternatives considered

**一次全改完。** B1 要动好几个模块和测试，和别的工作冲突的面大；每一项挂在下一次改那块代码的时候做，改动和理由在一起。

**写成文字规矩，不加检查。** agent 照已有的代码抄，存量不改、只写规矩，新代码还会照着旧的写；所以每一项都以「改完存量、再开检查」收尾。

## Acceptance criteria

- B1 做完：`anyUnknownInErrorContext` 在 `tsconfig.base.json` 里开着，`effect:check` 为 0。
- 其余每项做完从本表删掉那一行；表空了删掉本篇。

## Risks

- 挂在「下次改那块时」的项可能一直没人碰。[vv-effect](.agents/skills/vv-effect/SKILL.md) 的「还没做的」一节指到这里，改到那块的 agent 会看到。
