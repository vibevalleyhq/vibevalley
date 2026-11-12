---
name: vv-typescript
description: 在 VibeValley 里写、改、评审服务端和各个包的 TypeScript：服务是工厂函数加一个接口、依赖从参数进来；预期的拒绝抛 ApiError（带 bizCode），模块自己的失败是 Error 子类、用 instanceof 接；长操作收 AbortSignal，后台任务进 @vibevalley/async 的 TaskGroup，资源用 await using；时间经 Clock；运行时校验只用 Zod（契约、查询的行、落盘的 JSON、配置、工具入参）；库只经 db/generated 生成的函数；HTTP 是 Hono。用在：写或改 apps/server、apps/cli、packages/* 的代码；评审一段异步代码（打断、收尾、并发、错误）。
---

# 在这个仓库写普通 TypeScript

服务端、命令行和各个包都是普通 TypeScript：`async`/`await`、`AbortSignal`、`await using`、工厂函数，运行时校验只用 Zod。为什么不用 Effect 见[地基](docs/subsystems/foundation.md#为什么这样)。

## 1. 服务：工厂函数加一个接口

一个模块导出一个服务：接口和模块同名（`Issue`、`Session`），工厂叫 `make<名字>`，依赖是一个对象参数，只放它用到的、排在它前面的服务（[architecture.md](docs/architecture.md)）。

```ts
// apps/server/src/modules/issue/issue.ts
import type * as T from "@vibevalley/protocol";

export interface Issue {
  readonly get: (id: T.IssueId) => Promise<T.Issue>;
  /** Each change to an issue, from now on. */
  readonly changes: () => Subscription<IssueChange>;
  /** At startup, after the modules below it booted. */
  readonly boot: () => Promise<void>;
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
  return { get, changes, boot, close: () => tasks.close() };
}
```

- 别处要它的类型写 `Issue`；和它同名的协议形状写 `T.Issue`。
- `services.ts` 照模块次序一个个 `await make…(deps)`，拼成 `Farm`；全部建好以后按次序调各自的 `boot()`（开机做的事叫 `boot`，`start` 只指开始干一件事，[命名](docs/style/naming.md)）；`farm.close()` 倒着调 `close()`。`Farm` 是 `AsyncDisposable`，测试里 `await using farm = await world()`。
- 没有全局的单例：时钟、库、配置都从 `deps` 进来，测试换它们只换参数。
- 一个服务的接口很大时（频道），接口放同模块的 `contracts.ts`。

## 2. 错误

- **对调用方的拒绝**（参数不对、不让做、找不到）：抛 `ApiError`（`@vibevalley/protocol/api`），带 `bizCode`。`base/errors.ts` 的帮手：`throw refused(t("…"))`、`throw missing(…)`。网关把它写成 `{ bizCode, message, error? }`。
- **模块自己的、调用方要分辨的失败**：一个 `Error` 子类，`name` 和类名一样、全仓唯一，用 `instanceof` 接：

  ```ts
  export class HireRefused extends Error {
    override readonly name = "HireRefused";
    constructor(readonly reason: string, readonly retainedWork = false) { super(reason); }
  }
  try { await hire(…); } catch (e) { if (!(e instanceof HireRefused)) throw e; … }
  ```
- **预期的、不是错误的结果**（找到或没找到、合进去或冲突）：返回一个判别联合（`{ kind: "merged" } | { kind: "conflict"; files }`），不抛。
- **意外**：照常抛（`throw new Error`、`invariant`），网关答 500 并记日志。不要用 `catch {}` 吞掉；要吞的写明为什么，并记一行日志。

## 3. 打断、后台任务、资源

- **长操作收 `signal?: AbortSignal`**，作为最后一个参数，往下传给 `fetch`、子进程、`clock.sleep`、`queue.take`。被打断就让 `AbortError` 往上抛；判断用 `isAbort(e, signal)`。
- **后台任务进 `TaskGroup`**（`@vibevalley/async`）：每个服务一个，`tasks.run(name, async (signal) => …)`；关服务时 `await tasks.close()`，它中止每个任务并等它们结束。不要 `void someAsync()` 放着不管（`no-floating-promises` 查）。
  - 同一个键只许一个在跑：`tasks.keyed(key, …)`，新的先停掉旧的。
  - 要拿结果的：`const t = tasks.spawn(name, f); await t.result`。
- **资源成对**：返回资源的函数返回带 `[Symbol.asyncDispose]` 的对象，调用方 `await using`；几个资源一起用 `AsyncDisposableStack`。没法写成资源的，用 `try { … } finally { … }`。
- **不许被打断的一段**：不把 `signal` 传进去，注释写为什么。

## 4. 并发和时间

| 要做的 | 写法（`@vibevalley/async`） |
|---|---|
| 一个一个来 | `for (const x of xs) await f(x)` |
| 一起来，等全部 | `await Promise.all(xs.map(f))` |
| 一起来，最多 n 个 | `await mapConcurrent(xs, n, f)` |
| 一把锁、n 个名额 | `const lock = new Semaphore(1); await lock.with(() => …)` |
| 跨异步的状态 | 普通的变量或字段；有 `await` 夹在读和写之间时，读改写包进同一把锁 |
| 一个值和它的变化 | `Cell` |
| 一条队列 | `Queue`（`unbounded`、`sliding`、`dropping`） |
| 给很多读者的新闻 | `Hub`；读者 `using sub = hub.subscribe()`，`for await (const x of sub)` |
| 一串值 | `AsyncIterable`，写成 `async function*`；`merge`、`map`、`filter`、`lines`、`collect` |
| 等一个将来的值 | `Promise.withResolvers()` |
| 现在几点、等一会儿 | `deps.clock.now()`、`await deps.clock.sleep(ms, signal)`；不直接 `Date.now()`、`setTimeout`（lint 查） |
| 超时 | `await withTimeout((signal) => f(signal), ms, { clock })` |
| 重试 | `await retry(f, { retries: 3, delay: exponential(200), when: (e) => …, clock, signal })` |

## 5. 运行时校验：只用 Zod

契约（`packages/protocol` 的 `schema.ts`）、HTTP 入参、SSE、查询的每一行、落盘的 JSON、配置、工具入参都用 Zod 4 解，进门一次，门内是类型。

- **契约由手写的类型定**：`shapes.ts` 是手写的类型，`schema.ts` 里每个 Schema 写成 `export const Issue = z.object({ … }) satisfies Codec<T.Issue>`（`Codec<A>` 是 `z.ZodType<A, Wire<A>>`，在 `packages/protocol/src/codec.ts`），两边对不上就编不过。用 `satisfies` 而不是 `: Codec<…>`：Schema 保住自己的类型（对象的 `.shape`、`.extend`，接口的入参要拼它）。
- **可选字段用 `z.exactOptional(x)`**（仓库开着 `exactOptionalPropertyTypes`，`.optional()` 会多出 `| undefined`）。
- **品牌主键**：手写类型是 `string & { readonly [brand]: "IssueId" }`；Schema 用 `common/schema.ts` 的 `branded<T.IssueId>()`；门内造一个用 `issueId(s)`。
- **解的时候**：门口用 `X.parse(v)`（错了抛 `ZodError`，网关答 `InvalidInput`）；要自己处理错的用 `X.safeParse(v)`。不要 `as` 一个没解过的值。
- **JSON 列和落盘文件**：Schema 里写 `jsonString(X)`（`@vibevalley/protocol/schema`：`z.string()` 转 `JSON.parse` 再 `pipe(X)`）；服务端读一列用 `base/json.ts` 的 `storedJsonOrUndefined(X, "表.列")`，坏了当场失败，带表名和列名，不吞。
- **工具给模型的参数**：`z.toJSONSchema(X)`。
- **密钥**：`Secret`（`toJSON` 抛错，`toString` 是 `[secret]`），`secretOf(z.string())` 解进来。

## 6. 库

- SQL 只写在 `apps/server/db/queries/<表>.sql`，每条 `-- name: GetIssue :one|:many|:exec`；`vp run --filter @vibevalley/server db:generate` 写出 `db/generated/<表>.sql.ts`：每条查询一个参数类型、一个结果行的 Zod Schema、一个函数 `getIssue(sql, params)`。代码里只调生成的函数。
- `Db`（`infra/db.ts`）给出 `sql`（一个 `Sql`），事务是 `await db.tx(async () => { … })`，里面照样传 `db.sql`。一个事务里的写一个接一个 `await`，不要 `Promise.all`。提交以后才做的事（发新闻、通知）用 `db.afterCommit(hook)`：回滚了就不做。
- 出库的每一行都经结果 Schema 解；对不上抛错，不在读的地方兜底旧数据（内部不留兼容）。
- 一条语句失败抛 `SqlError`，默认就让它抛（网关答 500）。只有失败要告诉调用方或重试的地方才 `catch (e) { if (e instanceof SqlError) … }`，这些地方和理由列在 `infra/db.test.ts` 的 `catching` 表里；多一处要在表里加一行。
- `db.tx` 里调到的函数照样用 `db.sql`：它自己知道在不在事务里（嵌套的是保存点）。不要把事务对象一路传下去。

## 7. HTTP 和订阅

- 网关是 Hono，只听 127.0.0.1。接口仍由 `packages/protocol` 的 `<概念>/api.ts` 定：`endpoints` 列出 `op`、`input`、`result`（Zod）、`can`；处理函数的类型是 `(input) => Promise<Result>`，在 `gateway/http/handlers/<概念>.ts` 里只做转发。
- 订阅是 SSE：`subscriptions` 列出每条订阅的入参和每个事件的 Schema，服务端写 `async function*`，客户端读 `EventSource` 的流并用 Schema 解。
- 出去的请求用 `fetch`（全局的，或从 `deps.fetch` 进来以便测试换掉），带上 `signal`。

## 8. 日志、配置、度量

- 日志：`deps.log`（`infra/log.ts` 的 `Logger`：`debug`、`info`、`warn`、`error`，带模块名）。服务端不直接 `console.*`（lint 查）。
- 配置：`infra/config.ts` 用 Zod 解环境和 `vibevalley.yaml`，得到 `ServerConfig`，从 `deps.config` 进来。
- 度量：`infra/metrics.ts` 的计数器（`counter(name).add(n)`），测试读它守热路径的预算。

## 9. 测试

- `vite-plus/test` 的 `test`、`describe`、`expect`；异步测试直接写 `async`。
- 整农场：`await using farm = await world({ … })`（`src/testing/world.ts`），帮工是 oar 的 `scriptedRuntime`，模型是照脚本回答的 `Llm`。
- 时间：`vi.useFakeTimers()` 加 `vi.advanceTimersByTimeAsync(ms)`；或者给 `deps.clock` 一个测试时钟（`world({ clock: shiftedTime() })`）。不在测试里真等。
- 等一个条件：`@vibevalley/testkit/until` 的 `until`、`waitFor`；整农场的状态用 `testing/layers.ts` 的 `whenState`。
- 修缺陷补的测试以 `regression: ` 开头，删改它要在 PR 里点名说明。
