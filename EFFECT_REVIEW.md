# Effect TypeScript 评审与改造：15 个不够地道的点，以及如何闭合它们

> 分支：`v4-k31`（独立 worktree）
>
> Effect：`4.0.5`
>
> 评审方式：官方指南与源码对照、生产代码静态审查、最小运行探针。
>
> 前半记录基线 `59ad8eb3` 的评审，文中的「当前写法」都指这个基线；末尾记录实现与验证，现行行为以各子系统文档为准。静态推导不写成已经发生的线上事故。

## 摘要：答案不是“Effect 用得不好”，而是几处关键边界还没闭合

这个仓库已经大量采用 `Effect.gen`、`Effect.fnUntraced`、服务与 Layer、`PubSub`、`Stream`、`NodeRuntime.runMain`。很多看起来“很 Effect”的结构是成立的：核心状态有明确 owner，数据库有 `acquireRelease`，Session 有现场锁和交接，服务也有真实的测试替身。不能再用“有没有 Effect 类型”来判断代码质量。

真正值得改的是下面三类问题：

1. **错误在组合子里消失或被改错种类。** `Effect.option` 把 SQL/解码失败和空行混成一件事；宽范围 `catchDefect` 又把程序员错误包装成普通业务拒绝。
2. **异步工作没有完整生命周期。** spawn、探测、启动语音、构建输入都可能越过中断或服务关闭；底层 Promise 仍会完成，资源却已经失去 owner。
3. **边界数据与取消语义没有传到最外层。** 听写的 `AbortSignal` 没传进 `fetch`，两个 JSON 边界缺运行时解码，SSE 的慢消费者没有明确的背压策略。

按独立问题计，本文保留 **15 项**：

| 优先级 | 数量 | 判断 |
|---|---:|---|
| P0：先修，错误和资源生命周期 | 5 | 可能误报不存在、泄漏 agent/tunnel/输入、产生未处理 rejection 或进程级风险 |
| P1：随后修，错误语义和取消 | 5 | 缺陷被误分类、Effect 未运行就改状态、取消不到 I/O、坏输入变成 500 或毒化消息链 |
| P2：排队改进，背压与测试确定性 | 4 | 慢消费者、监听器、固定端口、墙钟使系统难验证或难维护 |
| P3：最后做，官方写法与可观测性 | 1 | 可复用方法的闭包与追踪边界，不是当前功能错误 |

另外还有一批“看起来像问题、实际不该动”的写法，列在后文，避免把 Effect 化本身当成目标。

## 评审标准与范围

我主要阅读 `apps/server/src` 的生产代码，并用测试代码判断现有覆盖能不能拦住问题。`apps/desktop`、`apps/mobile` 只用来确认哪些 Promise 属于合理的宿主边界，不要求它们引入 Effect runtime。`apps/server/db/generated` 不纳入手改建议。

判断一项是否“不地道”，至少满足一条：

- 与 Effect 4.0.5 的实际语义相反，而不只是与某种风格不同；
- 错误、取消、资源或顺序在 Interface 中丢失，调用方无法正确决定下一步；
- 现有实现使故障难以定位、测试无法确定复现，或生命周期只能隐含在注释里；
- 改动能缩小这些知识泄漏，而不是只把同一套编排换一个名字。

官方依据主要来自 `node_modules/effect/AGENTS.md`、`node_modules/effect/src/Effect.ts`、`SqlSchema.ts`、资源与并发模块。下面每项仍给出具体验证办法；没有跑过的目标测试不写成已经通过。

---

## P0-01：`Effect.option` 把 SQL 和解码失败吞成“没有这一行”

**位置**

- `apps/server/src/issue/issue.ts:227` 的 `one(...)`；
- `apps/server/src/channel/chat.ts:339-342`；
- `apps/server/src/doc/doc.ts:91-97,133,148,154`；
- `apps/server/src/session/session.ts:1201`；
- `apps/server/src/lan/lan.ts:146`；
- `apps/server/src/connector/connector.ts:279,505`。

**当前写法**

```ts
const one = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.map(db(Effect.option(e)), Option.getOrUndefined)
```

`SqlSchema.findOne` 的失败联合是 `E | SchemaError | NoSuchElementError`（`node_modules/effect/src/sql/SqlSchema.ts:115-145`）。`Effect.option` 则把**所有 typed failure**都变成 `None`，并丢弃失败值（`node_modules/effect/src/Effect.ts:3779-3799`）。所以下面的三件事无法区分：

- 数据库里确实没有这一行；
- SQL 执行失败；
- 读到了行，但 Schema 解码失败。

外层的 `orDie` 已看不到原始错误，调用方可能把工单、文档、Session 或配置误报为不存在。最小探针也确认：`Effect.fail("SQL failure")` 经 `Effect.option` 后得到的是 `undefined`，不是失败。

**为什么必须改**

这不是“用不用 Option”的偏好，而是把基础设施故障改成了业务事实。尤其在 LAN 配置、工单读取和会话恢复中，“没有”与“读失败”应走完全不同的路。

**建议**

只把 `NoSuchElementError` 转成 `None`，其他错误保留给原来的 `db(...).pipe(Effect.orDie)` 或调用方。可以先用 `map(Option.some)`，再单独 `catchTag("NoSuchElementError", ...)`；生成器若提供 `SqlSchema.findOneOption`，它的类型只保留 `E | SchemaError`，更符合意图（`SqlSchema.ts:149-171`）。不要手改 `db/generated`。

**验证**

给公共 optional 帮手分别注入 `NoSuchElementError`、`SqlError`、`SchemaError`：只有第一种允许返回空，后两种必须保留失败。再各补一个“有行但解码失败不能报 404”的业务测试。

---

## P0-02：`Sessions.send` 在 attach 前中断，可能留下 allocation、workplace 和无人监听的 agent

**位置**

- `apps/server/src/session/session.ts:735-758`；
- 正常失败清理在 `session.ts:1055-1082`；
- 注册与 attach 在 `session.ts:1080-1110`。

**当前问题**

实现先把 `allocation` 放进 Map，再用 `Effect.promise` 等 `subagents.spawn`。只有正常返回 refused 才走 `failedOpening`；从 `open` 到注册、attach 的整段没有 `onExit` 或 `acquireRelease` 保证非成功退出的清理。

Effect 中断不等于 Promise rejection。底层异步操作若没有观察传入的 signal，它仍可能完成，而 generator 不会恢复。于是：

- allocation 仍占容量，同工单重试也可能被它挡住；
- workplace 只有正常 `refuseStart` 才释放；
- 若 spawn 迟到成功，事件监听没有 attach，但 agent 可能已经在工作区里行动；
- 只有整个服务关闭时，才有最后一层统一清理。

`acquireRelease` 默认覆盖获取阶段的退出（`node_modules/effect/src/Effect.ts:13310-13315`）。oar 自身也有 `Subagents.close()` 处理 in-flight spawn 的原语，说明正确清理应该由 owner 主动完成，而不是依赖进程结束。

**建议**

给 `open → 注册 → attach` 建一个明确的所有权转移：

1. 尚未成功 attach 时，任何非成功 Exit 都关闭 allocation、释放 workplace 和 token；
2. attach 成功后，所有权才移交给 Session 的正常生命周期；
3. 对不可取消的 SDK 获取阶段，用一个小的不可中断临界区完成“取得资源并登记清理钩子”；可取消的接口则把 signal 传下去。

仅增加 `.catch` 不够，因为中断不走 rejection 分支；仅把 Map 删掉也不够，因为还要处理已经创建的外部会话。

**验证**

用 deferred `runtime.session` 卡住 spawn，fork `send` 后中断，再放行：应调用 `subagents.close` 或 session `dispose`，容量和同工单重试不被旧 allocation 挡住，workplace 被释放。另补在 `opt.hiring` 等待期间中断的用例，证明注册前的资源也有人收尾。

---

## P0-03：`AgentHost.stop/close` 没有让输入 Promise 链失效，停止后仍会启动输入

**位置**

- `apps/server/src/session/host.ts:177-183` 的输入交付；
- `host.ts:205-215` 的 stop / close；
- `host.ts:288-295` 的 Promise 串行链；
- `apps/server/src/agent/brain/agent.ts:467-473` 的队列清空。

**当前问题**

`serially` 把 Build 和 `send/later` 排到 `this.inputs`，但：

- `stop()` 只停 Brain，不处理正在构建的输入；
- `close()` 只等 Brain 和 `this.events`，不等 `this.inputs`；
- `closing` 没有用于拒绝新的或尚未交付的输入。

用 deferred Build 做最小复现，可以出现：

```text
build-start → brain-stop → host-stop-return → send
```

close 也能在 host-close-return 后继续 send。也就是说，主人的停止和服务的关闭都已经结束，模型和工具却仍可能被下一条旧输入启动。

**为什么这是 Effect 边界问题**

结构化并发不是“等待某一条 Promise 链”就算完成，而是后台工作必须绑定 owner 的生命周期。仅等待 Brain 的事件，无法阻止另一个异步生产者继续交付。

**建议**

- `closing` 必须拒绝新的 submit/resume；
- close 等 `inputs` 落定后再关 Brain；
- stop 用 generation/epoch 使停止前构建的输入在 `send/later` 前失效；
- 同时核对 Orchestrator 的监听 fiber 与 Host finalizer 的次序，避免关闭期间继续接收输入。

不要给每个 caller 加超时来掩盖这个问题；终态应由 Host 统一给出。

**验证**

固定 deferred-build 探针，分别覆盖 stop、close，以及 close 后再次 submit/resume。旧 submission 不得交付，新 generation 在 stop 后仍可正常工作，多个 pending caller 只结束一次。

---

## P0-04：Voice 的启动、活跃通话和后台播报没有统一纳入 Scope

**位置**

- 启动：`apps/server/src/voice/voice.ts:574-631`；
- 线路 key：`voice.ts:424-450`；
- 服务 finalizer：`voice.ts:464-475`；
- 后台播报：`voice.ts:507-537`。

**当前问题分三层**

1. **启动中断。** `g.starting` 先置为 true，随后等待 `openLine` 或 `session.start`。`tapError` 只处理 typed error，Effect 中断时不执行 release。等待 tunnel 时，底层 Promise 仍可晚到并 `keys.set`，而清理没有安装。
2. **活跃通话。** `calls` 里有 `client.stopAgent` 和 `release`，单通停止有 `ensuring`，但 layer finalizer 只清 grants、keys、tunnel 和本地 HTTP server，没有遍历 active calls。关闭 layer 后，远端 Agora agent 可能继续到 idle/token 超时。
3. **后台播报。** `tell` 用未跟踪的 `void drain()`。关闭若发生在 `orchestrator.brief` 等待期间，`stopped` 检查已经通过，随后仍可能 `speakOn`。

这些不是“云端也会超时，所以没关系”：本地已经知道该停，却把停止时机交给云端的超时和费用策略。

**建议**

把每次资源获取和所有权移交写成 bracket/onExit：只有成功登记到 `calls` 才转移所有权，其余 Exit 都释放。finalizer 要逐个停止 active calls 并执行 release；播报改由 `FiberSet` 或 `forkScoped` 管理，并在 brief 返回后再次检查停止状态。迟到的 tunnel、line key 和 agent id 都必须有取消后的清理路径。

**验证**

分别 deferred `openLine` 和 `session.start`，中断后放行，断言迟到的 tunnel/agent 被关闭、`lines()` 为 0、grant 可重试；关闭含 active call 的 Scope，断言调用 `stopAgent`；deferred brief 在关闭后完成时不得再 speak。

---

## P0-05：`Runtimes.list` 用裸 Promise 启动探测，失败无监督，关闭后仍可写缓存

**位置**

- `apps/server/src/runtime/runtime.ts:328-335` 的 `refresh`；
- `runtime.ts:387-407` 的 `list`；
- 已有的受管后台设施在 `runtime.ts:168-176,363-369`。

**当前问题**

缓存缺失时，`list` 执行 `void refresh(id)`。这条路径：

- 没有 catch，probe rejection 没人处理；
- 没走文件里已有的 `forkHere` / scoped 后台路径；
- `begin(id)` 已记录 read，失败后没有 cache，后续 `list` 不会自动重试；
- 服务关闭后，裸 Promise 仍可完成并写缓存、发事件。

后台正常探测反而逐条 catch（`runtime.ts:353-360`），说明“探测失败”本来就是预期情况。`Effect.tryPromise` 应把可能 reject 的操作收入错误通道，FiberSet 的 scoped runtime 则保证 owner 关闭时中断所持 fibers。

**建议**

保持 `list` 同步返回快照，但后台启动统一走已有 `forkHere`。用 `tryPromise` 或明确的错误映射记录失败，把失败写成可重试状态或清理 read 标记；完成写缓存前检查 `closed`。如果 probe 能接收 AbortSignal，把中断继续传入，而不是只靠关闭标志。

**验证**

覆盖同步抛错的 installation、连续两次 `list`、deferred probe 未完成就关闭 Scope：不应有未处理 rejection，不应有晚到 cache/event，失败后还能再次探测，runtime 不长期停在 `checking`。

---

## P1-06：宽范围 `catchDefect` 把意外缺陷改成普通业务拒绝

**位置**

- `apps/server/src/issue/issue.ts:493-497`；
- `apps/server/src/task/task.ts:213-216`；
- `apps/server/src/session/session.ts:1082-1090`。

**当前问题**

三处都把整段业务 Effect 的 defect 转为 `Effect.fail(...)`，随后用 `Effect.result` 当普通失败处理。于是 `get/add`、`putTask`、注册会话里任何意外异常都可能变成“没记下来”或“派不出去”。

`catchDefect` 的定位是集成边界上的报告或转换，官方也提醒意外 defect 通常不应恢复（`node_modules/effect/src/Effect.ts:5693-5708`）。`Effect.result` 只捕获 typed failure，不捕获 defect 和 interruption。现在的组合却先把 defect 改成 typed failure，再把分类结果返回给调用方，程序员错误因而失去告警和缺陷语义。

**建议**

删除覆盖整个业务段的 `catchDefect`；预期的 `ApiError` 继续用 `Effect.result` 或 `catchTag`。若产品确实需要对 SQL/文件故障返回拒绝文案，在具体故障原点只转换已知类型。会话和计划保存失败后的清理可改用 `Effect.onError`：清理照做，但保留原 `Cause`，而不是换一张错误面孔。

**验证**

用会 `Effect.die(new Error("boom"))` 的替身覆盖这些边界：退出仍应是 defect，同时工作区/会话得到清理；另用已知 typed error 验证原有拒绝路径。

---

## P1-07：`AgentExecution.close()` 在 Effect 运行前就修改状态

**位置**

- `apps/server/src/session/execution.ts:173-179`；
- 当前调用方 `apps/server/src/session/host.ts:215`。

**当前写法**

```ts
close(): Effect.Effect<void, Error> {
  this.closed = true
  if (this.run && !this.ending) {
    this.outcome = "interrupted"
    this.summary = "..."
  }
  return this.finish()
}
```

仅调用 `x.close()`、即使从未运行返回的 Effect，也会关闭执行并改写结局。随后 `observe` / `failedStart` 会被忽略，重试或重复执行时，这些状态转换也不会按 Effect 的执行重新发生。

实际探针读取 `beforeRun` 就得到 `closed: true`、`outcome: "interrupted"`；此时还没有运行 `closing`。

`Effect.suspend` 的官方语义正是延迟构造及其中副作用，并在每次执行时重新求值（`node_modules/effect/src/Effect.ts:1657-1670`）。这里不是风格不统一，而是副作用建模错误。

**建议**

把状态修改和 `this.finish()` 一起放进 `Effect.suspend`，或放进 `Effect.fn` / `Effect.gen` 的生成器体后再 `yield* this.finish()`。不需要重写其他方法。

**验证**

构造 `const closing = x.close()` 但不运行：此时 `observe(user(...))` 仍应能开启 run；运行 `closing` 后，后续输入才被忽略，run 以 `interrupted` 结束。

---

## P1-08：听写的 `tryPromise` 没有把 Effect 中断信号传给 `fetch`

**位置**

`apps/server/src/voice/voice.ts:681-690`。

**当前写法**

```ts
Effect.tryPromise({
  try: () =>
    fetch(url, {
      // ...
      signal: AbortSignal.timeout(120_000),
    }),
  catch: ...
})
```

`tryPromise` 会提供一个随 Effect 中断而 abort 的 `AbortSignal`，但底层操作必须观察它才会停止。当前 `fetch` 只看独立的 120 秒超时信号，所以 HTTP 请求取消或 Effect 作用域结束后，网络请求仍可能继续到超时。

**建议**

保留超时，同时组合 Effect 的信号：

```ts
try: (signal) =>
  fetch(url, {
    // ...
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  })
```

**验证**

假 `fetch` 返回 pending Promise 并记录 `init.signal`；fork 听写后中断，断言该信号被 abort。另保留“120 秒超时仍会触发”的用例，证明组合没有丢掉原语义。

---

## P1-09：QQ WebSocket 的合法 JSON `null` 会永久毒化消息链

**位置**

`apps/server/src/connector/qq.ts:112-145`。

**当前问题**

每帧串到 `chain`，但没有 rejection 收尾。`JSON.parse` 只包了 parse 的 try/catch，解析结果又直接 `as typeof msg`。收到合法文本 `"null"` 后，`msg.s` 会抛 `TypeError`。

这个异常发生在 `chain.then` 内：

- 不会进入只包 `JSON.parse` 的 catch；
- 不会调用 `end`；
- `chain` 一旦 rejected，后续每帧继续 `.then` 仍保持 rejected；
- WebSocket 却可能保持打开，外层收不到失败，也就不会重连或更新状态。

这是典型“解析边界与异步错误边界不一致”，不是 QQ 的特例偶发问题。

**建议**

先解析为 `unknown`，用 Schema 解码 envelope，再按 `op` 解码对应 payload；同时给串行链加统一的 `catch(end)` 兜底。Schema 不是替代关闭逻辑，二者都需要。

**验证**

帧级测试覆盖 `null`、数组、错误的心跳 payload：应关闭并进入重连路径；再补“坏帧之后的好帧仍可处理”，证明消息链不会永久 rejected。

---

## P1-10：OpenAI 兼容接口未解码嵌套请求，坏请求经 `Effect.promise` 变成 defect

**位置**

- `apps/server/src/agent/brain/openai.ts:27-35,60-65`；
- `apps/server/src/http/mcp.ts:12-16`。

**当前问题**

顶层只检查是不是对象，随后直接读取消息项和 content parts。合法 JSON 如：

```json
{"messages":[null]}
```

会在 `x.role` 处抛错；`content:[null]` 会在 `p.type` 处抛错。`http/mcp.ts` 又用 `Effect.promise` 包这个可 reject 的 handler，rejection 因而成为 defect，通常表现为 500，而不是 OpenAI 形状的 400。

官方 Promise 边界要求 `Effect.promise` 只包“保证不 reject”的 Promise；外部 JSON 应先经 Schema 解码，再映射成客户端错误。

**建议**

为 `ChatRequest`、message 和 content part 定义 Schema，在调用 `answerer` 前解码；解码失败返回 400 的 `invalid_request_error`。错误形状保持现有 OpenAI 兼容格式，不需要更换接口。

**验证**

对 stream / 非 stream 分别测试 null 消息、null part、错误类型的 `model` 和 `stream`：不调用 answerer、不 reject，返回 OpenAI 形状的 400。

---

## P2-11：SSE 的数据面有两层无界积压，慢消费者没有确定的背压策略

**位置**

- `apps/server/src/core/core.ts:145-149`：核心 PubSub 全部 unbounded；
- `core.ts:183-196`：`states` 的 `Stream.callback` 和主动 `Queue.offerUnsafe`；
- `apps/server/src/http/streams.ts:13-38`：直接暴露 SSE。

**当前问题**

慢 SSE 客户端既能在 PubSub subscription 中积累事件，也能在 `states` 的 callback Queue 中积累完整 StateFrame。`takeUpTo(Number.MAX_SAFE_INTEGER)` 还可能一次物化大批积压。

Effect 的 Queue 默认容量是 Infinity，`PubSub.unbounded` 也会让消息保留到订阅者取走。拉取侧背压无法限制生产者，因此存在结构性无界增长条件。这里是设计风险，不是声称已经观察到 OOM。

**建议**

按数据类型选策略，不能统一换 bounded 后继续使用 `publishUnsafe`：

- `states`：在每订阅者侧合并 burst，只保留最新状态，并明确 `GameEffect` 是合并、保留还是丢弃，避免 PubSub 与 callback Queue 双重无限积压；
- `events/live`：选择 bounded + effectful `publish` 的真正背压，或有界积压后断开，让客户端用 snapshot 重同步。不能靠 `publishUnsafe` 静默丢事实。

这里涉及“绝不丢消息”的既有决策，应该先做策略评审，而不是机械换类型。

**验证**

让 SSE 客户端连接但不读取，持续产生事实和帧：每连接积压必须有上限，最终状态最新；按选定策略验证事实不丢，或慢连接被关闭并重同步。给 `states` 增加 handler 被 Deferred 阻塞的测试，避免只测正常消费者。

---

## P2-12：`Caller.words` 每轮空等泄漏一个 abort listener

**位置**

`apps/server/src/session/host.ts:46-59`。

**当前问题**

每次队列为空都新增 `signal.addEventListener(..., { once: true })`，但正常 `push/end` 唤醒 Promise 时没有移除监听。`once` 只在 abort 真正触发后移除，不是 Promise 因其他原因完成时移除。

连续三轮“空等 → push”后，探针得到监听数 **3**；正常 `end` 后仍为 **3**。长流式回答中，它会随空等次数线性增长，可能触发 MaxListeners 警告，也让闭包活到 signal 被回收。

**建议**

整个 generator 只注册一个 abort listener，在 `finally` 中移除；或每次等待都用 `try/finally` 移除本轮 listener。正常结束、abort 和调用方提前 `return()` 都应走同一清理。

**验证**

连续 20 次空等/push，监听数不随轮次增长；正常迭代结束及提前 `return()` 后为 0；abort 仍能唤醒且不遗留监听。

---

## P2-13：测试配置没有统一使用自由端口，完整 app fixtures 会互相抢 8788

**位置**

- `apps/server/src/testing/layers.ts:10-12` 直接继承生产 defaults；
- 生产默认端口在 `apps/server/src/base/config.ts:52,57-58`：HTTP 8787、语音 8788、LAN 8790；
- `apps/server/src/testing/cli.ts:11-14` 只把主 HTTP 设为 0；
- `apps/server/src/lan/lan.test.ts:16-19` 只把主 HTTP 和 LAN 设为 0；
- Voice 构造时总会监听线路，见 `apps/server/src/voice/voice.ts:372-414`。

**当前问题**

即使“不测试语音”，完整 fixture 也可能占用 8788。两个完整 app fixture 并行时会 `EADDRINUSE`；Voice 对监听失败只记录并继续，测试可能表面通过，实际语音线路根本没开。

`apps/web/test/fixtures.ts:40-42` 和 `scripts/verify-server.ts:28-29` 已经把多个端口设为 0，说明这个要求本应集中在测试配置入口，而不是每个 fixture 自己补。

**建议**

让 `testConfig` 默认把主 HTTP、LAN、语音 line 三个端口都设为 0，嵌套配置用 spread 保留其他默认值，`change` 最后覆盖。`flows/reach.test.ts` 这种明确需要固定值的测试继续显式指定，生产 defaults 不变。

**验证**

同时建造两个完整 app fixture，断言都能启动且无端口错误；再并行重复运行 `src/lan/lan.test.ts`、`src/cli.test.ts`、`src/cli/golden.test.ts`。这也能减少不同 worktree 同时验证时的偶发失败。

---

## P2-14：每日预算直接读墙钟，跨日逻辑无法确定性验证

**位置**

- `apps/server/src/runtime/runtime.ts:116-119` 的 `today()`；
- `runtime.ts:192-201` 的加载与清空；
- `runtime.ts:220-226` 的预算停止状态。

**当前问题**

每日预算直接参与派单门禁，但日期由 `new Date()` 决定。测试只能手工塞一个固定的“昨天”，不能驱动同一服务跨午夜，也无法确定验证当地时区和零点边界。

Effect 官方建议在 Effect 程序中使用 Clock 驱动的当前时间（`AGENTS.md:288-296`）；`DateTime.nowInCurrentZone` 同时提供当前时区语义。

**建议**

Effect 路径改用 `DateTime.nowInCurrentZone`，生产提供本地时区。确实需要同步 Promise callback 的部分，可以像 `VoiceOptions.now` 一样显式注入时钟，而不是隐藏读取 `new Date()`。

**验证**

用固定时区和 `TestClock.adjust` 从 23:59:59 跨到次日，断言旧花费清零、预算门禁解除，并覆盖启动时读取昨日存档。这里首先是可测性改进，不声称当前一定算错日期。

---

## P3-15：`AgentExecution` 仍有四个“只包装并返回 `Effect.gen`”的可复用方法

**位置**

- `apps/server/src/session/execution.ts:64-66`：`begin`；
- `execution.ts:87-89`：`finish`；
- `execution.ts:103-105`：`observe`；
- `execution.ts:152-154`：`failedStart`。

**当前问题**

这些方法都是普通函数，只做 `const self = this; return Effect.gen(...)`。官方指南明确建议避免这种可复用函数（`AGENTS.md:14-18,51-60`）：`Effect.fn` 复用 generator body，普通包装则每次调用都创建新闭包；命名形式还提供 stack/span 边界（`Effect.ts:22987-23010`）。`observe` 又是每个 agent 事件都会走的热路径。

**建议**

用类字段和官方支持的 `{ self: this }` 绑定：热路径/私有帮手用 `Effect.fnUntraced`，需要命名边界的公共操作用 `Effect.fn("AgentExecution.<name>")`。P1-07 的 `close` 可放在同一个小改动里，不必扩展到整个模块。

**验证**

现有执行规则回归和类型检查即可；若采用 named span，再补一个 tracing 断言。这里收益主要是分配和可观测性，不能夸大为功能修复。

---

## 这些写法不应该被误判

评审中否决了一些“看起来像 Effect 风格问题”的候选，保留它们比强行统一更地道。

### 1. `NodeRuntime.runMain` 已经用在正确的入口

`apps/server/src/main.ts:58`、`apps/server/src/cli.ts:112-116` 已按官方方式运行程序。不能看到 `Effect.runPromise` 就要求全仓改成另一个 runtime；真正的外部工具桥仍可合理存在。

### 2. 不是所有 `orDie` 都是掩盖错误

SQL、FileSystem、启动迁移和 HTTP 转换中，无法恢复的失败转 defect 是合理的。问题在于错误进入 `orDie` 之前已经被 `Effect.option` 吞掉，而不是 `orDie` 本身。

### 3. `Effect.result` 和测试里的 `Effect.flip` 都有正当用途

需要在同一流程处理成功与预期失败时，`Effect.result` 很合适，而且它仍保留 defect。测试里用 `Effect.flip` 取错误断言也合理，不能把“看到 flip”当成坏味道。

### 4. `Effect.fnUntraced` 已经广泛使用，不能拿旧候选照抄扣分

`apps/server/src/issue/issue.ts` 的 `get`、`idOf` 等公共方法已经使用 `Effect.fnUntraced`。评审要逐处核实，不能因为某处仍是裸函数就说整个 Issue 模块都缺命名边界，更不能为了 span 数量给热路径全部加 tracing。

### 5. 资源和并发的现有 owner 不应被重写

- `apps/server/src/base/db.ts:54-57` 用 `Effect.acquireRelease` 关闭 PGlite；
- `apps/server/src/session/session.ts:1003-1023` 的 finalizer 处理 sessions、allocation 和 trajectories；
- `apps/server/src/recurrence/recurrence.ts:201-210` 把普通 service layer 与开机 ticker layer 分开；
- `apps/server/src/services.ts:34-38` 用 `Layer.provideMerge` 保留下层服务；
- `Sessions.handOver` 已拥有停止写入、现场锁和失败保留，单通 `Voice.stop` 的 `ensuring` 也覆盖失败与中断。

这些正是应该复用的 Seam，不要再造通用资源框架。

### 6. Promise 本身不是不地道

`apps/desktop`、`apps/mobile` 没有 Effect runtime，Electron / Expo / WebView 的 Promise 边界是合理选择。`agent/brain` 与 oar、pi-agent-core 的 Promise 工具桥也不能仅因名字里有 `runPromise` 就被定罪。是否引入 Effect，应由生命周期和错误语义决定，而不是由文本匹配决定。

### 7. `Stream.runForEach` 的串行不等于跨 PubSub 的全局顺序

它只保证单订阅者逐项等待 callback。不能把它的串行当成多条派生流之间的因果保证，也不能反过来把“顺序问题”归到 Stream 本身。需要顺序证明时，应看事实从哪个 hub、以什么次序产生。

### 8. `withPermits`、FiberMap、FiberSet 的既有实现不是当然泄漏

`withPermits` 会通过 `onExitPrimitive` 释放 permit；FiberMap / FiberSet 会在 Scope 关闭时中断所持 fiber。不能把没有手写 clear 的每个地方都列为缺陷，要检查官方实现是否已经有 finalizer。

---

## 推荐的落地顺序

### 第一阶段：先修影响正确性、又容易用窄测试证明的项

建议顺序：**P0-01 → P1-07 → P1-08 → P2-12 → P2-13**。

这些改动边界小，测试直接：保留 SQL 错误、Effect 未运行不改状态、取消到达 fetch、监听器不累积、测试端口不抢占。先建立“错误不消失、取消能到达、测试能复现”的共同标准。

随后处理 **P2-14**，因为它让跨日预算这一类门禁可以用 TestClock 证明，后续改时间相关逻辑会更安全。

### 第二阶段：集中处理资源生命周期

把 **P0-02、P0-03、P0-04、P0-05** 放在一起评审，但不合并成通用工作流。每一项先写当前失败的测试：

- spawn 中断后资源必须释放；
- stop/close 后旧输入不得交付；
- Voice 启动或 layer 关闭后远端 agent 必须停止；
- probe rejection 必须受管且可重试。

它们共享的是“所有权与退出”这一原则，不是同一个新框架。`Sessions.handOver`、`FiberSet`、`acquireRelease` 和现有 finalizer 应该成为实现的参考。

### 第三阶段：修错误分类和外部数据边界

处理 **P1-06、P1-09、P1-10**。先把预期错误与 defect 分清，再让外部 JSON 在 Schema 处失败为 400 或可重连错误，而不是 500、未处理 rejection 或永久毒化。

这一阶段还要避免另一个极端：把 SQL 和基础设施异常全部包装成友好的业务拒绝。清晰的原错误和清理后的 `Cause` 比统一文案更重要。

### 第四阶段：单独做背压策略和低优先级地道性改进

**P2-11** 需要产品决策：慢 SSE 客户端到底背压、合并还是断开重同步。先定什么不能丢，再改 Queue / PubSub。不要把这一步当机械替换。

**P3-15** 最后做，只改 AgentExecution 的四个方法，不把 `Effect.fn` 扩散成新的追踪噪声。

---

## 验证清单

每个阶段都应先跑最窄测试，再跑完整检查。建议按改动选择：

```bash
cd apps/server
npm run test -- src/issue/issue.test.ts src/channel/chat.test.ts src/doc/doc.test.ts
npm run test -- src/session/session.test.ts src/session/execution.test.ts
npm run test -- src/voice/voice.test.ts
npm run test -- src/runtime/runtime.test.ts
npm run test -- src/connector/connector.test.ts
npm run test -- src/task/task.test.ts
```

资源和中断用例还应包含：

- deferred spawn / probe / openLine / session.start 后中断，再晚到 resolve；
- stop / close 后释放 Build、再次 submit；
- Scope 关闭时仍有 active call；
- SSE 客户端不读取时的积压上限；
- A/B 两个测试 fixture 同时启动。

最后运行：

```bash
bun run server:check
bun run check
```

本次评审没有把全量 `server:check` 宣称为通过：并行 worktree 下出现了固定端口冲突、连接重置和超时。它正好说明 P2-13 需要先统一处理。报告任何后续结果时，都应区分“窄测试通过”“全量通过”和“当前环境无法证明”。

## 结论

这个仓库不缺 Effect 的形式，缺的是少数关键边界的完整语义。最值得修的不是增加更多 `Effect.gen`、更多 Layer 或更多统一封装，而是：

- 让 SQL 错误继续是错误，不变成空结果；
- 让 spawn、输入、语音和探测在中断时都有 owner 收尾；
- 让 defect 仍是 defect，业务拒绝仍是业务拒绝；
- 让取消真正到达底层 I/O；
- 让外部数据先经 Schema，再进入业务；
- 让慢消费者、跨午夜和并发测试都能被确定验证。

按这个顺序做，Effect 才会从“写在代码里的类型”变成真正可依赖的错误、资源和并发模型。

---

## 落地结果：15 项都归到各自的拥有者

改造没有引入通用 workflow、资源管理框架或新的服务层。每一项只改变拥有错误、取消或资源的那一处；HTTP 的成功响应形状、DAG 调度和 Core 单源模型不变。

| 项 | 实际实现 | 直接验证 |
|---|---|---|
| P0-01 | `base/db.ts` 的 `optional` 只捕获 `NoSuchElementError`；六个业务模块不再用 `Effect.option` 吞 SQL / Schema 失败 | `base/db.test.ts` 分别注入空行、SqlError、SchemaError |
| P0-02 | `Sessions.send` 用 `Opening` 记录所有权，`Effect.onExit` 覆盖 typed failure、defect 和中断；清理幂等且不可中断，attach 接管后才发布 `hired` | `session/session.test.ts` 的 deferred spawn、hiring 中断、重试和 defect 用例 |
| P0-03 | `AgentHost` 给输入记 generation 和 pending record；stop 使旧代际失效，close 等 starting 和 inputs 落定后关闭 Brain、事件与执行 | `session/host.test.ts` 的 deferred Build、stop、close、再次 submit |
| P0-04 | Voice 用 `StartingCall` 和共享幂等 cleanup 管理启动，活跃通话与后台播报归服务作用域；迟到资源也要停止 | `voice/voice.test.ts` 的 openLine / session.start 中断、Scope 关闭、deferred brief |
| P0-05 | Runtime 的后台探测经 `FiberSet` 和 `tryPromise`；失败可重试，旧失败不清新读取，关闭后不再写缓存或发事件 | `runtime/runtime.test.ts` 的 rejection、连续 list、deferred probe 与 Scope 关闭 |
| P1-06 | 删除 Issue、Task、Sessions 三处整段 `catchDefect`；`Effect.result` 只处理 typed failure | 三个模块分别断言 `Effect.die` 仍是 defect，已知拒绝不变 |
| P1-07 | `AgentExecution` 的状态修改进入 `Effect.fn` 的执行体；未运行的 `close()` 没有副作用 | `session/execution.test.ts` 的 before-run 与实际关闭用例 |
| P1-08 | 听写把 Effect 的 `AbortSignal` 与 120 秒超时经 `AbortSignal.any` 传给 fetch | `voice/voice.test.ts` 中断 pending fetch 并检查 signal |
| P1-09 | QQ 用 Schema 解码 envelope、心跳和消息数据，串行 Promise 链以 `catch(end)` 收尾 | `connector/qq.test.ts` 的 null、数组、坏心跳及后续合法帧 |
| P1-10 | OpenAI 入口在调用 answerer 前解码嵌套请求，坏输入返回原协议形状的 400 | `agent/brain/openai.test.ts` 覆盖 stream / 非 stream、null part、错误字段类型 |
| P2-11 | 对外 events / live 有界发布，states 有界合并；内部派生事实另走订阅，Core 串行提交，oar 回调进入受管运行时 | `core/core.test.ts` 的慢读者，`session/session.test.ts` 的真实 oar 慢读者 |
| P2-12 | `Caller.words` 每轮等待用 `finally` 移除 abort listener | `session/host.test.ts` 的正常结束、提前 return、abort |
| P2-13 | `testConfig` 默认把主 HTTP、LAN、语音线路端口设为 0，覆盖仍最后生效 | `lan/lan.test.ts` 同时启动两个完整 app fixture |
| P2-14 | `RuntimeOptions.now` 统一驱动存档日期、记账和预算；测试推进同一个本地时钟跨日 | `runtime/runtime.test.ts` 的昨日存档与跨日预算 |
| P3-15 | `AgentExecution` 的 begin、finish、observe、failedStart、close 都用 `Effect.fn({ self: this })` | 类型检查与执行规则回归 |

### 背压不能只换 PubSub 的类型

实现 P2-11 时发现两个不能靠机械替换解决的问题：

1. `Core.apply` 一旦可能等待，原来给 oar 回调用的 `Effect.runSync` 就不能继续用。现在 oar 事件、汇报和没动静按到达顺序进入 Sessions 自己的 `FiberSet` 运行时，不用无监督的裸 Promise，也不在慢读者面前抛掉事实。
2. 账本等消费者会在处理一条事实时施加下一条。如果内部订阅和外部 SSE 共用有界通道，发布者等消费者取走，消费者又等下一次 `apply`，会形成循环等待。现在内部订阅与对外通道分开：内部派生事实不被这个环卡死，真正的 HTTP 出口仍有容量上限。

`Core.apply` 和旁路事件共用一把锁，覆盖折叠、提交与发布，防止一个生产者等待时另一个生产者抢先发出后续事实。`/events` 和 `/live` 的容量是 64；`/state` 的变化容量是 32，输出队列容量为 1 且使用 `suspend`，每个合并窗口最多再取 32 条。发布不靠 `publishUnsafe` 静默丢消息，也不以强制断开代替背压。

### 两处不照搬文字建议的地方

- P2-14 的同步读取发生在 `list` 和 Promise 回调边界，不适合为了测试强行改成完整的 Effect Clock 流程。注入 `now` 让生产与测试使用同一套本地日历规则，比给接口增加无关的异步上下文更直接。
- P0-02 的 `hired` 发布会等待背压，不能再放在 attach 之前的同步提交段。现在先接好 hands 和事件监听，再发布事实；只有提交成功才转移启动清理，尚未提交就取消时全部释放，已经提交后归正常 Session 生命周期。

### 二次审查：同类边界再收紧

两路独立审查又验证了取消与错误交错时的路径，以下问题已经修复并有直接测试：

| 问题 | 修复与证明 |
|---|---|
| `Core.apply` 在背压中被中断会半提交 | 取得发布锁后，状态替换与全部通道发布进入不可中断临界区；Core 关闭时关闭有界通道，唤醒等待者。`core/core.test.ts` 在慢读者前中断发布，断言 `/events`、内部订阅和 `Transition` 都按序完整到达 |
| `attached` 被误当成 `hired` 已提交 | `cleanupOpening` 只在事实已提交时跳过清理，未提交时连监听一起释放。`session/session.test.ts` 用另一条占住发布锁的提交复现，断言 dispose、令牌、工作区和容量全部归还 |
| 第一个语音启动方未拿钥匙就取消，隧道无 owner | 线路钥匙在等共享隧道前登记，失败路径同样进入闲置关闭。`voice/voice.test.ts` 在服务仍运行时先确认隧道关闭，再重试 |
| Host 启动失败登记越过 close，Caller 空等待中 `return()` 不醒来 | 失败 run 进入 close 等待的串行链；iterator 的 `return()` 先结束并唤醒等待，且支持异步释放。`session/host.test.ts` 与 `execution.test.ts` 覆盖这两条竞争 |
| 自动调度保存 defect 后，已派 Session 继续运行 | `recurrence` 用 `Exit` 覆盖 typed failure、defect 和中断，先收回 Session，再传播原 `Cause`。`task/task.test.ts` 真正经过 resume、hire 和 `working` 保存失败 |
| 账号读取失败仍被兜成空游标 | 删除 `catch(() => undefined)`，只有 `Option.none` 是空游标，读取失败进入重连。`connector/connector.test.ts` 证明适配器没有收到空游标 |
| 旧用量整份覆盖新探测，晚到结果在关闭后写入 | 用量返回时核对自己开始时的缓存身份，旧快照直接丢弃；所有缓存写入统一拒绝关闭后的结果。`runtime/runtime.test.ts` 覆盖两种交错 |
| 心跳间隔溢出成 1 ms 定时器 | `op`、序号用整数 Schema，心跳限制为 `0–2_147_483_647` 毫秒。`connector/qq.test.ts` 覆盖原始文本 `1e400` 和 `2147483648` |
| 双 app 测试启动生产探测 | 测试显式关闭后台农机探测和模型监听，GitHub 使用 `noGitHub`，只验证两个隔离 app 的监听与关闭 |

### 现行文档与验证边界

长期行为分别沉淀在[地基](docs/subsystems/foundation.md)、[核心状态](docs/subsystems/core.md)、[帮工](docs/subsystems/session.md)、[档案和农机](docs/subsystems/agent.md)、[管家](docs/subsystems/orchestrator.md)、[语音](docs/subsystems/voice.md)、[田头](docs/subsystems/channel.md)、[工单](docs/subsystems/issue.md)和[计划](docs/subsystems/task.md)。本文保留评审依据和实现对应关系，不作为第二份行为手册。

没有连接真实 Agora、QQ 或 DeepSeek，没有运行付费的 orchestrator evals，也没有做生产内存压测。测试中的外部服务均为本地替身；背压测试证明容量、等待、顺序和恢复后的最新状态，不证明所有生产负载下的内存曲线。

有界 `PubSub` 不等于整个数据面都有界：慢 SSE 时，oar 回调的 Promise 链和轨迹 fiber 仍可能累积，一个长期不读的 SSE 客户端也能让 Core 生产者队头等待。这是当前显式设计代价，不写成已经解决。不可取消的 SDK Promise（spawn、Build、部分 Voice 清理）只能由 owner 等它结束再收尾；没有底层取消能力时，不假装资源已经释放。

## 最终验证记录

| 检查 | 实际结果 |
|---|---|
| `bun run check` | 566 个文件格式正确，lint 和类型无错误；只有 memory 测试的 3 条既有 warning |
| `bun run server:check` | 74 个测试文件通过，605 个测试通过，1 个真实模型评测按条件跳过 |
| `bun run web:check` | 各包类型检查通过；host 4 个、mobile 19 个测试通过；页面构建成功 |
| `bun run docs:verify`、`bun test scripts/doc-links.test.ts` | 85 个 Markdown 文件的链接、旧名字、目录和生成物检查通过；文档链接测试 2/2 |
| `verify-server --scripted-helper` | 派活、交回、试跑完成、完成均成功；`status: done`、`delivered: merged`，主分支最新提交 `89d5a96 加上打卡` |
| 真实 `/v1/chat/completions` | `messages: [null]` 返回 400，`type: invalid_request_error`、`code: invalid_json`；在回答器之前拒绝 |

真实工单验收的证据目录是 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-iGLrPL`，OpenAI 边界的是 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-FjCiWX`。两份 `ready.json`、`health.json`、`result.json` 均证明服务就绪、健康检查成功、`code: 0`、`stopped: true` 且没有清理错误；服务端日志没有错误。

两路独立审查先检查了实现与测试，修复后再次复核，确认原子提交、启动清理、隧道、Host、游标和测试夹具的复现路径均闭合。没有连接真实 Agora、QQ 或 DeepSeek，没有运行付费评测，也没有做生产内存压测。
