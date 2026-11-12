# 帮工

`session` 模块管「一个档案（`Agent`）干一件活」的全部：触发怎么记下、谁该听到、投递和叫醒（信箱），会话（`Session`）和它的每一轮（`Run`），工作目录，执行器所在的机器，以及助手进程内的宿主。
- 处理工单时画成地里的小动物，处理私聊或助手编排时关联频道；外部代理经 [oar](https://www.npmjs.com/package/@botiverse/oar) 驱动，进程内助手经 `AgentHost` 驱动。
- 一次触发到一次汇报是一轮 `Run`；一个 `Session` 可跨越多次 `Run` 与重启。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 来源事件按 `(source, key)` 幂等记成不可变的 `Trigger`（`session_trigger`），轻量控制头和只读原始载荷分开 | 频道、串、消息的存储（[频道](docs/subsystems/channel.md)）；GitHub PR 的分页快照（[仓库](docs/subsystems/repo.md)） |
| 受众路由与四档紧急度、工单订阅（`session_subscription`）与工单蓄水池（`session_issue_input`）、三道刹车、投递状态机（`session_delivery`）与叫醒 | 工单状态机、排队顺序、验收，要不要合并、从哪合、怎么拆（[工单](docs/subsystems/issue.md)） |
| `Session` 的创建、恢复、带话、叫停、交接与离场；工作目录的开、借、清（经 `Repo.checkout`、`releaseCheckout`、`resetCheckout`、`clearCheckout`） | git worktree、分支与合并的实现（[仓库](docs/subsystems/repo.md)） |
| 把帮工的工作目录借给上层：在会话锁内用一下（`withWorkplace`、`withIdleWorkplace`），或交接后放走帮工（`handOver`） | 交付：合并、提 PR、子工单合入父分支、跟 PR 与 CI、评审（[工单](docs/subsystems/issue.md#完成和交付)） |
| `Executions`（`session/executor.ts`）：oar 实例生命周期、静默检测与关闭确认；机器登记（`session_machine`） | 农机安装探测、模型列表与档案校验（[档案和农机](docs/subsystems/agent.md)） |
| `Run` 记录（`session_run`）：触发来源、消费输入、结局与花费；oar 事件转核心状态事实与轨迹日志 | 记忆的存储与检索算法（[记性](docs/subsystems/memory.md)） |
| 并发槽位上限、腾位置与每日花费记账；进程内 `AgentHost` 与 `InProcessRun` | 助手的编排提示词与工具集（[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/modules/session/session.ts` | 对外唯一的 `Session` 服务：把下面三部分组装起来，只露出别的模块要的几样（见[对外的门](#对外的门)）；`insideOf` 只给测试 |
| `lifecycle.ts`、`hands.ts`、`registry.ts`、`history.ts`、`launch.ts`、`watch.ts`、`signals.ts` | 会话：招人、带话、叫停、交接、离场、重启恢复；`HandRoster`（在场 `Hand`、`/mcp` 令牌与 `hand.access -> admission` 锁序）；运行登记；事件跟踪与 `settling` 收尾 |
| `mailbox.ts`、`triggers.ts`、`work.ts`、`pump.ts`、`routing.ts`、`brakes.ts`、`deliveries.ts` | 信箱：触发器幂等写入与 cron 重放、工单蓄水池（Tier 1）与退回转交、投递写入、空闲叫醒与忙时攒批插话、受众与紧急度（`urgencyOf`）和蓄水池的放行（`holdReasonOf`，纯函数）、三道刹车、未终结投递缓存 |
| `shapes.ts`、`schema.ts`、`payload.ts`、`envelope.ts`、`prompts.ts` | 共享契约：`Trigger`、`Envelope` 与编码、来源载荷、聊天交进来的行（`ChannelEnvelopeRow`、`ChannelHearers`）、信箱读聊天的 `ChatView`、对模型说的话；不读写数据库，别的模块可以直接用 |
| `machine.ts`、`executor.ts`、`link.ts` | 机器登记（今天只有服务端自己这台）、经链路暴露的 `Executions`（oar `Subagents` 启停、投递、中断与静默检测） |
| `reaction.ts`、`report.ts`、`briefing.ts`、`roster.ts` | 事件映射、汇报解析、容量检查与任务说明拼装、在场会话查找的纯函数 |
| `journal.ts`、`host.ts`、`inProcessRun.ts` | 轨迹日志文件读写、进程内 `AgentHost`（投递被拒抛 `SubmitRefused`）与 `InProcessRun`（`Run` 的落库） |
| `worker.ts`、`shell.ts` | 帮工 CLI 的凭证文件与认证探测（[帮工 CLI 接入](docs/subsystems/session.md#帮工-cli-接入)）、私聊的上下文目录 |
| `apps/server/src/modules/runtime/` | 农机注册探测、价格表、额度与每日花费记账、VibeValley 自己的农机（`vibevalley.ts`） |
| 表 `session`、`session_run`、`session_run_issue`、`session_trigger`、`session_order`、`session_delivery`、`session_subscription`、`session_issue_input`、`session_machine`、`runtime_spend` | 会话（含 `pending_report`）、轮次与关联工单、触发器、投递的统一次序、投递、工单订阅与蓄水池、机器、按日花费 |
| `apps/web/src/features/session/` | `WorkLog.tsx`、`Trajectory.tsx`、`runs.ts` 瀑布图与 `events.ts` 订阅 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`session.*`、`runtime.*`）。

## 模型和不变量

### 三层概念

| 概念 | 代码与存储 | 含义 |
|---|---|---|
| `Session` | `T.Session`、`session` 表 | 档案的持续工作上下文（工单现场或私聊上下文），编号 `w<n>` 单调递增 |
| `Run` | `T.Run`、`session_run` 表 | 一次触发到一次结束汇报（从 `sessionPhaseChanged(working)` 到 `sessionReported`） |
| oar 会话 | `oarSessionId`、`Subagent` | 底层编码代理的记录流；重启或失联时可在同一 `Session` 下更换 |
| 机器 | `T.Machine`、`session_machine` 表、`session/machine.ts` | 帮工干活的那台电脑；今天只有服务端自己这台（开机时没有就记下，主机名为名），雇来的帮工记着它（`Session.machine`），服务端进程里的助手没有。别的机器经命令行加入在后面几步（[一个服务端管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)） |

- **助手与帮工统一在 `sessions` 中**：以 `Session.role`（`orchestrator` 或 `worker`）区分，共用 `phase` 与 `session_run`；仅 `worker` 参与并发槽位、地块分配与目录恢复。
- **助手的会话由本模块自己登记**：开机时登记每个助手档案，之后经 `Agent.whenKept` 在档案存下的那次写返回之前登记或改名；登记失败那次写就失败。工单、频道用到助手的会话时它已经在了。
- **执行器隔着链路**：会话经 `session/machine.ts` 的 `executions(machine)` 拿到一台机器的 `Executions`（`link.ts` 包装 `executor.ts`），过界的每个值都复制一份，为执行器搬到别的进程、别的机器做准备。
- **执行器拥有底层资源，会话拥有领域状态**：`executor.ts` 持有 oar 实例直至确认底层进程关闭才释放占位；关闭失败时继续占槽并拒绝清理该目录。

### 对外的门

`Session` 只露出别的模块真要的几样，其余全在模块里（`service-paths.json` 记着谁用哪样）：

| 成员 | 做什么 | 谁用 |
|---|---|---|
| `route`、`recordTrigger`、`receive`、`hireWith` | 一件活到了：路由已记下的触发（可指定听众或帮工）；在调用方的事务里记下触发，提交后再 `route`；来源事件记下再路由（农场自己的回声不记）；腾位置、开帮工（子工单的先建好父工单的检出）、在同一事务里跑调用方的 `hiring`，带着它的头几件输入 | 工单（含定时任务和跟 PR）、频道、Inbox、助手 |
| `queueDispatch` | 给工单的下一个帮工留一件派活：在调用方的事务里记下，提交后路由 | 工单 |
| `withdrawEnvelope`、`withdrawDeliveries`、`withdrawDispatches` | 拿回来：一封信、一个会话的未投递、一张工单的派活 | 频道、工单 |
| `stop`、`dismiss` | 叫停一个会话正在跑的一轮；放走一个帮工（`discard` 时等农机不再写了再重置分支） | 工单、接口 |
| `handOver`、`withWorkplace`、`withIdleWorkplace` | 借工作目录：在会话锁内把帮工的工作目录交给调用方的 `use`（`withIdleWorkplace` 先让它歇下、在忙就拒绝）；`handOver` 等它歇下后跑 `use`，成了就放走帮工（`use` 给出 PR 时留着），`use` 失败抛 `NotTakenIn`、帮工留着 | 工单 |
| `discardWork`、`clearWorkplace` | 工作目录：帮工留着时把分支重置回主分支、工单上没有帮工时清掉检出 | 工单 |
| `hired`、`live` | 在场的帮工；一个会话此刻的样子（核心状态里的会话、这个进程是否握着它、最后说的话和汇报摘要、正在哪一轮、工作目录） | 工单、频道、Inbox、助手、工具、`/mcp` |
| `get`、`list`、`runsOf`、`eventsOf` | 会话（含已离场的）、全部或一个档案的会话、一张工单的各轮、一个会话的事件 | 工单、工具、接口 |
| `trigger`、`triggersOf`、`queuedTriggers`、`ownerOf`、`isRouted` | 一条触发、一张工单的触发、全部排队的触发、触发的归属工单、是否已路由 | 工单、定时任务、工具 |
| `waitingOn`、`digest` | 一封信还在几处投递里；助手没读的摘要 | 频道、助手 |
| `room` | 这个农机在这个仓库上还能不能再开一个帮工 | 工单 |
| `news`、`deliveries` | 会话的一切动静（`Hired`、`Reported`、`Left`、`IssueStarted`、`RunFinished`、回执和启动动静），投递的动静（`Handed`、`Consumed`、`Braked`） | 工单、频道、助手 |
| `decline`、`handBack`、`report`、`workFile`、`subscribe`、`replayCronTriggers`、`who`、`setAddress`、`host` | 帮工拒收、助手退回、帮工交汇报、读帮工目录里的文件、绑定工单的串、重放 cron 触发、令牌认人、`/mcp` 地址、助手的进程内宿主 | 工具、助手、工单（定时任务）、媒体、`/mcp`、接口 |
| `boot`、`wake`、`close` | 开机接回会话；观察层恢复串、重放事件以后恢复投递并叫醒；关门 | `services.ts` |

- **测试经 `insideOf` 驱动里面的部分**（`hire`、`deliver`、`handOver`、`restore`…），模块不许用它（`modules.test.ts` 查）。

### 触发与投递

- **一个 `(source, key)` 只产生一条不可变 `Trigger`**：重复到达的来源事件直接返回首次写入的 `Trigger` 与原文（`selfEcho: true` 直接忽略）；控制头（`TriggerMeta`、`TriggerContext`）经 Schema 解码，原始文本或结构化数据存入同行 payload 列，只读（供 `vv://trigger/<id>` 分页读取）。
- **记下参与调用方的事务，不另起后台任务**：上游在同一事务里提交来源游标与 `Trigger`（`recordTrigger`），提交后再 `route`。
- **来源先落库，投递行与路由回执同事务提交**：投递写入 `session_delivery`、路由回执写在 `session_trigger` 上，同一事务；中途崩溃时重启后重放。
- **至少投递一次，按 `launch` 对账，真实入模才算消费**：交给会话时标为 `handed` 并记下这次农机连接号 `launch`（`${id}#n`，一次连接可跨多轮 `Run`）；模型真正收下（会话的 `Consumed` 回执）才标 `consumed`；回合结束、重连、会话关闭或服务重启时仍未收到回执的 `handed` 按 `launch` 退回 `pending` 重投。
- **两级缓冲（工单蓄水池 → 会话信箱）**：发往工单的输入先匹配 `session_subscription` 进入 `session_issue_input`；工单排队或在等用户时自动输入保持 `held`（同一工单只留最新一条 cron 输入）；工单就绪或用户新发言放行时转入当前负责会话的 `session_delivery`。
- **三道刹车只约束 agent 唤醒 agent，用户发言随时放行并重置**：跳数上限 `hopLimit` = 4（同一作用域自上次用户发言起连续自动唤醒）、冷却 `agentWakeCooldownMs` = 60s（同一帮工被别的 agent 唤醒的间隔）、空唤醒熔断 `wakeBreaker` = 3（连续被叫醒却没开口）；被拦下的投递记 `held_by`，随下一次合法运行一并带上。

### 在场阶段与回合结算

| 阶段（`Session.phase`） | 含义 | 用户动作 |
|---|---|---|
| `working` | 正在执行一轮（可带 `quietSince` 静默告警或 `retry`） | 静默过久时查看轨迹或叫停 |
| `done` | 上一轮完成并显式交接（`prSubmit=false`） | 验收、完成或打回 |
| `failed` | 上一轮执行失败 | 让它接着修或取消关单 |
| `resting` | 被叫停、重启恢复、私聊休眠，或 PR 在途等待外部事件 | 带话继续，或等待 CI/Review 唤醒 |
| `closed` | 已离场（从核心状态移除，保留在 `session` 表） | — |

- **后台任务收尾（`settling`）**：主回合结束但仍有未完结后台命令且未调 `issue_report` 时，会话进入 `settling` 保持 `working` 与占槽，等后台任务全部结束后再结算。
- **结构化交接（`issue_report`）**：报告先同步写入 `session.pending_report`，回合结束时转为 `sessionReported` 并清空；PR 在途或 `prSubmit=true` 时结束后进 `resting` 并释放槽位，仅 `prSubmit=false` 才进 `done`。
- **触发来源（`RunTrigger`）**：分 `issue`、`comment`、`cron`、`refine` 和 `runtime`；执行中途插入的话记入当前 `Run.heard`，不另开新 `Run`。

### 容量上限、轨迹与花费

- **三级并发上限（`room`）**：全农场最多 6 个在忙帮工 `maxRunning`，单台农机按 `maxWorking` 限制，单仓库默认最多 3 个 `repo.max_sessions`；槽位满 6 个又来新活时，最久闲置的工单会话收工、私聊会话休眠。
- **无沙箱与无逐条权限确认**：帮工在 `$VIBEVALLEY_WORK_ROOT` 下直接执行命令，不弹权限确认；安全边界是服务端只听 `127.0.0.1`。
- **只追加的轨迹日志**：`events/<id>.json` 按序记录每一步事件，流式草稿按 `revision` 递增推送，落盘后不改。帮工留最近 240 条、助手留 1000 条，离场默认 30 天后清理文件。
- **额度与每日花费**：额度何时读、何时标「快用完了」见[档案和农机](docs/subsystems/agent.md#怎么走)；按日花费记入 `runtime_spend`，额度或预算耗尽时（`moneyStop`）阻止派新活，在跑回合继续跑完。

### 重启

- **VibeValley 自己的农机（`vibevalley`）上的帮工答到一半时，正常关门也接着答**：关门时会话模块先告诉农场的 `Harness` 要走了（`Durable.leave`），之后放下的会话不停这一轮，`session_run` 里那一轮留着不结；开机时 `restore` 看到这个帮工的 pi-durable 对话还有没跑完的一轮，就用同一个 oar 会话重新打开它（输入是 `goOn`，不进对话、不进轨迹），那一轮作为这次的回合报出来，结束时记在原来那一轮上：答一次、记一轮。崩溃后也一样。
- **外部农机（Claude Code、Codex 等）接不上半截的回合**：重启后那一轮记 `interrupted`，会话报「打断了」停在 `resting`，没被模型收下的投递退回重投，下一句话来时按 `oarSessionId` 续接。
- **助手**：进程内宿主关门时让没跑完的一轮留着，开机后接着答，仍记作同一轮（[VibeValley 自己的 agent](docs/subsystems/brain.md#接着做被打断的一轮)）。

## 怎么走

**一件活到了（`route`、`recordTrigger`、`receive`）**

1. `Watch`（读频道提交的事件）、`Issue`（含定时任务和跟 PR）、`Inbox` 或助手把来源事件交来（`receive`），或在自己的事务里记下（`recordTrigger`）、提交后再 `route`。
2. 信箱在写锁内算受众、查工单蓄水门禁与三道刹车，原子写入 `session_delivery` 与路由回执。
3. `pump.ts` 唤醒空闲帮工、对正忙帮工攒批（`chat.notice_batch_ms` = 3s）插话，或发布 `Handed` 交给当值助手。
4. 会话换人或关单时，未消费的用户追问以确定性返回编号转交新负责人或助手。

**派出帮工（`hireWith`）**

1. 子工单先经 `Repo.checkout` 建好父工单的检出（它的分支从父工单的分支切出；建不了抛 `HireRefused`）。在准入锁内检查容量上限（不满足时抛 `HireRefused`），分配 `w<n>` 编号，经 `Repo.checkout` 打开工单的检出，并创建 `handScope` 与 `startupScope`（都是 `AsyncDisposableStack`，`hands.ts`）挂上轨迹、令牌与目录的释放。
2. 召回档案记忆，拼装规矩、人设、技能与任务说明，经执行器启动 oar 会话。
3. 释放准入锁，写入 `session` 表并调用 `hiring` 回调登记工单关联或私聊投递；任一步失败或中断，关闭 `startupScope` 逆序回滚并抛 `HireRefused`。
4. 登记 `HandRoster`（移交 `handScope`）并施加 `sessionChanged`，启动事件监听与静默计时器（默认 240 秒无事件报 `quiet`）。

**带话与唤醒（投递）**

1. 会话 `resting` 且执行器仍在时，检查上限、召回新记忆并发送 followup，开启新 `Run`。
2. 执行器已关闭（重启或休眠后）时，按 `oarSessionId` 续接；续接失败则在原目录新建 oar 会话并提示查看 `git log`。
3. 会话正在 `working` 时，支持插话的农机直接 `steer` 进当前 `Run`；不支持的排入下一轮。
4. 容量不足或投递被拒时抛 `DeliveryRefused`（`AgentHost.submit` 抛 `SubmitRefused`），失败或中断时回收预留的输入。

**交接与离场（`handOver`、`dismiss`）**

1. 先关闭底层 oar 会话；关闭失败则拒绝交接或重置，保持现场占位。
2. `handOver` 在会话锁内等帮工歇下，把工作目录和它最后说的话交给调用方的 `use`（工单在里面跑检查、合并或提 PR，见[完成和交付](docs/subsystems/issue.md#完成和交付)）；`use` 失败抛 `NotTakenIn`（带给帮工的话和给用户的说法），帮工和分支留着；`use` 给出 PR 时帮工留着跟 CI 和评审。
3. 交接成功或放走帮工后，更新 `session` 表为 `closed`、关闭 `handScope` 作废令牌与轨迹、经 `Repo.releaseCheckout` 放下检出、通知 `Memory.endSession` 并施加 `sessionLeft`。

**开机（`boot`、`wake`）**

1. `boot`：清理过期轨迹文件；读回在场会话，目录丢失的记 `sessionLeft(lost)`；`vibevalley` 农机上留着一轮的帮工重新打开接着答（见[重启](#重启)），其余未完结的 `session_run` 记 `interrupted`，在忙的会话报「打断了」停在 `resting`。
2. 观察层（`watch.boot`）恢复各会话的串，把游标后的频道事件重放一遍。
3. `wake`：把未终结的投递读回缓存、`handed` 退回 `pending`，重放没有路由回执的触发，按工单放行蓄水池，叫醒在等的会话。

## 和谁打交道

- **工单（`issue`，含定时任务）**：用 26 个成员（`service-paths.json` 逐个记着）：派活（`hireWith`、`queueDispatch`、`withdrawDispatches`、`triggersOf`、`queuedTriggers`、`room`）、叫停放走（`stop`、`dismiss`）、借工作目录交付（`handOver`、`withWorkplace`、`withIdleWorkplace`）、工作目录（`discardWork`、`clearWorkplace`）、记下并路由触发（定时任务的 `recordTrigger`、`route`、`isRouted`、`ownerOf`、`subscribe`、`replayCronTriggers`，跟 PR 的 `receive`）、在场与查询（`hired`、`live`、`get`、`list`、`runsOf`）和 `news`；订阅 `news` 的 `Reported`、`Left`、`IssueStarted`、`RunFinished` 更新工单状态、问题与冲突。
- **观察层（`watch`）**：频道不调 `Session`。`Watch` 读频道提交的事件，记下并路由消息（`recordTrigger`、`route`，重放时先问 `isRouted`）、开私聊帮工（`hireWith`）、撤回（`withdrawEnvelope`、`withdrawDeliveries`）、读在场会话（`hired`、`live`）和还在等的投递（`waitingOn`），订阅 `news` 的 `Hired`、`Left`、`Reported` 管工单串与汇报、`deliveries` 的 `Consumed` 先在聊天里记看过（`Channel.markSeen`）再加 👀、`Braked` 贴熔断通知。会话不读聊天的表：信箱要的默认频道、一处的助手和一个参与者别处的未读，由 `Watch` 建好时经 `Session.useChat` 交给它一个 `ChatView`（背后是 `Channel.defaultChannel`、`orchestratorIn`、`unread`），之前是空的。开机是 `session.boot()` → `watch.boot()`（开串、按游标重放）→ `session.wake()`。
- **仓库、农机与记性（`repo`、`runtime`、`memory`）**：`Repo.checkout`、`releaseCheckout`、`resetCheckout`、`clearCheckout` 给帮工开、放、重置、清工单的检出，`houseRules`、`limit`、`usesPullRequests` 拼任务说明和算容量；合并、提 PR、检查与 GitHub 都是工单经仓库带类型的操作做的；农机探测与计费、pi-durable 的 `Harness`；每轮前后召回与写入记忆。
- **助手（`orchestrator`）**：经 `host` 创建进程内 `AgentHost`，共用 `session` 与 `session_run`；收 `deliveries` 的 `Handed`、`digest` 的摘要，退回用 `handBack`。

## 为什么这样

- **一件活的触发、投递、执行和工作目录放在一个模块**：信箱和会话各记着同一件活的一半状态（投递和执行），分开时任何一边收窄都得把另一半往外递；合起来以后别的模块只认一扇门，投递和执行之间的往来留在模块里。
- **交付在工单，本模块只借出工作目录**：交付要的决定（要不要合、从哪合、子工单过哪些检查、PR 结了算不算完）和它写下的（冲突、PR、结局、冻结的文件）都是工单的；本模块只管工作目录在谁手里，给出 `handOver`、`withWorkplace`、`withIdleWorkplace` 三扇门，git 和 GitHub 由工单经仓库带类型的操作（`verifyCheckout`、`merge`、`mergeInto`、`submitPullRequest`、`failedJobLog`…）去做。曾把合并、提 PR 和跟 PR 的编排放在本模块，工单的记录经 `IssueRecord` 回调写回：下层回调上层，本模块的门也更宽（交付 7 个成员）。
- **工单蓄水池、订阅和派活的队列还在本模块**：频道（排在工单前面）记下消息后同步调 `route`，路由在信箱里查订阅、进蓄水池、转成投递，在同一个事务里；蓄水池搬进工单，就得让本模块回调工单（又一个 `IssueRecord`），或让工单异步观察触发、改了投递的先后。要等频道不再路由（[正交领域](.agents/notes/proposed/architecture/2026-11-12-orthogonal-domains-and-event-watch.md) 第 3 步）、观察层接管唤醒（第 5 步）以后再搬。
- **一个成员答一个问题，不用标签把几件事并成一个**：曾把 `receive`、`withdraw`、`workplace`、`read` 做成带标签的大成员，成员数是少了，面却一样宽，路径表（`service-paths.json`）也看不出模块用的是哪一样（[一个名字只答一个问题](docs/style/naming.md)）。现在每件事一个名字，门窄靠的是只留别的模块真在用的成员：路径表里没人用的就删。
- **用执行器隔离进程资源，用纯函数表达领域规则**：防止启动中断或关闭失败时泄漏子进程或重用脏目录；事件映射与汇报解析保持纯函数以便快速单测。
- **区分 `Session`、`Run`、进程连接 `launch` 与 oar 会话**：`Session` 代表跨轮次工作现场，`Run` 记单轮触发与花费，内存 `launch`（`${id}#n`）标识一次底层连接以便重连时退回未确认投递，底层 oar 会话可随时替换而不丢工单归属。
- **受众计算与投递控制解耦**：频道只回答「谁在场、关注了哪个串」，蓄水、优先级、刹车和重试在本模块。
- **不做命令级权限确认，靠工作目录与回环监听划边界**：放弃把权限请求做成地里杂草逐条批准（会让帮工停在命令上等人，与无人值守冲突）。
- **显式传递农机 `binPath`，不写进程环境变量**：避免多配置并发时互相覆盖 `process.env`。
- **轨迹单存文件；外部农机重启后停在 `resting` 不自动重跑**：避免高频工具输出撑大 `SpaceState`，也避免重启后重跑外部 shell 命令导致重复副作用；pi-durable 自己记着跑到哪一步，所以只有它接着跑。

## 还没做的

- 接入 opencode、grok、kimi、antigravity、cursor 等更多农机：[其他农机提案](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)。
- 正交领域切分、事件观察驱动与纯判断搬出服务：[正交领域与事件观察](.agents/notes/proposed/architecture/2026-11-12-orthogonal-domains-and-event-watch.md)。

## 怎么验证

- `apps/server/src/modules/session/report.test.ts`、`journal.test.ts`、`inProcessRun.test.ts`：汇报解析、轨迹版本追加与进程内 `Run`。
- `executor.test.ts`、`access.test.ts`、`session.test.ts`、`apps/server/src/flows/work.test.ts`：执行器生命周期、派工、带话、静默告警、容量上限、合并交接与重启恢复。
- `triggers.test.ts`、`source.test.ts`、`brakes.test.ts`、`deliveries.test.ts`、`work.test.ts`、`apps/server/src/flows/ingress.test.ts`、`mailbox-order.test.ts`、`returns.test.ts`：`(source, key)` 幂等、来源游标与触发器共同回滚、投递顺序、三道刹车、工单蓄水、换人退回与重启重放。
- `apps/server/src/flows/pull_request.test.ts`、`pr-follow.test.ts`、`parent-pr.test.ts`、`split.test.ts`、`acceptance.test.ts`、`dependencies.test.ts`：经本模块交接的交付、跟 PR、子工单合入父分支（编排在工单）。
- `routing.test.ts`：蓄水池的放行（`holdReasonOf`）。
- `apps/server/src/flows/restart.test.ts`：助手、帮工答到一半时崩溃或正常关门，重开后接着答完、记一轮。
- `apps/server/src/modules.test.ts`：别的模块不碰投递的内部文件、共享契约不碰存储、只有测试用 `insideOf`。
- `apps/server/src/modules/runtime/runtime.test.ts`、`presets.test.ts`：农机探测缓存、额度计算与每日花费。

## 代理和 MCP 连接

- **回环地址总是绕过代理**：`session/executor.ts` 给每个子会话的 `NO_PROXY` 和 `no_proxy` 写同一份去重清单：继承的值、档案的值，再加 `127.0.0.1,localhost,::1`。档案里的空值不删继承的条目和回环地址；其余代理变量不动。声明了 `refusedSessionOptions.env` 的农机不加任何环境变量。
- **MCP 连接只记观察，不挡开工**：`Session.toolConnections` 是档案配置的每个 MCP 服务的连接观察；没有条目或 `unknown` 表示没有证据。`starting`、`ready`、`failed`、`cancelled` 是农机报来的，不是健康检查，不挡 run，也不代表帮工 CLI 可用（那一道门见[帮工 CLI 接入](docs/subsystems/session.md#帮工-cli-接入)）。
- **只认农机自己报的启动状态**：目前只有 Codex 报 MCP 启动状态，在农机适配层（`runtime/access.ts`）解码，其余农机一律 `unknown`。只收根会话、配置里有的服务；带了 `threadId` 就须是这个会话的。错误脱敏后截到 2000 字。
- **观察跟着执行走**：观察者先重放保留的记录再读实时的；每条观察施加 `sessionToolChanged`，`reduce` 只换那个服务的条目。新执行或重新接上时 `sessionToolsReset` 清空，同一执行上接着跑的回合保留。连接失败或取消写进轨迹的 `run/error`（带 `connection`）。看的人读这些共用字段，不解析各家农机的通知。

## 帮工 CLI 接入

帮工 CLI 与 MCP 共用 Session 签发的令牌和同一工具执行路径，交活及 PR 授权仍由领域服务处理。令牌在启动前登记，重新启动时轮换，离场或启动认证失败时撤销；未知身份不回退用户。令牌索引只管凭证，不保存第二份会话状态。

服务端为每个会话写入临时凭证文件：父目录权限 `0700`，文件 `0600`，内容只有回环 MCP 地址和令牌。启动说明只含绝对可执行路径、加载器和凭证文件路径，不含秘密；CLI 自己读文件。离场删除文件，服务关闭时删除整个目录。文件方案不依赖农机传递秘密环境变量，`ELECTRON_RUN_AS_NODE` 只作用于 CLI 子进程。

派工前先确认 CLI 可执行，再以该会话凭证运行只读 `doctor` 认证请求；任何一步失败都拒绝启动。该探测证明服务端至 CLI 的认证链路，帮工仍须在自己的 shell 中先运行 `doctor`，失败报告阻塞。可选 MCP 的连接状态独立观察，没有证据仍是 unknown。

`session/worker.ts` 是进程、凭证文件与认证探测的外部边界；源码使用绝对 Node、Vite+ 加载器和 `apps/cli/src/worker.ts`，打包后使用同级 CLI 包的 `dist/worker.mjs`。两个入口都应通过同一会话认证门槛；仅源码测试不能证明桌面包可派工。普通模块测试通过 `WorkerAccess` 替换此边界，集成测试运行真实 CLI 与 HTTP。MCP 的异常与错误结果均带 `isError`；CLI 据此非零退出，不匹配本地化文案，服务器拒绝原因脱敏后限制为 8000 字符。命令参数见 [CLI](apps/cli/README.md#帮工会话命令)。
