---
name: vv-typescript
description: 在 VibeValley 里写、改、评审服务端和各个包的 TypeScript（没有 Effect）：服务是工厂函数加一个接口、依赖从参数进来；预期的拒绝抛 ApiError（带 bizCode），模块自己的失败是 Error 子类、用 instanceof 接；长操作收 AbortSignal，后台任务进 @vibevalley/async 的 TaskGroup，资源用 await using；时间经 Clock；运行时校验只用 Zod（契约、查询的行、落盘的 JSON、配置、工具入参）；库只经 db/generated 生成的函数；HTTP 是 Hono。也是把还没改完的 Effect 代码改成普通 TypeScript 的对照表（Effect.gen、yield*、Layer、Stream、PubSub、Fiber、Scope、Schedule、Schema 各换成什么）。用在：写或改 apps/server、apps/cli、packages/* 的代码；把一段 Effect 代码改写掉；评审一段异步代码（打断、收尾、并发、错误）；不确定一个 Effect 的写法在这里换成什么。
---

# 在这个仓库写普通 TypeScript

仓库在离开 Effect（[计划](.agents/notes/proposed/architecture/2026-11-11-plain-typescript-without-effect.md)）。新代码、改写后的代码都照这里写：`async`/`await`、`AbortSignal`、`await using`、工厂函数，运行时校验只用 Zod。下面先是写法，最后是从 Effect 改过来时的逐条对照。

## 1. 服务：工厂函数加一个接口

一个模块导出一个服务：接口和模块同名（`Issue`、`Session`），工厂叫 `make<名字>`，依赖是一个对象参数，只放它用到的、排在它前面的服务（[architecture.md](docs/architecture.md)）。

```ts
// apps/server/src/modules/issue/issue.ts
import type * as T from "@vibevalley/protocol";

export interface Issue {
  readonly get: (id: T.IssueId) => Promise<T.Issue>;
  /** Each change to an issue, from now on. */
  readonly changes: () => Subscription<IssueChange>;
  /** At startup, after the modules below it started. */
  readonly start: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface IssueDeps {
  readonly config: ServerConfig;
  readonly clock: Clock;
  readonly db: Db;
  readonly core: Core;
  readonly session: Session;
}

export async function makeIssue(deps: IssueDeps): Promise<Issue> {
  const tasks = new TaskGroup({ name: "issue" });
  // …
  return { get, changes, start, close: () => tasks.close() };
}
```

- 别处要它的类型写 `Issue`（不是 `Issue["Service"]`）；和它同名的协议形状照旧写 `T.Issue`。
- `services.ts` 照模块次序一个个 `await make…(deps)`，拼成 `Farm`；全部建好以后按次序调各自的 `start()`；`farm.close()` 倒着调 `close()`。`Farm` 是 `AsyncDisposable`，测试里 `await using farm = await world()`。
- 没有全局的单例：时钟、库、配置都从 `deps` 进来，测试换它们只换参数。
- 一个服务的接口很大时（频道），接口放同模块的 `contracts.ts`，照旧。

## 2. 错误

- **对调用方的拒绝**（参数不对、不让做、找不到）：抛 `ApiError`（`@vibevalley/protocol/api`），带 `bizCode`。`base/errors.ts` 的帮手照旧：`throw refused(t("…"))`、`throw missing(…)`。网关把它写成 `{ bizCode, message, error? }`。
- **模块自己的、调用方要分辨的失败**：一个 `Error` 子类，名字和原来的 `_tag` 一样，字段照旧，用 `instanceof` 接：

  ```ts
  export class HireRefused extends Error {
    override readonly name = "HireRefused";
    constructor(readonly reason: string, readonly retainedWork = false) { super(reason); }
  }
  try { await hire(…); } catch (e) { if (!(e instanceof HireRefused)) throw e; … }
  ```
- **预期的、不是错误的结果**（找到或没找到、合进去或冲突）：返回一个判别联合（`{ kind: "merged" } | { kind: "conflict"; files }`），不抛。
- **意外**：照常抛（`throw new Error`、`invariant`），网关答 500 并记日志。不要用 `catch {}` 吞掉；要吞的写明为什么，并记一行日志。
- 一个错误类名全仓唯一（照旧）。

## 3. 打断、后台任务、资源

- **长操作收 `signal?: AbortSignal`**，作为最后一个参数，往下传给 `fetch`、子进程、`clock.sleep`、`queue.take`。被打断就让 `AbortError` 往上抛；判断用 `isAbort(e, signal)`。
- **后台任务进 `TaskGroup`**（`@vibevalley/async`）：每个服务一个，`tasks.run(name, async (signal) => …)`；关服务时 `await tasks.close()`，它中止每个任务并等它们结束。不要 `void someAsync()` 放着不管（`no-floating-promises` 查）。
  - 同一个键只许一个在跑（原来的 `FiberMap`）：`tasks.keyed(key, …)`，新的先停掉旧的。
  - 要拿结果的（原来的 `Fiber.join`）：`const t = tasks.spawn(name, f); await t.result`。
- **资源成对**：返回资源的函数返回带 `[Symbol.asyncDispose]` 的对象，调用方 `await using`；几个资源一起用 `AsyncDisposableStack`。没法写成资源的，用 `try { … } finally { … }`。
- **不许被打断的一段**（原来的 `uninterruptible`）：不把 `signal` 传进去，注释写为什么。

## 4. 并发和时间

| 要做的 | 写法（`@vibevalley/async`） |
|---|---|
| 一个一个来 | `for (const x of xs) await f(x)` |
| 一起来，等全部 | `await Promise.all(xs.map(f))` |
| 一起来，最多 n 个 | `await mapConcurrent(xs, n, f)` |
| 一把锁、n 个名额 | `const lock = new Semaphore(1); await lock.with(() => …)` |
| 跨异步的状态 | 普通的变量或字段；有 `await` 夹在读和写之间时，读改写包进同一把锁 |
| 一个值和它的变化（原来的 `SubscriptionRef`） | `Cell` |
| 一条队列（原来的 `Queue`） | `Queue`（`unbounded`、`sliding`、`dropping`） |
| 给很多读者的新闻（原来的 `PubSub`） | `Hub`；读者 `using sub = hub.subscribe()`，`for await (const x of sub)` |
| 一串值（原来的 `Stream`） | `AsyncIterable`，写成 `async function*`；`merge`、`map`、`filter`、`lines`、`collect` |
| 等一个将来的值（原来的 `Deferred`） | `Promise.withResolvers()` |
| 现在几点、等一会儿 | `deps.clock.now()`、`await deps.clock.sleep(ms, signal)`；不直接 `Date.now()`、`setTimeout`（lint 查） |
| 超时 | `await withTimeout((signal) => f(signal), ms, { clock })` |
| 重试 | `await retry(f, { retries: 3, delay: exponential(200), when: (e) => …, clock, signal })` |

## 5. 运行时校验：只用 Zod

契约（`packages/protocol` 的 `schema.ts`）、HTTP 入参、SSE、查询的每一行、落盘的 JSON、配置、工具入参都用 Zod 4 解，进门一次，门内是类型。

- **契约由手写的类型定**：`shapes.ts` 照旧是手写的类型，`schema.ts` 里每个 Schema 写成 `export const Issue = z.object({ … }) satisfies Codec<T.Issue>`（`Codec<A>` 是 `z.ZodType<A, Wire<A>>`，在 `packages/protocol/src/codec.ts`），两边对不上就编不过。用 `satisfies` 而不是 `: Codec<…>`：Schema 保住自己的类型（对象的 `.shape`、`.extend`，接口的入参要拼它）。
- **可选字段用 `z.exactOptional(x)`**（仓库开着 `exactOptionalPropertyTypes`，`.optional()` 会多出 `| undefined`）。
- **品牌主键**：手写类型是 `string & { readonly [brand]: "IssueId" }`；Schema 用 `common/schema.ts` 的 `branded<T.IssueId>()`；门内造一个用 `issueId(s)`。
- **解的时候**：门口用 `X.parse(v)`（错了抛 `ZodError`，网关答 `InvalidInput`）；要自己处理错的用 `X.safeParse(v)`。不要 `as` 一个没解过的值。
- **JSON 列和落盘文件**：Schema 里写 `jsonString(X)`（`@vibevalley/protocol/schema`：`z.string()` 转 `JSON.parse` 再 `pipe(X)`）；服务端读一列用 `base/json.ts` 的 `storedJsonOrUndefined(X, "表.列")`，坏了当场失败，带表名和列名，不吞。
- **工具给模型的参数**：`z.toJSONSchema(X)`。
- **密钥**：`Secret`（`toJSON` 抛错，`toString` 是 `[secret]`），`secretOf(z.string())` 解进来。

## 6. 库

- SQL 只写在 `apps/server/db/queries/<表>.sql`，每条 `-- name: GetIssue :one|:many|:exec`；`vp run --filter @vibevalley/server db:generate` 写出 `db/generated/<表>.sql.ts`：每条查询一个参数类型、一个结果行的 Zod Schema、一个函数 `getIssue(sql, params)`。代码里只调生成的函数。
- `Db`（`infra/db.ts`）给出 `sql`（一个 `Sql`），事务是 `await db.tx(async (tx) => { … })`，里面的函数收 `tx`。一个事务里的写一个接一个 `await`，不要 `Promise.all`。
- 出库的每一行都经结果 Schema 解；对不上抛错，不在读的地方兜底旧数据（内部不留兼容，照旧）。
- 一条语句失败抛 `SqlError`，默认就让它抛（网关答 500）。只有失败要告诉调用方或重试的地方才 `catch (e) { if (e instanceof SqlError) … }`，这些地方和理由列在 `infra/db.test.ts` 的 `catching` 表里（原来用 `db.attempt`、`db.attemptTx` 的就是这些）；多一处要在表里加一行。
- `db.tx` 里调到的函数照样用 `db.sql`：它自己知道在不在事务里（嵌套的是保存点）。不要把事务对象一路传下去。

## 7. HTTP 和订阅

- 网关是 Hono，只听 127.0.0.1。接口仍由 `packages/protocol` 的 `<概念>/api.ts` 定：`endpoints` 列出 `op`、`input`、`result`（Zod）、`can`；处理函数的类型是 `(input) => Promise<Result>`，在 `gateway/http/handlers/<概念>.ts` 里只做转发。
- 订阅（原来的 Effect RPC）是 SSE：`subscriptions` 列出每条订阅的入参和每个事件的 Schema，服务端写 `async function*`，客户端读 `EventSource` 的流并用 Schema 解。
- 出去的请求用 `fetch`（全局的，或从 `deps.fetch` 进来以便测试换掉），带上 `signal`。

## 8. 日志、配置、度量

- 日志：`deps.log`（`infra/log.ts` 的 `Logger`：`debug`、`info`、`warn`、`error`，带模块名）。服务端不直接 `console.*`（lint 查）。
- 配置：`infra/config.ts` 用 Zod 解环境和 `vibevalley.yaml`，得到 `ServerConfig`，从 `deps.config` 进来。
- 度量：`infra/metrics.ts` 的计数器（`counter(name).add(n)`），测试读它守热路径的预算。

## 9. 测试

- `vite-plus/test` 的 `test`、`describe`、`expect`；异步测试直接写 `async`。
- 整农场：`await using farm = await world({ … })`（`src/testing/world.ts`），帮工照旧是 oar 的 `scriptedRuntime`，模型照旧是照脚本回答的 `Llm`。
- 时间：`vi.useFakeTimers()` 加 `vi.advanceTimersByTimeAsync(ms)`；或者给 `deps.clock` 一个测试时钟。不在测试里真等。
- 等一个条件：`@vibevalley/testkit/until` 的 `until`、`waitFor`（改成 Promise 的版本）。
- `regression:` 开头的测试照旧，名字不改。

## 10. 从 Effect 改过来：逐条对照

| Effect | 普通 TypeScript |
|---|---|
| `Effect.gen(function* () { … })`、`Effect.fn("X.y")(function* (a) { … })` | `async (a) => { … }`；名字写在函数名或对象的键上 |
| `yield* x` | `await x` |
| `Effect.succeed(a)` / `Effect.void` / `Effect.sync(f)` | `a` / `return` / `f()` |
| `Effect.fail(e)`、`return yield* e`（可 yield 的错误） | `throw e` |
| `Effect.promise(f)`、`Effect.tryPromise({ try, catch })` | `await f()`；要换错误的包一层 `try/catch` |
| `Effect.catchTag("X", f)`、`Effect.catch(f)`、`catchIf` | `try { … } catch (e) { if (e instanceof X) return f(e); throw e; }` |
| `Effect.mapError(f)` | `catch (e) { throw f(e); }` |
| `Effect.orDie`、`orElseSucceed(() => a)` | 让它抛 / `catch { return a; }`（写明为什么吞） |
| `Effect.ensuring(f)`、`onExit`、`onInterrupt` | `finally`；打断时才做的看 `isAbort(e, signal)` |
| `Effect.acquireRelease`、`Scope`、`Scope.provide` | `await using`、`AsyncDisposableStack` |
| `Effect.forEach(xs, f)` / `{ concurrency: "unbounded" }` / `{ concurrency: n }` | `for…of` 加 `await` / `Promise.all` / `mapConcurrent` |
| `Effect.all({ a, b })` | `const [a, b] = await Promise.all([…])` |
| `Effect.fork*`、`FiberSet.run` | `tasks.run(name, (signal) => …)` |
| `FiberMap.run(key, …)`、`FiberHandle` | `tasks.keyed(key, …)` |
| `Fiber.join`、`Fiber.await` / `Fiber.interrupt` | `await t.result`、`await t.done` / `await t.abort()` |
| `Effect.interruptible`、`uninterruptible` | 传 / 不传 `signal` |
| `Effect.timeout`、`timeoutOption` | `withTimeout` |
| `Effect.retry(Schedule…)`、`Effect.repeat`、`Schedule.spaced` | `retry`；循环里 `await clock.sleep(ms, signal)` |
| `Effect.sleep`、`Clock.currentTimeMillis` | `clock.sleep`、`clock.now()` |
| `Deferred` | `Promise.withResolvers()` |
| `Queue` / `PubSub` / `SubscriptionRef` | `Queue` / `Hub` / `Cell` |
| `Ref`、`SynchronizedRef` | 变量 / 变量加 `Semaphore(1)` |
| `Semaphore.withPermits(n)(eff)` | `await sem.with(() => …, n)` |
| `Stream.*` | `async function*` 和 `for await`；`Stream.fromQueue(q)` 是 `q` 本身；`Stream.merge` 是 `merge`；`Stream.splitLines` 是 `lines` |
| `Cache` | 一个 `Map` 加 TTL，或在构造时算一次 |
| `Option` / `Exit` / `Cause` / `Result` | `T \| undefined` / `Promise.allSettled` 或 `try` / `e` 本身 / 判别联合 |
| `Context.Service` 加 `Layer` | 接口加 `make…(deps)`（第 1 节） |
| `Effect.log*`、`Effect.annotateLogs` | `deps.log.info(…)` |
| `Config.*`、`Redacted` | `ServerConfig`（Zod 解的）、`Secret` |
| `Metric.counter` | `counter(name)` |
| `FileSystem`、`Path` | `node:fs/promises`、`node:path` |
| `HttpClient` | `fetch`（或 `deps.fetch`），带 `signal` |
| `ChildProcess`（`effect/process`） | `node:child_process` 的 `spawn`，`signal` 传给它，退出时收干净 |
| `Schema.TaggedError` | `Error` 子类（第 2 节） |
| `it.effect`、`it.live`、`TestClock` | `test(…, async () => …)`、`vi.useFakeTimers()` |

### Schema 到 Zod

| Effect Schema | Zod 4 |
|---|---|
| `Schema.String` / `NonEmptyString` / `Trim` | `z.string()` / `z.string().min(1)` / `z.string().trim()` |
| `Schema.Finite`、`Schema.Number` / `Schema.Int` | `z.number()`（不收 `Infinity`）/ `z.number().int()` |
| `Schema.Boolean` / `Unknown` / `Void`、`void` | `z.boolean()` / `z.unknown()` / `z.void()` |
| `Schema.Struct({ … })` | `z.object({ … })`（多出的字段去掉） |
| `Schema.optionalKey(x)` / `Schema.optional(x)` | `z.exactOptional(x)` / `x.optional()` |
| `Schema.NullOr(x)` / `UndefinedOr(x)` | `x.nullable()` / `x.optional()` |
| `Schema.Array(x)`、`mutable(Array(x))` | `z.array(x)` |
| `Schema.Literal(a)` / `Literals(xs)` | `z.literal(a)` / `z.enum(xs)`（字符串）或 `z.literal([...xs])` |
| `Schema.Union([...])` | `z.discriminatedUnion("kind", [...])`（有判别字段时）或 `z.union([...])` |
| `Schema.Record(K, V)` | `z.record(K, V)` |
| `Schema.Tuple([...])` | `z.tuple([...])` |
| `Schema.TaggedStruct("X", { … })` | `z.object({ _tag: z.literal("X"), … })` |
| `Schema.fromJsonString(x)` | `jsonString(x)` |
| `FiniteFromString`、`NumberFromString` / `URLFromString` | `z.coerce.number()` / `z.url()` |
| `isBetween(a, b)`、`isGreaterThan…`、`isMaxLength`、`isPattern` | `.min()`、`.max()`、`.gt()`、`.regex()` |
| `Schema.brand("X")` | `branded<T.X>()` |
| `Schema.suspend(() => x)` | `z.lazy(() => x)` |
| `Schema.Redacted(x)` | `secretOf(x)` |
| `decodeUnknownSync(x)(v)` / `decodeUnknownOption`、`decodeUnknownExit` / `decodeEffect` | `x.parse(v)` / `x.safeParse(v)` / `x.parse(v)` |
| `encodeEffect(x)(a)`、`encodeSync` | 值本身（Zod 的 Schema 不需要编码；有转换的写成 `z.codec`） |
| `Schema.is(x)(v)` | `x.safeParse(v).success` |
| `Schema.toJsonSchemaDocument(x)` | `z.toJSONSchema(x)` |

## 11. 改写服务端的一个模块（改写期间同时有几个模块在改）

几个模块同时在改，谁也看不到别人改完的样子，所以每个模块都照同一套规则改，邻居的样子由规则推出来，不用等。

**接口怎么翻**（照 `class X extends Context.Service<X, { … }>` 里写的接口，一条一条换）：

| 原来的成员 | 改成 |
|---|---|
| `(a) => Effect.Effect<A>`、`(a) => Effect.Effect<A, E>` | `(a) => Promise<A>`（E 照常抛） |
| 成员本身是 `Effect.Effect<A>`（`pollGitHub: Effect.Effect<void>`） | `() => Promise<A>` |
| `Stream.Stream<A>` | `(signal?: AbortSignal) => AsyncIterable<A>` |
| `Effect.Effect<Stream.Stream<A>, never, Scope>`（先订阅再返回） | `() => Subscription<A>`（`@vibevalley/async`） |
| 同步的成员（`() => readonly T.Issue[]`） | 不变 |

接口改写成 `export interface X { … }`，和原来的类同名、同一个文件；原来叫 `X["Service"]` 的地方写 `X`。`Core` 已经改好（`apps/server/src/core/core.ts`）：它的方法都是同步的（`core.apply(…)`、`core.notice(…)` 不用 `await`），订阅返回 `Subscription`。

**工厂和依赖**：

- 原来的 `const make = Effect.gen(function* () { const a = yield* A; … })` 改成 `export async function makeX(deps: XDeps): Promise<X>`；`XDeps` 是一个接口，只列它用到的。
- `deps` 的键是服务名的首字母小写：`core`、`db`、`config`、`setting`、`user`、`attachment`、`provider`、`llm`、`agent`、`memory`、`runtime`、`repo`、`machine`、`session`、`channel`、`media`、`library`、`artifact`、`pkm`、`mailbox`、`issue`、`cron`、`inbox`、`tool`、`orchestrator`、`game`、`mcp`、`lan`、`voice`、`connector`。平台的几个：`clock`（`Time`，`infra/time.ts`：`now`、`sleep`、`after`）、`log`（`Logger`，`infra/log.ts`，自己再 `log.child("issue")`）、`fetch`（原来的 `HttpClient`，类型 `typeof fetch`）、`publicFetch`（原来的 `PublicHttp`，`infra/publicHttp.ts`）。`FileSystem`、`Path` 不进 deps，直接用 `node:fs/promises`、`node:path`。
- 原来 `X.layer(options)` 收的选项（`RuntimeOptions`、`RepoHooks`……）照旧是 `makeX(deps, options)` 的第二个参数。
- 原来叠在最后的 `start`、`ready` 这类 layer：改成接口上的 `readonly start: () => Promise<void>`，`services.ts` 在全部建好以后按模块次序调。原来挂在作用域上的收尾（`Effect.addFinalizer`、`forkScoped` 的纤程、`keptFile` 的最后一次写）：接口上的 `readonly close: () => Promise<void>`，倒着调。
- `services.ts`、`testing/world.ts` 由一个人统一改，模块里不要改它们。
- 一个文件夹里的私有文件（`issue/dispatch.ts`、`issue/store.ts`）跟着它的模块一起改；它们之间也照同样的规则。

**测试**：

- `import { describe, expect, test } from "vite-plus/test"`；`it.effect(…, () => Effect.gen(function* () { … }).pipe(Effect.provide(world(o))))` 改成 `test(…, async () => { await using farm = await world(o); … })`。
- `yield* Issue` 改成 `farm.issue`（同上的小写键），`yield* Said` 改成 `farm.said`，`yield* Core` 是 `farm.core`、`yield* Db` 是 `farm.db`。`world`、`moduleWorld` 的选项（`WorldOptions`）不变；`testConfig()`、`testIssues()` 不变；`testDatabase()` 改成 `await testDb(change)`（返回 `Db`）。
- 等条件：`await until(() => …, "what")`、`const a = await waitFor(() => farm.issue.get(id), (i) => i.status === "done", "what")`（`@vibevalley/testkit/until`，改成 Promise 的版本）。
- 原来 `Effect.flip(x)` 拿错误：`const e = await x.catch((e: unknown) => e)`，再 `expect(e).toBeInstanceOf(ApiError)`、`expect(e).toMatchObject({ bizCode: … })`。
- 测试名一个字都不改；`regression:` 的测试只改怎么跑，不改断言。
