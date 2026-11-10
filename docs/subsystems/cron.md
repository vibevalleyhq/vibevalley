# 定时任务

定时任务（`Cron`）是工单的时间触发器，每次到期在同一事务内更新运行时间并写入不可变 `Trigger`。服务端随后调用 `Issue.scheduled` 准备该定时任务绑定的同一张工单，交由 `Mailbox` 投递给帮工或管家。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 定时任务模型、五种时间规格（`CronWhen`）、时区解析与下次运行时间计算（`nextRun`） | 到期后工单如何创建、排队、重开或启动会话（[工单](docs/subsystems/issue.md)） |
| 管家创建定时任务时的主人授权门禁（`needsOK`：是否进入 `pending` 待批） | 触发信封如何排队、受阻暂存与唤醒（[Mailbox](docs/subsystems/mailbox.md)） |
| 周期性到期扫描（`tick`）、关机错过任务的单次补跑（`isMissed`）与未路由重放 | CLI 独立对话的本地提醒（`packages/agent/src/reminders.ts`） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/cron/cron.ts` | `Cron` 服务：增删改、到期与补跑判定（`dueCrons`、`isMissed`、`needsOK`）、到期事务与重放 |
| `apps/server/src/cron/when.ts` | 五种时间规格解析、`nextRun`、`whenText` 与 `nextText` |
| `apps/web/src/features/chat/` | 频道菜单与聊天页「定时任务」标签页 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`cron.*`，其中 `cron.update` 仅对主人与 `remote` 开放）。

## 模型和不变量

- **五种时间规格（`CronWhen`）**：
  - 支持 `once`、`every`、`daily`、`weekly` 与五段式 `cron`（`once` 跑完自动关闭）。
  - 每项携带 IANA 时区或偏移量，缺省取本机时区；8 年内无合法触发时刻的表达式（如 2 月 30 日）直接拒绝。
- **下次运行时间不落库，实时从 `last_run` 推导**：
  - `nextRun` 计算严格晚于 `last_run`（未运行过则取创建时间）的下一个匹配分钟。
  - 夏令时跳过的时刻顺延，重复的时刻取第一次。
  - 重新开启已关闭的周期任务时将 `last_run` 设为当前时间，不补跑关闭期间的时刻。
- **管家非当轮授权创建的周期或派工任务须等主人同意（`needsOK`）**：
  - 主人创建、或管家在含主人原话的当轮（`Actor.forUser` 为真）创建的任务立即生效。
  - 管家在后台回合自行创建时，仅「不派帮工的 `once` 回头看」直接生效。
  - 其余后台创建的任务存为 `enabled: false, pending: true`，在 `Inbox` 生成 `cron-ask` 待主人点击同意。
- **一个定时任务固定复用一张工单**：
  - 未指定帮工档案时指派给所属频道管家；指定帮工档案时必须同时指定仓库。
  - 若绑定工单处于等待主人状态，新到期输入在 `Mailbox` 蓄水池中保持 `held`（同一工单只留最新一条，`mailbox_issue_one_held`）。

## 怎么走

1. **扫描与补跑（`tick`）**：启动后及每 `cron.tick_ms` 在单锁内重放未路由 Trigger，并筛出 `nextRun <= now` 的已启用任务（错过多次只合并补跑一次）。
2. **原子记录与投递**：在同一数据库事务内更新 `cron.last_run` 并写入 `mailbox_trigger`，随后调用 `Issue.scheduled` 准备工单并交 `Mailbox.receive` 投递。

## 和谁打交道

- **工单与信箱（`issue`、`mailbox`）**：调用 `Issue.scheduled` 获取或创建绑定工单，通过 `Mailbox` 投递到期 `Trigger`。
- **通知（`inbox`）**：`pending` 状态的定时任务由 `inbox/items.ts` 派生为 `cron-ask` 提醒主人审批。

## 为什么这样

- **一个定时任务绑定一张工单，而非每次到期新建工单**。避免高频任务淹没看板，让历次运行记录自然归集在同一条工单串下。
- **到期状态更新与 Trigger 同事务落库**。防止更新 `last_run` 后崩溃导致漏跑，或投递后未更新 `last_run` 导致重复触发。

## 怎么验证

- `apps/server/src/cron/cron.test.ts`、`when.test.ts`：五种时间规格与夏令时、错过合并补跑、`needsOK` 门禁与事务恢复测试。
- `apps/web/test/chat.spec.ts`：定时任务列表、开关与删除端到端测试。
