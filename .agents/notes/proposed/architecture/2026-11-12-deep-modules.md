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
3. **repo 收下交付。** 把「这张工单的改动怎么交出去」整个放进 repo：`deliver(issue, how)`（本地合并、提 PR、跟进 PR、冲突）、`changes(issue)`；issue 不再调 `run`、`githubRequest`，只说要交付、读结果。目标：issue 用 Repo 的成员从 16 降到 5 个以内。
4. **library 并进 media。** 素材库是 media 产出和收进来的东西的目录，一个模块管：表 `library_item` 改名 `media_library_item`（表名「模块_概念」），接口并进 Media。
5. **纯判断搬出服务。** 每个模块里不碰库、不碰网、不读时钟的判断写成导出的纯函数，测试直接测；服务里只留 IO 和编排。
6. **规矩跟着改。** `AGENTS.md`「服务端的服务」从「每个模块导出一个服务」改成「一个模块对外一个深的服务：接口只留调用方用的，判断是纯函数」；写明事件的分工：用户看得见的变化走核心事实，服务端模块之间的反应走 `news`。`docs/subsystems/` 里 session、mailbox、machine、repo、issue、media 的文档合并改写。

每一步一个或几个提交，全部在一个 PR 里（[One PR per plan](.agents/notes/README.md)）；每一步后 `server:check`、`paths:check` 全过。

## Step 2 as done

- `modules/session` 吞下 mailbox 和 machine：表改名 `session_trigger`、`session_delivery`、`session_order`、`session_subscription`、`session_issue_input`、`session_machine`；`services.ts` 的 `buildModules` 建到工单，`makeFarm` 和测试的 `moduleWorld` 共用它。
- `Session` 对外 20 个成员（[对外的门](docs/subsystems/session.md#对外的门)），里面的 `Lifecycle`、`Mailbox`、`Machine` 只经 `insideOf` 给测试。同一件事的几种做法并成一个成员、用标签分（`receive`、`withdraw`、`workplace`、`read`、`live`），所以路径表只看得到门。
- issue 用 Session 的成员从 24 个降到 7 个（`receive`、`withdraw`、`workplace`、`live`、`read`、`room`、`news`），没到 5 个：`news` 是流、`room` 和 `live` 是同步读，再并只会造出一个什么都管的成员；issue 用 Repo 仍是 15 个，交付归 repo（第 3 步）以后再降。
- Repo 的 `workplace`、`release`、`reset`、`clear` 并成 `checkout`，只有 session 用；issue 要工单自己的检出走 `Session.workplace` 的 `Issue`。
- `registry`、`launch`、`watch` 这些里面的部分没有收拢：它们现在只在模块里，收拢不改任何调用方，留给第 5 步和纯判断一起做。
- 重启：`vibevalley` 农机上答到一半的帮工在正常关门以后接着答，记在原来那一轮上（`Durable.leave`、`goOn`、`Hand.goesOn`）；`session_run` 的开着的一轮仍是接上时认的那一轮，pi-durable 不记我们的轮次 ID，所以「接管」没有删。外部农机照旧记 `interrupted`。

## Alternatives considered

- **把宽接口拆成很多小服务。** 每个小服务只有几个成员，看着整齐，实际是更多的浅模块：调用方要认识更多的门，一件事还是散在几处。没选：要的是少而深。
- **只把没人用的成员从接口上去掉。** 便宜，但大多数「只在模块里用」的成员是接口给 HTTP 的用户操作，删不掉；真正的问题是模块之间互相伸手，要合并才消得掉。
- **保留 mailbox 为独立模块，只收窄 session。** mailbox 和 session 各自记着同一件活的一半状态（投递和执行），收窄任何一边都得把另一半的状态再往外递；合起来才藏得住。

## Acceptance criteria

- `services.ts` 没有阶段类型和 `add()`，每个 `makeX` 的依赖在调用处写明。
- `modules.ts` 里没有 mailbox、machine、library 这几个模块；issue 用 Session 的成员和用 Repo 的成员各不超过 5 个（`service-paths.json`），没有模块调 `repo.run` 或 `repo.githubRequest`。
- 帮工在服务端正常重启后接着干（流程测试守着）；`session_run` 不再有「接管」的写法。
- `server:check`、`web:check`、`paths:check`、`practice:check`、`health:verify`、`deadcode`、`docs:verify` 全过；服务端测试数不减（改名、挪地方的点名），`regression:` 测试名字不变。
- `AGENTS.md` 和 `docs/subsystems/` 照新的样子写，删掉本 Note。

## Risks

- **合并 session 和 mailbox 是这里最大的一块，投递的顺序和恢复最容易出错。** 缓解：先搬家不改行为（文件挪进一个模块、接口不变、测试全过），再收窄接口，最后删重复的持久；每一小步跑全部流程测试。
- **工作区的归属挪动牵连 issue、repo、session 三处。** 缓解：步骤 3 在步骤 2 之后做，repo 的新门先加、旧门后删。
- **表改名（`library_item`）作废本机旧库。** 照「内部不留兼容」：改 `0001_schema.up.sql`，本机旧库开机时挪到一边。
