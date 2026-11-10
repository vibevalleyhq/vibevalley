# 频道

频道（`Channel`）是主人、管家和帮工说话的地方，含公共频道 `channel`（默认 `general` 叫「田头」）、私聊 `direct` 和工单串 `thread` 三类通道。微信、飞书、QQ 经连接器 `Connector` 接入指定频道。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 频道、私聊、串的增删改查，消息号与地址 `#<频道>:<消息号>` | 工单生命周期与派活决策（[工单](docs/subsystems/issue.md)） |
| 消息写入、编辑、删除、回应、置顶、附件、搜索与链接预览 | 收件优先级、三道刹车、投递状态与唤醒调度（[Mailbox](docs/subsystems/mailbox.md)） |
| 阅读游标（`channel_read_cursor`）与未处理 `@主人`（`ownerMentions`） | 会话如何跑一轮、私聊执行器休眠实现（[帮工](docs/subsystems/session.md)） |
| 页面按频道的 RPC WebSocket 实时订阅与按修订号（`revision`）补齐 | 哪些未读事项提醒主人或外推连接器（[Inbox](docs/subsystems/inbox.md)） |
| 外部连接器（微信、飞书、QQ）：配对、收件去重、发件退避与摘要 | 管家如何生成回复（[管家](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/channel/channel.ts`、`contracts.ts` | 对外 `Channel` 服务接口 |
| `apps/server/src/channel/hub.ts`、`rooms.ts` | 频道与消息中枢、内存视图缓存、单写锁、数据库读写与已读游标 |
| `apps/server/src/channel/writing.ts`、`route.ts` | 消息落库、生成 `Trigger`、计算候选受众并交 `Mailbox` |
| `apps/server/src/channel/threads.ts`、`talk.ts` | 工单串创建/恢复、汇报贴出、私聊会话按需拉起 |
| `apps/server/src/channel/messages.ts`、`embeds.ts` | 地址解析、`@` 识别、搜索过滤与公网链接预览抓取 |
| `packages/protocol/src/rpc.ts`、`apps/server/src/http/rpc.ts` | `/api/v1/rpc` 频道与稿子实时订阅契约与服务端挂载 |
| `apps/server/src/connector/` | `connector.ts` 桥接协调器、`digest.ts`、`weixin.ts`、`feishu.ts`、`qq.ts` |
| 表 `channel`、`channel_participant`、`channel_message`、`channel_attachment`、`channel_mention`、`channel_member`、`channel_read_cursor` | 频道与消息存储表 |
| 表 `connector_account`、`connector_inbound`、`connector_outbox` | 外部聊天软件账号、入站去重与出站队列 |
| `apps/web/src/features/channel/`、`apps/web/src/farm/chat/` | 工作台聊天页、输入框 `composing.ts`、订阅 `follow.ts` 与农场田头窗 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`channel.*`、`connector.*` 及 `GET /api/v1/attachment/<id>`）。

## 模型和不变量

### 通道、消息与订阅

- **三种通道类型（`channel.type`）**：
  - `channel`：具名频道，可设说明、分组、排序、默认仓库和负责管家；全农场唯一默认频道（`is_default = 1`，初始 `general`）不可归档或删除。
  - `direct`：主人与单个管家或帮工档案的私聊；与帮工私聊直接拉起绑定该频道的 `Session`（用独立 `contexts/` 目录，闲置 10 分钟休眠），不建隐藏工单。
  - `thread`：挂在父频道某条消息下的串；每张工单固定一个工单串（`subject_kind: "issue"`），重开或换帮工复用同一串。
- **单连接串行写库，消息号从 `1` 递增**：所有写操作经 `hub.ts` 信号量串行提交，对外地址为 `#<频道>:<消息号>`。
- **核心状态只留近期摘要，正文按频道订阅**：`SpaceState.chat` 仅保留最近 100 个频道/串摘要与全量未处理的 `ownerMentions`。正文经 `/api/v1/rpc` 的 `channel.follow({ id, after })` 订阅：消息增改删或置顶均递增 `revision`，重连落后 200 条以内按修订号补齐，超出则回 `Reset` 重拉最新页。
- **主动阅读与被动消费分开记账**：
  - 调读取接口推进 `channel_read_cursor.read_number`。
  - 模型实际消费投递推进 `mailbox_delivery.consumed_at` 并加 👀 反应，未读查询同时排除两者已覆盖的消息。
- **写话只有一个门 `Channel.post(Post)`**：`Post` 是按写话的人分的联合，`Owner`（主人）、`Tell`（对一个帮工说）、`Agent`（帮工、管家经说话工具）、`Announce`（带上做出来的稿子或文件）、`Call`（通话里说的，不叫醒人）、`Run`（服务端里跑的 agent 一轮说完的话）、`Notice`（农场的通知）。每种保留自己的检查和答复，重载把答复的类型钉在种类上（`PostDoor`），调用方不用拆走不到的分支；七种都开同一个 `Channel.post` span，种类记在 span 的 `post` 属性上，最后都落进 `writing.ts` 的 `write`。
- **发送幂等键 `sendKey`**：主人发言带 `sendKey`（唯一索引 `(sender, send_key)`），重发返回原消息；帮工 60 秒内向同处发相同正文也自动去重。

### 受众计算与说话防撞

频道和串都有成员，记在同一张 `channel_member`：串的成员是开串的人、回过话的、被 `@` 的和手动加的；频道的成员是主人放进来的管家（只有管家能放），新频道和默认频道一开始就有默认管家。私聊的成员就是对面。没人点名的话发给成员，被 `@` 的另外加上；一个成员都没有的频道，要 `@` 才有人接。

主人发言可带 `to`（一个管家的档案 id）：只交给他，不交给成员，`to` 不是管家就拒绝；输入框的 `/imagegen` 用它把生图交给这里的管家（[媒体](docs/subsystems/media.md)）。

「这里的管家」（`Channel.orchestratorIn`，`T.Channel.orchestrator`）由 `mailbox/envelope.ts` 的 `orchestratorIn` 一处算：私聊是对面（他是管家时），否则是频道成员里的默认管家或第一个管家，都没有就是默认管家；泛称的「@管家」、派活说明的署名、没指定人的工单和定时任务、没人收的机器事件都交给它。

| 发言者与位置 | 唤醒目标 | 被动通知（仅知晓） |
|---|---|---|
| 主人在公共频道 | 被 `@` 的对象；未 `@` 他人时为频道里的成员（主人放进来的管家） | 该频道内的在场帮工 |
| 主人在私聊 | 私聊对象（对应管家或帮工档案 `Session`） | — |
| 主人在工单串 | 被 `@` 的对象、该工单当前帮工、关注该串的对象 | — |
| 管家或帮工发言 | 被 `@` 的对象；在工单串内发言唤醒该工单当前帮工 | — |
| 帮工回合结束汇报 | 失败时唤醒所在频道的成员 | 完成时作为摘要捎带给成员 |

- **帮工说话前新鲜度拦截**：帮工刚读串却要发往顶层频道时先要求 `confirm`；目标通道有未读新消息时先拦截并返回最旧 3 条未读，帮工可改后再发或带 `anyway: true` 照发。
- **附件与公网链接预览**：附件按 SHA-256 去重并经 `GET /api/v1/attachment/<id>` 带沙箱返回（上限 25MB）；消息中的公网 `http(s)` 链接在后台抓取标题与摘要（拦截内网与云元数据地址，限 3 次跳转、3 秒、512KB）。

### 外部连接器（微信、飞书、QQ）

- **只走出站长连接，只认配对主人**：微信长轮询、飞书与 QQ 官方长连接，不开 webhook；仅绑定扫码或发 6 位配对码的主人，忽略群聊与陌生人。
- **收件至少一次，发件受 Inbox 门禁控制**：
  - 入站先同事务写 `connector_inbound` 与游标，再以平台消息 ID 哈希作 `sendKey` 入频道。
  - 出站只发 `Inbox.toOwner` 放行的未读事项，在工作台已读或回复后自动撤回未发的 `connector_outbox`；拒收时指数退避并在主人下次发言时合并补发。

## 怎么走

**主人发送消息**

1. `Channel.say` 在单写锁内将消息、提及、关注和 `Trigger` 写入库，推进主人已读游标。
2. 调用 `Mailbox.receive` 在事务内写投递行与路由回执（中途崩溃由启动重放恢复）。
3. 施加 `messageChanged`、`channelChanged`、`ownerMentionsChanged` 事实，并向 WebSocket 订阅者推送。

**派活开启工单串与贴出汇报**

1. 收到 `Session.news` 的 `hired` 时，若工单尚无串则发派活消息并在其下建工单串；若已有串则在原串内发接手通知并让新帮工关注该串。
2. 收到 `reported` 时，将帮工本轮结论以帮工名义贴入工单串（叫停的不贴）。

## 和谁打交道

- **信箱**：Channel 算出候选受众并落库后，交 [Mailbox](docs/subsystems/mailbox.md) 执行刹车、蓄水与唤醒。
- **帮工与管家（`session`、`orchestrator`）**：订阅 `Session` 事件维护串；管家经 `Channel.post` 的 `Run` 写回复（在服务端里跑的 agent 一轮说的话，一整条）。
- **工单与通知（`issue`、`inbox`）**：向工单广播 `ownerInThread`；向 Inbox 提供 `ownerMentions` 并消费 `Inbox.toOwner`。

## 为什么这样

- **人与 agent 共处群聊，一张工单固定一个工单串**：帮工直接在串内汇报和提问，避免管家转述失真；重开或换人复用原串，上下文不散落。
- **消息不进 `StateFrame`，走按修订号的 RPC 订阅**：避免数百条消息放大全局帧体积，同时支持断线后按 `revision` 增量补齐。
- **帮工说话前拦截未读，末尾汇报自动贴出**：防止多帮工并发抢答或误发顶层频道，也省去每轮末尾额外调一次说话工具。
- **外部连接器只做频道门面，只走出站连接**：三家平台共用一套收发去重与退避桥接层，不建第二套 agent 循环，且只认配对主人以守住本机命令执行安全。

## 还没做的

- 不支持 MCP 的农机使用 CLI 说话工具：[其他农机提案](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)。
- 单条 WebSocket 连接合并状态增量与在线状态：[页面的连接接着带上在线状态和工单的增量](.agents/notes/proposed/architecture/2026-10-27-presence-and-entity-deltas.md)。

## 怎么验证

- `apps/server/src/channel/channel.test.ts`、`mentions.test.ts`、`recorded.test.ts`：路由、修订号补齐、新鲜度拦截与 `ownerMentions` 测试。
- `apps/server/src/flows/thread.test.ts`、`talk.test.ts`：工单串跨重开复用與私聊休眠恢复测试。
- `apps/server/src/connector/connector.test.ts`、`digest.test.ts`：微信/飞书/QQ 收发去重、退避与配对测试。
- `apps/web/test/chat.spec.ts`、`chat-messages.spec.ts`、`chat-rest.spec.ts`、`channel-follow.spec.ts`：聊天界面与实时订阅端到端测试。
