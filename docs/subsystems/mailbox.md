# Mailbox

`Mailbox` 是输入流水线的第二层。在外部或内部输入持久化为 `Trigger` 之后，`Mailbox` 决定受众路由、三道刹车与两级缓冲（Tier 1 工单蓄水池 → Tier 2 会话信箱），驱动空闲会话唤醒或忙时合并插话。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 受众路由与四档优先级、工单订阅（`mailbox_subscription`）与工单蓄水池（`mailbox_issue`） | 外部来源校验去重（[Ingress](docs/subsystems/ingress.md)）、频道/串/消息管理（[频道](docs/subsystems/channel.md)） |
| Agent 间三道刹车（跳数上限 `hopLimit`、冷却 `agentWakeCooldownMs`、空唤醒熔断 `wakeBreaker`） | 工单状态机与依赖解锁（[工单](docs/subsystems/issue.md)） |
| 会话投递状态机（`mailbox_delivery`：`pending` → `handed` → `consumed` / `dropped`）与唤醒循环 | 会话底层如何运行一轮（[帮工](docs/subsystems/session.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/mailbox/mailbox.ts` | 对外 `Mailbox` 服务接口 |
| `apps/server/src/mailbox/routing.ts` | 受众计算与四档紧急度排序 |
| `apps/server/src/mailbox/brakes.ts`、`deliveries.ts` | 三道刹车计算与未终结投递缓存 |
| `apps/server/src/mailbox/work.ts` | 工单蓄水池（Tier 1）、退回转交（`handback`）与投递写入（`forward`） |
| `apps/server/src/mailbox/triggers.ts` | 服务内部的触发器记录、读取、来源查询与 cron 重放 |
| `apps/server/src/mailbox/payload.ts`、`envelope.ts` | 共享形状、编码与纯转换，不读写数据库 |
| `apps/server/src/mailbox/pump.ts` | 空闲会话唤醒、忙时批次 `steer` 与管家流推送 |

## 模型和不变量

- **触发器存储只经 Mailbox 服务**：上游调用 `recordTrigger`（频道消息的触发带上它自己的 id）、`readTrigger`、`knownGitHubEvents` 与 `replayCronTriggers`，不传 `Db` 或 SQL 参数。记录方法参与调用方的事务，不另起纤程、不投递或唤醒；重复来源保留第一次记录的触发器和原文。`unreadSummary` 统一读取未读摘要。
- **跨模块入口由检查限定**：外部只导入 `mailbox.ts` 服务或 `payload.ts`、`envelope.ts`、`prompts.ts` 共享契约。共享契约不能导入数据库、基础设施或模块内部实现；`modules.test.ts` 同时检查直接导入、重导出与字面量动态导入。
- **来源先落库，投递行与路由回执同事务提交**：
  - 上游经 Mailbox 记录 `Trigger`，来源游标可与它在同一事务内提交；提交后再调用 `Mailbox.receive`。
  - `Mailbox` 在同一事务内写入 `mailbox_delivery` 并更新 `mailbox_trigger` 的路由回执；中途崩溃时于重启后重放。
- **至少投递一次，真实入模才算消费（`consumed`）**：
  - 投递交给会话时标为 `handed`；仅当 `Session.news` 传来 `Consumed` 回执时才标为 `consumed`。
  - 若回合结束、会话关闭或服务重启时仍未收到回执，`handed` 自动退回 `pending` 重新投递。
- **两级缓冲（工单蓄水池 Tier 1 → 会话信箱 Tier 2）**：
  - 发往工单的输入先匹配 `mailbox_subscription` 进入 `mailbox_issue`。
  - 工单排队或处于等待主人状态时，自动输入保持 `held`（同一工单仅留最新一条 cron 输入）。
  - 工单就绪或主人新发言放行时，转入当前负责会话的 `mailbox_delivery`。
- **三道刹车仅约束 agent 唤醒 agent，主人发言随时放行并重置**：
  - **跳数限制（`hopLimit` = 4）**：同一频道或工单作用域内，自上次主人发言起连续自动唤醒不超过 4 次。
  - **冷却窗口（`agentWakeCooldownMs` = 60s）**：同一帮工被其他 agent 唤醒至少间隔 60 秒。
  - **空唤醒熔断（`wakeBreaker` = 3）**：同一帮工连续 3 次被唤醒却未开口即结束，暂停自动唤醒直至主人再次对它发言。
  - 被拦截的投递记录 `held_by`，可随下一次合法运行一并带上。

## 怎么走

1. `Channel`、`Ingress`、`Issue` 或 `Cron` 经 Mailbox 服务持久化 `Trigger`，提交后调用 `Mailbox.receive`。
2. `Mailbox` 在信箱写锁内计算受众、检查工单蓄水门禁与三道刹车，原子写入 `mailbox_delivery` 与路由回执。
3. `pump.ts` 唤醒空闲帮工、对正忙帮工攒批（`chat.notice_batch_ms` = 3s）发送插话提示，或把一段对话交给管家：`Mailbox.news` 的 `Handed`（管家由管家模块来答，帮工经 `Session.deliver` 唤醒）。
4. 会话换人或关单时，未消费的主人追问以确定性返回编号转交新负责人或管家。

## 和谁打交道

- **底层依赖（`session`、`agent`、`core`）**：调用 `Session.deliver` 投递输入，订阅 `Session.news`（`Consumed`、`Returned` 和启动的 `Spoke`、`Ended`、`HandedOff`、`Settling`、`Closed`、`Compacting`）推进状态机。
- **上层调用方（`channel`、`issue`、`cron`、`ingress`、`orchestrator`）**：不反向 import 上层服务；对频道与工单的只读查询经窄查询完成。

## 为什么这样

- **集中管理 `mailbox_trigger` 与 `mailbox_delivery`，消除双写失步**。触发记录与投递状态统一收归 Mailbox 层，保证下层不写上层表且缓存与数据库严格一致。
- **受众计算与投递控制解耦**。频道只回答「谁在场、关注了哪个串」，工单蓄水、优先级、三道刹车和重试统一在 Mailbox 执行。

## 怎么验证

- `apps/server/src/mailbox/triggers.test.ts`：来源游标与触发器共同回滚、重复来源保留原文、记录与重放读取不隐式路由。
- `apps/server/src/mailbox/*.test.ts`、`apps/server/src/flows/mailbox-order.test.ts`、`flows/returns.test.ts`、`flows/handoff.test.ts`：投递顺序、三道刹车、工单蓄水、换人退回与重启重放测试。
