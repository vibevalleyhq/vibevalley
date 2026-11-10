# Agent Note: 显式状态机分层体系、Effect v4 原语与全链路错误契约

Status: proposed

## Problem

仓库已在工单流转（[apps/server/src/issue/moves.ts](apps/server/src/issue/moves.ts) 的 `statusMove` 与 `nextSteps`）、核心状态折叠（[apps/server/src/core/core.ts](apps/server/src/core/core.ts) 的 `SubscriptionRef` 与 `Fact`）及协议错误（[packages/protocol/src/endpoint.ts](packages/protocol/src/endpoint.ts) 的 `ApiError`、`Next`、`VoiceFix`）建立了显式状态与恢复契约。但在其余服务端模块、流式边界与客户端交互层，状态机与错误体系仍存在五处结构性断层：

1. **状态机缺少分层标准，25 处模块退化为散装布尔与哨兵值**：服务端 12 处与客户端 13 处（含表单引擎 [apps/web/src/infra/form/form.ts](apps/web/src/infra/form/form.ts)）用多个布尔值、可空字段、`-1` / `""` 哨兵与闭包 `let` 变量拼凑状态。帮工运行态（[apps/server/src/session/registry.ts](apps/server/src/session/registry.ts) 的 `Hand`）横跨 SQLite、`Core.SpaceState` 与内存 `Hand` 对象的 10 个可变字段，导致 [apps/server/src/session/launch.ts](apps/server/src/session/launch.ts) 的 `capacity()` 只能靠组合条件猜测帮工是否处于启动占位阶段。
2. **内部服务用成功通道返回 `{ refused?: string }`，绕开 `Effect` 错误通道与作用域回滚**：[apps/server/src/executor/executor.ts](apps/server/src/executor/executor.ts) 的 `Executor.start`、[apps/server/src/session/session.ts](apps/server/src/session/session.ts) 的 `Session.hire`、[apps/server/src/issue/dispatch.ts](apps/server/src/issue/dispatch.ts) 的 `Issue.hire` 与 [apps/server/src/session/host.ts](apps/server/src/session/host.ts) 的 `AgentHost.submit` 将失败塞进成功返回值（`{ refused, retainedWork }`），导致下游失败无法自动触发 `Effect.acquireRelease` 与 `Effect.onError`，迫使调用方手写 `committed`、`released`、`registeredRow` 等 3–6 个布尔标志位做条件回滚。
3. **`Effect.option` 加 `tapError` 旁路赋值吞没类型化错误**：[apps/server/src/session/session.ts](apps/server/src/session/session.ts)、[apps/server/src/executor/executor.ts](apps/server/src/executor/executor.ts) 与 [apps/server/src/issue/dispatch.ts](apps/server/src/issue/dispatch.ts) 为规避错误通道，声明 `let refusal = ""` 或 `let placeError = ""`，在 `Effect.tapError` 中偷偷修改外部变量后再调 `Effect.option`，既破坏了引用透明性，也丢弃了原始 `Schema.TaggedError` 的标签与 `cause`。
4. **结构化 `ApiError` 在四大消费端中的三端断链**：
   - **命令行（[apps/cli/src/farm.ts](apps/cli/src/farm.ts)）**：完整保留了 `_tag`、退出码与 `next` 恢复步骤。
   - **模型工具层（[apps/server/src/tool/schemas.ts](apps/server/src/tool/schemas.ts)）**：`toFailed` 仅调用 `reasonOf(e)`（[apps/server/src/base/errors.ts](apps/server/src/base/errors.ts)），将 `Missing` 与 `Refused` 携带的 `next` 数组完全丢弃，助手与帮工调工具被拒时看不到服务端算好的下一步命令。
   - **页面动作与表单层（[apps/web/src/ui/act.ts](apps/web/src/ui/act.ts)、[apps/web/src/infra/api.ts](apps/web/src/infra/api.ts)）**：`createAct` 仅把状态码 `400/401/403/404/409/422` 判为 `"rejected"`，而协议中 `VoiceUnavailable`（`503`）与 `VoiceCallFailed`（`502`）也是明确的 `ApiError`（[packages/protocol/src/endpoint.ts](packages/protocol/src/endpoint.ts) 的 `errorStatus`），被误判为 `{ kind: "unknown", message: "不确定是否已生效" }`；同时 `reasonOf` 丢弃了 `next` 与 `settings`。
   - **页面乐观意图与长连接层（[apps/web/src/state/intent.ts](apps/web/src/state/intent.ts)、[apps/web/src/features/voice/call.ts](apps/web/src/features/voice/call.ts)）**：故障仅存裸字符串 `reason` / `problem`，既无法区分「断网可自动重试」与「业务拒绝不可自动重试」，又允许 `phase === "live"` 与非空 `problem` 并存。
5. **客户端状态原语边界未对齐门禁规则**：`vibevalley/atom-door` 规定仅 `apps/web/src/state/` 可导入 `effect/reactivity`，组件层不能直接散落 `Atom`；同时页面已有无断言联合收窄原语 `variant(value, key, tag)`（[apps/web/src/base/dom.tsx](apps/web/src/base/dom.tsx)），但各业务组件仍普遍手写多重布尔信号而非判别联合。

## Proposal

在不改变外部 HTTP/SSE 线上协议、SQLite 表结构与组件公开属性的前提下，建立全仓统一的 **四层状态机体系** 与 **端到端结构化错误体系**，并严格对齐 [vv-effect](.agents/skills/vv-effect/SKILL.md) 的 `effect@4.1.2` 规范与门禁规则。

## 道 — 四层状态机架构与归属原则

全仓状态机按生命周期与所属边界划分为四层，每层使用固定的原语与并发契约，不跨层混用：

| 层级 | 管什么 | 唯一真相源与原语 | 典型模块 | 核心不变量 |
|---|---|---|---|---|
| **L1：持久领域状态机** | 跨进程重启保留的业务生命周期 | SQLite 行（带 `CHECK (col IN (…))` 枚举约束）+ `Core.SpaceState`（`SubscriptionRef`）+ [packages/protocol/src/rules](packages/protocol/src/rules/index.ts) 纯函数 | 工单（`Issue`）、信箱（`Mailbox`）、帮工身份（`Session`） | 状态迁移先在 `Db.inTx` / `attemptTx` 落盘，再调 `Core.apply` 发布事实；允许的动作（`acts`）与拒绝后的下一步（`Next[]`）由纯函数从当前状态唯一派生 |
| **L2：服务端运行期资源与流状态机** | 单进程内的外部连接、子进程槽位、缓存世代与流式草稿 | `SynchronizedRef<StateUnion>` + `Scope`（`Effect.acquireRelease`）+ `FiberMap` / `FiberHandle` + `Stream.runFoldEffect` | 执行器（`Executor`）、帮工底座（`Hand`、`AgentHost`、`Journal`）、语音（`Voice`）、连接器（`Connector`）、局域网（`Lan`）、记性源（`Sources`）、笔记缓存（`Pkm`）、`Brain` 与 `Loop` | 跨 `yield*` 的状态读写必须在 `SynchronizedRef` 或 `Semaphore` 内原子完成；伴生资源（`Fiber`、`Server`、`Subagent`、`Deferred`）只存在于对应状态分支载荷中，状态切换时由作用域或 `FiberMap` 自动释放 |
| **L3：客户端传输、意图与表单状态机** | 页面级长连接、乐观更新、跨组件共享状态与表单校验提交 | `apps/web/src/state/` 内的 `effect/reactivity`（`Atom`、`AtomRegistry`）与 `apps/web/src/infra/` 订阅源（经 `createExternal` 桥接 Solid） | 乐观意图（`intent.ts`）、帧流（`frame.ts`）、启动门禁（`opening.ts`）、通话（`call.ts`）、MOSS 线程（`moss-worker.ts`）、表单（`form/form.ts`）、动作（`ui/act.ts`） | 遵守 `vibevalley/atom-door`（仅 `state/` 导入 `effect/reactivity`）；内部状态为单一 `_tag` / `kind` 判别联合，对外派生只读访问器；故障存为结构化 `UiFault` 且仅驻留于故障或降级分支 |
| **L4：客户端局部交互状态机** | 单个组件树内的浮层互斥、自动补全、焦点交接与折叠态 | Solid `createSignal<StateUnion>()` + 纯迁移函数 + [apps/web/src/base/dom.tsx](apps/web/src/base/dom.tsx) 的 `variant(state(), "kind", "…")` | 消息工具栏（`MessageParts.tsx`、`Messages.tsx`）、频道顶栏（`ChatPage.tsx`）、输入框（`composing.ts`）、大纲块（`OutlineEditor.tsx`）、稿子块（`BlocksView.tsx`）、农场画布（`VillageCanvas.tsx`） | 严禁用 $N$ 个独立布尔信号表达互斥 UI 状态；模板分支读取统一用 `variant()`，零 `as` 断言 |

### 状态机设计的五条硬规则

1. **非法状态不可表示（Make Illegal States Unrepresentable）**：每个状态机只允许一个主状态联合类型（以 `_tag` 或 `kind` 为判别键）。仅在某阶段有效的数据（如 `Connecting` 时的 `pendingCaptions`、`Observing` 时的 `stopObservers`、`Failed` 时的 `fault`）必须收进该分支结构体，禁止作为顶层可空字段与主状态并列。
2. **禁止哨兵值重载（No Sentinel Overloading）**：禁止用 `-1` 表示「菜单已关闭」（[apps/web/src/features/pkm/OutlineEditor.tsx](apps/web/src/features/pkm/OutlineEditor.tsx)）、禁止用 `{ starting: false, agent: "" }` 组合表示「令牌已签发但未启动」（[apps/server/src/voice/voice.ts](apps/server/src/voice/voice.ts)）。位置是数值，阶段是标签，两者分开建模。
3. **内部失败走 `Effect` 错误通道，资源回滚走 `Scope`**：服务端内部模块方法（如 `Executor.start`、`Session.hire`）遇到拒绝或外部失败时，应在 `Effect` 错误通道返回 `Schema.TaggedError`（或 `ApiError`），不再返回 `{ session?: …; refused?: string }` 成功值；资源获取一律用 `Effect.acquireRelease` 绑定到当前 `Scope`，让失败或中断自动按后进先出（LIFO）顺序触发清理。
4. **消除 `let refusal = ""` 旁路捕获**：禁止写 `Effect.tapError((e) => Effect.sync(() => (refusal = …)))` 加 `Effect.option`。需要分支处理时，在 `Effect` v4 中使用 `Effect.matchEffect`、`Effect.catchTag` 或 `Effect.catchTags`。
5. **内核联合化，边界投影化（Union Core, Projected Shell）**：重构内部状态机时，对外接口（协议类型 `T.Session`、`T.ConnectorStatus`、`T.LanStatus`，以及客户端 `voiceCall.phase`、`composing.canSend()`、`intent.status`）通过纯函数从内部联合状态实时投影，确保外部调用方与测试契约零破坏。

## 道 — 全链路结构化错误体系

将仓库现有的错误类型统一收束为 **三层错误分类** 与 **四端无损消费契约**：

### 1. 三层错误分类与转换边界

| 错误层级 | 表示方式 | 语义与产生边界 | 谁来接、怎么转 |
|---|---|---|---|
| **第一层：外部与底层故障（Infra / Library Fault）** | `Schema.TaggedError`（必带 `cause: Schema.optionalKey(Schema.Defect())`） | 外部库 Promise 拒绝、子进程非零退出、SQLite `SqlError`、文件系统 `PlatformError`、模型流 `LlmError` | 在 `Effect.tryPromise({ try, catch })` 边界立即包装为具名 `Schema.TaggedError`（如 `NotRecorded`、`NotClosed`、`SourceError`、`RepoError`），保留原始 `cause` 供日志与追踪读取 |
| **第二层：领域转换与业务拒绝（Domain & Transition Error）** | `Schema.TaggedError` 或协议 `ApiError`（`Refused`、`Missing`、`VoiceUnavailable`、`VoiceCallFailed`、`ConnectorRefused`、`LanRefused`） | 状态机处于非法前置状态、实体不存在、配额或空位已满、外部前置条件未就绪（缺密钥、未配对） | 由领域服务或状态机迁移函数构造；凡用户或模型可通过下一步操作解决的，**必须附带 `next: readonly Next[]` 或 `settings: VoiceFix`** |
| **第三层：取消中断与程序缺陷（Interrupt & Defect）** | `Cause.Interrupt` 与 `Cause.Die`（含 [apps/server/src/base/errors.ts](apps/server/src/base/errors.ts) 的 `Inconsistent`） | 用户主动停止/挂断、作用域关闭、超时取消，或内部不变量破裂（数据自相矛盾、不可达分支） | 中断沿 `Cause` 自然传播以触发 `acquireRelease` 释放资源，并在状态机终点归位为 `Idle` / `"aborted"`；缺陷（`Inconsistent`）在 HTTP/MCP/流边界统一拦截记录 `500` 与遥测日志，绝不伪装成普通业务提示 |

### 2. 四大消费端无损传递契约（修复三处断链）

```
[领域状态机 / 服务]
   │ 产生 ApiError { _tag, reason | what, next?: Next[], settings?: VoiceFix }
   ├─► 1. CLI (apps/cli/src/farm.ts & output.ts)
   │      └─► 已打通：映射退出码 (3/4/5) + stderr JSON 输出 { tag, message, status, next }
   ├─► 2. 模型工具层 (apps/server/src/tool/schemas.ts)  <-- 【修复断链 A】
   │      └─► 升级 explainApiError(e)：将 e.next 格式化为模型可读的「可执行的下一步」指令追加在拒绝原因后
   ├─► 3. 页面动作与表单 (apps/web/src/infra/api.ts & ui/act.ts & infra/form/form.ts)  <-- 【修复断链 B】
   │      └─► 新增 UiFault 与 faultOf(e)：只要 e instanceof VibeValleyApiError && e.error !== undefined（含 502/503），
   │          一律归类为明确的 rejected（而非 deliveryUnknown），并保留 fault.next 与 fault.settings
   └─► 4. 页面乐观意图与流状态机 (apps/web/src/state/intent.ts & features/voice/call.ts)  <-- 【修复断链 C】
          └─► Failed / Lost 分支持有完整 UiFault：区分 transient 网络错误（重连后自动重发）与业务 Refused（保持失败态待用户处理）
```

- **修复断链 A（模型工具层 `explainApiError`）**：
  在 [apps/server/src/base/errors.ts](apps/server/src/base/errors.ts) 新增 `explainOf(e: ApiError): string`：当 `e` 为 `Refused` 或 `Missing` 且带有非空 `e.next` 时，在 `reasonOf(e)` 后追加 `e.next.map((n) => n.run ? `${n.say} (${n.run.join(" ")})` : n.say)`。在 [apps/server/src/tool/schemas.ts](apps/server/src/tool/schemas.ts) 的 `toFailed` 中改调 `explainOf(e)`，使助手与帮工在调工具失败时当场获得下一步恢复线索（AX 直接跃升）。
- **修复断链 B（页面 `UiFault` 与 `createAct` 状态码误判）**：
  在 [apps/web/src/infra/api.ts](apps/web/src/infra/api.ts) 定义：
  ```ts
  export interface UiFault {
    readonly tag: ApiError["_tag"] | "Network" | "Client";
    readonly reason: string;
    readonly next?: readonly Next[];
    readonly settings?: VoiceFix;
    readonly retryable: boolean;
  }
  ```
  在 [apps/web/src/ui/act.ts](apps/web/src/ui/act.ts) 中，将 `error instanceof VibeValleyApiError && (error.error !== undefined || [400, 401, 403, 404, 409, 422].includes(error.status))` 判定为 `{ kind: "rejected", message, fault: faultOf(error) }`，彻底修复 `503 VoiceUnavailable` 与 `502 VoiceCallFailed` 被误报为「不确定是否已生效」的缺陷。
- **修复断链 C（状态机内聚故障载荷）**：
  在 `intent.ts`、`frame.ts`、`call.ts`、`opening.ts` 与 `form.ts` 中，错误以 `UiFault` 存入 `Failed` 分支（或 `Live` 分支的 `warning?: UiFault`），对外 `.problem` / `.reason` 从 `fault.reason` 派生；一旦状态机迁移离开故障分支，`fault` 自动随旧状态对象被垃圾回收，根绝跨状态幽灵报错。

## 术 — 服务端 12 处隐式状态机收敛规格（L1 & L2）

| 编号 | 模块与位置 | 现行隐式状态与反模式 | 目标显式状态机与 `Effect` v4 改造方案 |
|---|---|---|---|
| **B1** | 连接器桥接状态机<br>[apps/server/src/connector/bridge.ts](apps/server/src/connector/bridge.ts) | `account`、`progress`、`verifyCode`、`loginTry`、`err`、`current: Fiber \| undefined`、`pendingOut` 独立修改；`logout` 失败时清空 `progress` 并重启 `connected()`，残留旧 `account` 与新 `err` | 用 `SynchronizedRef<BridgeState>` 收敛为：`Off { fault?: string } \| LoggingIn { progress: Progress; tryCount: number; verifyCode?: string } \| Pairing { account: Account } \| Paused { account: Account; until: number; fault?: string } \| Connected { account: Account; pendingOut?: number }`；后台收发纤程由 `FiberHandle` 托管，状态切换时自动中断旧纤程 |
| **B2** | 语音令牌与启动回滚<br>[apps/server/src/voice/voice.ts](apps/server/src/voice/voice.ts) | `Grant` 用 `{ starting: boolean; agent: string }` 编码三态；`start` 用 `release`、`callLine`、`openingLine`、`client`、`starting`、`committed` 6 个 `let` 变量在 `Effect.onError` 中手写条件回滚 | `Grant` 改为 `{ _tag: "issued"; expires: number } \| { _tag: "starting"; expires: number } \| { _tag: "active"; agentId: string; expires: number }`；`start` 用 `Effect.acquireRelease` 按顺序包裹令牌占座、声网客户端与通话行创建，删除 6 个手写回滚变量 |
| **B3** | 语音通话 MOSS 播报队列<br>[apps/server/src/voice/voice.ts](apps/server/src/voice/voice.ts) | `Call.ending: boolean`、`Call.life: AbortController` 与闭包 `activeMoss: MossSession \| undefined`、`pendingMossSpeaks: string[]` 分散维护 | 收敛为 `MossCallState = { _tag: "connecting"; queuedSpeaks: readonly string[] } \| { _tag: "live"; session: MossSession } \| { _tag: "ending" } \| { _tag: "closed" }`，建连成功时一次性冲刷 `queuedSpeaks`，进入 `ending` 时原子拒绝新播报 |
| **B4** | 局域网监听与配对审批<br>[apps/server/src/lan/lan.ts](apps/server/src/lan/lan.ts) | `open`、`server`、`port`、`problem` 拼凑监听状态；`Pairing` 用 `asking === ""` 与 `answer !== undefined` 区分「等配对码」与「等用户点允许」 | 拆分为两个显式联合：`ListenerState = { _tag: "closed"; port: number } \| { _tag: "listening"; server: Server; port: number } \| { _tag: "failed"; port: number; problem: string }` 与 `PairingState = { _tag: "idle" } \| { _tag: "awaitingCode"; code: string; expires: number; wrong: number } \| { _tag: "awaitingApproval"; code: string; asking: string; expires: number; answer: (allow: boolean) => void }` |
| **B5** | 助手宿主流式回答与生命周期<br>[apps/server/src/session/host.ts](apps/server/src/session/host.ts) | `Caller` 用 `kept[]`、`ended`、`failure`、`reader` 手写队列状态机；`makeHost` 用 `open: boolean`、`toCaller: number`、`closing: boolean`、`brain` 追踪吐字与关闭 | `Caller` 收敛为 `{ _tag: "buffering"; chunks: string[]; exit?: Exit<void, NotAnswered> } \| { _tag: "streaming"; reader: Queue<string, NotAnswered \| Cause.Done> } \| { _tag: "closed" }`；`makeHost` 吐字阶段收敛为 `TurnSpeech = { _tag: "silent" } \| { _tag: "speaking"; sentChars: number }` |
| **B6** | 帮工轨迹草稿合并与落盘<br>[apps/server/src/session/journal.ts](apps/server/src/session/journal.ts) | 单个 `draft` 同时承担文本增量合并（`draftWho`）与工具调用参数暂存（`draftCall`）；中间插入任意事件触发 `seal()` 后，迟到的 `toolInput` 被静默丢弃 | 将文本流草稿 `textDraft: { event: SessionEvent; who: string } \| undefined` 与待补全参数的工具调用表 `openToolCalls: Map<string, SessionEvent>` 分离，使中间事件封存文本草稿时不影响后续到达的 `toolInput` |
| **B7** | 帮工派活事务回滚与运行阶段<br>[apps/server/src/session/session.ts](apps/server/src/session/session.ts)<br>[apps/server/src/session/registry.ts](apps/server/src/session/registry.ts) | `Session.hire` 用 `let placeError = ""` 旁路拿错误，并用 `committed`、`released`、`registeredRow` 手写回滚；`Hand` 上散落 `launch`、`spoke`、`run`、`report`、`settling` | 删除 `placeError` 与 3 个回滚布尔值，改用 `Effect.acquireRelease` 管理工作目录、轨迹、执行器与数据库行回滚；将 `Hand` 的运行期状态内聚为 `HandTurnState = { _tag: "idle" } \| { _tag: "opening"; launch: string } \| { _tag: "working"; launch: string; runId: string; spoke: boolean; heard: string[]; report?: T.IssueReport } \| { _tag: "settling"; launch: string; runId: string; pendingReport: SubagentReport; completedBefore: number }` |
| **B8** | 执行器槽位生命周期<br>[apps/server/src/executor/executor.ts](apps/server/src/executor/executor.ts) | `Allocation` 同时含 `agent?`、`attached: boolean`、`detached: boolean`、`closing: boolean`、`closingWait?: Deferred`、`stop?`；`detach()` 后 `attached` 仍为 `true`；`start` 用 `let refusal = ""` 旁路拿错误 | 删除 `let refusal = ""`，用 `Effect.matchEffect` 处理 `runtimes.resolve`；将 `Allocation.phase` 收敛为 `{ _tag: "spawning" } \| { _tag: "unobserved"; agent: Subagent } \| { _tag: "observing"; agent: Subagent; stop: () => void } \| { _tag: "detached"; agent: Subagent } \| { _tag: "closing"; wait: Deferred<void, NotClosed>; failure?: string }`，对外 `view()` 由 `phase._tag === "observing"` 导出 `attached` |
| **B9** | 记性源世代热切换与退役<br>[apps/server/src/memory/sources.ts](apps/server/src/memory/sources.ts) | `held: SynchronizedRef`、`stopped: Ref<boolean>`、`generations: Set` 分离维护，退役时原地覆写 `g.why` 与 `g.retired` | 收敛进单个 `SynchronizedRef<SourcesState>`（`{ _tag: "active"; current?: { key: string; gen: Generation }; retiring: ReadonlyMap<Generation, { why: string; fiber: Fiber<void> }> } \| { _tag: "stopped" }`） |
| **B10** | 笔记库内存缓存与磁盘同步<br>[apps/server/src/pkm/pkm.ts](apps/server/src/pkm/pkm.ts) | `lock = Semaphore.make(1)`、`pages = Ref.make(new Map())`、`loaded = Ref.make(false)` 分离维护 | 合并为单一 `VaultCache = { _tag: "unloaded" } \| { _tag: "loaded"; pages: Map<string, Page> }`，由 `lock` 保护完成首次全量索引与按文件 `mtime` 增量刷新 |
| **B11** | `Brain` 运行、压缩与关闭协调<br>[packages/agent/src/brain.ts](packages/agent/src/brain.ts) | `stopping`、`closed`、`core: Agent \| undefined`、`folds`、`idleFold`、`accounting.active()` 分散在 6 处 | 先构建 `core` 再组装外层方法以消除 `core: undefined`；将顶层状态显式建模为 `{ _tag: "idle" } \| { _tag: "running"; stopping: boolean } \| { _tag: "compacting"; stopping: boolean } \| { _tag: "closed" }` |
| **B12** | `Agent` 循环流式回答折叠<br>[packages/agent/src/core/loop.ts](packages/agent/src/core/loop.ts) | `answer` 在 `Stream.runForEach` 外声明 `let partial`、`let ended`、`let failure`，流结束后靠多重条件补发 `message_start` 与拼装错误消息 | 用 `Stream.runFoldEffect` 驱动显式累加器 `AnswerFold = { _tag: "empty" } \| { _tag: "streaming"; partial: AssistantMessage } \| { _tag: "done"; message: AssistantMessage }`，在流結束与 `catchTag("LlmError")` 边界做一次穷尽转换 |

## 术 — 客户端 13 处隐式状态机收敛规格（L3 & L4）

| 编号 | 层级 | 模块与位置 | 现行隐式状态与反模式 | 目标显式状态机与错误契约 |
|---|---|---|---|---|
| **F1** | L3 | 通话客户端<br>[apps/web/src/features/voice/call.ts](apps/web/src/features/voice/call.ts) | `phase`、`muted`、`agentHere`、`problem`、`problemAt`、`line`、`agentId`、`starting`、`ending`、`cancel`、`pending[]` 及闭包 `cancelled`；`phase === "live"` 时续期失败直接写 `problem` | 收敛为单一 `VoiceCallState`（`Idle { fault?: UiFault } \| Connecting { cancel: () => void; line?: RtcLine; pending: PendingCaption[] } \| Live { line: RtcLine; agentId: string; muted: boolean; agentHere: boolean; warning?: UiFault } \| Ending { promise: Promise<void> }`），对外保留 `phase`、`problem`、`problemAt` 只读 getter |
| **F2** | L3 | MOSS 语音双帧配对<br>[apps/web/src/features/voice/moss-worker.ts](apps/web/src/features/voice/moss-worker.ts) | Worker 与主线程回退各自复制一套 `ws`、`opened`、`capturePort`、`playbackPort`、`pendingPiece` | 提取共用纯状态迁移函数 `stepMossWire(state, frame)`，状态定义为 `Disconnected \| Connecting \| Open { awaitingBinary?: AudioPieceMeta }` |
| **F3** | L4 | 消息悬浮工具栏与删除确认<br>[apps/web/src/features/channel/MessageParts.tsx](apps/web/src/features/channel/MessageParts.tsx)<br>[apps/web/src/farm/chat/Messages.tsx](apps/web/src/farm/chat/Messages.tsx) | 工作台 4 个布尔信号 `[picking]`、`[everyEmoji]`、`[sure]`、`[more]` 与农场 3 个布尔信号 `[open]`、`[sure]`、`[every]` 独立翻转，允许删除确认态与更多菜单同时打开 | 收敛为单一信号 `createSignal<ToolbarMode>("closed")`（取值 `"closed" \| "quickEmoji" \| "fullEmoji" \| "more" \| "confirmDelete"`），切换任一面板天然关闭其余面板 |
| **F4** | L4 | 频道页顶栏浮层与成员栏<br>[apps/web/src/features/channel/ChatPage.tsx](apps/web/src/features/channel/ChatPage.tsx) | `[tab]`、`[threadsOpen]`、`[search]`、`[settings]`、`[pinsOpen]`、`[membersOpen]` 各自独立；非 `"chat"` 标签页点击成员按钮会静默翻转 `membersOpen` | 顶栏浮层合并为 `HeaderOverlay = "none" \| "threads" \| "pins"`；点击 `members-toggle` 时若 `tab() !== "chat"` 则同步切回 `"chat"` 并展开成员栏 |
| **F5** | L4 | 农场世界加载与画布首帧<br>[apps/web/src/farm/world/load.ts](apps/web/src/farm/world/load.ts)<br>[apps/web/src/farm/canvas/VillageCanvas.tsx](apps/web/src/farm/canvas/VillageCanvas.tsx) | `useVillage` 返回 `{ village?: Village; error?: string }`，`VillageCanvas` 叠加 `[drawn]`、`[failed]` 与 DOM `dataset.ready` / `data-opening` | 收敛为 `CanvasStage = { kind: "loading" } \| { kind: "mounting"; village: Village } \| { kind: "ready"; village: Village } \| { kind: "failed"; error: string }`，DOM 属性由 `stage().kind` 声明式派生 |
| **F6** | L4 | 频道输入框补全与发送锁<br>[apps/web/src/features/channel/composing.ts](apps/web/src/features/channel/composing.ts) | 非响应式 `let sending = false` 与响应式 `commanding.busy()` 并存，`canSend()` 漏判 `sending`，普通消息发送途中发送按钮仍可点击 | 将发送阶段合并为响应式信号 `submitPhase: Accessor<"idle" \| "sending" \| "commanding">`，令 `canSend()` 统一读取 `submitPhase() === "idle"` |
| **F7** | L4 | 笔记大纲块编辑器焦点与补全<br>[apps/web/src/features/pkm/OutlineEditor.tsx](apps/web/src/features/pkm/OutlineEditor.tsx) | 按 `Escape` 关闭补全菜单时调 `setCaretAt(-1)`，用数值光标位置充当菜单关闭哨兵；用 `let handedOn = false` 加 `0ms` 定时器防失焦竞态 | 拆分为纯数值 `caretAt: Accessor<number>` 与显式 `dismissedTrigger: Accessor<string \| undefined>`；块拆分的焦点交接由父级 `OutlineEditor` 显式状态管理 |
| **F8** | L4 | 稿子协同块焦点与修订建议<br>[apps/web/src/features/artifact/BlocksView.tsx](apps/web/src/features/artifact/BlocksView.tsx) | 块焦点散落在 `[editing]`、`row.wanted`、`row.block.focused`、`editor.focusId` 与 `block.caret` 5 处，并在 `createEffect` 中直接命令式清空 `props.editor.focusId = undefined` | 在 `BlockEditor` 内统一用 `FocusTarget = { kind: "none" } \| { kind: "pending"; id: string; caret?: number } \| { kind: "active"; id: string }` 管理焦点生命周期 |
| **F9** | L4 | 长消息自动折叠与展开<br>[apps/web/src/features/channel/MessageParts.tsx](apps/web/src/features/channel/MessageParts.tsx)<br>[apps/web/src/farm/chat/Messages.tsx](apps/web/src/farm/chat/Messages.tsx) | `[long]` 与 `[open]` 独立维护；消息缩短后 `open` 仍可残留 `true` | 收敛为派生三态 `FoldState = "short" \| "folded" \| "expanded"`（当 `!long()` 时恒为 `"short"`） |
| **F10** | L3 | 启动遮罩多阶段就绪门禁<br>[apps/web/src/infra/opening.ts](apps/web/src/infra/opening.ts) | `cover.dataset.phase`、`page`、`content`、`failed` 及全文档 `MutationObserver` 扫描 `[data-opening="pending" \| "failed"]` | 建立内存状态机 `OpeningPhase`（`connecting -> reading -> loading -> waiting -> ready \| failed`），集中推进进度与阶段，DOM `dataset` 仅作为向后兼容输出 |
| **F11** | L3 | 乐观意图队列与帧追平确认<br>[apps/web/src/state/intent.ts](apps/web/src/state/intent.ts) | `status: "pending" \| "failed"` 混杂离线排队（`queued: true`）、在途请求与等待帧追平（`replied`）三态；错误仅存 `reason?: string` | 在 `Intent<I, R>` 上增加显式阶段 `phase: "queued" \| "sending" \| "confirming" \| "failed"` 与 `fault?: UiFault`（保留 `status`、`queued`、`replied`、`reason` 派生兼容），网络瞬态失败在帧流重连时可安全重试 |
| **F12** | L3 | 实时帧流连接与重连恢复<br>[apps/web/src/infra/frame.ts](apps/web/src/infra/frame.ts) | `frame?: StateFrame`、`link: "connecting" \| "open" \| "lost"`、`error?: string` 允许 `link === "open"` 且 `frame === undefined` | 内部状态收敛为 `Connecting \| Open { frame: StateFrame } \| Lost { lastFrame?: StateFrame; fault: UiFault }`，对外保持 `{ frame, link, error }` 形状不变 |
| **F13** | L3 | 表单校验、组合输入与提交状态机<br>[apps/web/src/infra/form/form.ts](apps/web/src/infra/form/form.ts)<br>[apps/web/src/ui/act.ts](apps/web/src/ui/act.ts) | `FormSnapshot` 用 `validating`、`submitting`、`submitted`、`composing` 4 个布尔值加闭包 `closed`、`scheduled`、`validation`、`controller`；`act.ts` 漏判 `502`/`503` 的 `ApiError` | 将表单异步流转收敛为显式阶段 `FormActivity = { kind: "idle" } \| { kind: "validating"; id: number; controller: AbortController } \| { kind: "submitting"; attempt: Attempt }`；修复 `act.ts` 对 `VibeValleyApiError` 的识别并透传 `UiFault` |

## 器 — 静态门禁与分批实施计划

### 静态检查与棘轮（防止回退）

1. **错误通道检查**：在 `scripts/oxlint-plugin.ts`（或结构测试）拦截 `Effect.tapError` 内向外部 `let` 变量赋值后再调 `Effect.option` 的旁路捕获模式，引导改用 `Effect.matchEffect` 或 `catchTag`。
2. **工具层错误完整性测试**：在 `apps/server/src/tool/tool.test.ts` 增加断言：当底层服务返回带 `next` 的 `Missing` 或 `Refused` 时，工具返回的文本必须包含 `next` 中的恢复提示。
3. **客户端 `act` 与 `intent` 错误分类测试**：在 `apps/web/src/state/intent.test.ts` 与表单测试中覆盖全部 6 种 `ApiError["_tag"]`（含 `503 VoiceUnavailable` 与 `502 VoiceCallFailed`）及网络断连 `ApiConnectionError`。

### 分批实施顺序

1. **第一批（全链路错误契约打通：修复断链 A、B、C）**：
   - 服务端：[apps/server/src/base/errors.ts](apps/server/src/base/errors.ts) 增加 `explainOf(e: ApiError)`；[apps/server/src/tool/schemas.ts](apps/server/src/tool/schemas.ts) 的 `toFailed` 接入 `explainOf`。
   - 客户端：[apps/web/src/infra/api.ts](apps/web/src/infra/api.ts) 增加 `UiFault` 与 `faultOf`；修复 [apps/web/src/ui/act.ts](apps/web/src/ui/act.ts) 对 `502`/`503` `ApiError` 的分类；升级 [apps/web/src/state/intent.ts](apps/web/src/state/intent.ts)。
2. **第二批（服务端核心执行与会话状态机：B7、B8、B2、B3、B4）**：
   - 收敛 `executor.ts`（`Allocation.phase`）、`session.ts` / `registry.ts`（`HandTurnState` 与 `Scope` 回滚）、`voice.ts`（`Grant` 与 `MossCallState`）与 `lan.ts`（`ListenerState` 与 `PairingState`）。
3. **第三批（服务端连接器、存储与模型循环状态机：B1、B5、B6、B9、B10、B11、B12）**：
   - 收敛 `connector/bridge.ts`、`session/host.ts`、`session/journal.ts`、`memory/sources.ts`、`pkm/pkm.ts`、`packages/agent/src/brain.ts` 与 `packages/agent/src/core/loop.ts`。
4. **第四批（客户端传输与组件交互状态机：F1–F13）**：
   - 收敛 L3（`call.ts`、`moss-worker.ts`、`frame.ts`、`opening.ts`、`form.ts`）与 L4（`composing.ts`、`MessageParts.tsx`、`Messages.tsx`、`ChatPage.tsx`、`VillageCanvas.tsx`、`OutlineEditor.tsx`、`BlocksView.tsx`）。

## 进度

2026-11-10 逐条到代码里核对过，又按 `let` 布尔、布尔信号、`-1` 哨兵在全仓扫过一遍（定下的写法已沉淀进 [模块设计](docs/style/module-design.md) 的「显式状态」，`practice:check` 的 `loose-flags` 拦新的散装 `let` 布尔）。

| 编号 | 状态 | 提交 | 做了什么，或为什么不改 |
|---|---|---|---|
| 错误契约（第一批） | 完成 | 本分支早先的提交 | `faultOf`、`UiFault`、`createAct` 认全部 `ApiError` |
| B2、B3 语音 | 完成 | `451722260` | `GrantPhase`（issued、starting、on）、`MossPhase`（waiting 带攒着的话、ready 带连接、closed）；`Call.ending` 永远等于 `life` 的 abort，删掉改读它 |
| B4、B5、B6、B8 | 完成 | 本分支早先的提交 | 局域网监听与配对、助手宿主的 `Caller`、轨迹草稿、执行器的 `Allocation.phase` |
| B7 帮工招人 | 完成 | `0db0d66c8` | 错误通道早先已改；`committed`、`released`、`registeredRow` 合成 `reached`（opening、recorded、committed、released） |
| B9 记性源 | 完成 | `714cdf167` | `stopped` 并进 `Held`（none、on、stopped）；退役合成一条记录，先记原因再中断，测试守着原因 |
| B12 agent 回答 | 完成 | `1199af053` | 流的失败作为最后一个元素，`Stream.runFoldEffect` 折成 `Answered`；先结束后失败的仍以结束为准 |
| B10 笔记缓存 | 不改 | — | 读写都在同一把锁里，`loaded` 只说「开机后扫过一遍」，和 `pages` 不会矛盾 |
| B11 `Brain` | 不改 | — | `stopping`（这一轮）和 `closed`（整个）是两个维度；`core` 是循环与工具互相需要打的结，构造完成前没人调 |
| B1 连接器 | 完成 | `2298f5972` | `progress` 和 `verifyCode` 合成 `signingIn`（登录中才有）；`account`（存下的账号）、`current`（工作纤程）、`loginTry`（跨登录的代号）各管一件，留着 |
| F3、F4、F6、F9 | 完成 | 本分支早先的提交 | 浮层、菜单、消息折叠一个联合；发送锁 `busy` 含发送中 |
| F7 大纲补全 | 完成 | `fe349dc5e` | Esc 记下关掉的那处触发（`offered`、`Shut`，在 `@vibevalley/pkm`），不再用光标 `-1`；列表不会在同一处的下一个键又冒出来 |
| F11 意图 | 完成 | `fe349dc5e` | `Intent` 按 `phase` 分的联合（`IntentAt`），删掉重复它的 `status`、`queued`、`reason`，失败的才有 `fault` |
| F1 通话客户端 | 不改 | — | `starting`、`ending` 是异步操作的去重，开始跑着时 `phase` 照样前进，不在一条线上 |
| F10 启动遮罩 | 不改 | — | 阶段已是协议的 `Opening["phase"]`；`data-opening` 是组件与遮罩约好的接口 |
| F12 帧流 | 不改 | — | 帧是 Solid store 逐 id reconcile，`open` 无帧只在一处构造、构造时不会出现；改成联合会整份重建画面 |
| F13 表单 | 不改 | — | 校验、提交、`submitted`、组字是独立维度，提交里本就要校验 |
| F2 MOSS Worker | 完成 | 本步的提交 | 不是状态机，是重复：Worker 原是内联的 JS 字符串，主线程另写一份。现在中继是一份 TypeScript（`moss-relay.ts`），Worker（`moss-relay.worker.ts`，照 `highlight.worker.ts` 用 `new URL` 加载）和没有 Worker 时的页面都跑它，事件有类型；关掉以后不再回调，两边一样。每秒一次的缓冲量改由页面已有的那一跳经 `measure` 去问，不再多一个定时器 |
| F5 农场加载 | 不改 | — | 只有 `useVillage` 一处写、每次只设 `village` 或 `error` 之一，读的五处都只问 `village` 在不在 |
| F8 稿子块焦点 | 不改 | — | 四样不同的东西：`focusId`、`caret` 是编辑器给视图的一次性请求（光标请求不换块也会发），`focused` 是协同合并要读的事实，`editing` 是视图自己的显示方式；并起来会把请求和事实混成一个 |
| 清单外 | 完成 | `ecc18f83d`、`2c35bc545`、`7f4d01a4b`、`922d9e4e0` | MOSS 引擎的 `stopped`、`cutting` 合成 `stop`；闪播流解析的 `stage`；`FlashPlayer` 一次播放一条 `Playing` 记录；聊天框的菜单（开着、失焦收起、Esc 关在一处触发，和大纲编辑器一个规矩）；聊天页的新建频道与搜索合成一个 `dialog`；视觉回答没给轮次就没有 `turn`，不再是 -1 |
| 清单外、看过不改 | — | — | `loose-flags` 报的另三处是独立维度：农场小狗（醒、被指、被按）、待办详情（改过、新建仓库对话框、自己写）、样式迁移脚本；`-1` 当「没高亮」的列表框下标是惯用写法 |

## Alternatives considered

- **引入 XState 或第三方状态机运行时**：XState 带来的配置 DSL 与独立解释器无法与 `Effect` 的 `Scope`、`SynchronizedRef`、`Cause` 通道直接组合，且增加客户端包体积。使用 TypeScript 判别联合加纯函数迁移、服务端 `SynchronizedRef`、客户端 `Atom` / `createSignal` 加 `variant()`，零外部依赖即可获得完整的编译期穷尽保证。
- **在组件层（`features/`、`farm/`）直接使用 `effect/reactivity` 的 `Atom`**：违反仓库 `vibevalley/atom-door` 门禁（`Atom` 仅限 `apps/web/src/state/` 封装，以便隔离 `effect/reactivity` 的实验性 API 变动）。组件层局部状态机应使用 Solid `createSignal<StateUnion>()` 搭配 `variant()`。
- **修改 HTTP 接口将服务端内部 `Schema.TaggedError` 全部暴露到线上协议**：客户端与 CLI 只需要闭合的 `ApiError`（6 种 `_tag`）加上可执行的 `next` / `settings` 即可完成展示与恢复；内部细粒度错误（如 `SqlError`、`NotClosed`）留在服务端内部按 `catchTag` 处理或转为 `Refused`，不污染线上契约。

## Acceptance criteria

- 四大错误消费端（CLI、模型工具层、页面 `createAct` / `useForm`、页面 `defineIntent` / 实时流）均无损消费 `ApiError`：模型工具输出包含 `next` 恢复提示，`createAct` 将全部 6 种 `ApiError`（含 `502`/`503`）准确识别为 `"rejected"`，客户端故障带有结构化 `UiFault`。
- 服务端 B1–B12 与客户端 F1–F13 内部消除平铺布尔组合、`-1` 光标哨兵与 `let refusal = ""` 旁路捕获；`Session.hire` 与 `Voice.start` 的中途失败回滚完全由 `Scope` / `Effect.acquireRelease` 驱动。
- 全仓通过 `vp check --deny-warnings`、`vp run effect:check`、`vp test`、`vp run notes:verify` 与 `vp run docs:verify`，公开协议与 SQLite 基线表结构保持不变。

## Risks

- **Solid 响应式粒度退化**：将多个信号合并为一个联合对象信号后，若读取端直接订阅整个对象并在每次字段微调时重建 DOM，会放大重渲染范围。投影访问器应返回基础类型（如 `const isSending = () => state().kind === "sending"`）或配合 `Keyed` / `variant` 按分支渲染。
- **锁内长耗时 I/O 阻塞状态读取**：在服务端将状态迁入 `SynchronizedRef` 后，若在 `modifyEffect` 闭包内直接等待外部子进程或网络请求，会阻塞并发的状态查询（如 `status`、`find`）。必须遵守「锁内只做状态校验、状态切换与 `FiberHandle` / `Deferred` 挂载，长耗时 I/O 在锁外纤程执行并回调更新状态」的边界。
