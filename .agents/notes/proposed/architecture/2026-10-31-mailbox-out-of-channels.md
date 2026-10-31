# Agent Note: 频道只记话，信箱把话交给 agent：从 `Channel` 拆出 `Mailbox`，去掉 `useHelpers`

Status: proposed

## Problem

`apps/server/src/channel/chat.ts` 1,949 行，`Channel` 的接口有 55 个成员（`chat.ts:322`–`424`）。它同时是两件事：

- **记话**：频道、串、消息、@、跟帖、已读、回应、置顶、附件、搜索、订阅（`follow`、`reports`），主人改、删、标已读。
- **交话**：一条消息之后谁被拦下（三道刹车，`audience.ts:114`–`118`）、投递表 `channel_delivery` 的状态机（`deliveries.ts`，`pending` → `announced` → `handed` → `seen`）、叫醒和忙时提示（`kick`、`notify`，`chat.ts:1024`–`1078`）、重试和熔断（`later`、`WakeBreaker`，`chat.ts:520`、`breaker.ts`）、压缩时不插话（`chat.ts:508`）、一轮的开口和结束（`onActivity`，`chat.ts:1080`–`1123`）、管家的叫醒流和摘要（`forOrchestrator`、`orchestratorDigest`）。

交话要调帮工（`Session.deliver`），而 `modules.ts:15`–`16` 把 Collaboration（`channel`、`artifact`）排在 Agent Sessions 前面，频道不能 import 帮工。现在的绕法是反向登记：

- 频道定义 7 个成员的端口 `Helpers`（`chat.ts:462`–`474`），存在可变的 `let helpers`（`chat.ts:483`），10 处用 `helpers?.` 兜「还没登记」（`chat.ts:591`、`592`、`696`、`1022`、`1220`、`1549`、`1550`、`1553`、`1603`、`1625`）；没登记时投递被拒成 `server.channel.notBack`（`chat.ts:1022`）。
- 帮工模块在自己的 `make` 里调 `chat.useHelpers`（`session/session.ts:1332`），把三条流接到 `chat.activity`、`chat.consumed`、`chat.sessionNews`（`session.ts:1343`–`1345`），在 `restore` 里调 `chat.helpersBack`（`session.ts:1066`），并从频道 import 自己的 4 个形状 `Delivered`、`InputConsumed`、`LaunchActivity`、`SessionNews`（`session.ts:68`）。这些形状说的是帮工的事，却定义在频道里（`chat.ts:432`–`460`）。

这个端口的理由写在 [地基](docs/subsystems/foundation.md)（「频道的 `Helpers` 是因为频道在帮工模块下面」，第 153 行）。查 import：排在 Agent Sessions 前面的模块里，只有 `session/session.ts:68` import 频道，而且只为了这个端口；`artifact` 的使用方（`handlers.ts`、`http/artifact.ts`、`tool/tool.ts`）都在 Agent Sessions 上面。方向不必倒过来，端口立着只因为排序。

`Helpers` 的 7 个成员里 6 个是只读的查询（在不在、地里的帮工、现在哪一轮、汇报的摘要、工单现在谁在做、按 id 找帮工），1 个是命令（`deliver`）。`Session` 已经公开了其中 3 个（`deliver` 184 行、`sessionOf` 199 行、`presentSessions` 200 行）和三条流（`launches`、`news`、`inputsConsumed`，222–226 行）。

## 进度

第 1 个 PR 的形状和结构已经落地：`Delivered`、`LaunchActivity`、`InputConsumed`、`SessionNews` 在 `session/shapes.ts`；`Session` 给出 `present`、`runOf`、`reportOf`、`onIssue`；模块顺序换成 Agent Sessions → Collaboration；`Channel` 直接 `yield* Session` 并订阅它的流，`Helpers`、`useHelpers`、`helpersBack`、`activity`、`consumed`、`sessionNews` 都删了；`channelStart` 排在 `agentSessionsStart` 后面，给接回来的帮工开串、送出等着的话。`chat.test.ts` 用一个 played Session（`Channel.layerWith`）跑，不再靠注入。第 2 个 PR 的接缝也有了：`chatAudience` 拆成 `whoHears`（谁该听到）和 `brakes`（三道刹车），`post(w, heard)` 在同一个事务里写消息、调 `heard`，现在的 `write` 就是 `post(w, settle)`；调用方和表都没动。剩下第 3、4 个 PR：`Mailbox` 模块搬家、表改名。

## Proposal
## Proposal

两件事分开做：先把 Collaboration 挪到 Agent Sessions 上面，`Channel` 直接读 `Session`，端口消失；再把「交话」拆成新模块 `mailbox` 的服务 `Mailbox`，排在 Collaboration 后面，`chat.ts` 只记话。行为不变：现有的测试、黄金数据和 flows 原样通过是每一步的门槛。

### 名字

服务叫 `Mailbox`，文件夹 `apps/server/src/mailbox`，标签 `vibevalley/Mailbox`。

- 服务用概念的单数词，和文件夹、表同一个（[命名](docs/style/naming.md)）；内存里一人一个信箱（`Deliveries.open` 按收件人分，`deliveries.ts:11`）是服务装着的一组，不改服务的名字。
- 和 [编排层：每个 agent 一个信箱](.agents/notes/proposed/architecture/2026-10-18-one-mailbox-per-agent.md) 用同一个名字和文件夹：本 Note 是它第 1 步的结构部分，只搬不改规则；`Urgency`、规则表和把管家也接进信箱留给那篇。
- 不叫 `Deliveries`：deliver 在仓库里已经指三样东西：`Session.deliver`（把一句话交给一轮，`session.ts:184`）、工单交付了什么（`issue_delivered`、`issue_deliver`，`0001_schema.up.sql` 142、144 行，用语表「完成」一行的 `delivered`）、频道的投递。再拿它当服务名，双关更深。
- 不叫 `Inbox`：那是要主人处理的事（`inbox/`）。

用语表加一行：信箱、mailbox、`Mailbox`（`mailbox_delivery` 表）、一个 agent 还没看到的话。

### 模块的先后

```
Platform, Agents, Source Control, Agent Sessions, Collaboration (channel, artifact), Mailbox (mailbox), Issues, Inbox, Orchestrator, Gamification, Gateway
```

十个模块变十一个；`modules.ts` 开头的注释、[架构](docs/architecture.md) 的「分层」、[地基](docs/subsystems/foundation.md) 第 46、47、153 行跟着改。`Channel` 只读 `Session`（`sessionOf`、`presentSessions`，和新公开的三个查询）；`Mailbox` 用 `Channel` 和 `Session`（`deliver`、三条流）。`modules.test.ts` 守住 `channel/` 不能 import `mailbox/`，`session/` 不能 import 两者。

`Session` 新公开三个查询，取代 `Helpers` 剩下的成员：

| `Helpers` 的成员 | 以后 |
|---|---|
| `present`、`sessionOf`、`presentSessions` | `Session.sessionOf`、`presentSessions`（已有） |
| `deliver` | `Session.deliver`（已有） |
| `currentRun` | `Session.runOf(id)`：现在的 `currentRun`（`session.ts:1103`），只在 handle 上 |
| `report` | `Session.reportOf(id)`：现在是 `summaryOf(hands.get(id)?.lastText ?? "")`（`session.ts:1336`） |
| `onIssue` | `Session.onIssue(issue)`：现在是 `sessionOnIssue(core.state(), issue)?.id`（`session.ts:1337`）；频道不能读核心状态里的 `sessions` |

`Delivered`、`InputConsumed`、`LaunchActivity`、`SessionNews` 挪进 `session/session.ts`：它们是 `Session` 的返回和流的形状。

### 记话和交话的接缝：一条消息和它的投递仍在一个事务里

[频道](docs/subsystems/channel.md) 的不变量：一条消息和它的 @、跟帖、投递在一个事务里写进库（第 30 行）。拆开以后由一个按次传入的钩子保住，不是登记：

- `Channel.post(w, heard)`：在 `Channel` 的锁和事务里写消息、@、跟帖、开串，算出「谁该听到」（不带刹车的 `chatAudience`），然后在**同一个事务里**跑 `heard(posted)`，提交后施加事实、推订阅、取链接预览。`heard` 由 `Mailbox` 给：上刹车、写投递、改自己内存里的账。事务失败时两边各自从库里重读（`Channel` 照旧 `reload`；`Mailbox` 在 `post` 外面接 `onError`）。
- 先例：`Session.handOver(id, closed, use)`（`session.ts:206`）也是上面的模块按次把一段要在下面的流程里跑的活传进去。

`chatAudience`（`audience.ts:105`–`151`）拆成两半：

- **谁该听到**留在 `channel/audience.ts`：@、私聊、汇报、工单串的主人、跟帖的、频道里的；输出收件人、理由、叫不叫醒，按加入的先后。这和信箱 Note 的第 5 节一致（「谁该听到」是频道的规则）。
- **三道刹车**挪进 `mailbox/`：按同一个先后走一遍，照 `audience.ts:114`–`118` 定 `heldBy`，照 118 行给来回次数加一。逐条的先后不变，所以合起来和今天的 `chatAudience` 逐字节相同。

`Audience` 类（`audience.ts:9`–`66`）也拆：`follows`（谁跟着哪个串）进 `channel/model.ts`，跟帖在 `Channel` 的事务里写（`chat.ts:734`、`795`、`797`、`930`、`1181`），`inboxOf` 查询也读它（`db/queries/channel.sql` 的 `InboxOf`）；`hopsIn`、`ownerLast`、`lastWakeOf` 进 `mailbox/`，只有刹车用。

两张表在不同事务里先后改的几处（今天在一个事务里），一律按「宁可重复给，不会丢」排先后：

| 动作 | 先 | 后 | 中间断了 |
|---|---|---|---|
| 一轮开口（`heardLaunch`，`chat.ts:758`） | 频道的看到标记 `channel_seen_mark` | 投递标 `seen` | 投递再交一次 |
| 帮工发话前先看没看到的（`speak`，`chat.ts:1584`–`1597`） | 看到标记、已读位置 | 投递标 `seen` | 同上 |
| agent 读（`read`，`readUpTo`，`chat.ts:747`–`753`） | 已读位置 | 投递标 `seen` | 同上 |
| 删消息、删频道 | 丢掉还开着的投递（`dropped_why: deleted`） | 删 | 主人要删的那条少叫一次 |

### 方法归谁

| 归 `Mailbox`（12 个，从 `Channel` 搬来，名字不变） | 理由 |
|---|---|
| `say`、`speak`、`tellSession`、`announce`、`spoken`、`orchestratorSays` | 写的话可能叫醒人，或是主人的话（主人开口重算来回次数，`chat.ts:907`）；都经 `channels.post(w, heard)` |
| `read` | agent 读到哪，投递就算看到；`lastRead`（`chat.ts:510`，读完串再发频道要确认）也跟着走，只有 `read` 和 `speak` 用 |
| `remove`、`previewRemove`、`removeChannel` | 先丢投递；`previewRemove` 数还在等的投递（`chat.ts:1474`） |
| `forOrchestrator`、`orchestratorDigest` | 管家的叫醒和摘要就是它的信箱 |

| 消失（5 个） | 以后 |
|---|---|
| `useHelpers`、`helpersBack` | `Mailbox` 直接 `yield* Session`；`helpersBack`（`chat.ts:1256`）变成 `mailbox` 的开机 layer，在 `services.ts` 里紧跟 `agentSessionsStart`（今天它在 `Session.restore` 的末尾，`session.ts:1066`，同样在 `issuesStart` 之前） |
| `activity`、`consumed`、`sessionNews` | `Mailbox` 在建的时候自己订阅 `Session.launches`、`inputsConsumed`、`news`，一次处理一条，和今天一样 |

`Channel` 留 38 个，加 `post`、`openThread`（派活的那句和工单串，`chat.ts:1136`–`1193`）、`left`（帮工走了，参与者记离开，`chat.ts:1195`–`1207` 的频道那一半）、`markSeen`、`unseen` 5 个，共 43 个。帮工的新闻只由 `Mailbox` 一处订阅：`hired` 调 `channels.openThread`，`left` 先丢投递、清熔断和提示的计时，再调 `channels.left`，`reported` 自己经 `post` 贴汇报（汇报要叫醒管家，`audience.ts:130`–`132`），保持今天「一条处理完再下一条」（`chat.ts:1238`–`1254`）。

`mentions.ts`、`targets.ts`、`search.ts`、`embeds.ts`、`folded.ts`、`model.ts` 留在频道：@ 在消息的事务里解析并写进 `channel_mention`。`wake.ts` 拆开：`InboxMessage` 进 `channel/model.ts`（频道的 `read`、`recent` 和管家的 `situation.ts` 用），`wakeMessages`、`summaryChannels`、`retryWindowMs`、`heldShown`、`UnreadRow` 进 `mailbox/`；`prompts.ts` 的 `wakeInput`、`busyNotice` 进 `mailbox/prompts.ts`，`messageLine`、`inboxLines` 留下（`issue.ts:50`、`tool.ts:25`、`orchestrator/situation.ts:4` 用）。

### 表

照「表名是 模块_概念」，归属变了就改名，不留兼容（直接改 `0001_schema.up.sql`）：

| 现在 | 以后 | 谁写 |
|---|---|---|
| `channel_delivery`，枚举 `channel_delivery_reason`、`channel_delivery_held_by`、`channel_delivery_state` | `mailbox_delivery`，枚举 `mailbox_delivery_reason`、`mailbox_delivery_held_by`、`mailbox_delivery_state`；`db/queries/mailbox_delivery.sql` | `Mailbox` |
| `channel_follow`、`channel_seen_mark`、`channel_mention`、`channel_read_cursor`、`channel_participant`、`channel_message`、`channel`、`channel_attachment` | 不变 | `Channel` |

`mailbox_delivery` 的外键照旧指 `channel_message`（`on delete cascade`）和 `channel_participant`：上面的表指下面的表。`mailbox_mail` 是信箱 Note 第 6 节的事（它把叫醒的列从投递里分出去），这里不提前做。

### 调用方

| 调用方 | 改成 |
|---|---|
| 管家 `orchestrator.ts` | `say`（438 行）、`orchestratorSays`（196、309 行）、`spoken`（443、468 行）、`forOrchestrator`（401 行）、`orchestratorDigest`（267 行）走 `Mailbox`；`defaultChannel`、`topOf`、`addressOf`、`orchestratorOf`、`channels` 仍走 `Channel` |
| 工具 `tool.ts` | `speak`（323 行）、`read`（343 行）、`tellSession`（396 行）、`spoken`（840 行）走 `Mailbox`；`unread`、`placeOf`、频道的增改查仍走 `Channel` |
| 工单 `issue.ts:674`、`merge.ts:42` | `tellSession` 走 `Mailbox`；`ownerInThread`、`linkTalk`、`openDirect`、`notice` 不变 |
| 语音 `voice.ts` | `spoken` 走 `Mailbox` |
| 接口 `handlers.ts:156`、`167`、`168` | `removeChannel`、`remove`、`previewRemove` 走 `Mailbox` |
| 产出 `artifact.ts:179`、`214` | `Artifact.create`、`version` 多收一个说话的函数（照 `handOver` 的 `use`），由 `tool.ts`、`http/artifact.ts` 传 `mailboxes.announce`：`artifact` 在 Collaboration，不能 import `mailbox`；`placeOf` 仍走 `Channel` |
| 连接器 `connector.ts` | 不变：只用 `channelByName`、`defaultChannel`、`messageLocation`、`now`；主人在外面说的话经 `Orchestrator.say` 进来 |
| 定时任务、Inbox、`http/rpc.ts`、`http/attachment.ts` | 不变 |

### 测试

- `channel/chat.test.ts`（901 行，28 个）：假的帮工 `fakeHelpers`（95–127 行）和它背后的 `FakeSessions` 去掉，改搭在 `testing/world.ts` 上，帮工用 oar 的 `scriptedRuntime`（照 AGENTS.md 的测试规矩）。和交话有关的 12 个挪进 `mailbox/mailbox.test.ts`：252、265、282、435、457、472、489、518、558、577、591、641 行的那几个（叫醒帮工、叫到管家、私聊、忙时提示、来回上限、熔断、发话前看没看到的、管家整条写一次、摘要、走了丢投递、重启再交、消息带着轮次）。开串的 3 个（221、239、853 行）留在频道，直接调 `channels.openThread`。新加一个：`mailbox_delivery` 的插入在触发器上失败时，消息也没写，两边内存都重读（照 853 行的做法）。
- 黄金数据：`channel/testdata/rules.jsonl.gz` 6,070 条里，`audienceOf` 2,562、`wakeInput` 200、`busyNotice` 200 共 2,962 条挪到 `mailbox/testdata/rules.jsonl.gz`，输出不改：`audienceOf` 在 `mailbox/recorded.test.ts` 里以「频道的谁该听到 + 信箱的刹车」合起来比；留下 `mentionsIn` 1,500、`parseTarget` 808、`channelNameProblem` 800 共 3,108 条，`recorded.test.ts` 第 12 行的 6 改成 3。
- `testing/world.ts:74` 的叠法改成 `agentSessions(o), collaboration(o), mailbox(o)`；`session/session.test.ts:16` 改从 `session.ts` import `LaunchActivity`。flows（`thread`、`talk`、`issue`、`reach`、`work`）不改，必须原样通过。

### 做的顺序

每步一个 PR，每步的门槛是 `vp run server:check` 通过、黄金数据没有 diff；文档在同一个 PR 里改。

| PR | 改什么 | 不改什么 |
|---|---|---|
| 1. Collaboration 挪到 Agent Sessions 上面 | `modules.ts` 换序；4 个形状挪进 `session.ts`；`Session` 公开 `runOf`、`reportOf`、`onIssue`；`Channel` 直接 `yield* Session`，自己订阅三条流；`Helpers`、`useHelpers`、`helpersBack`、`activity`、`consumed`、`sessionNews` 删掉，`helpersBack` 变成 `channel` 的开机 layer 跟在 `agentSessionsStart` 后面；`chat.test.ts` 搭在 `world.ts` 上；改 [地基](docs/subsystems/foundation.md)、[架构](docs/architecture.md)、[频道](docs/subsystems/channel.md) 第 10、131 行、[帮工](docs/subsystems/session.md) 第 137 行 | 文件不挪，`chat.ts` 只少 `Helpers` 和形状（约 70 行） |
| 2. 在 `chat.ts` 里先切好接缝 | `write` 变成 `post(w, heard)`；`chatAudience` 拆成谁该听到和刹车；`Audience` 拆开；交话的方法和状态挪到 `make` 里的一段，只经 `post` 和几个查询碰记话的部分 | 不加文件、不改调用方；评审只看接缝对不对 |
| 3. 新模块 `mailbox` | `Mailbox` 带着第 2 步那一段搬进 `mailbox/mailbox.ts`，刹车、`deliveries.ts`、`breaker.ts`、`wakeInput`、`busyNotice` 和常数搬进 `mailbox/`；开机 layer 改成 `mailbox` 的；调用方照上表改；`Artifact.create`、`version` 收说话的函数；黄金数据分开；12 个测试挪走；`modules.ts` 加 Mailbox；改频道文档的「在哪」「和谁打交道」「为什么这样」、[concept-map](docs/reference/concept-map.md)、用语表 | 表名 |
| 4. 表改名 | `channel_delivery` → `mailbox_delivery`（表、三个枚举、索引、`db/queries`），`vp run --filter @vibevalley/server db:generate`；`scripts/stale-names.ts` 拦 `channel_delivery`；改 [架构](docs/architecture.md) 的「存了什么」、频道文档的表那一行 | 行为 |

第 1 步自己就去掉了注入；第 3、4 步之间表名错位一个 PR，第 4 步紧跟。

## Alternatives considered

**留着注入。** 不动最便宜。代价是一直在：可变的 `let helpers` 和 10 处 `helpers?.`，「还没登记」是一种要处理的状态（`server.channel.notBack`）；开机分成「建」和「登记后再补一遍」两段（`helpersBack`）；帮工自己的 4 个形状住在频道里。端口的理由（[地基](docs/subsystems/foundation.md) 第 153 行「方向必须倒过来」）不成立：频道下面没有别的模块要它。`chat.ts` 也照样是全仓库最大的服务文件之一，改刹车要在 1,949 行里找。

**只做第 1 步。** 注入没了，`chat.ts` 只少约 70 行，记话和交话还在一把锁、一个文件里。可以作为止损点：第 2 步评审不过，停在这里也是好的状态。

**整个 `chatAudience` 和 `mentions` 都搬进信箱**（D7 原来的草图）。谁该听到要读跟帖、串的主人、@、在不在，这些是频道的账，在消息的事务里写；全搬走，信箱就要读频道内存里的大半，或频道把整个模型传上去。信箱 Note 第 5 节也把「谁该听到」留在频道。只搬刹车，接缝上传的是一个有序的收件人列表。

**按「投递」和「叫醒」切：投递表留在频道，只把 `kick`、`notify`、`onActivity` 搬走。** 投递表就有两个写入方：频道插行，信箱改状态。`deliveries.ts:4`（「Only the chat writes the table」）和 [频道](docs/subsystems/channel.md) 第 33 行的「只有它写这几张表，所以记着的和库里的一样」就不成立，内存里的 `Deliveries` 归谁也说不清。状态机和插行在一处，所以表整个归信箱。

**并进帮工模块。** `session.ts` 已经 1,366 行，再加约 600 行；管家不是帮工，叫醒管家（`chat.ts:1027`–`1040`）和它的摘要会住进帮工模块；帮工模块还要写频道的表。[地基](docs/subsystems/foundation.md) 第 152 行否决过「并成大模块」。

**`Channel` 留在 Agent Sessions 下面，在不在由 `Mailbox` 每次传下去。** 能让频道完全不认识帮工，但「在不在」要传进 `post`（@ 解析、跟帖）、`placeOf`（帮工自己的串）、`removeChannel`（帮工在用的频道不能删）、`unread`（帮工所在的频道）等至少 5 个入口，每个调用方都得先问 `Session`。频道读帮工是只读的、真实的依赖，直接读比到处传简单。

**照信箱 Note 一次做完。** 规则表、`Urgency`、管家的五个流一起改，是行为变化，测试要一格一格改；和搬家混在一起，出了问题分不清是搬坏的还是改坏的。先搬，规则留给那篇。

## Acceptance criteria

- `rg -n "useHelpers|helpersBack|interface Helpers|helpers\?\." apps/server/src` 没有结果；`session/` 下没有 `@/channel` 或 `@/mailbox` 的 import。
- `modules.ts` 的顺序是 Agent Sessions、Collaboration、Mailbox；`modules.test.ts` 通过，`pending` 是空的。
- `wc -l apps/server/src/channel/chat.ts` 不超过 1,450；`Channel` 的接口不超过 43 个成员；`mailbox/mailbox.ts` 不超过 700 行。
- `rg channel_delivery apps/server docs` 没有结果；`0001_schema.up.sql` 里是 `mailbox_delivery` 和它的三个枚举，`schema.test.ts` 通过。
- 黄金数据：`channel` 3 个函数 3,108 条，`mailbox` 3 个函数 2,962 条，`vp run golden:update` 后没有 diff。
- `vp run server:check` 通过，flows 一个没改。
- 照 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 的服务端分册在真的服务端上：主人在工单串里说一句，帮工被叫醒、那条消息上出现 👀；帮工忙时连说三句，它只收到一次提示；重启后交出去没看到的再交一次。

## Risks

- **两把锁。** 今天写库和写完之后的叫醒在一把锁里（`chat.ts:501`、`969`–`978`）。以后 `Mailbox` 有自己的锁，经它的写入顺序是「信箱的锁 → 频道的锁」；频道不能 import 信箱（`modules.test.ts`），反方向不存在，不会死锁。信箱提交以后、叫醒之前，只经频道的写入（改、回应、置顶、提示、主人标已读）可以插进来；它们都不碰投递，所以不改结果。叫醒时加 👀 经 `channels.react`，在频道的锁里。
- **事务和内存。** `heard` 在频道的事务里改信箱的内存；事务失败时信箱必须重读，否则内存里有库里没有的投递。第 3 步加的那个触发器测试守着这条。
- **熔断只在内存里**（`breaker.ts`，不存库）：整个搬，重启清零和今天一样。主人的话解除熔断要在提交之后（`chat.ts:970`），帮工走了也要清（`chat.ts:1205`），两处都跟着搬。
- **叫醒的时机。** `helpersBack` 从 `Session.restore` 末尾挪到紧跟 `agentSessionsStart` 的开机 layer：两者都在 `issuesStart` 之前，但中间不再是同一个 Effect；`restore` 里施加的「重启打断」汇报（`session.ts:1053`）照旧经 `news` 到信箱，信箱在建的时候已经订阅。重试（`chat.retry_wake_ms`）和忙时攒一批（`chat.notice_batch_ms`）的计时跟着 `FiberMap` 搬，配置的键不改。
- **测试改动大。** `chat.test.ts` 换成 `world.ts` 和 `scriptedRuntime`，`FakeSessions` 演的几种（开口前失败、忙着、压缩）要能用 `scriptedRuntime` 演出来；第 1 步先确认，演不出的再定是给 `scriptedRuntime` 加还是留一个只给测试用的 `Session` 实现。搭整个农场的测试比现在慢。
- **调用处读起来。** `mailboxes.say`、`mailboxes.read` 不如 `channels.say` 直白；方法名第 3 步先不改，减少调用方的改动。
- **和信箱 Note 重叠。** 那篇的第 1 步以后从 `mailbox/` 起，「`channel` 改成投信」已经做完；它第 6 节的 `mailbox_mail` 和本 Note 的 `mailbox_delivery` 由那篇决定是否合并。
- **有意放弃的**：消息和投递以外的跨表原子性（见上面的先后表）；`Channel` 不认识帮工（它仍读 `Session`）。
