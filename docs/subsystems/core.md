# 核心状态和接口

农场上的一切是一个值：核心状态（`CoreState`），只有服务端持有，只在 `Core.apply` 里因事实（fact）而变，每条事实由纯函数 `reduce`（`packages/protocol/src/rules/core.ts`）折进去。外面的人只经两样东西碰它：`/api/v1` 下的接口（改）和三条 SSE 流（看）。农场里不画它本身，农场画面的全部数据都从它来。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 核心状态怎么变：`apply`、`reduce`，每条事实的前后状态（`Transition`） | 某种事实什么时候施加、业务规则（各拥有者：[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)、[田头](docs/subsystems/channel.md)、[定时](docs/subsystems/schedule.md)、[种植计划](docs/subsystems/task.md)） |
| `state.json`：存什么、什么时候存、开机怎么读回 | 库里的表、`sessions.json`、各 Session 的日志（[帮工](docs/subsystems/session.md)、[architecture.md](docs/architecture.md)「存了什么」） |
| 给页面的帧 `StateFrame`（`frameOf`）和特效的发出 | 地里长什么、特效和账本怎么算（[游戏](docs/subsystems/game.md)、[farm-ui.md](docs/reference/farm-ui.md)） |
| 三条 SSE 流 `/api/v1/state`、`/api/v1/events`、`/api/v1/live` | 帮工的 `/mcp`（[田头](docs/subsystems/channel.md)）、语音线路（[语音](docs/subsystems/voice.md)） |
| 接口表 `api.ts` 的 `endpoints`、能力表 `can`、`/api/v1` 版本、命令行这张皮 | 每个接口做什么（拥有它的服务）；「连接到本机」的配对和钥匙（[连接到本机](docs/subsystems/lan.md)）；管家和帮工的工具（`apps/server/src/tool`，[管家](docs/subsystems/manager.md)） |
| 重启时核心状态怎么回来，各拥有者在哪一步接手 | 各拥有者自己怎么恢复（链接见「怎么走」） |
| 跨模块的接口约定：调用方交意图，拥有者负责协调和结果 | 某个模块的具体动作 |

## 在哪

- `apps/server/src/core/core.ts`（`Core`）：施加、存盘、各条流；`services.ts` 让它最先建、最后关。
- `packages/protocol`：形状在 `shapes.ts`（`CoreState`、`Fact`、`SideEvent`、`LiveEvent`、`StateFrame`，三条流的路径 `statePath`、`eventsPath`、`livePath`）；`rules/core.ts` 的 `reduce`、`emptyCoreState`；`rules/frame.ts` 的 `frameOf`；`rules/view.ts` 的 `effectsOf`；`api.ts` 的接口表 `endpoints`、`Handlers`、客户端 `VibeValleyApi`；`stream.ts` 的 `readStream`。
- `apps/server/src/http`：`api.ts` 按 `endpoints` 挂每个接口，`streams.ts` 三条流，`app.ts` 组装和开始答 HTTP；`handlers.ts` 实现 `Handlers`。
- 能力表 [capabilities.md](docs/reference/capabilities.md) 由 `scripts/capabilities.ts` 从 `endpoints` 写出，`docs:verify` 查它是不是最新。
- 命令行 `apps/server/src/cli.ts`：每个接口一条命令（从 `endpoints` 来），`state`、`events`、`issue run`；`runtime chat` 和自己的 agent 不经服务端。
- 「连接到本机」 `apps/server/src/lan/lan.ts` 的 `remoteMay`：从 `endpoints` 和三条流里挑 `can` 有 `remote` 的。
- 页面 `apps/web/src/data/frame.tsx`（读 `/state`）、`data/live.ts`（读 `/live`），命令用 `VibeValleyApi`。
- 文件：`$VIBEVALLEY_HOME/state.json`。

## 模型和不变量

**核心状态**

- **一份，只在服务端，只在 `apply` 里改**（`apply(...facts)` 一次可以给几条）。核心状态里有什么见 [architecture.md](docs/architecture.md)「核心状态」。
- **`reduce(state, fact)` 是纯函数，返回新状态和「变没变」**。没变的事实不发、不存、不算特效；关于不在地里的帮工的事实什么也不改。变了且有工单时，工单的状态跟着重算（`withIssueStatuses`）。
- **事实的时间由 `Core` 盖**：施加时把 `at` 改成当时的时钟，调用方给的不算。
- **`Transition` 绑住一条事实和它改的那一份状态**：`before`、`fact`、`after`。消费晚了也不读当前状态去猜当时，消费者不再自己跑一遍 `reduce`。`transitions` 同一步里拿初始快照和订阅，中间不漏事实。`Transition` 拿着旧状态的引用，所以 **`reduce` 不改传进来的旧值**。
- **一批是一次提交**（`apply(...facts)`）：先在局部状态上逐条折、收集 `Transition` 和特效，再一次换掉可见的状态、安排存盘，最后按原顺序逐条发事实、再发特效。每条 `Transition` 的 `after` 是这一条的结果，不是整批的最终状态；`state()` 和 `/state` 只看得到整批。HTTP 的事件格式不变，仍是一条一条的 `Fact`。种植计划的父子工单（工单服务一次写完的那组）走这条路。
- **一批不代替数据库事务**：拥有者先提交数据库事务，再发核心状态；两者之间的恢复归拥有持久化的那个模块。
- **主人做了、但不改状态的事不是事实**：看收成清单、语音接上，由经手的服务调 `Core.did`，只有游戏的账本听（`owner`）。
- **给人看的话只在出帧时填**：`frameOf(state, effects)` 在状态的副本上填帮工在干什么（`phaseText`，在做的动作和这一轮每一步的 `actionText`）、定时什么时候跑、计划和节点的状态、动作叫什么、现在能做什么，再算 `inbox`、`graphs`、`view`（地块、等级、每个成就的进度）；`reduce` 和 `state.json` 里没有这些话。改的是副本：阶段和 `play` 的历史复制一份再填，`Transition` 拿着的旧状态不变。特效由 `effectsOf(折之前的状态, fact)` 算，到一档成就的特效带着它的说法。动作的说法（`seeds.json` 的 `actionText`）页面不另拿一份：帧里的这两处，加上干活过程里每个 `tool/call` 写下时带的 `actionText`（[帮工](docs/subsystems/session.md)），就是它全部的来源。

**`state.json`**

- **存除了田头、进度、定时、工单以外的全部**（`toKeep` 清掉 `chat`、`progress`、`schedules`、`issues`）：它们的家是库，开机由拥有者从库里放回核心状态。工单只放开着的和最近关的 50 家（`keepClosedIssues`）。只有服务端要的（会话 id、worktree、原话）在 `sessions.json`，干活过程、diff 这类大块的旁路数据不进核心状态。
- **合并写**：从第一条变化起算 500 毫秒写一次，持续有事实也不推迟这一次；一次崩溃最多丢半秒。写的是临时文件再改名（`base/files.ts` 的 `FileWriter`），不会留下半个文件；写不了记日志，不停服务。
- **关时写最后一份**：关的时候停掉等着的那次，写最后的状态并封住，已经在路上的定时回调写不进来。`core` 最先建、最后关，所以最后一份是所有服务都停下之后的。
- **读回时**：读不了或解析不了就从空的开始并记日志；通话回到 `idle`、没有通话原因、管家回到 `idle`（没人在通话上，管家也不在说话），帮工的地块按 `withStations` 重新排。

**三条流**（`http/streams.ts`；「连接到本机」按同样的三个路径放行）

| 流 | 连上先发 | 之后发 | 谁读 |
|---|---|---|---|
| `GET /api/v1/state` | 一帧 `StateFrame` | 一条事实或特效到了，再收 200 毫秒，合成一帧（带这段时间的特效）；不是事实的旁路事件不出帧 | 页面、`vibevalley state` |
| `GET /api/v1/events` | `snapshot`（整份核心状态） | `SideEvent`：每条事实、轨迹的一步（`step`）、提醒（`Notice`）、农机变了（`runtime`） | 命令行 `vibevalley events`、调试 |
| `GET /api/v1/live` | 什么也不发 | `LiveEvent` 的三种：`SessionEvent`、`Notice`、`Runtime`；不发事实和快照 | 页面 |

- 每 20 秒一行心跳（`: ping`），免得代理关掉空闲的连接；客户端断开，这条流和出帧的那一头跟着停。
- 断线不补发：重连从一帧（或快照）重新开始。页面的状态流断了 1 秒后重连。
- 命令的结果不走流：要么是 HTTP 的答复，要么是之后的事实或提醒。

**接口和能力表**

- **一个操作是 `endpoints` 的一行**：操作名（`组.动作`，页面里是 `api.组.动作`）、方法和路径、路径和查询参数、请求和回答的 Schema、`can`（谁能调）。`can` 的取值封闭：`owner`（这台电脑上的页面、命令行）、`remote`（「连接到本机」后配对过的设备）、`manager`。`Handlers` 由这张表推出，`handlers.ts` 少实现一个就编不过。读写不另标，HTTP 方法已经说明。全部操作见 [capabilities.md](docs/reference/capabilities.md)。
- **「连接到本机」只放 `can` 有 `remote` 的操作和流**（`remoteMay`），没有匹配的路径一律拒绝；`/mcp` 和 `/v1/chat/completions`（`chatCompletionsPath`，管家的 OpenAI 协议入口，放在 `/api/v1` 外面）永远不放。`can` 写错就是权限写错，改 `remote` 时在改动里单独列出。
- **`manager` 一列只是记录**：代码不按它放行，管家和帮工能调什么由 `apps/server/src/tool` 的工具表定。
- **都在 `/api/v1` 下**，包括 `/api/v1/health` 和三条流。`endpoints` 里的路径就是最终路径，页面的客户端、命令行、能力表和「连接到本机」都从它来，没有第二处拼前缀。不设 `/api/...` 的别名，旧客户端拿到 404。加字段、加接口留在 v1；不兼容的改动另起 `/api/v2`，v1 留到主人的设备都升上来。`/mcp` 不带版本：MCP 有自己的版本。
- **命名五条**：组是概念（`lan`、`game`、`channel`）；动词一套 `list`、`get`、`create`、`update`、`delete`，`save` 只给带 id 的整份写入（编辑、导入），`check` 只校验，领域动词只给不是增删改查的；工单的生命周期挂在工单上（`issue.status`）；一个意图一个操作，不用布尔开关兼两件；`update` 只改给出的字段，路径里的 id 算数。
- **一条规则，差别作为参数**：入口之间的差别传进服务，不写成两个方法。例：工单的收成清单收「谁在看」，主人看才算进游戏。

**命令行是皮**

- `vibevalley <组> <操作> [路径参数] [--json 请求体|-]` 经 HTTP 调服务端，不自己打开 `vibevalley.db`；连哪个服务端是 `--server`、`VIBEVALLEY_SERVER`，默认 `http://127.0.0.1:8787`。命令表从 `endpoints` 来，每个操作都有命令。
- 手写的只有组合命令：`state`（`/state` 的帧）、`events`（一直看 `/events`）、`issue run <id>`（挪到待办，等它交回来，打出改动）；和不经服务端的本机工具 `runtime chat`。直接聊不算农场的活：没有工单，不进核心状态、轨迹和花费。

**拥有者负责协调和结果**

- **调用方交意图，顺序在拥有者里面**：处理函数给工单 id 和动作，不先查最新的帮工、判状态、拼评论；收获的调用方不安排停止写入、合并、离场。新加的抽象要让调用点删掉协调代码，只搬文件、加一层同样复杂的转发不算。
- **提交的结果属于动作本身**：保存失败沿动作返回，转发时不变成成功；依赖它的通知、叫醒、清理只在保存成功后做；档案和设置先存盘再发布内存里的结果。
- **资源由持有者收尾**：派活的容量在 Session 里检查；关联失败释放新开的资源。跨 git、SQLite、开执行的失败不包成一个事务：已经合了而库没存上，照实报告做到了哪一步，分支留着。
- **创建返回自己的身份**：服务端分配 id，和持久化在同一把锁里提交（`channel.create` 返回频道 id；`agent.create`、`skill.create` 拒绝非空 id，带 id 的 `save` 仍是 upsert）。
- **查询带齐真实的关联**：`issue.history` 只给真有的执行，找不到的明列在 `missingSessions`，不补造一个「歇着」的执行。

**开机顺序**：全部服务建好、开机的活（`start`、`ready` 这类 layer）跑过以后开始答 HTTP；开机就派出去的执行要的 `/mcp` 地址在开始听之后才交给 `Sessions`（[地基](docs/subsystems/foundation.md)）。

## 怎么走

**一条事实**：

1. 拥有者改完自己的家（库或文件），调 `Core.apply(fact)`，相关的几条一起给。
2. `Core` 盖时间、`reduce`；没变就到此为止。
3. 换掉可见状态，安排 500 毫秒后的存盘。
4. 按顺序发：`/events` 的订阅者收到事实，`facts` 的订阅者收到事实，`transitions` 的订阅者（账本、种植计划）收到前后状态；然后发特效。
5. `/state` 的每个连接在 200 毫秒窗口后用 `frameOf` 出一帧推给页面。

不改状态的旁路事件（`SessionEvent`、`Notice`、`Runtime`）不经 `reduce`，直接发到 `/events` 和 `/live`。

**重启时怎么回来**（[理由](docs/subsystems/session.md#为什么这样)「重启不丢农场」）：

1. `Core` 建的时候读 `state.json`：帮工、commit 数回来，通话和管家回到 `idle`，地块重排。
2. 各拥有者在构造时从库里施加事实放回核心状态：工单（开着的和最近关的 50 家）、田头的频道和最近的对话、定时。这时还没有订阅者，这些事实不算进游戏。
3. 全部服务建好以后，开机的活接手：帮工回到各自的地上歇着，停在半路的那一轮记成 `interrupted`（[帮工](docs/subsystems/session.md)「重启」）；定时补跑错过的（[定时](docs/subsystems/schedule.md)）。
4. 其余各拥有者自己恢复，次序不相干：种植计划跟着工单回来：停在拆的放弃，有件在做的暂停（[种植计划](docs/subsystems/task.md)「重启」）。
5. 田头里交出去还没看到的消息退回 `pending`，过一会儿再叫（[田头](docs/subsystems/channel.md)）；管家没做完的一轮接着做（[管家](docs/subsystems/manager.md)「重启后接着做」）。
6. 账本整本重折出金币、连胜、成就，规则改了重启就按新规则算（[游戏](docs/subsystems/game.md)）。

**加一个能力**：写服务的方法 → 在 `api.ts` 的 `endpoints` 加一行（方法、路径、Schema、`can`）→ 在 `handlers.ts` 实现 → `bun run capabilities`。页面的客户端、命令行的命令、「连接到本机」的放行都从同一张表来。

## 和谁打交道

- **施加事实的**：工单、帮工、田头、定时、管家（`setManager`）；`manager.open`、主人说话、语音和连接器经 `open`、`setCall` 让通话在线；游戏（commit 数、`progress`、`station`）。它们都排在 `core` 后面，`core` 只用 `base` 和 `packages/protocol`。
- **订阅的**：游戏的账本和种植计划读 `transitions`；别的读 `facts`、`events`；账本另读 `owner`。
- **读的**：任何服务用 `state()`、`session(id)` 读当前值；`http/streams.ts` 把三条流交给页面。
- **外面**：页面读帧和窄流、调 `VibeValleyApi`；命令行按 `endpoints` 发 HTTP；「连接到本机」后的设备经同一套接口，由 `lan` 按 `can` 放行。

## 为什么这样

- **核心状态只有一份，只因事实而变。** 一个帮工的状态曾经拆在服务端的行、站点里的一份行副本、页面从行推出来的作物、管家读的名册四处：每加一个功能（花费、冲突）就在几处各补一个字段；「没动静」只有管家看得到；冲突标记靠「开始干活时顺手清掉」这种副作用维持；页面比较前后两行来猜「开始了新一轮」。一份状态、一个纯函数折，新加一种状态只在 `shapes.ts` 加字段或事实、在 `reduce` 里折，编译器逼每个视图都处理到；服务端和页面不会对不上，重启只是读回上一份。放弃了「保留行模型、只补字段」：这正是要解决的问题。代价是拿一个状态要经过 `reduce`，不能随手改一个字段。
- **线上发事实，不发 JSON patch。** patch 只说哪个字段变了，看不出发生了什么（开始一轮还是改了标签）；账本、特效、种植计划要的正是「发生了什么」。
- **页面读折好的帧，不折事实。** 页面再折一遍就是第二份核心状态，两边改规则靠自觉对齐（[客户端](docs/subsystems/app.md)）。给人看的话在出帧时填，不进 `reduce`：话随时会改，存进 `state.json` 就要兼容旧话。动作的说法也一样在帧里带好，页面不另拿一份。不变的大块说法（成就的定义）不进帧，帧每个事实都出，一次性的接口给一次就够（[游戏](docs/subsystems/game.md)）。
- **每条事实带自己的前后状态，一批一次提交。** 放弃了「子工单先发、父工单最后发」的约定：排序不能把几次可见的更新变成一次，读的人仍会看见半个计划。放弃了每条事实都附整批的最终状态：第一条事实会背上后面事实的变化，按事件做的规则失去因果。放弃了对外的「一批事实」类型：现有的消费者都认得单条事实，内部的提交和订阅保证就够。
- **命令走 HTTP，状态走 SSE。** 放弃了 WebSocket：命令已经有类型化的 HTTP 接口，事件只往一个方向走；SSE 重连又从快照开始，不用写补发。放弃了轮询：帮工的动作一秒好几次，轮询要么慢要么费。代价是事件里不能顺带回复命令。三条流分开：`/state` 让页面不折事实；`/live` 让页面不必收它用不上的快照和事实；`/events` 保留整份事实流给命令行和调试。
- **重启不丢农场，也不自动接着干。** 见[帮工](docs/subsystems/session.md#为什么这样)：全部收工丢掉没合的活，自动接着干可能重复执行和花钱。核心状态在这里的部分是：读回 `state.json` 就是重启，不另写一套恢复。
- **接口带版本，版本在路径里。** 客户端不一起升级：桌面应用和服务端一起换，经「连接到本机」连的设备什么时候升由那台设备定；没有版本时要么形状只加不改（锁死改名），要么所有设备同一天升级（做不到）。放弃了请求头里的版本：curl、日志、「连接到本机」的放行表都要多一层解析；放弃了每个操作自己带版本：同一个概念散在几个版本里；放弃了 `/api` 当 v1 的别名：两个名字要一直维护，也分不清谁是新客户端（[不留兼容](docs/subsystems/foundation.md)）；放弃了网关映射：本机前面没有网关。v1 不能在设备升级前删，这是唯一明确的兼容负担。
- **先有能力，再有入口，能力表和接口写在同一处。** 农场能做的事曾从七个入口各接一遍：没有命令行；「连接到本机」放什么在它自己的代码里写死；同一件事几个入口规则不一样（派活一条路排队、一条路拒绝）；加一个能力要接好几处，漏了也不报错。`can` 和接口写在 `endpoints` 的同一行里，少了它类型就不对。放弃了另放一个 YAML：加操作时会忘了改它。放弃了手写命令行：它会是第八个各自接一遍的入口。放弃了命令行直接开数据库：服务端开着时就有两份核心状态。放弃了管家的工具、MCP 也从接口生成：模型要的参数和说明和给程序的接口不是一个形状，硬生成会变差。
- **拥有者负责协调和结果。** 放弃了只在 HTTP 入口查失败：计划自动推进、定时和管家不都经过 HTTP，修在拥有动作的模块里，所有调用方得到同样的结果。放弃了把 git、SQLite 和开执行包成一个事务：它们没有共同的提交机制，一个事务的名字只会盖住跨资源的失败。放弃了为每个小步骤加接口和把只有一个实现的存储、回调改成通用接口：前者把顺序推回调用方，后者只增加导航成本。
- **创建由服务端分配身份，查询不补造。** 客户端扫列表分配 id、保存前查重，查和写是两次请求，两台设备用同一份旧列表仍会写到同一个 id。缺执行记录时补一个「歇着」的执行，会把「记录没了」变成「在歇着」，按钮和统计照着不存在的阶段工作。

## 还没做的

- 按概念分模块、农场只画它们的整体方向：[概念先行，农场是皮](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)。
- `can` 只留 `owner`、`remote`，agent 能调什么写在档案上；管家派活先写工单、满了排队：[管家是一份档案，只是能力多](.agents/notes/proposed/architecture/2026-10-17-manager-is-an-agent.md)。

## 怎么验证

- `apps/server/src/core/core.test.ts`：从 `state.json` 读回（通话和管家回到 `idle`、库的部分不进文件、帮工回到各自的地）；事实盖时间、发出，同样的再来一次不算新闻，关的时候写 `state.json`、不带给人看的话；一阵事实合成一帧。
- `packages/protocol/src/rules/golden.test.ts`：几千个随机事实逐个比状态、特效和视图（`reduce.jsonl.gz`）；`schedules.test.ts` 查折法和出帧填的话。
- `apps/server/src/cli.test.ts`：每个接口都有命令、调一个接口打出回答、说命令哪里不对。`lan/lan.test.ts`：「连接到本机」按 `can` 放行。
- 契约：`apps/web/test/*.spec.ts` 每个 worker 起一个真的服务端，经接口和三条流走一遍每块页面。
- 能力表：`bun run docs:verify`（`scripts/capabilities.ts --check`）。
- 真的服务端照 `verify-server`：`GET /api/v1/health` 200、`GET /api/health` 404、`vibevalley state` 读到一帧。
