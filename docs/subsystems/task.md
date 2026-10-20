# 种植计划

种植计划（`TaskGraph`）把一件很长的编码活拆成有先后的几件（`Task`），每件一个帮工，按 DAG 推进：等的都合进去了才开工，互不依赖的同时做。计划是带 `graph` 的父工单，每一件是带 `task` 的子工单；它有自己的计划分支，每一件做完由农场跑检查、合进计划分支，全部做完主人一次收获进主分支。农场里是院子里的图纸桌（计划板）。

同一个包的子包 `task/engine` 是另一张图：VibeValley 自己的 agent 在一个会话里给自己记的任务图，和种植计划共用 `protocol/dag.go` 的边的规则，别的都不共用（见[agent 自己的任务图](#agent-自己的任务图)）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 拆：派规划的帮工、读它给的计划、打回一次；帮工把自己的工单拆成计划 | 规划的帮工读什么、拆的规矩（`session/rules.go` 的 `SplitBrief`） |
| 计划和每一件的状态、能做哪些动作、能改哪些件 | 父工单、子工单的存取和核心状态（[工单](docs/subsystems/issue.md)，`issue.PutTask`） |
| 调度：哪几件能开工、并行数、派谁 | 挑档案的打分（`session.ChooseAgent`）、农场的地满没满（`issue.Hire`） |
| 每一件做完的验证：检查命令、验收、冻结的文件 | 帮工怎么跑一轮、汇报怎么读（[帮工](docs/subsystems/session.md)） |
| 计划分支：开、合进去、收获进主分支 | git 操作本身：冲突预检、合并、`.vibevalley/check`（`internal/project`，[项目](docs/subsystems/project.md)） |
| 计划的经过（`task_event`） | 计划板怎么画（[farm-ui.md](docs/reference/farm-ui.md) 第 18 项、`farm/task_board.dart`） |
| 什么时候告诉管家一句 | 管家怎么回话、它的工具怎么包装（`internal/manager`、`tool/task.go`） |
| agent 自己的任务图的形状、状态和存储（`task/engine`） | 把任务图交给模型的工具和帮手的推进（`agent/brain` 的 `tasks.go`、`taskrun.go`，[brain](server/internal/agent/brain/README.md)） |

## 在哪

- 服务端 `server/internal/task`（`task.Service`，`Workspace` 上的字段是 `TaskGraph`）：`task.go` 拆、调度、验证、动作和开机恢复；`rules.go` 是只有它用的纯函数（`startable`、`parseSplit`、`editTask`、`removeTask`、`taskBrief`、冻结文件的判断和交给帮工的几句话）；`log.go` 计划的经过。
- 几个包都用的规则在 `protocol`：`task_rules.go`（`GraphProblems`、`ReadyTasks`、`BlockedBy`、`LayersOf`、`GraphActions`、`TaskActions`、`CanEditTask`、验收的几条、`MaxTasks`、`DefaultParallel`、`AutoRetries`）、`task_issues.go`（`GraphIssues` 把计划拆成一家工单，`GraphsOf`、`GraphOf` 从核心状态里的工单拼回计划）、`task_changes.go`（两版计划比出经过和它的说法）、`dag.go`（边的规则，和 `engine` 共用）。工单状态怎么从计划算在 `issues.go` 的 `IssueStatusOf`。
- 表：计划和每一件存在 `issue`（`graph`、`task` 两列，`parent`、`blocked_by`）；经过存在 `task_event`；`engine` 的图存在 `task_graph`。
- 接口：`graph.*`（`split`、`updateTask`、`deleteTask`、`act`、`taskAct`、`changes`、`events`，[capabilities.md](docs/reference/capabilities.md)）；管家的工具 `graph_split`、`graphs`、`task_edit`、`graph_action`、`task_action`，帮工的工具 `issue_split`（都在 `tool/task.go`）。
- 帧：`StateFrame.Graphs` 是服务端拼好的计划，带分层（`layers`）、每件在等谁（`blockedBy`）、要不要主人看（`asksForYou`）、花了多少（`spent`）、做完几件（`settled`）和能做的动作。
- 客户端：计划板 `farm/task_board.dart`、`task_steps.dart`、`task_log.dart`；看板上计划是一张「计划：…」卡片（`workbench/issues`），子工单的标题前加计划名（`rules/issues.dart` 的 `issueTitle`）。

## 模型和不变量

- **计划是父工单，每一件是子工单。** 父工单的 id 是计划的 id：管家起的是 `p1`、`p2`……（`issue/rules.go` 的 `nextTaskID`），帮工拆的就是原来那张工单的 id。标题和说明是计划的标题和目标；父工单原来的编号、帮工（assignee）、优先级、验收标准和干活记录都留着，`GraphIssues` 不重写它们。`graph`（`IssueGraph`）存状态、计划分支、并行数、一句说明。子工单的 id 是 `<计划>.<件>`（`p1.api`，`TaskIssueID`），`parent` 指父工单，`blockedBy` 是它要等的子工单，标题和说明是这件的标题和工单，`task`（`IssueTask`）存其余：状态、检查命令、该改的地方（`scope`）、是不是验收、冻结的文件、谁在做、结论、提交、花费、重试和失败的次数。
- **一次写整家**：每写一次计划，`issue.PutTask` 在一个事务里写父工单和全部子工单，提交后一次施加（`ApplyBatch`），先子工单、后父工单；计划在核心状态里总是完整的。核心状态只留最近 50 家关了的工单时，只数没有父工单的，子工单跟着父工单留、跟着父工单走。
- **计划的状态**：`splitting`、`draft`、`running`、`paused`、`ripe`、`done`、`abandoned`。**每一件**：`waiting`、`working`、`merged`、`failed`、`skipped`；`merged`、`skipped` 算定下了，等它的件能开工。
- **工单的状态跟着计划算**，不另存：父工单在拆、在做是 `in_progress`，草稿、暂停、熟了是 `in_review`，收了关成 `merged`、放弃了关成 `dismissed`。子工单等着是 `backlog`，帮工在干是 `in_progress`，帮工停着或没做成是 `in_review`，合进去了关成 `merged_into_graph`，跳过或计划结束了关成 `dismissed`。
- **计划里的工单跟着计划走**：看板不能改、开工、重开、收获它们（`moves` 是空的）；帮工离开不关它们；帮工的收获工具对计划里的帮工拒绝（「做完会自动合进计划分支」）。
- **校验**（`GraphProblems`）：至少一件、最多 12 件（`MaxTasks`）；id 是 1–32 位英文、数字、`_`、`-`，不重复；每件有工单；不等自己、不等不存在的、不成圈；验收件要有检查命令。
- **能改什么**（`CanEditTask`）：草稿什么都能改、能加能删；开工以后（`running`、`paused`）只能改、加还没开始或没做成的件，没做成的不能删、只能跳过；做完的不重开，要返工就加一件。
- **能做的动作**（`GraphActions`、`TaskActions`）由服务端算好放在帧上：草稿且校验通过能开工；在做能暂停；暂停能继续；熟了且有分支能收获；没关的能放弃。在做或暂停时，没做成的件能重试，等着的和没做成的能跳过。
- **一次只做一件事**：一把锁把帮工的一轮结束和主人按按钮排成一个一个来，不会两边读同一份计划互相覆盖。
- **计划只经 `put` 写**：每写一次和写之前比（`GraphChanges`），变了什么记一行经过，带是谁（主人、管家、帮工、农场）和为什么；经过写不进去只记日志，不挡计划。

## 怎么走

**拆**（`graph.split`、`graph_split`）：

1. 要有目标和项目；`ChooseAgent` 按「规划 计划 拆分 + 目标」挑一个能用的档案，挑不到就拒绝。
2. 写一张 `splitting` 的计划，派规划的帮工（`SplitBrief`：只读不改，最后用一个 json 代码块给出计划），它是父工单的一次干活。派不出去，计划放弃，说明为什么。
3. 汇报来了，`parseSplit` 从最后一个读得了的 json 代码块读计划并校验。合格就成草稿，帮工收工，告诉管家拆成了哪几步。
4. 不合格或这一轮出错，把问题列给它重给一次；还不行就放弃（`giveUp`）。规划被叫停、帮工被请走，也放弃。

**帮工拆自己的工单**（`issue_split`，`SplitIssue`）：活一般先作为普通工单派给一个帮工，它读完代码才知道大。它调 `issue_split` 给出各步（和规划师的 json 同形），这张工单就地变成计划的父工单，直接开工：

1. 只有这张工单最后派出去的帮工能拆，工单要开着、不是计划或计划的一步、不是派给管家的、帮工不在起草、有项目、帮工有自己的分支（`issueSplitRefusal`）；步骤照 `GraphProblems` 校验，问题列回给它改。
2. 计划分支从这个帮工的分支顶上开（`OpenBranch` 的起点），拆之前提交的东西是每一步的起点，没提交的不带过去；帮工自己的 worktree 不动。
3. 计划直接 `running`、马上调度，经过记成「帮工」做的；告诉管家拆成了哪几步。
4. 工具的回答叫帮工别再改代码、汇报完就结束；这一轮汇报来了，`task` 看到它不是任何一步的帮工、它的工单已是计划，请它收工。工单的「帮工走了就关」本来就跳过计划，父工单不会被关。

**开工**（`start`）：从主分支开一条计划分支 `vibevalley/task-<id>-<毫秒时间的 36 进制>`，计划进 `running`，开始调度。分支开了而状态没存下，错误里说明分支已创建。

**调度**（`schedule`；开工、继续、某件做完或离开、重试、跳过、开机时都跑）：

1. `startable`：等的都定下了的件，在计划的并行数（`DefaultParallel` = 3）减去在做的件数以内。
2. 每件按它写的档案或 `ChooseAgent` 挑帮工，从计划分支开 worktree，交给它 `taskBrief`：计划的目标、这件的工单、只改哪些地方、前面每件的结论和提交、要跑的检查、验收和冻结的提示。帮工是这张子工单的一次干活。
3. 派不出去（没有能用的档案、地满了）就先等着，计划的说明写「「…」先等着：…」，下次调度再试。

**一件做完**（帮工的汇报，`taskEnded`）：

1. 这一轮失败：退回去再做（`sendBack`）。叫停：计划暂停，「点继续接着做」。
2. 做成了，农场在它的 worktree 里验证（`verified`），不信帮工自己说的：
   - 验收件：跑它的检查命令，**这时要不通过**；通过了就退回（「它没抓住要修的问题」）。不通过就算做成，它改的文件记成冻结。
   - 别的件：改了前面验收冻结的文件就退回；再跑自己的检查命令；收尾的一件（没有件等它的）还要跑它上游已合进去的验收的检查，都要通过。检查在 worktree 根目录用 `sh -c` 跑，10 分钟超时，输出留最后 3000 个字符附在退回的话里。
3. 过了就合进计划分支（`session.MergeInto`，不动任何检出）：合之前替它提交没提交的改动、查冲突、跑项目的 `.vibevalley/check`，进锁后核对分支没变、再查一次冲突，只从原来的位置快进或加一个合并提交。合进去后删掉它的分支和 worktree，帮工收工，这件记成 `merged`，带结论、提交号和花费。清理没成功时保留合并结果、发提醒，不要求重合。
4. 会冲突就把 `ConflictBrief` 交回它，让它把计划分支合进自己的分支解决，下一轮再试；`.vibevalley/check` 没过就带着原因退回。合进去了而完成状态没存下，错误里说明分支已合并，真实的 git 结果保留。
5. 全部定下了，计划熟了（`ripe`），告诉管家做成了什么、等主人收获。

**没做成**：一轮失败、检查没过、验收现在就通过、改了冻结的文件，农场自己让它重来，最多 2 次（`AutoRetries`）；再不行这件停在 `failed`，告诉管家，等主人重试、改工单或跳过，不相干的件照做。规划以外的帮工被请走（地满了、主人请走）时，它那件直接 `failed`。

**重试**：帮工还在且闲着，就在同一个帮工里接着做（带上可能改过的工单），重试次数清零；否则退回等着，重新调度。**跳过**：在做的要先叫停；跳过后全部定下了就熟了；有帮工的请它收工。

**暂停、继续**：暂停后正在做的做完，不开新的。继续时，在做的件帮工没了就退回等着，帮工已经交回来的当作做完去验证，帮工停着的让它「接着把这一步做完」，然后调度。

**收获**（`merge`）：只有熟了的计划能收。`project.MergeBranch` 先查冲突，会冲突就不合，说明「主分支在这期间变了」，计划分支留着；不冲突就合进项目克隆的主分支，删掉计划分支（删不掉就在回话里说改动已合并、分支未清理）。父工单关成 `merged`。合进去了而状态没存下，错误里说明分支已合进主分支。

**放弃**（`abandon`）：先保存，再请规划的帮工和在做的帮工收工；在做的件退回等着，分支都留着。

**保存失败**：计划的动作返回错误，不答复成功、不继续叫醒或派下一步；自动推进（帮工交回、离开时）失败发一条提醒。

**重启**：开机时停在 `splitting` 的计划放弃（「规划停在了半路：再说一遍要做什么」），请规划的帮工收工；有件在做的 `running` 计划暂停（「点继续接着做」）；其余 `running` 的照常调度。

**告诉管家**：计划里帮工的汇报不转给管家（`ForTask` 的汇报不投给它）；只有拆好、没拆成、某件没做成、全部做完时，计划经 `News()` 在田头告诉管家一句「【种植计划】…」。

## 和谁打交道

- **工单（`issue`）**：`PutTask` 写整家工单，`NextTaskID` 给下一个计划号，`Hire` 派帮工（查档案、地满没满）；工单服务的转换表不管计划里的工单（[工单](docs/subsystems/issue.md)）。
- **帮工（`session`）**：派规划的、做件的帮工，`Tell` 带话（触发是 `RunTrigger{kind: task}`），`Dismiss` 请走，`MergeInto` 在收获动作里停住写入、合并、离场；正在干或有待开始的一轮时不能合。计划听核心状态的事实：`FactReport`（一轮结束）和 `FactLeft`（帮工离开）。
- **项目（`project`）**：`OpenBranch`、`MergeBranch`、`BranchChanges`（`graph.changes` 的收成清单）、`ChangedFiles`（冻结文件的判断）、`Run`（检查命令）。
- **管家（`manager`、`tool`）**：五个工具起头、看、改、动作；`News()` 的话进管家的输入（来源 `graph`）；`situation.go` 把开着的计划写进农场现状。
- **田头（`channel`）**：计划里帮工的汇报标 `ForTask`，不投给管家。
- **Inbox（`protocol/inbox.go`）**：没做成的件是一条 `task-failed`，巡查过了宽限期叫醒管家（[管家](docs/subsystems/manager.md)）。
- **游戏（`game`）**：收获一个计划记一条账，金币 `30 + 10 × 合进去的件数`，件数到档位给成就（[farm-ui.md](docs/reference/farm-ui.md)「金币」）。

## agent 自己的任务图

`task/engine` 是 VibeValley 自己的 agent（`agent/brain`）在会话里给自己记的图：每件写明做什么（`brief`）、等哪几件（`after`）、谁做（`self` 或交给帮手的 `helper`）、状态（`waiting`、`working`、`done`、`failed`、`skipped`）和结果。

- 一张图最多 30 件（`engine.MaxTasks`）；`Add` 整批收或整批不收，回给模型的问题说清是哪一条；`Update` 只让没开始和没做成的改正文和先后。交给帮手的件失败后重来 1 次（`Retries`）；叫回或进程没了，在做的退回等着（`Requeue`）。
- 存储（`Store`）是一个主人没做完的那张图：`DBStore` 存在表 `task_graph`，按会话 id 分开，做完的盖上 `finished_at` 留着；`MemoryStore` 给命令行，进程退出就没了。服务端给农机 `vibevalley` 的每个会话一个 `DBStore`（`runtime.Registry`）。
- 它不进工单、不进核心状态、没有分支和检查，和种植计划不相通；细节在 [engine 的 README](server/internal/task/engine/README.md)。

## 为什么这样

- **长活拆成一张图，交给不同的帮工。** 一个会话从头做到尾，上下文越拉越长、越做越差，中途失败整轮重来；互不依赖的部分没法并行，也没法按长处分给不同的档案。放弃了让管家在对话里一单一单地派：进度只在便宜模型的上下文里，十几步跟不住，重启就丢，每一步调度还花一次模型调用。拆图要模型，调度不要。
- **拆交给在项目里读代码的帮工，不让管家拆。** 管家不读代码，拆出来的件对不上现有的结构；管家只负责起头和转告。
- **帮工能就地拆自己的工单，拆完直接开工。** 活大不大，往往要读完代码才知道；放弃了让它在汇报里请主人另开计划：一件事变成两张东西，工单串接不上。它拆得比管家准，所以不等主人点头，主人随时能暂停、改步骤、放弃。用工具调用，不解析汇报里的 json：普通帮工的汇报是写给主人看的，工具调用是明确的意图，当场能告诉它哪里不对。计划另开一条分支、不用帮工的分支：每一步要合回计划分支，而帮工的 worktree 正检出着自己的分支。
- **不交给农机自己的子 agent 或工作流**（claude 的 workflow、codex 的子线程）。整件事在一个会话里，农场看不见每一件，只能用一种农机，也没法给每件单独的分支、检查和合并。
- **计划分支挡在主分支前面。** 每件做完直接进主分支，主分支上会出现做了一半的功能，并行的件在主分支上互相冲突；每件都要主人点，主人要审十几次。中间的合并自动做，主分支只在收获时变一次。也没选所有件在同一个分支、同一个 worktree 上排队：没有并行，分不清哪个提交属于哪一件。
- **每件做完由农场跑检查，不等人验收。** 每件等人会让并行停下来；人在收获整张计划时看一次。检查由农场跑，不信帮工自己说的。
- **先写会失败的验收，再冻结它。** 验收做完时检查要不通过，证明它抓住了问题；冻结以后，后面的件不能靠改测试过关，收尾的一件要让它通过。
- **计划是带子工单的父工单。** 放弃了计划留在核心状态、工单只记它属于哪个计划：同一件事两份，计划节点的状态和那一件的工单各记一份，得靠代码保持一致；看板上同一件事有计划卡、拆计划的工单、每件一张工单几个样子。
- **规则仍按整张计划算，读写时拆拼。** 把计划的规则改成按工单写，要重写全部规则、测试和黄金数据，换来的只是少一次拼装；拼装是纯函数，两头都测。
- **子工单的 id 是 `<计划>.<件>`。** 用新的随机 id，计划的规则、管家的工具、计划板都用件的 id（`api`），每次都要查一遍对应；`p1.api` 一眼看得出是哪个计划的哪一件。
- **经过由比较得出。** 每次写计划时和写之前比，不靠每个写的地方自己记，漏不掉；事实里仍是整个计划的快照，经过另存，回答「这一件怎么走到这里的、工单被谁改过」。
- **服务端按图派，不让帮工自己认领。** 照 Raft 让帮工从任务板上认领，适合一群常驻、都看得到任务板的 agent；VibeValley 的帮工是按件新开的会话，一件只会有一个帮工，认领要多一套「谁有空、该不该领」的规矩和一份花钱的轮询。也不照 Raft 的工作流做成一条线：长活里互不依赖的部分只能排着做。
- **不以仓库里的计划文件为准。** 正在跑的状态（谁在做、做到哪）属于农场的核心状态，放两处就会对不上。
- **不互相依赖的件要改不同的文件，靠 `scope` 提醒、不强制。** 同时做的件改了同一个文件，合并时冲突，多一轮让它解决；件之间的约定只靠结论里的文字传，所以规划的规矩要求最后一件做整体验证。

## 还没做的

- 种植计划和 agent 自己的任务图合成一个 Task：一份图的规则、一个推进的引擎，执行者和存储可换；开工要主人点头写进代码：[Task：一张按 DAG 推进的活](.agents/notes/proposed/architecture/2026-10-18-tasks-are-dags.md)。
- 先采样几份再验证、挑一份：[先采样再验证](.agents/notes/proposed/architecture/2026-10-14-sample-then-verify.md)。
- 还没有提案的：审查步骤、计划模板、半路重新规划、跨项目的计划、计划分支冲突时派帮工解决、计划自己的串。

## 怎么验证

- `task/task_test.go`（脚本扮演帮工、真的 git 仓库）：`TestTaskDiamond`（b、c 同时做，d 在两者合进去后开工并看得到它们的文件，收获前主分支不变，经过按顺序记下谁做的）、`TestTaskAcceptanceFirst`、`TestGraphFailingTask`（失败两次后停下、不相干的照做、跳过后开工、放弃后分支留着）、`TestTaskSentBackOnce`、`TestTaskRestart`（重启后暂停、继续后做完）、`TestTaskChooseAgent`、`TestTaskIsAParentIssue`（父工单和子工单、看板不能改和开工和重开、做完关成 `merged_into_graph`、收获后父工单关成 `merged`）。
- `task/persistence_test.go` 的 `TestFailedTaskCommitStopsActions`：保存失败时不答复成功、不叫醒、不派下一件。`task/log_test.go` 的 `TestTaskLog`。
- `task/rules_test.go`：`TestReadyAndStartable`、`TestParseTask`、`TestEditNode`、`TestNodeTask`；`TestRulesGolden` 用 `testdata` 的黄金数据。
- `protocol/task_rules_test.go`：`TestTaskProblems`、`TestLayersOf`、`TestTaskAsIssues`（拆成工单再拼回来不变、各张工单的状态）、`TestClosedGraphsGoWithTheirTasks`、`TestTaskChanges`、`TestTaskEventText`。
- `issue/rules_test.go` 的 `TestNextTaskID`；`workspace/work_test.go` 的 `TestIssueKnowsItsTask`；`game/progress_test.go` 的 `TestTaskHarvested`。
- `task/engine/task_test.go`：收、拒、状态的变化、帮手的几步、给模型看的文字，和两种存储（`TestTheStoreKeepsTheGraphAndPutsAFinishedOneAway`、`TestOneOwnersGraphIsNotAnothers`）。
- 客户端：`app/test/farm/task_board_test.dart`（草稿的分列、开工、改一件、经过、拆、熟了看改动再收获）、`app/test/workbench/issues_test.dart`（计划是一张卡）。
