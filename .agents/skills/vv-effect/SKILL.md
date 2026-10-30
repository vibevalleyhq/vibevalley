---
name: vv-effect
description: 在 VibeValley 里写、改、评审 Effect v4 的代码（apps/server、packages/agent、packages/ai，effect 4.0.5）：先读包里自带的官方指南，再照本仓库的约定写：服务是 Context.Service 的类、库经 Db、文件经 FileSystem、时间经 Clock、Promise 只在库的一次调用上且写 { try, catch }、错误打标签按 catchTag 接、服务的方法用 Effect.fn 命名、测试用 it.effect 和 TestClock；哪些已经由 effect:check、vp check 的 effecttsgo 规则、vibevalley/* lint 和逃生口的棘轮拦着。用在：写或改任何用到 Effect 的代码（服务、layer、错误、Stream、Schedule、Schema、测试）；评审一段 Effect 代码；effect:check 或 vp check 报了 effecttsgo 的诊断不知道怎么改；不确定一个 API 在 v4 叫什么（Context.Tag、Effect.Service、catchAll、Either、Layer.scoped 这些 v3 名字都不在了）；主人说「Effect 的最佳实践」「这段 Effect 写得对不对」。
---

# 在这个仓库写 Effect

Effect 的写法有两层来源：官方指南（随安装的版本走）和本仓库在它之上加的约定。agent 的训练数据大多是 v3，社区的 skill 和文章里还有 v4 测试版的名字（`ServiceMap.Service`、`Schema.TaggedErrorClass`、`effect/unstable/*`），这些在 4.0.5 里都不存在；凭记忆写，最常见的结果是编不过，或者编过了但用的是旧的语义。

## 1. 先读什么

1. 完整读 `node_modules/effect/AGENTS.md`（从 `apps/server` 解析 `effect`，例子在同目录的 `ai-docs/src/**`）。它是官方给 agent 的指南，和装的版本一致，是最佳实践的唯一来源；本 skill 不复制它。
2. 不确定一个名字时，到 `node_modules/effect/src` 里搜它的定义，不照记忆和网上的例子写。
3. 读本仓库的约定：[地基](docs/subsystems/foundation.md)里讲 Effect、库、文件、时间、测试的几节，根目录 [AGENTS.md](AGENTS.md#规矩) 的「服务端的服务」。官方指南的每一节在这里用不用、对应哪里，见 [references/official-guide.md](.agents/skills/vv-effect/references/official-guide.md)。

## 2. 本仓库的约定

每条的理由在它的家里，这里只列出来、指过去。

| 约定 | 写法 | 家 |
|---|---|---|
| 服务 | `class Issues extends Context.Service<Issues, { … }>()("vibevalley/Issue") { static readonly layer = … }`，`make` 里 `yield*` 用到的服务，用 `Issues.of({ … })` 拼出来；要类型写 `Issues["Service"]` | [AGENTS.md](AGENTS.md#规矩)「服务端的服务」 |
| layer 的次序 | `apps/server/src/services.ts` 按次序叠，模块只用排在它前面的；开机要做的放在最后的 `start`、`ready` | [architecture.md](docs/architecture.md) |
| 库 | 经 `Db` 服务（`run`、`attempt`、`one`、`inTx`），模块不自己 `provideService(SqlClient)`；SQL 只写在 `db/queries/<表>.sql` | [地基](docs/subsystems/foundation.md) |
| 文件、进程、外面的 HTTP | `FileSystem`、`ChildProcessSpawner`、`HttpClient`；不用 `node:fs/promises`、`fetch` | [地基](docs/subsystems/foundation.md) |
| 时间 | `Clock`、`Effect.sleep`、`TestClock`；类里用它拿到的 `Time`（`apps/server/src/base/time.ts`）；lint `vibevalley/no-wall-clock` | [地基](docs/subsystems/foundation.md) |
| Promise | 只在外面的库的一次调用上：`Effect.tryPromise({ try: (signal) => lib.call(…, { signal }), catch: (e) => new XError({ cause: e }) })`。不写 `catch` 的形式失败时只剩 `UnknownError`，原因丢了；lint `vibevalley/promise-boundary` | [地基](docs/subsystems/foundation.md) |
| 错误 | 预期的错误打标签（`Data.TaggedError` / `Schema.TaggedError`），按 `catchTag`、`catchTags` 接，不用 `instanceof` 分；抛错写 `return yield*`；`Effect.orDie`、不带 `{ log }` 的 `Effect.ignore`、空的 `catch` 在逃生口的棘轮上（`vp run health:verify`），要丢弃一个失败就 `Effect.ignore({ log: "Warn" })` | [地基](docs/subsystems/foundation.md)、`packages/health/README.md` |
| 命名和追踪 | 服务的方法用 `Effect.fn("Issues.create")`，热路径和库函数用 `Effect.fnUntraced`；不写只 `return Effect.gen(…)` 的函数 | 官方指南「Writing Effect code」 |
| 并发 | `Effect.all`、`forEach` 默认一个接一个；要并发写明 `{ concurrency: n }`，用户给的数量不用 `"unbounded"` | 官方指南 |
| 不信任的数据 | `Schema` 解码（Effect 里用 `decodeUnknownEffect`），不手写类型守卫、不 `as`；对象的判断用 `Predicate.isObject`、`Predicate.hasProperty` | 官方指南「Defining schemas」 |
| 测试 | 服务端 `@effect/vitest` 的 `it.effect`；有时间窗口的拨 `TestClock`；等后台的事用 `until`、`waitFor`（`waitFor` 直接收一个 Effect），不睡固定时间 | [地基](docs/subsystems/foundation.md)的测试金字塔 |

## 3. 已经有检查拦着的

写的时候不用记，撞上了照报错改；报错不懂时看这里对应的那一行。

- **`vp run effect:check`**（`@effect/tsgo` 的语言服务，规则和级别在 `tsconfig.base.json` 的 `plugins`，警告也算失败）和 **`vp check` 里的 `effecttsgo/*`**（同一张表，`scripts/effect-lint.ts`）：漂着没运行的 Effect、少了 `return yield*`、`yield` 少了 `*`、v3 的旧 API、gen 里的 `try/catch`、Effect 里再 `run*` 一个 Effect、方法签名里漏出的依赖、服务没写成类、`Math.random`、`process.env`、`fetch`……开着哪些、为什么关着哪些，看那张表和[地基](docs/subsystems/foundation.md)的说明。真要在一行上违反一条时写 `// @effect-diagnostics-next-line <规则>:off`，上一行说为什么。
- **`vibevalley/*` lint**：`promise-boundary`（async 和 `new Promise` 只在 `Effect.tryPromise`、`Effect.promise` 里）、`no-wall-clock`、`no-test-sleep`。
- **逃生口的棘轮**：`as`、`!`、关 lint 的注释、`Effect.orDie`、不带 `{ log }` 的 `Effect.ignore`、空的 `catch`，按区只许减。

## 4. 评审一段 Effect 代码

检查过了，下面这些检查看不出来，要读代码：

1. **错误有没有被说清楚**：`tryPromise`、`try` 有没有写 `catch`，把真正的原因（`cause`、`message`）带出去；`mapError((e) => String(e))` 拿到的可能是 `UnknownError`。
2. **错误该不该变成缺陷**：`orDie` 的那个错误主人能不能处理（库写不进去、磁盘满了是要告诉主人的）。要先 die 再 `catchDefect` 接回来的，是错误类型没留住，改成在 `Effect` 的错误通道里传。
3. **被丢弃的失败有没有人知道**：`Effect.ignore` 丢的如果是主人说的话、要发出去的消息，至少 `{ log: "Warn" }`。
4. **fiber 归谁**：后台的 fiber 在服务的 `Scope` 里（`Effect.forkScoped`、`FiberSet`），服务关了它也停；给外面的回调用的 runtime 用 `FiberSet.makeRuntime*`，不用 `Effect.runForkWith` 了事。
5. **资源和边界**：拿到的资源用 `acquireRelease` 配好释放；队列、`Stream` 的缓冲、并发有上限。
6. **重试和轮询**：手写的 `while` 加 `sleep` 换成 `Effect.retry`、`Effect.repeat` 和 `Schedule`，时间才拨得动。
7. **追踪**：新的服务方法有名字（`Effect.fn("X.m")`），边界（接口、外部进程、库的写、队列的交接）上有 span。

查到的照 [vv-simplify](.agents/skills/vv-simplify/SKILL.md) 的格式列出来：每处带文件和行号、怎么改、靠哪个测试证明没变坏。常见的反模式、它们为什么会被写出来、怎么发现，见 [references/practices.md](.agents/skills/vv-effect/references/practices.md)。

## 5. 还没做的

几处较大的整改（错误通道里的 `unknown`、给 `Db` 一个保留错误类型的事务、服务方法的命名、手写的重试和解码）和以后要加的检查，在[提案](.agents/notes/proposed/architecture/2026-10-31-effect-practices.md)里，各写了什么时候做。改到那一块时先看一眼。
