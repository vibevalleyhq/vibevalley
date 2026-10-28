# Agent Note: 编排层：每个 agent 一个信箱，什么时候交给它只在一处定

Status: proposed

## Problem

给 agent 的话（频道里的消息、交给管家的工单、到点的定时、巡查的发现、计划的进展、外面聊天软件和电话里的话、帮工的汇报）什么时候、以什么方式交到 agent 手里，现在没有一个地方说了算。2026-10-18 数下来：

- **入口至少 7 条，各走各的**：频道投递（`channel/chat.ts` 的 `kicked`）、工单交给管家（`orchestrator/orchestrator.ts` 的 `forOrchestrator`）、定时（`issue/issue.ts` 的 `scheduled`，忙着的帮工直接 `session.Deliver`，绕开频道）、巡查（`orchestrator/orchestrator.ts`）、计划（`tool/tool.ts` 的 `tellOrchestrator`）、连接器（落库后重新走 `channel.Say`）、电话和听写（`orchestrator.Call`，直接插进管家，频道里只留记录）。
- **「插话还是排到这一轮之后」写了三遍，判断依据各不相同**：频道给帮工的（`session.Deliver` → oar 的 `steerOrQueue`，看农机能不能插话）、频道给管家的（`heardInChat`：只有主人的话插话）、管家的脑子（`orchestrator.sendInput` 在 `brain.Send` 和 `brain.Later` 里二选一）。
- **节奏散在七个包里，互相不知道**：忙时攒 3 秒合成一条提醒（`channel` 的 `NoticeBatchMs`）、同一个人 60 秒内不再叫（`AgentWakeCooldownMs`）、帮工互相 @ 超过 4 跳挂起（`HopLimit`）、叫三次都没起来就不叫了（`WakeBreaker`）、巡查每 10 分钟扫一遍（`orchestrator/orchestrator.ts`）、定时每 20 秒看一次（`cron`）、排队的工单每 5 秒找一次空地（`issue/issue.ts`）、管家把这期间的汇报和农场现状拼进一条输入（`orchestrator.news`、`situationNow`）。同一个「攒一批再给」的想法写了四遍，单位和条件都不一样。
- **管家和帮工收话是两套**：帮工经频道投递（`channel_delivery` 表记着谁该收、收没收到），管家经五个 `base.Hub` 订阅，什么也不存，重启前没处理的就没了（巡查过后会再报，计划和工单的消息不会）。

结果：想改一条节奏规则（比如「主人的话总是插话」「帮工忙时别一条一条打断它」），要先找到它在哪几处各写了一份；加一个新入口（比如再接一家聊天软件，或者让领班收到它派出去的工单的进展），又要再写一遍「叫不叫、什么时候叫、怎么叫」。

## Proposal

**在 agent 之上加一层编排：每个 agent（管家和每个 Session）有一个信箱；所有给 agent 的话都投进信箱；什么时候、以什么方式把信箱里的东西交给 agent，只由编排层按一张规则表定。** agent 自己只管一次处理一轮。

做法照 [Hermes Agent](https://github.com/nousresearch/hermes-agent)（看的是 2026-06-11 的 `db7714d`）的网关（`gateway/run.py` 的 `GatewayRunner`）：一个会话同时只跑一轮（`_running_agents`），新来的话先进这个会话的待办（`_pending_messages` 一个槽加 `_queued_events` 溢出，最多 32 条），忙时怎么办只在一个函数里定（`_handle_active_session_busy_message`：`interrupt`、`queue`、`steer` 三种）。我们比它多一件事：频道里有好几个 agent，所以「谁该听到」（频道的规则）和「什么时候交给它」（编排层）要分开。

### 1. 名字

| 名字 | 是什么 | 不是什么 |
|---|---|---|
| 信箱（`Mailbox`） | 一个 agent 还没处理的话，按到达的先后 | 不是 `protocol.Inbox`：那是「要主人处理的事」，从核心状态现算，名字留给它 |
| 一封（`Mail`） | 信箱里的一条：给谁、从哪来（`Source`）、正文、指向的消息（有的话）、急不急（`Urgency`） | 不是频道消息：频道消息是大家看得见的话，一封是「这条要交给这个 agent」 |
| 编排层（包 `apps/server/src/mailbox`） | 收信、按规则决定什么时候交、交出去、记下交没交到 | 不决定谁该听到（频道的 `chatAudience`），也不决定能不能开工（Session 的同时干活上限） |

农场里画成：帮工头顶的信封、管家桌上的信件堆。

### 2. 一封信从哪来

| 来源（`Source`） | 现在怎么进 agent | 以后 |
|---|---|---|
| `chat`：频道里给它的话 | `channel` 写 `channel_delivery`，`kicked` 叫醒 | `channel` 算出收件人后投一封；`channel_delivery` 只记「谁该收到」，叫醒的部分归信箱 |
| `owner`：主人对它说的话（频道里、聊天软件、电话） | 各自判断插话 | 投一封，急 |
| `issue`：交给它的工单、到点的定时 | 管家经 `forOrchestrator`；帮工经 `session.Deliver` | 投一封 |
| `report`：帮工的汇报 | 写进工单串，没做成的叫醒管家 | 投给管家一封，做完的不急 |
| `patrol`：巡查的发现 | `PatrolNews` Hub | 投一封，不急 |
| `task`：种植计划的进展 | `task.news` Hub | 投一封，不急 |

连接器和电话不另开一条路：它们产生 `owner` 来源的信。电话要的低延迟由「急」保证，不由绕开信箱保证。

### 3. 急不急：一张规则表

每封信有一个 `Urgency`，由来源和收件人此刻的状态算出来，规则是 `mailbox` 包里不导出的纯函数，一处：

| `Urgency` | 收件人空闲时 | 收件人正在跑一轮时 |
|---|---|---|
| `interrupt` | 开一轮 | 停下这一轮，带着这封开新的一轮（主人点「停」、电话里说「停一下」） |
| `steer` | 开一轮 | 插进这一轮：等这批工具调用做完，作为补充交给它；这一轮里没来得及交的，顺延成下一轮的开头，不丢 |
| `queue` | 开一轮 | 这一轮结束后，和排在一起的合成一轮的输入 |
| `digest` | 攒到一个窗口（几秒到几分钟，按来源）再合成一轮 | 同 `queue`，但不单独叫醒：只跟着下一次叫醒一起交 |

默认表（初稿，评审时定）：

| 来源 | 给管家 | 给帮工 |
|---|---|---|
| `owner` | `steer` | `steer` |
| `chat`（@ 它、它的工单串） | `queue` | `steer`（农机不能插话时 `queue`） |
| `chat`（跟着的串、频道里没 @ 的） | `digest` | `digest` |
| `issue` | `queue` | `queue` |
| `report` 没做成 | `queue` | — |
| `report` 做完 | `digest` | — |
| `patrol`、`task` | `digest` | — |

- 照 Hermes 的保护：收件人手上有正在跑的子活（管家或领班派出去、还没交回的），`interrupt` 降成 `queue`，一句追问不该打断整串活。
- 插话的落点照 Hermes 的 `steer`：不是随时塞进去，而是在这一批工具调用结束、下一次请求模型之前，作为补充交出；VibeValley 自己的 agent（`packages/agent`）按这个时机做，外部农机能插话的交给 oar 的 `steer`，不能的退成 `queue`。

### 4. 交出去：每个 agent 一个泵

编排层给每个有信的 agent 跑一个泵：

1. 收件人空闲且信箱里有该交的：把该交的合成一条输入（照现在管家的做法：按来源分段、长汇报截断并写明去哪读全文），交出去开一轮。
2. 收件人在跑：按上表决定插话、等这一轮完，或停下这一轮。
3. 这一轮结束：回到 1。

交给谁由收件人定，信箱不知道 agent 怎么跑：

- **Session**：开一轮、插话、排到这一轮之后，都经 `session.Service`（现在的 `Deliver` 拆成这三个动作）；能不能开（同时干活的上限）仍由 Session 定，开不了的信留在信箱里，有空地了再交。
- **管家**：常驻（[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md) 第 4 节的「常驻」），管家包在开机时把自己的三个动作交给编排层（`mailbox` 排在 `orchestrator` 前面，往上走 `base.Hub` 或注册一个收件的接口）。`orchestrator.ask`、`send`、`heardInChat`、`onWork` 和那五个 Hub 订阅都不要了。

### 5. 节流和熔断都搬进编排层

冷却（60 秒）、跳数（4）、叫醒熔断（3 次）、叫醒失败重试、忙时攒一批的窗口，现在在 `channel` 里，只管帮工；搬进 `mailbox` 以后对管家和帮工一样，参数放在一张表里。

不搬的：

- 「谁该听到」（`chatAudience`：@、工单串、跟着的串、频道）留在 `channel`：这是频道的规则。
- 同时干活的上限（工作区、农机、项目三层）留在 `session`：这是开工的规则。
- 排队的工单找空地（`issue` 每 5 秒）留在 `issue`：那是派活，不是交话。
- agent 自己的 Task 里帮手做完了交回结果，是 `packages/agent` 自己一个进程里的事（[Task：一张按 DAG 推进的活](.agents/notes/proposed/architecture/2026-10-18-tasks-are-dags.md)），不经信箱；它和信箱共用一条规则：有帮手在跑时，新来的话不打断这一轮。
- 定时的时钟（`cron` 每 20 秒）留在 `cron`：到点只是投一封信。
- 巡查留着它的「过了宽限期才报」的规则，只把报的方式换成投信；以后可以只是一种 `digest`。

### 6. 存不存

- 第一步不改表：信箱在内存里，频道来的信照旧以 `channel_delivery` 为准（重启后从它重建），别的来源和今天一样重启就丢。
- 第二步：信箱落库，一张 `mailbox_mail`（模块 `mailbox`、概念 `mail`），`channel_delivery` 里关于叫醒的列（`wakes`、`held_by`、`handed`）挪过去，它只剩「谁该收到、读没读」。要等另一个会话的迁移（`0002`–`0004`）提交以后再加。

### 做的顺序

1. `apps/server/src/mailbox`：`Mail`、`Urgency`、规则表、每个 agent 的泵；Session 一侧把 `Deliver` 拆成开一轮、插话、排到后面三个动作；`channel` 改成投信，节流和熔断搬过来。行为对照现在的测试不变，除了默认表里有意改的几格。
2. 管家接上：五个 Hub 和 `heardInChat`、`onWork` 换成信箱；电话、听写、连接器都投 `owner` 的信。
3. 落库（第 6 节第二步）。
4. 客户端：每个 agent 的信箱有几封、最早的等了多久，进核心状态，农场里画出来。

## Alternatives considered

**什么都改成频道消息，`channel_delivery` 就是信箱。** 巡查、计划、工单交给管家都发成默认频道里的系统消息，投递表天然就是信箱，概念最少。不选：主人的默认频道会被这些刷屏，而且「交给管家的一条输入」和「大家看得见的一句话」不是一回事：管家自己的输入不该出现在群聊里。

**每个包保留自己的节奏，只抽一个公共的节流器。** 改动最小，四份「攒一批」能合成一份；但「插话还是排队」的三套判断和七条入口还在，加入口时照样要选一套抄。

**照 Hermes 默认 `interrupt`：新话来了就打断这一轮。** 对聊天机器人合适：用户追问通常意味着前一个回答不要了。编码的一轮往往在改文件、跑测试，打断的代价大；我们默认插话，只有主人明确要停才打断。

**用一个消息队列中间件。** 单机、单进程、只听 127.0.0.1，一个进程内的队列加一张表就够；Hermes 也是这样做的（一个槽加一个溢出列表）。

## Acceptance criteria

- `channel`、`orchestrator`、`issue`、`cron`、`task`、`connector`、`voice` 里没有直接叫醒 agent 的代码：都投信；`session.Deliver` 和管家的 `ask`、`send` 只被 `mailbox` 调。
- 「插话、排队、攒一批、打断」只在 `mailbox` 的一个纯函数里决定，有表驱动的测试覆盖默认表的每一格；加一个 `Source` 不处理时测试失败（照「封闭的联合穷尽处理」）。
- 冷却、跳数、熔断、攒一批的参数在一处，对管家和帮工都生效，有测试。
- 管家有正在跑的子活时，`interrupt` 变成 `queue`，有测试。
- 插话没来得及交的，下一轮开头能看到，有测试。
- `bun run server:check` 通过；照 `acceptance/server.md` 在真服务端上：帮工忙着时在它的工单串里连说三句，它在这一轮里收到一次补充，而不是三次。

## Risks

- 这是投递的主干，改坏了话就丢了或叫重了。第一步只搬不改：先让现有测试原样通过，再一格一格改默认表。
- 管家的提示开头要保持不变（[提示开头不变](docs/subsystems/orchestrator.md)）：信合成输入的格式变了，开头不能跟着变；改完跑 `acceptance/orchestrator-evals.md`（要花钱，先问主人）。
- 插话的落点在「一批工具调用之后」，比现在的「马上」慢；对正在跑长命令的帮工，主人的话可能要等这条命令跑完才被看到。真不能等的用 `interrupt`。
- 信箱在内存里的第一步，重启会丢掉非频道来源的信，和今天一样；落库前不要指望它可靠。
