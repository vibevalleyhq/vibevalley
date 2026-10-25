# VibeValley 的 Effect 地道性审查：错误、取消与资源所有权

这次从 `main` 的 `59ad8eb3d4ca620632ce5995a4e0d7b0c137b702` 切出 `v4-k31-no-extra-skill`，使用仓库的 `effect-ts` skill，完整阅读本机 `effect@4.0.5` 的 `AGENTS.md`，并对照同一份安装里的示例和源码审查当前工作树。没有读取其他 PR、其他分支或外部资料。

按问题主题归并，本文记录 **26 类改进空间，全部已在这个分支落实**。第 26 类是落实过程中继续扫描执行恢复和第三方适配器时新增的，不与已经修复的持久化 JSON 重复计数。主题数不是 bug 数：一个主题可以有多个代码站点，一个 helper 又可能影响几十个调用点。每个主题下面单独给出站点和影响范围，避免把 `Effect.gen` 的出现次数误当成缺陷数。

最重要的结论不是「Effect 用得不够多」，而是：**几处 Promise 交界把 Effect 已经能表达的错误、取消和资源所有权绕掉了。** 改成更多 `Effect.gen` 并不能修这些问题。反过来，仓库里大量服务 `make`、内联 `Effect.gen`、`FiberSet`、`Effect.runSync` 和 Promise 适配本来就写得对，不应为了形式统一而重写。

## 1. 审查口径

### 1.1 三种计数单位

- **问题主题**：同一种错误机制归成一类，例如「SQL 可选行吞掉数据库错误」。
- **具体站点**：实际需要修改或需要单独评估的代码位置，例如 10 个 SQL 包装点。
- **调用影响**：一个包装点向下影响多少业务调用。`issue` 和 `channel` 的两个 `one(...)` helper 覆盖 39 个调用点（8 + 31），不等于 39 个独立缺陷。

「还有多少地方」因此不能只报一个数字。本文的 26 类是可执行的清单；每类的站点数在标题或正文里单列。纯风格候选另算，不与高严重度问题混排。

### 1.2 判定标准

一个问题只有满足至少一条才计入实质改进：

1. 改变 typed failure、defect、interruption 的语义，造成错误结果或错误恢复。
2. 资源在失败、取消、迟到 Promise、Scope 关闭后失去 owner。
3. 不可信输入绕过 Schema，持久化或线上形状进入业务后才偶然爆炸。
4. 慢消费者、监听器、定时器或共享代次造成实际积压、覆盖或泄漏。
5. Effect 的值语义被误用，工作发生在 Effect 尚未运行时。
6. 明确违反本机指南且有可维护性收益的写法，例如只包装 `Effect.gen` 的可复用函数。

以下不机械计入：`Date.now`、`JSON.parse`、Promise、`try/catch`、`Effect.option`、`Effect.catch`、无界 `PubSub` 的出现本身。它们必须结合具体语义判断。

### 1.3 严重度

- **高**：错误交付、丢消息、错误覆盖密钥、失控写入、资源或内存持续增长。
- **中**：取消后仍产生副作用、启动关闭不一致、错误响应或无法确定重试。
- **低**：可测试性、可观测性、编译期安全网和纯风格问题。

## 2. 已经写得地道、不要机械重写的部分

### 2.1 服务 `make = Effect.gen` 不是指南反对的包装

指南反对的是「可复用函数只包一层 `Effect.gen`」，不是服务构造本身。`make` 需要 `yield*` 依赖、建立锁、订阅和 finalizer，是标准的内联 Effect 程序。`handlers.ts` 的转发 lambda、Stream 里的短回调也不需要改名成 `Effect.fn`。

### 2.2 Promise 不是反模式

oar、pi-agent-core、MCP SDK、Agora、Node HTTP 和连接器都 expose Promise 或回调。`Effect.promise`、`Effect.tryPromise`、`Effect.callback` 正是这些边界的桥。真正需要修的是取消信号、清理和迟到结果，不是把库表面全部换成 Effect。

### 2.3 `FiberSet` / `FiberMap` 已经是 owner

 Sessions、Runtimes、connector 和 LAN 用它们承接回调纤程，作用域结束会统一收掉。Core 的防抖落盘用 `FiberMap` 也合理。 Voice drain 的问题是它从这套所有权里跳出去了，不证明这套 API 用错了。

### 2.4 `Effect.runSync(core.apply(...))` 有明确边界

oar 的同步事件回调需要按顺序折事实，Core 的 apply 又是同步提交。这里的 `runSync` 比在回调里新建一个 `ManagedRuntime` 更合适。把 Core 改成异步背压时必须重新审查这个边界，不能只改发布端。

### 2.5 `Effect.result` 比 `Effect.exit` 更适合预期失败

仓库已有不少正确使用：`result` 只接管 typed failure，defect 和 interruption 保持原义。`Effect.exit` 会把完整 `Cause` 包起来，不适合把「所有失败都当普通业务失败」的恢复路径。

### 2.6 降级不都是吞错

记性召回、辅助历史、模型工具的文本错误都有明确的业务契约。该降级时保留错误日志并继续，是正确的。宽 `catch` 是否应删，要看它是在兑现契约，还是把关键数据库故障伪装成正常值。

### 2.7 `Date.now` 和 `DateTime` 不应一刀切替换

持久化时间戳、已注入的 `now`、本地日期、Cron 接受 `Date` 都有正当理由。需要改的是 TestClock 已能推进 `Effect.sleep`，却无法推进同一逻辑里的墙钟读取这种不一致。

### 2.8 不需要把 `ApiError` 全换成 `Schema.TaggedError`

`ApiError` 是 protocol 的联合和 HTTP 契约，已有 `_tag` 与状态码。`ProjectError`、`MergeFailure` 等内部错误也已有 tagged error。真正缺 Schema 的是外部 JSON 边界，不是每个内部错误类。

## 3. 本分支已落实的 26 类

## 3.1 SQL 可选行不再把数据库故障当成「没有这一行」

**站点：10 个包装点；其中两个 helper 影响 39 个调用点。**

涉及 `issue/issue.ts`、`channel/chat.ts`、`doc/doc.ts`、`session/session.ts`、`connector/connector.ts`、`lan/lan.ts`。

`SqlSchema.findOne` 的失败联合包括 `NoSuchElementError`、`SqlError` 和 `SchemaError`。原代码：

```ts
Effect.map(db(Effect.option(query)), Option.getOrUndefined)
```

`Effect.option` 会把三种 typed failure 都变成 `None`。外层的 `orDie` 此时已经看不到 SQL 错误。于是数据库故障可能被答成 404，频道去重、文档批次重放、连接器游标也可能在错误前提交下一步。

现在只捕获真正的无行：

```ts
Effect.map(db(Effect.catchNoSuchElement(query)), Option.getOrUndefined)
```

`SqlError` 和 `SchemaError` 继续按各模块原有策略成为 defect。生成的 SQL 文件没有手改。`project` 对 `realPath` 的 best-effort optional 和工单对领域 `Missing` 的 optional 保留，它们不是同一问题。

**验证**：`issue.test.ts` 用真实库先证明无行是 `Missing`，再把 `issue` 表改名，证明读取失败进入 defect。全部 SQL 相关的现有测试继续通过。

## 3.2 Git 故障不再被完成成「0 个提交、无改动交付」

**站点：`Projects.branchChanges` 及工单完成、重开两个调用方，另同步 Task 的内部形状。**

原来的 `Effect.option(projects.branchChanges(...))` 把分支不存在和 Git 命令失败都吃掉。损坏的仓库会被读成 0 个提交，`delivery` 随之选 `none`，工单可能在没有尝试合并的情况下完成。

现在 Project 先执行 `show-ref`：

- 返回 1：分支确实不存在，结果是 `undefined`。
- 其他非零：Git 故障，保留 `ProjectError`。
- 分支存在：继续读取提交和 diff。

工单完成和重开把 `ProjectError` 映射成 `Refused`。Task 对 `undefined` 给出「分支不在了」的独立拒绝，不把两种结果混起来。

**验证**：有真实提交后隐去 `.git`，`previewStatus` 和 `setStatus(..., "done")` 都拒绝，工单保持 `in_review`，`delivered` 仍为空。直接项目工作、无分支可合和正常合并的现有用例不受影响。

## 3.3 `state.json` 和 `settings.json` 都按 Schema 恢复

**站点：`core/core.ts`、`setting/setting.ts`。**

合法 JSON 不等于合法形状。`{"sessions":{}}` 或 `{"memorySources":{}}` 以前能越过 `JSON.parse`，直到更晚的业务遍历才失败。

Core 复用 protocol 的 `WorkspaceState` 和 `base/json.ts` 的 `jsonOf`。读取、JSON 解析或 Schema 校验失败都走既有的「记日志，从空状态恢复」。

Setting 新增与真实持久化形状一致的 `Stored` 和 `MemorySourceConfig` Schema。这里选择了和 Core 不同的恢复策略，因为后果不同：

- 文件不存在：从空设置开始。
- 读取、解析或形状失败：Layer 构建失败，原文件不动。

一次暂时性读取故障不再被解释成空设置，也不会在下一次保存时把钥匙整份覆盖掉。

**验证**：Core 覆盖「合法 JSON、错误形状」；Setting 覆盖坏 JSON 和错误形状，断言启动失败且文件字节不变。

## 3.4 OpenAI 请求和听写响应都在边界解码

**站点：`agent/brain/openai.ts`、`voice/voice.ts`。**

`chat/completions` 现在用 Schema 验证 `model`、`stream`、`messages` 和 content parts。`messages: {}`、数组成员为 `null`、数字 content、`stream: "false"`、非字符串 model 都返回 OpenAI 形状的 400，answerer 不会被调用。

听写响应用 `Schema.fromJsonString` 解码。非 2xx 仍保留服务端状态和错误说明；2xx 但 `text` 是数字、根值是数组或形状不符时返回 typed `VoiceUnavailable`，不再产生 `.trim()` defect 或空文本假成功。

**验证**：OpenAI 的畸形请求用例直接走 `chatCompletions`；听写用本机 HTTP 服务走真实 `Voice.dictate`，覆盖两类坏响应、正常文本和非 2xx。

## 3.5 HTTP 边界恢复错误、Schema 和中断语义

**站点：`http/api.ts` 的四个独立问题。**

1. 成功响应和 `ApiError` 改用 `HttpServerResponse.schemaJson`，不再用 `jsonUnsafe`。handler 返回违反契约的成功值会成为 500，而不是发给客户端一个错误的 2xx。
2. `request.text` 的 typed error 不再被 `orElseSucceed("")` 伪装成空 JSON。
3. `catchCause` 先检查 `Cause.hasInterrupts`，中断沿原 `Cause` 返回，不再被拼成 500。
4. 数字 query 与 path 一样要求 `Number.isSafeInteger`，不再把超大整数舍入或把 Infinity 交给数据库。

**验证**：新增 `http/api.test.ts`，用 Effect 的 `HttpRouter.toWebHandler` 发真实内存请求。合法响应为 200，错误成功形状为 500，中断由平台映射为 503 空响应，溢出 query 不进入 handler。

## 3.6 定时校验和失败通道各自归位

**站点：`packages/protocol/src/schema.ts`、`recurrence/rules.ts`、`recurrence/recurrence.ts`。**

每周的 `days` 现在同时由协议 Schema 和服务规则限制为 0–6 的整数，`1.5` 不会再进入 Core 和数据库后让 `Cron.make` 抛 `RangeError`。

`tick` 不再对已经 `orDie` 的写入使用 `Effect.exit`。它直接在 SQL client 上 `Effect.result`，只接管预期的 typed SQL 失败；defect 和 interruption 不再被当成「这次没写上，下回再说」。

**验证**：小数 weekday 被 Schema 和服务拒绝，0 和 6 正常工作；原有的「写失败不发布，下一 tick 重试」用例继续通过。

## 3.7 Effect 的副作用推迟到真正运行时

**站点：`session/execution.ts`、`core/core.ts`。**

`AgentExecution.close()` 原来在构造 Effect 时就写 `closed`、`outcome` 和 `summary`。现在由 `Effect.suspend` 包住整个判断和变更。构造 close 后再消费输入仍是合法的，执行 close 才封口。

`Core.open()` 也改为执行时读取 `state.call`，保存的 Effect 不会因构造时是 live 而在稍后错误地空跑。`sessionEvent`、`notice`、`runtime` 的时间戳同样推迟到执行时。

**验证**：`execution.test.ts` 证明 close 未运行时还能接受输入；`core.test.ts` 证明 live 时构造的 open，在状态变回 idle 后执行会重新打开。

## 3.8 Session 的 spawn、attach、worktree 和令牌共享退出清理

**站点：`session/session.ts` 的 `open` 和 `send`。**

资源窗口有两段：

1. allocation 已登记，spawn 尚未返回。
2. spawn 已返回，工单关联、日志登记和 attach 尚未提交。

`open` 在非成功退出时复用 `stopOar`。`send` 另有一层退出清理：停止失败就保留 allocation 和工作区，避免第二个 writer；确认停止后才释放 worktree 和令牌。正常业务拒绝仍走原来的 `failedOpening` 和 `refuseStart`，成功提交则把 owner 交给正常 Session 生命周期。

底层 spawn 不支持 AbortSignal，不能虚构取消。`Subagents.close()` 负责等待 in-flight spawn 并销毁迟到会话。最终 attach 段不可中断，避免「已经挂上 hired 又被回滚」。

**验证**：deferred 卡住 runtime.session，先 fork 中断，再放行 spawn。测试断言迟到会话被 dispose、容量可再用、同工单 worktree 可重新派发。这个顺序也证明测试本身不会因等待 finalizer 自锁。

## 3.9 Caller、Brain、工具和 MCP 不再在预取消后开始工作

**站点：`session/host.ts`、`agent/brain/{agent,tool,coding,mcp}.ts`。**

- `Caller.words` 在 push、end、abort 每条路径都移除 listener，预取消 signal 不新增等待。
- `Brain.ask` 预取消直接拒绝；运行中取消只移除自己的 waiter 和 listener，不取消其他调用者共享的 run。
- `textTool` 在 `spec.run` 前检查，`runCommand` 在 spawn 前检查，`connectMcp` 在创建 transport 前检查。
- MCP timeout 在 timer、abort、底层 Promise settle 后统一清 timer 和 listener。
- `Brain.start` 接收并传递 signal；启动结束后若已取消会关闭连接，构造失败也关闭已连接的 MCP。

**验证**：Caller 用同一 signal 跑 20 轮并计数 listener；Brain 和 textTool 的预取消测试断言模型请求数、工具执行数都为 0。

## 3.10 Voice 的启动失败、取消和迟到资源都有 owner

**站点：`voice/voice.ts` 的 listener、tunnel、openLine 和 `Voice.start`。**

原来的 `tapError` 只处理 typed failure，不处理 defect 和 interruption。现在 `onError` 覆盖所有非成功退出：

- 已建立的线路释放；尚未完成的 `openLine` 在迟到成功后关闭。
- 启动中的 Agora Promise 保存下来，迟到返回 agent id 后立即 `stopAgent`，清理错误只记录，不覆盖原中断。
- 服务停止后才完成的 tunnel 立即 close，不再挂回已关闭的 Voice。
- listener finalizer 提前注册，迟到 listen 回调看到 stopped 会主动关闭。
- `openLine` 等待隧道后再次检查 stopped，不在关闭后新增钥匙。

**验证**：假 Agora 的 `/join` 先挂起，中断后再返回 `agent_id`，断言 `/leave` 真正发出、线路归零、授予不卡在 starting。现有启动、挂断、凭据快照和通知流程全部通过。真实 Agora 不在自动测试边界内。

## 3.11 LAN 转发有背压，关闭监听可等待

**站点：`lan/lan.ts` 的 `forward`、`shut`、`setOpen` 和 finalizer。**

`res.write()` 返回 false 时继续读上游，会把慢设备的压力变成服务端缓冲。现在用 `Readable.fromWeb` 和 Node `pipeline` 连接上游 body 与下游响应，同时传入请求的 AbortSignal。

`shut` 返回 Promise，等待 `server.close` 回调。`setOpen(false)` 和 Layer finalizer 都等待它，固定端口可以立即重开。

**验证**：`lan.test.ts` 保留配对、权限和 SSE 用例，并新增同一固定端口连续三次开—关—立即重开。

## 3.12 connector 的等待有统一清理，outbox 不丢唤醒

**站点：`connector/wait.ts`、三个客户端和 `connector.ts` 的 outbox、inbox、generation。**

`waitFor` 统一返回 `timeout / wake / aborted`，任一路径结束都清 timer 和 abort listener。三份本地 sleep 改为复用它。飞书和 QQ 的 listen 在正常 end 时也移除 listener；generation 结束时移除服务级 life listener。

outbox 增加 dirty 标记。发送期间新来的消息先置脏，当前 drain 结束后立即再查，不再因为 `wakeOutbox` 当时为空就多等一个完整退避周期。

**验证**：`wait.test.ts` 对同一 signal 连续执行 20 次 timeout、20 次 wake 和一次 abort，存活 listener 始终为 0。connector 的收件、引用、重试和重启用例继续通过。

## 3.13 connector 的游标和接收退出不再伪装或跳过清理

**站点：`connector/connector.ts` 的 `receive` 和 `receiving`。**

游标读取只把 `NoSuchElementError` 当成空游标，数据库故障进入现有退避，不再 `.catch(() => undefined)` 后伪装首次连接。

adapter 抛出异常时也通过 `try/finally` 封存后续 accept 并等待已经接受的写入。接收失败被翻成 `Failure`，进入已有的 2 秒/30 秒退避，而不是结束整代任务。

## 3.14 可复用 Effect 函数改成真正的 `Effect.fnUntraced`

**站点：`session/session.ts` 两个，`memory/memories.ts` 五个；`Projects.branchChanges` 也直接以 `Effect.fn` 定义。**

`failedOpening`、`open`、`insertNote`、`matches`、`recallable`、`listed`、`write` 不再只是返回 `Effect.gen`。锁和错误降级仍作为函数组合保留，没有为了换写法改变行为。

这次还验证了一个容易写错的细节：`Effect.fn` 的后续 combinator 接收「上一步 Effect 和原函数参数」。把日志组合移出 generator 后，应写：

```ts
(effect, agent) => effect.pipe(Effect.catch(...))
```

不能继续假设它还在原函数的闭包里。类型检查和 memory 测试都覆盖了这条路径。

没有转换服务 `make`、内联回调、HTTP 转发或 Promise 适配。类方法是否改用带 `this` 的 `Effect.fn` 形式，应按本地 API 的 `this` 约束逐个判断，不做全局正则替换。

## 3.15 Predicate 和封闭联合都由编译器帮忙

**站点：`runtime/dsh.ts`、`core/core.ts`、`voice/voice.ts`。**

`dsh` 的 records 改用 `Predicate.isObject`，不再自写等价的 object guard。

`Core.isFact` 对四种非 Fact 显式分支，default 中用 `satisfies Fact` 保证新增非 Fact 成员会编译失败。Voice 的三个 vendor switch 在 default 中保留运行时提示，同时用 `never` 赋值做编译期穷尽检查。

未知 vendor 的现有运行时测试仍返回同样的中文提示；以后协议加成员而实现漏掉时，则先由 `tsc` 拦住。

## 3.16 connector 的外部帧、引用和 pause 都有明确失败去向

**站点：`connector/weixin.ts`、`connector/qq.ts`、`connector/connector.ts`。**

微信的 `Item`、`Message`、`Updates` 由 `Schema.Codec<T>` 绑定，`ref_msg.message_item` 用 `Schema.suspend` 保留递归形状。adapter 在读取 `msgs` 前先解码，`msgs: {}` 这样的合法 JSON 直接进入 `Failure`，不会到 `.filter` 才炸成意外异常。

QQ 的 token 响应、gateway 地址和事件帧也由 Schema 解码。`null`、错误 `op` 类型和无 URL 都走明确错误；现有 op 分支和 chain 末端 `catch(end)` 保持。

引用查询失败不再退成「没有引用」：inbound 保持 pending，只有成功交付才写完成标记，不会错投到当前频道。`pause` 把写入和 reload 的结果返回给调用方，stale pause 或解除 pause 失败时等待 `min(30s, retryMost)`，不再吞错后紧密重试。outbox 继续按原有退避发送。

**验证**：递归微信消息正常解码，畸形 updates 不交付，QQ `null` 和错误 `op` 被拒绝。真实库故障下，引用消息先不投递、恢复后成功；pause 写失败在短窗口内没有密集 poll，退避结束后恢复。

## 3.17 full probe 与 usage probe 不再互相覆盖

**站点：`runtime/runtime.ts` 的 `reads`、`refreshUsage`。**

完整探测继续按 read 序号淘汰旧结果，但 usage 不再占用 full 的序号。usage 开始时保留当前 `Observation`，返回后重新读取 cache，只有对象身份仍相同才合并 `usage` 和 `checkedAt`，并使用 `before.read`。完整探测已换掉、另一份额度更新已落地或服务已关闭时，旧结果直接丢弃。

因此，usage 先完成不会用更大的序号挤掉后续 full；full 先完成也不会让旧 usage 把 installation、models、settings 写回去。`withSpend` 仍在发布时计算最新花费。

**验证**：`runtime/runtime.test.ts` 建立 old full → new full 与一次变化的 usage 交错，分别让 full 和 usage 先完成。两种顺序最终都保留 new installation 和 new full 自己的 usage；原有「慢旧 full 不覆盖新 full」与「usage 使用 accepted installation」用例继续通过。

## 3.18 Brain 与 AgentHost 的关闭有了明确的代际和等待边界

**站点：`agent/brain/agent.ts`、`session/host.ts`。**

`Brain.close` 现在 memoize 实际清理 Promise，并在创建 Promise 时同步 abort 新工作。并发调用和重入调用都等同一份清理结果，不再由第二次调用提前返回。

`AgentHost` 把 start、Build、deliver 放进同一条输入串行链。close 先设置 closing、取消启动，再等待这条链，随后关闭 Brain、events 和 execution。`start` 把 signal 传给 `Brain.start`，如果关闭已经开始，会关闭刚创建的 Brain。`resume` 也走同一串行链和 closing 检查。

关闭中的输入只结束 caller 并返回 `{ ok: false, run: "" }`，不记新的 failed run；普通启动失败仍保留原来的 failedStart 记录。重复 close 共享结果。

**验证**：Brain 的 `waitForIdle` 被 deferred 卡住时，两次 close 是同一个 Promise，放行前都不完成。真实 AgentHost 在 Build 期间 close 会等待放行；迟到文本不 deliver，route 保持初始值，caller 正常结束。

## 3.19 外部 SSE 的慢订阅有界退出，内部事实不截断

**站点：新增 `core/bounded.ts`，接入 `http/streams.ts` 的三条 SSE；`core/core.ts` 关闭四个 PubSub。**

初版曾把容量 64 的 relay 接到 Core 的全部内部和外部流。全量测试随即发现它会切断 `core.subscribe`、`transitions` 等必须完整接收事实的内部订阅，导致引用回复等不到后续事实。这个失败不能当作超时忽略：内部订阅没有从快照补齐的协议，明确结束也意味着永久漏事。

现在只给 `http/streams.ts` 的 StateFrame、SideEvent、LiveEvent 三条外部 SSE 加容量 64 的订阅级 relay。正常读取保留原顺序；队列溢出时记一条 `slow subscription closed`，shutdown 该连接的 Queue，源订阅和整个流随之结束。客户端用既有的重连与快照机制恢复，而不是消费一份缺帧的状态。内部的 `transitions`、`subscribe`、`facts`、`owner` 不用会断开的 relay，不能把容量上限伪装成可靠交付。

源正常结束时先 `Queue.end` 排空已经入队的值，不截断尾帧；溢出则不继续接收。Core Scope finalizer shutdown 四个 PubSub，显式收掉所有订阅。`states` 在 HTTP 边界经过同一 relay，不用 sliding 合并可能携带 effects 的帧。

`Core.apply` 仍是同步提交，oar 回调中的 `Effect.runSync(core.apply(...))` 保持不变；断开策略只在可重连的 HTTP 边界处理，没有把同步事实折叠改成异步。测试用 `TestClock.adjust` 等待订阅建立，不依赖真实墙钟等待。

**验证**：初版 8 个定向测试通过，但完整测试暴露了上述内部订阅问题；因此增加 128 条事实、每条处理有等待的内部订阅回归测试，再重跑 connector 和全量检查。真实服务端证据见第 6 节。

## 3.20 Voice drain 收回 Effect 生命周期，挂断不再继续念后面的段

**站点：`voice/voice.ts` 的 `tell`、`drain`、`speakOn`，`orchestrator/orchestrator.ts` 的 `brief`，以及 `session/host.ts` 的 `Caller`。**

原来 `void drain()` 让等待、brief 和播报跳出 Effect 所有权。现在 drain 由 Voice 服务作用域的 `FiberSet` 启动，聚合等待使用 `Effect.sleep`；启动前同步置 `telling`，保证同时只有一轮。`ensuring` 无论成功、typed failure 还是中断都重置队列标记。真正的 brief 异常记一条日志并结束这一轮，不盲目重发管家可能已经收到的输入；下一条通知可以开启新一轮。空回答仍保留原来的最多三次重试。

每通电话有一个 `AbortController`。drain 把当前纤程的 signal 和电话的 signal 合成后传给 `Orchestrator.brief`；挂断立即 abort，Voice 关闭也 abort 所有电话并中断 FiberSet。`brief` 在预取消时不提交新输入，运行中取消只结束自己的 Caller listener，不取消其他回答共享的 run。提交链失败经 `Caller.fail` 拒绝等待者，不再成为 detached Promise 的未处理 rejection；listener 在成功、失败和取消后都移除。

`say` 自身没有 AbortSignal，所以不虚构「已发出的 HTTP 请求被取消」。`speakOn` 改成 Effect 循环，在每段前检查服务未停、电话未挂断且 map 里仍是同一会话。正在等待的那段可以按 SDK 的能力完成，但挂断后不会再发下一段。

**验证**：Voice 新增 brief 拒绝后可继续、brief 未完成时关闭作用域、分段播报中挂断三个用例；Orchestrator 增加预取消 brief 不启动模型请求的用例。`voice`、`orchestrator`、`session/host` 和 `agent/brain/agent` 四个文件共 68 个测试通过，服务端 `tsc --noEmit` 通过。这里证明的是本地服务与假 Agora 的取消接线，没有宣称真实 Agora 已验证。

## 3.21 其余持久化与外部 JSON 按归属解码

**站点：`agent/agent.ts`、`runtime/runtime.ts`、`recurrence/recurrence.ts`、`channel/chat.ts`、`task/task.ts`、`game/game.ts`、`memory/nowledge.ts`，以及 `packages/protocol/src/schema.ts` 的花费和账本数值。**

这些地方没有套用一个「坏值都变空」的 helper，而是保留各自的失败后果：

- 档案配置的 `StoredSchema` 复用 protocol 的 Agent、Skill、RuntimeSettings。合法 JSON 但 `agents: {}` 与语法错误走同一条既有路径：原文件改名保留，从种子启动；改名失败则启动失败。没有覆盖原文件。测试最初还发现夹具绕开类型写了缺字段的档案；修的是夹具，让它和真实协议一致，不是放宽 Schema。
- `spend.json` 用局部 `SpentSchema`，金额必须是有限数。当前日期下 `1e999` 不能变成 Infinity 绕过预算，整份无效账从今天的空账开始，之后的新花费仍能累加。
- 定时的 `spec` 用 `RecurrenceWhen` 解码，`set_by` 用 `RecurrenceBy` 校验。坏 spec 的行不恢复，正常的下一行仍恢复；正常写入 `set_by` 还受数据库 check 约束，不能拿数据库错误充当 JSON 测试。
- 田头 Meta 新增局部 Schema，mentions、session、outcome、spent 等都有实际形状。整份坏 Meta 按原约定视为没有，不拿 `mentions: {}` 或错误花费继续拼接归属。
- 计划事件的 payload 只包含 session、detail、changes、commits 的可选形状，changes 复用 `TaskFieldChange`。坏 payload 不造出执行或改动，但保留这一行自己的 id、计划、kind 和 actor。
- 账本 payload 先解析成 unknown，要求是非数组对象，再由行的 kind、at 补齐后按 `LedgerEntry` 解码。形状不对或数值无限的行不参与折叠，正常行仍计入。protocol 的 Spent 和账本数值也改成 `Schema.Finite`，让相同约束同时存在于持久化和线上编码边界。
- Nowledge 的搜索结果必须是 `results` 数组，Hit 的 id、文本和有限分数逐字段验证；`memory_add` 的几种 id 形状和详情响应也解码。搜索响应畸形时按辅助读取失败记日志并降级，不抛程序员 defect；来源恢复后能再次返回结果。详情认不出范围仍是 unknown，不猜成全局。

**验证**：`agent`、`runtime`、`recurrence`、`channel`、`task`、`game`、`memory/outside` 和 `memory/providers` 八个测试文件共 103 个测试通过，覆盖合法 JSON 错误形状、Infinity、恢复和真实 PGlite 重启。全量测试和真实服务端证据见第 6 节。Nowledge 验证使用本机 MCP 假服务，没有冒充真实外部服务。

## 3.22 执行恢复数据与第三方适配器都有运行时形状

**站点：`session/session.ts`、`connector/connector.ts`、`runtime/pi.ts`、`memory/everos.ts`、`agent/brain/{config,taskStore,recurrences}.ts`、`connector/weixin.ts`。**

这是继续扫描时新增的第 26 类，不与上一批持久化 JSON 重复计数：

- Session 不再用泛型 `json<T>` 冒充证明。`runOf` 分别用 `RunTrigger`、字符串数组和 `Spent`；已离场 Session 的 `SessionGraph`、恢复现场的 `Workplace` 和 `recalled` 也各自解码。某个字段坏了只走那个字段的空值策略，坏工作目录仍按接不回来处理。
- connector 的 secrets 必须是字符串字典，Inbound 必须有字符串 id、from、text 和可选回复信息。形状错误或内外编号不一致的坏行记错误日志并结清，后续有效消息不再被堵住；正常投递失败仍按原规则重试，不在坏行 catch 里丢弃。
- pi 的 settings、DeepSeek auth/models 和余额响应都按局部 Schema 读。畸形本机配置回退，2xx 的 `balance_infos: {}` 回「没读到 DeepSeek 余额」，不再成为 `.map` defect。
- EverOS 的 episodes 和 agent_cases 逐字段解码，id 必须存在，score 必须有限。坏响应成为辅助来源的受控错误并降级，正常响应在同一项目内仍能返回。
- Brain 只在 MCP 文件不存在时返回空配置；文件读取、JSON 或形状失败都会报错。`agent_task.after` 必须是字符串数组，坏值只回退这个字段。`recurrences.json` 的 `Job` 逐项解码，`everyMinutes` 写成字符串不会经隐式转换错误触发任务，坏文件也不被覆盖。
- 微信的 `request` 必须拿到响应的 Schema。二维码、扫码状态、消息页和发消息结果分别解码；`message_id`、`msg_id`、`svr_id` 先把 64 位数字改成字符串再解析，超过 JavaScript 安全整数的 id 不丢精度。语法和形状错误成为 `WeixinError`，保留原来的超时、退避和登录包装。

**验证**：前四项六个文件共 74 个测试通过；Brain 五个文件共 68 个测试通过；微信与 connector 共 24 个测试通过。微信用本机 HTTP 服务覆盖完整扫码确认、错误二维码形状、发送的大整数 ID、错误 ID 形状和消息页坏形状后的恢复，没有连接真实微信。全量 605 个测试通过，真实服务端证据见第 6 节。

`session/journal.ts` 已经用 `SessionEvent` 解码，`session/rules.ts` 对回答逐字段检查，`http/api.ts` 在 JSON.parse 后有请求 Schema；这些不再误报为同类问题。

## 3.23 client 保留 HTTP 错误上下文，SSE 按 Schema 编码

**站点：`scripts/api-client.ts` 和生成的 `packages/protocol/src/client.ts`、`http/streams.ts`、`core/core.ts` 的重启状态构造。**

生成的 client 原来在检查 `res.ok` 前就 `JSON.parse`，所以纯文本 400/500 会变成 `SyntaxError`，HTTP 状态和原文都丢掉。现在先读原文，非 2xx 才容错解析：有效的 `ApiError` 保留 tag、reason、what 和 next；`VibeValleyApiError` 另有 `body`，原样保存响应文本，包括不是 JSON 的代理错误。结构不对的 error 不冒充有效 `ApiError`，但仍保留 tag（若它是字符串）、状态和原文。

这里有意不为成功响应引入 Effect Schema：生成 client 的既有约束是页面不带上每个接口的 Schema。服务端已经验证成功形状，client 成功时仍走普通 JSON.parse，坏成功 JSON 仍是 `SyntaxError`，不会与非 2xx 混淆。错误联合用一个小型、无运行时 Schema 依赖的结构校验，不把整套 Effect 拉进页面。

三条 SSE 改用 `Schema.encodeEffect(Schema.fromJsonString(...))` 编码 StateFrame、SideEvent、LiveEvent。SchemaError 经 `Effect.tapError` 记错误，流以失败结束；不再是 `JSON.stringify` 把错误形状发出去。测试还发现了旧 `JSON.stringify` 会省略、但 `Schema.optionalKey` 不接受的显式 `callReason: undefined`：重启状态现在省略该字段，真实首帧可通过编码，不是绕过 Schema。

**验证**：`packages/protocol/src/client.test.ts` 四个用例覆盖纯文本错误、真实 `Missing` 和 next、错误字段类型、成功 JSON；`http/streams.test.ts` 四个用例覆盖真实 StateFrame 和三类非法事件。SSE、HTTP、CLI、LAN 共 21 个相关测试通过。真实服务端上的生成 client 收到 `404 / Missing` 和原始错误体，`state` 返回正常帧。全量 609 个服务端测试和 5 个 protocol 测试通过。

## 3.24 stall 的等待和静默时长使用同一个 Clock

**站点：`session/session.ts` 的 `watchStalls`、stall 通知，以及 `agent/agent.test.ts` 的退出断言。**

原来的计时器由 `Effect.sleep` 驱动，静默时长却读 `Date.now()`：测试能推进 sleep，却不能确定这次计算读到了什么。现在服务构建时取得 `Clock.Clock`，把它传给 `watchStalls`；计时结束只用 `currentTimeMillisUnsafe` 读一次，通知和 `quiet.since` 都使用这一刻。同步 oar 回调和 `Core.apply` 没有改成异步，也没有用 `DateTime.nowUnsafe` 冒充 TestClock。

这只是统一需要测试的时钟边界，不把持久化时间戳机械换掉。Game 的 commit 统计与账本时间不是同一种等待—墙钟混用，不为形式统一另改。

`watchStalls` 暴露给定向测试，用 oar 的真实 request record 形状：49 个虚拟毫秒时不提醒，第 50 个时恰好提醒一次，回调收到 `silentForMs: 50` 和 `at: 50`。测试不用真实等待。

退出断言也分开了：档案保存错误用 `Effect.flip` 断言精确 `Refused`；配置无法挪到一边导致启动失败时，断言 `Cause.hasDies`，不再让任意 Failure 都通过。

**验证**：Session 7 个测试和 Agent 8 个测试通过；全量 610 个服务端测试通过。真实服务端证据见第 6 节。

## 3.25 局部错误、取消和统计写回各自保持原义

**站点：`core/core.ts`、`game/game.ts`、`memory/memory.ts`、`session/session.ts`、`http/mcp.ts` 五组局部边界。**

- Core 的延迟落盘仍由 `FiberMap` 合并写。`Effect.onError` 只给非中断错误增加 `state.json could not be saved` 日志，原 Cause 不变；关闭时取消等待中的任务，再尝试最后一次保存。
- Game 把「统计 commit 并写回」收进同一个 `refresh`，启动定时和 run 结束后的刷新都复用 `counting` 锁。统计与写回作为一个串行段，较早开始的慢统计不会在较晚统计之后覆盖状态。
- 管家的 `forgetOf` 和 `previewForgetOf` 把 MEMORY.md 的读取、写回文件错误映射成 `Refused`。这条策略只覆盖有 `ApiError` 契约的管理接口，不把其他文件或记忆来源的故障一律改成拒绝。
- Session 的登记段用 `SqlError.isSqlError` 区分错误：SQL defect 翻成 typed failure，继续走既有拒绝；非 SQL defect 重新抛出。`Effect.onError` 在意外退出时先调用 `failedOpening` 关闭刚取得的执行，再保留原 Cause，不再用宽 `catchDefect` 把程序员错误说成启动失败。
- MCP 与 OpenAI 的手写 Web adapter 换成平台的 `HttpEffect.fromWebHandler`。断开连接会把 Request.signal 传给等待中的 handler，typed error 也不再经手工 Promise 包装改写。这里没有宣称 MCP SDK 已启动的工作都能取消，那取决于 SDK 自己的取消接口。

**验证**：Core、Memory、MCP、OpenAI 和 MCP 服务的 5 个测试文件共 31 个测试通过；Game 与 Session 的 2 个文件共 15 个测试通过。Game 覆盖两种 Deferred 完成顺序，Session 用真实 PGlite 的 SQL 故障验证拒绝，并验证非 SQL defect 后还能再次派活。MCP 测试实际 abort 请求，handler 收到取消并返回 499。

## 3.26 具名 Effect 函数按用途选用 `Effect.fn` 或 `fnUntraced`

**站点：33 个具名函数，不是 33 个独立缺陷。**

| 文件 | 数量 | 写法 |
|---|---:|---|
| `cli.ts`、`cli/api.ts` | 3 | 导出的 `Cli.run`、`Cli.request` 保留命名 span；内部请求体检查不追踪 |
| `project/project.ts` | 6 | 5 个 Git 帮助函数用 `fnUntraced`；导出的 `Projects.probeGitHub` 有命名 span |
| `channel/chat.ts` | 8 | 读游标、确认、写入、发布后、唤醒、通知、活动和目标解析 |
| `issue/{issue,merge,refinement}.ts` | 14 | 工单查找与开工、合并、PR、起草和清理；服务动作用 `Issues.*` span |
| `task/task.ts` | 2 | 定时推进与验收检查 |

`readThrough` 的事务和后续发布、`merge` 与 `draft` 的锁仍是原函数的一部分，但作为后续 combinator 传入：`Effect.fn...(generator, (effect, ...args) => ...)`。没有先把返回的函数当 Effect 调 `.pipe`。Channel 中互相递归的 `write`、`after`、`kick` 和 `notify` 保留显式 `Effect.fn.Return`，TypeScript 不会因改写推出 `any`。

服务 `make`、只为事务或 Stream 组合存在的内联 `Effect.gen`、已经构造好的锁内 Effect 值不改。`AgentExecution` 的四个类方法依赖 `this`，保留现有 `self` 捕获；`http/mcp.ts` 只有一个路由构造器，没有为凑数量再造具名函数。这些保留项见第 4 节，不是漏改的纯包装。

**验证**：CLI、Channel、Issue、Refinement、Project、Task、AgentExecution、Session 和 Game 的 9 个测试文件共 110 个测试通过，服务端类型检查通过。既有行为测试覆盖真实 Git、PGlite、工单起草、合并和命令行输出，没有为纯写法变化另造一套同义测试。

## 4. 审查后保留原样的边界

- 服务构造器需要取得依赖、建立锁、注册 finalizer，本身就是完整 Effect 程序；`make = Effect.gen` 不是待清理的包装。
- 事务、锁、Stream 和 HTTP 中的短内联回调只存在一次，不为它另造名字或 span。已经构造好的 `refreshPullRequests` 等 Effect 值也不属于「函数只包装 `Effect.gen`」。
- 类方法的 `this` 是实际状态边界。可以用显式 `this` 参数再改写，但那不修复错误，也不比当前 `self` 更清楚。
- Promise、回调和 `Effect.runSync` 只保留在有明确所有权的宿主交界。这个结论不恢复已经修掉的无 owner drain、迟到资源或取消后继续执行。
- `apps/server/db/generated` 和 `packages/protocol/src/client.ts` 仍由各自生成器维护，没有手改生成结果。

因此，「全部落实」指上面 26 类已经有实现或有证据的保留结论，不表示仓库没有 `Effect.gen`、Promise 或 `Date.now`，也不表示把每一种可替换写法都替换了。

## 5. 验证原则

先验证失败和中断时的语义，再验证正常流程。测试使用真实 PGlite、真实 Git、真实服务端和本机假 HTTP/MCP；只有协议明确支持的取消才写进结论。需要真实云账号、模型费用或生产慢消费者的部分不纳入自动通过的证据，也不为了验证去联网。

## 6. 本分支的验证证据

实现过程中先跑最窄检查，所有失败都修正后重跑，没有通过删测试或放宽断言收尾。

已通过的定向命令包括：

```bash
cd apps/server
bun run test -- src/agent/brain/openai.test.ts src/core/core.test.ts src/recurrence/recurrence.test.ts
bun run test -- src/setting/setting.test.ts src/core/core.test.ts src/recurrence/recurrence.test.ts \
  src/session/host.test.ts src/agent/brain/agent.test.ts src/agent/brain/tools.test.ts
bun run test -- src/session/session.test.ts src/session/host.test.ts
bun run test -- src/voice/voice.test.ts
bun run test -- src/connector/connector.test.ts src/connector/weixin.test.ts src/connector/qq.test.ts src/connector/wait.test.ts
bun run test -- src/lan/lan.test.ts
bun run test -- src/issue/issue.test.ts src/project/project.test.ts src/task/task.test.ts
bun run test -- src/http/api.test.ts src/issue/issue.test.ts src/session/execution.test.ts
bun run test -- src/memory/memory.test.ts src/session/session.test.ts src/runtime/dsh.test.ts
bun run test -- src/runtime/runtime.test.ts
bun run check
```

覆盖的关键证据：

- SQL 无行与 SQL 故障的退出类别不同。
- Git 故障不能完成成无改动。
- 坏设置文件启动失败且原字节不变。
- 畸形 OpenAI 请求不会调用 answerer。
- 中断 spawn 后，迟到会话被 dispose，同工单可重派。
- 中断 Voice 启动后，迟到 agent 收到 `/leave`。
- 听写坏响应是 typed `VoiceUnavailable`。
- Caller 和 connector 的 listener 计数不随轮次增长。
- 微信递归消息正常解码，畸形 updates 和 QQ `null` 帧被拒绝。
- 引用查询失败保持 pending、恢复后交付；pause 写失败没有密集 poll。
- LAN 固定端口反复立即重开成功。
- HTTP 错误成功形状为 500，中断为平台识别的 503。
- full 和 usage 两种完成顺序都保留新 full 的 installation 和 usage。
- 两次 `Brain.close` 共享实际清理 Promise，`waitForIdle` 未放行时不提前完成。
- `AgentHost` 在 Build 期间关闭会等待放行，迟到输入不 deliver，caller 正常结束。
- `Effect.fnUntraced` 改写后的 memory 和 session 行为不变。

### 全量检查

本轮新增的定向回归：

```bash
cd apps/server
bun run test -- src/core/bounded.test.ts src/core/core.test.ts src/connector/connector.test.ts src/game/game.test.ts
# 4 个文件、29 个测试通过
bun run test -- src/voice/voice.test.ts src/orchestrator/orchestrator.test.ts src/session/host.test.ts src/agent/brain/agent.test.ts
# 4 个文件、68 个测试通过
```

本轮 JSON 的定向回归：

```bash
cd apps/server
bun run test -- src/agent/agent.test.ts src/runtime/runtime.test.ts src/recurrence/recurrence.test.ts \
  src/channel/chat.test.ts src/task/task.test.ts src/game/game.test.ts src/memory/outside.test.ts src/memory/providers.test.ts
# 8 个文件、103 个测试通过
```

执行恢复与第三方适配器这一段的定向回归：

```bash
cd apps/server
bun run test -- src/session/execution.test.ts src/session/session.test.ts src/connector/connector.test.ts \
  src/runtime/runtime.test.ts src/memory/outside.test.ts src/memory/providers.test.ts
# 6 个文件、74 个测试通过
```

Brain 恢复数据的定向回归：

```bash
cd apps/server
bun run test -- src/agent/brain/taskGraph.test.ts src/agent/brain/tools.test.ts \
  src/agent/brain/agent.test.ts src/agent/brain/run.test.ts src/agent/brain/runtime.test.ts
# 5 个文件、68 个测试通过
```

微信响应的定向回归：

```bash
cd apps/server
bun run test -- src/connector/weixin.test.ts src/connector/connector.test.ts
# 2 个文件、24 个测试通过
```

client 和 SSE 的定向回归：

```bash
cd packages/protocol && pnpm test
# 2 个文件、5 个测试通过
cd apps/server && bun run test -- src/http/streams.test.ts src/http/api.test.ts src/cli.test.ts src/lan/lan.test.ts
# 4 个文件、21 个测试通过
```

Clock 与精确断言的定向回归：

```bash
cd apps/server && bun run test -- src/session/session.test.ts src/agent/agent.test.ts
# 2 个文件、15 个测试通过
```

局部错误、取消与统计锁的定向回归：

```bash
cd apps/server
bun run test -- src/core/core.test.ts src/memory/memory.test.ts src/http/mcp.test.ts src/agent/brain/openai.test.ts src/mcp/mcp.test.ts
# 5 个文件、31 个测试通过
bun run test -- src/game/game.test.ts src/session/session.test.ts
# 2 个文件、15 个测试通过
```

具名函数改写的定向回归：

```bash
cd apps/server
bun run test -- src/cli.test.ts src/channel/chat.test.ts src/issue/issue.test.ts src/flows/refinement.test.ts \
  src/project/project.test.ts src/task/task.test.ts src/session/execution.test.ts src/session/session.test.ts src/game/game.test.ts
# 9 个文件、110 个测试通过
```

各专题中的计数是那一轮的记录；最终交付以这组结果为准：

- `bun run check:fix && bun run server:check`：格式化完成，protocol 2 个文件共 5 个测试通过，服务端类型和生成查询检查通过；服务端 80 个测试文件通过、616 个测试通过，1 个需要真实模型的 live eval 按配置跳过。
- `bun run check`：575 个文件格式正确，0 个错误。只有 3 个既有警告：`memory/outside.test.ts:309` 的 `require-array-sort-compare`、`memory/source-lifetime.test.ts:33` 的 `unbound-method`、同文件 `:43` 的 `no-base-to-string`。
- `bun run docs:verify`：删除已沉淀的实施 Note 并重建目录后，24 篇 Note、6 个 skill、85 个文档链接文件和 482 个旧名字检查文件通过，能力表和生成的 API client 也是最新。
- `bun run web:check`：各包类型检查通过；host 4 个测试、mobile 19 个测试通过，web 构建成功。构建另打印 Node `DEP0169` 和大于 500 kB 的 chunk 提示，退出码为 0。

### 真实服务端

`verify-server` 使用临时家目录、工作目录和空闲回环端口，不读取主人的钥匙或数据。十四次成功验证的 `result.json` 都是 `code: 0`、`stopped: true`、`cleanupErrors: []`；前八次、第十次至第十四次 `server.stderr.log` 为空，第九次另有一行 `Got response to unknown request skills-reload`，接口断言和清理不受影响。

1. 隔离健康检查：`health.json` 为 `{ "ok": true, "version": "0.1.0" }`。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-ilFvwz`。
2. scripted helper 全流程：`issue create` → `issue run` → `status --dry-run` → `status done`。最终工单是 `status: "done"`、`delivered: "merged"`，Git 主分支有 `71eb0ca 加上打卡`。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-qmMIr1`。
3. 原始 HTTP、状态和设置：`issue list` 和 `state` 正常；`days: [1.5]` 的原始 POST 返回 400 和 `SchemaError: Expected an integer`；合法 weekly 创建成功，`setting load` 和含一张定时的 `state` 都通过 `jq` 断言。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-yBWkUu`。
4. connector 改造后的启动与状态：再次执行 `issue list` 和 `state`，健康检查和核心状态正常。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-EtXE2E`。
5. Runtime probe 改造后的启动与状态：再次执行 `issue list` 和 `state`，健康检查和核心状态正常。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-u2RpY0`。
6. Brain/AgentHost 改造后的启动与状态：再次执行 `issue list` 和 `state`，健康检查和核心状态正常。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-KNDrV8`。
7. Core/SSE 与 Voice drain 改造后的启动和状态：`issue list` 返回 `[]`，`state` 返回正常帧；`command.stderr.log` 为空。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-T6zsTw`。
8. 其余 JSON 边界改造后的启动：`agent list` 和 `runtime list` 都断言非空，`recurrence list` 断言为 `[]`，`state` 断言管家为 `idle`；四条命令都输出 `true`，命令和服务端错误日志为空。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-xJWfgT`。
9. 执行恢复与第三方适配器改造后的启动：`connector list` 返回微信、飞书、QQ 三条 `off`，`state` 断言管家为 `idle`。先前把默认账号列表误写成 `[]` 的断言失败后，修正为实际的三个 `off` 再跑通过。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-WA3n92`。
10. Brain 恢复数据改造后的启动：`issue list` 为 `[]`，`state` 断言管家为 `idle`，两个断言都输出 `true`，命令和服务端错误日志为空。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-cvClWN`。
11. 微信逐响应 Schema 改造后的启动：三个连接器均为 `off`，`state` 断言管家为 `idle`，两个断言都输出 `true`，命令和服务端错误日志为空。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-ySJjyJ`。
12. client/SSE 改造后的启动：生成的 client 在真实服务端读到 `404 / Missing` 和原始错误体，`state` 返回正常帧；命令和服务端错误日志为空。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-PgDuge`。
13. Clock 与精确断言改造后的启动：`issue list` 为 `[]`，`state` 断言管家为 `idle`，两个断言都输出 `true`，命令和服务端错误日志为空。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-bZ0xmi`。
14. 局部错误、MCP adapter 和具名函数收尾后的启动：`health.json` 为 `{ "ok": true, "version": "0.1.0" }`，`issue list` 为 `[]`，`state` 断言管家为 `idle`；两个断言都输出 `true`，命令和服务端错误日志为空。`result.json` 为 `code: 0`、`stopped: true`、`cleanupErrors: []`。证据目录：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-VXKGEg`。

这些结果没有把假 Agora、假模型和本机 HTTP 服务冒充真实云集成。真实 Agora、QQ、微信、飞书、DeepSeek 和生产环境慢消费者压测仍需各自的验证环境。

## 7. 结论

这个仓库不是「Effect 写得都不地道」。服务、Layer、核心状态、数据库和大量 Promise 交界已经有清晰结构。真正需要补的是几条边界：**错误不能变成正常值，取消不能变成继续执行，迟到的资源必须有 owner，外部形状必须由 Schema 决定，慢消费者必须有明确策略。**

本分支落实了全部 26 类，并把验证变成可重复的测试；没有剩余待设计的审查项。Effect 的地道性最终不体现在用了多少 combinator，而体现在这些边界在失败和中断时仍然说得清、测得到。
