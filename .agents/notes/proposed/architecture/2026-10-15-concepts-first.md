# Agent Note: 概念先行，农场是皮

Status: proposed

## Problem

VibeValley 是从农场往里长的：先有农场、地、帮工、收获，再往里接编码 agent。所以代码里很多东西按皮起名、按皮组织。主人的说法是：VibeValley 其实是一个类似 [Multica](https://github.com/multica-ai/multica) 的开发助手，外面包一层游戏的皮，应该从实际出发。

按皮组织带来三个问题：

- **核心概念不清**：最核心的工单，在代码里分在三处（待办 `BacklogItem`、执行 `Helper`、轨迹头 `TrajectoryHead`），id 中途会变，状态要客户端自己推。
- **皮漏进了核心**：核心状态 `FarmState` 里有金币、成就、算等级用的提交数和地块位置；执行和群聊直接往账本里记事，执行合并后还直接让提交数重数一遍。
- **名字误导**：读代码的人和 agent，从 `farm`、`FarmState`、`Site`、`Harvest`、`FarmTools` 这些名字看不出它们实际是什么。

服务端的模块原先是按「谁调谁」倒推出来的几层（游戏的状态垫在最底下），主人看了觉得奇怪，这也是同一个毛病。

## Proposal

概念模型见 [docs/concepts.md](../../../../docs/concepts.md)。按下面的顺序把代码对上它，每一步是一个单独的改动，测试照常通过。

1. **概念和模块（这一步已经做了）**：
   - 写下概念文档；
   - 服务按概念分成 fx 模块：base、projects、agents（后来改叫 memory）、runs、chat、tickets、manager、channels、game（[服务由 fx 组装](../../implemented/architecture/2026-10-15-services-assembled-by-fx.md)）；
   - 每个项目同时能有几个执行，这个上限挪到了 `Projects`，这样项目不用往上调执行。
2. **游戏只听事件（这一步已经做了）**：
   - 账本的每一条都从事实里算出来。带话、点名、交接现在是群聊直接记的，改成从群聊发出的消息事实里读出来；读不出来的，就加事实。
   - 提交数看到一轮结束的事实后自己重数，不再由执行来叫。
   - 做完以后，game 模块谁也不调，只有 HTTP 用它算出来的画面。
3. **拆执行（这一步已经做了）**：`Crew` 拆成三块：
   - 派活：档案能不能派、在哪个项目、满了请走谁、重开，成了 tickets 里的 `Dispatch`；
   - 会话：smith 的会话、投递、叫停，还有同时干活的上限（叫醒歇着的也要查），留在 runs 的 `Crew`；
   - 合并：改动、合进主分支、合进计划分支，成了 tickets 里的 `Merges`：它既要动项目的分支，也要让执行离开，放在两者之上。
4. **工单变成一个东西（这一步已经做了，[工单是一样东西](../../implemented/architecture/2026-10-15-issue-is-one-thing.md)）**：
   - 服务端有工单（代码里叫 `Issue`），从写下到关上始终是同一个 id，带着做什么、项目、档案、优先级、状态；
   - 执行挂在工单下面，重开就是同一张工单的下一次执行；
   - 看板直接读服务端给的状态，不再自己推；
   - 待办表和轨迹头里的数据迁过去；查询改用 sqlc 生成（[sqlc](../../implemented/architecture/2026-10-15-sqlc-queries.md)）。

### 收敛以后的模型

VibeValley 是 AI 版的 Linear，穿农场的皮。概念收成下面几样，其余的是它们的属性、动作，或者只是入口和皮：

| 概念 | 吸收掉的 | 怎么吸收 |
|---|---|---|
| Workspace | 工作目录、同时干活的上限 | 现在只有一个；大地图画的就是它 |
| 项目 | 并发位、worktree | 就叫项目（git 仓库），不用 Linear 的 Project 这个词；大地图上的一座岛 |
| Agent | agent 档案、runtime、技能、记性、管家 | 管家是一个特殊的 agent，能被派工单；runtime、技能、记性是 agent 的配置 |
| Issue（工单） | 待办、排队、种植计划、定时派活 | 计划是带子工单的父工单，子工单之间有先后（blocked by），合进父工单的分支，最后父工单合进主分支；拆计划是父工单的一次执行。定时派活是周期工单 |
| Run（执行） | 帮工、轮、步骤、轨迹、改动、合并 | 步骤是执行的 activity，轮从 activity 里切出来，不另存；改动是执行分支上的 diff，合并是关工单的一个动作 |
| Channel（频道） | 田头、按项目或事情开的频道、连接器 | 主人跟管家说话、管家派活的地方，可以带默认项目；微信、飞书、QQ 各接在一个频道上。Linear 没有，相当于它接 Slack 的那部分 |
| Comment | 工单串、带话、评论某一步、@ | 工单下的对话，挂在派活的那条频道消息下面；带话就是在工单下评论 |
| Inbox | 需要你的事、巡查 | 巡查只是往 Inbox 里放东西的后台活 |

入口（语音、院门）只把话送到管家或者开成工单，聊天软件经频道进来；金币、成就、等级、地块、账本是皮。

名字照 Linear（`Helper` 改叫 `Run` 和「轮不另存」已由 [Run 是一次干活，Session 跨好几次 run](2026-10-16-runs-sessions-crews.md) 取代：`Helper` 改叫 `Worker`，后来改叫 `Session`，run 是一次干活）：

- 工单状态：`backlog`（写下没派）、`todo`（排队等空地）、`in_progress`、`in_review`（等你看）、`done`、`canceled`；关单的原因（收获、合进计划、收工、丢了）留着，从它算出 `done` 还是 `canceled`；
- 优先级的 `normal` 改叫 `medium`；
- `Issue.agent` 改叫 `assignee`；
- `AgentProfile` 改叫 `Agent`，`Helper` 改叫 `Run`，`WorkStep` 改叫 `Activity`（`asked` → `prompt`、`said` → `response`、`tool` → `action`、`problem` → `error`）；
- `IncomingCall` 改叫 `InboxItem`（已经改了，见第 5 步），`Merges.Harvest` 改叫 `Merge`（已经改了，现在是 `Issue.Merge`），`Foreman` 改叫 `Manager`。

### 接下来的步骤

5. **Inbox（这一步已经做了，[要你处理的事是一个 Inbox](../../implemented/architecture/2026-10-15-inbox.md)）**：需要你的事和巡查的发现并成一样，巡查只看它。
6. **计划并进工单（这一步已经做了）**：父工单和子工单、先后关系；`Playbook` 的状态和节点迁过去；定时派活改成周期工单。
   - 6a：工单进了核心状态，有标题和说明（[工单进核心状态](../../implemented/architecture/2026-10-15-issues-in-core-state.md)）；
   - 6b、6c：计划是带子工单的父工单（[种植计划是带子工单的父工单](../../implemented/architecture/2026-10-15-plans-are-parent-issues.md)）；收获过的工单就是仓库（[仓库是收获过的工单](../../implemented/feature/2026-10-16-warehouse-is-harvested-issues.md)）；
   - 6d：写了帮工档案的定时是周期工单，到点写一张新工单开工。
7. **管家是一个 agent**：能被派工单；定时「发一句话」改成派给管家的周期工单。
8. **状态分成两份**：
   - 核心状态只装实际的东西：执行、工单、频道和工单串；Inbox 从它现算，和它一起推给客户端；
   - 金币、成就、等级、地块位置挪进农场的画面，和现在的 `FarmView` 一样，从状态和账本算出来；
   - Flutter 的工作台读核心状态，像素村读画面。
9. **改名，拆包**：
   - 照上面的名字改类型、字段和服务，生成的 Dart 跟着改（改了 `IncomingCall` 那一组，见第 5 步；`Helper`、`Foreman` 改成了 `Worker`、`Manager`，`Worker` 后来改叫 `Session`，见 [Run 是一次干活，Session 跨好几次 run](2026-10-16-runs-sessions-crews.md)；`AgentProfile`、`WorkStep`、`Merges.Harvest`、工单状态和优先级的值也都改完了，见 [改完旧名字](2026-10-16-finish-the-renames.md)）；
   - 存盘的字段和表名一起改，写迁移；复数表名改成单数，查询搬进 sqlc（新加的 `issue`、`issue_run` 已经是单数，老表还是复数）；
   - 按模块拆成 Go 包，模块之间的依赖方向由编译器检查（这一项已经做了，[一个概念一个包](../../implemented/architecture/2026-10-16-a-package-per-concept.md)）。

## Alternatives considered

**保持现状，只在文档里写对照。** 成本最低，但代码还是按皮组织：读代码的人和 agent 还会从农场的名字去猜实际的事，皮也会继续往核心里长。

**一次全部改完。** 改名、拆状态、改协议、改 Flutter 一起做，中间好几天什么都跑不起来，出了问题也难查。分步做的话，每一步都能单独验证、单独回退。

**照搬 Multica 的模型**（workspace、issue、squad、daemon……）。我们只给一个人用、在本机跑，多了管家，主界面是群聊；照搬会多出用不上的东西（权限、成员、多台机器）。所以只借它的概念和边界。

## Acceptance criteria

- `docs/concepts.md` 里，每个农场里的东西都对得上一件实际的事。
- game 模块不被别的服务调用；拆包以后由编译器保证。
- 核心状态里没有金币、成就、等级、地块位置。
- 概念只剩上面那几样；种植计划、定时派活、巡查不再是单独的东西。
- 一张工单从写下到关上只有一个 id，状态由服务端给。
- 拆包以后，模块之间只有往下的依赖。

## Risks

- **兼容**：改名和拆状态会动到协议、Flutter 和存盘的数据。经院门连进来的手机，如果还是旧版本，就读不懂新的帧；要么和桌面版一起升级，要么留一段兼容期。
- **迁移**：工单变成一个东西，要迁移老数据（待办表、轨迹头）。迁错了会丢工单的历史，所以要先备份，迁移要能重跑。
- **过渡期**：分步做的这段时间，代码里新旧名字混着用，要靠概念文档里的对照表撑过去。
