# Agent Note: 正交领域与事件观察：Channel 纯聊天、Session 纯执行、上层按事件观察驱动

Status: proposed

## Problem

在完成 `services.ts` 装配摊平、`library` 并入 `media` 以及 `machine` 并入 `session` 后，服务端顶层 `Farm`（[services.ts](apps/server/src/services.ts)）仍平铺着 24 个粒度悬殊的服务实例，核心复杂度集中在四处边界错位：

1. **`Channel` 绑死了单人类与会话编排，不是纯粹的聊天系统**：
   - 表结构在 [0001_schema.up.sql](apps/server/db/migrations/0001_schema.up.sql) 中将私聊写死为「当前唯一人类 + `peer_id`」，并在 `channel_participant` 上强约束农机字段（`role in ('orchestrator', 'worker')`、`runtime`、`profile:<agent>` 假 ID）；农机和会话的角色本该是 `Session` 的事，却记在聊天的参与者上。
   - [writing.ts](apps/server/src/modules/channel/writing.ts)、`talk.ts` 与 `threads.ts` 在消息层内部反向调用 `Session` 路由消息、雇佣私聊帮工、发汇报与贴 `👀`，迫使 `Channel` 排在 `Session` 之上；而 `Session` 又只能靠 [modules.test.ts](apps/server/src/modules.test.ts) 的 `foreignReads` 白名单直读 `channel.sql.ts`，[channel.sql](apps/server/db/queries/channel.sql) 也反向关联 `session_delivery` 与 `issue`，启动被迫拆成 `session.boot() -> channel.boot() -> session.wake()` 三段交错。
2. **`Session` 混入工单蓄水与代码交付，背离纯 Agent 执行维度**：
   - 会话执行内核（[lifecycle.ts](apps/server/src/modules/session/lifecycle.ts)）本不依赖 `Channel` 或 `Issue`，但模块内塞入了 4 张工单表（`session_issue_input`、`session_subscription`、`session_run_issue`、`session_github_cursor`）、协议上的工单字段（[session/shapes.ts](packages/protocol/src/session/shapes.ts) 的 `issue`、`refining`、`IssueAnswer`）、直读 `core.state().issues` 的工单蓄水池（[work.ts](apps/server/src/modules/session/work.ts)）以及分支合并与跟 PR（当时的 `session/landing.ts`、`session/github.ts`）。
   - 因为第 4 层的 `Session` 不拥有第 6 层的工单表，交付逻辑只能通过 4 个回调组成的 `IssueRecord` 反向写回工单，导致 `Session` 膨胀至 34 个生产文件、44 个接口成员，而 `Issue` 仍需调用 `Session` 的 23 个成员。
3. **「Agent 观察事件」的规则散落在 5 个模块里**：聊天提及、私聊唤醒、工单蓄水、PR 巡检、Cron 到期与 Patrol 心跳分散在 `channel`、`session`、`issue`、`cron`、`inbox` 各处手工拼装触发器，缺少统一的持久化观察游标出口。
4. **网关适配层与外围浅服务错位，跨端旧目录未收口**：
   - [tool.ts](apps/server/src/gateway/tool/tool.ts) 无自有表与核心状态，仅服务于 `orchestrator` 与 `gateway/mcp`，却作为领域模块横跨 10 个服务扇出，在 [service-paths.json](scripts/audit/service-paths.json) 中制造 40 余条伪业务耦合边（掩盖了 `Artifact`、`Media`、`Pkm` 之间零互调的事实）。
   - [agent.ts](apps/server/src/modules/agent/agent.ts) 与 [runtime.ts](apps/server/src/modules/runtime/runtime.ts) 共读写同一份 `config.json` 却拆成两个服务；[user.ts](apps/server/src/modules/user/user.ts) 除 HTTP 外仅被 `gateway/lan` 调用；`setting`、`attachment`、`provider` 属于平台底座原语；`packages/protocol/src/{library,machine}` 与 `apps/web/src/features/library` 仍保留合并前的旧目录。

## Proposal

按「正交事实源底座 → 纯 Agent 执行层 → 事件观察与编排层 → 对外网关」重整全仓边界，将 `Farm` 收敛为 **`Platform` 底座 + 7 组深领域服务 + `Gateway` 层**：

### 目标分层与模块边界

1. **底座 `Platform`（`base`、`infra`、`core`、`setting`、`attachment`、`provider`）**：提供数据库、时钟、核心状态投影底座、`settings.json` 密钥与偏好、内容寻址附件存储与多模态厂商 SDK 客户端，不含业务规则。
2. **基础正交域（彼此零依赖，可独立单测与演进）**：
   - **`Agent`（合并 `agent + runtime`）**：统一管理 `config.json`（档案、技能、农机设置）、模板、oar 安装探测缓存、额度与每日花费（`agent_spend`）、候选档案挑选（`choose` / `resolve`）以及 `pi-durable` Harness（`agent_todo`）。
   - **`Memory`**：保持现有 7 个窄门，管用户与 Agent 记忆检索、写入及外部记忆源同步。
   - **`Repo`**：Git 仓库串行锁、worktree 检出生命周期（`checkout / release / reset / clear`）、带类型的检查执行（`verifyCheckout`，替代裸 `repo.run`）、分支合并与 GitHub/GitLab PR 读写。
   - **`Channel`（纯聊天）**：频道 / 私聊 / 主题串（可选透明外部锚点 `topic`）、统一消息写入 `post`、表情反应、已读游标、全文检索，以及带单调递增序号 `seq` 的持久化 **`ChannelEvent` 事实流**。`Channel` 不依赖 `Agent`、`Session` 或 `Issue`。仍是一个人的农场（[概念](docs/concepts.md)）：说话的是用户、档案和系统，不为多个人类做成对等成员；要拿掉的是对 `Session`、`Issue` 的反向依赖和跨表 `join`，不是单人的模型。
   - **`Content` 垂直域（`Media`、`Artifact`、`Pkm`）**：各自独立暴露领域读写门给 `http` 与 `gateway/tool`，领域间零互调。
3. **纯执行层 `Session`（纯 Agent 维度）**：
   - 只依赖 `Platform`、`Agent`、`Memory`、`Repo`；**不导入 `Channel`，也不导入 `Issue`**。
   - 只管「一个 Agent 实例在某个目录里持续跑轮次」：进程/宿主启停、单会话待消费输入队列与唤醒泵（空闲唤醒、正忙 `steer`/排队、按 `launch` 崩溃重投）、`Run` 记录与轨迹日志、机器执行器（`session_machine`），以及供上层互斥操作工作目录的窄门（`withWorkplace`、`handOver`）。
   - 协议 `T.Session` 去掉 `issue`、`refining` 与 `LastRun.answer`，改用透明归属字段 `scope?: { kind: "issue" | "draft" | "channel" | "duty"; id: string }`。
4. **事件观察与编排层（站在事实源与 `Session` 之上，按事件观察驱动 Agent）**：
   - **`Issue`（含排期 `Cron`）**：管工单状态机、父子拆单与定时规则；拥有工单输入蓄水池（`issue_input`、`issue_subscription`）与 PR 观察游标（`issue_github_cursor`），按持久化游标观察工单主题串消息、PR CI/评审与 Cron 到期事件，依工单状态机放行并调用 `Repo.checkout` + `Session.open / enqueue` 在工单内运行 Agent；完工时调用 `Session.handOver` + `Repo.merge / submitPullRequest` 并将结果直接写回 `issue` 表，废除 `IssueRecord` 回调表。
   - **`Watch`（新模块，吸纳 `Inbox` 与 `Patrol`）**：按持久化游标观察 `ChannelEvent`（跟 Agent 的私聊、`@agent` 提及、设了 `watch: "on_duty"` 的频道）与巡查心跳；所有自动唤醒统一经过纯函数 `brakes.ts`（`hop_limit`、`cooldown`、`wake_breaker`，人类发言重置）后驱动聊天或当值助手 `Session`，并监听 `Session` 回执回写 `Channel` 的 `👀` 反应、已读游标与回复消息；同时汇总给用户的 `Inbox` 通知流供页面、`voice` 与 `connector` 消费。`Orchestrator` 只是助手本身（它的提示、工具和一轮），是 `Watch` 唤醒的对象之一，不兼做观察和派发的枢纽。
5. **外层 `Gateway`**：`http`、`mcp` + `tool`（Agent 工具适配门）、`lan`（远程设备配对的门；`user` 管「那个人」的账号、设备和密码，是领域概念，留作模块，归入 `Platform`）、`voice`、`connector`、`projection`、`game`（只读事件皮）。

### 分五步迁移路径

全部在一个 PR 里，一步一个或几个提交，每步之后全仓可编译、测试全绿。执行次序：第 1 步 → 第 4 步（先把交付搬回 `Issue`，消掉 `IssueRecord` 倒置）→ 第 3 步 → 第 5 步 → 第 2 步。

1. **第 1 步（First Proof：网关归位与跨端旧目录收敛，零表迁移）**：
   - 将 `apps/server/src/modules/tool/*` 迁至 `apps/server/src/gateway/tool/*`，更新 [modules.ts](apps/server/src/modules.ts)、[services.ts](apps/server/src/services.ts) 与 [service-paths.ts](scripts/audit/service-paths.ts)（将 `tool` 与 `http` 同列为外层适配入口），消除约 45 条伪跨模块边。
   - 将 `packages/protocol/src/library/*` 并入 `packages/protocol/src/media/`，`packages/protocol/src/machine/*` 并入 `packages/protocol/src/session/`，`apps/web/src/features/library/*` 并入 `apps/web/src/features/media/`（更新 `apps/web/src/app/App.tsx` 与 `state/prefs.ts`）。
2. **第 2 步（平台原语下沉与 `Agent + Runtime` 合并）**：
   - 将 `apps/server/src/modules/{setting,user,attachment,provider}` 归入 `apps/server/src/platform/{setting,user,attachment,provider}`（在 `modules.ts` 归属 `Platform`）。
   - 将 `apps/server/src/modules/runtime/*` 并入 `apps/server/src/modules/agent/`，表 `runtime_spend`、`runtime_todo` 改名为 `agent_spend`、`agent_todo`（更新 `0001_schema.up.sql` 与 `db/queries/`），对外合并为单一 `Agent` 服务；同步合并 `packages/protocol/src/runtime/*` 与前端引用（或保留子命名空间但服务端单门暴露）。
3. **第 3 步（`Channel` 纯化为对等聊天底座，切断对 `Agent` 与 `Session` 的依赖）**：
   - 修改 [0001_schema.up.sql](apps/server/db/migrations/0001_schema.up.sql) 与 `apps/server/db/queries/channel*.sql`：`channel_participant` 只记说话的是谁（用户、档案、系统），不再记农机（`runtime`）和会话里的角色；私聊仍是用户和一个档案；重写 `UnreadOf` 与 `ChannelInUse`，移除对 `session_delivery`、`issue`、`cron`、`connector_account` 的跨表 `join`（要那些的读法搬到拥有它们的模块）。
   - 重构 `apps/server/src/modules/channel/{channel,contracts,hub,writing}.ts`：从 `ChannelDeps` 移除 `agent` 与 `session`；将 `Post` 收敛为统一 `post`（带可选乐观未读水位检查）并导出带单调 `seq` 的 `Channel.events()`；将 `talk.ts`、`threads.ts` 及 `👀` / `wake_breaker` 回写逻辑抽离至上层观察器。
4. **第 4 步（`Session` 收窄为纯 Agent 执行层，工单蓄水与交付迁回 `Issue`）**：
   - 将 `session/landing.ts` 与 `session/github.ts` 迁回 `apps/server/src/modules/issue/`，删掉 `IssueRecord` 回调表；在 [repo.ts](apps/server/src/modules/repo/repo.ts) 用 `verifyCheckout` 替换裸 `repo.run`；将 `apps/server/src/modules/cron/*` 并入 `issue/`。
   - 将 [work.ts](apps/server/src/modules/session/work.ts) 中的工单蓄水与订阅迁入 `issue/`，表改名为 `issue_input`、`issue_subscription`、`issue_run`、`issue_github_cursor`；将协议 [session/shapes.ts](packages/protocol/src/session/shapes.ts) 的 `issue`、`refining` 改为透明 `scope`，`IssueAnswer` 移入 `protocol/src/issue/`。
   - 将 [session.ts](apps/server/src/modules/session/session.ts) 收窄至约 16 个纯 Agent 执行、单会话队列与工作区租约成员，并把 `session/`、`issue/`、`channel/` 中不碰 I/O 的判断提纯为导出纯函数直测。
5. **第 5 步（收口 `Watch / Orchestrator` 事件观察层，锁死静态正交门禁）**：
   - 新建 `apps/server/src/modules/watch/`，吸纳 `modules/inbox/*` 与聊天观察器：用持久化游标订阅 `Channel.events()` 与定时/巡查触发，统一经 `brakes.ts` 三道刹车驱动聊天与当值助手 `Session`，回写 `Channel` 反应、已读游标与回复，并向外提供人类 `Inbox` 通知流。
   - 将 [services.ts](apps/server/src/services.ts) 的 `session.boot() -> channel.boot() -> session.wake()` 简化为单次正序 `boot()`；清空 [modules.test.ts](apps/server/src/modules.test.ts) 的 `reads` 与 `foreignReads` 白名单，新增静态断言禁止 `Channel` 依赖任何业务模块、禁止 `Session` 依赖 `Channel` 或 `Issue`。

## Progress

- **第 1 步：已做**（`tool` 归入网关，`protocol` 与页面的 `library`、`machine` 旧目录并入 `media`、`session`）。
- **第 3 步：已做（3a、3b）；观察者换成按游标异步读、刹车收口留给第 5 步。**
  - 3a 已做：`Channel` 不再依赖 `Session`（`ChannelDeps` 去掉 `session`）。每条消息和删除在写的事务里记一条 `channel_event`（单调 `seq`），提交后、写话返回前在频道锁里按序告诉观察者（`Channel.observe`；`events(after)`、`replay(after)` 读它）。新模块 `modules/watch`（排在 `Collaboration` 后、`Issues` 前）是观察者：路由（`recordTrigger` + `route`，时序与原来一样，在写话返回前）、开帮工的串和「家」（`channel_participant.home_id`，`Channel.homeOf` 取代 `threadOfSession`）、拉起私聊帮工、贴汇报、👀、熔断通知、`Watch.tell`（原 `Post` 的 `Tell`）、删消息的预览带投递数；持久游标 `watch_cursor` 只往前，开机按游标重放（已路由的跳过，失败的记日志放过一次）。`channel.sql` 去掉 `ChannelInUse` 对 `issue_cron`、`connector_account`、`issue`、`session_issue_input`、`session_trigger` 的 join（改为各模块经 `Channel.guardRemoval` 登记自己的理由），`channel_message.sql` 去掉 `MissingDirectDeliveries`、`UnroutedChannelMessages`（对 `session_delivery`、`session_trigger` 的 join）。开机是 `session.boot()` → `watch.boot()` → `session.wake()`：频道自己不再有 `boot`，交错搬到了观察层。
  - 3b 已做：`ChannelDeps` 只剩 `clock`、`log`、`fetch`、`db`、`core`、`attachment`。席位由 `Watch` 排（`Channel.seat`：助手在开机和档案保存时，帮工在被雇、开串时；`Watch.direct` 按名字开私聊），频道按席位认助手（代档案说的是帮工），`@` 的解析、「这里的助手」、频道成员、`to` 都对着席位查。`channel_participant` 去掉 `role`、`runtime`，只剩 `kind`、名字、代谁说（`agent_id`）、家；`CalledBy` 换成 `CallersOf`，一个会话的话回应了谁由 `Watch` 在提交后判断、随路由答复交回。未读不再查 `session_delivery`：`channel_seen` 记会话收下的消息，`Watch` 收到 `Consumed` 先记它再贴 👀。频道不 import `session`：`Meta`、地址、`AddressedMessage` 归频道，`Watch` 自己拼信箱要的 `ChannelEnvelopeRow`；`modules.test` 查 `modules/channel/**`（测试也算）只 import 底座和自己。`Post` 拆成 `say`（用户，吸收了 `Channel.user`）、`speak`（agent 经工具说，带 held/confirm）、`post`（以谁的名义写进一处）、`notice`（农场的通知）。会话不读聊天的表：`Session.useChat` 收 `Watch` 交的 `ChatView`（默认频道、一处的助手、未读），`foreignReads` 的 `session` 只剩 `issue.sql` 的 `issueExists`，`inbox` 仍读 `channel_message.sql` 的 `messageByID`、`notificationReceipt`、`userReadReports`。
  - 留给第 5 步的（同步回调、开机交错、`inbox` 的 `foreignReads`、`reads` 里的 `mailbox.ts -> issues`）在第 5 步做了。
- **第 5 步：已做（5a–5d）。**
  - 5a：`Channel.observe`、`replay`、`retell`、`callersOf` 拿掉。每次提交的事件经 `Channel.committed` 发出（漏了的用 `events`、`committedOf` 读回）；`say`、`speak`、`post`、`note`、`remove` 提交并放开频道的锁以后等读者处理完（`Channel.awaitReader`），所以「写话返回时路由已做完」的时序照旧（测试照旧断言它，没放宽）；`notice` 不等（它不叫醒谁，观察层处理事件时会写它）。`Watch` 一次处理一个事件，`watch_cursor` 在开机读完游标后的事件之前不动、只在路由提交后往前、停在在线失败的事件和还在拉起的私聊帮工前面；开机再读的先问 `isRouted`，路由按触发 id（就是消息 id）幂等。提及、串的成员和消息在同一个事务里写；一个帮工的话回应了谁（`answers`）由频道写下时算；跳数通知由 `Watch` 写（`Noticing.untilUserSpeaks`）。
  - 5b：`brakes.ts`（跳数、冷却、熔断）、`Reach`、`WakeBreaker` 和 `whoHears` 搬到 `modules/watch`。`Watch` 给它路由的每一句话（提及、私聊、串、汇报、连接器和通话带进来的、巡查）过刹车，`Session.route` 收带 `held_by` 的听众（`Hearer`）照写；用户的话清零那一处的跳数、放开它叫醒的熔断帮工。熔断：泵报 `EmptyWake`，`Watch` 数够了用 `Session.holdWakes` 拦住、贴通知；不是话的触发（定时任务、GitHub、派活，都是 `system`）只受这道拦。开机经 `Session.agentWakes` 从投递读回跳数和最近一次叫醒。`flows/brakes.test.ts`：两个帮工互相 `@` 停在跳数上限，用户说话后重新开始。
  - 5c：`modules/inbox` 并入 `modules/watch`（`inboxNews`、`toUser`、`patrol`、`handoffState`、`externalChanges`），`Watch` 排到 `Issues` 后面（收件箱要读看板）；为此工单不再用 `Watch.tell`：工单对帮工说的话 `post` 进帮工的家，没有家就进工单串，`Watch.tell` 拿掉。收件箱经 `Channel.userReceipt`、`userReadReports` 读回执。信箱经工单交下来的 `IssueView`（`Session.useIssues`：看板上的工单、一张在不在）读看板，不再读 `core.state().issues` 和 `issue.sql`。`modules.test.ts` 的 `reads`、`foreignReads` 清空；新加一条：`modules/session`（测试也算）不 import 频道、工单、观察层，不读它们的表（两条讲工单的会话测试搬去了 `issue`）。
  - 5d：开机按模块次序各 `boot()` 一次：`repo` → `session`（接回会话，再恢复投递、重放非聊天的触发、叫醒）→ `media` → `issue` → `watch`（开串、按游标读完漏读的事件、收件箱和巡查）→ `game`；`Session.wake` 拿掉。
  - 还没到的：`Session` 是 45 个成员（拿掉 `wake`，加了 `holdWakes`、`agentWakes`、`useIssues`），离 18 个差的是 4c 的蓄水池和派活；`useChat`、`useIssues` 是上层交下来的只读视图，等 4c 工单自己观察触发以后再看要不要。
- **第 4 步：做了一部分，停在诚实能到的地方。**
  - 4a 已做：`Repo` 给带类型的操作 `verifyCheckout`（子工单的检查，`CheckoutChecks`）与 `failedJobLog`（失败的 Actions 日志），接口上拿掉了 `run`、`changedFiles`、`githubRequest`、`githubRemote`；没有模块再对仓库跑裸命令。
  - 4b 已做：`session/landing.ts`、`github.ts` 搬到 `issue/`，删掉 `IssueRecord`，冲突、PR 与结局由工单直接写；`Session` 拿掉 `merge`、`submitPullRequest`、`refreshPullRequests`、`pollGitHub`、`mergeChild`、`changesOf`、`conflictOf`，换上借工作目录的 `handOver`、`withWorkplace`、`withIdleWorkplace`；`cron` 并入 `issue`（表 `issue_cron`，`Issue.crons`、`addCron`…），`session_github_cursor` 改为 `issue_github_cursor`，收下过的评审和评论记在工单自己的 `issue_github_event`（不再查 `session_trigger` 的 GitHub 字段）。
  - 4c 没做：工单蓄水池、订阅、派活队列和轮次关联（`session_issue_input`、`session_subscription`、`session_run_issue`）还在 `session`。频道排在工单前面，记下消息后同步调 `Session.route`，路由在同一个事务里查订阅、进蓄水池、转成投递；搬进工单只剩两条路：让 `Session` 回调工单（另一个 `IssueRecord`），或让工单异步观察触发（改了投递的先后，测试的时序跟着变），都不诚实。要等第 3 步频道不再路由、第 5 步观察层接管以后再搬。协议的 `scope` 也没改：`Session` 还在按工单分支（蓄水池、`report` 的 `IssueReport`、交接要求有工单），把 `issue`、`refining` 换成带 `kind` 的 `scope` 只是把同一个分支藏进标签；`IssueAnswer` 挪到 `protocol/src/issue` 要先拿掉 `LastRun.answer`，而工单判断「这一轮交没交结论」读的就是它。
  - 4d 做了一部分：交付从哪合（`landingRouteOf`、`goesByPullRequest`）、PR 结局算不算完（`finishesWithPullRequest`）、CI 的判定（`checksVerdict`）、蓄水池的放行（`holdReasonOf`）提成纯函数并直接测。`Session` 是 43 个成员（第 4 步前 47 个），离 18 个差的是蓄水池和派活的门（`queueDispatch`、`withdrawDispatches`、`triggersOf`、`queuedTriggers`、`ownerOf`、`isRouted`、`subscribe`、`replayCronTriggers`、`decline`）和频道、助手用的投递的门（`withdrawEnvelope`、`withdrawDeliveries`、`waitingOn`、`digest`、`deliveries`、`handBack`），分别等 4c 和第 3、5 步。工单用 `Session` 26 个成员（原来工单 23 个加定时任务 6 个），用 `Repo` 14 个。

## Alternatives considered

- **取代原「交付与蓄水留在 `Session`」的后续计划（原 `2026-11-12-deep-modules.md`）**：`#250` 已完成的 `services.ts` 摊平、`library` 并入 `media`、`machine` 并入 `session` 已沉淀进子系统文档；但将工单交付与蓄水放在第 4 层 `Session` 导致了 44 个宽接口成员、`IssueRecord` 回调倒置以及跨层读写 `channel / issue`，违背「`Channel` 纯聊天、`Session` 纯 Agent 维度、`Issue` 内运行 Agent」的正交模型，故将未完的纯函数抽离并入第 3–4 步并删除旧 Note。
- **保留 `Channel -> Session` 同步推消息，只在内部拆文件**：只要 `Channel` 仍依赖 `Session`，就消不掉 `channel.sql` 的跨表查询、`boot / wake` 两段启动和档案之间互相唤醒没有统一刹车的问题。
- **把聊天做成多个人类平权的成员模型。** 没选：VibeValley 是一个人的农场（[概念](docs/concepts.md)），多人是另一个产品；纯化聊天只需切断反向依赖。
- **把 `Channel`、`Session`、`Issue` 合为一个大协作模块**：消息、Agent 运行与工单是三条独立演进的轴线，强行合并会形成上万行单体，且阻碍后续将执行器与仓库拆往独立机器进程（[拆出 apps/machine](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)）。
- **用无持久化的内存事件总线做 Agent 观察**：服务重启或崩溃会在消息提交与唤醒之间丢信；必须使用 `Channel` 单调 `seq` 与幂等 `trigger(source, key)` 持久化游标对账。

## Acceptance criteria

- [modules.test.ts](apps/server/src/modules.test.ts) 中 `reads` 与 `foreignReads` 特批表全部清零；静态检查强制守住 `Channel` 零业务模块依赖、`Session` 零 `Channel / Issue` 依赖，`channel.sql` 不再跨模块 `join` 其他模块的表。
- `Channel` 单测与流程测试覆盖「用户和档案私聊、频道 `@agent` 唤醒」「频道里只有用户说话不唤醒任何档案」「Agent↔Agent 互聊受 `hop_limit` 刹车熔断且人类发言立即重置」以及服务重启后的观察游标断点续读（`flows/ingress.test.ts`、`flows/restart.test.ts`）。
- `Session` 对外接口收敛至不超过 18 个纯 Agent 成员，协议 `T.Session` 与 `session/` 目录不再出现 `IssueRecord`、`ChildChecks`、`IssueAnswer` 或工单状态分支；`services.ts` 恢复单次正序 `boot()`。
- `service-paths.json` 不再包含 `Tool` 制造的伪业务边与单调用方顶层服务；`packages/protocol/src/` 与 `apps/web/src/features/` 不再残留独立的 `library` 或 `machine` 目录。
- `vp check`、`vp run server:check`、`vp run web:check`、`vp run paths:check`、`vp run practice:check`、`vp run health:verify`、`vp run deadcode`、`vp run docs:verify` 全绿，服务端测试总数不降且所有 `regression:` 用例保留；同步更新 `AGENTS.md`、[架构](docs/architecture.md)及对应子系统文档后删除本 Note。

## Risks

- **多 Agent 在同一频道互 `@` 引发无限唤醒循环**：所有观察器唤醒入口必须强制收口至同一套 `brakes.ts`（跳数上限、60 秒冷却、连续 3 次空唤醒熔断），禁止任何模块绕过观察器直接写循环唤醒，并用专门的多 Agent 互聊流程测试锁死。
- **消息提交与观察游标推进分属两个事务时的崩溃重放**：观察器重放未推进游标的 `ChannelEvent` 时，下游投递与工单蓄水必须按 `(source, messageId)` 保持幂等，确保至少一次观察不会造成重复建单或重复入队。
- **表与列名调整作废本机开发库**：遵循「内部不留兼容」，修改 `0001_schema.up.sql` 后 PGlite 旧库在启动时按表结构哈希自动归档重建，外接 `database.url` 在哈希不匹配时拒绝启动。
