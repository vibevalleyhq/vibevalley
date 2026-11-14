# 观察层

`Watch`（`modules/watch`）站在频道、帮工和工单之上，按事件驱动 agent：读频道提交的事件，算出谁听见、过三道刹车、交给 `Session` 投递；给帮工开串、拉起私聊帮工、贴汇报、记看过和 👀；它也是用户的收件箱（`Inbox`，农场里画成手机来电）和巡查。频道只管说话，帮工只管干活，两边都不认识对方，中间的规矩都在这里。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 按自己的游标（`watch_cursor`）读频道的 `channel_event`，每个事件路由一次，开机接着读 | 消息、席位、未读与看过的存储（[频道](docs/subsystems/channel.md)） |
| 谁听见一句话（`whoHears`）、三道刹车（`brakes.ts`）、把听众交给 `Issue.route` | 一句话是不是工单的、蓄水池（[工单](docs/subsystems/issue.md#蓄水池和路由)）；投递行、四档紧急度、叫醒与重投（[帮工](docs/subsystems/session.md#触发与投递)） |
| 给助手和档案排席位、开私聊（`direct`）、帮工的串和「家」、贴汇报、看过的标记与 👀、熔断与跳数通知 | 工单的状态机、派活与交付（[工单](docs/subsystems/issue.md)） |
| 用户的收件箱：从 `SpaceState` 现算要用户处理的事、刚来的（`inboxNews`）、外推门禁（`toUser`、`handoffState`）、巡查（`patrol`） | 手机来电、系统通知、托盘和电话播报的画法（[农场的皮](docs/subsystems/farm.md)、[客户端](docs/subsystems/app.md)、[语音](docs/subsystems/voice.md)）；连接器的发送与退避（[频道](docs/subsystems/channel.md#外部连接器微信飞书qq)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/modules/watch/watch.ts` | `Watch` 服务：读事件、路由、席位与串、私聊帮工、汇报、回执，组装收件箱 |
| `apps/server/src/modules/watch/brakes.ts` | 三道刹车的纯函数 `brakes`，跳数与冷却的记账 `Reach`、熔断 `WakeBreaker` |
| `apps/server/src/modules/watch/hearers.ts` | 谁听见一句话（`whoHears`）、这次投递对它算什么（`eventOf`），纯函数 |
| `apps/server/src/modules/watch/trigger.ts` | 一条消息记成的 `Trigger`（`channelTrigger`）和信箱要的行（`envelopeRowOf`） |
| `apps/server/src/modules/watch/inbox.ts` | 收件箱：`inboxNews`、`toUser`、`handoffState`、`externalChanges`、巡查循环与开机的 `prime` |
| `apps/server/src/modules/watch/items.ts`、`patrol.ts`、`prompts.ts` | 纯函数 `inbox`、`inboxEntries`、外推资格 `forUser`；巡查的 `patrolStep`（宽限期与已读延期）；巡查对模型说的话 |
| `packages/protocol/src/rules/inbox.ts` | 前后端共用的新事项识别 `freshOf` |
| 表 `watch_cursor` | 观察层读到 `channel_event` 的哪一号（只往前） |
| `apps/web/src/farm/phone/calls.ts`、`apps/web/src/features/inbox/` | 农场手机来电、系统通知（`Follow.tsx`）与菜单栏托盘摘要（`tray.ts`） |

## 模型和不变量

### 读频道的事件

- **每个事件按提交的次序处理一次，写话等它处理完才返回**：频道每次提交一条消息或一次删除，就在 `Channel.committed` 上发出一个事件（带 `channel_event.seq`）；观察层一个一个地处理（路由，或撤回还在等的投递）。频道的写话（`say`、`speak`、`post`、`note`、`remove`）在提交、放开频道的锁以后等观察层处理完它的事件再返回（`Channel.awaitReader`），所以写话返回时路由已经做完、熔断与跳数的通知已经写下；处理失败（不是 `ApiError` 的拒绝）让这次写话失败，事件留着。农场的通知（`notice`）不等：它不叫醒谁，观察层处理事件时也会写它。
- **游标只在效果落盘以后往前走**：开机读完游标后的事件之前，游标不动；处理完一个事件、它的路由提交了，游标才走到它；为一条私聊消息拉起帮工时，游标停在这条前面，直到帮工拉起来；一个事件在线处理失败后，游标停在它前面，等下次开机。
- **至少处理一次，不重复投递**：触发的 id 就是消息的 id，`recordTrigger` 按 `(source, key)` 幂等；开机再读的事件先问 `Session.isRouted`，路由过的跳过；投递按 `(会话, 信)` 唯一。开机再读时一条路由不了的记日志放过，不反复试。
- **私聊里补说的话按当时补投**：私聊帮工拉起时，期间用户又说的话再路由一次（`committedOf`），因为一封信每个会话一份。

### 三道刹车（`brakes.ts`）

每一次自动叫醒都过这三道：观察层路由的每一句话（`@` 提及、私聊、串、汇报、连接器和通话带进来的、巡查的提醒）先过 `brakes`，再把带着 `held_by` 的听众交给 `Issue.route`（用户在工单串里的话进工单的蓄水池，其余的由它交 `Session.route` 投递）；不是话的触发（定时任务、GitHub、派活）来自 `system`，只受熔断约束，由 `Session` 按观察层的决定拦着。

| 刹车 | 拦什么 | 放开 |
|---|---|---|
| 跳数上限 `hopLimit` = 4 | 一处（`deliveryScope`）自用户上次说话起，agent 的话叫醒人满 4 次，再叫醒的记 `hop_limit`；农场在那里说一次（`untilUserSpeaks`） | 用户在那里说话 |
| 冷却 60 秒 | agent 的话 60 秒内再叫醒同一个帮工（助手不冷却）记 `cooldown` | 时间过去 |
| 熔断 `wakeBreaker` = 3 | 一个帮工连续 3 次叫醒都没开口（`Session.deliveries` 的 `EmptyWake`）就熔断：观察层让 `Session.holdWakes` 拦住它、贴通知，之后不是用户的话记 `wake_breaker` | 用户点它的名叫醒它，或它离场；它开口说话（`Spoke`）清零计数 |

- 被拦下的投递照样写进信箱，随下一次合法的叫醒一起带上。
- 用户的话三道都不拦；跳数和冷却只看 agent 的话。
- 开机时跳数和最近一次叫醒从投递里读回（`Session.agentWakes`：自用户在一处最新的路由起 agent 叫醒了几次，每个会话最近一次被 agent 叫醒的时间，都按投递写下的时间，不看触发自己带的时间）。

### 收件箱

八种待处理事项（`InboxKind`）：

| 种类 | 触发条件 | 默认巡查宽限期 |
|---|---|---|
| `review` | 工单处于 `reviewing`（帮工做完一轮或全部子单完成，等用户验收） | 2 小时 |
| `ask` | 工单处于 `asking`（帮工带着问题等用户回答） | 15 分钟 |
| `fix` | 工单处于 `stuck: failed`（上一轮失败） | — |
| `interrupted` | 工单处于 `stuck: interrupted`（上一轮停在半路） | 30 分钟 |
| `conflict` | 工单处于 `stuck: conflict`（合入主分支存在冲突） | 2 小时 |
| `quiet` | 工单处于 `stuck: quiet`（执行中长时间无事件） | 20 分钟 |
| `mention` | 频道或串中有未读且未回复的 `@用户` 消息（`Chat.userMentions`） | 15 分钟 |
| `cron-ask` | 助手创建的定时任务处于 `pending` 等待用户同意 | — |

- **纯函数现算，不落库**：`InboxEntry[]` 直接从 `SpaceState` 算出，放进每帧的 `StateFrame.inbox`；每条有稳定的 id，带 `who` 和预填好的文案 `words`（`label`、`title`、`body`、`tray`）。原生子工单成功完成后自动合入父分支，不单独产生 `review`。
- **开机时已有的不响铃（`freshOf`）**：服务端开机 `prime` 与页面首次打开都先记下存量 id，之后新出现的 id 才响铃和通知，同一个只响一次。
- **外推门禁（`toUser`、`handoffState`）**：只有待人介入的工单汇报（工单的 `stage.state` 是 `draft`、`asking`、`stuck` 或 `reviewing`）、派活消息、助手直接回话或 @用户，且用户没读没回，才外推连接器；读的是频道给的回执（`Channel.userReceipt`：用户读到没有、之后有没有新话盖过它）。频道的通知设置 `notify`：`none` 什么都不外推，`mentions` 只外推 @用户和 @所有人（`forUser`）。用户在工作台读了、回了，或工单离开待人介入，连接器撤回没发的 `connector_outbox`。
- **巡查（`patrol`）**：每 `patrol.heartbeat_minutes`（默认 10 分钟）跑 `patrolStep`，超过宽限期的按频道记一条 `source = "patrol"` 的触发，交给那里的助手当摘要（不叫醒，随下次交互捎带）；同一件事 4 小时内最多报一次；用户读过报告所在的位置（`Channel.userReadReports`），宽限期从读的时候起至少再延 2 小时。

## 怎么走

**一句话路由**

1. 频道提交消息，发出事件；观察层取到它（在线），或开机从游标后读到它（`Channel.events`、`committedOf`）。
2. 算听众：`to` 指定的助手，或 `whoHears`（私聊的对面、被 `@` 的、串的主人和成员、频道的成员、在场帮工的知晓）；过 `brakes`；记 `Trigger`，交 `Issue.route`。
3. 用户的话把那一处的跳数清零、放开它叫醒的熔断帮工；agent 的话记下叫醒了谁。被跳数拦下时在那里说一次通知。
4. 私聊里用户对档案说话、还没有帮工时，拉起私聊帮工（`hireWith`，它的头几件输入是私聊里用户说过的）。
5. 游标往前走；等这个事件的写话返回。

**帮工的串和回执**

1. `Session.news` 的 `Hired`：给帮工排席位，工单没有串就发派活消息、在它下面开串，有串就在串里发接手通知；帮工的「家」记成那个串。`Left`：帮工离席，清它的跳数和熔断（它没收的投递由信箱自己放下）。`Reported`：把它这一轮的结论贴进串（叫停的不贴）。
2. `Session.deliveries` 的 `Consumed`：先记看过（`Channel.markSeen`），再贴 👀；`EmptyWake`：数熔断。

## 和谁打交道

- **频道（`channel`）**：读事件（`committed`、`events`、`committedOf`）、等写话（`awaitReader`）、排席位（`seat`）、开串和私聊、贴汇报（`note`）、通知（`notice`）、看过与回应、回执（`userReceipt`、`userReadReports`）；登记删频道的理由（在那里的帮工）。
- **帮工（`session`）**：`recordTrigger`、`isRouted`、`hireWith`、`withdrawEnvelope`、`holdWakes`、`agentWakes`、`waitingOn`、`hired`、`live`；订阅 `news`、`deliveries`；建好时经 `Session.useChat` 给信箱一个只读的 `ChatView`（默认频道、未读）。
- **工单（`issue`）**：`route`（带着刹车定下的听众；工单的入口：是工单的进蓄水池，不是的投给听众），收件箱读看板（`onBoard`）。工单不调观察层：工单的话说进帮工的家或工单串，由观察层路由。
- **语音、连接器（`voice`、`connector`）**：`Voice` 订阅 `inboxNews`；`Connector` 订阅 `toUser`、`externalChanges`，外推前问 `handoffState`。
- **接口（`http`）**：`channel.direct.create` 是 `direct`，`channel.message.previewDelete` 是 `previewRemove`（加上还在等的投递数）。

## 为什么这样

- **频道纯聊天，帮工纯干活，规矩在中间一层**：频道不 import 业务模块、帮工不 import 频道和工单（`modules.test.ts` 查）；谁听见、刹车、开串和回执都要同时知道聊天和会话，放在这两者之上，两边都不用回调对方。
- **用持久的游标读事件，不用内存里的回调**：提交和路由分属两个事务，中间崩溃时游标还在路由前面，开机接着读；路由按触发的 id 幂等，读两遍不会投两遍。
- **写话等观察层处理完再返回**：页面、工具和测试都靠「说完就已经路由了」：跳数通知紧跟着那句话、删消息立刻撤回投递。等待放在提交和放锁以后，观察层处理事件时可以随便用频道。
- **一处算刹车**：叫醒是从聊天进来的（或观察层自己的巡查），刹车放在它进来的地方，用户的话在同一处清零；`Session` 只照 `held_by` 写信、照 `holdWakes` 不叫醒，不再自己判断。
- **一套现算规则统一五条通知路径**：手机来电、系统通知、托盘、电话播报、外部连接器和巡查共用同一份规则与文案，各端不会不一致。

## 还没做的


## 怎么验证

- `apps/server/src/modules/watch/watch.test.ts`：路由、席位、串、私聊、看过、👀、熔断、跳数、游标断点续读与失败重放、查询预算。
- `apps/server/src/modules/watch/brakes.test.ts`：三道刹车的次序、跳数和冷却的记账、熔断，与多个助手时的听众。
- `apps/server/src/flows/brakes.test.ts`：两个帮工互相 `@` 停在跳数上限，用户说话后重新开始；`flows/mailbox-order.test.ts`：重启后跳数和冷却从投递读回。
- `apps/server/src/modules/watch/items.test.ts`、`patrol.test.ts`、`flows/handoff.test.ts`、`flows/mention.test.ts`：八种事项、宽限期、已读撤回与外推门禁。
- `apps/web/src/farm/phone/calls.test.ts`、`apps/web/src/features/inbox/tray.test.ts`、`apps/web/test/farm-phone.spec.ts`：来电去重、托盘摘要与接听。
