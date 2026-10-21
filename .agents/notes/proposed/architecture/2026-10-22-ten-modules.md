# Agent Note: 服务端按十个领域模块切分，代码统一用行业词汇

Status: proposed

## Problem

VibeValley 是一个 AI 原生的 Linear，外面包一层农场游戏的皮。服务端现在有 19 个模块，在 `apps/server/src/services.ts` 里按顺序一层层叠起来：每个模块只能用排在它前面的，开机要做的事是叠在最后的几层 `start`、`ready`。这样组装有四个问题：

- **没有边界，只有顺序。** 19 个模块平铺，哪些是同一件事的不同部分、哪些是外面接进来的路，组装的地方看不出来。测试的 `apps/server/src/testing/world.ts` 把顺序又抄了一遍，而且不含 `start`、`ready`，所以几乎没有测试跑过真实的开机。
- **规矩靠层的顺序撑着。** 至少有 9 条，例如：帮工的接回放在最后一层，好让它发出的事件被别的模块收到；频道先用 `state.json` 里的旧帮工开工单串，接回时才把其中几个标成丢了；`task.ts:450` 的注释说帮工已经先接回了，实际顺序正好相反。今天的「帮工挂着不存在的工单」就是这一类 bug。
- **职责放错了地方、依赖方向反了。**
  - 频道直接依赖执行（`chat` 调 `sessions.deliver`），又到处特判管家（`channel/rules.ts` 的 `managerAgent`、`chat.ts` 的 `forManager`）。
  - 合并和 PR 写在执行里（`mergeSession`、`submitPullRequest`、`mergeInto`），由工单和种植计划去调。
  - 「什么要找主人、怎么找」散在四处：收件箱（protocol）、巡查（manager）、打电话找主人的队列（voice）、手机响铃（页面）。
  - 管家的工具自己从原子接口拼动作，和 HTTP 接口是两套实现（第一轮已经把工单的动作收进 `Issues.act`）。
  - 十来处跨模块直接读 `core.state()` 里别人的数据，比如语音读工单、工具读帮工。
- **代码里的词不专业。** `manager`、`task graph`、`schedule`、`standing`、`fact` 这些名字，要么是农场的叫法漏进了代码，要么在行业里没有对应的词。读代码的人和 agent 看不出它们对应 Linear 或 agent 平台里的什么。

## Proposal

按领域切成 10 个模块，代码统一用下面的词汇，农场的叫法只留在界面上。边界和依赖方向用一个测试守住；组装按模块来，每个模块自己管内部的组装和开机顺序。

### 原则

1. **按限界上下文切**：概念和用语自成一套、因为同一个原因而改的放在一起（共同封闭原则）。
2. **内核和适配器分开**（六边形架构）。调进来的有：页面、HTTP、命令行、MCP、Assistant、IM、语音。被调出去的有：oar 运行时、git 和 GitHub、库、大模型、声网。
3. **端口背后至少有两个适配器才立接口**；只有一个实现时直接调用。
4. **依赖只朝稳定的方向**：皮和外部接入依赖领域，反过来不行。
5. **读写分开**：核心状态是推给页面的读模型（投影）。模块之间通过对方公开的接口查询，不读核心状态里别人的那一块。

### 词汇

左边是代码、接口和讲服务端的文档里用的词；界面上的字照[用语表](docs/README.md#用语)，不变。

**模块**

| 代码里 | 是什么 | 行业里对应 | 界面上 |
|---|---|---|---|
| Platform | 存储、配置和密钥、日志、领域事件、读模型投影 | 基础设施、Sync Engine | — |
| Agents | agent 档案、运行时、容量和花费、分派策略、agent 记忆 | Agent Registry、Provider、Routing、Memory | 帮工档案、农机 |
| Source Control | 仓库、worktree 和分支、冲突预检、检查、合并、Pull Request | SCM、Checks、PR | 岛、篱笆里那块地 |
| Agent Sessions | 一个 agent 在一个工作区里执行：Session、Run、Activity、输入投递、中断 | Agent Session、Run、Activity（Linear for Agents） | 帮工、一季庄稼 |
| Issues | 工单的全程：工作流、Review、Refinement、Plan、周期性工单、委派和编排 | Issue、Workflow、Sub-issue、Recurring issue、Delegation | 地、种植计划、定时 |
| Collaboration | 频道、讨论串、消息、@ 和投递、文档 | Channels、Threads、Comments、Docs | 田头、工单串 |
| Notifications | Inbox：哪些事要主人、何时提醒、经哪条路送到 | Inbox、Notifications | 手机来电 |
| Assistant | 工作区的助理 agent：推理循环、提示、工具、评测 | Workspace Assistant / Orchestrator | 管家 |
| Gateway | 所有外部入口：HTTP API 和事件流、CLI、MCP Server、设备配对、IM 集成、语音线路 | API、CLI、MCP、Integrations | 连接到本机、电话 |
| Gamification | 账本、进度、成就、农场的画法规则 | Gamification | 农场、金币、成就 |

**概念**

| 代码里 | 现在叫 | 是什么 | 状态 |
|---|---|---|---|
| Assistant | manager（`Manager`、`managerAgent`） | 主人的助理 agent | 定 |
| Plan、Plan step | task graph（`TaskGraph`）、task（`Task`） | 一组带依赖的子工单，和其中一件 | 定 |
| Recurrence | schedule（`Schedule`） | 挂在一张工单上的周期规则，每次到点是这张工单的一次 run | 定 |
| Refinement | draft（`issue.draft`、`Session.draft`） | 帮工读过代码，把一句话写成标题、说明、验收标准；不是 Linear 的 Triage（分拣新工单） | 定 |
| Review、Finding | acceptance（`Issue.acceptance`、`issue.accept`）、finding | 判交回来的活过没过，和没过时的一条意见 | 定 |
| Question | asks（`Issue.asks`、`Ask`） | 帮工问主人、还没回答的 | 定 |
| Activity | `SessionEvent`、trajectory、journal | Session 每一步做了什么 | 定 |
| Event | fact（`Fact`、`FactIn`） | 一件已经发生的事，由拥有它的模块发出，带类型 | 定 |
| Participant | 散在 `channel` 里的 `managerAgent`、`user`、帮工 id | 能在频道里收发消息的一方：主人、Assistant、Session | 定 |
| Attention | standing（`Issue.standing`、`Standing`） | 一张工单现在要谁做什么：状态、主动作、能做的动作 | 待定 |
| Repository | project（`project`、`Projects`） | 一个 git 仓库。Linear 的 Project 是一组工单，和我们的意思不同 | 待定 |
| WorkspaceState | `CoreState` | 读模型：整个工作区此刻的样子，推给页面 | 待定 |

不变的：Issue、Session、Run、Agent（档案）、Runtime、Channel、Thread、Message、Document、Memory、Skill、Workspace、worktree、Inbox。

### 十个模块

每个模块列出：负责什么、对外给什么、依赖谁、不管什么，以及现在由哪些文件夹组成。依赖从下往上：编号小的不知道编号大的。

**1 Platform**
- 负责：PGlite 和表结构、配置和密钥（现在的 `setting`）、日志、文件写入、领域事件的发布和订阅、把事件投影成读模型并推给页面。
- 对外：`Database`、配置和密钥、`Events`（发布、按类型订阅）、`Projection`（施加、帧）。
- 不管：任何业务规则。
- 现在：`base/`、`core/`、`setting/`。

**2 Agents**
- 负责：agent 档案、技能、运行时的探测和健康、额度和花费、模型目录、分派策略（现在的 `chooseAgent`）、agent 记忆的读写和想起。
- 端口：Runtime，适配器是 Claude Code、Codex、pi、自研 agent（`agent/brain` 包成的 vibevalley 运行时）。
- 现在：`agent/`、`runtime/`、`memory/`、`ai/`、`session/rules.ts` 里的 `chooseAgent`。

**3 Source Control**
- 负责：仓库、worktree 和分支、冲突预检、项目检查（`.vibevalley/check`）、本地合并、推送和 Pull Request、GitHub 检测。
- 端口：代码托管，适配器是本地合并和 GitHub PR。
- 现在：`project/`，加上要从 `session` 搬过来的合并和 PR。

**4 Collaboration**
- 负责：频道、讨论串、消息、@ 和投递、叫醒、读到哪、文档。
- 端口：Participant，适配器是主人（页面、IM）、Assistant、Session。频道只认参与者，不认识执行和 Assistant。
- 不管：一次汇报对工单意味着什么；开工单串、贴汇报由 Issues 调它的接口。
- 现在：`channel/`、`doc/`。

**5 Agent Sessions**
- 负责：Session 和 Run、驱动运行时、输入投递、中断、没动静的检测、每轮的花费、Activity、重启后接回。
- 对外：开一个 Session（一份活、一个工作区、一个触发）、送话、叫停、收工；带类型的事件：Session 开始、Run 开始、Run 交回、Session 离开。
- 依赖：Platform、Agents（Runtime 端口）、Source Control（worktree）、Collaboration（作为 Participant 的适配器）。
- 不管：工单的状态、合并和 PR。
- 现在：`session/`（去掉合并和 PR）。

**6 Issues**
- 负责：工单和工作流状态、Moves 和 Attention、动作（`act`）、Review 和 Finding、Question、Refinement、Plan（子工单 DAG）、Recurrence、委派（开 Session、听它的事件推进工单）、收获的编排（调 Source Control 合并或开 PR）、工单串（调 Collaboration）。
- 规则在 `packages/protocol/src/rules`（`issues.ts`、`moves.ts`、`standing.ts`、`tasks.ts`），页面也用。
- 现在：`issue/`、`task/`、`schedule/`。

**7 Notifications**
- 负责：Inbox（哪些事要主人）、提醒的时机（现在的巡查）、送达的路线：主人在通话就由 Assistant 在电话里说，不在就响铃，桌面和手机发系统通知。
- 端口：送达，适配器是电话、手机响铃、系统通知。适配器在组装时由上层提供，所以它在 Assistant 下面也能「让 Assistant 在电话里说」。
- 现在：`apps/server/src/notice`（刚来的、巡查）；Inbox 和它的配话还在 `packages/protocol/src/rules/inbox.ts`（第 5 步挪回）；页面的手机、系统通知、菜单栏只读帧里的 Inbox。

**8 Assistant**
- 负责：助理 agent 的推理循环（在 `agent/brain` 上）、提示、工作区现状、评测、它的工具。工具只把各模块公开的用例翻成模型能调的函数，不实现规则。
- 地位：和页面、命令行一样，是领域的使用方，不是领域本身。
- 现在：`manager/`、`tool/` 里给管家的那一半。

**9 Gamification**
- 负责：账本、进度、成就、农场的画法规则（`packages/protocol/src/rules/view.ts`、`play.ts`）。
- 只订阅事件；领域模块不调它，只有 Gateway 调（成就和称号的接口）。
- 现在：`game/`。

**10 Gateway**
- 负责：HTTP API、事件流和静态页面、CLI、MCP Server（给帮工的工具）、设备配对、IM 集成、语音（声网通话、语音线路、隧道）。只做鉴权和翻译。
- 安全边界在这一处：服务端只听 127.0.0.1，例外只有语音线路和设备配对这两个单独的监听。
- 现在：`http/`、`handlers.ts`、`cli.ts`、`mcp/`、`tool/` 里给帮工的那一半、`lan/`、`connector/`、`voice/`。

`packages/protocol` 是各模块对外的形状和规则，也就是共享内核；页面 `apps/web` 只经 Gateway 和读模型接触服务端。

### 参考

- [T3 Code](https://github.com/pingdotgg/t3code)：同一类产品（Effect 服务端驱动编码 agent，网页、桌面、手机三个客户端），最贴近的参考。按领域分文件夹，一个能力一个小服务；端口做成包，核心加适配器加测试替身（`provider-core` 和每家 provider 一个包、`provider-testing`；`source-control-core` 和 github、gitlab 等各一个包、`source-control-testing`）；WebSocket、HTTP、MCP、定时任务、CLI 的处理函数只解码、调一个服务方法、映射错误（`docs/internals/effect-services.md`）；编排是事件溯源的：编排器只决定事件，事件、投影、待做的副作用在一个事务里提交，副作用由 worker 在提交之后执行（`docs/internals/overview.md`）。
- [hex-effect](https://github.com/jkonowitch/hex-effect)：每个限界上下文分 domain、application、infrastructure，上下文之间经领域事件和持久的消息队列。
- [按领域组织 Effect 代码](https://ratstack.sh/lore/structure-effect-by-domain)、[按变化频率分层](https://www.typekaizen.com/posts/effect-righting-software/)：按领域不按机制分文件夹，一个服务和它的 Layer 在一个文件，组装在入口；只往下调，不横着调。

从参考里得出的两点修正：

1. **十个模块是边界图，不是合并的单位。** 它管谁能依赖谁；每个服务多大是另一件事。参考的做法是一个能力一个小服务：`issue.ts`（1260 行、31 个方法）、`session.ts`、`channel/chat.ts` 这样的大服务应该在自己的文件夹里按能力拆开。
2. **开机和顺序的问题，根治是事件提交和副作用分开。** 第 1 步的「先建好、再按顺序开机」是轻量版；把事实、核心状态和待做的副作用在一个事务里落下、由 worker 在提交后执行，重启、重试和顺序就都由结构保证。改动大，另写提案评估。

### 依赖和组装的规矩

- **方向**：Platform ← Agents ← Source Control ← Collaboration ← Agent Sessions ← Issues ← Notifications ← Assistant ← Gamification ← Gateway（`modules.ts` 的顺序）；Gamification 只订阅事件，领域模块不调它。模块只 import 编号比自己小的模块的公开入口，同模块内随意。
- **事件**：跨模块的事件由拥有它的模块发出，带类型；订阅方不再用 `e.type === "left"`、`e.id as string` 去认。
- **读模型**：核心状态只给页面和 Gamification 用；模块之间查对方公开的接口。
- **组装分两段**：先把所有模块建好，建的时候只订阅自己要跟的事；再按模块顺序跑各自的开机函数（Source Control 第一次看 GitHub，Agent Sessions 接回帮工，Issues 整理被打断的 Plan、开始走 Recurrence，Gamification 开始数提交）。这样一个开机函数发出的事，所有模块都已经在听，「先订阅、再接回」由结构保证，不靠哪一层排在哪里。`services.ts` 只拼模块；测试用同一套组装函数，按需要拼其中几个。
- **守边界**：一个测试读文件夹归属表，扫 import，反方向的 import 和跨模块读核心状态都会让它失败；做法照 `apps/server/src/base/schema.test.ts`。

### 步骤

每一步单独能过 `check`、`server:check`、`web:check` 和 Playwright。

1. **立边界，不挪文件**（已做）：
   - 归属表 `apps/server/src/modules.ts`，边界测试 `modules.test.ts`：每个文件夹都要归一个模块，反方向的 import 失败；还没清的列在测试里，写明由哪一步清（现在只剩频道依赖执行，第 2 步）。
   - `services.ts` 按模块组装、分两段；`testing/world.ts`、`flows/farm.ts` 用同一套组装函数。Plan 被打断后的整理从「建的时候」挪进 Issues 的开机函数（`Tasks.comeBack`），排在帮工接回之后；原来的注释把这个顺序说反了。
   - 扫描时发现 `task/engine.ts`、`task/store.ts` 是自研 agent 自己的任务图，和 Plan 无关：挪进 `agent/brain`（`taskGraph.ts`、`taskStore.ts`），表 `task_graph` 改名 `agent_task`。
   - 还在「建的时候」做开机工作的：频道重放会话和消息、Issues 重放工单并把管家没答完的关成 lost、Recurrence 重放定时、Gamification 折账本。它们之后逐步挪进各自的开机函数。
2. **Participant 端口**（已做）：频道不再依赖执行。
   - 已做：帮工这一类参与者走端口 `Helpers`（`channel/chat.ts`），执行模块建的时候登记、把活动和回执交给频道；`Delivered`、`LaunchActivity`、`InputConsumed` 搬进频道；Collaboration 改成建在 Agent Sessions 之前，边界测试里不再有待清的违规。原来频道在建的时候就叫醒还在地里的帮工，那时帮工还没接回、全被拒；现在帮工接回以后由执行模块调 `helpersBack`。
   - 不做：把管家也立成参与者端口。频道不 import 管家，`forManager` 已经是倒过来的流；剩下的只是「没 @ 别人的话归管家」这条角色规则，为它立端口背后只有一个适配器。
   - 挪到第 6 步：频道还听 `hired`、`left`、`report` 自己开串、贴汇报；改成由拥有这些事的模块发出带类型的事件，和第 6 步的「事件带类型」是同一件事。
3. **合并和 PR 由 Issues 编排**（已做）：Agent Sessions 只交出工作区。
   - 执行的 `merge`、`mergeInto`、`submitPullRequest`、`finishPullRequest` 四个方法收成一个 `handOver(id, closed, use)`：执行让帮工歇下、把 worktree 和最后说的话交给 `use`、按 `closed` 离开；冲突施加 `conflict` 留着帮工，这条仍归执行。
   - 本地合、提 PR（PR 正文 `pullRequestConclusion` 挪进 `issue/rules.ts`）、存 PR 回执、结束 PR 由工单给 `use`；种植计划给的是合进计划分支。执行不再知道 PR 和计划。
   - 合并本身一直在 Source Control（`project.ts`），没挪。
4. **立起 Notifications**（已做）：`apps/server/src/notice`（`Notices`）。
   - 刚来的（`news`）和巡查（`overdue`、`patrol`）在这里；巡查的规则和黄金数据从 `manager/` 挪来，管家只订阅、写巡查的话。开机的最后一段 `prime`，接回来的不算刚来。
   - 通话里说的改成 Inbox 里刚来的，和手机响的是同一批；`ownerCalls.ts`（看工单站位变化的另一套规则）删掉，`voice.ts` 不再读工单。
   - 每件 Inbox 带好 `who` 和 `words`（手机的标签、系统通知、菜单栏），种类的话只在 `inbox.ts` 一张表里；页面原来的三张表（`inboxKindLabel`、`noticeFor`、`waitingLine`）和两份「只响一次」（`CallBell`、`PhoneCalls.known`）收成读字段和一个 `freshOf`。
   - 不立「送达」端口：通话、手机、系统通知各自订阅，背后的适配器在两个进程里。
   - Inbox 本身还在 `packages/protocol`（`frameOf` 要它），由第 5 步挪回。
5. **`packages/protocol` 只放契约**（已做）：页面原来只 import 14 个规则的名字，服务端 import 97 个；服务端独用的业务规则放在共享包里，平铺、不分模块。
   - 留在 protocol 的：形状、Schema、接口，和两边都跑的 `phaseText`（连 `phaseWords`、`needOf`、`actionText`）、`isBusy`、`shortTitle`、`standingLabel`、`actLabel`、`standingWantsOwner`、`freshOf`、`farmOf`、`keyBetween`、`same`。`rules/contract.test.ts` 查每个导出都有服务端以外的包在用。
   - 其余挪回各自的模块：`session/state.ts`、`channel/state.ts`、`issue/{state,standing,moves}.ts`、`task/{graph,issues}.ts`、`schedule/when.ts`、`notice/inbox.ts`、`game/{play,view}.ts`、`agent/seed.ts`（和两个 json）、`base/{text,dag}.ts`；黄金数据和它们的测试在 `core/`。
   - 折法和拼帧在 `projection/`（组装那一层），组装时以 `Projection` 交给 `core`，`core` 不 import 上面的模块。没有拆成每个模块各交一段折法：一个 `reduce` 能看全，黄金数据只比一个函数。
   - 田头问帮工「这张工单现在谁在做」改走 `Helpers.onIssue`。剩下一条反向的（帮工的规矩里写了拆工单的上限 `maxTasks`）记在边界测试里，归第 6 步。
6. **Assistant 的工具改成用例适配器**；模块之间不再读核心状态里别人的那一块；事件改成带类型（已做）。
   - 事件：Agent Sessions 把自己的事实说成 `news`（`SessionNews`：`hired`、`reported`、`left`，带着那一刻的 Session）；工单和种植计划订阅它，田头经 `Helpers` 端口收（`sessionNews`），不再从核心事实里按 `type` 挑。主人在串里的话由田头说成 `ownerInThread`，工单订阅它；工单的两路合成一条按顺序处理。
   - 读别人的那一块：各模块给自己的一块开查询（`Sessions.sessionOf`、`presentSessions`，`Issues.onBoard`，`Tasks.graphs`，`Channels.now`），别人经它读；田头经 `Helpers.sessionOf`、`presentSessions`、`onIssue`。田头给帮工开工单串挪到 `helpersBack`（帮工接回以后），不再用 `state.json` 里的旧帮工先开；第几次派活照串里的派活消息数。边界测试加了一条：读 `core.state()` 里别人的那一块就失败，没有例外。
   - 工具：挑帮工档案（`dispatch`、`issue_status` 和起草各有一份）收成 `Issues.pickAgent`；拆计划的规矩 `splitBrief` 挪到 `task/rules.ts`。留在工具里的：主人有没有说过的检查（Assistant 替主人做事的规矩，HTTP 的调用方就是主人），参数的翻译（名字到 id）和给模型看的拼法。
7. **按能力拆大服务**：`issue.ts`、`session.ts`、`channel/chat.ts` 在各自的文件夹里拆成几个小服务（例如工单的起草、收获和 PR、排队），一个文件一个服务。
8. **事件提交和副作用分开**：另写提案评估（参考 T3 Code 的事件溯源和 outbox）。
9. **统一词汇**：照上面的「概念」表改名，接口、表名、文档一起改，不留兼容（本机旧库作废重建）；「待定」的三个先和主人定下来。
10. **挪文件夹**：按模块改成 `src/<模块>/…`，纯机械，单独一个改动。

每做完一步，把现状写进 [architecture.md](docs/architecture.md) 的「分层」、[concepts.md](docs/concepts.md) 和[用语表](docs/README.md#用语)的「代码里」一列，并更新本文；全部做完后沉淀进 [地基](docs/subsystems/foundation.md)，删掉本文。

## Alternatives considered

**保留 19 个平铺的模块，只加一道 lint。** 改动最小，但开机顺序仍然没人负责，频道依赖执行、合并写在执行里这些职责问题也不会消失；lint 只能挡住新的越界，挡不住已经放错的。

**合并成 5 个大模块（工作、管家与农机、说话、入口、底座）。** 把工单、执行、计划、定时并成一块，能消掉它们之间的事件往返，但太粗：执行同时被工单、频道、Assistant 用，是一个真 seam，并掉以后这些使用方又会伸进它的内部；一次要动几乎所有服务端文件和测试。

**另立一个 Knowledge 模块（记忆加文档），共 11 个。** 记忆是 agent 档案的属性，想起什么也按档案来；文档是主人和帮工一起写的地方，和讨论串是同一类东西。两者没有共同的变化原因，放在一起只是因为都叫「知识」。

**把 Gateway 拆成 API 和 Integrations。** 两边做的是同一件事：外面的东西进来时鉴权、翻译成用例；拆开以后「只听 127.0.0.1，例外只有这几个」这条安全边界就分在两处。

**把 Assistant 当成领域模块。** 它和页面、命令行一样是用例的使用方。放进领域，它的工具就会自己实现规则，第一轮发现的「工具和 HTTP 是两套动作」就是这样来的。

**模块和概念用农场的叫法（田头、班子、入口）。** 代码和接口用实际的概念，界面才用农场的叫法；农场的词在行业里没有对应，读代码的人和 agent 都要先翻译一遍。

**把核心状态单独当一个模块。** 它是事件的投影和推送，不含业务规则，归 Platform；单独成模块会让它继续被当成模块之间互相读数据的通道。

## Acceptance criteria

- 边界测试存在并通过：没有反方向的 import，没有跨模块读核心状态里别人的那一块。
- `services.ts` 只拼 10 个模块；`start`、`ready` 这类层不再出现在组装里，开机顺序写在各模块的开机函数里。
- `world.ts` 用同一套组装函数，至少一个测试覆盖「重启后接回」走的是真实的开机函数。
- 频道不 import 执行；`channel` 里不再特判 `managerAgent`。
- 合并和 PR 的代码不在 Agent Sessions 里。
- Inbox、提醒时机、送达路线在 Notifications 一处；`voice.ts` 不再读工单。
- Assistant 的工具和 HTTP 的 handler 调同一组用例。
- 「概念」表里标「定」的名字在代码、接口、表名和文档里都改完；`architecture.md`、`concepts.md`、用语表反映新的模块和词汇。

## Risks

- **改动面大、和别的会话冲突**：工作区里有别的会话也在改服务端；每一步都要小、单独可合，开始前先确认没有并行的改动。
- **改名不留兼容**：Assistant、Plan、Recurrence 等改名会动接口路径、表名和存下的值，本机旧库和旧的 `state.json` 作废；页面、桌面、手机壳要一起改。
- **Notifications 的端口**：「让 Assistant 在电话里说」要由上层在组装时提供适配器，这是唯一一处向下注入；如果写成上层直接调下层，方向就又反了。
- **`agent/brain` 的归属**：它既是 Assistant 的推理循环，也是 vibevalley 运行时；暂放在 Agents 作为运行时的实现，Assistant 当库用。若两边的需要分开，再拆。
- **边界测试的误报**：同模块内的 import 要允许；文件夹归属表要随第 10 步的挪动一起改。
- **页面的点击被挂起**：工单相关的查询在每次状态变化时整体作废、重新请求，重新请求期间读到它们的界面更新可能被 Solid 2 挂起；全量 Playwright 并行时「打回」那条偶发失败。和模块切分无关，另查。
