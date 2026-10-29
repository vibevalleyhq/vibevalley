# 命名

文件、文件夹、类型、函数、接口、表、词典的键和测试的标记都照这一篇起名。叫法用哪个词（工单还是 ticket，界面上叫什么）见 [用语表](docs/README.md#用语) 和 [code.md](docs/style/code.md#叫法)；本篇管名字的视角和形状。

## 视角

名字回答「这里管什么事」，站在领域的视角，用用语表里的词：`lanes.ts`（看板的栏和拖动）、`moves.ts`（工单能往哪挪）、`recall.ts`（下回想起什么）、`due.ts`（定时任务什么时候到点）。读代码的人从名字就知道要找的东西在不在里面。

代码的技术性质不进名字，交给检查：

| 性质 | 谁查 |
|---|---|
| 纯不纯、能在哪一层测 | 测试金字塔按 import 认层（`@vibevalley/testkit/pyramid`） |
| 页面和服务端都跑 | `packages/protocol/src/rules/contract.test.ts` |
| 模块的先后 | `apps/server/src/modules.test.ts` |
| 页面的分层 | lint 的 `vibevalley/page-layers` |

名字说性质时，它说的是写代码的人怎么实现、怎么测，读的人要找的却是哪件事；性质改了名字也跟着错。

例外只有位置本身就是约定、而且有检查守着的几个：`prompts.ts`（对模型说的话，lint 在这里放行中文）、`index.ts`（一个 feature 对外的入口，`page-layers` 查）、`packages/protocol/src/rules`（两边都跑的，`contract.test.ts` 查）、`testing/` 和 `testing.ts`（测试用的，金字塔认它们）。

## 不用的名字

| 不用 | 它说的是 | 换成 |
|---|---|---|
| `rules.ts` | 能在规则层测 | 它决定的事：`due.ts`、`patrol.ts`、`report.ts`；解析某个概念的，合进那个概念的文件（`parseRefinement` 在 `issue/refinement.ts`） |
| `state.ts`、`data.ts`、`hooks.ts` | 框架里的角色 | 它管的东西：`groups.ts`、`calendar.ts`、`lanes.ts` |
| `utils`、`helpers`、`common`、`misc`、`lib` | 没有归属 | 放进用它的概念；两个模块都用的，放进下层拥有它的模块 |
| `text.ts` | 形式是文字 | 说给谁、说什么：`digest.ts`、`mentions.ts` |
| `XManager`、`XHandler`、`XService`、`XUtil` | 角色 | 服务按它管的东西叫（`Issues`），函数按它做的事叫 |
| 一个文件装几个概念 | — | 一个概念一个文件，文件名就是概念 |

仓库里还有十九个 `rules.ts` 和一批 `state.ts`、`data.ts`：改到其中一个时，把动到的部分按上表搬到概念的文件里，不往里加新的。

## 文件和文件夹

| 什么 | 怎么起 | 例子 |
|---|---|---|
| 服务端的模块 | 单数，概念的词 | `apps/server/src/issue`、`channel` |
| 页面的 feature | 和服务端的模块同名 | `apps/web/src/features/issue` |
| 包 | `@vibevalley/<文件夹>`（`scripts/catalog.test.ts` 查） | `packages/health` 是 `@vibevalley/health` |
| 组件 | 大驼峰，一个组件一个文件 | `Board.tsx`、`IssueDetail.tsx` |
| 其他文件 | 小驼峰 | `moves.ts`、`pageTests.test.ts` |
| 测试和故事 | 挨着被测的文件 | `moves.test.ts`、`Board.stories.tsx` |

## 代码里的名字

| 什么 | 形状 | 例子 |
|---|---|---|
| 服务 | 管一类东西的用复数，管一样东西的用单数；接口是 `XShape`，建它的是 `make`、`layer` | `Issues`、`Channels`；`Core`、`Orchestrator`；`IssueShape` |
| 服务的标签 | `vibevalley/<概念>` | `"vibevalley/Issue"` |
| `Effect.fn` 的名字 | `<服务>.<方法>` | `"Issues.edit"`、`"Memories.search"` |
| 带牌子的 id | `XId` | `IssueId`、`SessionId` |
| 一组固定的取值 | 成员表 `XValues`，类型从它推；要每种都处理时用 `Record<X, …>` | `IssueStatusValues` |
| 取或算出某样东西的某一项 | `xOf` | `channelOf`、`quotaOf`、`summaryOf` |
| 是非 | `isX`、`hasX`、`canX` | `isClosed`、`hasFarm` |
| 从人或模型写的文字里读出结构 | `parseX` | `parseRefinement`、`parseSplit` |
| 检查一份输入 | `xProblem`：没问题返回 `""`，有问题返回主人读的理由 | `cronProblem`、`channelNameProblem` |
| 给主人看的一句话 | `xText` | `quotaText`、`dueText` |
| 只说会怎样、不改东西 | `previewX` | `previewDelete`、`previewForget` |

同一个意思全仓库用一个词：两个模块各写一个 `quotaText` 是一处重复，合成一份放进拥有额度的模块。

## 线上和存盘的名字

| 什么 | 形状 | 例子 |
|---|---|---|
| 接口 | `<模块>[.<名词>].<动词>`，单数；路径是 `POST /api/v1/<模块>[/<名词>]/<动词>` | `channel.message.send`、`issue.list` |
| 接口的动词 | 先用这几个：`list`、`get`、`create`、`update`、`delete`、`previewDelete`、`set`、`toggle`、`start`、`stop`；别的动作用它在领域里的词 | `channel.markRead`、`lan.pair` |
| 表 | `<模块>` 或 `<模块>_<概念>`，单数；索引以表名开头（`src/base/schema.test.ts` 查） | `issue`、`channel_message`、`session_run` |
| 词典的键 | `<宿主>.<模块>.…`，两边都说的在 `shared` | `web.issue.boardLabels.lane.todo`、`server.connector.qqKeys` |
| 页面测试的标记 | `data-testid` 说它是什么，小写加连字符；状态写成属性 | `issue-card`、`desk-status`；`data-state` |
| 分支 | `<类>/<主题>`，主题是英文小写加连字符 | `chore/repo-health` |

## 改名

- 改名是一个决定：理由写进提交或 Note，旧名字写进 `scripts/stale-names.ts`，不让它回来（[地基](docs/subsystems/foundation.md#为什么这样)）。
- 只在旧名字有歧义或站错了视角时改；换一个同义词不算理由。
- 标识符用编辑器的重命名和类型检查改，字符串、SQL、Markdown 逐处改，不全局替换。
