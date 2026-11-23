---
name: vv-typescript
description: 在 VibeValley 里写、改、评审原生应用的页面、官网、各个包和脚本的 TypeScript：预期的拒绝是 ApiError（带 bizCode），模块自己的失败是 Error 子类、用 instanceof 接；长操作收 AbortSignal，不留没人等的 Promise；运行时校验只用 Zod（契约、流、落盘的 JSON）。用在：写或改 apps/mac/ui、apps/site、packages/*、scripts/ 的代码；评审一段异步代码（打断、收尾、并发、错误）。服务端、命令行和应用的外壳是 Rust（crates/、apps/mac/src），不归这里。
---

# 在这个仓库写普通 TypeScript

原生应用的页面（`apps/mac/ui`）、官网、各个包和脚本都是普通 TypeScript：`async`/`await`、`AbortSignal`、工厂函数，运行时校验只用 Zod。服务端、命令行和应用的外壳是 Rust（`crates/`、`apps/mac/src`），不照这一篇。`apps/mac/ui` 由 nsh 查类型（`vp run mac:check`），lint 不扫它；别处由 `vp check` 查。

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

- **长操作收 `signal?: AbortSignal`**，作为最后一个参数，往下传给 `fetch` 或 `VibeValleyApi` 的 `Transport` 调用。被打断就让 `AbortError` 往上抛。
- **不放着不管的 Promise**：不要 `void someAsync()`（`no-floating-promises` 查）；拥有后台工作的对象自己记着它、关的时候中止并等它结束。
- **资源成对**：没法交给调用方 `using` 的，用 `try { … } finally { … }`；页面里订阅和计时器在所在作用域的 `cleanup` 里放掉。
- **不许被打断的一段**：不把 `signal` 传进去，注释写为什么。

## 3. 并发

| 要做的 | 写法 |
|---|---|
| 一个一个来 | `for (const x of xs) await f(x)` |
| 一起来，等全部 | `await Promise.all(xs.map(f))` |
| 跨异步的状态 | 普通的变量或字段；有 `await` 夹在读和写之间时，把读改写排成一条队（`apps/mac/ui/features/artifact/editor.ts` 的 `BlockEditor`） |
| 一串值 | `AsyncIterable`，写成 `async function*` |
| 等一个将来的值 | `Promise.withResolvers()` |

## 4. 运行时校验：只用 Zod

页面收到的东西（接口的结果、帧、订阅的事件、存在本机的 JSON）都用 Zod 4 解，进门一次，门内是类型。

- **类型由 Rust 的契约生成**：`shapes.gen.ts` 是生成的类型（`vp run protocol:ts`），手写的 `schema.ts` 里每个 Schema 写成 `export const Issue = z.object({ … }) satisfies Codec<T.Issue>`（`Codec<A>` 是 `z.ZodType<A, Wire<A>>`，在 `packages/protocol/src/codec.ts`），两边对不上就编不过。用 `satisfies` 而不是 `: Codec<…>`：Schema 保住自己的类型（对象的 `.shape`、`.extend`，接口的入参要拼它）。
- **可选字段用 `z.exactOptional(x)`**（仓库开着 `exactOptionalPropertyTypes`，`.optional()` 会多出 `| undefined`）。
- **品牌主键**：门内造一个用 `packages/protocol/src/common/schema.ts` 的铸造函数（`issueId(s)`），不写 `as`。
- **解的时候**：门口用 `X.parse(v)`（错了抛 `ZodError`，网关答 `InvalidInput`）；要自己处理错的用 `X.safeParse(v)`。不要 `as` 一个没解过的值。
- **落盘的 JSON**：Schema 里写 `jsonString(X)`（`@vibevalley/protocol/schema`：`z.string()` 转 `JSON.parse` 再 `pipe(X)`），坏了当场失败，不吞。
- **密钥**：`Secret`（`toJSON` 抛错，`toString` 是 `[secret]`）。

## 5. 测试

- `vite-plus/test` 的 `test`、`describe`、`expect`；异步测试直接写 `async`。
- 包的测试是 `src/**/*.test.ts`；页面的测试用 `nsh/test`，在 `apps/mac/ui`，喂样例的 `Transport`。
- 时间：`vi.useFakeTimers()` 加 `vi.advanceTimersByTimeAsync(ms)`。不在测试里真等（`no-test-sleep` 查）。
- 等一个条件：`@vibevalley/testkit/until` 的 `until`、`waitFor`。
- 修缺陷补的测试以 `regression: ` 开头，删改它要在 PR 里点名说明。
