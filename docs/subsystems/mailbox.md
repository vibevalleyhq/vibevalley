# Mailbox

## 一句话

每条消息之后，决定谁该听到、谁现在被叫醒、谁先攒着；是四层流水线的第二层。

## 管什么，不管什么

- **管**：受众路由（@、私聊、汇报、工单串、跟帖、频道）、三道刹车（跳数、冷却、熔断）、`mailbox_delivery` 状态机、叫醒/忙时提示、管家信箱、工单蓄水池与重试。
- **不管**：频道/串/消息本身（[频道](docs/subsystems/channel.md)）、工单状态和 DAG（[工单](docs/subsystems/issue.md)）、会话怎么跑（[帮工](docs/subsystems/session.md)）。来源标准化在 [Ingress](docs/subsystems/ingress.md)。

## 在哪

- `apps/server/src/mailbox/`：`mailbox.ts` 是服务，`routing.ts` 是“谁该听到”与四档紧急度，`brakes.ts`/`deliveries.ts` 是三道刹车和投递状态，`work.ts` 是工单蓄水池与投递写入，`payload.ts` 是触发记录与载荷读写，`pump.ts` 是叫醒循环。
- 表 `mailbox_trigger`（每条输入的 Trigger 和载荷，以及它的路由回执：所有来源的都记在这里，Ingress、频道、定时、工单经 `mailbox/payload.ts` 写）、`mailbox_delivery`、`mailbox_subscription`、`mailbox_issue`；同一批收件人的投递与路由回执在同一事务里写。

## 模型和不变量

- **来源先持久化，投递与回执原子提交。** Channel 提交消息与 Trigger 后直接调用 Mailbox；中途退出时，由 Channel 重放未路由消息，受众仍按频道规则计算。定时来源由 Cron 准备工单后重放，其他来源由 Mailbox 重放。
- **宁可重复给，不丢。** 一轮没有入模回执就结束、会话关掉、服务重启，交出去的投递回到 `pending`，再交一次。
- **跳数与冷却从投递回执恢复。** 使用路由顺序与实际投递时间；只有新的主人回执重置跳数，重复输入不重置。熔断按当前进程的连续失败计数。
- **谁该听到是频道的账，刹车是信箱的账。** Channel 给有序收件人，Mailbox 逐条定 `heldBy` 并计数。
- **调度只取仍需转交的输入。** 查询关联消费回执，跳过当前收件人的已转交输入和历史已消费输入；换人时只重投 pending、handed、left/reassigned 或尚无回执的输入。写入事务持有信箱写锁，再复核候选输入的消费回执；已消费输入的归属保留，仍能显式退回。
- **一个工单只留一条等人看的 cron 输入。** 新的 cron 输入把旧的 held 输入退回（`mailbox_issue_one_held`）；别的来源的 held 各自保留，PR 的多条 review 不会被合并掉。

## 怎么走

1. Channel 发出消息 / Ingress 收进 Trigger。
2. Mailbox 算收件人，上刹车，写投递行。
3. 空闲的会话被叫醒；忙的攒成一条提示；管家的流直接推给管家。
4. 启动/结束/关闭/压缩时回收或重投；工单变更可把等待的输入放进蓄水池。

## 和谁打交道

- 依赖 Session（投递、叫醒、流）、Agent（档案）、Core（事实与投影）与数据库；不 import Channel 或 Issue 服务。
- 频道和工单只开放具名读取：默认频道、频道管家、未读摘要与工单存在性；频道管家的线程继承和私聊选择在 Channel 的查询中解释。`modules.test.ts` 的 `foreignReads` 限定这些查询，Mailbox 不导入它们的整份查询模块，也不写它们的表。Trigger 与投递回执的事务写入归 Mailbox。
- Channel、Issue、Cron 直接调用 `receive`；管家订阅 `forOrchestrator`。投递前刷新工单投影，Session 结束派生出的 reviewing 门禁立即生效。

## 为什么这样

- **投递状态只归一处。** 以前 Channel 既记话又记投递，两个写入方让内存和库对不上；拆出来后只有 Mailbox 写 `mailbox_delivery`。
- **受众与投递分开。** 频道扇出只产生候选收件人；人类消息与机器任务输入先查工单订阅，命中进入 Tier 1；agent 间的提及与汇报保留频道受众，放行或无工单归属时共用 `posting.forward`。优先级、刹车、投递写入不因来源分叉。

## 怎么验证

- `mailbox/*.test.ts`、`flows/mailbox-order.test.ts`、`flows/returns.test.ts`、`flows/handoff.test.ts`。
