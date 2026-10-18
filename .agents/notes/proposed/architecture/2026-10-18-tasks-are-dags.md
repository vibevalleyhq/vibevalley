# Agent Note: Task：一张按 DAG 推进的活，agent 自己的步骤和种植计划都是它

Status: proposed

## Problem

「一件活拆成几件，有先后，前面的做完后面的才开始」在 VibeValley 里有两处要用，现在一处没有、一处自己写了一套：

- **VibeValley 自己的 agent（`internal/agent/brain`：管家、农机 `vibevalley`、命令行都用它）没有。** 它只有 `spawn_agent`（`brain/subagent.go`）：同步派一个帮手，这一步要等帮手做完才返回；帮手之间没有先后；什么也不存，压缩后自己都忘了派过什么，重启就全没了。模型在回答里写「第一步……第二步……」，压缩会压掉；哪步做完了、哪步失败了没处查；一轮停下以后没人提醒它还有能做的。
- **种植计划（`internal/task`）自己写了一套。** 查环、分层、算 ready 在 `protocol/task_rules.go`（`TaskProblems`、`LayersOf`、`ReadyNodes`、`BlockedBy`），状态机、重试、跳过、并行上限在 `task` 包；数据却存成父子工单，每次先用 `taskFrom` 拼成一张计划、改完再用 `TaskIssues` 拆回去（`protocol/task_issues.go`）。开工要主人点头只写在工具说明里，代码里只有收获查了。

两处要的是同一件东西：一张图、一套状态、一个推进的办法；不同的只是一件事由谁做、图存在哪、做完以后还要干什么。

## Proposal

**Task 是一张按 DAG 推进的活：节点是一件事，边是「等这几件做完或跳过」。图的规则只有一份，推进只有一个引擎；一件事由谁做（执行者）、图存在哪（存储）可以换。agent 自己的步骤是 Task，种植计划也是 Task。**

### 1. 放在哪

| 在哪 | 管什么 |
|---|---|
| `protocol/dag.go` | 图的纯规则：id 的写法、重复、等自己、等不存在的、成圈、分层（`DagProblems`、`DagLayers`）。种植计划要在帧里画图（`Task.Layers`），所以它照「几个包都用的规则放 protocol」在这里 |
| `internal/task/engine` | 引擎：Task 的形状、状态怎么变、ready、做完收起来、存储；以后还有执行者和推进 |
| `internal/agent/brain` | VibeValley 自己的 agent，原来的 `pkg/agent`（2026-10-18 挪进来）：把 Task 的工具交给模型，以后在一轮停下、帮手做完时推进 |
| `internal/task` | 种植计划特有的：派帮工拆、开工和收获的闸门、每步做完跑检查、合进计划分支（迁移以后） |

`pkg/agent` 挪进 `internal/agent/brain`：Task 要和档案、工单、种植计划一起长，agent 不再当成一个能单独拿走的库；不认识农场的底层（`pkg/agentcore` 的循环、`pkg/ai` 的模型）还在 `pkg`。

### 2. 形状

```go
type Task struct {
	ID     string   // the model's own short id: "read", "fix-auth"
	Title  string
	Brief  string   // what to do, where, what counts as done, what to report
	After  []string // ids that must be done or skipped first
	By     By       // self | helper (| farm, for a task on the farm's issues)
	State  State    // waiting | working | done | failed | skipped
	Result string
	Tries  int
}
```

- ready 不存：`waiting`、等的都 `done` 或 `skipped`。
- 加节点整批收或整批不收（`Add`），问题说清是哪条；做完的不能退回，没开始和没做成的能改正文和先后（`Update`）；全部做完或跳过就收起来（`Finished`）。

### 3. 执行者：一件事由谁做

| `By` | 谁 | 做完 |
|---|---|---|
| `self` | agent 自己 | 模型用 `task_update` 标上，写结果 |
| `helper` | 进程里的帮手（现在 `spawn_agent` 的那种：同样的工具，不能再派，不存对话） | 运行时写结果，作为一条输入交回 agent |
| `farm` | 农场的帮工：开一张子工单、一个 Session | 工单的状态就是它的状态；种植计划的宿主跑检查、合进计划分支以后才算 `done` |

### 4. 存储：图存在哪

| 用在 | 存在 |
|---|---|
| agent 自己的步骤 | 农场的库：表 `task_graph`（归 `internal/agent`），一个主人（会话 id，或管家）一张打开的图，一张图一个 uuidv7，做完的盖上 `finished_at` 留着；命令行不开库，给内存里的存储 |
| 种植计划 | 工单表：Task 是父工单，`farm` 节点是子工单，边是 `blockedBy`。不再有 `Task` 这第二种表示 |

### 5. agent 自己的步骤（第一阶段）

照 [Hermes Agent](https://github.com/nousresearch/hermes-agent)（2026-06-11 的 `db7714d`）的 `todo`、`delegate_task` 和 Kanban 各取一部分：

- **工具**：`task_add`（写图或往图里加）、`task_update`（改一件）、`task_graph`（看全图）；每次调用回整张图（Hermes `todo`）。
- **帮手**：ready 的 `helper` 节点自动派，后台并行跑，最多 `MaxHelpers`（默认 3），帮手不能再派；失败重试一次；做完的结果交回 agent，agent 闲着就开一轮，忙着就排到这一轮之后（Hermes `delegate_task`，但不同步等）。agent 被叫停时帮手一起停，节点退回 `waiting`；有帮手在跑时新来的话不打断这一轮，和 [编排层](.agents/notes/proposed/architecture/2026-10-18-one-mailbox-per-agent.md) 同一条规则。
- **提醒**：一轮停下时还有 ready 的 `self` 节点、又没有别的输入，提醒一次；图连续 `MaxNudges`（默认 3）次没变就不再提醒。不用另一个模型判断做没做完（Hermes `judge_goal` 不取）。
- **看得见**：图不进系统提示（[提示开头不变](docs/subsystems/manager.md)）。模型每次调任务工具、每个帮手交回都拿到整张图，所以不另拼变化；压缩时把打开的图接在摘要后面，被压掉的那几轮里的图由它接上；`brain` 发 `TasksChanged` 事件，`oarruntime` 写成原始记录里的一帧，帮工的轨迹里看得到。
- **谁开**：农机 `vibevalley` 和命令行；管家先不开（开了要改它的工具，要重放评测），以后只开 `self`，派活仍用 `dispatch`。

### 6. 种植计划并进 Task（第二阶段）

种植计划就是一张按 DAG 推进的 Task 图（`TaskGraph`）：节点就是 Task（每件一张子工单、一个帮工），边是工单的 `blockedBy`；图本身挂在父工单上，带目标、计划分支、并行上限、开工和收获的闸门。没有「步骤」这第三个概念：图里的一件就是一个 Task，和 agent 自己的图（引擎的 `Task`、表 `task_graph`）用同一个词。

- **一个模块**：`internal/task` 是种植计划的服务（拆、闸门、检查、合进计划分支、经过），引擎在它的子包 `internal/task/engine`。引擎不依赖农场，`brain` 只引子包；服务要用工单、Session、项目，所以两者不能是同一个 Go 包（会成环），但在同一个目录、同一个名字下。
- **不再有 playbook、plan、step 这些词**：容器叫 graph（`TaskGraph`、`graph.*`、`GraphState`……），节点叫 task，把一件活拆开叫 split。界面上还叫种植计划，每件叫「一件」或「一步」。`scripts/stale-names.ts` 查旧名字回不来。
- **还要做的**：种植计划的调度、状态机和重试改走引擎（`farm` 执行者、工单做存储）；之后去掉 `protocol` 里从父子工单拼回 `TaskGraph` 的那一层（`GraphIssues`、`graphFrom`）和 `Session.Graph` 这个标记（帮工挂在哪张子工单上，`parent` 就说明了属于哪张图）。

### 做的顺序

1. 位置和底子：`pkg/agent` → `internal/agent/brain`；`protocol/dag.go`；引擎的形状、规则、存储；`brain` 的工具；农机 `vibevalley` 和命令行打开。（已做）
2. `helper` 执行者；存储进 SQLite。（已做）
3. 提醒、压缩后给全图、`TasksChanged`。（已做）
4. 文字字段改名（`brief`）。（已做）
5. 种植计划改名、并进 `internal/task`、去掉 playbook、plan、step 的说法、表结构并成一个基线。（已做）
6. 种植计划的调度和状态改走引擎，去掉拼回的那一层。

### 做到哪了

第 1–3 步 2026-10-18 做了：`pkg/agent` 和 `oarruntime` 挪进 `internal/agent/brain`（挪进来以后 deadcode 查出 6 个只靠测试活着的函数，删了或挪进测试）；`protocol/dag.go` 有 `DagNode`、`DagProblems`、`DagLayers`、`DagIDValid`，种植计划的查环、分层改成调它；引擎（现在的 `internal/task/engine`）有 `Task`、`Add`、`Update`、`Ready`、`Finished`、`Text`、`Begin`、`Settle`、`Requeue` 和存储接口 `Store`（`DBStore` 存表 `task_graph`，`MemoryStore` 给命令行）；`brain` 给模型 `task_add`、`task_update`、`task_graph` 三个工具，`taskrun.go` 后台派帮手、交回结果、叫停时叫回、开机退回再派，一轮停下时提醒，压缩的摘要接上打开的图，图每变一次发 `TasksChanged`；农机 `vibevalley` 每个会话（按 oar 会话 id）一张图，`cmd/vibevalley` 自己的对话给内存的。

第 4、5 步同一天做了：
- 文字字段：`Session.Task` → `Session.Brief`（表 `session.brief`），每件的工单文字、`FactRun` 的、`dispatch` 和 `task_edit` 的参数、拆活时帮工交回的 JSON（`tasks`、`brief`）、`spawn_agent` 的参数都叫 `brief`；冲突时给帮工的那段话叫 `ConflictBrief`。
- 协议：容器 `TaskGraph`（`GraphState`：`splitting`、`draft`、`running`、`paused`、`ripe`、`done`、`abandoned`；`GraphAction`、`GraphEvent`（每件的事件是 `task_*`）、`GraphActor`、`IssueGraph`（`Issue.Graph`）、`SessionGraph`（`Session.Graph`）、`StateFrame.Graphs`），节点 `Task`（`TaskState`、`TaskAction`、`TaskEdit`、`IssueTask`（`Issue.Task`））；接口 `graph.split`、`graph.updateTask`、`graph.deleteTask`、`graph.act`、`graph.taskAct`、`graph.changes`、`graph.events`，路径 `/api/v1/graphs…`；频道主题、投递原因、管家输入的来源是 `graph`，关上的理由 `merged_into_graph`，Inbox 的 `graph-draft`、`graph-ripe`、`task-failed`；成就 `s_split`、`big_graph`、`parallel_graph`，账本的 `graph`、`split`。账号额度里原来叫 plan 的套餐改叫 `Subscription`。
- 管家的工具：`graph_split`（派帮工拆）、`graphs`、`task_edit`、`graph_action`、`task_action`（单件重试、跳过）；`graph_action start` 和 `merge` 一样，这一轮不是主人叫的就不动手（`tool/words.go` 的 `startNotAsked`）。agent 自己的三个工具是 `task_add`、`task_update`、`task_graph`。
- 包：`internal/playbook` → `internal/task`（`task.Service`，`Workspace.Task`），引擎 `internal/agent/task` → `internal/task/engine`；Flutter 的面板 `FarmPanel.taskBoard`、`TaskBoard`、`task_board.dart`、`task_steps.dart`、`task_log.dart`，贴图 `icon-task-board` 和三张徽章跟着改名，`village.ldtk` 里院子的那个点叫 `taskBoard`；分支 `vibevalley/task-<id>-<时间>`；`pb` 这样的缩写改成 `graph`、`task`（按类型改的，不是按字面）。
- 表结构：`0002`–`0006` 并进 `0001_schema.sql`（`issue.graph`、`issue.task`、`session.brief`、`session.graph`、`task_event` 的 `graph_id`、`task_id`、`task_graph`……），旧库作废（AGENTS.md「不留兼容」，[只有一份表结构](docs/subsystems/foundation.md)）。

第 6 步还没做。

## Alternatives considered

**agent 的 Task 和种植计划各写一套。** 本篇上一版是这样：agent 的放在 agent 库里，种植计划不动。不选：查环、分层、ready、状态、重试两边一模一样，两份迟早不一样；种植计划自己那套又正是要改的。

**引擎放在 `pkg`（`pkg/agent/task`），agent 留在 `pkg`。** agent 能单独拿走；但 Task 要接工单、Session、种植计划的闸门，放在 `pkg` 就只能靠宿主把这些一样样注进来，接口越长越像业务。agent 的底层（循环、模型）留在 `pkg` 就够单独用了。

**图的规则也放进引擎包，不放 `protocol`。** 概念上更集中；但种植计划的帧要分层画图，帧在 `protocol` 里折，`protocol` 不能 import 上面的包。规则放 `protocol`，引擎和帧都调它。

**照 Hermes 只要 `todo`。** 最简单；但没有先后，交给帮手的不能自动派，结果也不交回来。

**图放进对话里，不另存。** 压缩会压掉，重启要从对话里重新解析，改一个节点要重写整段。

**agent 的图存成家目录的文件（`tasks.json`）。** 第 1 步先这样做过：照 `schedules.json`，命令行没开服务端也能用。主人改成 SQLite：农场的东西都在一个库里，查得到、跟会话关联、以后能在农场里画出来，不再多一种文件；命令行不开库，给它内存里的存储，图只活在那一次对话里。

## Acceptance criteria

- 第一阶段：模型写一张三件、有先后的图，库里（`task_graph`）有它；成环、重复、等不存在的整批被拒；做完一件下一件变成可以做；全部做完图收起来。`helper` 节点自动派、并行不超过上限、结果交回；叫停时帮手一起停；提醒有次数上限；系统提示的哈希不因图变化而变。`go test ./internal/agent/...` 覆盖，模型用 `ai.FauxProvider`。
- 第二阶段：代码里没有 playbook、plan（`stale-names` 查）；`protocol` 里没有从父子工单拼回 `TaskGraph` 的那一层；种植计划的 ready、状态、重试走引擎；开工和收获不是主人说的就不动手，有测试；照 `verify-server` 用 `vibevalley task …` 建一个三步、有先后的种植计划，第二步等第一步合进去才开工；`verify-manager-evals` 重放通过（要花钱，先问主人）。
- `go vet ./... && go test ./...`、`bun run go:deadcode` 通过。

## Risks

- 后台帮手花钱：一张图可能同时开三个帮手、每个最多 30 步。并行上限默认小，花费算进 agent 的 `Progress()`。
- 提醒可能让 agent 在做不下去的步骤上空转：有次数上限，模型也能把它标 `failed` 或 `skipped`。
- 种植计划迁移时要守住现有语义：验收步、冻结文件、合进计划分支才算做完、开机时把在跑的计划转成暂停；这些作为种植计划宿主的钩子，不塞进引擎。
- `brain` 挪进 `internal` 以后受 deadcode 管，只给测试用的帮手函数要放进测试文件。
