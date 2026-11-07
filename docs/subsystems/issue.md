# 工单

一件活从创建到关闭是一张工单（`Issue`）：
- 代码类工单绑定一条分支与一个 worktree；帮工 `Session` 可换人，工单 ID 不变。
- 工单分**聊清楚**、**安排活**、**完成**三段，在农场里画成一块地。

## 状态和用语

状态词条定义在 `packages/i18n/locales/{zh,en}/shared.json`，前后端共用（详见 [话放在哪](docs/subsystems/foundation.md#话放在哪)）。种地隐喻词仅用于像素农场与游戏模块，由 `scripts/stale-names.ts` 检查。

| 层级 | 字段 | 取值与名称 | 来源 |
|---|---|---|---|
| 流程状态 | `status` | `backlog` 备选、`todo` 待办、`in_progress` 处理中、`in_review` 待验收、`done` 已完成、`canceled` 已取消 | 主人设置存库；`in_progress` 与 `in_review` 从在场 `Session` 或 `lastRun` 派生 |
| 展示阶段 | `stage.state` | `refining` 草稿、`queued` 排队、`working` 在做、`asking` 等你回答、`reviewing` 等你验收、`stuck` 卡住了、`done` 已完成、`canceled` 已取消 | `issueStageOf` 实时计算 |
| 受阻原因 | `stage.stuck` | `conflict` 有冲突、`failed` 没做成、`interrupted` 停在半路、`quiet` 没动静 | `issueStageOf` 实时计算 |
| 可执行动作 | `stage.acts`、`lead` | `start` 开工、`answer` 回答、`reject` 打回、`complete` 完成、`acknowledge` 知道了、`resolve` 让它解决冲突、`resume` 接着做、`cure` 接着修、`tell` 带话、`stop` 叫停、`close` 取消、`reopen` 重开 | `issueStageOf` 计算，自带点击后发送的请求参数 |
| 完成交付 | `delivered` | `merged` 合进主分支、`merged_into_parent` 合进父分支、`pull_request` PR 合入、`submitted` 已提交 PR/MR、`kept` 保留分支、`none` 无代码改动 | 完成关单时由服务端判定 |
| 取消原因 | `canceled` | `dismissed` 取消、`lost` 工作目录丢失 | 取消关单时写入 |
| 单轮结局 | `Run.outcome` | `completed` 做完了、`failed` 没做成、`interrupted` 停在半路 | 单次 `Run` 结束时写入 |
| 会话阶段 | `Session.phase` | `arriving` 刚派出、`working` 在干活、`done` 交回来、`failed` 没做成、`resting` 歇着、`closed` 走了 | 会话生命周期更新 |

固定术语：帮工提问叫**问题** `questions`，打回意见叫**验收意见** `findings`，待合入内容叫**改动** `changes`，拆出的工单叫**子工单**，仓库并发上限叫**空位**。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 工单模型、状态派生、原生父子依赖（`parent` / `blockedBy`）与合法状态流转 | 会话如何跑一轮、轨迹日志记录（[帮工](docs/subsystems/session.md)） |
| 起草（`refine`）：派帮工只读看代码生成草稿、写回工单、重置 worktree | worktree 创建、重置与清理实现（[仓库](docs/subsystems/repo.md)） |
| 派活、排队重试、拆分子工单（`split`）、换人、重开与取消 | 档案选择算法（[管家](docs/subsystems/orchestrator.md#模型和不变量)） |
| 验收、打回意见、问题清理与验收标准自评（`checks`） | 信箱投递、三道刹车与唤醒调度（[Mailbox](docs/subsystems/mailbox.md)） |
| 完成与交付：冲突预检、跑 `.vibevalley/check`、合入父分支或主分支、提 PR 与轮询 | 农场地块渲染（[农场的皮](docs/subsystems/farm.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/issue/issue.ts`、`lifecycle.ts` | 对外 `Issue` 服务、生命周期写操作、内存派工关联（`Assignments`）与事实发布 |
| `apps/server/src/issue/dispatch.ts`、`settle.ts` | 派活、排队刷新、重开、定时触发、状态流转前置判定与试跑预览 |
| `apps/server/src/issue/refinement.ts`、`split.ts`、`merge.ts` | 工单起草、原生父子拆单与合入父分支、本地合并与 PR 轮询 |
| `apps/server/src/issue/status.ts`、`stage.ts`、`moves.ts` | 状态派生（`issueStatusOf`）、展示阶段（`issueStageOf`）与合法挪动（`statusMove`） |
| `apps/server/src/issue/dependencies.ts`、`brief.ts`、`timeline.ts`、`rows.ts` | 依赖环检测与解锁、任务说明拼装、时间线与行转换 |
| `packages/protocol/src/rules/issues.ts`、`stage.ts` | 前后端共用的 `shortTitle`、`closedText` 与 `stageWantsOwner` |
| 表 `issue`、`issue_assignment`、`issue_assignment_execution` | 工单主表、档案责任关系与实际执行的 `Session` 关联 |
| `apps/web/src/features/issue/`、`apps/web/src/farm/issue/IssueView.tsx` | 工作台看板与工单详情、动作分发 `acts.ts`、农场工单详情 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`issue.*`），CLI 命令为 `vibevalley issue ...`。

## 模型和不变量

- **生命周期统一走 `setStatus` 状态机**：主人只能将工单移至 `backlog`、`todo`、`done`、`canceled`；`in_progress` 与 `in_review` 从在场会话实时派生。
- **核心状态保留活跃与近期工单**：全量工单存 `issue` 表；`SpaceState.issues` 保留未关工单及最近关闭的 50 张工单（含子工单，`keepClosedIssues`）。
- **责任关系与执行分离**：指派档案写 `issue_assignment`（换人或清空才写 `ended_at`）；实际运行的 `Session` 记在 `issue_assignment_execution`。
- **写操作收敛为「挪状态」与「说话」**：流转调 `issue.status.update`，评论调 `issue.comment.create`。前端按钮（`stage.acts`）自带请求参数，不重写判断。
- **引用解析统一在服务内完成**：接口支持传入 `#41`、`41`、工单 UUID 或曾执行该工单的 `Session` ID（`Issue.idOf`）。
- **先建工单身份，再派帮工**：即时派活先写 `issue` 表拿编号再开 `Session`；启动失败且工作区干净时撤回新单，已有改动则保留现场。
- **授权边界 `Mandate`**：工单绑定不可变的 `originTriggerId`，管家建单附言硬限 30 词；仅当 `autoSubmitPr` 为真时允许自动提 PR，`maxBotReviewRounds` 限制自动响应评审轮数。
- **单轮结局只认结构化 `issue_report`**：帮工通过 `issue_report` 提交状态、问题、`checks`、`answer`、记性与 `prSubmit`，不解析自由正文。
- **执行情况与生命周期分开**：提问、失败、中断及未明确交回的休息会话保持 `in_progress`，`stage` 提供回答、重试、继续动作；有效交回且没有待答问题才进入 `in_review`。看板、详情与 CLI 都读取同一投影；CLI 的 `issue show --watch` 在提问或受阻阶段也返回，stderr 同时给出生命周期和阶段。
- **PR 在途自动跟进**：当 PR 在途且无待答问题时，回合结束后会话进 `resting` 并释放槽位，工单保持 `in_progress` 等待 CI/评审；仅 `prSubmit=false` 显式交接才进 `in_review`。
- **交付物类型 `deliver` 事先声明**：分 `change`（要求合入）、`pull_request`（提交 PR/MR 即交付）、`branch`（留分支）与只读调研 `answer`；`answer` 单将结论写入 `Issue.answer`，完成后重置 worktree 并记 `delivered: none`。
- **原生父子工单与 DAG 依赖**：通过 `parent` 与 `blockedBy` 表达归属与前置依赖。子工单从父分支 `vibevalley/issue-<父编号>` 切出 worktree，完成后经 `mergeInto` 合入父分支。
- **验收子工单先判红并冻结文件**：标记 `constraints.acceptance` 的子工单必须先证明检查失败，合入父分支时将其改动文件记为 `frozen`；后继子工单不得修改冻结文件，且末端须通过全部祖先验收命令。
- **已完成只由主人点头**：单轮 `completed` 只进 `in_review`，管家 `issue_review` 通过只记 `reviewedAt`；最后一轮为 `failed` 时禁止挪到 `done`。

## 怎么走

**起草（`issue.refine`）**

1. 主人对 `backlog` 工单发一句话，服务端按当前指派、仓库历史或 `chooseAgent` 选定帮工档案。
2. 将主人输入写入同一工单串；最近 40 条讨论（最多 24,000 字符）、当前正文、验收标准及问题一起交给 `refining` 会话。有仓库用专属 worktree；没有仓库或档案目录时用隔离的上下文目录，不创建仓库，不进 `issue_assignment_execution`。
3. 帮工返回草稿 JSON 块与问题；服务端解析写回工单，并在工单串展示整理后的需求。结束起草会话；有 worktree 时重置回主分支，无仓库的上下文目录只在没有文件时删除。
4. 主人确认派发时，当前正文和验收标准进入执行说明。执行后不能直接编辑目标、正文或验收条件；补充与退回意见进入同一工单串，不静默替换目标。

**派活与排队（`issue.status.update` → `todo`）**

1. 挪到 `todo` 时同事务写入排队 `Trigger` 并交 `Mailbox` 入池；若传入新 `agent` 则先结束旧 `Assignment` 完成换人。
2. 若前置依赖已满足且有空位，立即启动 `Session` 并开启工单串。
3. 若无空位，工单留在 `todo`（`stage: queued`）；`Issue.refreshQueue` 在空位释放或周期到期时按看板顺序自动补派。

### 完成和交付

主人将工单挪到 `done` 时，服务端按 `deliver` 与分支状态判定交付：

1. **无代码改动（`none`）**：管家工单、`deliver: answer` 或分支无新提交时，直接记 `delivered: none` 并关闭会话。
2. **保留分支（`kept`）**：`deliver: branch` 且有提交时，保留分支并关闭会话，记 `delivered: kept`；工作树里未提交的改动不代提交。
3. **提交 PR/MR（`pull_request`）**：已有开放或已合入的结构化关联可完成；尚未提交时，仓库应已配置 PR 发布，主人点击完成会先运行检查并提交，发布失败就保持原状态；完成时记 `delivered: submitted`，不合并，保留未合入分支及未提交改动。远端状态变化只更新关联，不代替验收。
4. **要求合入（`change`）**：
   - 在锁外要求工作树干净；有未提交改动就退回帮工，按仓库自己的提交规范提交后再来。干净时用 `git merge-tree` 预检冲突；若冲突则标上 `Issue.conflict` 并留在 `in_review`。
   - 在锁外运行 `.vibevalley/check`；若失败则将末尾 40 行输出交回帮工修复。
   - 进仓库锁复核分支未变：子工单合入父分支记 `merged_into_parent`；普通工单本地合入主分支记 `merged`，或推送分支创建/更新 PR。
5. **要求合入的 PR 轮询结清**：每 `github.pr_poll_seconds` 秒轮询开放 PR；合并后记 `delivered: pull_request` 并清理 worktree，关闭未合则记 `canceled: dismissed`。

### 详情与讨论

详情显式展示当前需求、验收条件、交付结果和讨论记录。讨论使用 Channel 的工单串，换人、重试、退回不更换历史来源；`issue.conversation.get` 查询持久化的串位置，消息分页读取并订阅更新。执行轨迹只在展开时加载，不进入讨论消息。

PR/MR 创建或更新后在串内记录真实链接；关联保存在 Issue，消息以工单和 URL 构成的 `sendKey` 持久化去重，提交与轮询串行。完成后的 PR 状态继续更新，但不触发工作区清理。完成按钮统一表达验收，实际交付行为由服务端按 `deliver` 判定。

## 和谁打交道

- **帮工（`session`）**：调用 `send`、`deliver`、`handOver`、`dismiss`；订阅 `Session.news` 更新工单状态、问题与冲突。
- **仓库（`repo`）**：管理 worktree、冲突预检、`.vibevalley/check`、分支合并与 `gh` PR 操作。
- **信箱与频道（`mailbox`、`channel`）**：排队输入经 `Mailbox` 投递；主人发言经 `Channel.ownerInThread` 清空问题并作废旧验收标记。
- **接入（`ingress`）**：轮询 GitHub PR 的 CI 与 Review 事件，转为 `Trigger` 投入工单信箱。

## 为什么这样

- **工单是核心实体，帮工挂在工单下**：重开或换人复用同一工单 ID、同一分支与同一工单串，历史不散落。
- **大活拆成原生父子工单，不设独立 `TaskGraph` 服务**：子工单直接复用普通工单的看板、提问与修复动作，通过检查后合入父分支，省去平行的计划服务、表和面板。
- **验收子工单只冻结自身改动文件，违规直接退回**：冻结整个测试目录会阻碍后续步骤新增测试，悄悄恢复文件会让帮工莫名编译失败；显式退回并仅在依赖链末端跑全量祖先验收，兼顾防作弊与效率。
- **状态只存主人意图，展示阶段与按钮由纯函数派生**：`in_progress`、`in_review`、`stage` 和 `acts` 实时算出并由黄金数据锁死，帮工崩溃不会导致库状态卡死。
- **完成结论与交付去向解耦**：将 `done`/`canceled` 与 `delivered` 分为两个正交字段，使调研结论单、留分支单和合并单共用一套状态机。

## 还没做的

- 多帮工协作同一块地、逐条勾选持久化验收标准：[一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)。
- 故障自动回流成验收样本、退回超限换新会话：[先采样，再验收](.agents/notes/proposed/architecture/2026-10-14-sample-then-verify.md)。

## 怎么验证

- `apps/server/src/issue/recorded.test.ts`、`apps/server/src/core/golden.test.ts`：状态派生、合法挪动、时间线与模板填充黄金数据。
- `apps/server/src/issue/issue.test.ts`、`apps/server/src/flows/issue.test.ts`、`apps/server/src/flows/refinement.test.ts`、`apps/server/src/flows/pull_request.test.ts`：派活、起草、父子拆单、检查与 PR 流程。
- `apps/web/test/issues.spec.ts`、`apps/web/test/farm-actions.spec.ts`：工作台看板与农场工单操作端到端测试。

## 观察执行

`GET /api/v1/issue/watch/:id` 是本机的 SSE 观察流，CLI `issue watch` 使用它。路由只解析工单引用；`issue/watch.ts` 先订阅 Core 实时事件，再读取 `Core.states` 折好的工单和会话，补最近 8 个会话的保留轨迹。历史以批次发送（每批最多 241 条），实时发送 `SessionEvent`；新会话和进入交回阶段时补读历史，使尚未推送的末尾草稿也在退出前交出。`gap.before` 标明保留历史的起点；归档会话没有保留日志时发送不带 `before` 的 `gap`。`omittedSessions` 标明省略的较早会话数。

观察流复用 Core 的 64 项有界缓冲，积压超限关闭连接，客户端重连补读。客户端只按会话、事件 `seq`、`revision` 去重，不比较不同连接的 Core 帧序号；宿主重启不改变轨迹的持久序号。状态来自服务端；`stageWantsOwner`、完成和取消决定 `settled`，CLI 不重新判断业务进度。观察订阅的作用域关闭只释放队列与连接，不调用会话停止。JSONL 字段和退出方式见 [CLI](apps/cli/README.md#观察工单执行)。
