# Agent Note: 把 agent 当人：角色只管职责

Status: proposed

## Problem

一个 agent 档案就是农场里的一个人。管家和帮工是他的职务（`T.AgentRole`：`orchestrator`、`worker`），职务决定他能做什么、该做什么；他是哪种人、怎么上班、在哪说话，不该都从职务推出来。

代码现在拿 `orchestrator` 这个词说五件事，只有第一件是职务（2026-11-09 按语法树数，服务端、protocol、agent 包，不含测试：40 个名字带 orchestrator，按角色字面量分支的有七十多处）：

| # | 实际说的 | 代码里的样子 |
|---|---|---|
| 1 | 职责：能用哪些工具、能不能生图、能不能被派去改代码 | `asOrchestrator`、`orchestratorBlock*`、`caller.kind === "orchestrator" && forOwner`、`dispatch.ts` 拒绝把管家当帮工派 |
| 2 | 上班的方式：一直当值（会话 id 就是档案 id，开机就在），还是按活雇来、干完离场 | `registerOrchestrator`、`newsOf` 只给 `worker` 发 `Hired`、恢复时跳过 `orchestrator` 的行、`workers()` 按角色筛 |
| 3 | 在哪干：服务端进程里（`Session.host`），还是外面的农机（`hire`，一次次 launch） | 泵里 `if (isOrchestrator(recipient))` 走 `Mailbox.news` 的 `Handed`，别的走 `Session.deliver` |
| 4 | 一个地方有谁：没点名的话谁接 | 列 `channel.orchestrator`、私聊的 `peer_id`、`orchestratorOfRow`、`setOrchestrator`、Mailbox 的 `orchestratorOf` |
| 5 | 话是谁说的 | `ActorKind = owner \| orchestrator \| session \| system`：`session` 是会话，`orchestrator` 是职务，不在一个维度；`brakes.ts` 得拼 `isAgent = session \|\| orchestrator` |

第 2、3 件今天和职务绑在一起（`Agent.roleProblem`：管家只跑在 VibeValley 自己的 agent 上，在服务端里），所以到处写 `isOrchestrator` 问的其实不是职务。后果：

- **同一条规则写了三遍**：「频道归谁负责」在 `channel/hub.ts` 的 `orchestratorOfRow` 按内存里的频道算，在 `db/queries/channel.sql` 的 `OrchestratorForChannel` 递归算，Mailbox 的 `orchestratorOf` 再写一遍兜底（`own && isOrchestrator(own) ? own : defaultOrchestrator`）。
- **名字只说了职务，没说做的事**：`registerOrchestrator`（让他当值）、`orchestratorSays`（当值的人一整条说完）、`isForOrchestrator`（工单交给当值的人）、`beginOrchestrator`、`toOrchestrator`、`recordOrchestratorStart`。
- `defaultOrchestrator` 散在 8 个模块里，都是「频道没人负责时谁兜底」。

## 名字

照人在团队里怎么说来起名；职务只在第 1 件事上出现。

| 概念 | 名字 | 取代 |
|---|---|---|
| 农场里的一个人 | agent（档案 `T.Agent`） | — |
| 他的职务 | role：`orchestrator`（管家）、`worker`（帮工） | — |
| 一直当值的人的那个会话 | 当值 on duty：`keepOnDuty(profile)`（帮工模块内部），`isOnDuty(who)` | `registerOrchestrator`；按 `role === "orchestrator"` 判会话怎么来的地方 |
| 按活雇来的会话 | hired：`Session.hire`、`Hired`（已有），`isHired(who)`，`Session.hired()` | `role === "worker"` 问会话怎么来的地方；`Session.workers` |
| 在服务端进程里干活 | hosted：`Session.host`、`AgentHost`（已有），问法 `isHosted(id)` | 泵里的 `isOrchestrator` |
| 在农机上干活 | launched：`launch`（已有） | — |
| 一个地方有谁 | 成员 members：频道和串都记在 `channel_member`；私聊是对面 | 频道的「负责人」（列 `channel.orchestrator`、`orchestratorOfRow`、`OrchestratorForChannel`、`setOrchestrator`） |
| 这里的管家（泛称的 @管家、没指定人的活、没人收的事交给他） | `orchestratorIn`（`mailbox/envelope.ts` 一处），`T.Channel.orchestrator` 是它算出的结果 | Mailbox 的 `orchestratorOf`、频道的 `orchestratorOf` |
| 话是谁说的 | `ActorKind = owner \| agent \| system`，agent 带 `role` | `orchestrator`、`session` 两种 actor |

「当值」和「hosted」今天都由职务推出来，但只在一处推：`isOnDuty`、`isHosted` 各定义一次，别处都问它们，不再自己看 `role`。以后有不当值的管家或在进程里干活的帮工，只改这两处。

## Proposal

一步一个提交，每步之后 `paths:check` 的表、`stale-names` 跟着改：

1. **当值。** `registerOrchestrator` 改名 `keepOnDuty`；`isOnDuty(session)` 定义在帮工模块一处，`newsOf`、恢复、`workers()`、`history`、`assignment` 里问会话怎么来的地方都问它。
2. **频道有成员，没有负责人。** 私聊是有对面的频道；串有跟帖的人（`channel_member`）；普通频道也用 `channel_member` 记成员，只有管家能放进来，新频道和默认频道一开始就有默认管家。没点名的话和汇报发给成员；一个成员都没有，要 @ 才有人接。「这里的管家」由 `orchestratorIn` 一处算（私聊的对面，或成员里的默认管家、第一个管家，都没有就是默认管家），频道和 Mailbox 共用。
3. **在哪干。** 泵的端口 `isOrchestrator` 改 `isHosted`，由帮工模块定义一次。
4. **名字只说职务的。** `orchestratorSays`、`isForOrchestrator`、`beginOrchestrator`、`toOrchestrator`、`recordOrchestratorStart` 按它们做的事改名（交给当值的人、当值的人一整条说完）。
5. **话是谁说的。** `ActorKind` 收成 `owner | agent | system`，agent 带 `role`。改 protocol 形状和页面，单独一步，放最后。

改名用 tsgo 的 LSP 重命名，SQL、列和字面量用 ast-grep 限定文件改；每步跑 `vp check`、`server:check`、`effect:check`、`practice:check`、`paths:check`、`docs:verify`，碰页面的跑 `web:check`。

## 进度

| 步 | 状态 | 提交 | 做了什么 |
|---|---|---|---|
| 1 当值 | 完成 | `edf285f44` | `isOnDuty`、`isHired` 在 `session/roster.ts` 各定义一次（两个都正着写：黄金数据里有没带 `role` 的会话，取反会把它们算成雇来的）；`keepOnDuty`；`Session.workers` 改叫 `hired` |
| 2 频道有成员 | 完成 | `6e3bdacff` | 删掉频道负责人；`channel_follow` 改名 `channel_member`，频道和串的成员都记在这里（投递原因 `follower` 改叫 `member`）；`orchestratorIn`；页面勾选成员 |
| 3 在哪干 | 未做 | — | |
| 4 名字只说职务的 | 未做 | — | |
| 5 话是谁说的 | 未做 | — | |

## Alternatives considered

- **只改 `registerOrchestrator` 一个名字。** 问题在五件事共用一个词，只改一处，剩下的地方还会照着 `isOrchestrator` 写。
- **给频道换个名字的负责人（keeper、inCharge）。** 一个频道不必有人负责：私聊天然有对面，串有跟帖的人，普通频道照人在群里的样子有成员；负责人只是把私聊的对面硬推到了频道上（主人 2026-11-09 定）。
- **把「这里的管家」放进核心状态，Mailbox 读状态。** 状态只留 100 个频道（`keepChannels`），串可能不在里面，靠不住。
- **给会话加 `onDuty` 字段。** 今天它总等于 `role === "orchestrator"`，加字段是存两份同一件事；先用一个函数说清楚，真有不同时再加。

## Acceptance criteria

- 服务端代码里 `isOrchestrator` 只出现在职责的判断上（工具、权限、能不能派去改代码）；会话怎么来、在哪干、频道归谁，都问 `isOnDuty`、`isHosted`，这里的管家问 `orchestratorIn`。
- 频道没有负责人：列 `channel.orchestrator`、`OrchestratorForChannel`、`orchestratorOfRow` 不在了；没点名的话发给成员；「这里的管家」只有 `orchestratorIn` 一个规则。
- 名字表左列取代掉的名字由 `scripts/stale-names.ts` 拦着。
- 各项检查通过；改了的 `regression:` 测试在 PR 正文点名。

## Risks

- **频道成员会碰页面。** 频道设置从单选管家改成勾选成员，成员面板改读 `members`；跑 `web:check` 和页面的集成测试。
- **第 5 步动的面最大**（消息、触发、刹车、页面的头像和名字），单独提交，先列出所有读 `fromKind`、`actor.kind` 的地方再改。
