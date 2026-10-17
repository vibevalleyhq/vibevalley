# Agent Note: 管家是一份内置档案

Status: proposed

## Problem

管家现在是半个档案。它占着档案的 id：`protocol.ManagerAgent = "manager"`（`server/internal/protocol/shapes.go:10`），工单能派给它（`IsForManager`），记忆挂在它名下（`server/internal/memory/memory.go:283`），轨迹和 Session 的放在一起。但它不是一份存下的档案：农机和模型在配置的 `manager.runtime`、`manager.model`（`server/internal/base/config.go:31`），拿 `manager` 存档案被拒绝（`server/internal/agent/agent.go:140`）。

所以每个碰到档案的地方都要为它开特例：记忆有两套接口（`agent.memories` 和 `manager.memories`，后者的形状 `ManagerMemory` 多出 `Runtime`、`File`、`Carried`），频道的发言人分 `'worker'` 和 `'manager'` 两种，改管家的模型要改配置文件。

## Proposal

- 管家是一份内置的档案：id `manager`（`protocol.ManagerAgent`）就是它的记号，不另加字段：`Agent.Role` 已经是一句描述（「写接口、改 server」）。内置的意思是：服务端开机时确保它在，`agent.delete manager` 拒绝，农机只能是 `vibevalley`。
- 农机和模型从配置挪进这份档案：`agent save manager` 能改；配置的 `manager.runtime`、`manager.model` 删掉，按「不留兼容」在加载时把旧值写进档案一次（`agent/cast.go` 那样）。
- 名字 Manager 只留给这个角色和派活的服务 `internal/manager`；界面上还叫管家。不改叫 Agent：`Agent` 指全部档案，`manager.hear`、`manager.archive` 是只有它有的，归到 `agent.*` 下读起来像对所有档案说的。
- 随之收敛的：
  - 记忆 `memory.*` 带 `agent`，`manager` 就是一个档案 id，`ManagerMemory` 多出的 `Runtime` 是档案的字段，`File` 和 `Carried` 并进 `memory.list` 的返回（[先有能力，再有入口](2026-10-17-capabilities-before-surfaces.md) 第 4 节）。
  - 频道的发言人不合并：`channel_participant.kind` 留着 `manager`（见 Alternatives）。
  - `manager.*` 只剩 `manager.hear`、`manager.open`、`manager.archive.*`。
- 管家能用什么工具仍由 `internal/manager` 定，不进档案的 `skills`、`mcpServers`：它的工具是派活的规则，主人改了会让派活失灵。

### 做到哪了

2026-10-17 做了：档案 `manager` 在加载时补上（`agent.go` 的 `managerProfile`），`Agents()` 是派活用的档案（不含管家），`All()` 是全部，`agent.list` 返回全部；删管家、把它的农机换掉被拒绝；`Issue.Hire` 拒绝派给管家；管家的模型从档案读（`manager.go` 的 `modelOf`），配置的 `manager` 段、`protocol.Runtime` 枚举和 `ManagerMemory.Runtime` 删了（管家本来只能在自己的 agent 上跑，`pi` 一直被拒绝）。Flutter 的 `DeskConfig` 把管家的档案单放在 `manager`，各处的档案列表里没有它。

记忆合成 `memory.list`、`recall`、`create`、`delete`（`/api/v1/memories/{agent}`，管家是 `manager`，`MemoryList` 只有管家的带 `file`、`carried`；`memory.Service` 按档案分去行或 `MEMORY.md`）也做了。

频道发言人试过并进 `agent`，撤回了，见 Alternatives。还没做：管家页上改模型。

## Alternatives considered

**管家改叫 Agent。** `Agent` 已经指全部档案；另外 `pkg/agent`（我们自己的 agent 循环）和配置里 `cmd/vibevalley` 的 `Agent.Model` 也叫 agent，再加一个就是第四个意思。

**频道里管家也说成 `agent`。** 2026-10-17 做到一半撤回：频道里管家和 Session 的处理处处不同，合并以后要在五处写「是 agent 但不是管家」——给 Session 拼的消息行（`MessageLine` 写 id 和名字，管家只写名字）、Inbox 里谁问的（`InboxFromManager`）、开机叫醒在地里的（`chat.go`）、把不在地里的标成离开（`deliver.go`，管家会被标走）、账本里的交接（`game/progress.go`）。管家在频道里是另一种参与者：不在地里、不离开、田头的话都给它。`manager` 这个种类把这件事说在一处，比五个例外清楚。

**维持现状。** 每个碰到档案的地方继续开特例；记忆、配置两处的特例已经在，以后档案每加一样东西（长相、技能），都要问一遍管家有没有。

## Acceptance criteria

- `agent list` 里有 `manager`；`agent save manager` 能改它的模型，删它、把它的农机换掉被拒绝。
- 配置里没有 `manager.runtime`、`manager.model`；旧的配置打开一次后，值在档案里。
- 记忆和配置里没有为管家写的特例分支；频道里的 `manager` 种类留着。
- `go vet ./... && go test ./...`、`shapegen -check`、`bun run flutter:check` 通过。

## Risks

- 档案里只有模型对管家有用（农机固定、工具由 `internal/manager` 定）；管家页宜只放模型一项，别的字段改了也不起作用。
- 档案存在 `config.json`，管家进了档案，坏掉的 `config.json` 也会让管家起不来；开机时缺了就按默认补上。
