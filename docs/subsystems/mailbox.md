# Mailbox

## 一句话

每条消息之后，决定谁该听到、谁现在被叫醒、谁先攒着；是四层流水线的第二层。

## 管什么，不管什么

- **管**：受众路由（@、私聊、汇报、工单串、跟帖、频道）、三道刹车（跳数、冷却、熔断）、`mailbox_delivery` 状态机、叫醒/忙时提示、管家信箱、工单蓄水池与重试。
- **不管**：频道/串/消息本身（[频道](docs/subsystems/channel.md)）、工单状态和 DAG（[工单](docs/subsystems/issue.md)）、会话怎么跑（[帮工](docs/subsystems/session.md)）。来源标准化在 [Ingress](docs/subsystems/ingress.md)。

## 在哪

- `apps/server/src/mailbox/`：`mailbox.ts` 是服务，`routing.ts` 是“谁该听到”，`brakes.ts`/`breaker.ts`/`deliveries.ts` 是刹车和投递状态，`pump.ts` 是叫醒循环，`work.ts` 是工单蓄水池，`urgency.ts` 是四档紧急度。
- 表 `mailbox_delivery`、`mailbox_subscription`、`mailbox_issue`；频道消息与投递在同一事务里写。

## 模型和不变量

- **一条消息和它的投递在同一个事务里。** Channel 的 `post(w, heard)` 在锁和事务里调 Mailbox 的 `heard`；事务失败两边都从库重读。
- **宁可重复给，不丢。** 一轮没说话就结束、会话关掉、服务重启，交出去的投递回到 `pending`，再交一次。
- **刹车不持久。** 跳数/冷却/熔断只在内存；重启清零和今天一样，主人的话在提交后解除。
- **谁该听到是频道的账，刹车是信箱的账。** Channel 给有序收件人，Mailbox 逐条定 `heldBy` 并计数。
- **一个工单只留一条等人看的 cron 输入。** 新的 cron 输入把旧的 held 输入退回（`mailbox_issue_one_held`）；别的来源的 held 各自保留，PR 的多条 review 不会被合并掉。

## 怎么走

1. Channel 发出消息 / Ingress 收进 Trigger。
2. Mailbox 算收件人，上刹车，写投递行。
3. 空闲的会话被叫醒；忙的攒成一条提示；管家的流直接推给管家。
4. 启动/结束/关闭/压缩时回收或重投；工单变更可把等待的输入放进蓄水池。

## 和谁打交道

- 依赖 Channel（消息、串、已读）、Session（投递、叫醒、流）、Issue（蓄水池/工单上下文）、Core（事实与门禁）。
- 别人经 Mailbox 的 `say`/`speak`/`read`/`remove` 和 `forOrchestrator` 订阅它；频道不 import Mailbox。

## 为什么这样

- **投递状态只归一处。** 以前 Channel 既记话又记投递，两个写入方让内存和库对不上；拆出来后只有 Mailbox 写 `mailbox_delivery`。
- **同一事务保住“不会说了却没投”。** 先提交消息再投递会在中间重启时丢话；钩子在事务里写，失败一起回滚。

## 怎么验证

- `mailbox/*.test.ts`、`flows/mailbox-order.test.ts`、`flows/returns.test.ts`、`flows/handoff.test.ts`。
