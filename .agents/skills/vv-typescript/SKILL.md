---
name: vv-typescript
description: 在 VibeValley 里写、改、评审各共享包（packages/*）、工具脚本（scripts/*）与非 UI 端 TypeScript：能力是工厂函数加一个接口、依赖从参数进来；预期的拒绝用 ApiError（带 bizCode），自己的失败是 Error 子类、用 instanceof 接；长操作收 AbortSignal，后台任务进 @vibevalley/async 的 TaskGroup，资源用 await using；时间经 Clock；运行时校验只用 Zod（契约、桥、配置、序列化）；HTTP 调用传 signal。用在：写或改 packages/*、scripts/*、apps/web/src/infra 或 apps/mobile/src/infra 的代码；评审一段异步代码（打断、收尾、并发、错误）。
---

# 在这个仓库写普通 TypeScript

后端已迁入 Go（`cmd/*`、`internal/*`、`pkg/*`）；仓库里所有留下的共享包（`packages/*`）、客户端逻辑与脚本都是普通 TypeScript：`async`/`await`、`AbortSignal`、`await using`、工厂函数，运行时校验只用 Zod。为什么不用 Effect 见[地基](docs/subsystems/foundation.md#为什么这样)。

## 1. 服务与能力：工厂函数加一个接口

一个非 UI 能力暴露一个简洁接口，只留调用方用的（同一件事的几种做法是一个成员的标签），内部细节不露出去，判断写成纯函数；工厂叫 `make<名字>`（如 `packages/protocol/src/rpc.ts`、`packages/bridge` 宿主适配器、`packages/ai` 会话），依赖通过参数对象传进来（[architecture.md](docs/architecture.md)）：

```ts
import type * as T from "@vibevalley/protocol";
import { TaskGroup, type Clock } from "@vibevalley/async";

export interface IssueStream {
  readonly close: () => Promise<void>;
}

export interface IssueStreamDeps {
  readonly clock: Clock;
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

export function makeIssueStream(deps: IssueStreamDeps): IssueStream {
  const tasks = new TaskGroup({ name: "issue-stream" });
  return { close: () => tasks.close() };
}
```

- 和它同名的协议形状写 `T.Issue`（`protocol-namespace` 查，避免同名碰撞）。
- 没有全局单例，不直接在库里读系统时钟：时钟、`fetch`、底层通道从 `deps` 进来，测试传内存/脚本替身。
- 跨异步的清理用 `[Symbol.asyncDispose]` 与 `await using`。

## 2. 错误

- **对接口边界的拒绝**（参数不对、权限不足、找不到）：使用 `ApiError`（`packages/protocol/src/api.ts`、`packages/protocol/src/endpoint.ts`），带 `bizCode`（六位数字，注册在 `BizCode` / `BizErrorCodeValues`）。
- **模块自己的、调用方要分辨的失败**：一个 `Error` 子类，`name` 和类名一样、全仓唯一，用 `instanceof` 接（如 `packages/pkm`、`packages/artifact` 或桥超时错误）。
- **预期的、不是错误的结果**（命中与否、冲突）：返回一个判别联合（`{ kind: "merged" } | { kind: "conflict"; files }`），不抛。
- **意外**：照常抛，不写空 `catch {}` 吞掉错误（`packages/health` 棘轮查）。

## 3. 打断、后台任务、资源

- **长操作收 `signal?: AbortSignal`**，作为最后一个参数，往下传给 `fetch`、子进程、`clock.sleep`、`queue.take`。被打断就让 `AbortError` 往上抛；判断用 `isAbort(e, signal)`。
- **后台任务进 `TaskGroup`**（`@vibevalley/async`）：`tasks.run(name, async (signal) => …)`；关闭时 `await tasks.close()`，它会中止每个任务并等它们结束。不要 `void someAsync()` 放着不管（`no-floating-promises` 查）。
  - 同一个键只许一个在跑：`tasks.keyed(key, …)`，新的先停掉旧的。
  - 要拿结果的：`const t = tasks.spawn(name, f); await t.result`。
- **资源成对**：返回资源的函数返回带 `[Symbol.asyncDispose]` 的对象，调用方 `await using`；几个资源一起用 `AsyncDisposableStack`。
- **不许被打断的一段**：不把 `signal` 传进去，注释写为什么。

## 4. 并发和时间

| 要做的 | 写法（`@vibevalley/async`） |
|---|---|
| 一个一个来 | `for (const x of xs) await f(x)` |
| 一起来，等全部 | `await Promise.all(xs.map(f))` |
| 一起来，最多 n 个 | `await mapConcurrent(xs, n, f)` |
| 一把锁、n 个名额 | `const lock = new Semaphore(1); await lock.with(() => …)` |
| 跨异步的状态 | 普通的变量或字段；有 `await` 夹在读和写之间时，读改写包进同一把锁 |
| 一条队列 | `Queue`（`unbounded`、`sliding`、`dropping`） |
| 给很多读者的新闻 | `Hub`；读者 `using sub = hub.subscribe()`，`for await (const x of sub)` |
| 一串值 | `AsyncIterable`，写成 `async function*`；`merge`、`lines`、`collect`、`mapConcurrent` |
| 等一个将来的值 | `Promise.withResolvers()` |
| 现在几点、等一会儿 | `deps.clock.now()`、`await deps.clock.sleep(ms, signal)`；不直接 `Date.now()`、`setTimeout`（lint 查） |
| 超时 | `await withTimeout((signal) => f(signal), ms, { clock })` |
| 重试 | `await retry(f, { retries: 3, delay: exponential(200), when: (e) => …, clock, signal })` |

## 5. 运行时校验：只用 Zod

契约（`packages/protocol` 的 `schema.ts`）、SSE 帧、桥通信、配置与序列化都用 Zod 4 解，进门一次，门内是类型。

- **契约由手写的类型定**：`shapes.ts` 是手写的类型，`schema.ts` 里每个 Schema 写成 `export const Issue = z.object({ … }) satisfies Codec<T.Issue>`（`Codec<A>` 是 `z.ZodType<A, Wire<A>>`，在 `packages/protocol/src/codec.ts`），两边对不上就编不过。用 `satisfies` 而不是 `: Codec<…>`：Schema 保住自己的类型（对象的 `.shape`、`.extend`、接口入参要拼它），同时注意与 `pkg/contract/tsgen` 生成 Go 契约保持同步。
- **可选字段用 `z.exactOptional(x)`**（仓库开着 `exactOptionalPropertyTypes`，`.optional()` 会多出 `| undefined`）。
- **品牌主键**：手写类型是 `string & { readonly [brand]: "IssueId" }`；Schema 用 `common/schema.ts` 的 `branded<T.IssueId>()`；门内造一个用 `issueId(s)`（`schema-audit.ts` 查边界）。
- **解的时候**：门口用 `X.parse(v)`（错了抛 `ZodError`）；要自己处理错的用 `X.safeParse(v)`。不要 `as` 一个没解过的值。
- **JSON 字段**：Schema 里写 `jsonString(X)`（`@vibevalley/protocol/schema`：`z.string()` 转 `JSON.parse` 再 `pipe(X)`）。
- **密钥**：`Secret`（`toJSON` 抛错，`toString` 是 `[secret]`，在 `packages/protocol/src/common/schema.ts`），不要明文传或打印。

## 6. HTTP、SSE 与桥

- 客户端通过 `@vibevalley/protocol/client` 生成的 `VibeValleyApi`（由 `vp run api:client` 生成）调 Go 服务端 `/api/v1/*`，响应在边界经 Schema 解码。
- 订阅是 SSE：`packages/protocol/src/rpc.ts` 与 `<概念>/api.ts` 的 `subscriptions` 定义事件与入参，前端由 `apps/web/src/infra` 消费。
- 宿主通信走 `packages/bridge` 的强类型契约和 `packages/protocol/src/host.ts`。
- 出去的请求用注入的 `fetch`，带上 `signal`。

## 7. 测试

- `vite-plus/test` 的 `test`、`describe`、`expect`；异步测试直接写 `async`。
- 时间：`vi.useFakeTimers()` 加 `vi.advanceTimersByTimeAsync(ms)`；或者传测试 `Clock`（`@vibevalley/async`）。不在测试里真等。
- 等一个条件：`@vibevalley/testkit/until` 的 `until`、`waitFor`。
- 修缺陷补的测试以 `regression: ` 开头，删改它要在 PR 里点名说明。
