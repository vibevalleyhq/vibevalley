# 工单

一件活从创建到关闭是一张工单（`Issue`）：
- 代码类工单绑定一条分支与一个 worktree；帮工 `Session` 可换人，工单 ID 不变。
- 工单分**聊清楚**、**安排活**、**完成**三段，在农场里画成一块地。

## 状态和用语

每个取值在界面上叫什么，以词典 [shared.json](packages/i18n/locales/zh/shared.json)（英文在 `packages/i18n/locales/en/shared.json`）为准，前后端共用，这里不抄（[话放在哪](docs/subsystems/foundation.md#话放在哪)）。种地隐喻词仅用于像素农场与游戏模块，由 `scripts/docs/stale-names.ts` 检查；固定术语（问题、验收意见、改动、子工单、空位）见[用语表](docs/README.md#用语)。

| 层级 | 字段 | 取值 | 来源 |
|---|---|---|---|
| 流程状态 | `status` | `backlog`、`todo`、`in_progress`、`in_review`、`done`、`canceled` | 用户设置存库；`in_progress` 与 `in_review` 从在场 `Session` 或 `lastRun` 派生 |
| 展示阶段 | `stage.state` | `draft`、`queued`、`working`、`asking`、`reviewing`、`stuck`、`done`、`canceled` | `issueStageOf` 实时计算 |
| 受阻原因 | `stage.stuck` | `conflict`、`failed`、`interrupted`、`quiet` | `issueStageOf` 实时计算 |
| 可执行动作 | `stage.acts`、`lead` | `start`、`answer`、`reject`、`complete`、`acknowledge`、`resolve`、`resume`、`cure`、`tell`、`stop`、`close`、`reopen` | `issueStageOf` 计算，自带点击后发送的请求参数 |
| 完成交付 | `delivered` | `merged`、`merged_into_parent`、`pull_request`（PR 合入）、`submitted`（提交了 PR/MR）、`kept`、`none` | 完成关单时由服务端判定（[完成和交付](docs/subsystems/issue.md#完成和交付)） |
| 取消原因 | `canceled` | `dismissed`、`lost`（工作目录丢失） | 取消关单时写入 |
| 单轮结局 | `Run.outcome` | `completed`、`failed`、`interrupted` | 单次 `Run` 结束时写入 |
| 会话阶段 | `Session.phase` | `working`、`done`、`failed`、`resting`、`closed` | 会话生命周期更新 |

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 工单模型、状态派生、原生父子依赖（`parent` / `blockedBy`）与合法状态流转 | 会话如何跑一轮、轨迹日志记录（[帮工](docs/subsystems/session.md)） |
| 起草（`refine`）：派帮工只读看代码生成草稿、写回工单、重置 worktree | worktree 创建、重置与清理实现（[仓库](docs/subsystems/repo.md)） |
| 派活、排队重试、拆分子工单（`split`）、换人、重开与取消 | 档案选择算法（[档案和农机](docs/subsystems/agent.md#模型和不变量)） |
| 验收、打回意见、问题清理与验收标准自评（`checks`） | 信箱投递、三道刹车与唤醒调度（[帮工的信箱](docs/subsystems/session.md#触发与投递)） |
| 一件活的路由（[蓄水池和路由](#蓄水池和路由)）：工单的串、订阅（`issue_subscription`）、蓄水池（`issue_input`）与派活的队列，什么时候放给哪个会话、关单或换人时退回谁；没进工单的投给听众或那里的助手；哪一轮拿了工单的输入（`issue_run`） | 谁听见频道里的一句话、刹车（[观察层](docs/subsystems/watch.md)） |
| 完成与交付：何时完成、按 `deliver` 走哪条路、子工单要过哪些检查（`childChecks`）；合并或提 PR（从帮工的工作目录交接，或从工单自己的检出）、子工单合入父分支、PR 的结局与 CI、评审的跟进，以及工单上记下的冲突、PR 与结局 | 农场地块渲染（[农场的皮](docs/subsystems/farm.md)） |
| 定时任务（[定时任务](#定时任务)）：规格、到期、补跑与用户点头，每个定时任务固定一张工单 | 帮工的工作目录在谁手里、交接时怎么歇下和放走（[帮工](docs/subsystems/session.md#对外的门)）；git 与 GitHub 的实现（[仓库](docs/subsystems/repo.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `internal/domain/issue/service.go`、`types.go`、`migrations.go` | 对外 `Issue` 服务：状态流转、`dispatch` / `settle` / 验收意见 / 父子工单依赖与事实发布 |
| `internal/domain/issue/sqlite.go`、`memory.go`、`migrations/0001_init.up.sql`、`queries.sql` | 工单表、指派记录、定时任务、蓄水池、订阅与输入记录的 SQLite 持久化与内存替身 |
| `internal/domain/issue/cron.go`、`internal/domain/gateway/cron_runner.go` | 定时任务模型、到期判定与后台时区感知的 cron 调度循环（`Start`、`RunDueCrons`、`ComputeNextRun`） |
| `internal/domain/gateway/handlers_work.go`、`issue_helpers.go`、`seed_catalog.go` | 工单与定时任务 HTTP/工具接口处理、改动/PR/交付辅助逻辑与播种模板目录 |
| `packages/protocol/src/rules/issues.ts`、`stage.ts` | 前后端共用的 `shortTitle`、`closedText` 与 `stageWantsUser` |
| `cmd/vibe/issue.go` | 命令行工单创建、状态更新、查询与详情子命令 |
| `apps/web/src/features/issue/`、`apps/web/src/farm/issue/IssueView.tsx` | 工作台看板与工单详情、动作分发 `acts.ts`、农场工单详情 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`issue.*`），CLI 命令见 `cmd/vibe/issue.go`（`vibe issue ...`）。

## 模型和不变量

- **生命周期统一走 `setStatus` 状态机**：用户只能将工单移至 `backlog`、`todo`、`done`、`canceled`；`in_progress` 与 `in_review` 从在场会话实时派生。
- **核心状态保留活跃与近期工单**：全量工单存 `issue` 表；`SpaceState.issues` 保留未关工单及最近关闭的 50 张工单（含子工单，`keepClosedIssues`）。
- **责任关系与执行分离**：指派档案写 `issue_assignment`（换人或清空才写 `ended_at`），实际运行的会话关联记在 `issue_assignment_execution`；删除工单时级联清理家族子树。
- **写操作收敛为「挪状态」与「说话」，建单与留言规则内聚在 `Issue`**：流转调 `issue.status.update`，评论调 `issue.comment.create`。服务端收拢仓库推导、父单继承、选人、派发与留言分流；工具与 HTTP 入口只做解码与格式化。
- **看板挪一张工单只写一行**：排序在相邻两张未派发工单的 `rank` 之间取中值，间距不足时在同一事务里按固定步长重排。
- **引用解析统一在服务内完成**：接口支持传入 `#41`、`41`、工单 UUID 或曾执行该工单的会话 ID。
- **先建工单身份，再派帮工**：即时派活先写 `issue` 表拿编号再开 `Session`；启动失败且工作区干净时撤回新单，已有改动则保留现场。
- **授权边界 `Mandate`**：工单绑定不可变的 `originTriggerId`，助手建单附言硬限 30 词；仅当 `autoSubmitPr` 为真时允许自动提 PR，`maxBotReviewRounds` 限制自动响应评审轮数。
- **单轮结局只认结构化 `issue_report`**：帮工通过 `issue_report` 提交状态、问题、`checks`、`answer`、记性与 `prSubmit`，不解析自由正文。
- **执行情况与生命周期分开**：提问、失败、中断及未明确交回的休息会话保持 `in_progress`，`stage` 提供回答、重试、继续动作；有效交回且没有待答问题才进入 `in_review`。看板、详情与 CLI 都读取同一投影。
- **PR 在途自动跟进与同轮评审归并**：当 PR 在途且无待答问题时，回合结束后会话进 `resting` 并释放槽位，工单保持 `in_progress` 等待 CI/评审；按 `issue_github_cursor` 比对 CI 指纹，收下过的评审和评论记在 `issue_github_event`；仅 `prSubmit=false` 显式交接才进 `in_review`。
- **交付物类型 `deliver` 事先声明**：分 `change`（要求合入）、`pull_request`（提交 PR/MR 即交付）、`branch`（留分支）与只读调研 `answer`；`answer` 单将结论写入 `Issue.answer`，完成后重置 worktree 并记 `delivered: none`。
- **原生父子工单与 DAG 依赖**：通过 `parent` 与 `blockedBy` 表达归属与前置依赖。子工单从父分支 `vibevalley/issue-<父编号>` 切出 worktree，完成后经 `mergeInto` 合入父分支。
- **验收子工单先判红并冻结文件**：标记 `constraints.acceptance` 的子工单应先证明检查失败，合入父分支时将其改动文件记为 `frozen`；后继子工单不得修改冻结文件，且末端须通过全部祖先验收命令。
- **已完成只由用户点头**：单轮 `completed` 只进 `in_review`，助手 `issue_review` 通过只记 `reviewedAt`；最后一轮为 `failed` 时禁止挪到 `done`。

## 怎么走

**起草（`issue.refine`）**

1. 用户对 `backlog` 工单发一句话，服务端按当前指派、仓库历史或 `chooseAgent` 选定帮工档案。
2. 将用户输入写入同一工单串；最近 40 条讨论（最多 24,000 字符）、当前正文、验收标准及问题一起交给 `refining` 会话。有仓库用专属 worktree；没有仓库或档案目录时用隔离的上下文目录，不创建仓库，不进 `issue_assignment_execution`。
3. 帮工返回草稿 JSON 块与问题；服务端解析写回工单，并在工单串展示整理后的需求。结束起草会话；有 worktree 时重置回主分支，无仓库的上下文目录只在没有文件时删除。
4. 用户确认派发时，当前正文和验收标准进入执行说明。执行后不能直接编辑正文、验收条件、仓库或帮工；标题、优先级和交付方式只是标签，关单前都能改；补充与退回意见进入同一工单串，不静默替换目标。

**派活与排队（`issue.status.update` → `todo`）**

1. 挪到 `todo` 时同事务写入排队 `Trigger` 并放进工单的蓄水池（`queueDispatch`，提交后路由）；若传入新 `agent` 则先结束旧 `Assignment` 完成换人。
2. 若前置依赖已满足且有空位，立即启动 `Session` 并开启工单串。
3. 若无空位，工单留在 `todo`（`stage: queued`）；`Issue.refreshQueue` 在空位释放或周期到期时按看板顺序自动补派。

### 完成和交付

用户将工单挪到 `done` 时，服务端按 `deliver` 与分支状态判定交付：

1. **无代码改动（`none`）**：助手工单、`deliver: answer` 或分支无新提交时，直接记 `delivered: none` 并关闭会话。
2. **保留分支（`kept`）**：`deliver: branch` 且有提交时，保留分支并关闭会话，记 `delivered: kept`；工作树里未提交的改动不代提交。
3. **提交 PR/MR（`pull_request`）**：已有开放或已合入的结构化关联可完成；尚未提交时，仓库应已配置 PR 发布，用户点击完成会先运行检查并提交，发布失败就保持原状态；完成时记 `delivered: submitted`，不合并，保留未合入分支及未提交改动。远端状态变化只更新关联，不代替验收。
4. **要求合入（`change`）**：
   - 在锁外要求工作树干净；有未提交改动就退回帮工，按仓库自己的提交规范提交后再来。干净时用 `git merge-tree` 预检冲突；若冲突则标上 `Issue.conflict` 并留在 `in_review`。
   - 在锁外运行 `.vibevalley/check`；若失败则将末尾 40 行输出交回帮工修复。
   - 进仓库锁复核分支未变：子工单合入父分支记 `merged_into_parent`；普通工单本地合入主分支记 `merged`，或推送分支创建/更新 PR。
5. **要求合入的 PR 轮询结清**：每 `github.pr_poll_seconds` 秒轮询开放 PR；合并后记 `delivered: pull_request` 并清理 worktree，关闭未合则记 `canceled: dismissed`。

交付在工单的 PR 锁里：帮工在场时经 `Session.handOver` 在它的会话锁内等它歇下，跑检查与合并或提 PR，冲突、PR 的链接、子工单冻结的文件在帮工放走之前直接写在工单上；失败时帮工留着（`NotTakenIn`），工单记下冲突、把要改的话带给帮工。帮工不在、子工单已合进来时，从工单自己的检出（`Repo.checkout`）合。子工单的检查由 `Repo.verifyCheckout` 跑：验收子工单的检查要先失败、它改的文件冻结；其余的检查要过、冻结的文件不许动；然后 `Repo.mergeInto` 合进父工单的分支（父工单的帮工在场时借它歇下的工作目录）。

**跟 PR**

1. 定时器每 `github.pr_poll_seconds` 秒（默认 180）先读每个跟着的 PR 的状态：合了或关了时帮工在场就交接放走、不在就结掉检出，再结掉工单（交付的就是 PR、或工单已关的只记 PR 的状态）。
2. 再看板上开着的 PR：比对 `issue_github_cursor` 里的 CI 指纹，失败或跑完的 CI 记成一条触发；没收下过的评审和评论各记一条（同一次 Review 的行内评论共用 `botRoundKey`），经入口进 PR 订阅的工单蓄水池，放给它的帮工。

### 蓄水池和路由

定时任务、跟 PR、派活和助手的简报记下 `Trigger` 后经路由入池；观察层路由的用户消息在投递前先经过工单池（`issue_input`）校验：

1. 已在某张工单蓄水池里的，补路由回执，保持 `held` 的条目按工单再放一遍。
2. 线程对上一张工单的，进它的蓄水池（`issue_input`），对上两张就拒绝。
3. 都不是的，投给它点名的助手，或那里的助手。

- **放行看工单**：工单排队（`backlog` 不动）、没有能收的会话、在等用户（自动输入），或机器人评审过了轮数，输入保持 `held`（同一工单只留最新一条 cron 输入）；工单变了或会话换了就再放一遍，转给当前负责的会话或当值助手。已经投进会话的，工单关了或在等用户时先暂缓消费。
- **关单和拒收退回助手**：关单时帮工没收下的用户的话、帮工用 `issue_handback` 拒收的，以另一封信投给助手重新分流；转给新会话时前一个会话的那封作废。
- **重启**：未路由的触发与频道事件由开机阶段和观察层游标重放；路由按触发 id 幂等。
- **哪一轮拿了工单的输入**：会话开一轮或进程内助手拿了工单输入时记进 `issue_run`，结束时结算。

### 详情与讨论

详情显式展示当前需求、验收条件、交付结果和讨论记录。讨论使用 Channel 的工单串，换人、重试、退回不更换历史来源；`issue.conversation.get` 查询持久化的串位置，消息分页读取并订阅更新。执行轨迹只在展开时加载，不进入讨论消息。

PR/MR 创建或更新后在串内记录真实链接；关联保存在 Issue，消息以工单和 URL 构成的 `sendKey` 持久化去重，提交与轮询串行。完成后的 PR 状态继续更新，但不触发工作区清理。完成按钮统一表达验收，实际交付行为由服务端按 `deliver` 判定。

## 和谁打交道

- **帮工与观察层（`stack`、`watch`）**：经 [帮工](docs/subsystems/session.md#对外的门) 完成派活、交接工作目录、蓄水池投递与汇报回写。
- **定时任务与助手（`cron`、`orchestrator`、`gateway`）**：观察层遇用户消息先问蓄水池，`cron` 驱动定时触发与建单/重开，助手工具通过 `internal/domain/stack/tools.go` 调用。
- **仓库（`repo`）**：读取改动、冲突检出、验证与分支合并、PR 提交及 GitHub 快照。
- **频道（`channel`）**：经 `openThreadAbout` 开工单串；用户串内发言清空待答问题并按需作废旧验收标记。

## 为什么这样

- **工单是核心实体，帮工挂在工单下**：重开或换人复用同一工单 ID、同一分支与同一工单串，历史不散落。
- **大活拆成原生父子工单，不设独立 `TaskGraph` 服务**：子工单直接复用普通工单的看板、提问与修复动作，通过检查后合入父分支，省去平行的计划服务、表和面板。
- **验收子工单只冻结自身改动文件，违规直接退回**：冻结整个测试目录会阻碍后续步骤新增测试，悄悄恢复文件会让帮工莫名编译失败；显式退回并仅在依赖链末端跑全量祖先验收，兼顾防作弊与效率。
- **状态只存用户意图，展示阶段与按钮由纯函数派生**：`in_progress`、`in_review`、`stage` 和 `acts` 实时算出，帮工崩溃不会导致库状态卡死。
- **完成结论与交付去向解耦**：将 `done`/`canceled` 与 `delivered` 分为两个正交字段，使调研结论单、留分支单和合并单共用一套状态机。

## 还没做的

- 多帮工协作同一块地、逐条勾选持久化验收标准：[一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)。

## 怎么验证

- `env -u GOROOT CGO_ENABLED=0 go test -count=1 ./internal/domain/issue/... ./internal/domain/gateway/...`：工单状态机、排序、父子拆单、蓄水池路由、定时任务与交付路径测试。
- `apps/web/test/issues.spec.ts`、`apps/web/test/farm-actions.spec.ts`：工作台看板与农场工单操作端到端测试。

## 定时任务

定时任务（`T.Cron`，表 `issue_cron`）是工单的时间触发器：每次到期，在同一事务内更新运行时间并写入不可变 `Trigger`，随后准备它固定的那张工单，经路由推给帮工或助手。接口见 [capabilities.md](docs/reference/capabilities.md)（`cron.*`，其中 `cron.update` 仅对用户与 `remote` 开放），聊天页的「定时任务」标签页在 `apps/web/src/features/channel/views/Tabs.tsx`；服务端由 `internal/domain/issue/cron.go` 承载，直接服务 HTTP 与助手工具。

- **五种时间规格（`CronWhen`）**：`once`、`every`、`daily`、`weekly` 与五段式 `cron`（`once` 跑完自动关闭）；每项携带 IANA 时区或偏移量，缺省取本机时区；无效表达式（如 2 月 30 日）直接拒绝。
- **下次运行时间不落库，实时从 `last_run` 推导**：严格晚于 `last_run`（未运行过则取创建时间）的下一个匹配分钟；夏令时跳过的时刻顺延，重复的时刻取第一次；重新开启已关闭的周期任务时将 `last_run` 设为当前时间。
- **助手非当轮授权创建的周期或派工任务须等用户同意（`needsOK`）**：用户创建、或助手在含用户原话的当轮（`Actor.forUser` 为真）创建的任务立即生效；助手在后台回合自行创建时，仅「不派帮工的 `once` 回头看」直接生效；其余存为 `enabled: false, pending: true`，在收件箱（[观察层](docs/subsystems/watch.md#收件箱)）生成 `cron-ask` 待用户点击同意。
- **一个定时任务固定复用一张工单**：未指定帮工档案时指派给所属频道助手；指定帮工档案时必须同时指定仓库。若绑定工单在等用户，新到期输入在工单的蓄水池中保持 `held`。
- **扫描与补跑（`gateway/cron_runner.go`）**：网关启动时协调 `nextRunAt` 并拉起后台调度协程周期检查到期任务（支持 IANA 时区、`GMT±HH:MM` 与夏令时跳过处理，错过多次只合并补跑一次），触发后更新 `lastRunAt` 并计算下一运行时间。
- **为什么一个定时任务绑定一张工单**：避免高频任务淹没看板，让历次运行记录归集在同一条工单串下；到期状态更新与 `Trigger` 同事务落库，防止漏跑或重复触发。

## 观察执行

`GET /api/v1/issue/watch/:id` 是本机的 SSE 观察流，推送工单状态、相关会话与保留轨迹。缓冲、心跳和积压断开与其余 SSE 流一致（[SSE 流](docs/subsystems/core.md#sse-流和其余路由)），客户端按会话与事件序号去重；状态和可结算判定均来自服务端。
