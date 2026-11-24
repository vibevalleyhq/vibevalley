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
| `rules.ts` | 能在测试的规则层测 | 它决定的事：`due.ts`、`patrol.ts`、`report.ts`；解析某个概念的，合进那个概念的文件（工单的细化在 `crates/core/src/refine.rs`） |
| `state.ts`、`data.ts`、`hooks.ts` | 在框架里的角色 | 它管的东西：`groups.ts`、`calendar.ts`、`lanes.ts` |
| `utils`、`helpers`、`common`、`misc`、`lib` | 没有归属 | 用它的概念；两个模块都用的，放进下层拥有它的模块 |
| `text.ts` | 形式是文字 | 说给谁、说什么：`digest.ts`、`mentions.ts` |
| `XManager`、`XHandler`、`XService`、`XUtil` | 角色 | 服务按它管的东西叫（`Issue`），函数按它做的事叫 |

代码的技术性质不进名字，交给检查：

| 性质 | 谁查 |
|---|---|
| 页面和服务端都跑 | `packages/protocol/src/rules/contract.test.ts` |
| 页面的分层 | lint 的 `vibevalley/page-layers` |

名字说性质，说的是写的人怎么实现、怎么测，读的人要找的却是哪件事；性质变了，名字也跟着错。位置本身就是约定、而且有检查守着的，可以用：`prompts.ts`（对模型说的话，lint 在这里放行中文）、`index.ts`（一个 feature 对外的入口，`page-layers` 查）、`packages/protocol/src/rules`（两边都跑的，`contract.test.ts` 查）、`testing/` 和 `testing.ts`（测试用的，金字塔认它们）。

**起不出名字就先拆。** 一个文件或函数只能用「和」连起来说，或只能用上表左边的词概括，说明它管了不止一件事：拆成几份，每份再起名。左边这些名字 `scripts/audit/file-names.test.ts` 拦下，`apps/`、`packages/` 里一个也没有。

## 单数和复数

名字用单数，除非值本身是一组：数组、`Map`、`Set`、一张列表、一个数，或返回好几个的接口和函数。复数说的是「好几个」，读的人会照着去遍历它；一个对象、一样东西用复数，就让读的人以为手里是一组。

| 复数是必要的 | 复数是多余的 |
|---|---|
| `issues: Issue[]`、`SpaceState.issues` | 服务 `Issue`（服务是一个，写 `Issue`） |
| `issue.list`、`repo.list`（返回好几个） | 管一张表的存取对象 `Memory`（写 `MemoryStore`） |
| `runsOf(session)`、`questionsOf(issue)`（返回好几个） | 只放一样东西的文件 `memories.ts`（写 `store.ts`） |
| 一个数：`maxTasks`、`keepClosedIssues`、`autoRetries` | 返回一样东西的函数用复数名 |
| 在内存里装着一组的：`Assignments`、`Deliveries`、`Trajectories` | |

几个有名字的取值拼成的一份（`HireOptions`、`BoardProps`、`VoiceSettings`）照英语的习惯用复数：它确实是好几项。用语表里本身就是复数的词照用语表（`Changes` 是「改动」：一个分支上的提交和文件）。以 s 结尾的单数词（`Status`、`Progress`、`Alias`）是单数。

## 查询和命令

只回答问题、不改东西的，用名词或判断；会改东西、有副作用的，用动词。读的人从名字知道调用它安不安全。

| 什么 | 形状 | 例子 |
|---|---|---|
| 取或算出某样东西的某一项 | `xOf` | `channelOf`、`quotaOf`、`summaryOf` |
| 是非 | `isX`、`hasX`、`canX` | `isClosed`、`hasFarm` |
| 从人或模型写的文字里读出结构 | `parseX` | `parseRefinement`、`parseSplit` |
| 检查一份输入 | `xProblem`：没问题返回 `""`，有问题返回用户读的理由 | `cronProblem`、`channelNameProblem` |
| 给用户看的一句话 | `xText` | `quotaText`、`dueText` |
| 只说会怎样、不改东西 | `previewX` | `previewDelete`、`previewForget` |
| 改东西 | 动词 | `issues.edit`、`channels.react` |
| 新建、删掉 | `create`、`delete`（和接口的动词同一个词；不用 `open`、`remove`） | `channels.create`、`agents.delete`、`previewDelete` |
| 一个模块往外说发生了什么 | 事实（`Fact`），经 `Hub::apply` 折进核心状态，别的模块读转变（`Watcher`）；成员用领域里的过去时 | `FactCronChanged`、`FactCronRemoved` |

两条容易犯的：

- **一个名字只答一个问题**：带标签的参数只用来给同一个动作不同的输入（一个 enum 参数的各变体都是同一个动作的输入）；两个不同的问题（筛法、排序、结果不同）起两个名字，不用标签把它们并成一个（撤回一封信、撤回投递、停下、辞退各是一个名字，不并成一个 `withdraw`）。
- **命令不只答一个是非**：做没做成要么抛一个说得出为什么的错误，要么返回做成的结果；只返回 `boolean` 的命令，调用方不知道没做成的原因。

## 单位、时刻和长短

- 时长带单位：`stalePauseMs`、`idleWaitMs`（Rust 里用 `Duration`）；时刻用 `At`：`createdAt`、`closedAt`、`endedAt`，本身就说一刻的词（`since`、`until`）不另加。只写 `timeout`、`time` 时，读的人不知道是毫秒还是秒、是一段还是一刻。
- 名字的长短跟作用域走：三行的回调里用 `c`、`p`、`e`，模块级的、导出的写全。

## 文件和代码的形状

| 什么 | 形状 | 例子 |
|---|---|---|
| 服务端的模块 | 单数，概念的词 | `crates/server/src/work/issue/`、`collab/channel/` |
| 页面的 feature | 和服务端的模块同名 | `apps/mac/ui/features/issue` |
| 包 | `@vibevalley/<文件夹>`（`scripts/audit/catalog.test.ts` 查） | `packages/protocol` 是 `@vibevalley/protocol` |
| 组件 | 大驼峰，一个组件一个文件 | `Board.tsx`、`IssueDetail.tsx` |
| 其他文件 | 小驼峰 | `moves.ts`、`pageTests.test.ts` |
| 测试 | 挨着被测的文件 | `outline.test.ts` |
| 服务端模块对外的结构体 | 按它管的东西叫，不叫 `XService`、`XManager` | `Agents`、`Chat`、`Crons`、`Repos` |
| 带牌子的 id（页面） | `XId` | `IssueId`、`SessionId` |
| 一组固定的取值 | 成员表 `XValues`，类型从它推；要每种都处理时用 `Record<X, …>` | `IssueStatusValues` |

服务端模块和线上的形状撞名时，线上的形状用契约里的名字（`vibevalley_protocol::Issue`），模块的结构体用复数或它管的事；别的库撞名的，导入时起别名（`use … as`）。

## 线上和存盘的形状

| 什么 | 形状 | 例子 |
|---|---|---|
| 接口 | `<模块>[.<名词>].<动词>`，单数；路径是 `POST /api/v1/<模块>[/<名词>]/<动词>` | `channel.message.send`、`issue.list` |
| 接口的动词 | 先用这几个：`list`、`get`、`create`、`update`、`delete`、`previewDelete`、`set`、`toggle`、`start`、`stop`；别的动作用它在领域里的词 | `channel.markRead`、`issue.refine` |
| 表 | `<模块>` 或 `<模块>_<概念>`，单数；索引以表名开头 | `channel_message`、`media_job` |
| 词典的键 | `<宿主>.<模块>.…`，两边都说的在 `shared` | `web.issue.boardLabels.lane.todo`、`server.connector.qqKeys` |
| 页面测试的标记 | `testID` 说它是什么，小写加连字符 | `route-missing`、`native-workspace` |
| 分支 | `<类>/<主题>`，主题是英文小写加连字符 | `chore/repo-health` |

## 现有的双关

下面这些词在仓库里还指不止一样东西。新代码只用左列的那个意思；右列的意思各起各的名字（不靠上下文区分，也不带限定凑合），改完把旧名字写进 `scripts/docs/stale-names.ts`。

| 词 | 指的是 | 也被用来指 |
|---|---|---|
| rules | 测试金字塔的规则层 | 业务的纯函数（按它决定的事起名，不叫 `rules.ts`）；lint 规则（`scripts/audit/oxlint-plugin.ts`）；写给 agent 的规矩用「规矩」，不用 rules |
| open | 形容词，还没了结（`openQuestions`、`openFindings`） | 动词新建（`openChannel`、`openBranch`）：改叫 `create`；农场上线（`Core.open`）：改叫 `goLive`；一个帮工的投递（`openDeliveries`）：改叫 `deliveriesOf` |
| input | 媒体的输入文件（`Media.inputs`、接口 `media.input.*`） | 交给帮工的信（`returnInput`）：改叫 envelope；喂给模型的文字（`wakeInput`）：改叫 prompt；一封信给模型看的上下文（`InputContext`）：改叫 `EnvelopeContext` |
| orchestrator | 职务：助手能做什么、该做什么（`T.AgentRole`、`Agent.isOrchestrator`，工具和权限） | 会话怎么来（一直当值）：改问 `isOnDuty`，雇来的问 `isHired`；在哪干：改问 `Agent.isHosted`；频道没有负责人：频道和串都有成员（`members`，记在 `channel_member`），这里的助手问 `orchestratorIn`；话是谁说的：actor 是 `agent`，带 `role`（[角色只管职责](docs/subsystems/agent.md#模型和不变量)） |

已经分开的：语音的授予是 `voice.grant.*`、通话是 `voice.call.*`（`VoiceCall`），不再借 session 和 agent；校验一份输入是 `validate`（`setting.validate`、`repo.validate`、`agent.validate`，结果是 `Validation`），试一把钥匙是 `voice.moss.verify`，check 只指跑一遍检查（`vp check`、仓库的 `.vibevalley/check`、验收标准的 `CriterionCheck`）。

## 改名

- 改名是一个决定：理由写进提交或 Note，旧名字写进 `scripts/docs/stale-names.ts`，不让它回来（[地基](docs/subsystems/foundation.md#为什么这样)）。
- 只在名字不能区分、在调用处不够用或成了双关时改；换一个同义词不算理由。
- 标识符用编辑器的重命名和类型检查改，字符串、SQL、Markdown 逐处改，不全局替换。
