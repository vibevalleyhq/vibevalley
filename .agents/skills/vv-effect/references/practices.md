# Effect v4 的实践、反模式和 v3 → v4 的陷阱

2026-10-31 的调研（官方文档、Effect-TS 的仓库和 skill、社区的文章和 skill）里，这个仓库用得上的部分。每个 API 名字都对过 effect 4.0.5 的 `node_modules/effect/src`；以后升级 effect，名字以那时的源码为准。入口见 [SKILL.md](.agents/skills/vv-effect/SKILL.md)。

目录：[资料信谁](#资料信谁) · [反模式](#反模式) · [策略](#策略) · [v3--v4](#v3--v4)

## 资料信谁

- 最可信的是装好的包自带的 `node_modules/effect/AGENTS.md` 和 `ai-docs/src/**`：和版本一致。Effect-TS 官方的 skill 仓库也只是把 agent 指到这份文件（本仓库的 [effect-ts](.agents/skills/effect-ts/SKILL.md) 就是它）。
- effect-smol 仓库在 2026 年 7 月归档，v4 在 Effect-TS/effect 的 `main` 上。
- 社区的 skill 和文章不少还停在 v4 测试版：`ServiceMap.Service`、`ServiceMap.Reference`、`Schema.TaggedErrorClass`、「http 和 sql 在 `effect/unstable/*`」，在 4.0.5 里都不对（4.0.5 是 `Context.*`、`Schema.TaggedError`、`effect/http`、`effect/sql`）。照着装或照着写之前，先在 `node_modules/effect/src` 里搜一遍。

## 反模式

agent 写 Effect 时最常见的错，为什么会写出来，和这个仓库里谁拦着。「已拦」的在 `vp check` 或 `effect:check` 里报错；「审」的要读代码（[SKILL.md](.agents/skills/vv-effect/SKILL.md#4-评审一段-effect-代码)）。

| 反模式 | 为什么会写出来 | 在这里 |
|---|---|---|
| 用 v3 或测试版的 API：`Context.Tag`、`Effect.Service`、`catchAll`、`Either`、`Layer.scoped`、`Effect.fork`、`Effect.async`、`ServiceMap.Service` | 训练数据大多是 v3 | 已拦：类型（这些名字不存在）和 `outdatedApi` |
| Effect 漂着没运行；`map` 里返回 Effect；`yield` 少了 `*` | 把 Effect 当成 Promise | 已拦：`floatingEffect`、`effectMapFlatten`、`missingStarInYieldEffectGen` |
| gen 里写 `try { yield* … } catch` | async/await 的习惯 | 已拦：`tryCatchInEffectGen` |
| 抛错时没写 `return yield*` | 同上 | 已拦：`missingReturnYieldStar` |
| `throw new Error()`、`class X extends Error`、`Effect.fail(new Error("…"))` | JS 的习惯 | 部分已拦（`globalErrorInEffectFailure`）；`extendsNativeError`、`preferSchemaTaggedError` 有命中，未开，见[提案](.agents/notes/proposed/architecture/2026-10-31-effect-practices.md) |
| 一个 `Effect.catch` 吞掉所有错误，或者到处 `Effect.orDie` 让类型编过 | 想让类型通过 | 已拦一部分：`catchToIgnore`、`redundantOrDie`，逃生口的棘轮（`orDie`、`ignored`、`swallowed`）；其余审 |
| 在服务里 `Effect.runPromise`、`runSync` | 不知道怎么从回调回到 Effect | 已拦：`runEffectInsideEffect`；回调用 `FiberSet.makeRuntime*` |
| 服务的方法签名里带依赖（R） | 嫌在 layer 里拿依赖麻烦 | 已拦：`leakingRequirements` |
| 到处 `Effect.provide`、连着 provide | 哪里缺服务就在哪里补 | 已拦：`multipleEffectProvide`；layer 只在 `services.ts` 叠 |
| `Date.now()`、`setTimeout`、`console.log`、`process.env`、`fetch`、`Math.random` | 习惯 | 已拦：`vibevalley/no-wall-clock`、`no-console`，`globalRandomInEffect`、`processEnvInEffect`、`globalFetchInEffect` 等 |
| `Effect.tryPromise(() => …)` 不写 `catch`；不把 `AbortSignal` 传下去 | 最短的写法 | 审（失败时只剩 `UnknownError`）；以后做成 lint，见提案 |
| 手写类型守卫，`as` 断言外面来的数据 | 最短的写法 | 已拦：逃生口的棘轮（`as`）、`unsafeEffectTypeAssertion`；对象用 `Predicate.isObject` |
| 函数只是 `return Effect.gen(…)`，没有名字和 span | v3 的写法 | 审：`effectFnOpportunity` 是建议级；服务方法补名字见提案 |
| 测试里 `Effect.runPromise` + `expect`；`it()` 里返回 Effect | vitest 的习惯 | 已拦：`floatingEffectInVitest`；服务端用 `it.effect` |
| 以为 `Effect.all`、`forEach` 是并行的 | `Promise.all` 的直觉 | 审：并发要写 `{ concurrency }` |
| `Ref`、`Deferred`、`Fiber` 直接 `yield*` | v3 里它们是 Effect | 已拦：类型；用 `Ref.get`、`Deferred.await`、`Fiber.join` |
| `Layer.mergeAll` 里的 layer 互相依赖 | 以为 merge 会自动接线 | 已拦：`layerMergeAllWithDependencies` |
| 服务带泛型参数 | 想做「通用仓库」 | 已拦：`genericEffectServices` |
| Schema 用 v3 写法：`Schema.Literal("a", "b")`、`Schema.Union(A, B)`、`Schema.filter`、`Schema.transform` | 训练数据 | 已拦：类型、`schemaUnionOfLiterals` |

## 策略

**服务和 layer。** 服务是 `Context.Service` 的类，依赖在 layer 里 `yield*`，方法签名里不带依赖；layer 只在入口叠一次（这里是 `services.ts`），v4 的 layer 跨 provide 也会复用，想要新实例写 `Layer.fresh`。

**错误：预期的和缺陷。** 主人能处理、调用方要分开接的（拒绝、找不到、外面的服务失败）是带标签的错误，留在错误通道里，按 `catchTag` 接；没法恢复的（程序的 bug、库坏了）是缺陷，只在边界处理一次（这里是接口的处理和 `Exit` 的折法）。包装外面的错误时把它放进 `cause`，不只留 `String(e)`。

**资源。** 拿到就配好释放：`Effect.acquireRelease` 放进 `Layer.effect`（v4 里 `Layer.scoped` 并进了 `Layer.effect`）；后台任务用 `Layer.effectDiscard` 加 `Effect.forkScoped`，服务关了它也停。

**并发。** 默认一个接一个；要并发就写明上限。用户给的数量（工单数、消息数）不用 `"unbounded"`。

**测试。** `it.effect` 加 `assert`；时间用 `TestClock.adjust`；每个测试 provide 新的 layer，只有贵的资源才共享。被测的代码里不能有 `Date.now()`、`setTimeout`：测试的钟拨不动它们。

**可观测性。** span 打在边界上：接口、外部进程、库的写、队列的交接；服务的方法用 `Effect.fn("X.m")` 自带 span。id 这类高基数的值写进 span 的注解，不当成 metric 的标签。

**和 Promise 的库打交道。** 交界收窄到一次调用：`Effect.tryPromise({ try: (signal) => lib.call(…, { signal }), catch: (cause) => new XError({ cause }) })`，`signal` 传下去，打断时库也停；从外面的回调回到 Effect 用 `FiberSet.makeRuntime*`（归服务的作用域）或 `ManagedRuntime`。

## v3 → v4

只学过 v3 的 agent 最容易写错的地方。左边的写法在 4.0.5 里大多编不过；编得过的（语义变了的）更要注意。

**服务、layer、运行时**

| v3 | v4（4.0.5） |
|---|---|
| `class X extends Context.Tag("X")<X, S>() {}` | `class X extends Context.Service<X, S>()("X") {}`（id 挪到最后） |
| `Effect.Service`、`X.Default`、accessors（`X.method(…)`） | 没有了：`Context.Service` 加 `static readonly layer`；用的时候 `yield* X` |
| `Layer.scoped`、`Layer.scopedDiscard` | `Layer.effect`、`Layer.effectDiscard`（自动去掉 Scope） |
| `FiberRef`、`Effect.locally` | `Context.Reference`、`Effect.provideService` |
| `Runtime<R>`、`Runtime.runFork(rt)` | `Effect.context<R>()` 加 `Effect.runForkWith(ctx)`；应用级用 `ManagedRuntime` |
| layer 只在同一次 provide 里复用 | 跨 provide 也复用；要新实例写 `Layer.fresh` |
| `@effect/platform`、`@effect/sql` 各一个包 | 并进 `effect`：`effect/http`、`effect/sql`…，版本统一 |

**Effect 本身**

| v3 | v4 |
|---|---|
| `catchAll`、`catchAllCause`、`catchAllDefect` | `Effect.catch`、`catchCause`、`catchDefect` |
| `catchSome` | `Effect.catchIf`、`catchFilter` |
| `Effect.either`、`Either` | `Effect.result`、`Result` |
| `Effect.async` | `Effect.callback`（`(resume, signal) => …`） |
| `zipRight`、`zipLeft` | `Effect.andThen`、`Effect.tap` |
| `Effect.ignoreLogged` | `Effect.ignore({ log: "Warn" })` |
| `Effect.fork`、`forkDaemon` | `Effect.forkChild`、`forkDetach` |
| `UnknownException`、`TimeoutException` | `Cause.UnknownError`、`TimeoutError` |
| `Cause` 是递归的树 | 拍平成 `cause.reasons` |
| `Ref`、`Deferred`、`Fiber` 本身是 Effect | 不是了：`Ref.get`、`Deferred.await`、`Fiber.join` |
| `Equal.equals` 对普通对象比引用 | 默认按结构比（对象、数组、Map、Set、Date）；比引用用 `Equal.byReference` |
| `Mailbox` | `Queue` |
| `Stream.async`、`Stream.catchAll` | `Stream.callback`、`Stream.catch` |

**Schema**

| v3 | v4 |
|---|---|
| `Schema.decodeUnknown(S)(x)` | `Schema.decodeUnknownEffect(S)(x)`；`decodeUnknownSync` 还在 |
| `Schema.decodeEither` | `*Exit`（错误是 `SchemaError`，`.issue` 是 `SchemaIssue`） |
| `Schema.Literal("a", "b")` | `Schema.Literals(["a", "b"])` |
| `Schema.Union(A, B)`、`Schema.Tuple(A, B)` | `Schema.Union([A, B])`、`Schema.Tuple([A, B])` |
| `Schema.Record({ key, value })` | `Schema.Record(Key, Value)` |
| `S.pipe(Schema.filter(p))` | `S.check(Schema.makeFilter(p))` |
| `Schema.transform(A, B, …)` | `A.pipe(Schema.decodeTo(B, SchemaTransformation.transform({ decode, encode })))` |
| `Schema.optionalWith(S, { default })` | `Schema.optional` / `optionalKey` 加 `Schema.withDecodingDefault*` |
| `Schema.DateFromSelf` | `Schema.Date` |

来源：`node_modules/effect/AGENTS.md`；effect.website 的 v4 文档；Effect-TS/effect 的 `MIGRATION.md` 和 `packages/effect` 的说明；Effect-TS/skills；`@effect/tsgo` 的 README 和规则文档；社区文章（Kit Langton、Sandro Maglione 等）只取和 4.0.5 对得上的部分。
