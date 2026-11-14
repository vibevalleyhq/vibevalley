---
name: vv-typescript
description: 在 VibeValley 里写、改、评审页面、宿主和各个包的 TypeScript：预期的拒绝是 ApiError（带 bizCode），模块自己的失败是 Error 子类、用 instanceof 接；长操作收 AbortSignal，后台任务进 @vibevalley/async 的 TaskGroup，资源用 await using；运行时校验只用 Zod（契约、SSE、桥、落盘的 JSON）。用在：写或改 apps/web、apps/desktop、apps/mobile、apps/mac/ui、apps/site、packages/*、scripts/ 的代码；评审一段异步代码（打断、收尾、并发、错误）。服务端和命令行是 Rust（crates/），不归这里。
---

# 在这个仓库写普通 TypeScript

页面、宿主、各个包和脚本都是普通 TypeScript：`async`/`await`、`AbortSignal`、`await using`、工厂函数，运行时校验只用 Zod。为什么不用 Effect 见[地基](docs/subsystems/foundation.md#为什么这样)。服务端和命令行是 Rust（`crates/`），不照这一篇。

## 1. 错误

- **服务端的拒绝**（参数不对、不让做、找不到）：线上是 `ApiError`（`@vibevalley/protocol/api`，`{ bizCode, message, next? }`），客户端按 `bizCode` 分辨，不解析 `message`。
- **模块自己的、调用方要分辨的失败**：一个 `Error` 子类，`name` 和类名一样、全仓唯一，用 `instanceof` 接：

  ```ts
  export class HireRefused extends Error {
    override readonly name = "HireRefused";
    constructor(readonly reason: string, readonly retainedWork = false) { super(reason); }
  }
  try { await hire(…); } catch (e) { if (!(e instanceof HireRefused)) throw e; … }
  ```
- **预期的、不是错误的结果**（找到或没找到、合进去或冲突）：返回一个判别联合（`{ kind: "merged" } | { kind: "conflict"; files }`），不抛。
- **意外**：照常抛（`throw new Error`、`invariant`）。不要用 `catch {}` 吞掉；要吞的写明为什么，并记一行日志。

## 2. 打断、后台任务、资源

- **长操作收 `signal?: AbortSignal`**，作为最后一个参数，往下传给 `fetch`、子进程、`clock.sleep`、`queue.take`。被打断就让 `AbortError` 往上抛；判断用 `isAbort(e, signal)`。
- **后台任务进 `TaskGroup`**（`@vibevalley/async`）：每个拥有后台工作的对象一个，`tasks.run(name, async (signal) => …)`；关它时 `await tasks.close()`，它中止每个任务并等它们结束。不要 `void someAsync()` 放着不管（`no-floating-promises` 查）。
  - 同一个键只许一个在跑：`tasks.keyed(key, …)`，新的先停掉旧的。
  - 要拿结果的：`const t = tasks.spawn(name, f); await t.result`。
- **资源成对**：返回资源的函数返回带 `[Symbol.asyncDispose]` 的对象，调用方 `await using`；几个资源一起用 `AsyncDisposableStack`。没法写成资源的，用 `try { … } finally { … }`。
- **不许被打断的一段**：不把 `signal` 传进去，注释写为什么。

## 3. 并发和时间

| 要做的 | 写法（`@vibevalley/async`） |
|---|---|
| 一个一个来 | `for (const x of xs) await f(x)` |
| 一起来，等全部 | `await Promise.all(xs.map(f))` |
| 一起来，最多 n 个 | `await mapConcurrent(xs, n, f)` |
| 一把锁、n 个名额 | `const lock = new Semaphore(1); await lock.with(() => …)` |
| 跨异步的状态 | 普通的变量或字段；有 `await` 夹在读和写之间时，读改写包进同一把锁 |
| 一条队列 | `Queue`（`unbounded`、`sliding`、`dropping`） |
| 给很多读者的新闻 | `Hub`；读者 `using sub = hub.subscribe()`，`for await (const x of sub)` |
| 一串值 | `AsyncIterable`，写成 `async function*`；`merge`、`map`、`lines`、`collect`、`mapConcurrent` |
| 等一个将来的值 | `Promise.withResolvers()` |
| 现在几点、等一会儿 | 经 `Clock`（`@vibevalley/async`）读和等；不直接 `Date.now()`、`setTimeout`（lint 查） |
| 超时 | `await withTimeout((signal) => f(signal), ms, { clock })` |
| 重试 | `await retry(f, { retries: 3, delay: exponential(200), when: (e) => …, clock, signal })` |

## 4. 运行时校验：只用 Zod

契约（`packages/protocol` 的 `schema.ts`，现在也是生成 Rust 类型的源）、HTTP 的结果、SSE、桥、落盘的 JSON 都用 Zod 4 解，进门一次，门内是类型。

- **契约由手写的类型定**：`shapes.ts` 是手写的类型，`schema.ts` 里每个 Schema 写成 `export const Issue = z.object({ … }) satisfies Codec<T.Issue>`（`Codec<A>` 是 `z.ZodType<A, Wire<A>>`，在 `packages/protocol/src/codec.ts`），两边对不上就编不过。用 `satisfies` 而不是 `: Codec<…>`：Schema 保住自己的类型（对象的 `.shape`、`.extend`，接口的入参要拼它）。
- **可选字段用 `z.exactOptional(x)`**（仓库开着 `exactOptionalPropertyTypes`，`.optional()` 会多出 `| undefined`）。
- **品牌主键**：手写类型是 `string & { readonly [brand]: "IssueId" }`；Schema 用 `common/schema.ts` 的 `branded<T.IssueId>()`；门内造一个用 `issueId(s)`。
- **解的时候**：门口用 `X.parse(v)`（错了抛 `ZodError`，网关答 `InvalidInput`）；要自己处理错的用 `X.safeParse(v)`。不要 `as` 一个没解过的值。
- **落盘的 JSON**：Schema 里写 `jsonString(X)`（`@vibevalley/protocol/schema`：`z.string()` 转 `JSON.parse` 再 `pipe(X)`），坏了当场失败，不吞。
- **密钥**：`Secret`（`toJSON` 抛错，`toString` 是 `[secret]`）。

## 5. 测试

- `vite-plus/test` 的 `test`、`describe`、`expect`；异步测试直接写 `async`。
- 页面的 Playwright 对着隔离的真服务端（Rust 的 `vibevalley-server`，`VIBEVALLEY_TEST_RUNTIMES=1` 时帮工是替身农机 `pi`），只按 `data-testid` 找元素。
- 时间：`vi.useFakeTimers()` 加 `vi.advanceTimersByTimeAsync(ms)`，或给 `Clock` 一个测试时钟。不在测试里真等。
- 等一个条件：`@vibevalley/testkit/until` 的 `until`、`waitFor`。
- 修缺陷补的测试以 `regression: ` 开头，删改它要在 PR 里点名说明。
