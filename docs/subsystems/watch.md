# 观察层

`Watch`（`modules/watch`）站在频道、帮工和工单之上，按事件驱动 agent：读频道提交的事件，算出谁听见、过三道刹车、交给 `Session` 投递；给帮工开串、拉起私聊帮工、贴汇报、记看过和 👀；它也是用户的收件箱（`Inbox`）和巡查。频道只管说话，帮工只管干活，两边都不认识对方，中间的规矩都在这里。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 按自己的游标（`watch_cursor`）读频道的 `channel_event`，每个事件路由一次，开机接着读 | 消息、席位、未读与看过的存储（[频道](docs/subsystems/channel.md)） |
| 谁听见一句话（`who_hears`）、三道刹车（`brakes`）、把听众的话经 `Board::tell` 交给工单的帮工 | 一句话是不是工单的、蓄水池（[工单](docs/subsystems/issue.md#蓄水池和路由)）；投递行、四档紧急度、叫醒与重投（[帮工](docs/subsystems/session.md)） |
| 给助手和档案排席位、开私聊（`direct`）、帮工的串和「家」、贴汇报、看过的标记与 👀、熔断与跳数通知 | 工单的状态机、派活与交付（[工单](docs/subsystems/issue.md)） |
| 用户的收件箱：从 `SpaceState` 现算要用户处理的事（`inbox`）、刚来的（`fresh_of`）、巡查（`patrol_step`） | 系统通知和托盘摘要怎么给出去（[客户端](docs/subsystems/app.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/vibevalley-server/src/modules/watch/mod.rs` | `Watch`：按游标读频道事件、路由、席位与串、私聊帮工、汇报、回执；投递经 `Board::tell` |
| `crates/vibevalley-server/src/modules/watch/hearers.rs` | 谁听见一句话（`who_hears`）、这次投递算什么（`event_of`）、三道刹车 `brakes`、跳数与冷却的记账 `Reach`、熔断 `WakeBreaker`，纯函数 |
| `crates/vibevalley-core/src/inbox.rs` | 收件箱：`inbox`、`inbox_entries`、新事项识别 `fresh_of` |
| `crates/vibevalley-core/src/patrol.rs` | 巡查的纯函数 `patrol_step`、宽限期 `grace`、对助手说的话 `patrol_text` |
| 表 `watch_cursor`（`crates/vibevalley-server/src/modules/channel/db.rs`） | 观察层读到 `channel_event` 的哪一号（只往前） |

## 模型和不变量

### 读频道的事件

- **每个事件按提交的次序处理一次，写话等它处理完才返回**：频道每次提交一条消息或一次删除，就在 `Chat::committed` 上发出事件（带 `channel_event.seq`）；观察层的路由线程顺序处理（路由，或清除对应消息的内存待发项）。频道的写话在提交、放开频道锁以后通过 `Chat::await_reader` 等观察层处理完该序号再返回；农场的通知（`notice`）不等。
- **游标只在处理后往前走**：开机先从 `watch_cursor` 读回上次序号并经 `Chat::events`、`Chat::committed_of` 补读漏掉的事件，再接实时流；每处理完一条事件推进游标。

### 三道刹车（`hearers.rs` 的 `brakes`）

每一次聊天路由都先过这三道：观察层算好听众后过 `brakes`，再按目标分发——用户在工单串里的话连同内存里积攒的待发项经 `Board::tell_message` 交给工单，帮工的唤醒话经 `Board::tell_message` 交给对应工单，助手的唤醒话经 `Orchestrator::hear` 交出（不唤醒的经 `Orchestrator::overhear` 捎带）。

| 刹车 | 拦什么 | 放开 |
|---|---|---|
| 跳数上限 `hopLimit` = 4 | 一处（`channel:<id>`）自用户上次说话起，agent 的话叫醒人满 4 次，再叫醒的记 `HopLimit`；农场在那里说一次（`untilUserSpeaks`） | 用户在那里说话 |
| 冷却 60 秒 | agent 的话 60 秒内再叫醒同一个帮工（助手不冷却）记 `Cooldown` | 时间过去 |
| 熔断 `wakeBreaker` = 3 | 一个帮工连续 3 次叫醒都没开口就熔断：之后不是用户的话记 `WakeBreaker` | 用户点它的名叫醒它，或它离场；它开口说话清零计数 |

- 被拦下或非唤醒的帮工消息留在观察层内存（`State::waiting`），随下一次合法的叫醒一并带上；成功交给帮工后记 `Chat::mark_seen` 并贴 👀。
- 用户的话三道都不拦；跳数和冷却只看 agent 的话。

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
- **巡查（`patrol_step`；Rust 服务端还没跑巡查的循环，规则和测例在 `patrol.rs`）**：每 `patrol.heartbeat_minutes`（默认 10 分钟）跑 `patrolStep`，超过宽限期的按频道记一条 `source = "patrol"` 的触发，交给那里的助手当摘要（不叫醒，随下次交互捎带）；同一件事 4 小时内最多报一次；用户读过报告所在的位置（`Channel.userReadReports`），宽限期从读的时候起至少再延 2 小时。

## 怎么走

**一句话路由**

1. 频道提交消息并经 `Chat::committed` 发出事件；观察层在线接收，或开机从 `watch_cursor` 后经 `Chat::events`、`Chat::committed_of` 补读。
2. 算听众：带 `ingress_recipient` 直接指向目标助手，否则用 `who_hears`（私聊对面、被 `@` 的、串的主人和成员、频道成员、在场帮工知晓）；过 `brakes`。
3. 用户的话清零该处跳数并放开被点名的熔断帮工；agent 的话记录跳数与冷却。触发跳数上限时在频道发一次通知。
4. 唤醒目标分流给 `Board::tell_message`（工单与帮工）或 `Orchestrator::hear`（助手），成功后记 `Chat::mark_seen` 并贴 👀；非唤醒或被拦下的帮工消息暂存内存 `State::waiting`。私聊里用户对帮工档案说话且尚无在场帮工时，拉起私聊帮工。
5. 推进游标并唤醒等待该序号的频道写话。

**帮工的串和回执**

1. 订阅 `Hub::watch` 的 `Transition`（`SessionChanged`、`SessionLeft`、`SessionReported`），送入独立的 `news` 线程（避免在 `Hub::apply` 锁内回写频道死锁）。
2. 新雇帮工时排席位并开启或复用工单串；帮工离场时离席、清空内存待发项与熔断；一轮汇报时把结论贴进工单串（按帮工与轮次去重，叫停的不贴），启动时补投未投出的待发汇报。

## 和谁打交道

- **频道（`channel`）**：读事件（`committed`、`events`、`committed_of`）、等写话（`await_reader`）、排席位（`seat`、`ensure_seated`）、开串和私聊、贴汇报（`note`）、通知（`notice`）、看过与回应（`mark_seen`、`react`）；登记删频道的守卫（`guard_removal`）。
- **工单板与帮工（`issue`、`session`）**：经 `Board::tell_message` 投递给工单和帮工，按 `Hub` 的会话事实维护工单串与汇报。
- **助手（`orchestrator`）**：唤醒消息交 `Orchestrator::hear`，旁听消息交 `Orchestrator::overhear`。
- **接口（`http`）**：注册 `channel.direct.create`、`issue.comment.create` 与 `channel.message.previewDelete`（加上内存里还在等的待发条数）。

## 为什么这样

- **频道纯聊天，帮工纯干活，规矩在中间一层**：频道（`modules/channel`）不调工单板，工单板（`modules/issue`、`modules/session`）不认识频道；谁听见、刹车、开串和回执都要同时知道聊天和会话，放在这两者之上，两边都不用回调对方。
- **用持久的游标读事件，不用内存里的回调**：提交和路由分属两个事务，中间崩溃时游标还在路由前面，开机接着读；路由按触发的 id 幂等，读两遍不会投两遍。
- **写话等观察层处理完再返回**：页面、工具和测试都靠「说完就已经路由了」：跳数通知紧跟着那句话、删消息立刻撤回投递。等待放在提交和放锁以后，观察层处理事件时可以随便用频道。
- **一处算刹车**：叫醒是从聊天进来的，刹车放在它进来的地方，用户的话在同一处清零；工单与会话不再各自重复判断跳数、冷却与熔断。
- **一套现算规则**：收件箱、通知和巡查共用同一份规则与文案（`vibevalley-core`），各端不会不一致。

## 还没做的

- 巡查循环：Rust 服务端没有；外推由连接器自己读频道的提交事件和用户的已读（`modules/connector`），不经观察层；投递按会话排在内存里（随下一次叫醒带上），不是 TS 版的持久信箱。

## 怎么验证

- `crates/vibevalley-server/tests/watch.rs`：频道里的话路由到帮工。
- `crates/vibevalley-server/src/modules/watch/hearers.rs` 里的单元测试：三道刹车的次序、跳数和冷却的记账、熔断。
- `crates/vibevalley-core/src/tests.rs`、`crates/vibevalley-core/src/tests_round2.rs`：收件箱事项与巡查的宽限期。
