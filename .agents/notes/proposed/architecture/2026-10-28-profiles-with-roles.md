# Agent Note: 档案有角色：管家和帮工都是档案，管家可以有好几个

Status: proposed

## Problem

档案（profile，代码里是 `Agent`）本来就是「一份 agent」：农机、模型、人设、技能、记性。可管家被写成了一个特例：

- **只有一个管家，id 写死**：`orchestratorAgent`（`"orchestrator"`）是一个固定的 id，25 个文件、97 处按它判断「是不是管家」：派活不派给它、记性走它的 MEMORY.md、交给它的工单只交结论、频道里它是唯一的参与者 `orchestrator`、主人在频道里不 @ 谁就叫醒它、私聊的对面是它、巡查和定时交给它。
- **服务和状态都是单份的**：一个大脑（`Sessions.host`）、一个家目录（`$VIBEVALLEY_HOME/orchestrator/`）、核心状态里一个心情（`WorkspaceState.orchestrator`、`orchestratorChannel`）、`orchestrator.*` 接口不带是哪一个；页面上管家页写死它的 id，农场画一个管家，它的样子是一个本机偏好（`orchestratorLook`），不是档案的 `look`。
- **「档案」被说成「帮工档案」**：界面把档案默认成帮工；管家的档案单放在别处，档案列表里没有它。
- **`Agent.role` 是一句自由文字**（「看代码、答问题」，界面叫「职责」）：名字被占着，表达不了一份档案是管家还是帮工。

## Proposal

**档案是总的东西，管家、帮工是它的角色。** 一份档案的 `role` 是 `orchestrator`（管家）或 `worker`（帮工）；管家可以有好几个，各是一份普通的档案。

### 1. 叫法

| 界面 | 代码 | 是什么 |
|---|---|---|
| 档案 | `Agent` | 一份 agent：农机、模型、人设、技能、记性、样子 |
| 管家 | `Agent.role: "orchestrator"` | 常驻、带队、自己不干活；可以有好几个 |
| 帮工 | `Agent.role: "worker"` | 被派上一张工单，开一个 Session 干活 |
| 职责 | `Agent.duty` | 原来的 `Agent.role`：一句话说它做什么，派活时管家读它 |
| 默认管家 | `defaultOrchestrator`（`"orchestrator"`） | 内置的那份管家档案：删不掉、不能改成帮工，所以至少有一个管家；没指明交给哪个管家的都给它 |

`orchestratorAgent` 改名 `defaultOrchestrator`；代码里「是不是管家」一律问角色（`isOrchestrator`），只有「没指明时给谁」才用默认管家。

### 2. 档案

- `Agent.role` 是封闭的两种（`AgentRoleValues`），新建默认是帮工；`Agent.duty` 是原来的 `role`。
- 管家只在 VibeValley 自己的 agent 上跑（常驻在服务端进程里，电话要它插话）：保存一份管家档案时农机不是 `vibevalley` 就拒绝；把帮工改成管家要先把农机换成 `vibevalley`。
- 默认管家删不掉、角色改不了；别的管家能删（有工单派给它时照帮工的规则拒绝）。
- 派活用的档案（`sendable`）是帮工；全部档案和按 id 取的含管家。

### 3. 每个管家一份

- **家目录是档案的**：每份档案一个 `$VIBEVALLEY_HOME/agent/<档案 id>/`（`agentHome`），管家的对话、`MEMORY.md`、旧账 `archive/`、评测 `evals/` 都在它自己的这里；帮工档案的家目录是同一个位置，以后它的记性也放进来（这一篇只挪管家的）。原来的 `$VIBEVALLEY_HOME/orchestrator/` 不再读（照「内部不留兼容」）。
- **大脑**：`Orchestrator` 服务按档案各起一个宿主（`Sessions.host`，第一句话到了才起来）；每个有自己的排队、自己的「上次给模型看的现状」。提示开头照旧，档案有名字和人设时接在后面（默认管家没有，开头不变）。
- **心情**：核心状态的 `orchestrators`：每个管家的心情和它在想、在写的频道（替掉 `orchestrator`、`orchestratorChannel`）；事实 `orchestrator` 带上是哪个管家。
- **接口**：`orchestrator.stop`、`orchestrator.archive.*`、`orchestrator.eval.create` 收 `agent`（不填是默认管家）；记性照旧走 `memory.*`，管家的记性是它家目录里的 `MEMORY.md`。

### 4. 谁接哪条话

| 来的话 | 给哪个管家 |
|---|---|
| 主人在频道里说话、没 @ 别人 | 这个频道的管家：`Channel.orchestrator`，不填是默认管家（频道设置里选） |
| 有人 @ 一个管家 | 被 @ 的那个；`@管家` 是这个频道的管家，别的管家用它档案的 id（`@lead`） |
| 主人在和一个管家的私聊里说话 | 对面那个管家（每个管家一个私聊，`channel.direct.create` 给管家开的就是它的私聊） |
| 派给一个管家的工单、交给它的定时 | 工单的 `assignee` 那个；没写给谁的定时给它所在频道的管家 |
| 巡查 | 那个频道的管家 |
| 电话、听写、`chat/completions`、计划的消息 | 默认管家 |

频道里每个管家是一个参与者，id 就是它的档案 id，种类是 `orchestrator`；它说的话 `from` 是档案 id、名字是档案的名字。来回上限、冷却照旧不管管家。

### 5. 页面

- 「帮工档案」改叫「档案」；档案页列出全部档案、标出管家和帮工，能新建管家；管家的档案里农机固定是 `vibevalley`。
- 管家页按档案分：`/orchestrator` 是默认管家，`/orchestrator/<档案 id>` 是别的；记性、轨迹、旧账、声音照旧。
- 聊天：管家的头像、名字、在想在写按它是哪个；成员栏列出这个频道的管家；@ 的名单里有每个管家；频道设置里选照看的管家；侧栏底下是这个频道的管家。
- 农场：每个管家一个人，默认管家在原来的位置，别的在它旁边；样子是它档案的 `look`（`orchestratorLook` 这个本机偏好去掉，原来的样子挪进默认管家的档案）。

### 6. 做的顺序（一个 PR，每步一个提交）

1. 档案：`role`、`duty`，`defaultOrchestrator`，角色的规则；`orchestratorAgent` 的判断换成问角色。只有一个管家时行为不变。
2. 管家服务按档案分：家目录、宿主、核心状态的 `orchestrators`、接口带 `agent`。
3. 频道：每个管家一个参与者、`Channel.orchestrator`、谁被叫醒、管家的私聊、@。
4. 工单、定时、巡查、通知照第 4 节交给对的管家。
5. 页面：档案页、管家页、聊天、频道设置、农场；词表。
6. 文档、测试；管家的提示变了就跑真模型的评测（花钱，先问主人）。

## Alternatives considered

- **管家和帮工是两种东西，管家只有一个**（现在的样子）：每加一样跟档案有关的东西都要问一遍管家有没有；想要第二个管家（比如一个专管某个项目的）没有地方加。
- **角色放在另一个字段名里，`role` 留给职责**：界面和主人的说法都是「角色」，`role` 给它；原来那句话界面叫「职责」，改叫 `duty`。
- **管家也能跑在外部农机上**：常驻、电话里插话、提示开头不变这几件外部农机做不到；先只在 `vibevalley` 上，档案上的这条规则在 `agent` 一处，以后放开只改它。
- **每个频道可以有好几个管家同时听**：一句话叫醒好几个管家就是好几份钱、好几个回答；一个频道一个照看的，别的被 @ 才来。
- **按档案上的能力（`Can`）分工具**（[管家是一份档案，只是能力多](.agents/notes/proposed/architecture/2026-10-17-orchestrator-is-an-agent.md)）：那篇的「只有一种 agent」由本篇的角色做成；它的 `Can`（一份档案多给或少给哪几组工具）叠在角色之上，本篇不做。
- **原来管家的家目录挪到新位置**：照「内部不留兼容」不做数据搬运；旧的 `orchestrator/` 留在原处不读。

## Acceptance criteria

- 档案页能新建第二个管家；它有自己的私聊，在里面说话是它回答；把一个频道交给它照看，主人在那个频道里说话是它回答，默认频道还是默认管家。
- 两个管家各有自己的 `MEMORY.md`、对话和心情；一个在想时另一个不显示在想。
- 服务端里没有 `orchestratorAgent`；「是不是管家」都问角色。
- 界面上没有「帮工档案」。
- 只有默认管家时，管家的提示开头和工具跟改之前一样（评测样例不用改）。

## Risks

- 原来管家的对话和 `MEMORY.md` 在 `$VIBEVALLEY_HOME/orchestrator/`，改了以后不再读：主人要留着它的记性，就把文件挪到 `agent/orchestrator/`。
- 核心状态的形状变了（`orchestrators`）：页面和手机壳读它的地方都要跟着改。
