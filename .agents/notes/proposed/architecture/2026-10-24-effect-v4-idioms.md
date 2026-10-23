# Agent Note: 服务端照 Effect v4 的写法：方法有名字，状态在 Ref 里，定时和回调归作用域

Status: proposed

## Problem

服务端是 Effect v4，但很多地方是包在 `Effect.gen` 里的 Node 写法（在 `apps/server/src` 里数的，不算测试）：

- 服务的方法都是 `(id) => Effect.gen(function* () {...})`，`Effect.fn` 一处没用：出错的栈和追踪里看不出是哪个方法。
- 服务的状态是 `make` 里的 `let` 和 `new Map`（116 个 `let`，`Ref` 一个没有），另用 `Semaphore` 管并发：读的地方加不加锁靠自觉。
- 定时是 `setTimeout`（36 处）和 `new Promise`（30 处）：存盘的防抖、超时的 `Promise.race`；要手动 `clearTimeout`、`unref`，服务关的时候不跟着停。
- 服务里面另起运行时：`Effect.runSync(core.apply(...))`（`session/session.ts`、`channel/chat.ts`），中断、上下文和追踪接不上。
- 同步的 `fs`（100 处）、`JSON.parse` 配 try（49 处）、散着读的 `process.env`（17 处）、`console.*`。

和 Promise 写的库交界的地方不算：oar、pi-agent-core（`agent/brain`）、MCP 的 SDK、连接器、`cli/chat.ts` 的终端界面。那里用 Promise 是被外面的接口定的。

## Proposal

分几批，每批一个 PR，行为不变，现有的测试就是回归：

1. **方法有名字**：服务的方法改成 `Effect.fn("<服务>.<方法>")(function* (...) {...})`，只有一个 `yield*` 的短方法照旧。机械改动，先做。
2. **服务里不另起运行时**：`Effect.runSync(core.apply(...))` 改成在纤程里调；给自己的回调用的 `FiberSet.makeRuntimePromise` 改成回调只往 `Queue` 放、一个 `forkScoped` 的纤程消费。给 oar、MCP 的回调保留。
3. **定时归作用域**：防抖存盘用 `forkScoped` 的纤程加打断（或 `Stream.debounce`），超时用 `Effect.timeout`，重复用 `Schedule`；服务关的时候作用域收掉它们，不再手动 `clearTimeout`。先做 `session`、`runtime`。
4. **状态在 Ref 里**：读和写之间隔着异步的状态，换成 `SynchronizedRef`（`modifyEffect` 把读、判断、写放在一处）或用一把锁；同步的读改写不动。先看 `agent`、`lan`。
5. **读写和配置**：服务里的同步 `fs` 换成 `FileSystem`，JSON 用 `Schema.fromJsonString`，环境变量收进 `Config`，日志用 `Effect.log*`。

做完再扫一遍，把还剩的、新看到的写回这篇或新开一篇。

### 做到哪了

1. 方法有名字：已经做了。服务的 `make` 里返回的方法和内部的帮手函数，整个函数就是一段 `Effect.gen`（或套一层 `x.withPermits(n)`）的，都改成了 `Effect.fn("<服务>.<名字>")`，锁作为第二个参数；共 135 处。模块顶层的 `make` 和自己写了返回类型的没动。
2. 服务里不另起运行时：已经做了。在 `Effect.gen` 里经 `Effect.runSync` 施加事实、发提醒的 19 处改成 `yield* core.apply`、`yield* core.notice`（`session`、`channel/chat`），`chat` 的那个帮手删了；`session` 的留给 oar 的回调（事件、汇报、太久没动静），它们不在纤程里、要照 oar 给的次序落下。服务的 `make` 里的锁 `Semaphore.makeUnsafe` 改成 `yield* Semaphore.make`（两个普通的工厂函数照旧）。其余的 `FiberSet.makeRuntime*` 都是给外面的库（oar、记性的来源、MCP、node 的 http）的回调用的，纤程归服务的作用域，是 v4 给这种交界的写法，留着。
3. 定时归作用域：已经做了我们自己的服务。`session`（存盘的防抖、每个会话太久没动静）、`runtime`（花费的存盘、推一次新的花费、跑完一轮后查额度）、`core`（state.json 的合并写）、`channel/chat`（攒一下再提醒、叫醒失败后再试）的 `setTimeout` 都换成服务自己的 `FiberMap`：同一个键再来一次就换掉上一个（防抖），`onlyIfMissing` 是已经在等就不再排（合并写、一个窗口推一次）；服务关的时候作用域收掉它们，关前要写的照旧在终结器里写。`chat` 等完以后把活交给 `forkHere`，叫停只取消还在等的，不打断已经在锁里跑的。`session` 关时等农机收尾的 `Promise.race` 换成 `Effect.timeoutOption`，`lan` 等主人点头的超时也是。还剩的 `setTimeout` 在和外面打交道的地方（`voice`、连接器、`agent/brain`、`runtime/dsh.ts`、`project/git.ts` 的进程超时、`session/journal.ts` 这个类），最后一遍扫的时候再看。
4. 状态在 Ref 里：看过以后不整体改。服务里的 `let` 多是句柄（监听、子进程、隧道）、关没关的标记、计数，或者像档案那样读、改、写在同一步里做完、中间没有 `yield*` 的同步状态；换成 `Ref` 要在各处同步地取（`getUnsafe`），没有消掉哪一种竞争。真有竞争的是读和写之间隔着异步的：`lan` 的 `setOpen` 写库以后才绑端口，同时来一个关，会找不到还没绑上的监听、留下它开着；给它一把锁（`Effect.fn` 的第二个参数），一次只开或关一个。这个竞争的窗口是绑回环端口的那一下，测试里造不出来，没写测试。
5. 读写和配置：做了项目和 JSON 列。`project` 在 Effect 代码里的同步 `fs`（建目录、找真实路径、看在不在、写 `.gitignore` 和 README、建项目时独占地建目录）换成 `FileSystem`，失败照旧是缺陷（`Effect.orDie`），独占建目录读 `PlatformError` 的 `AlreadyExists`；`platform` 提供 `NodeServices.layer`。列项目要看目录项的种类（链接到文件夹的不算项目），`FileSystem` 不给，照旧用 `readdirSync`。我们自己写进表的 JSON 列（文档的块、工单的计划、步骤、检查、PR、上一轮、结论……）不再 `JSON.parse(...) as T`，照 protocol 的 Schema 读（`base/json.ts`：原来读不出是缺陷的，形状不对也是；原来读不出当没有的，形状不对也当没有）。`gh` 的输出不是我们的形状，没动。环境变量看过不改：`runtime` 是给 oar 探测时临时设的，`project` 是传给子进程的，`pi.ts` 照 pi 自己的找法，`recurrence` 读 `TZ`，都不是我们的配置。

## Alternatives considered

**错误改成 `Schema.TaggedErrorClass`。** 地道，但 `ApiError` 是 protocol 的契约，页面和服务端都用，129 处 `Effect.fail(refused(...))` 都要动；收益是栈和 cause，接口的形状不变。放到这几批之后再看值不值。

**子进程换成 `ChildProcess`。** `project/git.ts` 超时要杀整个进程组，换之前要先确认 `ChildProcess` 能做到；先不动。

**一次全改。** 改动太大，出了问题分不清是哪一类引起的；按类分批，每批的测试都过了再走下一批。

## Acceptance criteria

- 服务的方法都有 `Effect.fn` 的名字（`Context.Service` 的 `make` 里返回的方法）。
- 服务的 Effect 代码里没有 `Effect.runSync`、`Effect.runPromise`；只留在外面的库的回调里，并写明为什么；`makeRuntime*` 只留在交给外面的库的地方。
- `session`、`runtime`、`core`、`channel/chat`、`lan` 里没有 `setTimeout`；它们等着的都是服务作用域里的纤程，服务关的时候停下。
- `bun run server:check`、`web:check` 过，行为不变。

## Risks

- **防抖改成纤程后时序变了**：存盘早一点、晚一点都可能让测试变红；照原来的间隔，测试红了先看是不是时序。
- **`Effect.fn` 改变栈的形状**：只影响出错时打出来的东西，不影响行为。
- **和别处同时改同一个文件**：每批小、合得快，减少冲突。
