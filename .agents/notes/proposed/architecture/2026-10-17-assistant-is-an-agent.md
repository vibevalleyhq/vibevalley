# Agent Note: 管家是一份档案，只是能力多

Status: proposed

## Problem

管家和档案本质上是一种东西：一个模型、一份人设、一组工具。差别只在两处：管家手里的工具多（派活、带话、合并、计划、定时、开频道），以及它常驻、不绑工单。可是代码里把它们写成了两种东西：

- **档案这半边已经并了**：管家是档案 `assistant`（`protocol.AssistantAgent`），模型从档案读，记忆走 `memory.*`（见「做到哪了」）。
- **工具这半边还是两套**：管家的工具手写在 `apps/server/src/tool/tool.ts`（`dispatch`、`tell`、`changes`、`roster`、`task`、`recurrence`、`open_channel`、`memory_search`……），帮工的工具手写在 `apps/server/src/mcp/mcp.ts`（`channel_say`、`channel_read`、`channel_inbox`、`session_list`、`memory_search`、`memory_add`）。记性的两个工具写了两遍；同一件事（读频道）管家叫 `read_chat`，帮工叫 `channel_read`，规则也各写一份。
- **谁能做什么写在三处**：管家的工具表、MCP 的工具表、能力表的 `can assistant`（[先有能力，再有入口](docs/subsystems/core.md)）。想让一个帮工也能拆子工单（一个「领班」），或者让管家能建档案，没有地方改，只能再手接一遍。
- 「管家」「帮工」作为两种调用者散在 16 个服务端文件里（`AssistantAgent`、`IsForAssistant` 等的判断）；其中一部分是真的不一样（见下面「不是能力的差别」），一部分只是「它的工具多」。

## Proposal

**只有一种 agent：档案。管家是一份能力最多的内置档案。** 一份档案能调哪些工具，是档案上的一个字段；管家和帮工用同一张工具表，服务端在每次调用时按调用者的档案放行。

### 谁管什么

| 在哪 | 管什么 |
|---|---|
| `protocol` | 给出去的形状：`Agent.can` 这个字段和 `Capability` 的取值，存盘、发给页面、档案页改它都用它。不放规则 |
| `apps/server/src/agent` | 档案这个概念：默认给哪些能力、哪份是常驻的、谁能改 `Can` |
| `apps/server/src/tool` | 工具表：每个工具要哪种能力、执行时放行、把结果写成给模型看的一句话 |
| 能力表（`packages/protocol/src/api.ts` 的 `can`） | 只管 HTTP 入口：主人、「连接到本机」后的设备能调哪些接口；不管 agent |

### 1. 能力是档案的字段

`protocol.Agent` 加 `Can []Capability`，`Capability` 是封闭的枚举。一种能力是一组工具，哪个工具归哪种能力写在 `apps/server/src/tool`，不写在 `protocol`：

| 能力 | 工具（现在的名字） | 管家 | 普通档案默认 |
|---|---|---|---|
| `talk` | 在频道里说、读、看收件箱（`channel_say`、`channel_read`/`read_chat`、`channel_inbox`） | ✓ | ✓ |
| `memory` | 搜、记自己的记忆（`memory_search`、`memory_add`） | ✓ | ✓ |
| `look` | 看地里谁在干什么、看改动（`roster`/`session_list`、`check`、`changes`、`projects`、`channels`） | ✓ | ✓（只读） |
| `dispatch` | 派活、带话、合并、请走、打断（`dispatch`、`tell`、`merge`、`dismiss`、`stop`） | ✓ | |
| `graph` | 种植计划（`graph_split`、`task_edit`、`graph_action`、`task_action`、`graphs`） | ✓ | |
| `recurrence` | 定时（`recurrence`、`list_recurrences`、`cancel_recurrence`） | ✓ | |
| `channel` | 开频道、改频道设置（`open_channel`、`channel_settings`） | ✓ | |
| `hire` | 建档案、改别的档案的人设、模型、技能（新） | ✓ | |

- 管家的 `Can` 是全部，内置档案开机时补齐；普通档案新建时是 `talk`、`memory`、`look`。默认值是 `agent` 包的规则。
- 只有主人能改 `Can`（`agent.save` 从 `owner` 入口来，`agent.Service` 查）；工具不能改任何档案的 `Can`，也不能改管家这份档案。所以没有哪个 agent 能给自己或别人加权。
- 给一份 Claude Code 档案加上 `dispatch`，它就是能拆子工单的领班；不用新概念。

### 2. 一张工具表，两种接法

工具只定义一次：名字、给模型看的说明、参数（Effect Schema，`tool/schemas.ts`）、要哪种能力、执行函数。执行函数收到的是认证过的调用者：

```go
type Caller struct {
	Agent   string // 档案 id；管家是 protocol.AssistantAgent
	Session string // 在干哪份活；管家为空
	Project string // 那份活在哪个项目
	Here    string // 管家正在回答的对话；帮工默认是它的工单串
	Picked  string // 主人这次选的档案，派活时优先
	Owner   bool   // 这次的输入里有主人的话：只有这时才能收获
}
```

- 表放在一个新包 `apps/server/src/tool`（排在 `task`、`recurrence` 之后、`assistant` 之前，`tool.Service`）。工具的规则还在拥有它的服务里，`tool` 只做参数、放行和把结果写成给模型看的一句话。
- **管家**在进程里拿这张表：`tool.Service` 按 `Can` 交出 pi-agent-core 的 `AgentTool`，`apps/server/src/assistant` 不再手写工具，只留它特有的输入、回复和 Run 的接线。
- **外部农机上的 Session**（Claude Code、Codex……）经 `/mcp` 拿同一张表：`apps/server/src/mcp` 只做 MCP 的传输和认证（从请求认出 Session，再找到它的档案），工具列表按档案的 `Can` 过滤。
- 放行在执行时再查一次 `Can`，不只靠列表过滤：档案的 `Can` 在 Session 干活时被主人改小，下一次调用就拒。
- 同一件事只留一个名字（`read_chat` 和 `channel_read` 合成一个）；名字和说明照管家现在为模型调过的那份，帮工那份不同的地方逐条比过再定。

### 3. 和能力表分开

能力表的 `can` 管「农场往外给出哪些接口、给谁」；本篇的 `Can` 管「一个 agent 能调哪些工具」。这是两件事，不合在一处：

- 模型的工具和 HTTP 接口不是一个形状：`dispatch` 收的是档案的名字和一句话，`tell` 是带话，`read_chat` 读出来的是给模型看的文字。工具里调哪些服务是工具自己的实现，不对应某个接口。
- 所以 `can` 只留 `owner`、`remote`，去掉现在 23 个操作上的 `assistant` 和没用的 `session`；[先有能力，再有入口](docs/subsystems/core.md) 里的 `//vibevalley:tool` 和「管家的每个工具对得上一个 `can assistant` 的操作」的检查不做，换成工具表自己的检查（每个工具标了能力、每种能力都有工具）。
- 那篇第 5 节的「管家建项目、改档案……不给」由这里的 `hire` 取代：建、改档案给，项目、设置、农机仍然不给。

### 4. 不是能力的差别

下面这些不是「工具多少」，并进档案以后照样不同，代码里保留，但都按「这份档案是不是常驻的」判断一次，不再散着写 `== AssistantAgent`：

- **在哪跑**：管家跑在服务端进程里的 `apps/server/src/agent/brain`，常驻、不绑工单、不进 worktree；电话、听写、`/v1/chat/completions` 要它低延迟地插话，也要它的提示开头不变（[提示开头不变](docs/subsystems/assistant.md)）。普通档案每次为一张工单开一个 Session，经 oar 驱动外部农机。所以管家的农机仍然只能是 `vibevalley`。
- **在频道里是谁**：`channel_participant.kind` 留着 `assistant`：不在地里、不离开、田头的话都给它（见 Alternatives）。
- **不能派给它**：工单派给管家走管家的输入，不开 Session（`Issue.Hire` 拒绝派给管家）。

代码里给这件事一个名字：`agent.Service` 回答「这份档案是不是常驻的」（目前只有管家是），上面三处都问它。它是档案的规则，不挂在 `protocol.Agent` 上。

### 5. 主人要看得见

`hire` 是管家第一次能改主人的配置，按「谁写的谁负责、主人要看得见」：

- 管家建或改了一份档案，在它正在回话的频道里说一条，写明改了什么；档案页标出「管家建的」。
- 建出来的档案是 `Enabled: false`，主人点一下才能派活。理由和[分清话是谁说的](docs/subsystems/assistant.md)里收获要主人点头一样：一句外面传进来的话不该直接变成一个能花钱、能改仓库的帮工。

### 做的顺序

1. `Capability` 和 `Agent.Can`，档案页能改；`agent.Service` 的「是不是常驻」替掉散着的 `AssistantAgent` 判断。档案存在家目录的 `config.json`，不加迁移。
2. `apps/server/src/tool`：两边的工具都搬进去，管家和 `/mcp` 都从它拿（已做）。
3. `/mcp` 按 `Can` 过滤和放行；能力表的 `can` 去掉 `assistant`、`session`。
4. `hire` 的工具和「管家建的」的展示。

### 做到哪了

档案那半边 2026-10-17 做了：档案 `assistant` 在加载时补上（`agent/agent.ts` 的 `assistantProfile`），`Agents()` 是派活用的档案（不含管家），`All()` 是全部，`agent.list` 返回全部；删管家、把它的农机换掉被拒绝；`Issue.Hire` 拒绝派给管家；管家的模型从档案读（`assistant/assistant.ts` 的 `modelOf`），配置的 `assistant` 段、`protocol.Runtime` 枚举和 `AssistantMemory.Runtime` 删了。页面的 `DeskConfig` 把管家的档案单放在 `assistant`，各处的档案列表里没有它。记忆合成 `memory.list`、`recall`、`create`、`delete`（`/api/v1/memories/{agent}`，管家是 `assistant`）。帮工的 `memory_search`、`memory_add` 经 `/mcp` 也有了（7ddb14d），和管家的是两份实现。

工具表（第 2 节的目录）2026-10-18 做了：`apps/server/src/tool` 排在 `task` 之后、`assistant` 之前，按事情分文件（`tool/tool.ts`、`tool/tool.ts`、`tool/tool.ts`、`tool/tool.ts`、`tool/tool.ts`、`tool/tool.ts`），管家的 23 个工具和帮工的 6 个都搬了进去；`tool/tool.ts`、`tool/schemas.ts` 删了，管家经 `tool.Service.Assistant` 拿工具，调用者从它正在回答的输入取；`apps/server/src/mcp` 只剩认证和把 `tool.Service.Session` 的工具注册到 `/mcp`。读频道合成一个 `read_chat`（帮工原来叫 `channel_read`，管家的多了 `unread`、`before`、`limit`）；记性的两个工具各一个函数，按调用者选写法。哪些工具给谁现在还是两张写死的表（`Assistant`、`Session`），没有 `Can`。

还没做：`Capability` 和 `Agent.Can`（第 1 节）、`agent.Service` 的「是不是常驻」（第 4 节）、按 `Can` 过滤和放行、能力表去掉 `assistant` 和 `session`（第 3 节）、`hire`（第 5 节）、管家页上改模型；从[先有能力，再有入口](docs/subsystems/core.md)并过来的：管家的 `dispatch` 现在直接 `Issue.Hire`、满了就拒绝，要改成先写工单再挪到待办（`issue.status`），和主人派的一条规则、满了排队。

## Alternatives considered

**管家的工具留在 `apps/server/src/assistant`，不进档案。** 本篇的前一版就是这样定的，理由是「它的工具是派活的规则，主人改了会让派活失灵」。不再这样：主人能改的是 `Can`（给不给一组工具），不是工具本身，工具的说明和参数仍然只在一处、由代码定；而留在 `apps/server/src/assistant` 的代价已经出现了：记性工具写了两遍，领班和建档案没有地方加。

**管家改叫 Agent。** `Agent` 已经指全部档案；另外 `apps/server/src/agent/brain`（我们自己的 agent 循环）和 `cli.ts` 的 `Agent.Model` 也叫 agent，再加一个就是第四个意思。名字 Manager 只留给这个角色和服务 `apps/server/src/assistant`，界面上还叫管家。

**频道里管家也说成 `agent`。** 2026-10-17 做到一半撤回：频道里管家和 Session 的处理处处不同，合并以后要在五处写「是 agent 但不是管家」：给 Session 拼的消息行（`MessageLine` 写 id 和名字，管家只写名字）、Inbox 里谁问的（`InboxFromAssistant`）、开机叫醒在地里的（`channel/chat.ts`）、把不在地里的标成离开（`channel/chat.ts`，管家会被标走）、账本里的交接（`game/progress.ts`）。`assistant` 这个种类把这件事说在一处，比五个例外清楚。

**工具挂在 `packages/protocol/src/api.ts` 的操作上（`//vibevalley:tool`，`can` 里加 `agent`）。** 能力表那篇原来的打算，本篇第一稿也照着写了：能力表成为 agent 能做什么的唯一来源。不选：那样是 HTTP 接口决定 agent 能做什么，方向反了；模型的工具要的参数和说明和接口不一样，硬对上要么工具变差，要么为模型加接口。`protocol` 管给出去的形状，agent 的能力归档案和工具表。

**能力按角色分（`assistant`、`lead`、`helper` 三档）。** 好懂，但每多一种用法就要多一档，档和档之间的差别还是要落到工具上；直接列能力，角色只是一组默认值。

**能力细到每个工具。** 最灵活；但主人要勾二十几个框，而且「能派活不能带话」这种组合没有意义。按一组一组的事给。

**管家也能跑在外部农机上（比如 Claude Code）。** 统一得最彻底；但电话和听写要插话、要提示开头不变，外部农机做不到，也没法在进程里压缩上下文。先不做，「是不是常驻」把这件事留在 `agent` 一处，以后要放开只改它。

**维持现状。** 每加一样跟档案有关的东西都要问一遍管家有没有，每加一个工具都要决定写在哪一边。

## Acceptance criteria

- `protocol.Agent` 有 `Can`；`agent list` 里管家的 `Can` 是全部，新建的档案是 `talk`、`memory`、`look`；`agent save` 能改 `Can`，管家的改不小。
- `apps/server/src/assistant` 和 `apps/server/src/mcp` 里都没有手写的工具定义；工具只在 `apps/server/src/tool`，每个标了能力，`tool/tool.test.ts` 查每种能力都有工具、每个工具都有能力（`Record<Capability, …>` 让漏了的编不过）。
- 经 `/mcp`，一个只有默认能力的 Session 列不出也调不了 `dispatch`；主人给它的档案加上 `dispatch` 后，它能派出一张工单，排队规则和管家派的一样。
- 干活中把档案的 `Can` 改小，下一次调用被拒。
- 服务端里 `== protocol.AssistantAgent` 只剩 `agent` 包里，别的地方问 `agent.Service` 是不是常驻，或者查 `Can`。
- `packages/protocol/src/api.ts` 的 `can` 里没有 `assistant`、`session`；`protocol` 里没有能力和工具的对应。
- 管家用 `hire` 建的档案是停用的，频道里有一条说明。
- `bun run server:check`、`bun run capabilities`、`bun run web:check` 通过；改了管家的工具描述，跑一次 `verify-assistant-evals`（要花钱，先问主人）。

## Risks

- 工具合成一份时，管家那份说明是为 DeepSeek 调过的，帮工那份是给 Claude Code、Codex 看的；合并后可能有一边变差。合之前跑管家的评测，帮工那边至少真的派一次活看汇报。
- `Can` 写错就是权限写错：给错一个档案 `dispatch`，它就能花钱开别的帮工。默认值要小，改 `Can` 只在档案页、只由主人；PR 里单列默认值的改动。
- 领班能派活以后，帮工派帮工可能连锁：同时干活的上限（6）还在，但一个领班可以把它占满。第一版不限，看用起来再说；要限就加在 `Issue.Start`，不加在工具里。
- 档案存在 `config.json`，坏掉的 `config.json` 也会让管家起不来；开机时缺了管家就按默认补上，`Can` 也一起补。
