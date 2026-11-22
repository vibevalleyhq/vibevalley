# 工单

一件活从创建到关闭是一张工单（`Issue`）：
- 代码类工单绑定一条分支与一个 worktree；帮工 `Session` 可换人，工单 ID 不变。
- 工单分**聊清楚**、**安排活**、**完成**三段，在农场里画成一块地。

## 状态和用语

每个取值在界面上叫什么，以词典 [shared.json](crates/i18n/locales/zh/shared.json)（英文在 `crates/i18n/locales/en/shared.json`）为准，前后端共用，这里不抄（[话放在哪](docs/subsystems/foundation.md#话放在哪)）。种地隐喻词仅用于像素农场与游戏模块，由 `scripts/docs/stale-names.ts` 检查；固定术语（问题、验收意见、改动、子工单、空位）见[用语表](docs/README.md#用语)。

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
| 验收、打回意见、问题清理与验收标准自评（`checks`） | 信箱投递、三道刹车与唤醒调度（[帮工的信箱](docs/subsystems/session.md)） |
| 一件活的路由（[蓄水池和路由](#蓄水池和路由)）：对工单说的话交给它的帮工（`Board::tell`）、派活的队列、每张工单的各轮 | 谁听见频道里的一句话、刹车（[观察层](docs/subsystems/watch.md)） |
| 完成与交付：何时完成、按 `deliver` 走哪条路、子工单要过哪些检查；合并、子工单合入父分支，以及工单上记下的冲突与结局 | 农场地块渲染（[农场的皮](docs/subsystems/farm.md)） |
| 定时任务（[定时任务](#定时任务)）：规格、到期、补跑与用户点头，每个定时任务固定一张工单 | 帮工的工作目录在谁手里、交接时怎么歇下和放走（[帮工](docs/subsystems/session.md)）；git 实现（[仓库](docs/subsystems/repo.md)）；分支发布与 PR 轮询（[PR 与分支发布](docs/subsystems/pull.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/server/src/modules/work/issue/board.rs` | `Board`：建单、挪状态（`move_to`）、对帮工说话（`tell`）、叫停、排队（`refresh_queue`）、改动（`changes`）、交付（`complete`）与取消；帮工交给 `Sessions`，worktree 与合并交给 `Workplace` |
| `crates/server/src/modules/work/issue/edits.rs`、`family.rs`、`refine.rs` | 改字段、删单、验收（`edit`、`remove`、`review`）；拆单与子工单合进父分支（`split`、`join_children`）；起草（`refine`）和读回草稿 |
| `crates/server/src/modules/work/ledger.rs` | 工单板唯一的写入口 `Ledger`：一批事实先在 `server.db` 的事务里存好，再经 `Facts` 折进核心状态；写失败时整批回滚且不修改核心状态；已有工单的变化只能是一个 `IssueChange`（入队、重开、交付、取消、冲突、汇报、起草……），由 `IssueChange::fold` 一处写 |
| `crates/server/src/modules/work/session/sessions.rs`、`runs.rs` | 帮工与每一轮：见 [帮工](docs/subsystems/session.md) |
| `crates/server/src/modules/work/workplace/mod.rs`、`check.rs` | worktree、合并、冲突与分支清理；合进主分支前跑 `.vibevalley/check`、子工单合进父分支前跑它的检查，失败给末尾 40 行：见 [仓库](docs/subsystems/repo.md) |
| `crates/core/src/status.rs`、`moves.rs` | 状态派生、展示阶段与可执行动作；合法挪动（`status_move`） |
| `crates/core/src/deps.rs`、`refine.rs`、`brief.rs`、`pr.rs` | 父子依赖与 DAG、子工单要过的检查；起草的提示与读回；对帮工说的话；PR 的纯规则 |
| `crates/server/src/modules/work/issue/mod.rs` | `issue.*` 端点：解码入参、调 `Board`、带 `requestKey` 的幂等与拒绝的话 |
| `crates/server/src/modules/work/cron/`、`crates/core/src/cron/mod.rs` | 定时任务：增删改与到期（`server.db` 的 `cron` 表，`issue_id references issue(id) on delete set null`，经 `Board::use_cron_of_issue` 投影）；时间规格与 `next_run` |

接口见 [capabilities.md](docs/reference/capabilities.md)（`issue.*`），CLI 命令为 `vibevalley issue ...`。

## 模型和不变量

- **生命周期统一走 `setStatus` 状态机**：用户只能将工单移至 `backlog`、`todo`、`done`、`canceled`；`in_progress` 与 `in_review` 从在场会话实时派生。
- **核心状态保留活跃与近期工单**：全量工单存 `issue` 表（`PutIssue` 使用 `ON CONFLICT(id) DO UPDATE` 避免清空 `cron`、`pull`、`artifact` 的 `ON DELETE SET NULL` 外键；`Issue.cron` 与 `Issue.pull_request` 由各自模块经 `Board::use_cron_of_issue`、`Board::use_pull_of_issue` 同步投影，不在 `issue` 表存冗余列）；`SpaceState.issues` 保留未关工单及最近关闭的 50 张工单（含子工单，`keepClosedIssues`）。
- **写操作收敛为「挪状态」与「说话」，建单与留言规则内聚在 `Issue`**：流转调 `issue.status.update`，评论调 `issue.comment.create`。`Board::create` 收拢仓库推导、父单继承与派发；端点和工具只做解码与格式化。
- **看板挪一张工单只写一行**：`edit`（`issue/edits.rs`）在相邻两张未派发工单的 `rank` 之间取中值（排在两端时加减 1024），一次 `UPDATE`、一次发布；间距用完或超出 ±2,000,000,000 时才在一个事务里按 1024 的步长重排全部未派发工单。
- **引用解析统一在服务内完成**：接口支持传入 `#41`、`41`、工单 UUID 或曾执行该工单的 `Session` ID。
- **先建工单身份，再派帮工**：即时派活先写 `issue` 表拿编号再开 `Session`，启动失败且工作区干净时撤回新单，已有改动则保留现场。
- **授权边界 `Mandate`**：工单绑定不可变的 `originTriggerId`，助手建单附言硬限 30 词；仅当 `autoSubmitPr` 为真时允许自动提 PR，`maxBotReviewRounds` 限制自动响应评审轮数。
- **单轮结局只认结构化 `issue_report`**：帮工通过 `issue_report` 提交状态、问题、`checks`、`answer`、记性与 `prSubmit`，不解析自由正文。
- **执行情况与生命周期分开**：提问、失败、中断及未明确交回的休息会话保持 `in_progress`，`stage` 提供回答、重试、继续动作；有效交回且没有待答问题才进入 `in_review`。看板、详情与 CLI 都读取同一投影；CLI 的 `issue show --watch` 在提问或受阻阶段也返回，stderr 同时给出生命周期和阶段。
- **PR 状态轮询与同轮评审归并**：由独立模块 `modules/work/pull` 承担（[PR 与分支发布](docs/subsystems/pull.md)），`pull` / `pull_event` 表记录开放 PR、CI 指纹与同轮机器人评审去重（`bot_round_key`）；状态变为 `merged` 或 `closed` 时通知 `Board::settle_pull` 结清工单。
- **交付物类型 `deliver` 事先声明**：分 `change`（要求合入）、`pull_request`（提交 PR/MR 即交付）、`branch`（留分支）与只读调研 `answer`；`answer` 单将结论写入 `Issue.answer`，完成后重置 worktree 并记 `delivered: none`。
- **原生父子工单与 DAG 依赖**：通过 `parent` 与 `blockedBy` 表达归属与前置依赖。子工单从父分支 `vibevalley/issue-<父编号>` 切出 worktree，完成后合入父分支。
- **验收子工单先判红并冻结文件**：标记 `constraints.acceptance` 的子工单应先证明检查失败，合入父分支时将其改动文件记为 `frozen`；后继子工单不得修改冻结文件，且末端须通过全部祖先验收命令。
- **已完成只由用户点头**：单轮 `completed` 只进 `in_review`，助手 `issue_review` 通过只记 `reviewedAt`；最后一轮为 `failed` 时禁止挪到 `done`。

## 怎么走

**起草（`issue.refine`）**

1. 用户对 `backlog` 工单发一句话，服务端按当前指派、仓库历史或 `chooseAgent` 选定帮工档案。
2. 将用户输入写入同一工单串；最近 40 条讨论（最多 24,000 字符）、当前正文、验收标准及问题一起交给 `refining` 会话。有仓库用专属 worktree；没有仓库或档案目录时用隔离的上下文目录，不创建仓库，不进 `issue_assignment_execution`。
3. 帮工返回草稿 JSON 块与问题；服务端解析写回工单，并在工单串展示整理后的需求。结束起草会话；有 worktree 时重置回主分支，无仓库的上下文目录只在没有文件时删除。
4. 用户确认派发时，当前正文和验收标准进入执行说明。执行后不能直接编辑正文、验收条件、仓库或帮工；标题、优先级和交付方式只是标签，关单前都能改；补充与退回意见进入同一工单串，不静默替换目标。

**派活与排队（`issue.status.update` → `todo`）**

1. 挪到 `todo` 时排进队；若传入新 `agent` 则先换人。
2. 若前置依赖已满足且有空位，立即启动 `Session` 并开启工单串。
3. 若无空位，工单留在 `todo`（`stage: queued`）；`Board::refresh_queue` 在空位释放时按看板顺序自动补派；对排队工单说的话随它一起交给帮工。

### 完成和交付

用户将工单挪到 `done` 时，服务端按 `deliver` 与分支状态判定交付：

1. **无代码改动（`none`）**：助手工单、`deliver: answer` 或分支无新提交时，直接记 `delivered: none` 并关闭会话。
2. **保留分支（`kept`）**：`deliver: branch` 且有提交时，保留分支并关闭会话，记 `delivered: kept`；工作树里未提交的改动不代提交。
3. **提交 PR/MR（`pull_request`）**：已有开放或已合入的结构化关联（`Issue.pull_request`，由用户经 `repo.pr.submit` 或帮工在获授权时经 `issue_pr_submit` 发布，见 [PR 与分支发布](docs/subsystems/pull.md)）时即可完成，记 `delivered: submitted`，不本地合并，保留未合入分支及未提交改动；尚未关联 PR/MR 时挪到完成会被拒绝（`server.issue.deliveryNeedsPr`）。远端状态变化只更新关联，不代替验收。
4. **要求合入（`change`）**：
   - 普通工单提交剩余改动，按[本地合并](docs/subsystems/repo.md)交付。预检冲突时保存 `Issue.conflict` 并留在 `in_review`。候选检查失败时保留工单，按会话余量交回帮工修复。工单详情展开最近一次失败检查的命令、受检提交和输出。发生冲突时，用户可从详情或审查对话框打开该工单工作目录中的冲突文件。成功合入记 `merged`。
   - 子工单使用父分支和自身的验收命令，合入父分支记 `merged_into_parent`。
5. **要求合入的 PR 轮询结清**：`modules/work/pull` 每 `github.pr_poll_seconds` 秒轮询 `pull` 表中的开放 PR；合并或关闭时调用 `Board::settle_pull` 结清关联工单（[PR 与分支发布](docs/subsystems/pull.md)）。

交付由 `Board` 在工单的锁里做：帮工在场时等它歇下，跑检查与合并，冲突和子工单冻结的文件直接写在工单上；失败时帮工留着，工单记下冲突、把要改的话带给帮工。子工单的检查由 `workplace/check.rs` 跑：验收子工单的检查要先失败、它改的文件冻结；其余的检查要过、冻结的文件不许动；然后合进父工单的分支。

本地改动的审查通过时，工单保存时间、改动的基线提交和文件树，见 [仓库](docs/subsystems/repo.md)。审查窗口在完成前提交所见版本。若文件已变，窗口展示新增改动，用户可再次审查。CLI 也可把 `issue diff --json` 的 `revision.baseCommit` 和 `revision.tree` 分别传给 `issue review --pass --base-commit … --tree …`。

本地交付把检查回执先写入 SQLite，再推进 Git 引用。回执记录目标分支和提交、工单文件树、候选提交和文件树，以及检查是否配置、是否通过和失败输出。工单完成时保存最终提交。若 Git 已接受候选而进程在结算前中断，服务重开时核对目标分支是否包含候选提交，再确认源目录没有新增改动。两项吻合时，服务认领原提交并完成结算。

**跟 PR**：由独立模块 `modules/work/pull` 承担（`refresh`、`poll`、`snapshot`，见[PR 与分支发布](docs/subsystems/pull.md)）。

### 蓄水池和路由

Rust 版没有 TS 版的蓄水池（`issue_input`）、订阅与触发表：观察层算好听众后经 `Board::tell` 把话直接交给工单的帮工，帮工在干活就插进这一轮，歇着就开下一轮；工单在排队时话随它一起交出。定时任务到期时由 `modules/work/cron` 准备它固定的那张工单并 `tell`。

### 详情与讨论

详情显式展示当前需求、验收条件、交付结果和讨论记录。讨论使用 Channel 的工单串，换人、重试、退回不更换历史来源；`issue.conversation.get` 查询持久化的串位置，消息分页读取并订阅更新。执行轨迹只在展开时加载，不进入讨论消息。

PR/MR 创建或更新后在串内记录真实链接；关联保存在 Issue，消息以工单和 URL 构成的 `sendKey` 持久化去重，提交与轮询串行。完成后的 PR 状态继续更新，但不触发工作区清理。完成按钮统一表达验收，实际交付行为由服务端按 `deliver` 判定。

建单、改字段、挪状态、起草和看改动的规则由 `modules/work/issue` 的带类型函数提供；HTTP 端点和助手工具调用同一份函数，工具不经 Hub 再调工单接口。

## 和谁打交道

- **帮工（oar 和档案）**：`Sessions` 经 `Drivers`（`crates/server/src/modules/work/session/drivers.rs`，服务端给的是 `crates/server/src/modules/team/agent/drive.rs`）把指派的档案变成农机和参数，在 worktree 里跑一轮；轨迹由 `crates/server/src/modules/work/session/journal.rs` 记。
- **观察层、助手、工具**：观察层把频道里的话 `tell` 给工单；助手和帮工的工单工具在 `crates/server/src/modules/team/tool/issue.rs`。
- **仓库（`vibevalley-git`）**：改动、冲突预检、合并、分支。

## 为什么这样

- **工单是核心实体，帮工挂在工单下**：重开或换人复用同一工单 ID、同一分支与同一工单串，历史不散落。
- **大活拆成原生父子工单，不设独立的计划服务**：子工单直接复用普通工单的看板、提问与修复动作，通过检查后合入父分支，省去平行的计划服务、表和面板。
- **验收子工单只冻结自身改动文件，违规直接退回**：冻结整个测试目录会阻碍后续步骤新增测试，悄悄恢复文件会让帮工莫名编译失败；显式退回并仅在依赖链末端跑全量祖先验收，兼顾防作弊与效率。
- **状态只存用户意图，展示阶段与按钮由纯函数派生**：`in_progress`、`in_review`、`stage` 和 `acts` 实时算出，帮工崩溃不会导致库状态卡死。
- **完成结论与交付去向解耦**：将 `done`/`canceled` 与 `delivered` 分为两个正交字段，使调研结论单、留分支单和合并单共用一套状态机。

## 还没做的

- 多帮工协作同一块地、逐条勾选持久化验收标准：[一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)。
- 工单详情的讨论、里程碑、步骤与轮次合为一条活动流：[工单详情的经过合成一条活动流](.agents/notes/proposed/feature/2026-11-11-issue-activity-stream.md)。

## 怎么验证

- `crates/server/tests/issue_board.rs`：从待办到合并、失败与修、提问、中断续上、取消、排队与空位、按仓库的上限、重启接续、冲突、检查失败退回、调研单、留分支、没动静。
- `crates/server/tests/issue_family.rs`：父子拆单、验收子工单与冻结文件、起草。
- `crates/server/tests/issue_edits.rs`：改字段、排位与删单。
- `crates/server/tests/issue.rs`、`crates/server/tests/cron.rs`：经端点走一张工单；定时任务的增删、拒绝与到期。
- `crates/core/src/tests.rs`：状态派生、挪动与依赖的纯函数。
- `apps/mac/ui/app/scenarios.test.tsx`、`apps/mac/ui/app/interactions.test.tsx`：工单多密度看板、详情与核心写路径防回归测试（`nsh/test`）。

## 定时任务

定时任务（`Cron`，存在 `server.db` 的 `cron` 表，`issue_id references issue(id) on delete set null` 并建 `cron_by_issue` 索引，经 `Board::use_cron_of_issue` 投影到 `Issue.cron`）是工单的时间触发器：每次到期，更新运行时间，随后准备它固定的那张工单（最近建的那张，或重开，或新建），交给帮工，或在它的频道交给助手。接口见 [capabilities.md](docs/reference/capabilities.md)（`cron.*`，其中 `cron.update` 仅对用户与 `remote` 开放），服务端在 `crates/server/src/modules/work/cron/`（`mod.rs`、`db.rs`、`sql/schema.sql`），时间规则在 `vibevalley-core::cron`。

- **五种时间规格（`CronWhen`）**：`once`、`every`、`daily`、`weekly` 与五段式 `cron`（`once` 跑完自动关闭）；每项携带 IANA 时区或偏移量，缺省取本机时区；8 年内无合法触发时刻的表达式（如 2 月 30 日）直接拒绝。
- **下次运行时间不落库，实时从 `last_run` 推导**：`nextRun` 计算严格晚于 `last_run`（未运行过则取创建时间）的下一个匹配分钟；夏令时跳过的时刻顺延，重复的时刻取第一次；重新开启已关闭的周期任务时将 `last_run` 设为当前时间，不补跑关闭期间的时刻。
- **助手非当轮授权创建的周期或派工任务须等用户同意（`needsOK`）**：用户创建、或助手在含用户原话的当轮（`Actor.forUser` 为真）创建的任务立即生效；助手在后台回合自行创建时，仅「不派帮工的 `once` 回头看」直接生效；其余存为 `enabled: false, pending: true`，在收件箱（[观察层](docs/subsystems/watch.md#收件箱)）生成 `cron-ask` 待用户点击同意。
- **一个定时任务固定复用一张工单**：未指定帮工档案时指派给所属频道助手；指定帮工档案时必须同时指定仓库。
- **扫描与补跑**：开机后定时筛出 `next_run <= now` 的已启用任务（错过多次只合并补跑一次）。
- **为什么一个定时任务绑定一张工单**：避免高频任务淹没看板，让历次运行记录归集在同一条工单串下；

## 观察执行

`GET /api/v1/issue/watch/:id` 是本机的 SSE 观察流，CLI `issue watch` 使用它。路由（`crates/server/src/transport/http/mod.rs`）只解析工单引用；`issue.watch` 订阅（`crates/server/src/modules/work/session/mod.rs`）先订阅实时事件，再读折好的工单和会话，补最近会话的保留轨迹。历史以批次发送（每批最多 241 条），实时发送 `SessionEvent`；新会话和进入交回阶段时补读历史，使尚未推送的末尾草稿也在退出前交出。`gap.before` 标明保留历史的起点；归档会话没有保留日志时发送不带 `before` 的 `gap`。`omittedSessions` 标明省略的较早会话数。

缓冲、心跳和积压断开和其余 SSE 流一样（[SSE 流](docs/subsystems/core.md#sse-流和其余路由)），客户端重连补读。客户端只按会话、事件 `seq`、`revision` 去重，不比较不同连接的 Core 帧序号；宿主重启不改变轨迹的持久序号。状态来自服务端；`stageWantsUser`、完成和取消决定 `settled`，CLI 不重新判断业务进度。观察流结束只释放队列与连接，不停会话。JSONL（`--json`）字段和退出方式见命令行 `vibevalley issue watch --help`（`crates/cli/src/domains/work/issue.rs`）。
