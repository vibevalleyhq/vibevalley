# 田头

主人、管家和帮工说话的地方是频道（`channel`）；默认的频道叫田头（`general`），主人可以再开。频道里的消息可以挂一个串（`thread`），派活时开的是工单串。帮工自己在串里汇报、提问、交接，管家不转述。微信、飞书、QQ 经连接器（`connector`）各接一个频道，主人在外面说的话就是在这个频道里说的。「要你处理的事」是 Inbox（来电），从核心状态现算，它不在 `channel` 包里，单独写在[下面一节](#inbox要你处理的事)。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 频道、串、消息、@，消息号和地址 `#<频道>:<消息号>` | 工单的状态和派活（[工单](docs/subsystems/issue.md)）；派活时 `issue` 开 Session，田头只为这张工单开工单串 |
| 一条消息给谁、叫不叫醒，三道刹车，送达的状态 | 一轮怎么跑、能不能插话（`session.Deliver` 交给 smith，[帮工](docs/subsystems/session.md)） |
| 帮工的汇报贴进工单串；带话、验收意见、冲突经工单串交给帮工 | 汇报怎么读出结论（`session.SummaryOf`） |
| 帮工在 `/mcp` 上的说话工具（`channel_say`、`read_chat`、`channel_inbox`）背后的规则 | 工具的定义和认人（`internal/tool`、`internal/mcp`、`session/tokens.go`） |
| 连接器：扫码登录、只认主人、收件和发件、转成纯文本 | 管家怎么回答（`manager`）；连接器把话交给 `manager.Say`，管家照田头的规则被叫醒 |
| Inbox：从核心状态现算要主人处理的事（`protocol/inbox.go`） | 巡查什么时候叫醒管家（`manager/patrol_rules.go`，[管家](docs/subsystems/manager.md)）；定时到点在频道里说的那句（[定时](docs/subsystems/schedule.md)） |
| | 田头和串在界面上的样子（[farm-ui.md](docs/reference/farm-ui.md)、`app/lib/chat`） |

## 在哪

- **田头**：`server/internal/channel`（`channel.Service`）。`chat.go` 是对外的方法（`Say`、`Speak`、`Read`、`TellSession`、`ManagerSays`、`Spoken`、`Notice`、`OpenChannel`……）和开机恢复；`deliver.go` 写一条消息、算给谁、叫醒和提示；`rules.go` 是只有它用的纯规则：`mentionsIn`、`parseChatTarget`、`channelNameProblem`、`chatAudience`、`wakeInput`、`busyNotice`，黄金数据在 `testdata/rules.jsonl.gz`；`receipts.go`、`consumed.go` 推进已读和「看到了」；`threads.go` 开串；`db.go` 包 sqlc 的查询。
- **几个包共用的规则在 `protocol`**：`chat_rules.go`（`TargetOf` 写地址，`HopLimit`、`AgentWakeCooldownMs`、`WakeBreaker`、`NoticeBatchMs`、`WakeMessages`、`SummaryConversations`、`RetryWindowMs`、`HeldShown` 这些常数），`chat.go`（核心状态里留哪些：`KeepMessages` 300 条、`KeepConversations` 100 个）。
- **表**：`channel_participant`、`channel_conversation`（田头、频道、串都是一行）、`channel_message`、`channel_mention`、`channel_follow`、`channel_read_cursor`、`channel_seen_mark`、`channel_delivery`；连接器的 `connector_account`、`connector_inbound`、`connector_outbox`。表结构在 `server/migrations/0001_schema.sql`。
- **连接器**：`server/internal/connector`（`connector.Service`，[包的约定](server/internal/connector/README.md)）。`connector.go` 是桥：账号、配对、只认主人、收进来的话交给管家；`connection.go` 是账号代际的协调器（`voiceConnection`）；`inbox.go` 是持久收件（`voiceInbox`）；`outbox.go` 是发件表和退避（`voiceOutbox`）；`text.go` 是送出去的规则（`forOwner`、`ownerLine`、`plainText`、`splitText`、`flushText`）；适配器在 `weixin.go`、`feishu.go`、`qq.go`。三家的协议和扫码登录在 `server/pkg/weixin`、`pkg/feishu`、`pkg/qq`。
- **接口**：`channel.say`、`channel.create`、`channel.update`、`channel.history`、`channel.markRead`，`manager.hear`、`voice.heard`，`connector.list`、`connector.login`、`connector.verify`、`connector.logout`、`connector.channel`（[capabilities.md](docs/reference/capabilities.md)）。管家的工具 `channels`、`open_channel`、`channel_settings`、`tell`、`read_chat`；帮工的 `channel_say`、`read_chat`、`channel_inbox`、`session_list`（`internal/tool` 的 `talk.go`、`channel.go`、`look.go`、`dispatch.go`）。
- **配置**：`chat.notice_batch_ms`（忙时攒多久再提示，默认 3000）、`chat.retry_wake_ms`（叫醒没开口以后多久再叫，默认 3000）。
- **客户端**：农场窗口的田头和频道菜单（`app/lib/chat`，`channel_menu.dart`）；整页的聊天页 `/chat`（`app/lib/workbench/chat`）；连接器页 `/settings/connectors`（`app/lib/workbench/connectors`）。

## 模型和不变量

- **数据库是家，先写库再成事实**：一条消息和它的 @、跟帖、投递在一个事务里写进库，提交以后才施加 `message`、`conversation` 事实。核心状态 `CoreState.chat` 只放最近的 100 个对话、300 条消息，挤出去时频道不挤；更早的用 `channel.history` 取。`state.json` 不存田头，开机从库里放回。帮工的已读位置、跟帖、投递只在库里。
- **写库一个一个来**：改田头的都持 `Service.mu`，数据库一个连接、一个写入方，所以 `number` 的先后就是提交的先后，不用像多写入方那样等「稳定」。不应开连接池。
- **一个对话一列消息号**：主键是 uuidv7，`number` 在每个对话里从 1 数，对外的消息号就是它。地址是 `#<频道>`、`#<频道>:<消息号>`（田头是 `#田头`）；频道名 1–24 个字母、数字、汉字、`_`、`-`，不能重名，这样地址能读回来。
- **对话三种**：田头（全库唯一一行）、频道（可以带说明和默认项目）、串（挂在一条消息下，`subject_kind` 是 `issue`、`talk`）。工单串的 `subject_id` 是工单的 id；没挂工单的 Session 开的是 `talk` 串，`subject_id` 是它自己；有人往 `#频道:<号>` 说话时现开的串也是 `talk`，没有 `subject_id`。
- **一张工单一个串**：重开、换帮工都还是这一个串，前后几个帮工的派活、汇报、主人的话都在里面。串的主人是这张工单现在在干活的帮工（`protocol.SessionOnIssue`），每次写消息时按工单现算，不存；没有帮工在干时串没有主人。从帮工找串只走一个函数（`threadOfSession`：先找它的工单，再找串），不拿帮工的 id 去找工单串。核心状态里 `FactMessage.thread` 是工单的 id。客户端的串标题是工单标题，帮工走了也对（`app/lib/rules/chat.dart` 的 `threadTitle`、`threadOwnerOf`）。
- **谁在频道里**：主人和管家在每个频道里；帮工在它的活所在的频道里，在哪个频道派的活，工单串就开在哪个频道下面。帮工派出来时加入（`channel_participant`），离开时打上 `left_at`，说过的话留着，给它没交完的投递作废（`dropped`）。
- **@ 名**：`@w3`（帮工的 id）、`@管家`、`@主人`、`@所有人`（只有主人用才算）。反引号和代码块里的不算；名字在它的词结束处结束（`@w3你看` 是 w3）。写 @ 就是叫醒；@ 了不在地里的，消息照发，发的人被告知没送到。
- **给谁、叫不叫醒**（`chatAudience`）：

  | 谁说的 | 叫醒谁 | 只让谁知道 |
  |---|---|---|
  | 主人在频道里 | 被 @ 的；没 @ 别人时是管家 | 这个频道里的帮工 |
  | 主人在串里 | 被 @ 的、这张工单现在的帮工、跟着这个串的；工单没人在干时只记下 | — |
  | 管家或帮工 | 被 @ 的；在工单串里说话叫醒这张工单现在的帮工 | — |
  | 帮工的汇报 | 没做成时叫醒管家 | 做完时给管家；种植计划里的帮工不给，计划自己告诉管家 |
  | 派活消息、农场的提示（`notice`）、通话里说过的话 | 谁也不叫 | — |

  在串里说过话或被 @ 过，就跟着这个串（`channel_follow`）。`@主人` 不产生投递，它进 Inbox。
- **三道刹车**只管 agent 叫醒 agent，主人的话不受限：一个对话里从主人上次说话算起最多叫醒 4 次（`HopLimit`），到了 @ 照记、照显示，不叫醒，对话里贴一句提示（每次主人说话后只贴一次）；同一个帮工被 agent 叫醒至少隔 60 秒（`AgentWakeCooldownMs`）；连着 3 次叫醒都在开口前失败（`WakeBreaker`）就不再自动叫它，工单串里贴一句，主人的下一句叫醒它的话解除。被拦下的投递照样记着（`held_by` 是 `hop_limit`、`cooldown`、`wake_breaker`）。来回次数和冷却从 `channel_delivery` 现算；熔断的计数在内存里，重启清零。
- **送达**：每条给帮工的投递走 `pending` → `announced`（插过不带正文的提示）→ `handed`（放进了一轮的输入）→ `seen`；离开的是 `dropped`。这一轮真的开口才算 `seen`；没开口就结束、会话关掉、服务端重启都退回 `pending`，过一会儿再叫。宁可重复给，不会丢。给管家的投递交出去当即算看到。
- **主人的话重发不成两条**：`channel.say`、`issue.comment`、`manager.hear`、`voice.heard` 带客户端为这一次发送生成的 `sendKey`（至多 64 个字，长了拒绝）。同一个人带同一个键再发就是已经说过的那一条：不另写、不再送，管家也不再听一遍（唯一索引 `channel_message_send_key` 在发送者和键上）。客户端为一份草稿生成一个键，发成功才换；发送失败时草稿留在输入框里，重发用同一个键。帮工的 `channel_say` 不带键：60 秒内（`RetryWindowMs`）同一个帮工在同一处说一模一样的话，返回原来那条。连接器按外部消息 id 去重。
- **消息带着产生它的那次干活**（`meta.run`）：过程面板按这个号取事件；没有号的消息不按时间推测归属。创建频道的接口返回实际的频道号，客户端用它跳转，不从名字猜号、不等状态流确认。
- **连接器只认主人**：微信扫码的人就是主人；飞书返回扫码者的 OpenID 时直接绑定，没返回时和 QQ 一样，由第一个私聊机器人发 6 位配对码（前面可以带「配对」和空格）的人成为主人。别人的话丢掉，群里的不收。账号和密钥在 `connector_account`，不进日志、不发给页面；断开就删掉这一行。
- **连接器只往外连**：微信长轮询，飞书、QQ 长连接，都是服务端连出去，不收 webhook。
- **收件至少交付一次**：平台交来的消息先写进 `connector_inbound` 再算收下；管家那边成功、完成标记没写进去时，重试会重复交一次。不保证恰好一次。

## 怎么走

**主人说一句**（`channel.say` → `manager.Say` → `channel.Say`）：写库、算投递、推进主人的已读，提交后施加事实；被叫醒的是管家就经 `ForManager` 交给它，它在哪个对话被叫就回在哪个对话。管家的回答是逐字长出来的同一条消息（`ManagerSays`，同一个键替换正文，`final` 时才算投递）；服务端停下时说到一半的，开机时就当说完了。

**派活开工单串**：`FactHired` 来了，田头为新的 Session 建参与者，把它在频道里的已读位置放到最新，按它的工单找串：

1. 工单还没有串：以管家的名义在频道里发一条派活消息（`dispatch`，「派 @w3（名字）去 项目：要做什么」），同一个事务里在下面开工单串，帮工跟着它。开串失败时派活消息也不留。
2. 工单已经有串（重开、换了帮工）：在串里以管家的名义写一条派活的话（「这张工单交给 @w5（名字）接着做，第 2 次派活」），同一个事务里让新帮工跟着这个串；已经跟着的就不再写，开机重放不会说两遍。串里的派活消息不让管家跟着串，不然主人在串里的每句话都会叫醒管家。

没挂工单的 Session 照旧在频道里发派活消息，下面开它自己的 `talk` 串。

**叫醒一个帮工**（`kicked`）：

1. 帮工不在地里：给它的投递作废。
2. 帮工在忙：攒 `chat.notice_batch_ms`（3 秒），经 smith 插一句不带正文的提示（`busyNotice`：哪几个对话、几条、有没有提到你、最后是谁），投递标成 `announced`；同一条只提示一次。它在压缩上下文时不插，压完再提示。
3. 帮工歇着、有要叫醒它的投递、没被熔断：开新的一轮，输入是 `wakeInput`：最新的 3 条全文（`WakeMessages`），别处没读的最多 20 个对话的摘要（`SummaryConversations`），写明旧消息只读不回、除非直接问到它；投递标成 `handed`。
4. 这一轮开口了（`LaunchActivity` 的 `spoke`）：交给它的都算看到。没开口就结束：退回 `pending`、记一次失败，过 `chat.retry_wake_ms` 再叫。

**帮工说话**（`channel_say` → `Speak`），发出前按顺序查：

1. 60 秒内同一处一模一样的话：返回原来那条。
2. 刚读的是一个串、却要发到频道顶层：先让它确认一次（`confirm`）。
3. 目标里有它没看过的新消息：先不发，给它看最多 3 条（`HeldShown`），记成看过；改了再发，或带 `anyway` 照发。
4. 发出去，推进它的已读；不在地里的 @ 回给它。

`read_chat` 默认读 30 条、最多 100 条，推进已读；不写地址时帮工读自己的工单串。`channel_inbox` 列出它没读的对话。

**汇报**：帮工一轮结束（`FactReport`），田头以帮工自己的名义把这一轮贴进它这张工单的串（`report`）：做完的是最后一段话里的结论（`session.SummaryOf`），没有就用汇报的摘要，截到 1500 字；被打断的不贴。

**带话和意见**：主人的带话、验收没过的意见、冲突和检查失败交回帮工，都经 `TellSession` 以主人的名义说在工单串里，按串的规则叫醒帮工；没有工单串的 Session 直接 `session.Deliver`。

**开机**：说到一半的消息标成说完；所有 `handed` 退回 `pending`；为地里每个 Session 补上参与者和工单串；把最近的对话和消息放回核心状态；开始以后把还在地里的帮工的投递再推一遍。

**外面进来的话**（连接器）：

1. 适配器把平台的消息翻成「谁、说了什么、回复凭据、引用了哪条」：微信每页消息和下一页游标交给 `voiceInbox.accept`，同一个事务写进 `connector_inbound` 和 `connector_account.cursor`，失败就整页回滚、游标不动；飞书和 QQ 的回调等这一行落库后才返回给 SDK。同一个平台消息 id 只收一次（`on conflict do nothing`）。
2. 收件工人（`voiceInbox.run`，有新收件或每秒）按顺序交付：还没配对的，对上配对码就绑定主人、回一句「配对好了」；不是主人的丢掉；主人的先记下回复凭据、补发发件表，再把话交给管家（`manager.Say`）。被引用的是农场发出去的某条消息时，话说在那条所在的对话里（比如它的工单串），否则说在连接器接的频道（默认田头）。
3. 交付成功，标成已交付、清空正文，只留去重记录。没交付完的，重启后接着交。

**送出去的话**：核心状态的每条 `message` 事实交给每个连接器的协调器，`forOwner` 挑出主人要看的：说完了的，不是主人自己的；汇报和派活，管家的话，@主人 或 @所有人 的话；提示不送。只送连接器接的那个频道（和它下面的串）里的。`ownerLine` 加上「【谁 · 做完了 / 没做成 / 派活 / 在工单串里】」，Markdown 转成纯文本，按 UTF-16 长度切开（微信 1800、飞书 4000、QQ 2000，尽量在空行或换行处切），写进 `connector_outbox`；网络发送不阻塞读核心事件。

**发件表**（`voiceOutbox`）：每条马上发，按顺序，遇到发不出去的就停下。拒收的（微信、QQ 的回复窗口，`restricted`）留着，30 秒后重试，每失败一次等待翻倍，最多半小时；发出去一条就从 30 秒重来。主人下次说话时先补发，积了 3 条以上就合成一条摘要（「你不在的时候有 N 条消息」，每条留头 60 个字），整批一起确认。飞书、QQ 拿到平台的消息 id 才算发成功。登录过期（`stale`）就暂停这个账号一小时，页面说明可以断开重连。收消息断了先等 2 秒重连，连着断 3 次等 30 秒。

**登录和换账号**：

- 微信、飞书扫码，QQ 填机器人的 AppID 和 AppSecret（先验一次）。一次扫码由各自 SDK 走完：微信拿到二维码后最多等 8 分钟，跟随重定向的域，要输数字时页面显示输入框，二维码过期或验证码被禁用累计 3 次就结束；飞书按注册返回的间隔和有效期轮询，跟随租户跳到 Lark。连接器只把进度（等待扫码、扫过了、要输数字）给页面，成功后保存账号。
- 每个账号同时只有一代任务：登录，或者接收、收件、发件三个工人。协调器（`voiceConnection`）不在任何一代里：重新登录或退出时，它先取消并等旧一代结束，再在一个事务里改 `connector_account`、清掉旧收件、退休旧发件（`dropped`），然后起新一代。保存失败就保留旧账号、重新起旧的那一代。SDK 在接收返回后回调的，不再收下；旧连接迟到的结果不写新账号。

## Inbox：要你处理的事

Inbox 不属于 `channel` 包：它是 `protocol.Inbox(state)`（`server/internal/protocol/inbox.go`），从整个核心状态（帮工、种植计划、定时、田头）现算，不存，放在 `StateFrame.inbox`，和 `state`、`view` 并排。农场手机把它当来电（`app/lib/phone/calls.dart`），桌面的通知和菜单栏摘要也读它（`app/lib/host/notify.dart`），都经 `inboxProvider`。巡查只看它：`InboxEntries` 给每件附上频道、从什么时候算起、给管家看的一句话。

| 种类（`InboxKind`） | 什么时候 |
|---|---|
| `merge` | 帮工这一轮做完，等你看 |
| `fix` | 帮工这一轮没做成 |
| `conflict` | 合进主分支会冲突 |
| `quiet` | 干着活好久没动静 |
| `graph-draft`、`graph-ripe` | 种植计划拆好了等你看、做完了等你收 |
| `task-failed` | 计划里有一件没做成；重试又失败再算一次 |
| `mention` | @主人 的话，你没读、也没在那个对话里回 |
| `schedule-ask` | 管家定的定时等你同意（目标是定时所在的频道） |

- 一个帮工一次只算最要紧的一件（`NeedOf`）；重试中的不算。种植计划里的帮工做完、没做成、冲突交给计划报，没动静照样算。
- 新的在前，同一时刻的保持收集的顺序；同一件事的 id 不变（帮工的是 `<id>:<种类>:<第几轮>`，@ 的是消息 id）。
- 「回了」是主人在那个对话里在这条之后说过话；回了没读不算，读了没回也不算。主人的已读位置在 `Conversation.read`，存在服务端，几台设备看到的一样。

## 和谁打交道

- **帮工（`session`）**：给帮工的话经 `Session.Deliver` 交给 smith（插话或开新一轮由它定）；`Launches()` 报一轮开口、结束、关掉、压缩上下文，`InputsConsumed()` 报一轮实际读进去的消息，田头据此推进送达。`FactHired`、`FactLeft`、`FactReport` 经核心事件来。
- **核心状态（`core`）**：田头施加 `message`、`conversation` 事实；读 `CoreState.Sessions` 知道谁在地里、谁在忙。
- **管家（`manager`）**：订阅 `ForManager`（叫醒它的话，按对话分批）和 `ManagerDigest`（只让它知道的汇报）；用 `ManagerSays` 说话、`Spoken` 记下通话里的话。主人的话经 `manager.Say` 进田头，管家照田头的规则被叫醒。
- **工单（`issue`）**：带话、验收意见、冲突和检查失败经 `TellSession`；首次派活时记下频道（`ChannelOf`）。
- **定时（`schedule`）、种植计划**：到点时用 `Notice` 在频道里说一句再派活；派活工具按 `ChannelByName`、`ChannelOf` 取频道和它的默认项目。
- **工具（`tool`、`mcp`）**：管家和帮工的说话工具都调 `Speak`、`Read`、`Inbox`；`/mcp` 用每个会话自己的令牌认出是谁在说话，令牌只用来分清人，不用来防人。
- **语音（`voice`）**：电话里说的和回答经 `Spoken` 留在田头，不叫醒谁，管家在电话里已经听过。
- **连接器 → 管家、田头**：收进来的话交给 `manager.Say`；送出去的读核心事件里的 `message`，只读不改田头。主人在外面说话也让农场开门（通话状态成 `live`）。
- **巡查（`manager/patrol_rules.go`）**：读 `protocol.InboxEntries`，过了宽限期才叫醒管家（[管家](docs/subsystems/manager.md)）。

## 为什么这样

- **人和 agent 在同一个群聊里，帮工自己说话。** 星形的对话里帮工的话全由管家转述，会丢细节、说错，主人也没法直接对帮工说话，帮工之间不能交接。照 Raft（botiverse 的人机协作工作区）做频道和串；派一件活开一个工单串，田头上每件活只占一条。
- **@ 和主人在工单串里的话才叫醒帮工，比 Raft 收得紧。** 放弃了「频道成员每条都收、都被叫醒」：Raft 的 agent 长驻，VibeValley 的帮工按工单开会话、按 token 花钱，田头一句闲聊叫醒六个帮工就是六份钱。成员照样被动知道（忙的收提示、歇着的醒来看摘要），所以主人说「main 刚合了大改动」帮工也知道。
- **防 agent 来回靠结构上的闸，不靠礼节。** Raft 只靠提示词里的礼节，自己的手册承认关键时刻会失灵。来回上限、冷却和熔断不管模型守不守礼节都管用。`session_list` 的名单不带 @、规矩写明 @ 就是叫醒：真跑时帮工把带 @ 的名单原样抄进回答，一连叫醒了管家和别的帮工。
- **用帮工的 id 来 @，不用名字。** 名字有空格、紧跟中文会被吞进去，都会 @ 错人；id 是稳定的，页面上显示名字。
- **串跟着工单，不跟着帮工。** 原来工单串按派出去的 Session 开，重开、换帮工就另开一个串，同一张工单的话散在几个串里，新帮工和主人都要去翻旧串；叫「工单串」，`subject_id` 却是 Session，帮工走了界面上只剩 id。放弃了「重开时把旧串的 `subject_id` 改成新帮工」：串仍然是帮工的，取消后重开要挪串，挪的那一刻谁听得见说不清。也放弃了「串上存一列主人」：现在谁在干这张工单核心状态里已经有，存一份就要在换人时同步，违反核心状态只有一份。
- **最后的汇报自动贴出，`channel_say` 只用于一轮中间。** 放弃了「只经工具说话」：帮工本来就用最后一段话汇报，每轮多调一次工具，模型容易忘。
- **帮工的工具走会话级的 MCP，不给命令行。** pi、claude、codex 都接受会话级 MCP，工具有类型，不用处理 shell 引号和多行中文；不接受 MCP 的农机再补命令行。管家跑在服务端进程里，不绕 HTTP 调 `channel_say`：它的话直接写进田头。
- **交给它不等于它看到了，开口才算。** 帮工会在任何时候死掉（登录失效、进程崩溃、重启）；不记下交到哪一步，消息要么丢、要么不知道该不该重发。新鲜度拦截、防发错地方、压缩时不插话、只提示一次也照 Raft，因为两个帮工被同时 @ 会抢着答，插话会占上下文。草稿不存：工具调用时模型手里有原文。
- **聊天记录存 SQLite，一个写入方。** 一条消息要同时改消息、@、投递、跟帖、已读，还要按游标翻页、按人查未读，用文件得自己保证一致。只有一个写入方，`number` 的先后就是提交的先后，Raft 为多写入方做的「稳定窗口」和守护进程确认协议都省了。
- **频道是安排活的地方，可以带默认项目。** Raft 的频道和代码仓库没关系；VibeValley 的帮工按工单在项目的 worktree 里干，频道带个默认项目，在那里派的活不说项目也知道去哪。私信不做：和管家的私信就是一个只有你和管家的频道。
- **外部渠道是频道的门，不是另一个 agent。** 放弃了用 nanobot 当外壳：它有自己的 agent 循环、记性和子 agent，会和管家、帮工、田头的投递重复成两套，核心状态也不再只有一份。一个桥、三个适配器：账号、只认主人、配对、发件表、补发和摘要在桥里，适配器只管登录、收、发，再接一家只写一个适配器。主人把一个连接器接到一个频道上，一对一；每个外部会话自动开频道，群一多频道就乱。
- **只走出站连接，只认主人，只用官方接口。** webhook 要公网地址，违背「服务端只听 127.0.0.1」。帮工没有权限确认、能在这台机器上跑命令，聊天账号能派活就等于能控制这台机器，所以只认配对过的主人。飞书、QQ 拿不准主人是谁，用配对码，比让主人去找自己在平台上的 id 好用。不用 NapCat 这类非官方客户端：会封号，也等于把登录交给第三方。
- **先当平台能主动发，发不出去再退避。** 每条马上发，微信、飞书在主人没说话时也能送到；QQ 只能在主人说话后的窗口里回，拒收的进发件表，主人下次说话时补发。
- **收件先落盘再交给管家，至少一次。** 内存队列救不回飞书已经确认的消息，也挡不住旧账号的迟到回调。SQLite 的事务不能和管家的工具副作用合成一个事务，先记完成再交付会永久丢指令，先落盘再交付只在一个极窄的窗口里可能重复；所以不声称恰好一次。
- **账号由一个不在任何一代里的协调器换。** 给任务表加 WaitGroup 不行：登录任务本身会触发换账号，等任务表就会等自己。协调器把「结束旧任务」和「发布新账号」的顺序收在一个主人手里。
- **一次扫码登录由平台的 SDK 拥有。** 二维码、重定向域、期限、刷新次数、验证码、轮询间隔、Feishu 到 Lark 的跳转都是平台协议，放在 SDK 里，连接器不碰中间状态。放弃了三家共用一个可配置的登录状态机：QQ 用密钥，微信要验证码和刷新，飞书按租户域轮询，统一起来只会把差异变成更多配置。
- **Inbox 是一条现算的规则，不存。** 来电和巡查的发现原来是两套大半重叠又各有出入的规则，改一处忘一处，手机响了巡查不报。放弃了像 Linear 那样存进库、带已读和归档：这些都能从核心状态现算，存一份就要保持一致。放在帧上不放在 `view` 里：`view` 是农场的画面，Inbox 是实际要你处理的事。

## 还没做的

- 给 agent 的话从哪几条路来、什么时候交给它收成一处（每个 agent 一个信箱）：[编排层：每个 agent 一个信箱](.agents/notes/proposed/architecture/2026-10-18-one-mailbox-per-agent.md)。
- 不接受 MCP 的农机用的命令行版说话工具：[其他农机](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)。
- 管家和帮工的工具按能力分配（现在是 `tool.Service` 里两张写死的表）：[管家也是一个 agent](.agents/notes/proposed/architecture/2026-10-17-manager-is-an-agent.md)。
- 种植计划自己的串、串的静音和退出跟帖、Telegram 等别的渠道：还没有提案。

## 怎么验证

- `channel/rules_test.go`：`TestMentionsIn`、`TestParseTarget`、`TestChannelNameProblem`、`TestAudienceInAChannel`、`TestThePersonOnTheGeneral`、`TestThePersonInAJobThread`、`TestAgentsWakingAgents`（三道刹车）、`TestReportsDispatchesNotices`、`TestWakeInputAndBusyNotice`；`TestRulesGolden` 对 `testdata/rules.jsonl.gz`。
- `workspace/thread_test.go`（smith 的 `oartest` 扮演帮工、真的 git 仓库）：`TestOneIssueKeepsOneThreadAcrossItsSessions`：派出去、取消、重开，前后两个帮工的派活、汇报、主人的话在同一个串里；主人的话叫醒现在的帮工，没人在干时只记下。
- `channel/chat_test.go`（假的帮工、真的 SQLite）：`TestChatJobOpensThreadUnderDispatch`、`TestChatSessionSentForNoIssueHasATalkThread`、`TestChatPersonInJobThreadWakesSession`、`TestChatGeneralReachesManager`、`TestChatChannels`、`TestChatBusySessionGetsOneNotice`、`TestChatHopLimit`、`TestChatWakeBreaker`、`TestChatSpeaking`（拦截、确认、重试）、`TestChatManagerSaysGrowsThenDelivers`、`TestChatRestartGivesHandedWordsAgain`、`TestChatSessionLeaves`、`TestChatSendKeyWritesOnce`、`TestMessagesKeepTheProducingRunRatherThanMatchingTime`。`transaction_test.go`：`TestThreadOwnerFailureLeavesNoDispatch`、`TestRolledBackMessageDoesNotResetWakeBreaker`、`TestReadingReceiptRollsBackAsAUnit`、`TestStreamingCommitCanRetryWithoutAnotherMessage`。
- `protocol/chat_rules_test.go`：`TestTargets`、`TestChannelsInTheChat`、`TestTheChatKeepsTheGeneral`。`mcp/mcp_test.go`：`TestToolsOverMcp`、`TestEveryMcpToolRequiresAuthenticatedSession`。
- 连接器（真的 SQLite、本机假适配器，不登录真账号）：`connector_test.go` 的 `TestConnectorsWeixinOwnerSaidOnTheGeneral`、`TestConnectorsWeixinInAnotherChannel`、`TestConnectorsWeixinStrangerNotLetIn`、`TestConnectorsQQPairing`、`TestConnectorsQQRefusedReplyWaits`、`TestConnectorsWeixinHeldGoOutAsADigest`、`TestConnectorsRetryBacksOff`、`TestConnectorsResumeAfterRestart`、`TestConcurrentInboundIsTakenOnce`、`TestAccountChangeRollsBackWhenOutboxUpdateFails`；`inbound_retry_test.go` 的 `TestWeixinPageAcceptanceIsAtomicAndDeliveryRetries`；`recovery_test.go` 的 `TestInboxRecoversAcceptedWorkAfterRestart`、`TestInboxReplaysWhenManagerSucceededBeforeCompletionWrite`；`feishu_test.go` 的 `TestFeishuAcknowledgesOnlyAfterAcceptance`；`connection_test.go` 的 `TestAccountOwnerJoinsOldLoginBeforeReplacement`、`TestAccountLogoutWaitsAndRejectsLateCallbacks`、`TestConnectionShutdownWaitsForManagerDelivery`、`TestReceiverSealsSDKCallbacksAfterListenReturns`；`outbox_test.go`、`text_test.go`、`login_test.go`。全部：`go test -race ./internal/connector ./pkg/qq ./pkg/weixin ./pkg/feishu`。
- SDK 的扫码登录（本机假端点）：`pkg/weixin` 的 `TestLoginOwnsRedirectVerificationAndRefresh`、`TestLoginOwnsRefreshLimit`、`TestLoginCancellationInterruptsPoll`；`pkg/feishu` 的 `TestLoginOwnsPollingLeaseAndDomainRedirect`、`TestLoginOwnsCancellationExpiryAndRejection`。
- Inbox：`protocol/inbox_rules_test.go`（每种什么时候算、id、截字、先后，`TestInboxMostPressingNeedOnly`、`TestInboxTaskSessionsLeaveItToTheTask`、`TestInboxMentionCalls`、`TestInboxMessagesThatDoNotCall`）；巡查在 `manager/patrol_rules_test.go`。
- 客户端：`app/test/chat/chat_test.dart`（频道和未读、串、在频道里说话；串标题是工单标题，帮工走了照样对）、`app/test/workbench/connectors_test.dart`、`app/test/phone/widget_test.dart`（假的 `inboxProvider`）、`app/test/host/notify_test.dart`。
