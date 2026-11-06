# 写法对照：不建议和建议

一个案例一对写法：不建议的是 agent 最常写出来的样子，建议的是这个仓库要的样子，各配一句为什么和谁拦着。拿不准怎么写时找最像的一条照抄。这是「术」；为什么这样写（道）见 [principles.md](.agents/skills/vv-effect/references/principles.md)，拿什么查、怎么查（器）见 [tools.md](.agents/skills/vv-effect/references/tools.md)，反模式的总表在 [practices.md](.agents/skills/vv-effect/references/practices.md)，入口见 [SKILL.md](.agents/skills/vv-effect/SKILL.md)。

来源：2026-11-05 读了 [Effect-TS best practices](https://mcpmarket.com/zh/tools/skills/effect-ts-best-practices) 和 [EffectPatterns](https://github.com/PaulJPhilp/EffectPatterns)（304 个模式），只留下 v4 里成立、这个仓库用得上的；它们按 v3 写的（`Effect.Service`、`accessors`、`catchAll`、`Config.redacted`）都换成了 4.1.2 的名字，每个名字对过 `node_modules/effect/src`。案例里标「这里」的，是本仓库出现过的写法。

「在这里」一栏：**已拦**是 `vp check` 或 `vp run effect:check` 会报的；**棘轮**是 `vp run health:verify` 只许减的；**审**是检查看不出来、要读代码的。

目录：[服务和 layer](#服务和-layer) · [函数和追踪](#函数和追踪) · [错误](#错误) · [不信任的数据](#不信任的数据) · [Promise 和回调](#promise-和回调) · [资源和并发](#资源和并发) · [时间、重试、轮询](#时间重试轮询) · [配置和日志](#配置和日志) · [测试](#测试) · [Stream](#stream) · [观测、打断和性能](#观测打断和性能)

## 服务和 layer

### 1. 定义一个服务

不建议（v3，4.1.2 里没有这些名字）：

```ts
export class Issues extends Effect.Service<Issues>()("Issues", {
  accessors: true,
  dependencies: [Db.Default],
  effect: Effect.gen(function* () { /* … */ }),
}) {}
```

建议：

```ts
export class Issue extends Context.Service<Issue, {
  readonly get: (id: string) => Effect.Effect<T.Issue, ApiError>;
}>()("vibevalley/Issue") {
  static readonly layer = Layer.effect(Issue, make);
}

const make = Effect.gen(function* () {
  const db = yield* Db;
  const get = Effect.fn("Issue.get")(function* (id: string) {
    // …
  });
  return Issue.of({ get });
});
```

为什么：v4 的服务是 `Context.Service` 的类，接口写在类型参数里，layer 是静态成员；用的地方 `yield* Issue` 再调方法，没有 accessors。名字是概念的单数词，和模块、表同名。

在这里：已拦（类型、`outdatedApi`、`serviceNotAsClass`、`vibevalley/singular-service`）。

### 2. 依赖在哪里接

不建议：

```ts
// In a module: provides what it is missing where it uses it.
const issues = yield* Issue.pipe(Effect.provide(Issue.layer), Effect.provide(Db.layer));
```

建议：

```ts
// services.ts: the one place layers are stacked, in build order.
const AppLive = Db.layer.pipe(Layer.provideMerge(Core.layer), Layer.provideMerge(Issue.layer));
```

为什么：layer 在入口叠一次，同一个 layer 只建一次；到处 provide 会建出第二份，还把依赖顺序藏起来。`Layer.provideMerge` 一层一层往上叠，类型也平。

在这里：已拦（`multipleEffectProvide`、`layerMergeAllWithDependencies`）；layer 只在 `services.ts` 叠是审。

## 函数和追踪

### 3. 返回 Effect 的函数

不建议：

```ts
export const writeOnce = (path: string, bytes: Uint8Array): Effect.Effect<void, NotWritten, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    // …
  });
```

建议（这里，`infra/files.ts`）：

```ts
export const writeOnce = Effect.fn("Files.writeOnce")(function* (path: string, bytes: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(path), { recursive: true });
  // …
});
```

为什么：`Effect.fn` 给每次调用一个 span，名字是「模块.函数」，trace 里看得见是谁、调了几次、花了多久，堆栈也指到定义的地方；只 `return Effect.gen` 的函数在 trace 里是一片空白。热路径和薄的取值用 `Effect.fnUntraced`，同样的写法、不开 span。

在这里：服务的方法已拦（`vibevalley/service-method-names`）；其余的函数审，目前有近两百处是不建议的写法。

### 4. 给 `Effect.fn` 加锁、接错误

不建议：

```ts
const say = Effect.fn("Channel.say")(function* (text: string) {
  // …
}).pipe(locked); // Not a pipeable function: this pipes the function, not the Effect it returns.
```

建议（这里，`channel/channel.ts`）：

```ts
const say = Effect.fn("Channel.say")(function* (text: string) {
  // …
}, locked);
```

为什么：`Effect.fn` 的第二个起的参数是套在每次调用返回的 Effect 上的组合子（锁、`Effect.catchTag`、`Effect.withSpan`）。

在这里：审。

### 5. 一长串 `andThen`

不建议：

```ts
const ship = (id: string) =>
  issues.get(id).pipe(
    Effect.andThen((issue) => repos.get(issue.repo)),
    Effect.andThen((repo) => git.push(repo.path)),
    Effect.andThen(() => issues.markShipped(id)),
  );
```

建议：

```ts
const ship = Effect.fn("Issue.ship")(function* (id: string) {
  const issue = yield* issues.get(id);
  const repo = yield* repos.get(issue.repo);
  yield* git.push(repo.path);
  yield* issues.markShipped(id);
});
```

为什么：超过两步、后面的要用前面的值时，gen 读起来是顺序代码，中间的值有名字。`pipe` 留给一个值上的一两个变换。

在这里：审；只是想丢掉结果的 `flatMap` 已拦（`flatMapToTap`），多余的 gen 已拦（`unnecessaryEffectGen`）。

## 错误

### 6. 失败用什么表示

不建议：

```ts
if (!issue) return yield* Effect.fail(new Error(`no issue ${id}`));
throw new Error("not allowed");
```

建议：

```ts
export class NotWritten extends Schema.TaggedError<NotWritten, { readonly brand: unique symbol }>()("NotWritten", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

return yield* new NotWritten({ path, cause: e });
```

为什么：带标签的错误能在类型里看见、按标签接、经接口传出去；字段写成 Schema，带上找问题要的上下文（路径、id），外面的失败原样放进 `cause`。抛错写 `return yield*`，后面的代码不会以为还在往下走。

在这里：已拦（`globalErrorInEffectFailure`、`extendsNativeError`、`preferSchemaTaggedError`、`missingReturnYieldStar`、gen 里的 `try/catch` 是 `tryCatchInEffectGen`）。

### 7. 一个错误类型盖住几种失败

不建议：

```ts
class Failed extends Schema.TaggedError<Failed>()("Failed", { message: Schema.String }) {}
// "not found", "not allowed" and "the network is down" all become Failed: the caller can only show the words.
```

建议：

```ts
// Each failure the caller answers differently is its own tag: Missing says where to look next, Refused why not.
return yield* Effect.fail(missing(t("server.issue.none", { id }), [lookIn.issue]));
return yield* Effect.fail(refused(t("server.issue.closed")));
```

为什么：调用方要分开处理的失败（找不到给出去哪儿找，拒绝给出能做什么，外面的服务失败要重试）各是一个标签；只要显示一句话的才合成一个。这里接口的错误是 `ApiError`（`Missing`、`Refused`……），`next` 写着接着能做什么。

在这里：审。

### 8. 接错误

不建议：

```ts
yield* fs.writeFile(path, bytes, { flag: "wx" }).pipe(Effect.catch(() => Effect.void));
// Every failure is gone: a full disk is now "already there".
```

建议（这里，`infra/files.ts`）：

```ts
yield* fs.writeFile(path, bytes, { flag: "wx" }).pipe(
  Effect.catchIf(
    (e) => e.reason._tag === "AlreadyExists",
    () => Effect.void,
  ),
);
// Tagged errors: Effect.catchTag("Missing", …), several at once with Effect.catchTags({ … }).
```

为什么：只接认得的那一种，其余的照样往上走；`Effect.catch` 一下全接住，类型里的错误没了，以后加的新失败也被悄悄吞掉。真要全接（外面的库交来的失败只有一种处理）时，写明为什么。

在这里：一部分已拦（`catchToIgnore`、`catchConditionalRefailToCatchIf`、`unknownInEffectCatch`）；`Effect.catch` 全接现在有五十几处，审。

### 9. 「不该发生」的情况

不建议：

```ts
if (!orchestrator) return yield* Effect.die(new Error(`the built-in template ${defaultOrchestrator} is not in agent/templates`));
```

建议（这里，`agent/agent.ts`）：

```ts
if (!orchestrator) return yield* Effect.die(new Inconsistent({ message: `the built-in template ${defaultOrchestrator} is not in agent/templates` }));
```

为什么：程序自己的记录对不上、调用方违反了约定，是缺陷，不是预期的失败；这里统一用 `errors.ts` 的 `Inconsistent`，日志和 trace 里按这个名字一搜就是全部的 bug，不和外面来的 `Error` 混在一起。

在这里：审。

### 10. 包住外面的失败

不建议：

```ts
catch: (e) => new SourceFailed({ message: String(e) }),
// The stack, the status code and the library's own error are gone.
```

建议：

```ts
catch: (cause) => new SourceFailed({ source: name, cause }),
// cause: Schema.Defect() keeps the library's error as it was.
```

为什么：原样留住原因，日志里能看到库自己的报错和堆栈；给主人看的话由处理它的地方用 `t()` 说。

在这里：审；不写 `catch` 的 `tryPromise` 已拦（`vibevalley/try-promise-catch`）。

### 11. 从 `Option` 拿值

不建议：

```ts
Effect.repeat(Effect.delay(once, interval), { until: Option.isSome }).pipe(Effect.map(Option.getOrThrow));
```

建议（这里，`connector/feishu.ts`）：

```ts
Effect.repeat(Effect.delay(once, interval), { until: Option.isSome }).pipe(
  Effect.flatMap(Option.match({
    onNone: () => Effect.die(new Inconsistent({ message: "the login poll stopped without an account" })),
    onSome: Effect.succeed,
  })),
);
// Absent is an expected failure: Option.match into a tagged error, or Effect.fromOption(o).pipe(Effect.mapError(…)).
```

为什么：`getOrThrow` 在 Effect 外面抛一个普通的异常，变成无名的缺陷；两种情况都写出来，没有值时是什么错就清楚了。有默认值时用 `Option.getOrElse`。

在这里：审。

## 不信任的数据

### 12. 解析 JSON

不建议：

```ts
emitTable ??= JSON.parse(yield* read(files.emit)) as Record<State, Record<string, number>>;
```

建议（这里，`memory/gse.ts`）：

```ts
const EmitTable = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Finite));
emitTable ??= yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EmitTable))(yield* read(files.emit));
// Outside an Effect: base/json.ts's jsonOrNone(schema) gives the value or undefined, never throws.
```

为什么：`JSON.parse` 加 `as` 是对编译器说谎，文件坏了在很远的地方才炸；Schema 在读的地方就说哪个字段不对。

在这里：`as` 在棘轮上；`JSON.parse` 审。

### 13. 在 Effect 里同步解码

不建议：

```ts
const event = Schema.decodeUnknownSync(SessionEvent)(raw); // Throws inside an Effect: a defect, not a failure.
```

建议：

```ts
const event = yield* Schema.decodeUnknownEffect(SessionEvent)(raw);
// Or, when a bad one is just skipped: Schema.decodeUnknownOption(SessionEvent)(raw).
```

为什么：`*Sync` 失败时抛异常；Effect 里用 `decodeUnknownEffect`，失败留在错误通道，带着哪个字段不对。

在这里：已拦（`schemaSyncInEffect`、`preferTypedSchemaDecoder`）。

### 14. 判断一个值是不是对象

不建议：

```ts
if (typeof value === "object" && value !== null && "code" in value) { /* … */ }
```

建议：

```ts
if (Predicate.hasProperty(value, "code")) { /* … */ }
// A whole shape: Schema.is(Shape)(value), or decode it.
```

为什么：手写的守卫容易漏 `null`、数组，类型也收窄得不对。

在这里：已拦（`vibevalley/no-object-guard`）。

## Promise 和回调

### 15. 调一个 Promise 的库

不建议：

```ts
const send = async (text: string) => {
  const res = await client.messages.create({ text });
  return res.id;
};
```

建议：

```ts
const send = Effect.fn("Feishu.send")(function* (text: string) {
  const res = yield* Effect.tryPromise({
    try: (signal) => client.messages.create({ text }, { signal }),
    catch: (cause) => new SendFailed({ cause }),
  });
  return res.id;
});
```

为什么：交界收窄到库的一次调用；`signal` 传下去，Effect 被打断时请求也停；失败是带标签的错误。

在这里：已拦（`vibevalley/promise-boundary`、`vibevalley/try-promise-catch`）；`signal` 审。

### 16. 从外面的回调回到 Effect

不建议：

```ts
socket.on("message", (data) => {
  Effect.runPromise(handle(data)); // A new runtime per message: no services, no scope, nobody waits for it.
});
```

建议（这里，`infra/log.ts`、`infra/time.ts`）：

```ts
const run = yield* FiberSet.makeRuntime();
socket.on("message", (data) => run(handle(data)));
// The fibers belong to the service's scope: they stop when it closes.
```

为什么：回调里跑的 Effect 要拿到服务、归作用域管，服务关了它们也停。

在这里：在 Effect 里调 `run*` 已拦（`runEffectInsideEffect`）；回调里的审。

## 资源和并发

### 17. 打开了要关的东西

不建议：

```ts
const client = new Client(url);
try {
  yield* use(client);
} finally {
  client.close(); // Not run when the fiber is interrupted between the lines.
}
```

建议：

```ts
const client = yield* Effect.acquireRelease(
  Effect.sync(() => new Client(url)),
  (c) => Effect.sync(() => c.close()),
);
// In a service: inside Layer.effect, so it closes with the service.
```

为什么：取得和释放成对写，打断、失败都会释放。

在这里：gen 里的 `try` 已拦（`tryCatchInEffectGen`）；成对释放审。

### 18. 起一个后台任务

不建议：

```ts
yield* Effect.forkDetach(pollForever); // Nobody stops it: it outlives the service and the tests.
```

建议：

```ts
yield* Effect.forkScoped(pollForever);
// A service's background work: Layer.effectDiscard(Effect.forkScoped(…)), stopped when the layer is.
```

为什么：后台的纤程归作用域，服务关了、测试结束了它也停；`forkDetach` 只留给真要比调用方活得久的（终端里的对话），在那一行说为什么。

在这里：已拦（`vibevalley/scoped-fibers`）。

### 19. 一批事情并发做

不建议：

```ts
const pages = yield* Effect.all(ids.map((id) => fetchPage(id))); // One after another: Effect.all is sequential by default.
await Promise.all(ids.map(fetchPage));                         // No limit, no interruption.
```

建议：

```ts
const pages = yield* Effect.forEach(ids, fetchPage, { concurrency: 4 });
```

为什么：`Effect.all`、`forEach` 默认一个接一个；要并发就写上限。数量由主人或外面定的（工单数、消息数）不用 `"unbounded"`。循环里一个一个 `yield*` 查库也不要：查一次拿全部。

在这里：循环里 `yield*` 已拦（`vibevalley/yield-in-loop`）；并发上限审。

### 20. 读出来、算一下、写回去

不建议：

```ts
const now = yield* Ref.get(held);
const next = yield* reload(now); // Another fiber can write between the get and the set.
yield* Ref.set(held, next);
```

建议（这里，`memory/sources.ts`）：

```ts
const next = yield* SynchronizedRef.modifyEffect(held, (now) =>
  Effect.map(reload(now), (fresh) => [fresh, fresh] as const),
);
```

为什么：中间要跑 Effect 的「读、算、写」用 `SynchronizedRef`，整个过程只有一个纤程在做；纯计算的用 `Ref.modify`。

在这里：审。

## 时间、重试、轮询

### 21. 重试和轮询

不建议：

```ts
for (let attempt = 0; attempt < 3; attempt++) {
  const r = yield* Effect.result(call);
  if (r._tag === "Success") return r.success;
  yield* Effect.sleep(`${2 ** attempt} seconds`);
}
```

建议（这里，`voice/voice.ts`）：

```ts
const retries = Schedule.exponential("1 second").pipe(
  Schedule.while(({ attempt }) => attempt <= 2),
);
yield* call.pipe(Effect.retry(retries));
// Polling until something is there: Effect.repeat(check, { schedule: Schedule.spaced("2 seconds"), until: … }).
```

为什么：`Schedule` 把多久一次、几次、什么时候停写在一处，测试里 `TestClock` 能拨；手写的循环每处都不一样，也拨不动。按错误挑着重试用 `Effect.retry({ schedule, while: (e) => e._tag === "RateLimited" })`。

在这里：审；`Effect.result` 的分支在棘轮上（`resultBranch`）。

### 22. 等外面的回答

不建议：

```ts
const answer = yield* agora.join(channel); // A service that never answers holds this fiber forever.
```

建议：

```ts
const answer = yield* agora.join(channel).pipe(
  Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => new CallFailed({ reason: "timeout" }) }),
);
```

为什么：外面的服务、进程、网络都要有时间上限，到点给一个带标签的错误，调用方知道是超时。

在这里：审；和 `Effect.sleep` 赛跑的写法已拦（`raceFirstWithSleepToTimeout`）。

### 23. 现在几点

不建议：

```ts
const at = Date.now();
setTimeout(flush, 1000);
```

建议：

```ts
const at = yield* Clock.currentTimeMillis;
yield* Effect.sleep("1 second").pipe(Effect.andThen(flush), Effect.forkScoped);
```

为什么：时间经 `Clock`，测试用 `TestClock` 拨；`Date.now()`、`setTimeout` 测试的钟拨不动。同步的外部回调用 `infra/time.ts` 给的 `Time`。

在这里：已拦（`vibevalley/no-wall-clock`、`globalTimersInEffect`、`vibevalley/clock-in-effect`）。

## 配置和日志

### 24. 读配置

不建议：

```ts
const key = process.env.DEEPSEEK_API_KEY ?? "";
```

建议：

```ts
const key = yield* Config.Redacted("DEEPSEEK_API_KEY");
// With a default: Config.String("VIBEVALLEY_SERVER").pipe(Config.withDefault("http://127.0.0.1:8787")).
```

为什么：经 `Config` 读的，测试能用 `ConfigProvider` 换掉，缺了、格式不对时报出是哪个；密钥用 `Config.Redacted`，打日志也不会漏出来。服务端的配置经 `infra/config.ts` 统一读进 `ServerConfig`。

在这里：Effect 里的已拦（`processEnvInEffect`）；进程入口（`main.ts`、命令行的开头）读环境是允许的。

### 25. 打日志

不建议：

```ts
yield* Effect.logWarning(`memory from ${name} is off: ${why}`);
console.log("sent", id);
```

建议（这里，`memory/sources.ts`）：

```ts
yield* Effect.logWarning("memory source is off", why).pipe(Effect.annotateLogs({ source: name }));
```

为什么：值放在注解和后面的参数里，日志能按 `source` 筛；`console.log` 不经 Effect 的日志，测试里关不掉，也没有级别。

在这里：`console` 已拦（`no-console`）；拼进字符串的审，现有的不强改。

## 测试

### 26. 测一段 Effect 和时间

不建议：

```ts
it("fires after a minute", async () => {
  const done = await Effect.runPromise(schedule.pipe(Effect.provide(TestLayer)));
  await new Promise((r) => setTimeout(r, 60_000));
  expect(done).toBe(true);
});
```

建议：

```ts
it.effect("fires after a minute", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(schedule);
    yield* TestClock.adjust("1 minute");
    expect(yield* Fiber.join(fiber)).toBe(true);
  }).pipe(Effect.provide(TestLayer)),
);
```

为什么：`it.effect` 跑在测试的运行时上，`TestClock`（`effect/testing`）把一分钟拨过去；真等会让测试慢，也会时好时坏。等一个条件用 `@vibevalley/testkit/until`。

在这里：已拦（`floatingEffectInVitest`、`vibevalley/no-test-sleep`）。

## Stream

### 27. 一页一页地取

不建议：

```ts
const all: Item[] = [];
let cursor: string | undefined;
do {
  const page = yield* fetchPage(cursor);
  all.push(...page.items); // Everything in memory before the first one is used.
  cursor = page.next;
} while (cursor);
```

建议：

```ts
const items = Stream.paginate(undefined as string | undefined, (cursor) =>
  Effect.map(fetchPage(cursor), (page) => [page.items, Option.fromNullishOr(page.next)] as const),
);
yield* Stream.runForEach(items, save);
```

为什么：数量不知道多少、要边取边处理的用 `Stream`，取一页处理一页，背压和打断都有；一次就能拿全、量也小的，直接 `Effect`。

在这里：审。

## 观测、打断和性能

这一组来自第二轮的资料：[Effect Best Practices](https://ethanniser.com/blog/effect-best-practices/)、[Kit Langton 的 Effect v4 skill](https://www.ui-skills.com/skills/kitlangton/effect)、[Effect Solutions](https://www.effect.solutions/services-and-layers)、[agent doctor](https://effect.doctor/) 的规则。为什么这样写见 [principles.md](.agents/skills/vv-effect/references/principles.md)。

### 28. span 包在把失败变成值的外面

不建议：

```ts
const outcome = yield* send(message).pipe(Effect.result, Effect.withSpan("Feishu.send"));
// The failure is moved into the success channel before the span ends: the trace shows a success.
```

建议：

```ts
const outcome = yield* send(message).pipe(Effect.withSpan("Feishu.send"), Effect.result);
// Better still: send is Effect.fn("Feishu.send"), so its own span records the failure.
```

为什么：span 记的是它包住的那段 Effect 的结局；`Effect.result`、`Effect.option`、`Effect.ignore` 之后再包，失败已经变成了成功的值。

在这里：审；`Effect.result` 的分支在棘轮上（`resultBranch`）。

### 29. 把 `Option` 当布尔值

不建议：

```ts
const found = Option.fromNullishOr(map.get(id));
if (found) return found.value; // An Option is an object: always truthy, and .value is not there on None.
```

建议：

```ts
if (Option.isSome(found)) return found.value;
// Or, with both cases: Option.match(found, { onNone: …, onSome: … }).
```

为什么：`Option` 永远是一个对象，`if` 永远进去；`Option.isSome` 收窄类型以后才有 `.value`。

在这里：类型挡住大部分（`None` 上没有 `.value`），审。

### 30. 不让打断

不建议：

```ts
yield* Effect.uninterruptible(Effect.gen(function* () {
  yield* writeJournal(entry);
  yield* waitForPeer(); // Now nothing can stop this wait: no timeout, no race, no Ctrl+C.
}));
```

建议：

```ts
yield* Effect.uninterruptibleMask((restore) =>
  Effect.gen(function* () {
    yield* writeJournal(entry);   // Protected: always finishes once started.
    yield* restore(waitForPeer()); // Interruptible again: a timeout or a race can stop it.
  }),
);
```

为什么：`uninterruptible` 连它里面的等待也保护起来，`timeout`、`race` 都停不了它；只保护必须做完的那一小段，其余用 `restore` 放回去。

在这里：审；终端里的对话是有意整段不打断的，那里写了为什么（`apps/server/src/chat/main.ts`）。

### 31. 重试的上限和抖动

不建议：

```ts
yield* call.pipe(Effect.retry(Schedule.exponential("200 millis"))); // Forever, every client in step.
yield* sendMessage(text).pipe(Effect.retry({ times: 3 })); // Not idempotent: the message can go out twice.
```

建议：

```ts
const transient = Schedule.exponential("200 millis").pipe(Schedule.jittered, Schedule.upTo({ times: 5, duration: "30 seconds" }));
yield* call.pipe(Effect.retry({ schedule: transient, while: (e) => e._tag === "Unavailable" }));
// A send is retried only with a key the other side dedupes on (sendKey, requestKey).
```

为什么：没有上限的退避把一次故障拖成永远；大家同时重试会把刚恢复的服务再打垮，抖动把它们错开；只重试做两次也没害处的，或者带着对方认得的去重 key。

在这里：审。

### 32. fork 了马上 join

不建议：

```ts
const fiber = yield* Effect.forkChild(load(id));
const page = yield* Fiber.join(fiber); // Nothing ran in between: the fork bought nothing.
```

建议：

```ts
const page = yield* load(id);
// Two at once: const [a, b] = yield* Effect.all([loadA, loadB], { concurrency: 2 }).
```

为什么：fork 是为了让两件事同时做；中间什么都没做就 join，只多了一个纤程和更难读的代码。

在这里：审。

### 33. 收集一个不会结束的 Stream

不建议：

```ts
const all = yield* Stream.runCollect(frames); // A stream of state frames never ends: this never returns.
```

建议：

```ts
yield* Stream.runForEach(frames, handle);
// A few of them: Stream.take(frames, 1), or Stream.takeUntil(frames, (f) => f.done).
```

为什么：`runCollect` 等它结束、把全部放进内存；不会结束的（订阅、状态流、轮询）一条一条处理，或者先 `take`。

在这里：审。

### 34. 手写缓存和请求去重

不建议：

```ts
const cache = new Map<string, { at: number; value: Price }>();
const inFlight = new Map<string, Promise<Price>>();
// Expiry, a size limit, two callers asking at once, a failure that must not be cached: each written by hand.
```

建议：

```ts
const prices = yield* Cache.make({ capacity: 500, timeToLive: "5 minutes", lookup: (id: string) => fetchPrice(id) });
const price = yield* prices.get(id);
// One value for the whole service: const config = yield* Effect.cached(loadConfig).
```

为什么：`Cache` 管过期、容量和同时来的请求（只查一次）；手写的版本常漏掉其中一样，失败也被缓存住。

在这里：审；常驻的 `Map` 由谁删，见 [vv-governance](.agents/skills/vv-governance/SKILL.md)。

### 35. 构造 layer 的函数调了两次

不建议：

```ts
const AppLive = Layer.mergeAll(Issue.layer.pipe(Layer.provide(Db.layerAt(path))), Channel.layer.pipe(Layer.provide(Db.layerAt(path))));
// Two calls, two layers: two databases opened on one file.
```

建议：

```ts
const DbLive = Db.layerAt(path); // Built once: layers are shared by reference.
const AppLive = DbLive.pipe(Layer.provideMerge(Issue.layer), Layer.provideMerge(Channel.layer));
```

为什么：layer 按引用去重，同一个值只建一次；带参数的构造函数每调一次是一个新的 layer。先存进常量再用。

在这里：审；layer 只在 `services.ts` 叠。

### 36. 测试之间共享 layer

不建议：

```ts
const world = Effect.runSync(Layer.build(World.layer)); // One farm for every test file: one test's issues are the next one's.
```

建议：

```ts
it.effect("…", () => Effect.gen(function* () { /* … */ }).pipe(Effect.provide(World.layer))); // A fresh farm each test.
// Only what is costly to build is shared: it.layer(Database.layer)(…), its state reset between tests.
```

为什么：每个测试一个新的 layer，状态不会从一个测试漏到下一个；只有真贵的（数据库、整个服务）才共享，并且说清楚共享了什么。

在这里：审；服务端测试的分层和预算见[测试金字塔](docs/subsystems/foundation.md)。

### 37. 吞掉、降级、重试之前不留记录

不建议：

```ts
const memories = yield* source.search(text).pipe(Effect.catch(() => Effect.succeed([]))); // A source that is down looks like one with nothing.
```

建议：

```ts
const memories = yield* source.search(text).pipe(
  Effect.tapError((e) => Effect.logWarning("memory source failed", e).pipe(Effect.annotateLogs({ source: source.name }))),
  Effect.catchTag("SourceFailed", () => Effect.succeed([])),
);
// "Note it and go on" for any failure, defects too: infra/log.ts's bestEffort(what).
```

为什么：降级以后调用方看到的是正常的空结果；先 `tapError` 记下来，日志和 trace 里才知道它其实失败了。

在这里：审；不带 `{ log }` 的 `Effect.ignore` 在棘轮上。

### 38. 在 Effect 的组合子里传 async 函数

不建议：

```ts
yield* Effect.forEach(files, async (file) => {
  await upload(file); // The Effect sees a Promise as the value: it does not wait, and a rejection is lost.
});
```

建议：

```ts
yield* Effect.forEach(files, (file) => Effect.tryPromise({ try: (signal) => upload(file, { signal }), catch: (cause) => new UploadFailed({ file, cause }) }), {
  concurrency: 4,
});
```

为什么：`map`、`forEach`、`tap` 收到 async 函数时，Promise 只是一个普通的值：不等它，失败也不进错误通道。

在这里：已拦（`vibevalley/promise-boundary`：async 只在 `tryPromise`、`promise` 里）。

### 39. 里面的错误原样从接口送出去

不建议：

```ts
"issue.diff.get": ({ id }) => issues.diff(id), // GitFailed { cause: <the process, its stderr, the repository path> } goes to the page.
```

建议：

```ts
"issue.diff.get": ({ id }) => issues.diff(id).pipe(Effect.catchTag("GitFailed", (e) => Effect.fail(refused(t("server.issue.diffFailed", { why: e.reason }))))),
// The wire's errors are ApiError (Missing, Refused…): words for the owner and next steps, no causes.
```

为什么：里面的错误带着原因（堆栈、路径、库的报错），是给日志看的；经接口出去的是协议里的错误，只有给主人看的话和接着能做什么。在边界上转一次，不把里面的东西泄出去。

在这里：接口的错误类型是 `ApiError`（类型挡住大部分）；转换在拥有规则的服务或处理里，审。

### 40. 为了传一个参数改全局的环境变量

不建议：

```ts
const before = process.env[name];
process.env[name] = binPath; // Every other probe and session in the process sees it until it is put back.
try {
  return runtime.installation();
} finally {
  if (before === undefined) delete process.env[name];
  else process.env[name] = before;
}
```

建议：

```ts
// oar's probes take an env overlay: the host's environment is untouched.
return runtime.installation({ env: { [`OAR_${runtime.id.toUpperCase()}_BIN`]: binPath } });
```

为什么：全局的环境是整个进程共享的，写进去再还原只在同步的那一小段里安全，改了库、加了一个 `await` 就串了；库已经收参数时，参数就是那个更高一层的写法。看着要「设好再还原」的地方，先看库现在给不给参数（这一处是 oar 早先只读环境变量时留下的）。

在这里：`apps/server/src/runtime/runtime.ts` 的 `probeInstallation`；`process.env` 由 Effect 的诊断拦，审。

### 41. 手写的单消费者队列

不建议：

```ts
const waiting: string[] = [];
let telling = false;
const drain = Effect.gen(function* () {
  while (waiting.length > 0) {
    yield* Effect.sleep(gatherMs);
    yield* say(waiting.splice(0));
  }
}).pipe(Effect.ensuring(Effect.sync(() => { waiting.length = 0; telling = false; })));
const tell = (texts: readonly string[]) => {
  waiting.push(...texts);
  if (telling) return; // A flag stands for "a consumer is running": every exit path has to reset it.
  telling = true;
  forkHere(drain);
};
```

建议：

```ts
const told = yield* Queue.unbounded<Told>();
const round = Effect.gen(function* () {
  let pending = yield* Queue.takeAll(told); // Waits for one, takes all.
  while (pending.length > 0) {
    yield* Effect.sleep(gatherMs);
    pending.push(...(yield* Queue.clear(told)));
    yield* say(pending);
    pending = yield* Queue.clear(told);
  }
}).pipe(Effect.ensuring(Queue.clear(told)));
yield* Effect.forkScoped(Effect.forever(round));
const tell = (t: Told) => Queue.offerUnsafe(told, t);
```

为什么：数组、「有没有人在消费」的标志、按需 fork、出口处的复位，合起来就是一个队列和一个消费者；`Queue` 和归作用域的一个纤程把它们换成结构，标志就不会忘了复位。`takeAll` 等到至少一个、`clear` 不等，正好是「攒一会儿，一次说完」。

在这里：`apps/server/src/voice/voice.ts` 的通话播报；审。
