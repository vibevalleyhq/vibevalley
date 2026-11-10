# Mailbox

`Mailbox` 负责触发留痕与会话投递调度：将外部或内部来源事件按 `(source, key)` 幂等记为不可变的 `Trigger`，计算受众路由、三道刹车与两级缓冲（Tier 1 工单蓄水池 → Tier 2 会话信箱），驱动空闲会话唤醒或忙时合并插话。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 来源事件按 `(source, key)` 幂等落库（`mailbox_trigger`），分离轻量控制头与只读原始载荷 | 频道/串/消息存储（[频道](docs/subsystems/channel.md)）、GitHub PR 分页快照与指纹比对（[仓库](docs/subsystems/repo.md)、[工单](docs/subsystems/issue.md)） |
| 受众路由与四档优先级、工单订阅（`mailbox_subscription`）与工单蓄水池（`mailbox_issue`） | 工单状态机与依赖解锁（[工单](docs/subsystems/issue.md)） |
| Agent 间三道刹车（跳数上限 `hopLimit`、冷却 `agentWakeCooldownMs`、空唤醒熔断 `wakeBreaker`） | `vv://` 资源按会话权限裁剪与分页读取（[助手](docs/subsystems/orchestrator.md) 的 `tool/resource.ts`） |
| 会话投递状态机（`mailbox_delivery`：`pending` → `handed` → `consumed` / `dropped`）与唤醒循环 | 会话底层如何运行一轮（[帮工](docs/subsystems/session.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/mailbox/mailbox.ts` | 对外 `Mailbox` 服务接口（含 `record`、`accept`、`recordTrigger`、`receive`、`withdraw`、`news` 等） |
| `apps/server/src/mailbox/shapes.ts`、`schema.ts` | 服务端私有的 `Trigger`、`Envelope` 与投递编码契约 |
| `apps/server/src/mailbox/payload.ts`、`envelope.ts` | 来源载荷编码、共享形状与纯转换，不读写数据库 |
| `apps/server/src/mailbox/triggers.ts` | 触发器幂等写入、原始载荷读取、来源查询与 cron 重放 |
| `apps/server/src/mailbox/routing.ts` | 受众计算与四档紧急度排序 |
| `apps/server/src/mailbox/brakes.ts`、`deliveries.ts` | 三道刹车计算与未终结投递缓存 |
| `apps/server/src/mailbox/work.ts` | 工单蓄水池（Tier 1）、退回转交（`handback`）与投递写入（`forward`） |
| `apps/server/src/mailbox/pump.ts` | 空闲会话唤醒、忙时批次 `steer` 与助手流推送 |

## 模型和不变量

- **一个 `(source, key)` 只产生一条不可变 `Trigger`**：
  - `record` / `recordTrigger` 对重复到达的来源事件直接返回首次写入的 `Trigger` 与原文（`selfEcho: true` 直接忽略），不重复写库；`accept` 在记下 `Trigger` 后紧接调用 `receive`。
  - 控制头（`TriggerMeta`、`TriggerContext`）经 Schema 解码，大段原始文本或结构化数据存入同行 payload 列，写入后只读（供 `vv://trigger/<id>` 按需分页读取）。
- **工单与频道找帮工只经 Mailbox 一道门**：
  - `receive`：收 `Trigger`（将已落库的触发按串/订阅、频道听众或指定帮工路由）或 `Hire`（腾位置、开帮工并在同一事务内执行调用方的 `hiring` 回调、登记初始信封 `Envelope` 并立即唤醒）。
  - `withdraw`：撤回一个帮工、一封信或一张工单的待投递；退回重投（`handBack`）与帮工拒收退回工单池（`decline`）语义相反，独立保留。
  - `triggersOf` 与 `queuedTriggers`：分别读取单张工单与全部排队工单池内等待的触发；`deliveriesOf`、`waitingOn`、`isRouted` 与 `unreadSummary` 提供投递与未读只读查询。
  - `news`：向外发布 `Handed`（交给当值助手）、`Consumed`（模型已收下）与 `Braked`（空唤醒熔断）。
- **触发器存储只经 Mailbox 服务**：上游调用 `record`、`accept`、`recordTrigger`、`readTrigger`、`knownGitHubEvents` 与 `replayCronTriggers`，不传 `Db` 或 SQL 参数。记录方法参与调用方的事务，不另起纤程；提交后再调用 `receive`。
- **跨模块入口由检查限定**：外部只导入 `mailbox.ts` 服务或 `payload.ts`、`envelope.ts`、`prompts.ts` 共享契约。共享契约不能导入数据库、基础设施或模块内部实现；`modules.test.ts` 同时检查直接导入、重导出与字面量动态导入。
- **来源先落库，投递行与路由回执同事务提交**：
  - 上游在同一事务内提交来源游标与 `Trigger`，提交后再推进路由。
  - `Mailbox` 在同一事务内写入 `mailbox_delivery` 并更新 `mailbox_trigger` 的路由回执；中途崩溃时于重启后重放。
- **至少投递一次，按 `launch` 对账，真实入模才算消费（`consumed`）**：
  - 投递交给会话时标为 `handed` 并记下当次农机进程连接号 `launch`（`${id}#n`，一次连接可跨多轮 `Run`）；仅当 `Session.news` 传来 `Consumed` 回执时才标为 `consumed`。
  - 若回合结束、进程重连、会话关闭或服务重启时仍未收到回执，`handed` 按 `launch` 自动退回 `pending` 重新投递。
- **两级缓冲（工单蓄水池 Tier 1 → 会话信箱 Tier 2）**：
  - 发往工单的输入先匹配 `mailbox_subscription` 进入 `mailbox_issue`。
  - 工单排队或处于等待用户状态时，自动输入保持 `held`（同一工单仅留最新一条 cron 输入）。
  - 工单就绪或用户新发言放行时，转入当前负责会话的 `mailbox_delivery`。
- **三道刹车仅约束 agent 唤醒 agent，用户发言随时放行并重置**：
  - **跳数限制（`hopLimit` = 4）**：同一频道或工单作用域内，自上次用户发言起连续自动唤醒不超过 4 次。
  - **冷却窗口（`agentWakeCooldownMs` = 60s）**：同一帮工被其他 agent 唤醒至少间隔 60 秒。
  - **空唤醒熔断（`wakeBreaker` = 3）**：同一帮工连续 3 次被唤醒却未开口即结束，暂停自动唤醒直至用户再次对它发言。
  - 被拦截的投递记录 `held_by`，可随下一次合法运行一并带上。

## 怎么走

1. `Channel`、`Issue`、`Cron` 或 `Inbox` 经 Mailbox 服务持久化 `Trigger`，提交后调用 `Mailbox.receive`（或直接调用 `Mailbox.accept`）。
2. `Mailbox` 在信箱写锁内计算受众、检查工单蓄水门禁与三道刹车，原子写入 `mailbox_delivery` 与路由回执。
3. `pump.ts` 唤醒空闲帮工、对正忙帮工攒批（`chat.notice_batch_ms` = 3s）发送插话提示，或经 `Mailbox.news` 发布 `Handed` 交给当值助手。
4. 会话换人或关单时，未消费的用户追问以确定性返回编号转交新负责人或助手。

## 和谁打交道

- **底层依赖（`session`、`agent`、`core`）**：调用 `Session.deliver` 投递输入，订阅 `Session.news`（`Consumed`、`Returned` 和启动的 `Spoke`、`Ended`、`HandedOff`、`Settling`、`Closed`、`Compacting`）推进状态机。
- **上层调用方（`channel`、`issue`、`cron`、`inbox`、`orchestrator`、`tool`）**：不反向 import 上层服务；对频道与工单的只读查询经窄查询完成。

## 为什么这样

- **集中管理 `mailbox_trigger` 与 `mailbox_delivery`，不设纯透传门面**。来源去重、原始载荷存储与投递状态统一收归 Mailbox 层，省去无自有表的中间转发服务，保证缓存与数据库一致。
- **工单和频道只经 Mailbox 找帮工，门上按问题分动词**。把腾位置、开帮工、撤回和消费通知收进 Mailbox 一道门，使 `Session` 的投递与招人入口不再暴露给上层；`triggersOf` 与 `queuedTriggers` 筛法和排序不同，保持独立方法名。
- **受众计算与投递控制解耦**。频道只回答「谁在场、关注了哪个串」，工单蓄水、优先级、三道刹车和重试统一在 Mailbox 执行。

## 怎么验证

- `apps/server/src/mailbox/triggers.test.ts`、`apps/server/src/mailbox/source.test.ts`：`(source, key)` 幂等去重、来源游标与触发器共同回滚、重复来源保留原文。
- `apps/server/src/mailbox/*.test.ts`、`apps/server/src/flows/ingress.test.ts`、`flows/mailbox-order.test.ts`、`flows/returns.test.ts`、`flows/handoff.test.ts`：投递顺序、三道刹车、工单蓄水、换人退回与重启重放测试。
