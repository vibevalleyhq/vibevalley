# Agent Note: 模块要深：合并把一件事拆散的模块，接口收窄到调用方要的

Status: proposed

## Problem

拿掉 Effect 以后（[地基](docs/subsystems/foundation.md#为什么这样)），代码的组织还照着 Effect 的形状：每个服务要一个 `Context.Service` 和一个 layer，所以「一个模块导出一个服务」，`services.ts` 一层层叠 11 个阶段（`PlatformFarm`、`AgentsFarm`…，`add()` 把下面的全交给上面的 `makeX`）。结果是模块浅：接口宽、藏的少，一件事拆在几个模块里互相伸手。`scripts/audit/service-paths.json`（2026-11-12）读出来的：

- **「让一个档案干一件活」拆在 session、mailbox、machine 三处。** issue 用 Session 的 17 个成员、Mailbox 的 7 个；mailbox 和 session 互用 7 个；channel 用 Session 的 7 个。Session 的接口 33 个成员，28 个被别的模块用；工作区的事一半在 session（`withWorkplace`、`withIdleWorkplace`、`clearWorkplace`、`discardWork`），一半在 repo（`workplace`、`release`、`reset`、`clear`）。machine 只有 3 个成员（553 行），只被 session 用。
- **issue 一步步替 repo 编排 git。** issue 用 Repo 的 16 个成员，其中有原始的 `run`（一条 git 命令）和 `githubRequest`（一次 GitHub 请求）：合并、提 PR、跟进 PR 的步骤写在 issue 里，repo 只是一包工具。
- **浅的小模块。** library（261 行，5 个成员）只是素材的一张表和几个读写，和 media 管的是同一批东西；machine 同上。
- **组装还是 layer 的样子。** `services.ts` 的阶段类型和 `add()` 只为让每个 `makeX` 拿到「下面的全部」，模块真正要什么写在各自的 `XDeps` 里，组装处看不出来。
- **没有 IO 的判断还待在服务里。** 拿掉 Effect 以后读时间、读配置不再要上下文，这些判断可以是纯函数，模块层的测试也就不必为它们搭整个农场。

## Proposal

模块要深（窄接口、藏住多的实现）：该合的合，接口只留调用方要的，内部的分层拆掉。11 个有序模块和单向依赖不变（`modules.ts`、`modules.test.ts`），`paths:check` 守住新的路。

1. **组装处摊平。** `services.ts` 是一个函数，照模块次序一行一个 `const issue = await makeIssue({ db, core, session, … })`，依赖写明；去掉阶段类型和 `add()`，只留 `Farm` 和 `close` 的倒序。测试的 `world()`、`flows/farm.ts` 跟着改。纯机械，不改行为。
2. **工作合成一个深模块：session 吞下 mailbox 和 machine。** 一件活从触发、排队、投递、开 Session、跑、汇报到放掉都在一个模块里；对外只留调用方真要的几样：收一个触发（`receive`）、撤回（`withdraw`）、叫停和放掉、读一个 Session 的状态和汇报、新闻（`news`）。工作区的开、借、清一并归它，repo 只给「这个仓库在这张工单上的检出」这一个门。内部借这次重写把只为 Effect 作用域分出来的子对象（`registry`、`launch`、`recording`…）收拢；pi-durable 已经管了的持久（`session_run` 的接管）删掉，帮工在**正常重启**后也接着干（现在只有崩溃后才接着）。
3. **派活和交付也进 session，issue 只留工单本身。** 拆开门以后量出来（`service-paths.json`）：issue 用 Session 的 23 个成员、Repo 的 15 个，分三团：派活（`dispatch.ts`：`hireWith`、`room`、`triggersOf`、`queuedTriggers`、`withCheckout`）、交付（`merge.ts`、`settle.ts`、`split.ts` 的交出改动：`handOver`、`withWorkplace`、`withCheckout`，加 repo 的 `merge`、`submitPullRequest`、`finishPullRequest`、`run`…）、跟 PR（`github.ts`：`receive`、`knownGitHubEvents`，加 repo 的 `githubRequest`、`githubSnapshot`）。交付要工作区（session）也要 git（repo），repo 排在 session 下面，所以三团都归 session：session 是「派活 → 干活 → 交付」整件事的深模块。issue 只留工单本身：状态和它的规则、拆分的决定、细化、关系；对 session 只说派这张（`dispatch`）、叫停和放掉、交出去（`deliver(issue, how)`：本地合并、提 PR、跟进 PR、冲突），再读状态。repo 只给 session 用的 git 和 GitHub 门。目标：issue 用 Session 的成员不超过 8 个、用 Repo 的不超过 3 个，没有模块（session 以外）调 `repo.run` 或 `repo.githubRequest`。
4. **library 并进 media。** 素材库是 media 产出和收进来的东西的目录，一个模块管：表 `library_item` 改名 `media_library_item`（表名「模块_概念」），接口并进 Media。
5. **纯判断搬出服务。** 每个模块里不碰库、不碰网、不读时钟的判断写成导出的纯函数，测试直接测；服务里只留 IO 和编排。
6. **规矩跟着改。** `AGENTS.md`「服务端的服务」从「每个模块导出一个服务」改成「一个模块对外一个深的服务：接口只留调用方用的，判断是纯函数」；写明事件的分工：用户看得见的变化走核心事实，服务端模块之间的反应走 `news`。`docs/subsystems/` 里 session、mailbox、machine、repo、issue、media 的文档合并改写。

每一步一个或几个提交，全部在一个 PR 里（[One PR per plan](.agents/notes/README.md)）；每一步后 `server:check`、`paths:check` 全过。

## Step 2 as done

- `modules/session` 吞下 mailbox 和 machine：表改名 `session_trigger`、`session_delivery`、`session_order`、`session_subscription`、`session_issue_input`、`session_machine`；`services.ts` 的 `buildModules` 建到工单，`makeFarm` 和测试的 `moduleWorld` 共用它。
- `Session` 对外 44 个成员（[对外的门](docs/subsystems/session.md#对外的门)），每个答一个问题、每个都有别的模块、接口或 `services.ts` 在用；里面的 `Lifecycle`、`Mailbox`、`Machine` 只经 `insideOf` 给测试。先做过一版把几件事并进带标签的成员（`receive`、`withdraw`、`workplace`、`read`、`live`），成员数少了、面没变窄，路径表也看不出用的是哪件事，违反[一个名字只答一个问题](docs/style/naming.md)，已拆回具名成员。
- issue 用 Session 的 23 个成员（原来 Session 17 个加 Mailbox 7 个，共 24 个）：合并消掉的是 mailbox 和 session 之间的互相伸手，不是 issue 的成员数；issue 用 Repo 仍是 15 个，交付归 repo（第 3 步）以后再降。
- Repo 的 `workplace`、`release`、`reset`、`clear` 并成 `checkout`，只有 session 用；issue 要工单自己的检出走 `Session.withCheckout`。
- `registry`、`launch`、`watch` 这些里面的部分没有收拢：它们现在只在模块里，收拢不改任何调用方，留给第 5 步和纯判断一起做。
- 重启：`vibevalley` 农机上答到一半的帮工在正常关门以后接着答，记在原来那一轮上（`Durable.leave`、`goOn`、`Hand.goesOn`）；`session_run` 的开着的一轮仍是接上时认的那一轮，pi-durable 不记我们的轮次 ID，所以「接管」没有删。外部农机照旧记 `interrupted`。

## Step 3 as done

- **交付和跟 PR 进了 session**（`session/landing.ts`、`session/github.ts`）：`merge`（帮工交接后放走，或帮工不在、子工单已合进来时从工单自己的检出；合进主分支或提 PR 由仓库和 PR 的状态定）、`submitPullRequest`、`mergeChild`（跑子工单的检查、合进父工单帮工的工作目录或父工单的检出）、`refreshPullRequests`、`pollGitHub`、`changesOf`、`conflictOf`。工单留着决定，作为数据交过去：从检出合不合（有没有子工单）、`childChecks`（子工单过哪些检查、冻结哪些文件）、PR 结了算不算完（`FollowedPullRequest.finishes`）；工单表上要记的（冲突、PR 的链接和状态、结局、冻结的文件）经调用方给的 `IssueRecord` 回调，在帮工放走之前写下，先后和以前一样。PR 锁和拆单的锁还在工单（它们串的是工单这边的读和决定）。表 `issue_github` 改名 `session_github_cursor`。
- **派活**：`hireWith` 收 `parent`（父工单号），子工单的父检出由 session 先建；工单留排队派活的三处（排队、当值的开工、拆单）改用 `queueDispatch`：在调用方的事务里记下触发，提交时（`db.afterCommit`）路由，触发的形状不再写在工单里。路由因此排在同一事务的 `publish` 之前（以前在之后），队列看到工单变化时派活已经路由好了。
- **删掉和拆开**：Session 去掉只有工单用的 `withWorkplace`、`withIdleWorkplace`、`withCheckout`、`handOver`、`knownGitHubEvents`（`handOver` 等仍在模块里，测试经 `insideOf` 用）；`Repo.checkout` 的 `Open`/`Release`/`Reset`/`Clear` 拆成 `checkout`、`releaseCheckout`、`resetCheckout`、`clearCheckout`；信箱的 `receive`（`Trigger`/`Hire`）、`withdraw`（`Session`/`Envelope`/`Issue`）拆成 `route`、`hireWith`、`withdrawDeliveries`、`withdrawEnvelope`、`withdrawDispatches`。
- **量出来**：issue 用 Repo 3 个（`usesPullRequests`、`branchChanges`、`stack`），达标；`repo.run`、`repo.githubRequest` 只有 session 调。issue 用 Session 23 个，没到 8 个：拿掉 8 个让工单自己编排的门（`withWorkplace`、`withIdleWorkplace`、`withCheckout`、`handOver`、`receive`、`knownGitHubEvents`、`recordTrigger`、`route`），换上 8 个高层操作（`merge`、`submitPullRequest`、`mergeChild`、`refreshPullRequests`、`pollGitHub`、`changesOf`、`conflictOf`、`queueDispatch`）。剩下的每个都答工单的一个问题，再并只能违反两条之一：读（`live`、`get`、`list`、`runsOf`、`hired`、`triggersOf`、`queuedTriggers`、`room`：派活的决定和时间线、历史要它们，`hired` 换成读核心状态里的会话会越界，`modules.test.ts` 拦）；叫停放走（`stop`、`dismiss`）；派活（`hireWith`、`withdrawDispatches`）；工作目录（`discardWork`：答案工单交回后重置，`deliver` 开着时能改，只能在汇报时由工单定；`clearWorkplace`：换仓库和起草收尾）；`news`。`deliver(issue, how)` 那样一个成员装几件事是带标签的门；把 `room`、`triggersOf` 并进派活要把排队和就绪的判断搬进 session，改了拒绝的先后。8 个的目标是按带标签的门估的，作废，记 23。
- `merge.ts` 里的 `verifyChild` 拆成工单的 `childChecks`（纯函数）和 session 的检查；`pullRequestConclusion` 跟着提 PR 搬到 `session/landing.ts`。测试只改了调用的写法和 import（`Repo.checkout` 的拆分、`pullRequestConclusion` 的 import、频道测试的 `sessionOver` 替身多了交付的几样），断言没动，服务端 1185 个测试照旧全过。

## Alternatives considered

- **把宽接口拆成很多小服务。** 每个小服务只有几个成员，看着整齐，实际是更多的浅模块：调用方要认识更多的门，一件事还是散在几处。没选：要的是少而深。
- **只把没人用的成员从接口上去掉。** 便宜，但大多数「只在模块里用」的成员是接口给 HTTP 的用户操作，删不掉；真正的问题是模块之间互相伸手，要合并才消得掉。
- **保留 mailbox 为独立模块，只收窄 session。** mailbox 和 session 各自记着同一件活的一半状态（投递和执行），收窄任何一边都得把另一半的状态再往外递；合起来才藏得住。

## Acceptance criteria

- `services.ts` 没有阶段类型和 `add()`，每个 `makeX` 的依赖在调用处写明。
- `modules.ts` 里没有 mailbox、machine、library 这几个模块；issue 用 Repo 的成员不超过 3 个（`service-paths.json`），session 以外没有模块调 `repo.run` 或 `repo.githubRequest`（issue 用 Session 的成员数见 [Step 3 as done](#step-3-as-done)：23 个，每个答一个问题）；`Repo.checkout` 这类带标签的门拆成具名成员。
- 帮工在服务端正常重启后接着干（流程测试守着）；`session_run` 不再有「接管」的写法。
- `server:check`、`web:check`、`paths:check`、`practice:check`、`health:verify`、`deadcode`、`docs:verify` 全过；服务端测试数不减（改名、挪地方的点名），`regression:` 测试名字不变。
- `AGENTS.md` 和 `docs/subsystems/` 照新的样子写，删掉本 Note。

## Risks

- **合并 session 和 mailbox 是这里最大的一块，投递的顺序和恢复最容易出错。** 缓解：先搬家不改行为（文件挪进一个模块、接口不变、测试全过），再收窄接口，最后删重复的持久；每一小步跑全部流程测试。
- **工作区的归属挪动牵连 issue、repo、session 三处。** 缓解：步骤 3 在步骤 2 之后做，repo 的新门先加、旧门后删。
- **表改名（`library_item`）作废本机旧库。** 照「内部不留兼容」：改 `0001_schema.up.sql`，本机旧库开机时挪到一边。
