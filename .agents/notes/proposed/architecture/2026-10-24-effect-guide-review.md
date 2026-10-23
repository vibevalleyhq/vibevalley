# Agent Note: 照 Effect 自带的指南逐条对一遍服务端：差在哪、为什么要紧、先改哪些

Status: proposed

## Problem

[effect-ts skill](.agents/skills/effect-ts/SKILL.md) 和 AGENTS.md 的「Learning more about Effect」把 `node_modules/effect/AGENTS.md`（effect 4.0.5 自带的指南，和服务端跑的是同一个版本）定为写 Effect 的标准。前七个 PR（#33–#39）照经验改过一轮：方法用 `Effect.fn`、定时进 `FiberMap`、错误带 `_tag`、JSON 列照 Schema 读。这一篇照指南逐节重新对一遍，回答还有多少地方不地道、哪些值得改。

范围是 `apps/server/src` 里不算测试的 125 个文件（26 033 行），测试和测试工具 81 个文件，和 `packages/protocol`；基准是 `main` 的 `59ad8eb3`（#42）。数字用 TypeScript 的语法树数（`Effect.fn` 在不在服务的 Shape 里、`Date.now` 在不在生成器里、哪些函数整个就是一段 `Effect.gen`），其余用 `grep`；文中的「行」都指这个提交。

结论先给：

| 指南的一节 | 现在 | 差距 |
|---|---|---|
| 可复用的函数用 `Effect.fn` / `Effect.fnUntraced`，不写只包一层 `Effect.gen` 的函数 | `Effect.fn` 139 处，`fnUntraced` 0；`Effect.fn(...).pipe` 0 | 还有 61 个函数整个就是 `Effect.gen`（模块顶层 24，其中 15 个是 `make`；里层 37）；76 个 `Effect.fn` 是不对外的帮手，指南要它们用 `fnUntraced` |
| 错误用 `Schema.TaggedError`，`return yield* new X(...)` | `Data.TaggedError` 6 个，`Schema.TaggedError` 0；`refused()`、`missing()` 造的普通对象 156 处 | 接口的错误 `ApiError` 是 interface 加工厂函数，Schema 另手写了一份（`api.ts`） |
| 外来数据用 `Schema` 解，不手写判断；类型判断用 `Predicate` | `JSON.parse` 38 处，其中约 19 处是外面来的（`gh` 的输出、聊天软件和记性来源的答复、模型交回的 json 块、请求体）；`Predicate` 0 | 外面来的数据靠 `as` 和手写的 `textOf`、`linesOf` 判断 |
| 时间用 `Clock`、`DateTime`，不用 `Date.now` | `Date.now()` 115 处（生成器里 51），`Clock` 0，`DateTime` 5（只在 `recurrence`） | 4 个服务自己造了 `now?: () => number` 给测试拨钟；`it.live` 200 个，`TestClock` 只在 `core` 用了 3 次 |
| 定期、重试用 `Schedule` | `Schedule` 2 处 | 6 个后台循环是 `Effect.forever(… Effect.sleep(…))`，2 个是手写的 `for (;;)` |
| 服务：`Context.Service`，`X.of({...})` 返回 | 每个模块一个 `Context.Service`；`X.of` 7 处，`const shape: XShape = {...}` 13 处 | 写法两种并存；10 个模块各自写了一个 `db` 帮手在调用处 `provideService(SqlClient)` |
| 资源用 `acquireRelease`，后台任务用 `Layer.effectDiscard` | `acquireRelease` 1（`base/db.ts`），`addFinalizer` 9，`Layer.effectDiscard` 7 | 监听、隧道、子进程是先建、再在别处的终结器里关 |
| 状态：指南没有单独一节；`SubscriptionRef` 是「状态加它的变化流」的现成件 | `core` 是 `let state` 加 4 个 `PubSub` | 正好是 `SubscriptionRef` 的形状 |
| 和非 Effect 代码交界：`ManagedRuntime`，回调用 `Stream.callback` | `FiberSet.makeRuntime*` 12 处，`Effect.runSync` 3 处（oar 的回调），`Stream.callback` 1 | `Effect.promise` 39 处、`tryPromise` 9 处：前者把拒绝当缺陷 |
| HTTP 出站用 `HttpClient`；服务端用 `HttpApi` | `HttpClient` 只在命令行；`fetch` 12 处；服务端是自己的接口表 `endpoints` 加 `HttpRouter` | 出站请求没有 Schema、没有统一的超时和重试 |
| 子进程用 `effect/process` | `node:child_process` 5 个文件，`ChildProcess` 0 | `git.ts` 已经说明为什么不换（[地基](docs/subsystems/foundation.md)），其余三处没评估过 |
| 观测：`Effect.log*`、span、Otlp | `Effect.log*` 35，`callbackLog` 的 `logs.*` 32，`console.*` 24；没有 tracer | `Effect.fn` 的 span 没有去处，三套日志 |
| 测试：`it.effect`、共享的测试 layer | `it.effect` 56，`it.live` 200，`Effect.runPromise` 25 处，`as unknown as` 24 处 | 时间相关的测试只能跑真钟 |

已经和指南一致、不再提的：入口是 `NodeRuntime.runMain(Layer.launch(farm))`（`main.ts:58`）；每个模块一个 `Context.Service`，按 `services.ts` 的次序叠 layer；protocol 的 329 个形状都是 `Schema.Codec<T.X>`；服务的方法有 `Effect.fn` 的名字，没有 `Effect.fn(...).pipe`；接错误用 `catchTag`（7 处）；命令行是 `effect/cli`、`HttpClient`、`Sse`、`Stdio`；服务里的定时是 `FiberMap`。

## 可复用的函数

指南：「Avoid functions that only wrap and return `Effect.gen`」；可复用的函数用 `Effect.fn("name")`，不需要追踪的（库里的、热路径上的）用 `Effect.fnUntraced`；返回类型用 `Effect.fn.Return<A, E>` 标。

**只包一层 `Effect.gen` 的函数还有 61 个。**

- 模块顶层 24 个：15 个是服务的 `make`（`issue/issue.ts:216`、`session/session.ts:358`、`project/project.ts:363`……），9 个是 `project/project.ts` 的帮手（`mergeCommit:133`、`conflictsOf:141`、`commitLeft:158`、`cleanupMerged:175`、`probeGitHub:305`）和命令行的 3 个。#33 的 codemod 有意跳过了顶层，怕 `make` 变成一个 span。
- 里层 37 个：都是自己写了返回类型的（`(...): Effect.Effect<A, E> => Effect.gen(...)`），codemod 怕丢掉类型跳过了：`channel/chat.ts` 的 `write:590`、`kick:694`、`notify:724`，`issue/merge.ts` 的 4 个，`issue/refinement.ts` 的 5 个，`memory/memories.ts` 的 5 个，`session/session.ts` 的 `open:705`……
- 改法：`make` 和不对外的帮手用 `Effect.fnUntraced(function* (options: X) {...})`；有返回类型的改成在生成器上标 `Effect.fn.Return<A, E>`（指南的例子就这样写），类型照旧由编译器查。

**76 个 `Effect.fn` 是不对外的帮手，指南要它们用 `fnUntraced`。** 服务 Shape 上的方法 63 个（`Issues.setStatus`、`Projects.submitPullRequest`……）是有意义的边界，留 `Effect.fn`；`Channels.toConversation`、`Channels.publishMessage`、`Issues.readyOf`、`Issues.movesWords`、`Docs.get` 这类内部帮手每条消息、每次挪动都调，指南说这种不值得一个 span、一次取栈。现在没有 tracer（见「观测」），span 只多花构造的钱，所以这条的收益要等接上 tracer 才看得见；先改，规矩就定下来了。

## 错误

指南的每个例子都用 `Schema.TaggedError<X>()("X", { ... })`，抛的时候 `return yield* new X({...})`。

**接口的错误是普通对象。** `ApiError`（`packages/protocol/src/api.ts`）是 6 个 interface 的联合，服务端用 `refused()`、`missing()`（`errors.ts`）造普通对象，156 处 `Effect.fail(refused(...))`。为了让命令行能读回来，#29 又手写了一个 `Schema.Union`（`api.ts` 的 `ApiError`），和 interface 是两份，靠 `Schema.Codec<ApiError>` 绑住。

- 改成 `Schema.TaggedError` 以后，一个类就是类型、Schema 和能 `yield*` 的错误：`class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String, next: Schema.optionalKey(Schema.Array(Next)) })`，`ApiError` 的 Schema 是 6 个类的 `Schema.Union`，手写的那份删掉；服务端 `return yield* new Refused({ reason, next })`，`refused()` 留作一行的构造。线上的 JSON 不变（`_tag` 加字段），页面不用动。
- 页面的生成客户端（`client.ts`）只 import 类型，加类不会把 Schema 带进页面的包。
- 代价：156 处调用，多数机械；`errors.ts` 和 protocol 的契约一起改。

**服务自己的错误用的是 `Data.TaggedError`**（`ProjectError`、`MergeFailure`、`NotTakenIn`、`SettingRefused`、`MemoryRefused`、命令行的 `Failure`）。指南用 `Schema.TaggedError`：多一个 Schema，能编码、能在测试里比。这几个不出进程，差别小；和 `ApiError` 一起改时顺手统一，规矩就只有一条。

**`throw new` 116 处**，多在 Promise 写的交界（连接器 33、`tool/tool.ts` 11、`agent/brain/coding.ts` 11）：那里抛是对的。Effect 代码里还在抛的是同步帮手（`base/config.ts` 的 `ConfigError`、`task/graph.ts` 的 `TaskError`），由调用的一层 `Effect.try` 接住，可以留。

## 外来数据

指南：「AVOID using predicates or manual parsing, instead use `Schema` to parse untrusted data」；类型判断用 `Predicate`，「NEVER write your own helper functions like `isRecord`」。

**外面来的 JSON 约 19 处靠 `as` 或手写的判断。**

| 来源 | 位置 | 现在 |
|---|---|---|
| 帮工交回的 json 块（模型写的） | `issue/rules.ts:135` 的 `parseRefinement`、`session/rules.ts:104`、`task/rules.ts:77` | `JSON.parse(...) as Record<string, unknown>`，再用 `textOf`、`linesOf`、`typeof raw !== "object"` 一个字段一个字段地查 |
| `gh` 的输出 | `project/project.ts:235`、`:900`、`:942`、`:978` | `as { viewerPermission?: string }`、`as PullRequest[]` |
| 记性的外部来源 | `memory/nowledge.ts:125`、`:137`、`:180`，`memory/everos.ts:95` | `as { results?: Hit[] }` |
| 聊天软件 | `connector/feishu.ts:188`、`connector/qq.ts:117`、`connector/weixin.ts:113` | `as` 加零散的判断 |
| 其他 | `runtime/dsh.ts:74`、`:159`，`voice/voice.ts:698`，`session/session.ts:267`，`http/api.ts:44`（请求体，先 `JSON.parse` 再 `decodeUnknownExit`） | 同上 |

- 模型交回的 json 块最要紧：形状对不上时现在的错话是手写的（「json 读不了：……」），换成 Schema（`Schema.fromJsonString(Refinement)`）以后，错在哪个字段由 Schema 说，而这句话正是交回给帮工让它改的（「接着修」）。protocol 里已经有 `IssueRefinement` 等形状，缺的是它们的 Schema 带上 `clip` 这类约束。
- `gh` 和外部来源：只取用到的字段，`Schema.Struct` 默认忽略多的键，写一个窄的 Schema 就够。
- `http/api.ts:44` 换成 `Schema.fromJsonString(endpoint.body)`，「不是 JSON」和「不合 Schema」由同一次解码分出来（命令行那边 #29 已经这样）。

**我们自己写的文件和行还有约 19 处 `JSON.parse`**：`agent/agent.ts:99`（config.json）、`core/core.ts:114`（state.json）、`setting/setting.ts:70`、`runtime/runtime.ts:193`（spend.json），和表里的 JSON 列 `channel/chat.ts:128`、`connector/connector.ts:287`、`:482`、`game/game.ts:49`、`recurrence/recurrence.ts:72`、`task/task.ts:664`。#37 只改了文档和工单的列；照 `base/json.ts` 的 `jsonOf`、`jsonOrNone` 继续改完，存盘的格式就都由 protocol 的 Schema 定。

**`Predicate` 一处没用。** 对 `unknown` 写的类型守卫只有 `connector/connector.ts:74` 的 `isFailure`；但手写的 `typeof x === "object" && x !== null` 散在上面这些解析里，换成 Schema 以后它们自己就没了，不必单独改。

## 时间

指南：「When working with dates and time, use the `DateTime` module instead of `Date` and `Date.now`」，要的是「testable current time」。

- `Date.now()` 115 处：Effect 生成器里 51 处（`channel/chat.ts` 21、`issue/issue.ts` 12……），普通函数里 64 处（`agent/brain`、连接器、`core/core.ts:162`、`:206`–`:208`、`base/ids.ts:11` 的 uuidv7）。`Clock` 0 处。
- 测试因此拨不动钟：`recurrence`、`notice`、`voice`、`lan` 四个服务各自加了 `now?: () => number` 选项，`recurrence.test.ts` 用 `clock.now += 60 * 60_000` 手拨；别的服务只能等真钟，`it.live` 200 个对 `it.effect` 56 个，测试里的等待（`testing/until.ts`）都是真的 10 毫秒一问。这也是 `server:check` 全量跑时那几条负载下偶发失败（「跑太久的检查」「群聊提及」）的同一个根：它们比的是真钟上的先后。
- 改法：Effect 代码里 `yield* Clock.currentTimeMillis`（或 `DateTime.now`）；四个服务的 `now` 选项删掉，测试用 `TestClock.adjust`；`base/ids.ts` 的 uuidv7 和 `core` 的打时间戳在纤程外，由调用方传时间进去。
- 代价：51 处生成器里的机械替换；普通函数里的要看调用方，`agent/brain` 是 pi-agent-core 的世界，不动。改完以后，等的不是外部进程的测试可以从 `it.live` 换成 `it.effect` 加 `TestClock`，确定、也快。

## 定期和重试

指南：「Schedules define recurring patterns for retries, repeats and polling」，用在 `Effect.repeat`、`Effect.retry`。

- 6 个后台循环是 `Effect.forever(Effect.andThen(x, Effect.sleep(n)))`：`recurrence/recurrence.ts:209`（定时的 tick）、`game/game.ts:140`（数 commit）、`notice/notice.ts:100`（巡查）、`issue/issue.ts:879`、`:881`（排队的、PR 的状态）、`core/core.ts:187`。写成 `x.pipe(Effect.repeat(Schedule.spaced(n)))`（或先等再做的 `Effect.schedule`），意思一样，出错时要不要停、要不要退避由 Schedule 说，不藏在 `forever` 里。
- `memory/memories.ts:191`、`memory/gse.ts:93`、`:207`、`session/shell.ts:26` 的 `for (;;)` 是读完为止的循环，不是定时，不改。
- 出站请求的重试散在各处（连接器的 `while`、`fetch` 外面的 `try`），换成 `HttpClient` 时一起用 `HttpClient.retryTransient`。

## 服务的形状

指南的服务：`Context.Service`，方法用 `Effect.fn` 定义，`return X.of({...})`，`static readonly layer`。

- 13 个服务写 `const shape: XShape = {...}; return shape`，7 个写 `X.of({...})`。`X.of` 不多做什么，但两种并存时照抄的人会挑一种；统一成 `X.of`。
- `layer` 是模块导出的函数，不是类上的 `static`：这是 AGENTS.md「服务端的服务」定的（`make`、`layer` 分开导出，测试传选项），不改。
- **10 个模块各写一个 `db` 帮手**：`const db = (e) => Effect.provideService(e, SqlClient.SqlClient, sql)`（`issue`、`session`、`channel/chat`、`task`、`doc`、`lan`、`recurrence`、`game`、`memory/memories`、`agent/brain/taskStore`），`Effect.provideService` 共 18 处。原因是 Shape 的方法要 `R = never`，而 effect-sqlc 生成的查询要 `SqlClient`。用户层的 effect skill 说「Avoid broad hidden provisioning that makes missing dependencies hard to see」；这里是同一种隐藏，只是每个模块都抄了一遍。给 `base/db.ts` 加一个 `Db` 服务（`run`、`inTx`），模块 `yield* Db` 拿它，十份就成一份，事务的写法也只有一种。
- `Context.Reference` 一处没用。上面那 4 个 `now` 选项、各处的 `options.xxxMs ?? 默认值`（`issue.ts:879` 的 `tryEveryMs`……）就是指南说的「configuration values … that has a default value」：做成 `Context.Reference`，测试 `Layer.succeed` 换掉，`make` 的选项参数就少了一半。

## 资源和作用域

指南：用 `Effect.acquireRelease` 把「建」和「关」写在一处。

- `acquireRelease` 只有 `base/db.ts` 一处。`lan` 的监听（`lan/lan.ts` 的 `listen`、`shut`）、`voice` 的语音线路和 cloudflared 隧道（`voice/voice.ts:282`、`:361`–`:365`）、`session` 的 oar 会话，都是建的时候存进 `let`，关在另一处的终结器或 `shut()` 里。#36 修的「开到一半来一个关，留下开着的监听」就是这个结构的代价：建和关不在一处，中间的状态要靠锁守。
- 改法：每个长寿的资源写成 `acquireRelease` 的一个 scoped Effect，开着的那段是一个 `Scope`；`lan` 的开和关就是「建一个 Scope / 关掉这个 Scope」，存的是 Scope 不是 server。`FiberMap` 管定时那样，可以用 `FiberMap` 或 `LayerMap`（指南的「Dynamic resources with LayerMap」）按键管这些 Scope。
- 代价：`voice` 和 `lan` 的生命周期重写，各一个 PR，有现成的测试。

## 状态

- 服务里的 `let` 113 个，多是句柄、标记、计数（#36 看过，不整体换）。
- 例外是 `core`：`let state`（`core/core.ts:119`）加 `changes`、`events`、`transitions`、`owner` 4 个 `PubSub`，`apply` 改 `state` 再发 `changes`。「一份值加它的变化流」正是 `SubscriptionRef`（`make`、`get`、`update`、`changes`）。换成它以后读最新值和订阅变化是同一个东西的两面，`frames` 那条流可以直接从 `SubscriptionRef.changes` 起。`core` 是核心状态唯一的家，改它的风险最大，先写测试比对帧（黄金数据已有 `reduce.jsonl.gz`），再动。

## 和非 Effect 代码的交界

指南：桥用 `ManagedRuntime`；回调式的 API 用 `Stream.callback`。

- **`Effect.promise` 39 处、`Effect.tryPromise` 9 处。** `Effect.promise` 的约定是这个 Promise 不会拒绝，拒绝了就是缺陷，绕过所有 `catch`。`memory/memory.ts:119`（`sources.list`）、`:143`、`:176`，`runtime/runtime.ts:380`，`voice/voice.ts:708` 包的都是会失败的网络或文件调用。逐个看：会失败的改 `tryPromise` 并给出错误类型，真不会失败的留着。
- **`FiberSet.makeRuntime*` 12 处**给 oar、MCP、node 的 http、记性来源的回调用，纤程归服务的作用域：这是 v4 给这种交界的写法，和 `ManagedRuntime` 相比不用另建一个运行时，留着。
- **oar 的事件**（`session/session.ts` 的 `watch`，`session.events(cb)`、`rawEvents(cb)`）是回调，回调里同步地改 `Hand`、施加事实。指南的写法是 `Stream.callback` 把回调变成流，在纤程里消费；好处是中断、背压、出错都归 Effect，`Effect.runSync(core.apply)` 这最后 3 处也就没了。代价是时序：事实现在在回调里同步落下，测试按这个先后写的；这是这一篇里风险最高的一条，先放着，等 `Clock` 和 `TestClock` 到位、能确定地测先后再做。

## HTTP

- **出站请求**：`fetch` 12 处（连接器 5、`voice` 2、`memory/everos.ts`、`runtime/pi.ts`、`agent/brain/coding.ts`、`lan/lan.ts` 的转发），都在 Promise 写的代码里，超时用 `AbortSignal.timeout`，重试各写各的，答复靠 `as`。指南的 `HttpClient` 加 `HttpClientResponse.schemaBodyJson(S)` 一次给出类型化的答复、超时和 `retryTransient`。先改 `memory/everos.ts`、`runtime/pi.ts` 这种单个请求的；连接器的长连接（qq 的 gateway）等「外来数据」那批一起。
- **服务端的接口**：指南推荐 `HttpApi`（schema-first、类型化的客户端、OpenAPI）。我们的 `endpoints` 表做了同样的事，还多了 `can`（谁能调）、`dryRun`（试跑）、命令行和能力表从它生成。换 `HttpApi` 要把这些搬成注解，收益是 OpenAPI 和少维护一份 `client.ts` 的生成器；不在这一篇的计划里，记下来，等 `HttpApi` 的注解能放下 `can` 和 `dryRun` 再评估。

## 子进程

指南：`effect/process` 的 `ChildProcess` 和 `ChildProcessSpawner`。

- `project/git.ts` 不换，理由在 [地基](docs/subsystems/foundation.md)：超时被打断会丢掉读到的输出，每个 git 帮手还要多带一个依赖。
- `runtime/dsh.ts:153`（DeepSeek Harness 的 ACP 子进程）、`voice/voice.ts:284`（cloudflared）是长寿的子进程，正好是 `ChildProcess` 加 `acquireRelease` 的场合：起、读输出、关在一处，`Scope` 关的时候杀进程组。和「资源」那批一起做。
- `agent/brain/coding.ts:49` 是 pi-agent-core 的工具，在 Promise 的世界，不动。

## 观测

- 三套日志并存：`Effect.log*` 35 处，`base/log.ts` 的 `callbackLog`（`logs.info`、`logs.warn`）32 处，`console.*` 24 处（`cli/chat.ts` 12 处是终端界面，对；`session/journal.ts`、`agent/brain` 的不是）。`callbackLog` 是给回调里用的；回调都有 `FiberSet` 的运行时，可以在那里 `Effect.log`，`callbackLog` 就能删。
- **没有 tracer。** `Effect.fn` 的 139 个名字现在只让出错的栈好读，span 没有去处。指南的「Setting up tracing with Otlp modules」是一个 layer；本机用的工具不必常开，`VIBEVALLEY_OTLP` 这样的开关打开时才挂上，调慢的派活、合并时就能看到每一步花在哪。`Effect.annotateLogs`、`withSpan` 0 处，挂 tracer 时再加在派活、合并、开会话这几条主线上。

## 测试

- `it.live` 200 个、`it.effect` 56 个；`TestClock` 3 处。原因见「时间」：钟改成 `Clock` 以前，大多数测试只能跑真钟。
- 测试里 `Effect.runPromise` 25 处（`issue.test.ts` 6、`connector.test.ts` 3……）：在 `it.live` 里跑另一个运行时，服务和上下文接不上；多数能改成 `yield*`。
- `as unknown as` 24 处（`notice/inbox.test.ts` 8、`issue/moves.test.ts` 5……）拼半个 `Issue`：#37 已经看到这种拼法读回来会被当成「没有」。protocol 加一个 `testing` 入口给完整的样例值（`issueOf({...})`），测试只覆盖要的字段。
- 共享的测试 layer：`testing/world.ts` 已经按 `services.ts` 搭整个农场，和指南的「Testing services with shared layers」一致；`@effect/vitest` 的 `layer(...)` 只在 7 处用，`world` 每个测试重建一次，慢的那几个文件可以改成文件级的 `layer(world())`。

## 类型

- `as unknown as`、`as never` 在服务端代码里 27 处，多在交界（`runtime/price.ts:46`、`:48` 是 pi-ai 的类型、`agent/brain/tool.ts:52`、`cli/api.ts:153` 是 `effect/cli` 从表生成命令）；在我们自己的形状上的（`task/rules.ts:280` 拼一个 `Issue`）应改掉。
- 非空断言约 119 处（`doc/markdown.ts` 17、`memory/gse.ts` 15、`recurrence/when.ts` 10），多是数组下标和正则的分组；用户层的 effect skill 说不为了让类型过而加。逐文件看，能用 `Option`、`Array.head` 的换掉，规则里的保留。
- **id 不带品牌**：工单、执行、频道、项目的 id 都是 `string`（`Schema.brand` 0 处）。`issue.idOf` 认「工单的编号、id，或干过它的执行的 id」，正因为它们是同一种类型才能混着传。给 id 加品牌（`Schema.String.pipe(Schema.brand("IssueId"))`）能让编译器挡住传错的 id，但 protocol、页面、命令行都要跟着改，收益在大重构时才显出来；记下，不排进计划。

## Proposal

照「先让测试能确定地测，再动结构」排，一批一个 PR，行为不变，现有测试是回归：

1. **时间走 `Clock`**：生成器里的 51 处 `Date.now()` 换成 `Clock`；`recurrence`、`notice`、`voice`、`lan` 的 `now` 选项删掉，测试改 `TestClock`。验收：这四个服务的测试用 `it.effect`，不用真钟。
2. **函数的写法收齐**：61 个只包一层 `Effect.gen` 的函数改成 `Effect.fn`（标 `Effect.fn.Return`）或 `Effect.fnUntraced`（`make`、内部帮手）；76 个内部帮手的 `Effect.fn` 换 `fnUntraced`；13 个 `shape` 换 `X.of`。机械，codemod 做，`tsc` 查。
3. **定期用 `Schedule`**：6 个 `Effect.forever` 循环。
4. **外来数据照 Schema 解**：模型交回的 json 块（3 处，带上 Schema 的错话交回帮工）、`gh` 的输出（4 处）、请求体（`http/api.ts`）、我们自己的文件和其余 JSON 列；`Effect.promise` 里会失败的改 `tryPromise`。
5. **`ApiError` 换成 `Schema.TaggedError` 的类**，服务端 `return yield* new Refused(...)`，手写的 Union 删掉；服务自己的 `Data.TaggedError` 一起换。
6. **一个 `Db` 服务**替掉 10 份 `db` 帮手；`now` 以外的默认值做成 `Context.Reference`。
7. **资源归 `acquireRelease`**：`lan` 的监听、`voice` 的线路和隧道、`dsh` 和 cloudflared 的子进程（`ChildProcess`）。
8. **日志合成 `Effect.log`**，删 `callbackLog`；加一个按开关挂上的 Otlp tracer。
9. 之后再评估：`core` 换 `SubscriptionRef`、oar 的事件换 `Stream.callback`、出站请求换 `HttpClient`、id 加品牌、服务端换 `HttpApi`。

每批做完，在这一篇的「做到哪了」记一行；全部做完，把仍然成立的写法并进 [地基](docs/subsystems/foundation.md) 的「Effect 的写法」，删掉这一篇。

## Alternatives considered

**照指南一次全改。** 改动面是几百处、横跨每个模块，出了问题分不清是哪一类引起的；时间那批不先做，后面的批次也测不确定。按上面的次序分批。

**只改新写的代码，老的不动。** AGENTS.md 说 agent 照着已有的代码抄；老代码里两种写法并存，新代码就会继续两种都有。所以改到「每一类只剩一种写法」为止。

**不跟指南，照现在的写法写进地基当规矩。** 现在的写法多是在指南出来以前、照 v3 的经验写的；指南和 effect 4.0.5 是同一份发布，升级 effect 时它会跟着变，跟它走比维护一套自己的规矩便宜。

**和 Promise 写的库交界的地方（`agent/brain`、连接器、`tool/tool.ts`、`cli/chat.ts`）也改成 Effect。** 那里的 Promise、`throw`、`try` 是外面的接口定的，改了只是换写法；只改它们和服务相接的那一层（`Effect.promise` 改 `tryPromise`、答复照 Schema 解）。

## Acceptance criteria

- 服务端的 Effect 代码里没有 `Date.now()`；`recurrence`、`notice`、`voice`、`lan` 没有 `now` 选项，它们的测试用 `TestClock`。
- 没有只包一层 `Effect.gen` 的函数；`Effect.fn` 只在服务 Shape 的方法上，内部帮手是 `Effect.fnUntraced`；服务都 `return X.of(...)`。
- 后台循环都是 `Effect.repeat` 加 `Schedule`。
- 外面来的 JSON（模型交回的块、`gh`、外部来源、请求体）都经 Schema 解，没有 `JSON.parse(...) as`。
- `ApiError` 的 Schema 由它的类组成，没有手写的第二份；服务端不写 `Effect.fail(refused(...))`。
- 每批 `bun run server:check`、`web:check` 过。

## Risks

- **钟换成 `Clock` 后测试的先后变了**：真钟下碰巧对的先后，在 `TestClock` 下要显式地拨；一批里先换一个服务的测试，看稳了再推开。
- **`ApiError` 换类以后线上的形状**：`Schema.TaggedError` 编码出来要和现在的 JSON 一样（`_tag` 加字段），页面的客户端和命令行的黄金数据（`cli/testdata/cli.jsonl.gz`）会查出不一样的地方。
- **`fnUntraced` 以后栈变短**：内部帮手出错时栈里少一层名字；这是指南要的取舍，接上 tracer 以后靠 span 看。
- **资源改成 `acquireRelease` 时关的顺序变了**：`voice` 的隧道和线路、`lan` 的转发有先后，照现在终结器的顺序写，测试里关一次看日志。
- 这一篇的数字是 `59ad8eb3` 时的；动手前重数一遍。
