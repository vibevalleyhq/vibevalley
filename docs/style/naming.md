# 命名

文件、文件夹、类型、函数、接口、表、词典的键和测试的标记都照这一篇起名。叫法用哪个词（工单还是 ticket，界面上叫什么）见 [用语表](docs/README.md#用语) 和 [code.md](docs/style/code.md#叫法)；本篇管名字怎么起。

## 三条原则

1. **能区分**：名字说出这里和别处不同的那件事。检验办法：把名字换到另一个模块的另一个文件上，它还成立，就是坏名字。`rules.ts`、`utils.ts`、`data.ts`、`state.ts` 放在哪个模块都成立；`moves.ts`（工单能往哪挪）、`recall.ts`（下回想起什么）、`lease.ts`（家目录的租约）只在一处成立。
2. **在调用处正好够用**：名字是在调用处读的，调用处已经写了的不重复，没写的要补上。具名导出在调用处只剩函数名，所以写 `issueTitle`，不写 `title`；服务的方法前面有服务，所以写 `issues.edit`，不写 `issues.editIssue`。
3. **一词一义**：一个词在整个仓库只指一样东西，一样东西只用一个词。同一个意思两个模块各起一个名字，是重复；同一个词指两样东西，是双关，读的人得看上下文才知道是哪个。

## 用哪一类词

业务里的东西用业务的词（用语表）：`Issue`、`Session`、`moves`、`recall`。技术机制用技术上的通名：`lease`（租约）、`breaker`（熔断）、`cursor`、`relay`、`queue`。两类词都说得出「这里是什么」；不用的是两类都不是的：

| 不用 | 它说的是 | 换成 |
|---|---|---|
| `rules.ts` | 能在测试的规则层测 | 它决定的事：`due.ts`、`patrol.ts`、`report.ts`；解析某个概念的，合进那个概念的文件（`parseRefinement` 在 `issue/refinement.ts`） |
| `state.ts`、`data.ts`、`hooks.ts` | 在框架里的角色 | 它管的东西：`groups.ts`、`calendar.ts`、`lanes.ts` |
| `utils`、`helpers`、`common`、`misc`、`lib` | 没有归属 | 用它的概念；两个模块都用的，放进下层拥有它的模块 |
| `text.ts` | 形式是文字 | 说给谁、说什么：`digest.ts`、`mentions.ts` |
| `XManager`、`XHandler`、`XService`、`XUtil` | 角色 | 服务按它管的东西叫（`Issues`），函数按它做的事叫 |

代码的技术性质不进名字，交给检查：

| 性质 | 谁查 |
|---|---|
| 纯不纯、能在哪一层测 | 测试金字塔按 import 认层（`@vibevalley/testkit/pyramid`） |
| 页面和服务端都跑 | `packages/protocol/src/rules/contract.test.ts` |
| 模块的先后 | `apps/server/src/modules.test.ts` |
| 页面的分层 | lint 的 `vibevalley/page-layers` |

名字说性质，说的是写的人怎么实现、怎么测，读的人要找的却是哪件事；性质变了，名字也跟着错。位置本身就是约定、而且有检查守着的，可以用：`prompts.ts`（对模型说的话，lint 在这里放行中文）、`index.ts`（一个 feature 对外的入口，`page-layers` 查）、`packages/protocol/src/rules`（两边都跑的，`contract.test.ts` 查）、`testing/` 和 `testing.ts`（测试用的，金字塔认它们）。

**起不出名字就先拆。** 一个文件或函数只能用「和」连起来说，或只能用上表左边的词概括，说明它管了不止一件事：拆成几份，每份再起名。仓库里还有十九个 `rules.ts` 和一批 `state.ts`、`data.ts`，多是这样来的：改到其中一个时，把动到的部分搬到概念的文件里，不往里加新的。

## 查询和命令

只回答问题、不改东西的，用名词或判断；会改东西、有副作用的，用动词。读的人从名字知道调用它安不安全。

| 什么 | 形状 | 例子 |
|---|---|---|
| 取或算出某样东西的某一项 | `xOf` | `channelOf`、`quotaOf`、`summaryOf` |
| 是非 | `isX`、`hasX`、`canX` | `isClosed`、`hasFarm` |
| 从人或模型写的文字里读出结构 | `parseX` | `parseRefinement`、`parseSplit` |
| 检查一份输入 | `xProblem`：没问题返回 `""`，有问题返回主人读的理由 | `cronProblem`、`channelNameProblem` |
| 给主人看的一句话 | `xText` | `quotaText`、`dueText` |
| 只说会怎样、不改东西 | `previewX` | `previewDelete`、`previewForget` |
| 改东西 | 动词 | `issues.edit`、`channels.react`、`lan.forget` |

## 单位、时刻和长短

- 时长带单位：`stalePauseMs`、`weixinPollMs`、`idleWaitMs`；时刻用 `At`：`createdAt`、`closedAt`、`endedAt`，本身就说一刻的词（`since`、`until`）不另加。只写 `timeout`、`time` 时，读的人不知道是毫秒还是秒、是一段还是一刻。
- 名字的长短跟作用域走：三行的回调里用 `c`、`p`、`e`，模块级的、导出的写全。

## 文件和代码的形状

| 什么 | 形状 | 例子 |
|---|---|---|
| 服务端的模块 | 单数，概念的词 | `apps/server/src/issue`、`channel` |
| 页面的 feature | 和服务端的模块同名 | `apps/web/src/features/issue` |
| 包 | `@vibevalley/<文件夹>`（`scripts/catalog.test.ts` 查） | `packages/health` 是 `@vibevalley/health` |
| 组件 | 大驼峰，一个组件一个文件 | `Board.tsx`、`IssueDetail.tsx` |
| 其他文件 | 小驼峰 | `moves.ts`、`pageTests.test.ts` |
| 测试和故事 | 挨着被测的文件 | `moves.test.ts`、`Board.stories.tsx` |
| 服务 | 管一类东西的用复数，管一样东西的用单数；建它的是 `make`、`layer` | `Issues`、`Channels`；`Core`、`Orchestrator` |
| 服务的接口 | `XShape` | `IssueShape` |
| 服务的标签和 `Effect.fn` 的名字 | `vibevalley/<概念>`；`<服务>.<方法>` | `"vibevalley/Issue"`；`"Issues.edit"` |
| 带牌子的 id | `XId` | `IssueId`、`SessionId` |
| 一组固定的取值 | 成员表 `XValues`，类型从它推；要每种都处理时用 `Record<X, …>` | `IssueStatusValues` |

`XShape` 是按角色起的后缀，是上面那条的例外：Effect 的 `Context.Service` 要一个类当标签、一个接口当形状，两个名字都指同一个服务，后缀只用来分开它们。

## 线上和存盘的形状

| 什么 | 形状 | 例子 |
|---|---|---|
| 接口 | `<模块>[.<名词>].<动词>`，单数；路径是 `POST /api/v1/<模块>[/<名词>]/<动词>` | `channel.message.send`、`issue.list` |
| 接口的动词 | 先用这几个：`list`、`get`、`create`、`update`、`delete`、`previewDelete`、`set`、`toggle`、`start`、`stop`；别的动作用它在领域里的词 | `channel.markRead`、`lan.pair` |
| 表 | `<模块>` 或 `<模块>_<概念>`，单数；索引以表名开头（`src/base/schema.test.ts` 查） | `issue`、`channel_message`、`session_run` |
| 词典的键 | `<宿主>.<模块>.…`，两边都说的在 `shared` | `web.issue.boardLabels.lane.todo`、`server.connector.qqKeys` |
| 页面测试的标记 | `data-testid` 说它是什么，小写加连字符；状态写成属性 | `issue-card`、`desk-status`；`data-state` |
| 分支 | `<类>/<主题>`，主题是英文小写加连字符 | `chore/repo-health` |

## 现有的双关

下面这些词在仓库里还指不止一样东西。新代码只用左列的那个意思；其余的意思改名之前，写的时候带上限定。

| 词 | 指的是 | 也被用来指 |
|---|---|---|
| rules | 测试金字塔的规则层 | 业务的纯函数（`rules.ts`，照「起不出名字就先拆」逐个拆）；lint 规则（`scripts/oxlint-plugin.ts`）；写给 agent 的规矩用「规矩」，不用 rules |

已经分开的：语音的授予是 `voice.grant.*`、通话是 `voice.call.*`（`VoiceCall`），不再借 session 和 agent；校验一份输入是 `validate`（`setting.validate`、`project.validate`、`agent.validate`，结果是 `Validation`），试一把钥匙是 `voice.moss.verify`，check 只指跑一遍检查（`vp check`、项目的 `.vibevalley/check`、验收标准的 `CriterionCheck`）。

## 改名

- 改名是一个决定：理由写进提交或 Note，旧名字写进 `scripts/stale-names.ts`，不让它回来（[地基](docs/subsystems/foundation.md#为什么这样)）。
- 只在名字不能区分、在调用处不够用或成了双关时改；换一个同义词不算理由。
- 标识符用编辑器的重命名和类型检查改，字符串、SQL、Markdown 逐处改，不全局替换。
