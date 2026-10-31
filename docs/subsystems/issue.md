# 工单

一件活从写下到关上是一张工单（`Issue`）。代码相关的工单带一个 worktree 和一条分支；帮工（Session）为它干活，可以换人，工单不换。工单按三段走：**聊清楚**、**安排活**、**完成**；聊清楚是起草：主人写一句想做什么，帮工读过代码把它写成固定格式的草稿（标题、说明、验收标准）；每张工单都有一道验收，照验收标准验，过了才算结果。工单的状态只有一套（下面「状态和用语」），看板、工单页、命令行、管家和提醒都说这一套；农场把它画成一块地，那是皮，另有一套词。

## 状态和用语

工单的真实状态分下面几层，每层一个字段、一组词条。词条在词典的 `shared` 命名空间（`packages/i18n/locales/{zh,en}/shared.json` 的 `status`、`priority`、`deliverable`、`delivered`、`canceled`、`attention`、`stuck`、`act`、`outcome`，帮工到哪了的 `phase`；`rules/issues.ts` 的 `closedText`、`rules/phase.ts` 的 `phaseWords` 用它们拼句子），中英各一份（[话放在哪](docs/subsystems/foundation.md#话放在哪)），服务端（工具、管家的提示、拒绝、提醒、连接器）和页面都从这里取，不另写一份；`scripts/stale-names.ts` 查别处有没有 `Record<Outcome, string>` 这样的词表（皮自己的叫法用 `Partial<…>` 盖过，如农场的「收获」）。

| 层 | 字段 | 取值和叫法 | 怎么来的 |
|---|---|---|---|
| 状态 | `status` | `backlog` 备选、`todo` 待办、`in_progress` 处理中、`in_review` 等你看、`done` 已完成、`canceled` 已取消 | 主人挪的存下；处理中、等你看从帮工的阶段或工单的 `lastRun` 现算 |
| 给主人看的状态 | `attention.state` | `draft` 草稿、`queued` 排队、`working` 在做、`asking` 等你回答、`reviewing` 等你验收、`stuck` 卡住了、`done` 已完成、`canceled` 已取消 | `attentionOf` 从状态、帮工的阶段、问题、冲突、验收现算 |
| 卡在哪 | `attention.stuck` | `conflict` 有冲突、`failed` 没做成、`interrupted` 停在半路、`quiet` 没动静 | 同上 |
| 能做的事 | `attention.acts`（`IssueAction`）、`lead` | 按钮：`start` 开工、`answer` 回答、`reject` 打回、`complete` 完成、`acknowledge` 知道了、`resolve` 让它解决冲突、`resume` 接着做、`cure` 接着修、`tell` 带话、`stop` 叫停这一轮、`close` 取消、`reopen` 重开；每个带着按下去发什么（挪到哪、要不要话，说一句，或叫停） | 同上 |
| 交付了什么 | `delivered`（已完成的） | `merged` 合进了主分支、`merged_into_parent` 合进了计划的分支、`pull_request` PR 合进去了、`kept` 分支留着没合、`none` 没有改动要合 | 完成时由工单算（下面「完成和交付」） |
| 为什么取消 | `canceled`（已取消的） | `dismissed` 取消了（主人取消的，或 PR 没合就关了）、`lost` 干活的目录丢了 | 取消时 |
| 一轮怎么结束 | `Run.outcome`、`lastRun.outcome` | `completed` 做完了、`failed` 没做成、`interrupted` 停在半路 | 这一轮 |
| 帮工到哪了 | `Session.phase` | `arriving` 刚派出去、`working` 在干活、`done` 交回来了、`failed` 没做成、`resting` 歇着、`closed` 走了 | 帮工的事件 |

工单的几样东西也只有一个叫法：帮工问主人的是**问题**（`questions`，有问题时是等你回答），没过验收的一条是**验收意见**（`findings`），分支上要合进去的是**改动**（`changes`），一件长活拆成的是**计划**（task graph），一个项目同时能做几张工单是**空位**。

- **一个意思一个词。** 完成只说完成：合进主分支、开 PR、分支留着、没有改动，都是「交付了什么」的取值，不是另一种结束。取消只说取消。「关上」只是已完成和已取消的合称：看板的「已关」一列、`isClosed`、「也列关上的」。
- **状态是工单的，不是画面的。** 给主人看的状态由服务端算，页面、命令行、管家不另起名字；要新的说法就在词表里加，不在用到的地方写一句。
- **农场的词只在农场里。** 农场把工单画成地，用种地的词：地、种子袋、播种、发芽、开花、缺肥（等你回答）、草（验收意见）、收获（完成）、麦茬（已完成）、仓库（合进主分支的）、收成清单（改动）、种植计划（计划）。这些词只在农场的画面（`apps/web/src/farm`）和游戏规则（`apps/server/src/game`、账本、成就）里，对应关系见[农场的皮](docs/subsystems/farm.md)；工单的状态、动作、拒绝、提醒、工具和管家的话都不用它们。`scripts/stale-names.ts`（`docs:verify`）查这条。
## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 工单的模型、状态和能挪到哪 | 帮工怎么跑一轮、事件日志（[帮工](docs/subsystems/session.md)） |
| 起草：派谁起草、交给它的规矩、读回草稿写进工单、起草完重置 worktree | worktree 的重置和清理怎么做（`project.Reset`、`project.Clear`） |
| 派活、排队、重开、取消 | 挑哪个档案（[管家](docs/subsystems/orchestrator.md)） |
| 验收、验收意见、问题、帮工对每条标准的自评 | 汇报怎么读（`session/report.ts` 读出「结论：」「要问主人：」和「标准 N：」交给它） |
| 完成：查冲突、跑检查、本地合或提 PR | 项目和工作目录、worktree 的 git 操作（`project`，[项目](docs/subsystems/project.md)） |
| 工单的状态、给主人看的状态和主人能做的事，和它们的词表；工单的时间线 | 怎么画（工单详情 `apps/web/src/features/issue/overview.ts`；农场的地见[农场的皮](docs/subsystems/farm.md)） |
| | 计划里的工单（跟着计划走，[计划](docs/subsystems/task.md)） |

## 在哪

- 服务端 `apps/server/src/issue`（`Issue`）：`issue.ts` 存取和核心状态、挪状态、派活和重开、排队、带话和取消、验收和问题、帮工历史、派给管家的工单；`refinement.ts` 起草（谁来起草、交回来的草稿怎么读进工单）；`merge.ts` 合并（本地合或提 PR、合不进去怎么说、PR 的轮询）；只有工单用的纯规则按管的事分开，见下一条。worktree、检查、推送和 `gh` 的 git 操作在 `apps/server/src/project`。
- 只有服务端跑的规则在 `apps/server/src/issue`：`status.ts` 的 `issueStatusOf`（状态怎么算）、`issueRefiningOf`（谁在起草）、`withIssue`、`withIssueStatuses`、`issueOrder`、`keepClosedIssues`、`isForOrchestrator`、`openFindings`，`attention.ts` 的 `attentionOf`（给主人看的状态和能做的事）和 `attentionIn`，`moves.ts` 的 `statusMove`、`statusMoves`（能挪到哪、挪了做什么），`brief.ts` 交给帮工的话和从汇报读回来的（`issueBrief`，交付物是结论时带上只读的规矩和结论的格式；`cureWords`、`resumeWords`、`answerCureWords`；`splitBrief` 一句话拆成标题和说明；`findingsOf` 打回的意见），`refinement.ts` 起草（`parseRefinement` 读草稿、`refinementDescription` 拼说明），`templates.ts` 播种表上的模板和最近的标题，`timeline.ts` 的 `milestonesOf` 时间线，`filter.ts` 的 `pickIssues`，`stored.ts` 写进行的样子和下一个计划的 id；地的样子（`plotOf`）在 `apps/server/src/game/view.ts`。服务端和页面都要的留在 `packages/protocol/src/rules`：`issues.ts` 的 `shortTitle`（一行的标题）和 `closedText`，`attention.ts` 的 `attentionWantsOwner`；状态和动作叫什么在 `packages/protocol/src/words`。
- 表：`issue`（一张工单一行；验收标准在 `criteria`、帮工的问题在 `questions`、它对每条标准的自评在 `checks`，都是 JSON 数组）、`issue_session`（哪些 Session 干过它；只有工单写它，工单在内存里记着一份，`issue/sessions.ts`：开机读一遍，记下一个 Session 的事务提交后加一条，删了工单就重读，从帮工找工单、列一张工单的帮工都不再查库）、`issue_queue`（排队的上下文）。
- 接口：`issue.*`（[capabilities.md](docs/reference/capabilities.md)），起草是 `issue.refine`（`POST /api/v1/issue/refine`），时间线是 `issue.timeline.get`；命令行 `vibevalley issue …`。
- 页面：工作台的看板在 `apps/web/src/features/issue`，备选工单的草稿详情是 `TodoDetail.tsx`，派出去以后的详情是 `IssueDetail.tsx`，把服务端的状态说成话的规则在 `apps/web/src/features/issue/acts.ts`；农场照同一份规则画 `farm/issue/IssueView.tsx`；两边的动作（哪些要话、要先打开框、要开对话框，重开以后说什么）都经 `apps/web/src/features/issue/acts.ts` 的 `createIssueActs`，农场只换掉自己有特效的几个（`commands`）；一张工单的改动、时间线和帮工历史都经 `apps/web/src/features/issue/queries.ts` 的 `useIssueChanges`、`useIssueTimeline`、`useIssueRuns` 读，键都在 `issues` 下，什么时候重读写在那里一处；工作台、农场、轨迹和工作记录里的帮工步骤都经 `apps/web/src/features/session/events.ts` 的 `createSessionEvents` 读（快照、直播和重连的约定见[客户端](docs/subsystems/app.md)）；农场的播种袋在 `farm/panels/SeedForms.tsx`。

## 模型和不变量

- **一张工单一个 id**，从写下到关上不变；重开是同一张工单的下一个帮工，不是新工单。
- **状态六个**，和 Linear 一样：`backlog`、`todo`、`in_progress`、`in_review`、`done`、`canceled`。只存主人的意思（排没排上队 `queued_at`、关的结论：完成了交付了什么 `delivered`，或不做了为什么 `canceled`），帮工那一半（在做、交回来了）从核心状态里帮工的阶段算，不另存一份。
- **数据库是家，核心状态有一份**：开着的和最近关的 50 家在 `WorkspaceState.issues`，`Issue` 每改一次库就施加一条 `issue` 事实；页面只读核心状态。
- **主人只挪到 `backlog`、`todo`、`done`、`canceled`**；`in_progress`、`in_review` 是帮工干出来的。每张工单的 `moves`（能挪到哪）和 `attention.acts`（能做什么）是同一张表的两面，都在 reduce 里和状态一起算（`withIssueStatuses`）：帮工这一轮一结束，看板、地块详情、命令行读到的就是新的，不等服务端再发布这张工单；服务端的拒绝调同一个 `statusMove`。拒绝（不能这样挪、现在不能这样做）带着 `next`：这张工单的按钮和按钮没盖到的挪法，各是一条能直接跑的命令（`moves.ts` 的 `nextSteps`）；要主人说一句的（带话、回答、打回、重开、再干一轮）只说哪个字段要写，不给命令。找不到工单时 `next` 是 `issue list`。挪状态和删工单各有试跑（`issue.status.previewUpdate`、`issue.previewDelete`，命令行的 `--dry-run`）：`setStatus` 先算出挪法和它要定下的（谁接手、交付是没改动、留分支还是合并），再动手；试跑只把同一份算出来的说成话（会派给谁、有没有空位、合进哪、会不会冲突、要不要先替它提交），不写库、不碰 git，所以试跑说能做的，真做不会因为同一个原因被拒。
- **找和看**：`issue.list` 带过滤（状态、字、项目、条数、关上的、等主人的），默认只列开着的；规则是 `issue/filter.ts` 的 `pickIssues`，管家的 `issue_list` 和命令行用同一条。验收是 `issue.review`（过了只记下验过，完成仍是挪到已完成）；`issue.split` 让在做这张的帮工把它拆成计划（[计划](docs/subsystems/task.md)）。
- **写只有两个：挪状态、说话**（`issue.status.update`、`issue.comment.create`）。挪是什么由工单现在的处境定，带给帮工的话在服务端拼：等你验收时带话挪回待办是打回（话一行一条成为验收意见），卡住了不带话挪回待办是照原因接着修（`cureWords`）、交代冲突（`conflictBrief`）或接着做（`resumeWords`），挪到已完成是验收通过并照交付方式交付。叫停一轮是帮工的事（`session.stop`）。其余是改字段（`issue.update`，排先后是它的 `before`）、建、删和起草。
- **按钮是皮**：站位给出的每个按钮（`IssueAction`）带着按下去发什么：挪到哪个状态、话必填、可填还是不收（`move`），对帮工说一句（`say`），或叫停（`stop`）。页面（`apps/web/src/features/issue/acts.ts` 的 `perform`）、农具和命令行的下一步都照它发，不自己判断；页面只决定哪个按钮先开输入框、先开改动或关单对话框。
- **工单认编号**（`Issue.idOf`）：接口里的工单可以写 `#41`、`41`、工单 id 或干过它的帮工 id；命令行、管家的工具都用编号。
- **一块地最多一个 worktree**：代码活的分支是 `vibevalley/issue-<号>`，worktree 是 `worktrees/<项目>.<号>`；重开、换帮工、重启都还是这一块。
- **先有工单身份，再派帮工**：即时派活也先写工单、取得编号，再开 Session；启动前写不进工单就不派。派不出去时，项目确认现场已释放才撤掉本次新建工单；已有改动或农机没能停止，就保留工单号和现场，下一张工单不会继承它。已有工单和排队来源保留。`hiring` 只登记既有工单和 Session 的关联、重开、出队，不创建工单。删工单时，现场还被帮工占用、或清理后仍有分支，都拒绝删掉身份；换项目也先以保留改动的方式释放旧现场，不能把仍有改动的地留给旧项目、把身份移走。
- **完成就是验收**：`in_review` 就是「等验收」，挪到已完成就是通过，还没解决的验收意见都算解决。管家的 `issue_review` 工具（`Issue.review`）照验收标准看过：过了记下 `reviewedAt`（地成熟了），不挡也不代替主人完成；没过就是带着意见又一轮。
- **计划里的工单 `moves` 是空的**，验收和挪状态都拒绝。
- **已完成只由主人点头。** 一轮怎么结束的（`completed`、`failed`、`interrupted`）只决定工单停在哪、请主人做什么，不决定活成没成：帮工最后一轮没做成（站位「卡住了」，`stuck: failed`）时 `moves` 里没有已完成，`statusMove` 和完成都拒绝，看板、命令行、管家的工具一样；叫停的一轮还能完成。
- **谁干活不改变工单怎么走**：派给管家的工单和帮工的工单是同一套状态、站位和挪法（`statusMove` 里没有按做活的人分的支）。工单写明交付物 `deliver`：`change`（改动，合进项目）、`branch`（改动，分支留着给主人自己收）或 `answer`（结论，留在工单上）；派给管家的默认是 `answer`，管家不改代码。帮工对 `change` 和 `branch` 干一样的活。完成的按钮跟着交付物：结论是「知道了」（`acknowledge`），改动是「完成」（`complete`）。没有帮工在做的工单（管家在自己的进程里答）由它自己的 `lastRun`（`{ startedAt, endedAt?, outcome? }`，表的 `last_run`）说站在哪：交给管家时记下开始（进 `in_progress`），这一轮结束时记下结局（进 `in_review`），不管怎么结束都等主人：没做成的不能完成，叫停的能完成；挪回待办、重开是带着主人的话再交给管家（`OrchestratorWork.said`），关上不用请谁回家。服务端开机时只把还在答的关成 `lost`，等你看的留着；接着做的那一轮结束时，`lost` 的工单重新打开、记下结局。
- **和帮工的档案的私聊是一张工单**（`Issue.talk` 是私聊的 id）：不在看板和 `issue.list`、`issue.history.list` 里，管家的 `issue_list` 也不列它，站位没有按钮；主人在私聊里说话等于在它的串里说话，没有帮工在做时派一个只读的（`talkOn`），每轮交回来清掉改动，闲 10 分钟收工（[频道](docs/subsystems/channel.md)）。
- **交付物是结论的工单只读**（`deliver: answer`）：交给帮工的活前面写明只读代码、跑只读的命令、不改文件不提交，最后要一个 json 代码块交结论：`conclusion`、`evidence`（依据，至少一条：文件和行号、命令和输出）、`unsure`、`next`（`issueBrief`）。汇报怎么读归帮工模块：`readReport` 读最后一个读得出结论又有依据的代码块（`session/report.ts` 的 `parseAnswer`），放进 `report` 事实的 `answer`，折进帮工的 `lastRun.answer`；工单服务把它记到 `Issue.answer`（表的 `answer`），再请帮工模块把这张工单的 worktree 重置回主分支（`Session.discardWork`：帮工留着，不在干活时才重置），所以它改了什么、提交了什么都不出这张工单，完成时交付总是 `none`。做完的一轮读不出结论，站位是「卡住了」（`stuck: failed`），不能完成，「接着修」带上读不出来的原因和格式（`answerCureWords`）。交付物在工单开着时能改（`issue.update` 的 `deliver`），下一轮照新的走。
- **子工单**带 `parent`、`blockedBy`：计划用它，计划里的工单跟着计划走，看板不能单独开工、重开。
- **还没派的能改、能删、能排先后**（`issue.update` 的 `before`）；派出去以后只能改交付方式。交给帮工的是标题，空一行，再是说明，最后是编了号的验收标准，要它交活时逐条写「标准 N：做到了｜没做到｜不确定」和凭据（`issueBrief`）。
- **备选的工单是草稿**：起草的帮工（`Session.draft`）只为写这张工单来，不是工单的帮工：不进 `issue_session`，`Issue.sessions` 一直是空的，工单一直在 `backlog`。谁在起草（`Issue.drafting`）和状态一样从核心状态里的帮工现算，不另存；起草时不能开工（`moves` 里没有待办，`ready` 也拒绝），一张工单同时只有一个起草的。
- **验收标准**（`Issue.criteria`）：一条一个主人能照着验的点。草稿写它，主人在派出去以前用 `issue.update` 改（给一个空列表就是清掉），派活时编好号写在活的最后；验收时详情把它逐条列出来。
- **改动跟着动作走**：起草和挪状态（`issue.refine`、`issue.status.update`）都带一个 `edit`，是主人在详情里改了还没存的那几栏；服务端先存它再做这件事，动作被拒绝时改动也已经存下。页面不先存再做。
- **帮工的自评**（`Issue.checks`）：汇报里「标准 N：做到了 —— 凭据」这样的行（`checksOf`，N 从 1 数，同一条以最后一行为准），存成 `{ criterion, result, proof }`，`criterion` 是 `criteria` 里的下标；最近一次带了自评的汇报算数，重开时清掉。帮工不写就没有，页面只列标准。
- **标题一行**：主人写的一句话直接成为工单时（`splitBrief`），第一行太长就取它的第一句、放不下就到最后一个停顿（`shortTitle`，40 个字以内），整段放进说明；起草的标题要求 20 个字以内。
- **排队的上下文和排队一起提交**：首次派发的频道和 `RunTrigger`（定时任务的 id、是不是补跑）写进 `issue_queue`，和 `issue.queued_at` 同一个事务；重试照它恢复来源，开工成功时同一个事务清掉。

## 怎么走

**三段和状态**：

| 段 | 状态 |
|---|---|
| 聊清楚 | `backlog`（草稿，可能正在起草）；帮工问了主人还没答是「等你回答」（`questions`） |
| 安排活 | `todo`（排队等空位）→ `in_progress`；验收没过时带着意见再修一轮 |
| 完成 | `in_review`（等你看）→ 验收过了 → `done`（已完成）；不做了是 `canceled`（已取消） |

农场里这三段画成荒地、播种到长叶、开花到麦茬（[农场的皮](docs/subsystems/farm.md)）。

**挪状态就是派活**（`issue.status.update`，转换表在 `apps/server/src/issue/moves.ts` 的 `statusMove`）：

| 挪到 | 从 | 做的事 |
|---|---|---|
| 待办 | 备选 | 派给档案；空位都占满了就在待办排队，服务端每 5 秒按先后试一遍 |
| 待办 | 等验收 | 带一句话（必填）再干一轮 |
| 待办 | 已完成、已取消（派过的） | 重开：同一个档案派一个新帮工，告诉它原来要做什么、上次怎么关的、分支上有没有上次的提交 |
| 备选 | 待办；没派过就取消的 | 不排了；挪回备选 |
| 已完成 | 等验收 | 收获（见下）；`required` 且没通过、或最后一轮没做成时不在 `moves` 里 |
| 已取消 | 在做、等验收；备选、待办 | 叫帮工回家，或没派过的直接关上；分支上有提交就留着 |

**换人**：挪到待办时带 `agent`（`IssueStatusRequest.agent`，档案的 id 或名字）填一个和现在不同的档案，就是换人接手：备选的先改谁来做再开工；等验收的上一个帮工先收工（分支留着），再由新档案重开，新帮工在同一张工单、同一条分支上接着做，交给它的话写明是接手、之前是谁、最后一轮怎么样、分支上已经有什么；关上的直接由新档案重开。在做的拒绝（「先叫停，等它停下再换人」）：同一时间一张工单只有一个帮工在它的分支上干活。档案不在、被停用、农机有错，在任何东西动之前就拒绝，所以换人不会落到上一个走了、新的没派出去。工单的 `assignee` 总是它最新一个帮工的档案（开工时 `AssignIssue` 写下），看板上写的是新档案。换人是收工加重开，两次写库之间工单关上了一瞬，时间线上是两条。

**起草**（`issue.refine`，带主人的一句话；工单有没答的问题时这句话就是回答）：

1. 加号直接建一张备选工单（`issue.create`），主人那一句是标题，还没说时标题是「新工单」；带着话就马上起草。只有在备选里、没派过、没在起草的能起草，派给管家的不能。
2. 谁起草：工单的 `assignee`；没有就是这个项目上次派出去干活的档案（还能派的话，`issue_session` 里最近的那张工单的 `assignee`）；再没有按 `chooseAgent` 挑。项目是工单的，没有就用档案的工作目录，都没有就拒绝。没写的项目和帮工填成这一次的，主人的第一句话写成标题（还没有说明和验收标准时）；回答问题时 `questions` 先清掉。
3. 在这张工单自己的 worktree 里起草（`project.workplace` 按工单开，和后面干活是同一块；档案关了 worktree 也照样开），Run 的触发是 `draft`，花费记在这张工单的 run 上。交给它的活（`refinementBrief`）：只读代码，不改文件、不提交；拿不准的写「要问主人：」，想得到的回答写在句末「（选项：A｜B）」；`title` 20 个字以内；最后用一个 json 代码块交草稿：`title`、`why`、`todo`、`criteria`、`notDoing`、`files`（列表也可以是一句话）。再起草时附上现在的草稿（主人改过的算数）和上一版的问题、主人的回答或这次的话。
4. 交回来：读最后一个能读的代码块（`parseRefinement`），写回工单：`title`，`description` 用固定的小标题拼（为什么、要做的、不做的、可能涉及，空的不写），`criteria`，问题照旧进 `questions`（等你回答）；一次写，第二版整个盖过第一版。读不出来、没做成、被叫停，工单不动，工单串里说一句（串还没开就是一条提醒）。然后请帮工带着 `discard` 收工：帮工先停止写入，再把 worktree 重置回主分支，提交了也清掉；干净的 worktree 和空分支随收工清掉。
5. 主人改各栏、回答问题再起草，满意了挪到待办开工；没开工就取消或删掉的，在起草的帮工带着 `discard` 收工，`project.clear` 清掉起草留下的 worktree 和没有提交的分支。

**排队**：没空位的待办留在待办里排着，后台每 5 秒照看板的先后试一次（`tryQueued`），有空就照它排队时记下的来源开工，派不出去的出队、说为什么。空位一出来它自己就走，不另设「现在就试」。

**验收**：等你验收时带话挪回待办就是没过，话一行一条记成验收意见（`findings`），还没解决的编号写成一句话交给帮工再修一轮；挪到已完成就是通过，意见都算解决。管家的 `issue_review` 走同一个 `Issue.review`：过了记下 `reviewedAt`，原来的意见都算解决，主人照样要完成它。新的一轮开始（带话、再干一轮）`reviewedAt` 作废，意见留着。

**主人的话从一处进工单**：主人的话不管从哪来（`issue.comment.create`、在工单串里 `channel.message.send`、连接器、农场替主人说的冲突和检查没过），写进工单串就有一条带 `thread` 的 `message` 事实，工单服务订阅频道的 `ownerInThread`：清掉 `questions`，作废验收。帮工没有串时 `issue.comment.create` 直接送到帮工、没有事实，`comment` 自己做这两步。关上的工单不动。农场替主人说的话也算：冲突解决、检查没过修好以后是新的一轮代码，管家先前的验过作废。

**问题**：帮工汇报里「要问主人：」开头的行，`readReport` 读出来放进 `report` 事实的 `questions`，工单服务记到 `questions`（`{ question, options? }`：句末「（选项：A｜B）」是它想到的回答，少于两个就不算选项）；主人在工单串里说一句就算回答，点一个选项就是把这句原样说出去，问题清掉。

**给主人看的状态**（`Issue.attention`，`attentionOf`）：从 `status`、帮工的阶段、`questions`、冲突、上一轮的结果和验收算出来，`issueOf` 读工单时和核心状态折事实时（`withIssueStatuses`）都填，页面不自己拼。每种状态带开始的时间（`since`），和主人能做的事（`acts`），其中最多一件是主动作（`lead`）：

| 状态 | 什么时候 | 主动作 |
|---|---|---|
| 草稿 `draft` | `backlog`；正在起草时没有动作 | 开工 |
| 排队 `queued` | `todo`，或计划里还没轮到的一步 | 无（可以关上） |
| 在做 `working` | 帮工在干活 | 无（可以带话、叫停、关上） |
| 等你回答 `asking` | 交回来了，有 `questions` | 回答 |
| 等你验收 `reviewing` | 交回来了 | 完成；可以打回（管家验过的不再打回） |
| 卡住了 `stuck` | 冲突（`conflict`）、没做成（`failed`）、停在半路（`interrupted`）、很久没动静（`quiet`） | 让它解决冲突 / 接着修 / 接着做（都是不带话挪回待办）/ 叫停 |
| 已完成 `done` | `done` | 无（可以重开） |
| 已取消 `canceled` | `canceled` | 重开 |

冲突排在问题前面，问题排在没做成前面；交付物是结论的工单，做完的一轮没交出读得出的结论也算没做成。计划里的工单有状态、没有动作：在计划那边操作。没有帮工在做的工单（派给管家的）在答时只能「取消」；答完了是「等你看」（交付物是结论时主动作「知道了」），没答成是「卡住了」（只能「取消」），叫停的仍能完成。每种组合钉在 `apps/server/src/core/testdata/rules.jsonl.gz`（`attentionOf`）。

**时间线**（`issue.timeline.get`，`milestonesOf`）：从已经存着的事实拼，不另存：开单；每次干活的开始（开工、你带了话、重开、定时任务、起草）和结束（交回来了、问你、没做成、停在了半路、起草好了）；打回（同一时刻的意见合成一条）；验收通过；关单。新的在上，带时间和是哪个帮工；同时给出所有干活加起来花了多少（`spent`）。

**完成和交付**：已完成是主人对工单的结论，合并只是交付的一种。关上的工单存结论和交付两个字段，不再是一个「怎么关的」：

| 结论 | 字段 | 取值 |
|---|---|---|
| 完成 | `delivered` | `merged`（合进项目的主分支）、`merged_into_parent`（计划的一步合进计划的分支）、`pull_request`（PR 合了）、`kept`（分支留着不合）、`none`（没有改动要合，或管家的回答） |
| 不做了 | `canceled` | `dismissed`（主人关的、PR 没合就关了）、`lost`（干活的目录丢了） |

挪到已完成只有一个挪法 `complete`，交付由工单算，不由谁来挪算：确认分支不存在或没有主分支没有的提交，交付 `none`，不碰 git、不开空 PR；读取分支或提交失败则拒绝，不把故障当成无改动。工单的交付是 `branch`（`issue.update` 改，或挪的时候带在 `edit` 里）且有提交，交付 `kept`，分支和提交留着、帮工收工；其余照下面合并，合进主分支或开 PR。不合并的两种先写下结论再让帮工收工（帮工的离开记成 `completed`），所以帮工离开时不会把它当成「不做了」。帮工离开时工单还开着，才按它离开的方式关工单（合进去了是完成，其余是不做了）。

**合并**（有提交、不留分支的完成）：

1. 还在干的不收；关掉会话，没提交的改动替它提交（缓存和依赖目录不提交）。
2. 会冲突就不合：标上 `conflict`，「让它解决冲突」发一句固定的话（`conflictTask`）交回帮工，在自己的分支上把主分支合进来，下一轮结束时再查。
3. 跑项目的检查：帮工分支上的 `.vibevalley/check`，在 worktree 根目录、项目锁外跑，没有这个文件就跳过；本地合的先把主分支合进帮工分支再检查，PR 和计划检查帮工当前的分支。退出码非 0、跑不起来或超时（`project.check_timeout_seconds`，默认 1200）都不合，输出的最后 40 行附在拒绝里交给帮工修。工单留在 `in_review`，帮工、分支、worktree 都在。
4. 进锁以后确认分支没在检查后变过、重新查一次冲突、主分支没有没检查过的提交，才合：
   - **本地合**（项目不在 `github.pr_projects` 里，或 `pullRequest.available` 为假）：合进项目克隆的主分支，删掉 worktree 和分支，帮工离开，账本记 `harvested`。
   - **提 PR**：农场 `git push -u origin <工单分支>`，用工单标题、编号、帮工最后一轮的「结论：」那一段（找不到就放最后一轮原话）和检查结果开 PR；已有开着的 PR 只推分支，开完没存下回执的重试先查已有的 PR。推送或 `gh` 失败就拒绝这次完成。`pullRequest` 记 `url`、`number`、`state`；PR 开着时工单留在等验收，再干一轮再收获更新同一个 PR。

**PR 的结局**：农场每 `github.pr_poll_seconds` 秒（默认 180，`github refresh` 手动）查开着的 PR：合了就完成、交付 `pull_request`，没合就关掉是不做了（`dismissed`），清掉 worktree 和本地分支，帮工离开；帮工还在干或有待开始的一轮就留着现场，下次再结。远端分支归 GitHub。开新分支或结束 PR 前先 `git fetch origin <主分支>` 快进本地主分支，不干净或不能快进就保留本地的、记日志。

**收工**：关掉会话、帮工离开；分支上有没合的提交就留着，重开接着做。

## 和谁打交道

- **帮工（`session`）**：派活经 `Session.send` 开一个 Session，起草的带 `SendOptions.refining`、不记关联，它的汇报由工单服务读成草稿；帮工离开（`left`）时，离开的是最后一个就关上工单；汇报（`report`）带来缺肥的问题。
- **项目（`project`）**：worktree、分支、冲突预检（`git merge-tree`，不碰工作区）、检查和合并、推送和 `gh`、取消时的清理（`clear`）；起草后的重置由帮工模块在停止写入以后调用，工单只决定丢弃起草的工作。
- **频道（`channel`）**：派活时在频道里开工单串，一张工单一个串，重开、换帮工都在这个串里（[频道](docs/subsystems/channel.md)）；带话和验收没过的意见经它交给帮工。
- **定时任务（`cron`）**：一个定时任务一张工单，到点是它的一轮（[定时任务](docs/subsystems/cron.md)）。
- **计划（`task`）**：计划是带 `graph` 的父工单，每一件是带 `task` 的子工单，跟着计划走，不归这里的转换表。
- **管家（`tool`）**：派活、带话、验收、完成都是同一个服务的方法，完成要主人说一声。
- **GitHub 检测（`setting`、`project`）**：开机查 `gh` 装没装、登没登录（`github.get`、`github.refresh`），项目查 origin 是不是 GitHub、有没有写权限，结果缓存在 `project.pullRequest`；完成只读缓存决定走哪条路。
- **农场的皮（`plotOf`、`game`）**：工单的状态在农场里用种地的词说（「状态和用语」）；`FarmView.plots` 按工单做键（`plotKeyOf`，重开的工单还是这块地），地的样子看工单和地上帮工的阶段；农具直接调 `issue.status.update`、`issue.comment.create`、`issue.accept`，不经帮工找工单；仓库是交付 `merged` 或 `pull_request` 的工单。游戏只读事实算画面和账本，不调工单。

## 为什么这样

- **工单是服务端的一样东西，帮工挂在它下面。** 原来「工单」是页面从帮工的轨迹拼出来的，重开换 id、几台设备各看各的。放弃了「接回原来的会话来重开」：分支合了、会话可能过期，新派一个帮工、把该知道的写给它，任何一种关法都能用。叫 `Issue` 不叫 `ticket`，和 Linear、GitHub、Multica 一致，界面上叫工单。
- **状态只存主人的意思，帮工那一半现算。** 存一份完整的状态，帮工半路死掉、农场重启时都要对一遍，违反「核心状态只有一份」；现算的话帮工离开，工单自己回到主人定的那一列。
- **写只有挪状态和说话两个，按钮是皮。** 原来改生命周期有三个入口三套词：挪状态（`issue.status.update`）、14 个按钮动词（`issue.act`，九个只是转手调挪状态、评论或叫停）、`issue.dispatch` 和 `issue.move`；一个意图两三个入口（完成是挪到已完成，也是 `act complete`、`act acknowledge`），`act` 的输入是一袋可有可无的字段，打回没写意见要到服务端才拒。卡住了的三种接着干、打回，本来就是挪回待办，差别只在话由谁写；服务端按处境写，页面照帧里的 `IssueAction` 发，不再认动词。放弃了每个动词一个接口：十几个都很薄的接口，试跑翻倍，规则仍分在各处。放弃了只留 `act`、输入按动词分成联合类型：类型查得住，看板拖动和按钮还是两条路。
- **挪状态就是派活，一个接口 `issue.status.update`。** 原来是 start、unqueue、merge、cancel、reopen 五个动作，主人看到的是列、要做的是动作；看板、命令行、管家都得记哪个动作挪到哪。放弃了「只在拖卡片时翻译成动作」：只有页面受益，规则写在页面里。in_progress 不让主人挪进去：和挪到待办只差没空位时怎么办，多一个入口没换来什么。
- **一块地是一张工单，不是帮工的位置。** 地跟着帮工走时，重开的工单换地、地块详情和工单详情两页、工具要先找帮工再找工单。也没选「地是 worktree」：主人派的、看的、收的都是工单，worktree 只是代码活的一部分。
- **完成是主人对工单的结论，交付另记；交付物事先写在工单上。** 原来已完成只有合并一条路：查一下、确认修好了的工单没有提交也「合并」，用 PR 的项目会开一个空 PR，这次不想合的只能关成「不做了」；关单方式一个字段既说结论又说代码去了哪，还按谁做的分三套规则（帮工、管家、计划的步骤）。放弃了按有没有提交自动判：那是事后猜工单是哪种活，「查一下」的帮工顺手改了文件就成了合并，验收也不知道该验结论还是改动。也没给工单加种类、每种一套关单的规则（和按谁做的分叉是同一个毛病：交付物只决定帮工怎么干、完成时默认怎么交付，生命周期还是一套），没接着往关单方式里加取值，没把完成和合并拆成两步（合不进去时工单该回哪说不清：交付是完成的一部分，合不进去就不算完成）。
- **已完成只由主人点头，不由一轮的结局推出来。** 原来管家的工单一轮跑完（`completed`）就关成已完成，可管家说一句「没查到」也是 `completed`；帮工的工单最后一轮没做成，页面藏了完成键，服务端却照样能完成，`glance` 的完成又算验收。两处都是拿「这一轮没崩」当成「活干成了」。放弃了「只把失败的留下，答完的照旧自动关」：答没答上，runtime 判断不了；也没让管家用工具自己报结局，那是把规则交回模型。代价是每天的定时任务汇报这样的管家工单要主人点一下才关；定时任务下次到点接着用同一张，不会越积越多。
- **完成就是验收，不分两步。** 原来工单有验收方式（`glance` 完成就算，`required` 先点「验收通过」才能完成），要验收的工单主人点两下才合得进去，通过和完成说的是一件事。管家验过照样记下（`reviewedAt`），给主人参考，不挡主人完成。
- **每张工单都有验收，`in_review` 收窄成「等验收」。** 没有这一关，「交回来」和「做完了」分不开，地的阶段也没法标；没加新状态，因为它和 `in_review` 是同一件事。问题从帮工汇报里固定的一行读，不让管家读工单串去判：帮工最清楚自己缺什么，固定的开头读得准，不调模型。验收意见整批解决：汇报里读不准修了哪几条，下一次通过就都算解决。
- **对主人只有一套状态，由服务端算。** 原来工单的六个状态、帮工的阶段、页面的三段进度和标签各说各的，没有一套说「卡在谁身上」：帮工问了问题、一行没改，进度条停在「完成」，主按钮是完成。改成从这几处事实算一套给主人看的状态和唯一的主动作，放在 protocol 里、用黄金数据钉住每种组合：算错了比没有更误导。没把它存进库：它全是现算的，存一份就要对一份。放弃了照搬 Linear 的工单页（标题、描述、属性栏、评论流）：这里是 agent 在做，主人要知道的是卡没卡、要不要我、做到了没有、交出了什么，评论流答不了这些。
- **聊清楚是起草：主人写一句，帮工照格式写成工单。** 主人想说的只是「看板拖卡还在调旧接口」；要做什么、怎么算做完、碰哪些文件，是读过代码的人才写得出来的，工单写得粗，验收也没有依据。放弃了让管家起草：管家只看得到农场的状态，读不了代码，写不出要碰哪些文件、怎么验收。草稿交回来直接填进工单，不让主人再点「填进工单」：主人随时能改每一栏，多一步确认没换来什么。加号写了一句话就马上起草，不另等主人点按钮：主人写这句话要的就是一张写好的工单；代价是每张都花钱，花费记在工单上，以后可以加「不起草，直接写」。
- **起草在工单自己的 worktree 里，交回来就重置。** 在项目的主检出里只读起草不用开 worktree，快；可「只读」只能写在提示里，帮工改了文件就改在主人的主分支上。用工单自己的 worktree，交回来 `checkout -f -B` 回主分支、`clean -fd`，改了什么、提交了什么都不出这张工单，开工时从主分支起步。
- **起草的帮工不是工单的帮工，「正在起草」现算。** 记进 `issue_session` 的话，状态就从帮工算成处理中、等你看，还会被「最后一个帮工离开就关单」关上；另存一个「起草中」又是第二份状态。只标在 Session 上（`draft`），工单从核心状态里认出它，帮工离开就自己没了。起草的规矩和读草稿只有工单用，放在 `issue/brief.ts`，不放进 `session/report.ts`。
- **一张工单一条分支、一个 worktree，跟着工单不跟着帮工。** 按帮工开时，取消后重开的帮工不在原来的分支上接着干，旧 worktree 还会留着，一张工单两个 worktree。约束放进 `project.Workplace`：按工单开，有就复用，不靠调用方记着。
- **合并在不碰工作区的地方预检，冲突交回帮工。** 遇到冲突再中止要碰主人的工作区；冲突交给主人在终端里解决，不如让最清楚改动的帮工解决、跑测试、说清怎么取舍。
- **检查写在仓库里（`.vibevalley/check`），在锁外跑。** 写在项目设置里会和代码分开，帮工也看不见合并时跑什么。在锁里跑会让同一个项目几分钟开不了新 worktree；锁外跑、进锁再核对分支没变。
- **能提 PR 的项目一律提 PR，开关 `github.pr_projects`。** 本地合和提 PR 都可选会有两套状态，主分支有时在本地动、有时在 GitHub 上动，农场的克隆和 origin 迟早分叉。帮工自己不 push：推送和开 PR 留给农场，帮工照旧只在工作目录里提交。

## 还没做的

- 管家答的工单还没把回答记成 `Issue.answer`：回答在它的频道里，工单页写「回答：在它的频道里」。
- 照一张结论工单的结论起一张改动工单（`parent` 指向它）：现在要主人或管家另记一张。
- 不起草，直接写（省钱）；验收时勾过的标准记下来：现在只在这一页上勾。
- 几个人一起种、派一个看地的、验收标准逐条打勾记进工单：[一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)。
- 农场里回答问题的农具（肥料袋）：现在回答是带话。

## 怎么验证

- `apps/server/src/issue/recorded.test.ts`：黄金数据；标题和活；一行太长的话取第一句当标题；活的最后是编了号的验收标准；时间线；下一件的 id；读最后一个能读的块；起草的规矩（第一版、回答问题、再起草）；每个状态能挪到哪；工单模板的目录、按栈填、每个都填得满、最近的标题是这个项目自己派过的。
- `issue/issue.test.ts`（oar 的 `scriptedRuntime`、真的 git 仓库）：开不了会话就交回 worktree；写不进的工单不发布、不留 Session；同时两次派活守住项目的空位；挪工单不动计划里的先后；工单的动作找它最新的帮工；排队的工单记着第一次从哪个频道派的、定时任务的触发和补跑；排着队的待办有空位才开工、没有就留着位置；帮工历史把还在的和走了的合起来，列出缺了记录的。
- 流程（`src/flows`，照字眼干活的帮工、真的 git 仓库）：`issue.test.ts`（关上再重开、写下来再派、等空位、知道自己是计划的哪一件、定时任务只有一张工单、只改给出的字段、挪状态就是派活、检查没过不让收、取消再重开留着 worktree、交付物是结论的工单（结论记在工单上、分支上什么都不留、读不出结论卡住再接着修）、验收：缺肥 → 回答 → 等验收 → 带话挪回长草 → 修 → 完成，意见都解决、钱用完不派）；`draft.test.ts`（派之前起草、第二版盖过第一版、起草不留东西、读不出来的草稿不改工单）；`pull_request.test.ts`（推送、开 PR、重启后 PR 合了或关了才关单并清掉 worktree 和分支）。
- `apps/server/src/core/golden.test.ts`：工单的状态、谁在起草、地的样子（`rules.jsonl.gz`、`reduce.jsonl.gz`）。
- 页面：`apps/web/test/issues.spec.ts`（快速新建、列表和分组刷新后还在、工单有自己的地址和保存、没帮工时开工先问、拖着排序、搜索、截图）；`farm-hud.spec.ts`（播种袋的「草稿」写进备选）；`farm-chat.spec.ts`（点帮工的地打开它的工单）。
