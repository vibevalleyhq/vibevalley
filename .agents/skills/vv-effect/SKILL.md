---
name: vv-effect
description: 在 VibeValley 里写、改、评审 Effect v4 的代码（apps/server、packages/agent、packages/ai，以及页面的中间层 apps/web/src/state 上的 Effect Atom，effect 4.0.5）：先读包里自带的官方指南，再照本仓库的约定写：服务是 Context.Service 的类、库经 Db、文件经 FileSystem、时间经 Clock、Promise 只在库的一次调用上且写 { try, catch }、错误打标签按 catchTag 接、服务的方法用 Effect.fn 命名、测试用 it.effect 和 TestClock；哪些已经由 effect:check、vp check 的 effecttsgo 规则、vibevalley/* lint 和逃生口的棘轮拦着。用在：写或改任何用到 Effect 的代码；页面上主人做一件事要先显示结果（乐观更新）、要等服务端确认、要记住一个选择、要一个全页面共享的值（意图、act()、defineStored、defineAtom，Atom 只在 state/）（服务、layer、错误、Stream、Schedule、Schema、测试）；评审一段 Effect 代码；effect:check 或 vp check 报了 effecttsgo 的诊断不知道怎么改；不确定一个 API 在 v4 叫什么（Context.Tag、Effect.Service、catchAll、Either、Layer.scoped 这些 v3 名字都不在了）；主人说「Effect 的最佳实践」「这段 Effect 写得对不对」。
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
| 服务 | `class Issue extends Context.Service<Issue, { … }>()("vibevalley/Issue") { static readonly layer = … }`，`make` 里 `yield*` 用到的服务，用 `Issue.of({ … })` 拼出来；要类型写 `Issue["Service"]` | [AGENTS.md](AGENTS.md#规矩)「服务端的服务」 |
| layer 的次序 | `apps/server/src/services.ts` 按次序叠，模块只用排在它前面的；开机要做的放在最后的 `start`、`ready` | [architecture.md](docs/architecture.md) |
| 库 | 经 `Db` 服务（`run`、`attempt`、`one`、`inTx`、`attemptTx`），模块不自己 `provideService(SqlClient)`、`withTransaction`（lint `vibevalley/db-door`）；SQL 只写在 `db/queries/<表>.sql` | [地基](docs/subsystems/foundation.md) |
| 文件、进程、外面的 HTTP | `FileSystem`、`ChildProcessSpawner`、`HttpClient`；不用 `node:fs/promises`、`fetch`（effect:check 的 `globalFetchInEffect`；测试像浏览器一样打服务端的，在那一行关掉并说为什么） | [地基](docs/subsystems/foundation.md) |
| 时间 | `Clock`、`Effect.sleep`、`TestClock`；类里用它拿到的 `Time`（`apps/server/src/infra/time.ts`）；lint `vibevalley/no-wall-clock` | [地基](docs/subsystems/foundation.md) |
| Promise | 只在外面的库的一次调用上：`Effect.tryPromise({ try: (signal) => lib.call(…, { signal }), catch: (e) => new XError({ cause: e }) })`。不写 `catch` 的形式失败时只剩 `UnknownError`，原因丢了；lint `vibevalley/promise-boundary`、`vibevalley/try-promise-catch` | [地基](docs/subsystems/foundation.md) |
| 错误 | 预期的错误是 `Schema.TaggedError`（字段写成 Schema，包住外面的失败时原样放进 `cause: Schema.Defect()`；`preferSchemaTaggedError`、`extendsNativeError`），按 `catchTag`、`catchTags` 接，分错误的函数收它的调用方传的联合、用 `Predicate.isTagged`，不用 `instanceof` 分（lint `vibevalley/no-instanceof-tagged`）；错误通道里不写 `unknown`：写出调用方传的联合或用泛型带过去，外面的库交来的失败在边界上包成带标签的错误、原样放进 `cause`（effect:check 的 `anyUnknownInErrorContext`）；抛错写 `return yield*`；`Effect.orDie`、不带 `{ log }` 的 `Effect.ignore`、空的 `catch` 在逃生口的棘轮上（`vp run health:verify`），要丢弃一个失败就 `Effect.ignore({ log: "Warn" })`；「出错了记一笔、接着做」（缺陷也记，打断照样往上走）用 `infra/log.ts` 的 `bestEffort(what)` | [地基](docs/subsystems/foundation.md)、`packages/health/README.md` |
| 命名和追踪 | 服务的方法用 `Effect.fn("Issue.create")`（服务的类名加成员名），热路径和薄的取值用 `Effect.fnUntraced`；要加的锁、接错误这类组合子作为 `Effect.fn` 后面的参数，不 `.pipe` 它；不写只 `return Effect.gen(…)` 的函数；lint `vibevalley/service-method-names` | 官方指南「Writing Effect code」 |
| 并发 | `Effect.all`、`forEach` 默认一个接一个；要并发写明 `{ concurrency: n }`，用户给的数量不用 `"unbounded"` | 官方指南 |
| 不信任的数据 | `Schema` 解码（Effect 里用 `decodeUnknownEffect`），不手写类型守卫、不 `as`；对象的判断用 `Predicate.isObject`、`Predicate.hasProperty`（lint `vibevalley/no-object-guard`）；模型回的话里最后一个 JSON 块用 `base/json.ts` 的 `lastJsonBlock(text, schema, words)` | 官方指南「Defining schemas」 |
| 测试 | 服务端 `@effect/vitest` 的 `it.effect`；有时间窗口的拨 `TestClock`；等后台的事用 `until`、`waitFor`（`waitFor` 直接收一个 Effect），不睡固定时间 | [地基](docs/subsystems/foundation.md)的测试金字塔 |

## 2b. 页面里的 Effect：中间层

页面不是 Effect 写的，但它的中间层建在 Effect 的 Atom（`effect/reactivity`）上，在 `apps/web/src/state/`。理由和边界写在[客户端](docs/subsystems/app.md)的「为什么这样」，用法写在 `apps/web/README.md`；这里只列要照着做的。

| 要做的事 | 用 | 不用 |
|---|---|---|
| 主人做的事要先显示结果，等服务端确认 | 一种意图（`state/intent.ts` 的 `defineIntent`）：按请求 key 存，画面经这个 feature 的纯函数覆盖层看（只改主人改的那个字段），帧显示了才结算（`bySeq` 比 `StateFrame.seq`），失败留着可重试（同一个 key），断线时排队 | Atom 自带的 `optimistic`、Solid 2 的 `createOptimistic`：它们答复一回来就撤，而我们的真相在之后的帧里，会先弹回去再跳过去 |
| 其余调用接口的动作 | `ui/act.ts` 的 `createAct`：忙的计数一定清，拒绝用出错的语气，断线时拒绝 | 组件里直接 `api.…`（lint `vibevalley/act-door`）；`toast(reasonOf(e))` 不带出错的语气（`vibevalley/failure-tone`） |
| 要记住的选择（本机的偏好、看板的样子、窗格宽度） | `state/stored.ts` 的 `defineStored(名字, Schema, 默认值)`：经 Schema 解码、按字段退回默认值、跨标签页跟着变 | 直接读写 `localStorage`（`vibevalley/stored-door`） |
| 值得放进地址的选择（看板的筛选） | `useSearchParam` | 一个刷新就丢的信号 |
| 全页面共享的值 | `state/atom.ts` 的 `defineAtom`，读的时候 `useAtom` 不挂起，帧照常流 | 模块级的 `createSignal`、`createStore`（`vibevalley/page-store`） |
| 只有搜索、置顶这类最新一次的回答算数 | `state/latest.ts` 的 `useLatest` | 自己比对请求的先后 |

只有 `state/` 能 import `effect/reactivity`（`vibevalley/atom-door`）：Atom 的 API 标着不稳定，换了只改这一层。传输和长时间运行的机器（帧的源、直播流、聊天的订阅、通话、听写）不包进 atom，它们的状态是连接和计时器推出来的。

## 3. 已经有检查拦着的

写的时候不用记，撞上了照报错改；报错不懂时看这里对应的那一行。

- **`vp run effect:check`**（`@effect/tsgo` 的语言服务，规则和级别在 `tsconfig.base.json` 的 `plugins`，警告也算失败）和 **`vp check` 里的 `effecttsgo/*`**（同一张表，`scripts/effect-lint.ts`）：漂着没运行的 Effect、少了 `return yield*`、`yield` 少了 `*`、v3 的旧 API、gen 里的 `try/catch`、Effect 里再 `run*` 一个 Effect、方法签名里漏出的依赖、服务没写成类、`Math.random`、`crypto.randomUUID`、`process.env`、`setTimeout`、`fetch`……开着哪些、为什么关着哪些，看那张表和[地基](docs/subsystems/foundation.md)的说明。真要在一行上违反一条时写 `// @effect-diagnostics-next-line <规则>:off`，上一行说为什么。
- **`vibevalley/*` lint**：`promise-boundary`（async 和 `new Promise` 只在 `Effect.tryPromise`、`Effect.promise` 里，那里的 async 函数最多一个 `await`）、`try-promise-catch`（`Effect.tryPromise` 写 `{ try, catch }`，不只传函数）、`db-door`（`SqlClient`、`withTransaction` 只在 `infra/db.ts`）、`no-instanceof-tagged`（`x instanceof YError` 分带标签的错误：改成 `Predicate.isTagged` 或 `catchTag`）、`no-object-guard`（`typeof x === "object" && x !== null`：改成 `Predicate.isObject`）、`service-method-names`（`X.of({ … })` 里返回 Effect 的成员不是 `Effect.fn("X.m")` 或 `Effect.fnUntraced`，或 `Effect.fn` 的名字不是 `X.m`；只认得出语法上看得见的，看不见的在 `scripts/oxlint-plugin.ts` 开头）、`no-wall-clock`、`no-test-sleep`。
- **逃生口的棘轮**：`as`、`!`、关 lint 的注释、`Effect.orDie`、不带 `{ log }` 的 `Effect.ignore`、空的 `catch`，按区只许减。

## 4. 评审一段 Effect 代码

检查过了，下面这些检查看不出来，要读代码：

1. **错误有没有被说清楚**：`tryPromise`、`try` 有没有写 `catch`，把真正的原因（`cause`、`message`）带出去；`mapError((e) => String(e))` 拿到的可能是 `UnknownError`。
2. **错误该不该变成缺陷**：`orDie` 的那个错误主人能不能处理（库写不进去、磁盘满了是要告诉主人的）。要先 die 再 `catchDefect` 接回来的，是错误类型没留住，改成在 `Effect` 的错误通道里传。
3. **被丢弃的失败有没有人知道**：`Effect.ignore` 丢的如果是主人说的话、要发出去的消息，至少 `{ log: "Warn" }`。
4. **fiber 归谁**：后台的 fiber 在服务的 `Scope` 里（`Effect.forkScoped`、`FiberSet`），服务关了它也停；给外面的回调用的 runtime 用 `FiberSet.makeRuntime*`，不用 `Effect.runForkWith` 了事。
5. **资源和边界**：拿到的资源用 `acquireRelease` 配好释放；队列、`Stream` 的缓冲、并发有上限。
6. **重试和轮询**：手写的 `while` 加 `sleep` 换成 `Effect.retry`、`Effect.repeat` 和 `Schedule`，时间才拨得动。
7. **追踪**：服务方法的名字 lint 看得见的它查，它看不见的（从别的对象拿来的、解构出来的）读代码看；边界（接口、外部进程、库的写、队列的交接）上有 span。

查到的照 [vv-simplify](.agents/skills/vv-simplify/SKILL.md) 的格式列出来：每处带文件和行号、怎么改、靠哪个测试证明没变坏。常见的反模式、它们为什么会被写出来、怎么发现，见 [references/practices.md](.agents/skills/vv-effect/references/practices.md)。
