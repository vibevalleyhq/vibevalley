# Agent Note: 一件事一条路：按调用表收敛服务之间的路径

Status: proposed

## Problem

[一道门](.agents/notes/proposed/architecture/2026-11-09-one-door-to-a-helper.md)收完投递以后，2026-11-09 按语法树重新数了一遍服务之间的调用（`apps/server/src`，不含测试）。读法：每个文件里 `const x = yield* Service` 把变量绑到服务，再找 `x.member` 的用处，得到「服务成员 × 调用模块」的表；另按 `#db/<表>.sql.ts` 的 import 数每张表被哪些模块读写。模块之间经 Effect 服务说话，不经 import，所以只看 import 的工具（dependency-cruiser、madge）看不到这一层。

表的归属是干净的：只有 `channel`、`issue`（各被 Mailbox 读）和 `channel_message`（被收件箱读）有第二个模块在读，写都在自己的模块里。

还没收敛的，按「一件事一条路、一个意思一个名字」看有四处：

1. **往频道写一条话有七个入口。** `say`（主人）、`tellSession`、`speak`（帮工和管家经工具）、`announce`（稿子）、`spoken`（通话）、`orchestratorSays`、`notice`（系统）。往下都落进同一个 `write(Write)`（`channel/writing.ts`），不同的只是写之前的检查：`speak` 查重复、先看没读的、跨串要确认；`say` 收附件和 `sendKey`；`spoken` 写进默认频道；`notice` 以 `system` 名义。`writing.ts` 里 `post(w, heard)` 只有 `write` 一个调用方，`heard` 永远是 `settle`，多了一层没用的参数。

   另有一条旁路：`tellSession` 找不到帮工的串时不写消息，直接 `recordTrigger` 加 `receive` 给那个帮工。这是主人在工单上对帮工直说（`tool/issue.ts`）。

2. **管家的会话有三条登记的路。** `Session.registerOrchestrator` 在 `channel/hub.ts`（`seat`，管家开口前）、`issue/dispatch.ts`（`beginOrchestrator`）、`mailbox/work.ts`（`forward`，投递前）各被调一次，都是「用之前先确保有」。频道的 `seat` 对参与者表也是同样的写法。档案是 Agent 的事，它变了没有流告诉别人，所以每个用到的人都得自己补。

3. **「在农场上」有两个意思，用了一个词。** `Session.present(id)` 是这个进程里有它的 hand（`hands.has`），能交给它一封信；`Session.presentSessions()` 是核心状态里所有 worker（`core.state().sessions`），和 hand 无关。`sessionOf(id)` 也读核心状态，但连管家一起读。三个名字问的是两个问题，名字没说出区别。

4. **记下触发和交给 Mailbox 永远是两步。** 六处（频道两处、工单三处、定时、收件箱、GitHub）都是先 `recordTrigger` 再 `receive({ _tag: "Trigger" })`。这一处看过、决定不改：记下要在调用方自己的事务里（GitHub 的游标、工单的派活和触发同进同退），交给 Mailbox 要在提交以后、拿 Mailbox 的写锁；只记不交也是真的用法（`regression: the source cursor and Mailbox trigger share commit and rollback without routing`、`cron replay supplies decoded source payloads without routing them`）。这是事务外箱的两步，不是两条路。

Channel 对外 48 个成员、其中 30 个只有 http 在用，是接口宽，不是路径分叉；不在这次。

## Proposal

**一、调用表做成检查。** `scripts/service-paths.ts` 用上面的读法写出「服务成员 → 调用模块」，存进 `scripts/service-paths.json`；任务 `paths:check`，和 `practice:check` 一样只在本机提交前跑。规则只有两条：表里没有的边（一个模块开始用另一个服务的某个成员）就失败，要么走已有的门，要么跑 `--write` 明确加上；边只许少。失败时说：哪个模块、哪个成员、现在谁是这件事的门（`Fix:`）、`See` 本 Note。

**二、频道写话收成一个 `post`。** `Channel.post(Post)`，`Post` 按谁说的分：

| `_tag` | 取代 | 写之前的检查 |
|---|---|---|
| `Owner` | `say` | `sendKey`、附件 |
| `Agent` | `speak`、`orchestratorSays` | 帮工：查重复、没读的、跨串确认；管家：一整条、不查 |
| `Artifact` | `announce` | 带卡片 |
| `Spoken` | `spoken` | 默认频道、不唤醒 |
| `Notice` | `notice` | 以 `system` 名义、按 `code` 去重 |

`tellSession` 改名说它做的事（`toSession`：对一个帮工说，有串写在串里，没串直接交给它），留着，因为它的落点不只是频道。`writing.ts` 的 `post(w, heard)` 并进 `write`。旧名字写进 `scripts/stale-names.ts`。

**三、管家的会话只在一处登记。** Session 开机时登记现有的管家，并经 `Agent.whenKept` 挂上同一个登记：档案存下（新建、改、装模板、按模板更新）时，在写档案的那次调用返回之前登记好，登记失败那次写就失败；`registerOrchestrator` 从接口上拿掉，频道、工单、Mailbox 不再补。用流（Agent 发 `Saved`、Session 订）试过：流是异步的，改完名立刻读还是旧名字，所以用同步的挂钩。频道的 `seat` 只管它自己的参与者表，照旧。

**四、「在」分成两个名字。** `present(id)` 改名 `isReachable(id)`（这个进程拿着它的 hand、能交信；hand 在两次启动之间也在，所以不叫 attached；是非照命名表写 `isX`）；`presentSessions()` 改名 `workers()`（核心状态里的 worker）；`sessionOf` 不变。`naming.md` 的双关表补一行 present。

改名都用 tsgo 的 LSP 重命名（`textDocument/rename`），判别字段和字面量用 ast-grep 限定在列出的文件里改，不用正则。

## 进度

| 步 | 状态 | 提交 | 做了什么 |
|---|---|---|---|
| 调用表做成检查 | 完成 | `2901cd8e1` | `scripts/service-paths.ts`、`vp run paths:check`（提交前的钩子），表在 `scripts/service-paths.json` |
| 管家的会话 | 完成 | `902031e44` | `Agent.whenKept`；顺带修了改名要重启才显示 |
| 「在」分成两个名字 | 完成 | `72cac0f0f` | `isReachable`、`workers` |
| 频道写话 | 未做 | — | 见下 |

频道写话还没动：七个入口的返回和错误不同（`{ message, again }`、`Spoken` 的 sent/held/confirm、`ChatMessage`、`boolean`；`notice`、`orchestratorSays` 不失败），收成一个 `post` 要么靠条件类型加断言，要么调用方拆走不到的分支。`writing.ts` 那层多余的参数已经并掉，落点本来就是一个 `write`。

## Alternatives considered

- **dependency-cruiser 管模块边。** 只看 import，这里的依赖经 `yield* Service`，看不到；它能管的「包之间只经包名」已经有 lint。
- **LSP 的 `callHierarchy/incomingCalls` 做函数级调用链。** 能从一个写入点往回追每条路，比成员表细；但慢（每个符号一次请求），结果也难做成稳定的基线。先用成员表做闸门，需要追一条具体的路时再用它。
- **`recordTrigger` 在提交后自己 `receive`。** 要 Db 支持提交后的钩子，还要区分只记不交的用法，换来的只是少写一行；见 Problem 第 4 条。

## Acceptance criteria

- `vp run paths:check` 在新加一条服务成员的调用边时失败，提示里有 `Fix:` 和 `See`；`--write` 之后通过。
- `Channel` 的接口上没有 `say`、`speak`、`announce`、`spoken`、`orchestratorSays`、`notice`，只有 `post`；频道、工单、稿子、通话、管家、工具都经它写话。
- `Session` 的接口上没有 `registerOrchestrator`；新存的管家档案不经任何调用方就有会话（测试：存一个管家档案，`sessionOf` 立刻读得到）。
- `present`、`presentSessions` 不在代码里，`stale-names` 拦着。
- `vp check`、`server:check`、`effect:check`、`practice:check`、`health:verify`、`docs:verify` 通过；没有 `regression:` 测试被删或改名，改了的在 PR 正文点名。

## Risks

- **`post` 的联合太大，变成一个大 switch。** 每个 `_tag` 的检查留在各自的小函数里，`post` 只分派，落点是同一个 `write`。
- **Agent 的流晚到。** 试过，会：改名后立刻读到旧名字。改用 `whenKept` 同步挂钩，见 Proposal 三。顺带发现改名只写了库、没进核心状态，原来要重启才显示新名字，已修（`regression: an orchestrator profile has its session as soon as it is kept, and its new name as soon as it is renamed`）。
- **调用表误报。** 绑定没写成 `const x = yield* S` 的（解构、经参数传进来的端口）看不到，表会少算；它只拦新边，少算不会误拦，但会漏。漏的写在脚本的说明里。
