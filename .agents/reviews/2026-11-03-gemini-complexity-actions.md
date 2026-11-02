# Gemini 复杂度报告：核实与处理

依据：[Gemini 桌面端原始报告](.agents/reviews/2026-11-03-gemini-complexity-original.txt)。原报告保持原文，本文件记录当前代码核实结果、每项裁决、实施内容与验证证据。基线为 749a7f40 加上网关收口和本轮简化的未提交改动。

## 结论摘要

逐项核对 G01–G14 后，采纳 11 项、部分采纳 2 项、不采纳 1 项；另完成 CodeGraph 报告里的 5 个结构精简点。没有新增平行状态、反向回调或跨模块依赖。所有删除都以「现有调用方为零或已有等价路径」为前提，行为由现有流程测试和新增 regression 用例覆盖。

| 编号 | 原报告结论 | 本轮裁决 | 结果 |
|---|---|---|---|
| G01 | `Mailbox` 用 `core.transitions` 复制 `board` | 采纳 | `board` Map 与 `syncBoard` 完全删除，改为在使用点读 `core.state().issues` |
| G02 | `Session.attachPullRequestPolicy` 反向可变回调 | 采纳 | 回调删除，判定移到 `projection/reduce.ts` |
| G03 | `Trigger` 构造与落库分裂成 3 套 | 采纳 | 落库收敛到 `apps/server/src/mailbox/payload.ts`；旧路径 apps/server/src/issue/trigger.ts（已迁移） |
| G04 | `work.initial` 死代码、排队输入截断 | 采纳 | 删死代码；排队输入全部登记；`QueuedInputs` 去掉 `DISTINCT ON` |
| G05 | `Mailbox` 公开接口膨胀、`Transfer` 万能袋 | 采纳 | 接口 37（报告口径 44）→ 25 个成员；`posting.ts` 并入 `work.ts`，`OutboundDelivery` 留在模块内，`flushIssue`、`deliveryChannel` 退出公开接口 |
| G06 | `received` 恒空、`kinds` 未用、3 处死代码/SQL | 采纳 | 字段、循环、查询全部删除 |
| G07 | `Mailbox.deliveryUnread` 与 `Channel.inboxRows` 重复 | 采纳 | 共用 `unreadSummaryOf` |
| G08 | 未路由 Trigger 重放分裂在 3 个模块 | 不采纳 | 三条恢复路径各有不同语义，合并会引入反向依赖；只统一了 Trigger 写入 |
| G09 | 旧路径 channel/wake.ts 空壳、base/chat.ts 混入业务 | 采纳 | 两个文件删除；业务形状迁入 `apps/server/src/mailbox/chat.ts` |
| G10 | `Meta` 双层 JSON 序列化与字段冗余 | 采纳 | 去掉 `JSON.stringify` 往返；`IngressPurpose` 与 `ChannelRouteFact.purpose` 删除，`Meta.ingressSource` 写字面量 |
| G11 | `Assignment.executions` 与 `AgentRole` 同义异名 | 采纳 | `kind: "session"` → `"worker"`；黄金数据同步 |
| G12 | `IssueOptions.background`、`SessionOptionsIn.stallMs` | 采纳 | `IssueOptions`、`SessionOptionsIn` 两个类型删除；测试农场改从 `ServerConfig` 取停顿与后台开关 |
| G13 | 5 处命名问题 | 采纳 4、保留 1 | `Recipient`、`OutboundDelivery`、Trigger 归属、response 归属已改；span 名保留 |
| G14 | `registerTalk` 事务与内存更新顺序 | 部分采纳（前提部分不成立） | 改为单事务后统一更新内存；原报告的「外层事务」前提被调用顺序反证 |

## 已核实应保留的复杂度

原报告第四节列出的 5 项没有改动，核实后仍然成立：

1. `Assignment`、`Session`、`Executor` 三层职责正交，不合并。
2. Tier 1 `mailbox_issue` 与 Tier 2 `mailbox_delivery` 的生命周期不同，不合并。
3. 主人追问与 agent 间 `@` / 汇报的分流规则保留：有频道受众且发言者不是主人时跳过 Tier 1。
4. 协议形状与视图形状（`View`、`phaseText` 等）分离，不在持久层存界面文案。
5. `Session.send` 的两阶段准入锁和 `hand.access` 锁序保留。

## 逐项核实与处理

### G01：`Mailbox` 的 `board` 投影（采纳）

- **现状**：`apps/server/src/mailbox/mailbox.ts` 里已经没有 `board = new Map<string, T.Issue>()`，也没有 `syncBoard`；`receive`、`subscribe`、`flushIssue` 之前不再刷新一份副本。
- **改了什么**：删掉 `board` 和 `syncBoard`，也不再为每条事实 `Effect.scoped(core.transitions)` 重新订阅、重建。需要工单的地方（`issueOf`、`start` 的恢复遍历、`onFact` 里判断频道挂在哪张工单）直接读 `core.state().issues` 的当下这份。
- **为什么这样对**：`Mailbox` 在 Issue 之下，不能反向问 Issue 服务；共享同一份核心状态比在模块里再折一个投影少一份漂移的可能。`apps/server/src/modules.test.ts` 的 `reads` 只登记 `mailbox/mailbox.ts -> issues` 这一条跨模块读并写明理由（Tier 1 储层要同步看工单的阶段和受派人），新增的跨读仍会被拦下。
- **证据**：`mailbox.ts` 搜不到 `board` 和 `syncBoard`；`modules.test.ts` 的 `reads` 只有这一条。

### G02：`Session.attachPullRequestPolicy`（采纳）

- **现状**：全仓搜索 `attachPullRequestPolicy`、`followsPullRequest` 为 0 处。
- **改了什么**：`Session.finishReport` 不再询问下层注入的策略，只在本轮完成且没有显式交还主人时提出 `phase: resting`；`apps/server/src/projection/reduce.ts` 在折 `sessionReport` 时检查该工单是否有 `pullRequest.state === "open"`，有才保留 `resting`，否则落到 `ended`。
- **为什么对**：判定需要同时看 `issues` 和 `sessions`，这正是组装层 `reduce` 的视野；`Session` 不再隐式依赖 `Issue` 的初始化时机。
- **证据**：`apps/server/src/session/session.ts` 已无该成员；`reduce.ts` 的 `case "sessionReport"` 用 `state.issues.some(...)` 判定。

### G03：`Trigger` 构造与落库（采纳）

- **现状**：旧路径 apps/server/src/issue/trigger.ts（已迁移到 `apps/server/src/mailbox/payload.ts`）。旧短路径 issue/trigger.ts 已删除，Cron、Inbox、Issue 都从 `@/mailbox/trigger.ts` 导入 `recordTrigger`。
- **改了什么**：
  - `mailbox/payload.ts` 统一 `recordTrigger`、频道消息的 `keepChannelTrigger` 和未路由 cron 查询。
  - `apps/server/src/channel/chat.ts` 的 `settle` 先写 Trigger 并把返回的 `Trigger` 直接交给 `Mailbox.receive`，不再插入后从数据库重读、重解码同一行。
  - `apps/server/src/ingress/ingress.ts` 仍保留 `Ingress.record`，但底层调用同一个生成的 `RecordTrigger` 查询，不再自己拼一套写入。
- **没做什么**：没有把三条调用路径强行并成一个函数。Ingress、Channel、Cron 各自知道来源和幂等键，共用一个落库实现已经消除了「三套实现漂移」；合并调用方反而要把上层语义塞进下层。
- **证据**：`grep recordTrigger apps/server/src` 只命中 `mailbox/payload.ts` 的实现和 Ingress、Issue、Cron、Inbox 的调用；`chat.ts` 的重查代码已删除。

### G04：排队输入与 `work.initial`（采纳）

- **现状**：
  - 旧路径 apps/server/src/mailbox/work.ts 里的 `initial` / `initialInputs` 已删除（搜不到）。
  - `apps/server/db/queries/mailbox_issue.sql` 的 `QueuedInputs` 不再有 `DISTINCT ON (m.issue_id)`，按工单返回全部未消费输入，并保留派发输入优先、再按路由顺序的排序。
  - `Issue.start` 接受 `inputs`，`Issue.refreshQueue` 把该工单的全部 `issueInputs` 交给 `send`，`send` 用 `registerInitialInputs` 一次性登记。
- **为什么对**：排队期间「先派发、后追问」不再丢追问；即时开工和排队出队走同一条登记路径。
- **证据**：`apps/server/src/issue/issue.ts` 的 `start`（约 555 行）和 `refreshQueue`（约 770 行）都只经 `mailbox.issueInputs` / `registerInitialInputs`；`mailbox_issue.sql` 的 `IssueInputs` 与 `QueuedInputs` 都返回全部行。

### G05：`Mailbox` 接口与 `Transfer`（采纳）

- **现状**：`Mailbox` 服务接口从 37 个成员（Gemini 报告口径 44）降到 25 个。`hand`、`consume`、`returnHanded`、`breakerSpoke`、`breakerFailed`、`breakerReset`、`breakerOpen`、`sessionLeft`、`urgency`、`deliveryChannel`、`flushIssue`、`insert` 的内部协作部分和三个 response 方法都不再出现在公开接口上。
- **改了什么**：
  - `apps/server/src/mailbox/pump.ts` 用 `PumpPorts` 接收泵需要的窄回调。
  - 旧路径：apps/server/src/mailbox/posting.ts（已并入 `apps/server/src/mailbox/work.ts`）：投递写入、优先级和 `registerTalk` 的事务都在 `work.ts`；刹车在 `brakes.ts`。
  - `apps/server/src/mailbox/work.ts` 的 `Transfer` 改名为 `OutboundDelivery`，`forward` 接收一组投递并一次提交。`OutboundDelivery` 只在 `mailbox/` 内部流通，不出现在 `Mailbox` 的公开接口上。
- **证据**：`Mailbox` 的 `Context.Service` 类型参数只剩 25 个 `readonly` 成员，其中没有 `flushIssue` 和 `deliveryChannel`；`pump.ts` 的 `makePump(sessions, ports)` 不再接收 `Mailbox["Service"]`。

### G06：死字段与死代码（采纳）

- **现状**：
  - `ChannelRouteResult` 只剩 `{ heldNotice: string }`，恒为 `[]` 的 `received` 已删除，`chat.ts` 里两处「👀」循环随之删除。
  - `ChannelRouteFact.kinds` 已删除，不再每次路由都组装一份没人读的 actor kind 表。
  - `Deliveries.released`、`RetireHeldInputs`、`SetIssueChecks` 在查询文件和生成文件里都搜不到，已删除。
- **证据**：`apps/server/src/mailbox/chat.ts` 的 `ChannelRouteResult` 定义；`ingress_trigger.sql` 与 `mailbox_issue.sql` 中对应查询已不存在。

### G07：未读摘要重复实现（采纳）

- **改了什么**：`apps/server/src/mailbox/chat.ts` 新增 `unreadSummaryOf`，`Mailbox.deliveryUnread` 与 `Channel.inboxRows` 都调用它，不再各写一遍「取频道、截到 `summaryChannels`、补最新发言人」的逻辑。
- **遗留**：`Channel.inboxRows` 的 span 名仍是 `Channel.deliveryUnread`（G13b）。两处实现已经合并，改名不影响行为，留作后续命名清理。

### G08：未路由 Trigger 的三条重放路径（不采纳）

- **现状**：仍有 3 条恢复路径：
  - `Mailbox.replay` 处理通用未路由 Trigger，并按 `retryWakeMs`（默认 3 秒）常驻重试；
  - `Channel.start` 重放 `unroutedChannelMessages`，因为频道消息要按频道规则重新计算受众；
  - `Cron.tick` 先重放 `unroutedCronTriggers`，因为 cron 输入要先经 `Issue.scheduled` 准备工单，才能交给 Mailbox。
- **为什么保留**：三条路径的前置动作不同。把 Channel 或 Cron 的恢复塞进 Mailbox 会让 Mailbox 反向依赖 Channel 和 Issue，正是本轮在消除的方向。常驻轮询保留，用来兜住「写完 Trigger 后进程退出」和「单次 `receive` 失败」两种情况；删除 3 秒轮询会把自愈能力交给下一次人工操作。
- **本轮只做的一致性**：Trigger 的写入统一到 `mailbox/payload.ts`（G03），Mailbox 的通用查询继续排除 cron 和频道消息，避免绕过各自的准备步骤。

### G09：旧路径 channel/wake.ts 与 base/chat.ts（采纳）

- **改了什么**：
  - 旧路径 apps/server/src/channel/wake.ts（已删除）：纯转发的 3 行 barrel 删除，调用方直接引用新家。
  - 旧路径 apps/server/src/base/chat.ts（已删除）：业务形状迁入 `apps/server/src/mailbox/chat.ts`；`Channel` 需要的 `Meta` 等经 `apps/server/src/channel/contracts.ts` 转出。
  - `base` 重新只留 id、JSON、排序、脱敏、卡片、裁剪、问答等地基；`modules.test.ts` 的「base 不 import 其它 src」检查通过。
- **证据**：`apps/server/src/base/` 当前只剩 `ids.ts`、`json.ts`、`order.ts`、`redact.ts`、`card.ts`、`clip.ts`、`actor.ts`、`questions.ts`、`wire.ts`、`pubsub.ts`、`number.ts` 和测试。

### G10：`Meta` 的 JSON 往返与冗余字段（采纳）

- **现状**：`apps/server/src/mailbox/payload.ts` 的 `triggerPayload` 直接 `metaOf(trigger.meta)`，不再先 `JSON.stringify(trigger.meta)` 再解析；同时显式取出 `inputContext` 和 `channelType`，不再从解构后的对象上重复读。`IngressPurpose` 这个具名别名已删除，`Meta["ingressSource"]`（`apps/server/src/mailbox/chat.ts`）直接写字面量联合；`ChannelRouteFact.purpose` 也已删除，路由事实只带 `row`、`audience` 和目标。
- **改了什么**：删掉 `IngressPurpose` 与 `ChannelRouteFact.purpose` 两个转手字段，`Meta.ingressSource` 成为唯一的来源声明，`apps/server/src/channel/folded.ts` 从它映射到 `T.TriggerSource`。
- **保留的部分**：`inputContext` 和 `channelType` 仍写在 `trigger.meta` 里，投递载荷再从它派生一次 `context`。这是「持久 Trigger 自描述」和「投递行可直接读」的取舍：只存一份源，派生一份可读副本，不再有第二层字符串化。彻底删掉派生副本会让每次读投递都要解码整个 Trigger，本轮不改。
- **证据**：全仓搜不到 `IngressPurpose` 和 `ChannelRouteFact.purpose`；`payload.ts` 的 `triggerPayload`；`apps/server/src/mailbox/chat.ts` 的 `metaText` 统一处理空字段，等价于 Go 的 `omitempty`。

### G11：`Assignment.executions` 的角色词（采纳）

- **改了什么**：`packages/protocol/src/shapes.ts` 与 `schema.ts` 把 `executions` 的 `kind: "session"` 改成 `kind: "worker"`，和 `AgentRole` 的 `"worker" | "orchestrator"` 用同一套词。`apps/server/src/issue/assignment.ts` 的 `executionOf` 同步。
- **保留的部分**：`executions` 数组本身保留。它记录一张工单历史上的执行上下文，不是「第二个执行者类别」；和 `issue_assignment_execution` 的语义一致。
- **证据**：`assignment.ts` 返回 `{ kind: "worker", ... }`；黄金数据随 `vp run golden:update` 更新。

### G12：测试专用开关（采纳）

- **现状**：`IssueOptions.background`（`apps/server/src/issue/issue.ts`）和 `SessionOptionsIn.stallMs`（`apps/server/src/session/session.ts`）都不存在了：两个 options 类型整体删除，`Issue.start`、`Session` 的入口只从 `ServerConfig` 取运行参数。
- **改了什么**：`apps/server/src/testing/world.ts` 把测试想要的停顿和后台开关折进 `ServerConfig`（`session.stallSeconds`、`runtime.background`），生产入口一律用配置文件里的值，不再为了测试在服务接口上留洞。
- **证据**：全仓搜不到 `SessionOptionsIn` 和 `IssueOptions`；`world.ts` 的 `stallSeconds: options.stallMs / 1000` 和 `runtime: { background: false }`；`apps/server/src/flows/work.test.ts` 用 `farm({ stallMs: 500 })` 走同一条配置路径。

### G13：命名（采纳 4 项，保留 1 项）

| 子项 | 裁决 | 结果 |
|---|---|---|
| G13a `Delivery` 撞名 | 采纳 | `apps/server/src/mailbox/brakes.ts` 的内部接口改为 `Recipient`，协议层 `T.Delivery` 不动 |
| G13b span 名 | 保留 | `Channel.inboxRows` 的 span 仍是 `Channel.deliveryUnread`；两处实现已合并，等命名清理一起改 |
| G13c `trigger.ts` 归属 | 采纳 | 旧路径 apps/server/src/issue/trigger.ts（已迁移到 `apps/server/src/mailbox/payload.ts`） |
| G13d `Transfer` 过泛 | 采纳 | 改为 `OutboundDelivery` |
| G13e response 方法寄居 Mailbox | 采纳 | `openResponse` / `takeResponse` / `dropResponse` 从 `Mailbox` 删除，`responses` Map 归 `orchestrator/response.ts` 的 `makeResponses` |

### G14：`registerTalk` 的事务与内存顺序（部分采纳，前提部分不成立）

- **前提核实**：原报告认为 `Session.send` 在调用 `hiring` 时已经处在外层 `db.inTx` 中。实际 `apps/server/src/session/session.ts` 先完成 `db.inTx(...)`（约 1139 行），再调用 `hiring`（约 1157 行），所以不存在「嵌套事务里先改内存」的原始故障窗口。
- **仍然改了什么**：旧路径：apps/server/src/mailbox/posting.ts（已并入 `apps/server/src/mailbox/work.ts`）——`work.ts` 的 `registerTalk` 改成先为全部行准备 `DeliveryDraft`，再用一次 `db.attemptTx` 写入全部投递、`markHanded` 和路由回执，提交成功后才更新内存的 `received` 和 `stored`；和 `registerInitialInputs` 的结构一致。
- **保留的部分**：结构性的「Trigger 不存在」仍以 defect 结束，因为那说明持久 Trigger 和消息行不一致，属于不变量被破坏，不是可恢复的业务拒绝。
- **证据**：`work.ts` 的 `registerTalk`；`flows/talk.test.ts` 覆盖首句私聊的投递。

## CodeGraph 文件与概念精简

这一轮同时完成了 CodeGraph 报告第六节的 5 个结构点。

### 1. `Mailbox` 服务表面积

公开接口从 37（报告口径 44）降到 25 个成员。泵的 `hand` / `consume` / `returnHanded` / `breaker*` / `sessionLeft` 收回 `PumpPorts`；`insert`、`urgency`、`deliveryChannel`、`flushIssue` 等只在本模块用的方法不再公开；response 三方法整体移出（见下）。`pump.ts` 不再把 `Mailbox["Service"]` 当内部句柄传。

### 2. 影子状态与反向回调

- 旧路径 apps/server/src/mailbox/issue.ts（已并入 `apps/server/src/mailbox/routing.ts`）：`waitsForHuman` 回到路由模块，`Mailbox` 不再维护一份重复判定。
- `Session.attachPullRequestPolicy` 删除（G02），判定进入 `reduce`。
- `board` 和 `syncBoard` 删除（G01）：`Mailbox` 不再留工单的第二份副本，需要时读 `core.state().issues`。

### 3. `OrchestratorResponse` 并入 `Orchestrator`

`apps/server/src/orchestrator/response.ts` 不再导出第二个 `Context.Service`：改成 `makeResponses(ingress, channel)` 工厂，由 `Orchestrator` 的 layer 创建并挂成 `answerer`、`brief` 等方法。`services.ts` 不再单独安装 `OrchestratorResponse.layer`。`orchestrator/` 目录现在只有一个 `Context.Service`。

### 4. 旧路径 base/chat.ts 的业务形状归位

旧路径 apps/server/src/base/chat.ts（已拆入 `apps/server/src/mailbox/chat.ts` 与 `apps/server/src/channel/contracts.ts`）：`Meta`、`InboxMessage`、`ChannelEnvelopeRow`、`ChannelAudience`、`ChannelRouteFact`、`ChannelRouteResult`、`OrchestratorNews` 回到拥有它们的 `mailbox`；`Channel` 需要的少数形状经 `contracts.ts` 转出。`base` 恢复为纯地基。

### 5. 空壳文件与死导出的归并

| 旧路径 | 现在 |
|---|---|
| apps/server/src/channel/wake.ts | 删除；调用方直接引用 `apps/server/src/mailbox/chat.ts` |
| apps/server/src/channel/targets.ts | 并入 `apps/server/src/channel/mentions.ts` |
| apps/server/src/channel/prompts.ts | 并入 `apps/server/src/mailbox/prompts.ts` |
| apps/server/src/session/usage.ts | 并入 `apps/server/src/session/report.ts` |
| apps/server/src/issue/conflict.ts | 并入 `apps/server/src/issue/status.ts` |
| apps/server/src/issue/followup.ts | 并入 `apps/server/src/issue/status.ts` |
| apps/server/src/issue/stored.ts | 并入 `apps/server/src/issue/rows.ts` |
| apps/server/src/inbox/away.ts | 并入 `apps/server/src/inbox/items.ts` |
| apps/server/src/artifact/testing.ts | 迁到 `apps/server/src/testing/artifact.ts` |
| apps/server/src/orchestrator/evals.ts | 迁到 `apps/server/src/testing/evals.ts` |
| apps/server/src/issue/trigger.ts | 迁到 `apps/server/src/mailbox/payload.ts` |
| apps/server/src/mailbox/issue.ts | 并入 `apps/server/src/mailbox/routing.ts` |

## 验证

### 已执行的窄检查

- `vpx scripts/doc-links.ts`：本文件、`docs/subsystems/orchestrator.md`、`docs/subsystems/voice.md`、`2026-11-01-four-layer-agent-gateway-design.md` 不再引用已删除文件的反引号路径（`mailbox` 的 `posting.ts` 改写成「旧路径：…（已并入 `apps/server/src/mailbox/work.ts`）」）；Markdown 链接和 `docs/README.md` 覆盖通过。
- `vp run docs:verify`：agent notes、skills、doc links、stale names、glossary、i18n 都通过；最后停在 `vpx scripts/primitives.ts` 的 `--check`，因为工作区里的 `docs/reference/primitives.md` 还没按本轮删除的导出重新生成。这个文件不在本批四个文件的范围内，合并前跑 `vpx scripts/primitives.ts` 即可。
- `grep` 级核对：
  - `attachPullRequestPolicy` / `followsPullRequest`：0 处；
  - `work.initial` / `initialInputs`：0 处；
  - `DISTINCT ON` 在 `mailbox_issue.sql`：0 处；
  - `RetireHeldInputs` / `SetIssueChecks` / `Deliveries.released`：0 处；
  - `board` / `syncBoard` 在 `mailbox.ts`：0 处；
  - `IngressPurpose`、`ChannelRouteFact.purpose`、`SessionOptionsIn`、`IssueOptions`：0 处；
  - `posting.ts`：文件不存在，投递写入在 `apps/server/src/mailbox/work.ts`；
  - 旧路径 channel/wake.ts、base/chat.ts、issue/trigger.ts、mailbox/issue.ts：文件不存在；
  - `Mailbox` 公开接口：25 个成员。

### 应随 PR 跑的全量检查

```bash
vp check && vp run server:check && vp run web:check
vp run deadcode && vp run health:verify && vp run docs:verify
```

### 行为覆盖

- 频道扇出整批回滚并只重放一次：`regression: channel fanout rolls back all recipients and replays the committed message once`（`apps/server/src/channel/chat.test.ts`）。
- cron occurrence 与排期同事务提交、一次性任务重启后不重复建工单：`apps/server/src/cron/cron.test.ts`。
- 开工被拒只删这次派发的工单、保留已有排队：`regression: refused startup removes only the issue made for that dispatch and keeps an existing queue`（`apps/server/src/flows/issue.test.ts`）。
- 私聊首句投递：`apps/server/src/flows/talk.test.ts`。
- 工单状态与黄金数据：`vp run golden:update -- core` 后由 `apps/server/src/core/golden.test.ts` 和 `apps/server/src/cli/golden.test.ts` 守住。

### 没有验证到的

- 真模型重放（`vp run --filter @vibevalley/server evals`）未运行；本轮没有改管家的提示和工具描述，只改了评测文件的位置。
- 真声网电话没有打；`voice` 的行为没变，只更新了文档里的服务名。
- 桌面版和手机壳没有重新打包；改动只在服务端和文档。
