# 频道

频道（`Channel`）是用户、助手和帮工说话的地方，含公共频道 `channel`（默认 `general` 叫「田头」）、私聊 `direct` 和工单串 `thread` 三类通道。外部聊天软件（微信、飞书、QQ）经连接器（`modules/collab/connector`）各接到一个频道上：用户在那边对机器人说的话记成他在这个频道里说的，农场里该用户听的话（助手的话、汇报、派活、`@` 他的）在他还没在农场里读到时发到那边。

连接器按平台和外部消息标识登记入站消息。一批消息与读取游标在同一个 SQLite 事务中保存。换绑账号时，连接器同时清除旧入站记录并退役旧待发消息。重启后只读取 `pending` 状态的出站分片，按序号投递。平台已接收但本地尚未记录回执的分片仍可能重发。[连接器查询](crates/server/src/db/queries/collab_connector.sql)

## 读取频道消息

原生工作台经进程内桥调用 `channel.message.list` 读取最新一页。向前翻页时，`before` 取当前最早的消息号。工作台从已读到的最大修订号订阅 `channel.follow`，按消息号合并新增和修改，保留修订号较大的版本。读取分页和申报已读位置是两次调用。[工作台消息列表](apps/mac/ui/features/channel/model/follow.ts) · [频道契约](packages/protocol/src/channel/api.ts)

命令行通过 HTTP `/api/v1` 访问同一频道服务。执行 `vibevalley channel message list general --limit 10` 可读取田头最近十条消息。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 频道、私聊、串的增删改查，消息号与地址 `#<频道>:<消息号>` | 工单生命周期与派活决策（[工单](docs/subsystems/issue.md)） |
| 消息写入、编辑、删除、回应、置顶、带附件、搜索与链接预览 | 投递后的工单/帮工唤醒与单轮汇报执行（[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)） |
| 纯受众计算与环路刹车（`dispatch.rs`：`who_hears`、`hopLimit`、`cooldown`）及持久待发队列表 `channel_delivery` | 会话如何跑一轮、私聊执行器休眠实现（[帮工](docs/subsystems/session.md)） |
| 阅读游标（`channel_read_cursor`）与未处理 `@用户`（`userMentions`） | 哪些未读事项提醒用户（[核心状态的收件箱](docs/subsystems/core.md#收件箱)） |
| 页面按频道的订阅流（`channel.follow`、`channel.reports`）与按修订号（`revision`）补齐 | 助手如何生成回复（[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/server/src/modules/collab/channel/` | `Chat` 核心、事务保存点（`store.rs`）、消息写入/编辑/搜索（`messages.rs`）、房间/投递/订阅流（`rooms.rs`）、DTO 与映射（`types.rs`）及 Hub 端点安装（`service.rs`）；每条消息连同 `channel_event` 与 `channel_delivery` 待发记录在同一个事务里落库，提交后非阻塞发出 `Chat::committed` 与 `Chat::dispatches` |
| `crates/server/src/modules/collab/channel/dispatch.rs` | 纯受众规则（`who_hears`）、两道环路刹车（`brakes`：`hopLimit = 4`、`cooldown = 60s`）与 `plan_deliveries`，仅读频道模型与参与者表，零依赖 `issue`、`session` 或 `orchestrator` |
| [频道表结构](crates/server/src/modules/collab/channel/sql/schema.sql)、[命名查询](crates/server/src/db/queries/collab_channel.sql)、`db.rs` | sqlc 生成 SQLx 查询。频道连接在 `server.db` 上读写消息、串与 `channel_delivery` |
| `crates/server/src/modules/collab/channel/model.rs` | 写事务在频道锁内更新镜像。回滚恢复原镜像与环路记账，提交后才向订阅者发布 |
| `crates/server/src/modules/collab/channel/words.rs` | `@` 识别、地址解析、搜索过滤与公网链接预览 |
| `crates/server/src/transport/http/mod.rs` | 订阅流（SSE，`/api/v1/subscribe/<名字>`，[SSE 流](docs/subsystems/core.md#sse-流和其余路由)） |
| 表 `channel`、`channel_participant`、`channel_message`、`channel_mention`、`channel_member`、`channel_read_cursor`、`channel_seen`、`channel_event`、`channel_delivery` | 频道与消息；`channel_seen` 是参与者在聊天之外收下的消息，`channel_event` 是按提交次序编号的事件（`posted`、`removed`），`channel_delivery` 记录持久 `pending` / `delivered` / `withdrawn` / `failed` 投递 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`channel.*`；附件见[附件](docs/subsystems/attachment.md)）。

## 模型和不变量

### 通道、消息与订阅

- **三种通道类型（`channel.type`）**：
  - `channel`：具名频道，可设说明、分组、排序、默认仓库和负责助手；全农场唯一默认频道（`is_default = 1`，初始 `general`）不可归档或删除。
  - `direct`：用户与单个助手或帮工档案的私聊；与帮工私聊直接拉起绑定该频道的 `Session`（用独立 `contexts/` 目录，闲置 10 分钟休眠），不建隐藏工单。
  - `thread`：挂在父频道某条消息下的串；每张工单固定一个工单串（`subject_kind: "issue"`），重开或换帮工复用同一串。
- **一把锁串行写库，内存镜像提交后才改**：所有写操作在 `Chat` 的锁里串行提交，消息号从 `1` 递增（对外地址 `#<频道>:<消息号>`）；内存镜像（`model.rs`）只在事务提交后改，回滚的不留。
- **核心状态只留近期摘要，正文按频道订阅**：`SpaceState.chat` 仅保留最近 100 个频道/串摘要与全量未处理的 `userMentions`。正文经订阅流 `channel.follow({ id, after })` 读：消息增改删或置顶均递增 `revision`，重连落后 200 条以内按修订号补齐，超出则回 `Reset` 重拉最新页。
- **主动阅读与被动消费分开记账，都在聊天里**：
  - 调读取接口、自己说话推进 `channel_read_cursor.read_number`。
  - 会话收下投递的消息记进 `channel_seen`（`Chat::mark_seen`）：下游消费方（`work/issue`、`team/orchestrator`）成功交出消息后结算 `channel_delivery`、记 `channel_seen` 并贴 👀。未读（`UnreadOf`）和说话前的新鲜度（`UnseenIn`）都排除这两样。
- **参与者只记谁在说话，线上读 `ChatMessage.actor`**：一个农场只有一个人。`channel_participant` 记 `kind`（`user`、`agent`、`system`）、名字、「家」，和 agent 的席位代哪个档案说话（`agent_id`）：助手是档案自己说话（没有），帮工（会话、私聊里档案的席位）代它的档案说。消息的 `Actor` 由此得出（代档案说的是 `worker`，否则是 `orchestrator`）。农机、会话里的角色是 `Session` 的事，不记在聊天里；席位由所属领域排（`Chat::seat`：助手在 `channel/service.rs`，工单会话在 `work/issue`，私聊会话在 `work/session`）。
- **写话按要做的事分四个门，都落进同一个写**：`say`（用户的话，页面和命令行都走它，农场随之上线）、`speak`（agent 经说话工具说的话：同样的话 60 秒内是同一条，有没看过的新话先给它看、不发，读完串立刻发顶层频道要确认）、`post`（以谁的名义写进一处：它的家、带上做出来的 Artifact 或图片、服务端里跑的 agent 一轮说的话、通话里说的、工单对它的帮工说的；说话的人读到自己这句）、`notice`（农场的通知，尽力而为、不会失败；`untilUserSpeaks` 的在一处只说一次，直到用户再在那里说话）。消息的 `run` 由调用方给（工具、Artifact 的 `Maker`），频道不问会话。
- **频道只靠底座，同步路由与异步唤醒严格分层**：`modules/collab/channel` 只用附件和 `Hub`，零 import `issue`、`session`、`orchestrator`。每次写入在同一个 SQLite 事务内完成 < 1 ms 的纯策略计算（`dispatch::plan_deliveries`）并落盘 `channel_delivery`（`pending`）与 `channel_event`；若触发 `hop_limit` 则紧跟原消息写出通知；提交后非阻塞推送 `Chat::dispatches()` 与 `Chat::committed()` 即返回，绝不等待慢速 `Board::tell_message` 或 `runtime.open`。`Chat::remove` 在同一事务中将对应消息的 `pending` 投递立刻标记为 `withdrawn`，`Chat::preview_remove` 直接从 `channel_delivery` 统计待撤回条数。参与者的「家」（`channel_participant.home_id`，`Chat::home_of`）是空目标的去处，由工单与会话模块在开串、拉起私聊时给。删频道时查谁还指着它：频道只数自己的话题串，工单、帮工与连接器各自通过 `guard_removal` 登记理由。
- **发送幂等键 `sendKey`**：用户发言带 `sendKey`（唯一索引 `(sender, send_key)`），重发返回原消息；帮工 60 秒内向同处发相同正文也自动去重。

### 受众计算与说话防撞

频道和串都有成员，记在同一张 `channel_member`：串的成员是开串的人、回过话的、被 `@` 的和手动加的；频道的成员是用户放进来的助手（只有助手能放），新频道和默认频道一开始就有默认助手。私聊的成员就是对面。没人点名的话发给成员，被 `@` 的另外加上；一个成员都没有的频道，要 `@` 才有人接。

用户发言可带 `to`（一个助手的档案 id）：只交给他，不交给成员，`to` 不是助手就拒绝；输入框的 `/imagegen` 用它把生图交给这里的助手（[媒体](docs/subsystems/media.md)）。

「这里的助手」（`Chat::orchestrator_in`，`T.Channel.orchestrator`）由频道一处算（`crates/server/src/modules/collab/channel/store.rs`，按助手的席位认谁是助手）：私聊是对面（他是助手时），否则是频道成员里的默认助手或第一个助手，都没有就是默认助手；泛称的「@助手」、派活说明的署名、没指定人的工单和定时任务、没人收的机器事件都交给它。

| 发言者与位置 | 唤醒目标 | 被动通知（仅知晓） |
|---|---|---|
| 用户在公共频道 | 被 `@` 的对象；未 `@` 他人时为频道里的成员（用户放进来的助手） | 该频道内的在场帮工 |
| 用户在私聊 | 私聊对象（对应助手或帮工档案 `Session`） | — |
| 用户在工单串 | 被 `@` 的对象、该工单当前帮工、关注该串的对象 | — |
| 助手或帮工发言 | 被 `@` 的对象；在工单串内发言唤醒该工单当前帮工 | — |
| 帮工回合结束汇报 | 失败时唤醒所在频道的成员 | 完成时作为摘要捎带给成员 |

- **两道环路刹车（`dispatch::brakes`）**：
  - **跳数上限 `hopLimit` = 4**：同一处（`channel:<id>`）自用户上次发言起，agent 发言叫醒他人累计达 4 次后，后续 agent 唤醒标记 `HeldBy::HopLimit` 并在频道写出一次 `hop_limit` 通知（`untilUserSpeaks`），直到用户再次发言清零。
  - **冷却 60 秒**：agent 发言 60 秒内再次叫醒同一帮工会话（助手不受冷却）标记 `HeldBy::Cooldown`。
  - 用户发言不受两道刹车限制；非唤醒或被拦下的帮工消息保留在 `channel_delivery`（`status = 'pending', wakes = 0`），随该会话下一次合法唤醒一并带出。
- **帮工说话前新鲜度拦截**：帮工刚读串却要发往顶层频道时先要求 `confirm`；目标通道有未读新消息时先拦截并返回最旧 3 条未读，帮工可改后再发或带 `anyway: true` 照发。
- **附件与公网链接预览**：消息只带附件的 id，存和读归[附件](docs/subsystems/attachment.md)；消息中的公网 `http(s)` 链接在后台抓取标题与摘要（拦截内网与云元数据地址，限 3 次跳转、3 秒、512KB）。

## 怎么走

**用户发送消息**

1. `Chat::say` 在单写锁内将消息、提及、关注、`channel_event` 与 `dispatch::plan_deliveries` 算出的 `channel_delivery`（`pending`）在同一个事务里写入库，推进用户已读游标。
2. 提交后施加 `messageChanged`、`channelChanged`、`userMentionsChanged` 事实，向订阅流推送，非阻塞发出 `Chat::committed` 与 `Chat::dispatches`（若触发 `hop_limit` 则紧跟写出通知）并立即返回。
3. 各领域消费方按目标类型异步消费 `Chat::dispatches`（重启时先补读 SQLite 中的 `pending` 投递）：`work/issue` 按工单串行投递至 `Board::tell_message`、`work/session` 按目标档案异步拉起私聊 `Sessions::talk`、`team/orchestrator` 交由 `Orchestrator::hear`/`overhear`；消费完成后结算 `channel_delivery`、记 `mark_seen` 并贴 👀。

派活开串、单轮汇报与 `issue.report` 补投归[工单](docs/subsystems/issue.md)（`work/issue/chat.rs`），席位清理、删频道守卫与私聊帮工归[帮工](docs/subsystems/session.md)（`work/session/mod.rs`），频道只提供 `note`、`seat`、`leave`、`thread_about` 与 `channel_delivery` 原语。

## 和谁打交道

- **工单、帮工与助手（`issue`、`session`、`orchestrator`）**：频道不 import 它们；三者分别通过 `Chat::dispatches()`、`pending_deliveries`、`settle_delivery`、`mark_seen`、`react`、`note`、`seat` 与 `guard_removal` 异步接入；助手经 `Chat::post` 写回复。
- **收件箱与连接器（`core`、`connector`）**：收件箱读 `userMentions`（[核心状态](docs/subsystems/core.md#收件箱)）；外部聊天连接器订阅 `Chat::committed` 与 `Chat::user_reads`。

## 为什么这样

- **人与 agent 共处群聊，一张工单固定一个工单串**：帮工直接在串内汇报和提问，避免助手转述失真；重开或换人复用原串，上下文不散落。
- **消息不进 `StateFrame`，走按修订号的订阅流**：避免数百条消息放大全局帧体积，同时支持断线后按 `revision` 增量补齐。
- **帮工说话前拦截未读，末尾汇报自动贴出**：防止多帮工并发抢答或误发顶层频道，也省去每轮末尾额外调一次说话工具。

## 怎么验证

- `crates/server/tests/channel.rs`：频道、私聊、串、消息与订阅经端点走一遍。
- `crates/server/tests/watch.rs`：写话等路由、交给帮工。
- `apps/mac/ui/app/scenarios.test.tsx`、`apps/mac/ui/app/interactions.test.tsx`：聊天页渲染与消息发送/实时推流的虚拟时钟页面测试（`nsh/test`）。
