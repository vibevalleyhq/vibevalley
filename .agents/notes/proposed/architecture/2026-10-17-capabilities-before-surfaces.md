# Agent Note: 先有能力，再有入口：一张能力表，接口、命令行、管家、帮工都从它来

Status: proposed

## Problem

农场能做的事（派活、合并、开频道、定时、记忆……）现在从七个入口进来，每个入口各自接一遍：

| 入口 | 谁用 | 能做的事从哪来 |
|---|---|---|
| HTTP 接口 | Flutter、院门后的设备 | `protocol/api.go` 的 86 个 `//vibevalley:route`，shapegen 生成，handler 一个方法转给一个服务 |
| 管家的工具 | 管家（DeepSeek） | `manager/tools.go` 手写的 21 个，再加 `internal/agent/brain` 自带的 `remember`、`rewrite_memory`、`search_archive`、`load_skill` |
| MCP | 帮工（Claude Code、Codex、pi……） | `mcp/mcp.go` 手写的 4 个：`channel_say`、`channel_read`、`channel_inbox`、`session_list` |
| 聊天软件、语音 | 主人在外面说话 | 不是工具：文字交给 `Manager.Say`，语音交给 `Manager.Call`，之后由管家的工具干活 |
| 院门 | 主人配对过的设备 | 整套 HTTP 接口，`gate.go` 里写死不放 `lan.*` 的管理 |
| 定时、计划 | 服务端自己 | 直接调服务（`issue/dispatch.go` 的 `scheduled`、`task.go` 的 `follow`） |
| 命令行 | 终端、脚本、编码 agent | **没有**。`cmd/vibevalley` 是另一个 agent 的对话程序，不连服务端 |

后果：

- **没有命令行**。主人在终端里、编码 agent 在 shell 里、验证 skill 里，要动农场只能手写 `curl`。
- **谁能做什么没有写在一处**。管家能派活、合并、定时，不能建项目、改档案、改设置；帮工只能在频道里说话，读不到自己的工单；院门放什么写死在 `gate.go`。这些是有意的还是没顾上，代码里看不出来。
- **同一件事，几个入口的规则不一样**：
  - 派活：写好的工单开工（`Issue.Start`）满了就排队；管家的 `dispatch` 直接调 `Issue.Hire`，满了就拒绝，工单在帮工开工的同时才补上（`issues.Ran`）。
  - 看改动：主人看（`Issue.Review`）算进游戏，管家看（`Issue.Changes`）不算。这个区别是对的，但靠两个入口各调一个方法维持，不是靠传进去的「谁在看」。
  - `POST /api/dispatch` 叫派活，其实是 `Manager.Heard`：把一句话交给管家，安静地处理。
- **接口里有没人调的**：Flutter 不调 `worker.activities`、`progress.carryCoins`，别的入口也不调。
- **加一个能力要接好几处**：服务、`api.go`、handler、Flutter、管家的工具（要不要）、MCP（要不要），漏了哪处也不报错。

## Proposal

**能力是第一位的，入口是皮。** 一个能力就是 `api.go` 里的一个操作（`group.op`，已经有方法、路径、请求和返回的形状）。给每个操作补上「谁能用」，各个入口从这张表生成或检查，不再各自手接。这和 [先有概念，再有皮](2026-10-15-concepts-first.md) 是一回事：服务端按概念分模块，入口只是把这些模块交给不同的人。

### 1. 能力表：在 api.go 里给每个操作写明谁能用

`//vibevalley:route` 旁边加一行 `//vibevalley:can`，列出能用它的人，取值是封闭的：

| 取值 | 是谁 | 从哪个入口 |
|---|---|---|
| `owner` | 主人在农场那台电脑上 | Flutter、命令行 |
| `remote` | 主人配对过的设备 | 院门 |
| `manager` | 管家 | 管家的工具 |
| `session` | 帮工（一个 Session） | 暂不用：Session 不调农场的接口（「帮工的子集」） |

`manager` 和 `session` 要去掉：`can` 只管农场往外给出哪些接口、给谁；agent 能调哪些工具写在档案的 `Can` 和工具表上，不经能力表，见 [管家是一份档案，只是能力多](2026-10-17-manager-is-an-agent.md) 第 3 节。

例：

```go
//vibevalley:route issue.start POST /api/issues/{id}/start
//vibevalley:can owner remote manager
IssueStart(ctx context.Context, pID string) (Dispatched, error)
```

- shapegen 读它，没写 `can` 的操作生成失败。
- 读的操作和写的操作不另外标：HTTP 方法已经说明了。
- 给模型看的工具不写在这里：模型的工具和接口不是一个形状，工具表在 `internal/tool`（[管家是一份档案，只是能力多](2026-10-17-manager-is-an-agent.md)）。

### 2. 入口从能力表来

| 入口 | 怎么来 | 这一步做什么 |
|---|---|---|
| HTTP | 和现在一样 | 不变 |
| 命令行 | shapegen 写出 Go 的 `protocol.Client`（实现同一个 `Handlers` 接口）和命令表 | 新增，见下面第 3 节 |
| 院门 | 只放 `can` 里有 `remote` 的操作 | 替掉 `gate.go` 里写死的 `lan.*` |
| 管家的工具 | 不从能力表来：和帮工共用 `internal/tool` 的工具表，按档案的 `Can` 放行 | 见 [管家是一份档案，只是能力多](2026-10-17-manager-is-an-agent.md) |
| MCP | 外部农机上的 Session 经它拿 `internal/tool` 的工具表，按档案的 `Can` 过滤 | 见 [管家是一份档案，只是能力多](2026-10-17-manager-is-an-agent.md) |
| 聊天软件、语音 | 不变：说话交给管家 | 以后可以加斜杠命令，一条命令对一个 `owner` 操作 |
| 定时、计划 | 不变：服务端自己调服务 | — |

管家的工具先只检查、不生成：它们的说明和参数是为模型调过的（`dispatch` 的参数是档案的名字和一句活，不是工单的 id），硬从接口生成会变差。检查已经能保证「表里写了管家能做，管家就真的能做」。

### 3. 命令行：接口的一张皮

全部命令见下面的「命令行清单」，名字是第 4 节改过之后的。

- 只当服务端的客户端：命令行经 HTTP 调服务端，不自己打开 `vibevalley.db`；核心状态只有一份，归服务端。
- 命令从命令表来：`vibevalley <组> <操作> [路径参数] [--json 请求体]`，例如 `vibevalley issue start tDS4CG8AX`。另加 `state`（一帧 `StateFrame`，`--watch` 一直跟着）和 `events`。
- 连哪个服务端：`--server`，或者 `VIBEVALLEY_SERVER`，默认 `http://127.0.0.1:8787`，和 Flutter 的 dart-define 同一个名字。
- 输出默认 JSON，给脚本和 agent 读；`--pretty` 给人看。
- 手写的只有几个组合动作，也建在 `Client` 上：`issue run <id>`（开工、等到「等你看」、打出改动）。
- 两类命令：**农场命令**从能力表生成、经 HTTP；**本机工具**直接用 smith、不经服务端：`runtime chat` 和 `oar`。命令表标明每条是哪一类，生成的文档也列出本机工具。
- `vibevalley runtime chat <runtime> [--model --resume <oar 会话 id> --cwd -p]`：和一个农机直接聊（claude、codex、kimi、pi、dsh……，和服务端同一份：`internal/runtime` 的 `Registry`），一轮一轮，干活时输入的话并进这一轮，Ctrl+C 停这一轮、空闲时再按退出。建在 smith 的 `oar.Session` 上；`oar run <runtime> <prompt>`（`pkg/smith/cli/run.go`）已经能跑一轮。我们自己的 agent 在注册表里就是农机 `vibevalley`，不带子命令的 `vibevalley` 是 `runtime chat vibevalley` 的简写，也就是现在 `cmd/vibevalley` 的对话。
- 直接聊不算农场的活：没有工单、目录随意，不进核心状态、轨迹和花费。帮工只在 `VIBEVALLEY_WORK_ROOT` 的 worktree 里开工，服务端只认挂在工单上的 Session；要进农场就是派活（`issue create`、`issue start`）。
- 带档案聊（人设、技能、MCP）以后是 `agent chat <id>`：档案经接口读，对话在本机跑。

### 4. 操作的语义：组、动词、职责

86 个操作按下面五条收敛成约 80 个。改名和 [Worker 改叫 Session](../../implemented/architecture/2026-10-17-worker-is-a-session.md) 一起做，路由只改一次。

1. **组是概念**：不用皮和传输层的叫法。`lan` 是院门的包 `gate`；`progress` 是 `internal/game`；频道的路径 `/api/chat/{id}/messages` 和 `/api/channels` 统一成 `channels`；`server.start`、`server.end` 管的是管家这条线（`CallState`）和请走全部帮工，不是服务端。
2. **动词一套**：`list`、`get`、`create`、`update`、`delete`；`save` 只给 id 由客户端定的整份写入（档案、技能、设置）；`check` 只校验不保存（现在三处都是）。领域动词只留给不是增删改查的：`start`、`merge`、`reopen`、`stop`、`resolve`、`task`、`pair`。现在同一件事有 `add`/`create`/`open`、`edit`/`update`、`remove`/`delete`、`find`/`get`。
3. **工单的生命周期挂在工单上**：合并关上工单、请走以 dismissed 关上工单，改的是工单的状态，现在却挂在 `/api/workers/{id}` 下。改成按工单 id，服务端找这张工单最新的 Session（重开一次多一个；旧的经 `trajectory` 看）。`session` 下只留管这一次会话的 `stop`（打断这一轮）。
4. **一个意图一个操作，不用布尔开关兼两件**：`issue.queue {queued}` 的 `true` 只有 `Issue.Start` 没空地时自己调（`dispatch.go:183`），Flutter 只传 `false`（「不排了」），所以换成 `issue.unqueue`，排队只经 `issue.start`。`schedule.toggle {enabled}` 并进 `schedule.update`，`lan.setOpen {open}` 是 `gate.update`。
5. **`update` 只改给出的字段，路径的 id 算数**：`issue.edit` 现在整张替换，没给的 `project`、`assignee` 清空、`priority` 回到 medium（`issue.go:246`）；`PUT /api/agents/{id}` 不看路径的 id，用请求体的（`handler/api.go:259`）。

| 现在 | 改成 | 依据 |
|---|---|---|
| `issue.find` / `add` / `edit` / `remove` | `issue.get` / `create` / `update` / `delete` | 2、5；`find` 读起来是按条件搜，`kubectl get`、`multica issue get` 都用 `get` |
| `issue.move`（路径 `/place`） | `issue.move`，路径 `/move` | 名字和路径一致 |
| `issue.queue {queued}` | `issue.unqueue` | 4 |
| `worker.merge` / `changes` / `resolve` | `issue.merge` / `changes` / `resolve` | 3；`changes` 带「谁在看」（见下面「一条规则」） |
| `worker.dismiss` | `issue.cancel` | 3 |
| `worker.tell {text, on}` | `issue.comment {text, on}` | 3；工单关上时拒绝，提示 `reopen` |
| `worker.stop` | `session.stop` | 只打断这一轮 |
| `worker.activities` | 删 | 和 `session.get(Session id)` 是同一份步骤（`handler/api.go:156`、`:168`），没人调 |
| `trajectory.list` / `find` | `session.list` / `get`，路径 `/api/sessions…` | 1、2：轨迹是一个 Session 的步骤，归 session |
| `issue.dispatch` | `manager.hear` | 实际是 `Manager.Heard`：交给管家一句话 |
| `channel.open` | `channel.create` | 2 |
| `channel.read {seq}` | `channel.markRead` | 实际是 `MarkRead`；`read` 读起来是读消息 |
| `channel.history`（`/api/chat/{id}/messages`） | 不变，路径 `/api/channels/{id}/messages` | 1 |
| `schedule.add` / `remove` / `toggle` | `schedule.create` / `delete` / `update`；补 `schedule.list` | 2、4；管家有 `list_schedules`，接口没有 |
| `agent.memories` / `remember` / `forget`、`manager.memories` / `remember` / `forget` | `memory.list` / `create` / `delete`，带 `agent`（档案 id 或 `manager`） | 6 个收成 3 个；管家本来是一个档案 id（`protocol.ManagerAgent`）；`ManagerMemory` 多出的部分要放进 `list` 的返回 |
| `agent.recall` | `memory.recall` | 预览的是记忆 |
| `manager.archive` / `archiveFile` | `manager.listArchive` / `getArchive` | 2；操作名只有一段，它也是 Dart 客户端的方法名 |
| `task.editNode` / `removeNode` | `task.updateNode` / `deleteNode` | 2 |
| `task.act`、`task.nodeAct` | 不变 | 动作是封闭的枚举（start、pause、resume、abandon、merge；retry、skip），一个操作加枚举比拆成七个清楚 |
| `progress.carryCoins` | 删，连同 `ledger.Carry` | 只有这个接口调 `Game.Carry`，Flutter 和别的入口都不调 |
| `progress.chooseTitle` | `game.chooseTitle` | 1 |
| `lan.*` | `gate.status` / `update` / `startPairing` / `stopPairing` / `answerPairing` / `deleteDevice` / `pair` / `me`，路径 `/api/gate…` | 1、4 |
| `server.start` | `manager.open` | 1；它只做 `Core.Open`：把管家这条线设成 live（`core.go:247`） |
| `server.end` | 删，连同 `Worker.DismissAll` | 只有调试命令调它（`debug_commands.dart:43`）；它把「挂断管家」和「请走全部帮工」两件事绑在一起 |
| `CallState` | `ManagerLine`，只留 `idle`、`live` | 服务端只设这两个（`handler/api.go:60`、`core.go:249`、`connector.go:545`）；`connecting`、`ending`、`error` 从没设过 |
| `agent.save` | 不变，路径的 id 和请求体的不一样时拒绝 | 5 |
| `agent.*`、`skill.*`、`project.*`、`runtime.*`、`setting.*`、`connector.*`、`voice.*`、`server.health` 的其余 | 不变 | 已经合这五条 |

**一条规则，差别传进服务**：

- 「谁在做」作为参数传进服务，像计划已经在用的 `protocol.TaskActor`：`Issue.Changes(id, by)` 由服务决定主人看算不算进游戏，去掉 `Review` 和 `Changes` 两个方法。
- 派活一条规则：管家的 `dispatch` 先写下工单，再走 `Issue.Start`，和主人派的一样排队；「满了先请走最久没干活的」留在 `Hire` 里，两条路都经过它。
- 每个操作至少有一个入口用它（Flutter 的生成客户端里有调用，或者 `can` 里有 `manager`、`session`），加一个检查。

### 5. 能力上的空缺

2026-10-17 主人让定，按「谁写的谁负责、主人要看得见」定：

| 能力 | 现在 | 定了 | 理由 |
|---|---|---|---|
| Session 读自己的工单、工单串 | 做不到，只能读频道 | 进的口子带进来：派活时带工单，投递时带串里它没看过的上文 | 帮工不知道工单写了什么就开工，是现在汇报跑题的来源之一 |
| Session 报「卡住了，要主人拿主意」 | 汇报里的 `NeedsYou` 进 Inbox | 已经有：出的口子做（[Session、Run、事件](2026-10-17-session-run-step.md)） |
| Session 记事 | 一轮结束时服务端记下这件活（`memory.Keep`）；VibeValley 自己的农机关着 `NoMemory` | 出的口子做，不给 Session 工具；`NoMemory` 保持 | 记忆归档案，任何农机都走同一条路 |
| 管家建项目、改设置、改农机 | 做不到 | 不给 | 主人的配置，管家改了主人不知道 |
| 管家建档案、改档案 | 做不到 | 改由 `hire` 能力给，建出来的停用、在频道里说一声 | 见 [管家是一份档案，只是能力多](2026-10-17-manager-is-an-agent.md) 第 5 节 |
| 管家看、改别的档案的记忆 | 只能记自己的 | 不给 | 档案的记忆由它自己的 Session 和主人写；派活时 `memory.recall` 已经自动挑给 Session |
| 院门后的设备管院门 | 不给 | 保持不给 | |

### 6. 能力表画成文档

shapegen 另写一份 `docs/reference/capabilities.md`：每个能力一行，列出它在哪几个入口、对应的命令行命令和管家工具。生成的，`go run ./tool/shapegen -check` 查它是不是最新，所以这张表总是对的。

### 做的顺序

1. `//vibevalley:can` 和 `//vibevalley:tool`，给全部操作都写上；生成能力表的文档；院门改成按 `remote` 放。（`can`、`protocol.Endpoints`、能力表、院门已做；85 个操作，不是 86；`tool` 不做了。）
2. 生成 `Client` 和命令表，做命令行；写 `verify-dispatch`，步骤就是命令行的几条命令，真的派一次活。（`protocol.Client`、`Endpoints` 带查询参数和请求体、`cmd/vibevalley` 的农场命令、`state`、`events`、`runtime chat`、`issue run <id>`（开工、等到等你看、打出改动；不要 `--wait`，它总是等）已做，`verify-server` 改用命令行；`verify-dispatch` 还没做：要真的派一次活。）
3. 第 4 节的改名和收敛，和 Worker 改叫 Session 一个改动做完（只改名、不改行为的那些已做：`get`、`create`、`update`、`delete`、`markRead`、`manager.hear`、`manager.open`、`gate.*`、`game.chooseTitle`、频道的路径；删掉没人调的 `worker.activities`、`progress.carryCoins`、`server.end` 已做；`issue.unqueue`、`schedule.update`、`schedule.list`、保存档案和技能时路径的 id 算数、`issue.update` 只改给出的字段（`IssueUpdate`，空的项目或档案是清掉）、记忆合成 `memory.*` 已做；工单的生命周期按工单 id（`issue.comment`、`changes`、`merge`、`resolve`、`cancel`，`session.stop`；`Issue.Latest` 找最新的帮工，`Changes(id, by)` 只把主人看的算进游戏）已做）；派活一个入口、`Changes` 带上「谁在看」、`update` 只改给出的字段。
4. 管家和帮工的工具不对能力表检查，由 [管家是一份档案，只是能力多](2026-10-17-manager-is-an-agent.md) 的工具表做。

## 命令行清单

草案，按第 4 节改名之后的操作列，一个操作一条生成的命令；另加两个不在 `Handlers` 里的 SSE（`/api/state`、`/api/events`）和几个手写的组合命令。第 6 节的 `docs/reference/capabilities.md` 生成后取代这份清单。

格式：`vibevalley <组> <操作> [路径参数…] [--查询参数] [--json 请求体 | 标准输入]`，默认输出 JSON。`can` 里 `owner` 每条都有，表里不写；`remote` 照院门现在的放行（除 `gate.*` 的管理都放）；「管家」「帮工」两列只标现在已有工具（✓ 后面是工具名）或第 5 节建议补的。

### 工单

| 命令 | 管家 | 帮工 | 备注 |
|---|---|---|---|
| `issue list` | | | |
| `issue get <id>` | | 补，只限自己的 | |
| `issue runs <id>` | | | |
| `issue create --json` | 补（管家派活先写工单） | | |
| `issue update <id> --json` | | | 只改给出的字段；开工后拒绝 |
| `issue delete <id>` | | | |
| `issue move <id> --before <id>` | | | 看板上的先后 |
| `issue start <id>` | ✓ 现在是 `dispatch` → `Hire` | | 满了排队 |
| `issue unqueue <id>` | | | 退回待办 |
| `issue comment <id> --json` | ✓ `tell` | | 给最新的 Session 带话；`on` 是评论哪一步 |
| `issue changes <id>` | ✓ `changes` | | 带「谁在看」 |
| `issue merge <id>` | ✓ `merge` | | |
| `issue resolve <id>` | | | 让 Session 解决冲突 |
| `issue cancel <id>` | ✓ `dismiss` | | 请走，工单以 dismissed 关上 |
| `issue reopen <id> --json` | | | 带一句话开一个新的 Session |
| `session stop <id>` | ✓ `stop` | | 打断这一轮 |
| `session list [--agent]` | | | |
| `session get <id>` | | | Session 或管家的全部步骤 |

### 频道和管家

| 命令 | 管家 | 帮工 | 备注 |
|---|---|---|---|
| `channel say --json` | | ≈ `channel_say` | 以主人的身份说，管家会回 |
| `channel create --json` | ✓ `open_channel` | | |
| `channel update <id> --json` | ✓ `channel_settings` | | |
| `channel history <id> [--before --limit]` | ✓ `read_chat` | ≈ `channel_read`，只限自己的串 | |
| `channel mark-read <id> --json` | | | |
| `manager hear "<话>"` | | | |
| `manager open` | | | 把管家这条线设成 live |
| `manager list-archive [--q]` | ✓ `search_archive` | | |
| `manager get-archive <name>` | | | |

### 记忆

| 命令 | 管家 | 备注 |
|---|---|---|
| `memory list --agent <id 或 manager>` | | |
| `memory create --agent <id 或 manager> --json` | ✓ `remember`（只记自己的） | 管家替档案记，待定 |
| `memory delete --agent <id 或 manager> <memory>` | | |
| `memory recall --agent <id> [--project --text]` | | 下回开工会想起什么 |

### 计划和定时

| 命令 | 管家 | 备注 |
|---|---|---|
| `graph split --json` | ✓ `graph_split` | |
| `graph update-task <id> <task> --json` | ✓ `task_edit` | |
| `graph delete-task <id> <task>` | ✓ `task_edit` | |
| `graph act <id> --json` | ✓ `graph_action` | |
| `graph task-act <id> <task> --json` | ✓ `task_action` | |
| `graph changes <id>` | | |
| `graph events <id>` | | |
| `schedule list` | ✓ `list_schedules` | 新补 |
| `schedule create --json` | ✓ `schedule` | |
| `schedule update <id> --json` | | 含开关 |
| `schedule delete <id>` | ✓ `cancel_schedule` | |

### 配置

管家都不给（第 5 节）。

| 命令 | 备注 |
|---|---|
| `agent list` / `check --json` / `save <id> --json` / `delete <id>` | `save` 的路径 id 和请求体对不上时拒绝 |
| `project list` / `check --json` / `create --json` / `languages <id>` / `activity <id>` | 管家 ✓ `projects`（只列） |
| `runtime list` / `refresh <id>` / `update <id> --json` / `upgrade <id>` | |
| `skill list` / `save <id> --json` / `delete <id>` | |
| `setting load` / `check --json` / `save --json` | 返回里的钥匙要确认已打码 |

### 连接器、院门、语音、游戏

生成，命令行里少用。

| 命令 | 备注 |
|---|---|
| `connector list` / `login <id> --json` / `verify <id> --json` / `logout <id>` / `channel <id> --json` | 登录要扫码，命令行只能打出链接 |
| `gate status` / `update --json` / `start-pairing` / `stop-pairing` / `answer-pairing --json` / `delete-device <id>` | 不给 `remote` |
| `gate pair --json` / `gate me` | 设备那一端调，`remote` ✓ |
| `voice session` / `renew` / `start` / `stop` | 声网的令牌，只有客户端用 |
| `game choose-title --json` | |
| `server health` | |

### 手写的命令

| 命令 | 做什么 |
|---|---|
| `state [--watch]` | `/api/state` 的一帧 `StateFrame`；`--watch` 一直跟着 |
| `events` | 跟着 `/api/events` |
| `issue run <id>` | 开工，等到「等你看」或排上队，打出改动；`verify-dispatch` 的主体 |
| `runtime chat <runtime>` | 本机工具：和一个农机直接聊，不经服务端（第 3 节） |
| `oar <command>` | 本机工具：smith 的 oar 命令行（`detect`、`models`、`login`、`usage`、`run`……），农机和服务端的一样 |
| 不带子命令 | `runtime chat vibevalley` 的简写 |

### 帮工的子集

没有。Session 不调农场的接口：它要的东西由投递带进来，它说的话由服务端在一轮结束时整理出去，见 [Session、Run、事件](2026-10-17-session-run-step.md)。原来定的「命令行加每次执行一把钥匙」和 `session.say`、`session.inbox`、`session.ask` 不做了；`can` 里的 `session` 留着不用，等真的有 Session 要调的操作再说。

### 已定

2026-10-17 主人让定的几件，已经写进上面各节：`server.start` → `manager.open`，`server.end` 删；`progress.carryCoins` 删；帮工不调农场的接口（「帮工的子集」）；能力上的空缺（第 5 节）；直接聊叫 `runtime chat`（第 3 节）。

## Alternatives considered

**只加一个手写的命令行。** 最快，但它会是第八个各自接一遍的入口，几个月后就和接口对不上。没选。

**命令行直接打开数据库，不经服务端。** 服务端没开也能用；但服务端开着时就有两份核心状态，违反「核心状态只有一份」。没选。

**管家的工具、MCP 全部从接口生成。** 一处都不用手写；但模型用的工具要的是模型看得懂的参数和说明，和给程序用的接口不是一个形状（管家派活给的是档案的名字和一句话）。先检查，等能力表稳定了再看哪些能生成。

**能力表另放一个文件（YAML）。** 和 `api.go` 分开，加操作时会忘了改它；写成同一处的注释，shapegen 一起读，漏了就生成失败。

## Acceptance criteria

- `api.go` 的每个操作都有 `can`，没有就 `shapegen` 失败。
- `docs/reference/capabilities.md` 由 shapegen 写出，`-check` 查它最新。
- 院门放行的操作和 `can remote` 一致，有测试。
- `vibevalley issue create`、`issue start`、`state`、`issue merge` 能对着一个临时的服务端用；测试经 `Client` 走一遍每个操作。
- `can` 里只有 `owner`、`remote`；agent 的工具不经能力表（[管家是一份档案，只是能力多](2026-10-17-manager-is-an-agent.md)）。
- 派活只剩一条规则：管家派的也先有工单，满了排队。
- 每个操作至少有一个入口用它。
- `mcp.go` 里没有 `farm_*`，`/mcp` 的工具从能力表来（[Session、Run、事件](2026-10-17-session-run-step.md)）。
- 第 4 节的表做完：没有 `add`、`edit`、`remove`、`find`、`open` 这些动词，没有 `/api/workers`、`/api/chat`、`/api/lan` 路径。

## Risks

- `can` 写错了就是权限写错了：`remote` 放多了，院门后的设备能做本该只在本机做的事。第一次写 `remote` 时逐条对照 `gate.go` 现在的放行，改的时候在 PR 里单独列出。
- 管家派活改成先写工单、满了排队以后，管家原来「满了就告诉主人派不出去」的说法要跟着改，不然主人以为没派。
- 命令行和对话共用 `cmd/vibevalley` 一个名字：对话只在不带子命令时、或 `runtime chat` 时打开，带别的子命令一律是一次调用。
- `runtime chat` 在本机跑，花的钱不进农场的账；主人以为农场记着的话会对不上，命令开头打一行说明。
- `/mcp` 对外以后，主人机器上任何 agent 都能经它做主人能做的事；它和命令行一样只听 127.0.0.1，院门不放它。
