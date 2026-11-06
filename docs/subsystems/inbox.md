# Inbox

`Inbox` 汇总当前需要主人介入的事项（农场里画成手机来电），负责三件事：
- 识别刚出现的新事项（`freshOf`），驱动手机响铃、系统通知与电话内语音播报。
- 周期性巡查（`patrol`）超时未处理的事项，打包交给频道管家提醒主人。
- 判定人类交接门禁（`toOwner`），决定哪些消息外推到微信/飞书/QQ 连接器及何时撤回。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 从 `WorkspaceState` 实时派生 `InboxEntry[]`，预填手机、通知、托盘与电话播报文案 | 工单阶段与帮工状态本身的计算（[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)） |
| 识别刚出现的事项（`freshOf`），向语音模块广播 `Inbox.news` | 手机响铃动画、系统通知弹窗与语音合成播报（[农场的皮](docs/subsystems/farm.md)、[客户端](docs/subsystems/app.md)、[语音](docs/subsystems/voice.md)） |
| 周期性巡查（`patrol`）：将超过宽限期未处理的事项交给频道管家 | 管家如何向主人转达巡查提醒（[管家](docs/subsystems/orchestrator.md)） |
| 人类交接门禁（`toOwner`）：判定哪些消息可外推给连接器及何时撤回 | 连接器平台的实际发送与退避重试（[频道](docs/subsystems/channel.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/inbox/inbox.ts` | `Inbox` 服务：`news` 流、`toOwner` 流、`patrol` 定时循环与启动 `prime` |
| `apps/server/src/inbox/items.ts` | 纯函数 `inbox`、`inboxEntries` 与连接器外推资格 `forOwner` |
| `apps/server/src/inbox/patrol.ts` | 纯函数 `patrolStep`（宽限期与已读延期判定） |
| `packages/protocol/src/rules/inbox.ts` | 前后端共用的新事项识别规则 `freshOf` |
| `apps/web/src/farm/phone/calls.ts`、`features/inbox/` | 农场手机来电、系统通知（`Follow.tsx`）与菜单栏托盘摘要（`tray.ts`） |

## 模型和不变量

### 八种待处理事项（`InboxKind`）

| 种类 | 触发条件 | 默认巡查宽限期 |
|---|---|---|
| `review` | 工单处于 `reviewing`（帮工做完一轮或全部子单完成，等主人验收） | 2 小时 |
| `ask` | 工单处于 `asking`（帮工带着问题等主人回答） | 15 分钟 |
| `fix` | 工单处于 `stuck: failed`（上一轮失败） | — |
| `interrupted` | 工单处于 `stuck: interrupted`（上一轮停在半路） | 30 分钟 |
| `conflict` | 工单处于 `stuck: conflict`（合入主分支存在冲突） | 2 小时 |
| `quiet` | 工单处于 `stuck: quiet`（执行中长时间无事件） | 20 分钟 |
| `mention` | 频道或串中有未读且未回复的 `@主人` 消息（`Chat.ownerMentions`） | 15 分钟 |
| `cron-ask` | 管家创建的定时任务处于 `pending` 等待主人同意 | — |

- **纯函数实时派生，不落库**：
  - `InboxEntry[]` 直接从 `WorkspaceState` 算出，放入每帧 `StateFrame.inbox`。
  - 每条记录具有稳定 ID，附带 `who` 与预填好的多端文案 `words`（`label`、`title`、`body`、`tray`）。
  - 原生子工单成功完成后自动合入父分支，不单独产生 `review` 条目。
- **启动已有事项不响铃（`freshOf`）**：服务端启动 `prime` 与页面首次打开均先记下存量 ID；仅后续新出现的 ID 触发响铃与通知，且同一 ID 只响一次。
- **人类交接门禁（Human Handoff，`toOwner`）**：
  - 仅待人介入的工单汇报（起草确认、`asking`、`blocked`、`ready`）或管家直接回话/@主人，且主人未读未回时，才经 `toOwner` 外推连接器。
  - 一旦主人在工作台已读、回复，或工单离开待人介入阶段，立即通知连接器撤回未发出的 `connector_outbox` 行。
- **已读自动延长巡查宽限期**：
  - 若主人已读过报告所在的频道位置，巡查宽限期从已读时刻起至少延长 2 小时。
  - 同一事项 4 小时内最多报一次，以 `source = "patrol"` Trigger 投入 `Mailbox` 随下次交互捎带，不直接发消息刷屏。

## 怎么走

1. **实时分发**：核心状态变化时更新 `StateFrame.inbox`；新增条目发往 `Inbox.news` 与 `Inbox.toOwner`（驱动电话播报与连接器入队）。
2. **定时巡查**：每 `patrol.heartbeat_minutes`（默认 10 分钟）运行 `patrolStep`，将超时条目按频道生成 `patrol` Trigger 交 `Mailbox`。

## 和谁打交道

- **核心状态与频道（`core`、`channel`）**：读取工单、会话、`Chat.ownerMentions` 与 `channel_read_cursor`。
- **信箱、语音与连接器（`mailbox`、`voice`、`connector`）**：巡查摘要投递给 `Mailbox`；`Voice` 订阅 `news`、`Connector` 订阅 `toOwner`。

## 为什么这样

- **一套现算规则统一五条通知路径**。手机来电、系统通知、托盘菜单、电话播报、外部连接器和管家巡查共用同一份 `Inbox` 规则与文案，消除各端不一致。

## 怎么验证

- `apps/server/src/core/golden.test.ts`、`apps/server/src/inbox/*.test.ts`：8 种事项派生、宽限期计算、已读撤回与黄金数据测试。
- `apps/web/src/farm/phone/calls.test.ts`、`features/inbox/tray.test.ts`、`apps/web/test/farm-phone.spec.ts`：来电去重、托盘摘要与接听测试。
