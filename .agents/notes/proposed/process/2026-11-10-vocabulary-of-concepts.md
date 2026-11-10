# Agent Note: 概念表：关键名词由结构认定，逐个批准，名字由它们拼出

Status: proposed

## Problem

`naming.md` 要求一词一义，现在只有一个方向有检查：`scripts/glossary.ts` 查用语表「代码里」一列的名字还在代码里。反方向没有：代码里多出一个没人批准过的名词，没有检查会报。`scripts/stale-names.ts` 是改名以后补的正则黑名单，只拦已经知道的旧名字。

2026-11-10 用 `parseSync` 抽了一遍，量是这样的：

| 范围 | 声明 | 拆成词 |
|---|---|---|
| `packages/protocol/src/*/shapes.ts`、`api.ts` | 629 个导出名、621 个字段、134 个字面量 | 709 个词，354 个只出现一次 |
| `packages/protocol/src/*/shapes.ts` 的类型 | 474 个，其中 74 个带 `id` | 261 个不同的末尾词 |
| `apps/server/src` 的导出名 | 2407 个 | 1536 个词，955 个不在 protocol 里 |
| `apps/server/db/migrations/0001_schema.up.sql` | 46 张表 | |
| `apps/server/src` 的服务 | 31 个 | |

按词批准做不完，也批不到点上：跨模块最多的词是 `request`（15 个模块）、`kind`（11）、`fact`（10）、`changed`（9）、`status`（9）、`update`（8），它们说的是形状的角色，不是名词。

同一批证据里已经能看到没理清的名词（[概念初稿](#概念初稿)的「待理清」一列和[精确的概念](#精确的概念)）：`Delivery` 在 `issue` 是交付的结果、在 `mailbox` 是一次投递；说「谁做的」有三套分类、八个字段名；`machine` 在英文界面指农机，在代码里指一台电脑。

概念现在写在三处，互不检查，同一件事各写一遍：

| 写了什么 | `docs/concepts.md` | 用语表（`docs/README.md`） | `docs/reference/concept-map.md` |
|---|---|---|---|
| 概念是什么 | 「东西」表的「是什么」（25 行） | 「意思」一列（60 行上下） | |
| 代码里叫什么 | 「代码里」一列 | 「代码里」一列 | 「协议」「服务端」「存储」三列 |
| 农场里画成什么 | 「农场是皮」表 | 「农场的皮」表 | 「农场里」一列 |

三处已经对不上：记性在用语表叫记性、在 `concepts.md` 叫记忆；`concept-map.md` 写的 `artifact_revision`、`artifact_op`、`pkm_undo` 三张表在库里叫 `artifact_block_revision`、`artifact_change`、`pkm_change`。

## Proposal

### 道：不变的几条

1. **关键名词是问得出「哪一个」的东西。** 有很多个，每个靠一个 id 或键认得出。取值、部件、只有一个的服务都不是；词频不决定它关不关键。
2. **批的是概念和它的关系，不是字面。** 一个概念的定义写明它指向谁、谁指向它。说不出和邻居的关系，就是没理清。
3. **一个概念一个名字，一个名字一个概念。** 同一个词在两个模块指两样东西，改其中一个的名字，不靠前缀或上下文区分（[命名](docs/style/naming.md)的第三条原则）。
4. **其余的名字是拼出来的。** 概念以外的导出名由「概念 + 角色词 + 通用技术词」拼成，不用批；拼不出来的就是新名词。
5. **两张表，一张手写，一张生成。** 手写的是概念表：人批准的，一个概念一行，定义、叫法都在这一行。生成的是清单：脚本从代码读出每个概念在各层的名字。同一件事不在第三处写。
6. **机器找，模型疑，人定。** AST 认定概念、查名字拼不拼得出；同义和双关要懂意思，由模型标出疑点；批准只由用户做。

### 术：怎么做

**三类名词。** 脚本从结构认出候选，分成三类；只有第一类进概念表。

| 类 | 是什么 | 怎么认 | 2026-11-10 的数 |
|---|---|---|---|
| 概念：东西 | 有很多个、每个认得出是哪一个，有开始有结束，中间会变 | 一张有主键的表；一个带 `id` 的形状（去掉 `*Request`） | 35 |
| 概念：事 | 在某一刻发生、记下以后不改的一件 | 只有加、没有改和删的表；带 `at` 或 `seq`、没有别的可变字段的形状 | 6 |
| 模块 | 只有一个、管一件事的服务 | `extends Context.Service` 的类，且没有同名的概念 | 17 |
| 属于概念的 | 离开所属的概念就不存在的部件，或它的一个取值 | 封闭联合（`XValues`）；没有 `id` 的形状；外键指向所属概念且联着删的表 | 70 上下 |

检验一个名词是不是概念，问「哪一个」：问得出（哪张工单、哪一轮）是概念；问不出（哪个优先级）是属性；离开所属的那一个就没法问（哪条验收意见，得先说哪张工单）是部件。

**清单带证据。** 清单就是生成的 `concept-map.md`。每个概念列出：归哪个模块、哪条规则认定的、字段、它指向的概念（字段的类型是别的概念或 `XId`、表的外键）、指向它的概念。批准的人读的是关系。

**概念表的一行。** 概念（代码里的名字）、一句话是什么、认它靠什么、属于它的部件和属性、中文叫法、English、不用的词；按模块分组。指向谁、在哪张表、哪个服务不写进这一行：那是清单读出来的。

**拼名规则。** 导出名按大小写拆开，每一段应是下面三类之一，否则报：

| 类 | 例子 | 放在哪 |
|---|---|---|
| 概念，和属于它的部件、属性 | `Issue`、`Session`、`Run`；`Priority`、`Phase`、`Finding` | 概念表的「概念」和「属于它的」两列 |
| 角色词 | `Request`、`Update`、`View`、`Kind`、`Status`、`Changed`、`Removed`、`List`、`Preview`、`Summary`、`Id` | `docs/concepts.md` 的「角色词和通用技术词」表，30 个上下 |
| 通用技术词 | `Max`、`Ms`、`At`、`Count`、`Key`、`Hash`、`Cursor` | 同一张表 |

**存量走棘轮。** 检查上线时拼不出来的名字记数，只许减（`scripts/ratchet.ts` 现成的写法）。

**模型审同义和双关。** 照 `scripts/comment-review.ts` 的做法：把清单和证据交给模型，它标出疑似同义（两个概念指向同一批邻居、定义相近）和疑似双关（一个词在两个模块的字段不同）。存量审一次；之后概念表有新增时只审新增的行。结论由用户逐条定，模型不改概念表。

**批准的流程。**

1. 跑 `vpx scripts/vocabulary.ts`，读报出的新名词和它的证据。
2. 新名词是已有概念的另一个叫法时，改名。
3. 新名词是新概念时，在概念表加一行，PR 正文里点名。
4. 用户在评审里批这一行。

### 器：用什么

| 工具 | 做什么 |
|---|---|
| `scripts/vocabulary.ts` | 用 `vite` 的 `parseSync`（`scripts/service-paths.ts` 同一个）按上面三类的认法读出清单和证据；读概念表；对两边 |
| `docs/concepts.md` | 概念表（手写）。脚本照 `scripts/glossary.ts` 读用语表的办法读它 |
| `scripts/vocabulary.ratchet.json` | 拼不出来的名字的存量，按包记数 |
| `vp run vocabulary:check` | 概念不在概念表、概念表的概念不在代码里、拼不出的名字超过棘轮，三种都失败；失败的话写明哪个名字、`Fix:`、`See`。进提交前的钩子和 CI |
| `vp run vocabulary` | 重写 `docs/reference/concept-map.md`（清单）；`docs:verify` 查它是不是最新，照 `docs/reference/capabilities.md` 的做法。`vpx scripts/vocabulary.ts --review` 让模型标疑点（要钥匙、花钱，先问用户） |
| `scripts/glossary.ts`、`scripts/i18n.ts` | 改成读概念表的「叫法」「English」「不用」三列；「代码里」那条检查由 `vocabulary:check` 接走 |
| `scripts/stale-names.ts` | 留着：它拦的是退役的名字，概念表管在用的 |

**概念的地方收成两处，落后的删掉。** 手写的概念表在 `docs/concepts.md`，生成的清单在 `docs/reference/concept-map.md`。别处写着同一件事的，不留、不标「已过时」、不留跳转的空节，直接删；历史在 git 里。

| 删掉 | 里面还成立的去哪 |
|---|---|
| `docs/README.md` 的「用语」整节（「叫法」表和「农场的皮」表） | 概念的行进概念表，占「叫法」「English」「不用」三列；不是概念的行（在场、空位、完成、取消、关上、派活、起草、验收、巡查）进 `docs/concepts.md` 的「状态和动作」表，每行写明属于哪个概念；农场的词进「农场的皮」表。10 个链到这一节的文档改链到 `docs/concepts.md` |
| `docs/concepts.md` 的「东西」表 | 换成概念表，按模块分组 |
| `docs/concepts.md` 的「农场是皮」表 | 和用语表的「农场的皮」表合成一张 |
| `docs/concepts.md` 的「Host 和 Space」里讲 Host 的部分 | 照[`Host`](#host)定下来的写；`Host` 不再是概念的话整段删 |
| `docs/reference/concept-map.md` 手写的「看得见的几层」「服务端以下」两张表 | 不搬：整篇换成生成的，每个概念一行，列是表、服务、协议的形状、接口的前缀、页面的 `features/<概念>` |
| `docs/reference/concept-map.md` 的「oar 那一层」表 | 挪进[帮工](docs/subsystems/session.md)，那里已经讲 Session 和 oar 会话 |
| `docs/subsystems/session.md` 的「三层概念」表 | `Session`、`Run`、`Machine` 是什么在概念表；这一节只留不变量 |
| `docs/subsystems/issue.md`「状态和用语」里手写的取值表 | 取值由清单生成，叫法在词典（`shared.json`）和「状态和动作」表；这一节只留哪个字段由谁定 |

删完以后 `docs/concepts.md` 是讲模型的文字（Space、一件活怎么走、Session 和 oar 会话）加四张表：概念、状态和动作、农场的皮、角色词和通用技术词。

子系统文档讲一个概念的模型和不变量，不重写它是什么、取值有哪些。现在已经写错的三处（[其余](#九其余)的后两行）不单独改，跟着所在的表一起删。

**人和 agent 的叫法（用户定，2026-11-10）。**

- 不再把人叫「用户」：人有自己的名字（`user_account.name`，能改），界面和提示词里称呼他时用这个名字，泛称写「你」或「用户」。
- 「管家」改叫「助手」：界面、词典、提示词、文档里都换；助手的名字照旧是它档案的名字，能改（`agent.update`）。代码里的 `orchestrator` 跟着概念表的第 4 步再定。
- 帮工也能改名字：档案的名字今天就能改；一个帮工（`Session.name`）还没有改名的接口，要加。

这一节以前写的「用户」都指用户，跟着叫法的改动一起改。

**分步。**

1. 用户审下面的初稿，定[精确的概念](#精确的概念)里每一条改不改。
2. 落 `scripts/vocabulary.ts`、概念表和检查，范围是 protocol、表和服务名；拼名规则在 protocol 上拦。同一个改动里删掉上表列的文档，改完链接。
3. 服务端内部的导出名（2407 个）只出报告，不拦；看过例外的数量再定收不收紧。
4. 定下要改的名字，每个概念一个改动，`stale-names` 拦旧名字。

第 2 步和第 4 步分开提：第 2 步不改行为，第 4 步每一个都改名字和存盘的取值。

## 概念初稿

脚本认出的候选按[三类名词](#术怎么做)分：

| 类 | 个数 | 去向 |
|---|---|---|
| 概念 | 41：东西 35，事 6 | 下面的概念表，一个一行 |
| 模块 | 17 | 不进概念表：它管什么写在[子系统](docs/subsystems/README.md)的目录里，名字由 lint 的 `singular-service` 和文件夹查 |
| 属于概念的（部件、属性） | 70 上下 | 写在所属概念那一行的「属于它的」一列 |

定义照 `docs/concepts.md`、用语表、`shapes.ts` 的注释和表结构写。「认它靠」是表的主键或形状的 `id`。「待理清」指向[精确的概念](#精确的概念)里的一组，或写明没核实的地方。上线时这张表补上叫法三列，搬进 `docs/concepts.md`，本 Note 删掉。

### 概念

**地方和人**

| 概念 | 是什么 | 认它靠 | 属于它的 | 待理清 |
|---|---|---|---|---|
| `Space` | 一套独立的工作：若干仓库、工单、频道和一份笔记 | 目录 `$VIBEVALLEY_WORK_ROOT` | `SpaceState`（它的核心状态）、`StateFrame`（推给页面的一帧）、`call`（现在有没有在通话） | `scope` 四个意思都不是它（第九组） |
| `Machine` | 一台登记过的电脑；Session 在其中一台上干活 | `machine.id` | `here`、`online`、家目录 | 用语表里农机的英文是 machine；`Host` 并进来（见下） |
| `Device` | 用户的一台设备，一台一把钥匙；配对来的或登录来的 | `user_device.id` | `came` | 代码里叫 `UserDevice`（[用户和设备](docs/subsystems/user.md)） |
| `User` | 这个服务端唯一的那个人 | 固定的 `user` | | 用语表「代码里」一列还写 owner |
| `Actor` | 做了一件事的那个：`User`、一个 `Agent`、VibeValley 自己，或外面的人和程序 | `kind` 加 `id` | `ActorKind` | 现在叫 `TriggerActor`，另有两套分类、八个字段名（第一组） |

**档案和农机**

| 概念 | 是什么 | 认它靠 | 属于它的 | 待理清 |
|---|---|---|---|---|
| `Agent` | 一份档案：在哪种农机上、用哪个模型、什么人设、带哪些技能 | 档案的 id | `AgentRole`、`Persona`、`Look`、`MCPServer` | `packages/agent` 是 VibeValley 自己的 agent 程序，同一个词 |
| `AgentTemplate` | 一份档案的配方，装一份多一个 `Agent` | 模板的 id 加 `version` | `AgentTemplateSource` | |
| `Skill` | 档案能带的一项技能 | 技能的 id | | |
| `Runtime` | 机器上的一种编码 agent 程序 | 它的 id（`pi`、`claude`、`codex`……） | `RuntimePreset`、`Installation`、`RuntimeQuota`、`AccountUsage`、`RuntimeSettings` | 形状叫 `RuntimeInfo` |
| `Model` | 一个能用的模型 | 模型的 id | | 现在是两个形状：`ModelEntry`（农机的）、`ProviderModel`（供应商的）；`voice` 里的 `Model` 是第三样（第八组） |
| `ProviderConnection` | 一条模型供应商的连接：适配器和钥匙 | 连接的 id | `ProviderBinding`（哪种用途用它的哪个模型） | `connection` 还指 `ToolConnection`（第九组） |
| `Todo` | agent 给自己记的一条待办，不是工单 | `runtime_todo` 的 `graph` 加 `id` | | 归 `runtime` 模块，用它的是 `packages/agent` |

**仓库**

| 概念 | 是什么 | 认它靠 | 属于它的 | 待理清 |
|---|---|---|---|---|
| `Repo` | 空间里的一个 git 仓库 | `repos/` 下的名字 | `Branch`、`BranchCheck`、`BranchPublication`、`RepoActivity` | 形状叫 `RepoSummary`；`game` 里另有一个 `Repo`（第八组） |
| `Commit` | 一次提交 | git 的 sha | | |
| `IssueTemplate` | 写工单的一份现成模板 | 模板的 id | `TemplateKind` | 归 `repo` 模块；`template` 两个意思（第九组） |

**工单**

| 概念 | 是什么 | 认它靠 | 属于它的 | 待理清 |
|---|---|---|---|---|
| `Issue` | 一件活，从写下到关上是同一个；可以指一个 `Repo`，可以有父工单 | `issue.id`；`number` 是给人说的号 | `IssueStatus`、`IssueStage`、`Priority`、`Mandate`、`Constraints`、`Criterion`、`Finding`、`Question`、`Deliverable`、`Delivery`、`Changes`、`Conflict`、`PullRequest`、`Worktree`、`Milestone`、`IssueAct` | `Delivery` 双关（第三组）；`status` 和 `stage`（第二组） |
| `Assignment` | 一张工单由一个档案负责的一段；换人或清空才结束 | `issue_assignment.id` | `executions`（这一段里干过活的 Session） | `executor` 三个意思（第四组） |

**帮工**

| 概念 | 是什么 | 认它靠 | 属于它的 | 待理清 |
|---|---|---|---|---|
| `Session` | 一个档案工作的执行上下文：做一张工单，或接一个私聊；跨多轮、休眠和重启是同一个 | `session.id`（`w1`、`w2`……，整个空间不重号） | `Phase`、`Doing`、`Workplace`、`SessionClose`、`ToolConnection`、`Spent` | 帮工是角色为 `worker` 的 Session，不是全部 Session（第四组） |
| `Run` | 一个 Session 的一轮：一次触发到一次汇报 | `session_run.id` | `RunTrigger`、`Outcome`、`IssueReport`（这一轮交回来的） | `RunTrigger` 和 `Trigger`（第五组） |
| `SessionEvent` | 一轮里的一步：收到的话、想、说、一次工具调用 | Session 加 `seq` | `SessionEventType`、`ToolAction` | 一样东西叫 step、activity、event（第六组） |

**核心状态**

| 概念 | 是什么 | 认它靠 | 属于它的 | 待理清 |
|---|---|---|---|---|
| `Fact` | 改核心状态的一件事 | 没有 id；折进去以后是一个 `seq` | 每一种 `Fact*` | 名字不贴（第十组） |
| `LiveEvent` | 不改核心状态、只是路过的一条：一步、一句提醒、农机的探测结果 | 没有 id | `Notice` | 三个成员在 `ServerEvent` 里又写了一遍（第六组） |

**信箱**

| 概念 | 是什么 | 认它靠 | 属于它的 | 待理清 |
|---|---|---|---|---|
| `Trigger` | 外面来的一件事标准化成的一张：哪个 `Actor`、从哪、对谁、带什么 | `mailbox_trigger.id`；同一来源的同一件事只存一次（`source` 加 `source_key`） | `TriggerSource`、`TriggerAddressing`、`CompactCard` | `TriggerKind` 没搜到用它的地方（第五组） |
| `Delivery` | 一个 `Trigger` 给一个 Session 的一次投递，和它走到哪 | `session_id` 加 `envelope_id` | `Envelope`（Session 读到的样子）、`urgency`、`held_by`；工单蓄水池（`mailbox_issue`：发往工单的输入先在这里等）、工单订阅（`mailbox_subscription`：哪个串的输入归哪张工单） | 和工单的 `Delivery` 同名（第三组） |
| `InboxItem` | 要用户处理的一件事，从核心状态现算，不存 | 算出来的 id | `InboxKind` | `PkmTier` 也有一个 `inbox`（第八组） |

**频道**

| 概念 | 是什么 | 认它靠 | 属于它的 | 待理清 |
|---|---|---|---|---|
| `Channel` | 说话的地方：频道、私聊、挂在一条消息下的串，三种是同一样东西 | `channel.id` | `ChannelType`、`Member`（谁在里面、从哪条起）、`ReadCursor`、`Notify` | 取值 `channel` 和概念同名（第八组） |
| `Participant` | 一个 `Actor` 在频道里的身份：能被 @、能被私聊，活得比一次 Session 长 | `channel_participant.id` | | `kind` 把角色和层混在一起（第一组） |
| `Message` | 频道里的一条消息 | `channel_message.id`；`number` 是它在频道里的号 | `MessageKind`、`Mention`、`Reaction`、`Embed` | 现在叫 `ChatMessage`，另有 `ChannelMessage`、`Chat`（第六组） |
| `Attachment` | 一条消息带的一个文件 | `attachment.id` | | `CardAttachment`、媒体任务的 `attachment` 列 |
| `Connector` | 一个聊天软件接到一个频道上的那条线 | 它的 id（`weixin`、`feishu`、`qq`） | `ConnectorState`、`ConnectorAccount` | 形状叫 `ConnectorStatus`（第二组） |

**Artifact 和笔记**

| 概念 | 是什么 | 认它靠 | 属于它的 | 待理清 |
|---|---|---|---|---|
| `Artifact` | 留下来要人看的一篇：一块一块写的，或一稿一稿换的网页 | `artifact.id` | `ArtifactVersion`（网页的一稿）、`ArtifactCard`、`ArtifactBody` | `version`、`revision`、`rev`（第七组） |
| `Block` | 块 Artifact 里的一块 | `artifact_block.id`，在它的 Artifact 里 | `BlockType`、`BlockOp`（对它的一次修改） | 不带 `Artifact` 前缀，`PkmBlock` 带（第八组） |
| `Suggestion` | 对一块提的一条修改建议，等人接受或拒绝 | `artifact_suggestion.id` | `SuggestionStatus` | 和 `PkmComment` 是不是同一样东西（第九组） |
| `PkmPage` | 笔记里的一个页面，一个 Markdown 文件 | `slug` 或 `file`：两个都在形状上，哪个是键待核实 | `PkmBlock`、`PkmComment`、`PkmTier`、`PkmMarker` | |

**记性、定时、媒体、语音**

| 概念 | 是什么 | 认它靠 | 属于它的 | 待理清 |
|---|---|---|---|---|
| `Memory` | 一份档案记得的一件事 | `memory.id` | `MemoryKind`、`MemoryScope` | 用语表叫记性，`concepts.md` 叫记忆 |
| `MemorySource` | 外面的一个记性来源，写在设置里 | `kind`（`nowledge`、`everos`），一种一个 | | `source` 六个意思（第九组）；另有一个 `MemorySourceInfo` |
| `Cron` | 一张工单的一种触发：到点开它的一轮 | `cron.id` | `CronWhen` | 取值 `cron` 和概念同名（第八组） |
| `MediaInput` | 传给媒体任务的一份输入文件 | `media_input.id` | `MediaInputPhase` | |
| `MediaJob` | 一个生图、理解或语音合成的任务 | 任务的 id | `MediaPhase`、`MediaCleanup` | 形状叫 job，表也叫 job（`media_job`，按 `kind` 分） |

**游戏**

| 概念 | 是什么 | 认它靠 | 属于它的 | 待理清 |
|---|---|---|---|---|
| `LedgerEntry` | 账本里值得记的一件事 | `game_ledger.id` | 每一种 `LedgerEntry*` | |
| `Achievement` | 从账本折出来的一个里程碑 | 成就的 id | `AchievementCategory`、`AchievementTier`、`Unlock` | 工单的 `Milestone` 是另一样东西 |

### 东西和事

概念分两种，问的问题不一样：

| | 东西 | 事 |
|---|---|---|
| 是什么 | 持续存在、中间会变的 | 在某一刻发生、记下以后不改的 |
| 要答的 | 什么时候有、什么时候没、中间怎么变 | 谁记下、记在哪、留多久 |
| 名字 | 名词（`Issue`、`Session`） | 名词，成员用过去时（`issueChanged`、`Hired`） |

事有 6 个，其余 35 个是东西：

| 事 | 谁记下 | 记在哪 | 改不改、留多久 |
|---|---|---|---|
| `Fact` | `Core.apply` | 不存：折进核心状态，折完是一个 `seq` | 不改 |
| `LiveEvent` | `Core` | 不存：只推给在听的页面 | 不改，过了就没了 |
| `SessionEvent` | `Journal` | `events/<id>.json` | 流式的一步按 `revision` 更新，落盘后不改；帮工留最近 240 条、助手 1000 条，离场 30 天后清文件 |
| `Trigger` | `Mailbox.recordTrigger` | `mailbox_trigger` | 内容不改，同一来源的同一件事留第一次的；路由回执（`routed_at`）另写；库里没有删它的查询 |
| `LedgerEntry` | `Game` | `game_ledger` | 只加，库里没有改和删它的查询 |
| `Commit` | git | 仓库里 | 不改；它是 git 的，VibeValley 只读 |

`Message` 能改、能删、能加表情，是东西。`Milestone` 是事，但它是从别的事算出来给人看的一行，挂在 `Issue` 下面。

### 有和没

能从文档和表结构确认的 8 个；其余 27 个东西这一列待补，第 1 步审的时候逐行答。

| 东西 | 什么时候有 | 什么时候没 | 中间不换的 |
|---|---|---|---|
| `Issue` | 写下时；即时派活先写表拿号再开 Session，启动失败且工作目录干净就撤回 | 库里有删它的查询，谁调没查；关上（`done`、`canceled`）不是没，能重开；核心状态只留没关的和最近关的 50 张 | 换人、重开，id 不变 |
| `Assignment` | 指派一个档案 | 换人或清空指派（写 `ended_at`） | 同一个档案继续负责时，换 Session 不换它 |
| `Session` | 派活（`hire`）；和一个档案私聊；助手的在档案存下时登记 | 阶段到 `closed`：从核心状态拿掉，`session` 表里留着 | 多轮、休眠、重启；底下的 oar 会话可以换 |
| `Run` | 一次触发；带着 `brief` 的 `sessionPhaseChanged` | 一次汇报（`sessionReported`），写下 `outcome` | 中途插进来的话记进这一轮的 `heard`，不另开 |
| `Delivery` | `Mailbox.receive` 算出谁该听到，一个 Session 一行 | 到 `consumed`（模型真的读到）或 `dropped` | `handed` 以后没收到回执，退回 `pending` 再投 |
| `Machine` | 服务端开机时没有就记下自己这台 | 没查 | |
| `Participant` | 参与者加入（`joined_at`） | 离开（`left_at`），行留着 | |
| `Artifact` | 没查 | 没查 | 网页 Artifact 一稿一稿换，id 不变 |

这一列答出来的三件事，直接决定前面几组怎么改：

- **`Session` 的 `closed` 是「没」，不是一个阶段。** 它在 `Phase` 里和 `working`、`resting` 并列，但到了它 Session 就从核心状态拿掉了。第二组的 `phase` 应只装还在的时候走到哪；怎么没的（`SessionClose`）单独一个字段。
- **`Issue` 关上不是没。** 所以 `done`、`canceled` 是 `status` 的取值，不是结束；`delivered` 和 `canceled` 两个字段说的是「这次关上的结果」，重开以后应清掉。清没清没查。
- **`Run` 的开始和结束是两个事实**，`Trigger` 是存下的一件事。每一轮是不是都由恰好一个 `Trigger` 开始（第五组的问题），看的就是这两个事实里带没带 `Trigger` 的 id。

### `Host`

`docs/concepts.md` 写 Host 是「本机的 VibeValley」：`$VIBEVALLEY_HOME` 下的密钥、农机探测、全局档案模板、日志。[一个服务端管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)以后，这几样分到两边：密钥、模板、日志归服务端，农机探测归机器，机器另有自己的家目录放它的钥匙。「本机」不再是一个地方。

建议：`Host` 不再是概念。`$VIBEVALLEY_HOME` 是家目录，服务端有一个，每台 `Machine` 有一个，约定在 `packages/home`。要用户定：这样做以后，「服务端」是不是一个概念。从代码里面看它只有一个；从 `Device` 和 `Machine` 看，它们连的是「某一个服务端」。

### 模块

17 个服务只有一个，不问「哪一个」，不进概念表：

| 模块 | 管什么 |
|---|---|
| `Core`、`Projection` | 持有核心状态；把事实折进去、拼成帧 |
| `Setting` | `settings.json`、配置和环境变量 |
| `Provider` | 模型供应商的接入 |
| `Tool`、`Mcp`、`Resource` | 给 agent 的工具、VibeValley 自己的 `/mcp`、只读的 `resource_read` |
| `Executor` | oar 执行实例的创建、投递、中断和释放 |
| `Mailbox`、`Ingress` | 谁该听到、什么时候叫醒；外面的来源进来的门 |
| `Inbox` | 算出要用户处理的事 |
| `Orchestrator` | 助手：用户直接说话的 agent |
| `Pkm`、`Media`、`Voice`、`Lan`、`Game` | 笔记、媒体任务、通话和听写、「连接到本机」、账本折出的金币和成就 |

其余 14 个服务里，11 个和一个概念同名（`Issue`、`Session`、`Channel`……），那一行已经在概念表里；3 个是地基（`ServerConfig`、`Db`、`PublicHttp`）。

### 不算概念的

有名字、有形状或有表，但不在概念表里占一行的：

| 名字 | 它是什么 | 为什么不是概念 |
|---|---|---|
| `ServerEvent` | `LiveEvent` 的待理清 | 它是 `Fact`、快照和 `LiveEvent` 的并集，不是一样新东西 |
| `Execution` | `Assignment` 的 `executions` | 它存的就是 Session |
| `ModelEntry`、`ProviderModel` | `Model` | 两个形状说的都是一个模型 |
| `Thread` | `Channel` 的一种 | 只是 `ChannelType` 的一个取值 |
| `Member`、`ReadCursor`、`Mention`、`Reaction`、`Embed` | `Channel`、`Message` 的部件 | 离开所属的那一个就不存在 |
| `Finding`、`Question`、`Criterion`、`Milestone`、`PullRequest`、`Worktree` | `Issue` 的部件 | 同上 |
| `IssueStatus`、`Priority`、`Phase`、`Outcome`、`PkmTier`、`CronWhen` 等封闭联合 | 所属概念的属性 | 是一个取值，不是一样东西 |
| `Refinement`、`Recall`、`Subagent`、`Dictation` | 动作，或一个取值 | 起草、想起是动作，进「状态和动作」表 |
| `IssueChildDraft`、`PkmSource`、`ArtifactCard`、`FarmView`、`Plot`、`Progress`、`Crop` | 输入或画面的形状 | 是某个概念给某处看的样子 |
| `OrchestratorEval` | 不进 | 评测的样例，不是领域里的东西 |
| `Host` | 家目录，服务端和 `Machine` 各有一个 | 拆成服务端和机器以后不再是一个地方 |
| `VoiceCall` | `Space` 的 `call` | 形状里只有 `agentId`，没有 id；核心状态里是一个 `CallState` |
| `StateFrame` | `Space` 给页面的样子 | 是核心状态折到某个 `seq` 的一帧，不是另一样东西 |

## 精确的概念

### 什么叫精确

一个概念精确，是这五个问题各有一句答案，而且答案只在一处：

| 问 | 答的是 | `Run` 的答案 |
|---|---|---|
| 是什么 | 它属于哪一类，和最近的邻居差在哪 | 一个 Session 的一次工作；和 Session 的差别是它有头有尾 |
| 怎么算同一个 | 靠什么认它，重启、重开以后还是不是它 | `session_run.id`；重启不换 |
| 什么时候有、什么时候没（事：谁记下、留多久） | 谁让它开始，谁让它结束 | 一次触发开始，一次汇报结束 |
| 和邻居几对几 | 指向谁，被谁指向 | 一个 Session 多个 Run；一个 Run 至多一张工单 |
| 谁改它 | 拥有它的模块 | `session` |

词不精确有四种，下面每一组都标了是哪种：

| 种类 | 是什么 | 例子 |
|---|---|---|
| 双关 | 一个词指两样东西 | `Delivery` |
| 同义 | 两个词指一样东西 | `ServerEventStep` 和 `LiveEventSession` |
| 名不副实 | 名字说的和装的不一样 | `Chat` 里没有消息 |
| 层次混 | 一个词既是一样东西，又是它的一个取值或属性 | `Channel` 的 `type` 有一个取值叫 `channel` |

### 一、谁（同义，影响面最大）

「一个做了事的人或程序」现在有三套分类、八个字段名。

| 在哪 | 分类 |
|---|---|
| `ActorKind`（`common`） | `user`、`agent`、`system` |
| `TriggerActorKind`（`mailbox`） | `user`、`collaborator`、`bot`、`ci`、`agent`、`system` |
| `channel_participant.kind` | `user`、`orchestrator`、`session`、`profile`、`system` |
| `Assignment.executions[].kind` | `worker`、`orchestrator` |

字段名：`actor`（`Trigger`、`artifact_change`、`artifact_block_revision`）、`author`（`memory`、`artifact_suggestion`、`pkm_comment`）、`by`（`artifact.by_id` 和 `by_name`、`cron.set_by`、`PkmComment.by`）、`sender`（`channel_message.sender_id`）、`from`（`ChatMessage`、`Envelope`、`InboxItem`、`ChannelLast`）、`who`（`Milestone`、`InboxItem`）、`keeper`（`runtime_todo`）、`holder`（`media_input_pin`）。

`TriggerActor` 已经是完整的形状：`kind`、`id`、`role`、`name`。`ChatMessage` 和 `Envelope` 各把同样四个字段摊开写了一遍（`from`、`fromKind`、`fromRole`、`name`）。

精确的说法，三层分开：

| 概念 | 是什么 | 怎么算同一个 |
|---|---|---|
| `Actor` | 做了一件事的那个：用户、一个 agent、VibeValley 自己，或外面的人和程序 | `kind` 加 `id` |
| `Participant` | 一个 Actor 在频道里的身份：能被 @、能被私聊；活得比一次 Session 长 | `channel_participant.id` |
| `Member` | 一个 Participant 在一个频道里，从哪条消息起、因为什么 | 频道加参与者 |

建议：

1. `TriggerActor` 改叫 `Actor`，挪到 `common`；`ChatMessage`、`Envelope` 用它，不再摊开。
2. 存「谁做的」的字段一律叫 `actor`。`from` 只留给「从哪来」，`keeper`、`holder` 是「归谁」，另算。
3. `ActorKind` 是基础的三种；`collaborator`、`bot`、`ci` 是外面的 Actor，要么并进 `ActorKind`，要么 `TriggerActorKind` 改名说明它多出来的是「外面的」。
4. `channel_participant.kind` 的 `orchestrator`、`session`、`profile` 都是 `agent`，区别是角色和层（档案还是它的一个 Session）。拆成 `kind`（照 `ActorKind`）加两列。`profile` 是用语表的英文叫法，代码里这样东西叫 `Agent`。

### 二、到哪了（同义）

`phase`、`status`、`state`、`stage` 四个词，现在按模块随手用。

| 词 | 现在用在 | 取值由谁定 |
|---|---|---|
| `status` | `Issue`、`Suggestion`、`PkmComment`、`PullRequest` | 人的决定（挪、接受、拒绝） |
| `status` | `ToolConnection`、`Installation`、`ConnectorStatus`（整个形状） | 程序自己走 |
| `phase` | `Session`、媒体任务、`MediaInput` | 程序自己走 |
| `state` | `ConnectorState`、`CallState`、`mailbox_delivery`、`mailbox_issue`、`runtime_todo`、`connector_outbox` | 程序自己走 |
| `stage` | `IssueStage` | 从 `status` 和 Session 的 `phase` 算出来 |

`phase` 和 `state` 在这里没有区别。`IssueStage` 的字段叫 `state`，类型叫 `IssueStageKind`，一个形状里三个词。

精确的说法，按「谁定的」分三个词：

| 词 | 是什么 | 例子 |
|---|---|---|
| `status` | 人的决定能改的位置 | `Issue.status`、`Suggestion.status` |
| `phase` | 一个在跑的东西自己走到哪 | `Session.phase`、媒体任务、连接器、通话、投递、`Todo` |
| `stage` | 算出来给用户看的，不存 | `IssueStage` |

`state` 只留给「一整份状态」（`SpaceState`、`StateFrame`）。建议：`ConnectorState`、`CallState` 和四张表的 `state` 列改 `phase`；`ToolConnection.status`、`Installation.status` 改 `phase`；`IssueStage.state` 改 `kind`；`ConnectorStatus` 这个形状改名（它是连接器的全部现状，不是一个位置）。

### 三、怎么结束的（双关、名不副实）

| 现在 | 装的是 | 问题 |
|---|---|---|
| `Issue.deliver: Deliverable` | 要交什么：改动、分支、回答、PR | 和下一行只差两个字母 |
| `Issue.delivered: Delivery` | 完成时怎么落的：合了、合进父分支、PR、提交了、留分支、没有 | 和 `mailbox_delivery` 双关 |
| `mailbox_delivery` | 一个信封给一个 Session 的一次投递 | 同上 |
| `Issue.canceled: IssueCanceled` | 为什么取消：被请走、工作目录丢了 | 字段名是状态，装的是原因 |
| `PhaseClosed.closed: SessionClose` | 帮工怎么走的：合了、做完、被请走、丢了 | 同上；取值是 `Delivery` 和 `IssueCanceled` 各一半 |
| `Outcome` | 一轮怎么结束：做完、没做成、被打断 | 精确 |
| `CheckResult` | 一条完成线过没过 | `result` 还指 `BlockOpResult`、`runtime_todo.result`（一段文字） |

建议：

1. 工单一侧改名：`delivered: Delivery` 改成 `landed: Landing`（改动落在哪）。`deliver: Deliverable` 留着。信箱的 `Delivery` 留着，它在[信箱](docs/subsystems/mailbox.md)里是状态机的主语。反过来改也成立（信箱的改叫别的），二选一由用户定。
2. 装原因的字段叫 `xWhy`，照 `mailbox_delivery.dropped_why`：`Issue.canceledWhy`、`PhaseClosed.why`。
3. `SessionClose` 的四个取值里，`merged`、`completed` 说的是工单，不是帮工。帮工走只有三种：活完成了、被请走、丢了。

### 四、执行（双关、名不副实）

| 现在 | 装的是 |
|---|---|
| 服务 `Executor` | 管 oar 执行实例的创建、投递、中断和释放 |
| `Execution`（`executor/executor.ts`） | 一个活着的 oar 执行实例，只在内存里 |
| 表 `issue_assignment_execution`、`Assignment.executions` | 一条派工关联下干过活的 Session |
| 列 `issue_assignment_execution.executor` | 一个 Session 的 id |
| 列 `runtime_todo.executor` | 谁做这条待办：`self` 或 `subagent` |

`executor` 一个词三样东西。建议：表改 `issue_assignment_session`，列改 `session`，`Assignment.executions` 改 `sessions`；`runtime_todo.executor` 改 `by`。`Executor` 和 `Execution` 只留给 oar 那一层。

另一处同义：用语表写「帮工 = Session」，又写档案的角色是「助手或帮工（`worker`）」。助手也有 Session（`Session.role` 是 `orchestrator`）。精确的说法：Session 是执行上下文；帮工是角色为 `worker` 的 Session。`worker` 这个取值和 `Assignment.executions[].kind` 的 `worker` 是同一个词，留一处。

### 五、触发（双关）

| 现在 | 装的是 |
|---|---|
| `Trigger`（`mailbox_trigger`） | 外面来的一件事，标准化以后的一张：谁、从哪、对谁、带什么 |
| `RunTrigger`、`session_run.triggered_by` | 一轮为什么开始：`issue`、`comment`、`cron`、`refine`、`runtime` |
| `TriggerMeta.trigger: RunTrigger` | 一个 `Trigger` 里面装着一个 `RunTrigger` |
| `TriggerKind` | `ci`、`review`、`comment`；`apps/server/src` 的非测试代码里没搜到用它的地方 |

建议：`RunTrigger` 改叫 `RunCause`（`session_run.cause`），`Trigger` 只指信箱收到的那一张。`TriggerKind` 没人用就删。要用户定的一个模型问题：每一轮是不是都由恰好一个 `Trigger` 引起。是的话 `Run` 直接指 `Trigger` 的 id，`RunCause` 不用存。

### 六、消息和事件（名不副实、同义）

| 现在 | 装的是 | 问题 |
|---|---|---|
| `ChatMessage` | 频道里的一条消息；表 `channel_message`，id `MessageId` | 三个名字 |
| `ChannelMessage` | 跟随者收到的一条事件：`{ _tag: "Message", message }` | 和上一行只差前缀 |
| `Chat` | 频道的列表和 @ 用户的消息；注释写「不含说的话」 | 名不副实 |
| `MessageKind` 的 `chat` | 一条普通的话 | 层次混 |
| `ServerEventStep`、`ServerEventNotice`、`ServerEventRuntime` | 状态流里不改状态的三种 | 和下一行字段完全相同 |
| `LiveEventSession`、`LiveEventNotice`、`LiveEventRuntime` | 同上 | 同义；`Step` 和 `Session` 是同一个成员的两个名字 |
| `type: "event"`、字段 `activity: SessionEvent` | 帮工的一步 | 一样东西叫 step、activity、event 三个名字 |

建议：概念叫 `Message`（`ChatMessage` 改名，`MessageEdit`、`MessageHit`、`MessageId` 已经是这个词）；`ChannelMessage` 改成 `ChannelEvent` 的成员 `Said`；`Chat` 改成它装的东西。`ServerEvent` 写成 `Fact | ServerEventSnapshot | LiveEvent`，删掉重复的三个。帮工的一步定一个词：用语表叫轨迹里的一条，`concepts.md` 叫事件，建议 `SessionEvent`，`LiveEvent` 里的成员叫 `LiveEventStep`、字段叫 `event`。

### 七、第几（同义）

| 词 | 现在用在 | 精确的说法 |
|---|---|---|
| `version` | `artifact.version`、`artifact_version`、`AgentTemplate.version` | 人看得见的一稿，一稿一个数 |
| `revision`、`rev` | `Channel`、`ChatMessage`、`SessionEvent`、`ProviderStatus`、`artifact_block.rev` | 一样东西改过几次的计数，两份比大小 |
| `seq` | `StateFrame`、`SessionEvent`、`artifact_change`、`mailbox_trigger`、`channel_participant` | 一条流里的第几个 |
| `number` | `Issue`、`ChatMessage` | 人说得出口的号（#12） |
| `position`、`rank`、`order_key` | 侧栏、`mailbox_delivery`、`runtime_todo`；`Issue.rank`；`artifact_block.order_key` | 人排的顺序 |

前四个词现在用得一致，写进概念表的通用技术词并各带一句定义就够了。要改的：`rev` 改 `revision`；表 `artifact_block_revision` 存的是每个 `rev` 的文字，不是计数，改叫 `artifact_block_text`；`position`、`rank`、`order_key` 定一个。

### 八、裸名字（层次混）

[命名](docs/style/naming.md)的第二条原则：导出名在调用处只剩自己。下面这些在调用处是 `T.Model`、`T.Repo`：

| 名字 | 装的是 | 建议 |
|---|---|---|
| `Model`、`ModelValues`（`voice`） | Deepgram 的两个 ASR 型号 | `DeepgramModel` |
| `Voice`（`voice`） | OpenAI TTS 的六个音色；和服务 `Voice` 同名 | `OpenaiVoice` |
| `Area`、`Language`（`voice`） | 声网的区域、通话的语言 | 带上 `Voice` 或 `Agora` |
| `Repo`（`game`） | 一个仓库的路径和提交数 | `RepoCommits` |
| `Block`、`BlockOp`、`BlockType`、`BlockInput`（`artifact`） | Artifact 的块 | 和 `PkmBlock` 对称：`ArtifactBlock` |
| `Via`、`Balance`（`runtime`）、`Head`、`Build`（`agent`） | 装的方式、余额、长相的两部分 | 带上所属的概念 |

取值和概念同名的：`ChannelType` 的 `channel`、`CronWhenKind` 的 `cron`、`PkmTier` 的 `inbox`、`MemoryKind` 的 `note` 和 `issue`。取值改成它说的事（`cron` 改 `expression`，`inbox` 留给 `Inbox`）。

### 九、其余

| 问题 | 证据 | 建议 |
|---|---|---|
| `machine` 双关 | 表 `machine` 是一台电脑；用语表里农机的英文是 machine | 改用语表的英文 |
| `source` 六个意思 | `TriggerSource`、`AgentTemplateSource`、`KeySource`、`MemorySource`、`PkmSource`、媒体任务的 `source` | 逐个换成它说的事 |
| `kind` 和 `type` | `Channel.type`、`BlockType`、`SessionEventType`；`attachment.type` 是 MIME | 分类统一成 `kind`，`type` 只留给 MIME |
| `scope` 四个意思 | `memory.scope`、`mailbox_delivery.scope`、`IssueConstraints.scope`、`IssueReportMemoryScope` | 逐个换 |
| `check` 三个意思 | `CriterionCheck`、`BranchCheck`、`IssueConstraints.check`（一条命令）、`ingress_github` 的 CI check | 逐个换 |
| `template` 两个意思 | `AgentTemplate`；`IssueTemplate`、`TemplateKind`（归 `repo`） | `TemplateKind` 带上 `Issue` |
| `connection` 两个意思 | `ProviderConnection`、`ToolConnection`；`Connector` 是第三样 | 定义里写清 |
| 修改 Artifact 的词 | `BlockOp`（一个操作）、`artifact_change`（一批操作）、`Suggestion`（建议） | 表改 `artifact_batch`（它的键是 `batch_id`） |
| 批注两个名字 | Artifact 叫 `Suggestion`，笔记叫 `PkmComment`（状态里有 `suggested`） | 核实是不是同一样东西 |
| 故事两个名字 | `IssueTimeline`（里程碑加花费）、`IssueHistory`（工单加全部 Session） | `IssueHistory` 改成它装的 |
| 拼写 | `ToolConnectionStatus` 写 `cancelled`，别处写 `canceled` | 改 |
| 时刻的字段 | `Cron.created`、`PkmComment.created`、`Memory.at`、`SessionEvent.time`；别处是 `createdAt` | 统一成 `At` |
| `owner` | 用语表「代码里」一列写 owner，代码已改叫 user | 并进概念表时写 `User` |
| 文档里的旧表名 | `concept-map.md` 的 `artifact_revision`、`artifact_op`、`pkm_undo` | 跟着手写的表一起删 |
| 文档里的旧取值 | `docs/subsystems/issue.md` 写 `stage.state` 有 `refining`（代码是 `draft`）、`Session.phase` 有 `arriving`（代码里没有）；`docs/subsystems/session.md` 写 `RunTrigger` 有 `refining`（代码是 `refine`） | 跟着手写的取值表一起删；取值由清单生成 |

### 十、`Fact`（名不副实）

`Fact` 是 `Core.apply` 的输入，`reduce(state, fact)` 把它折进 `SpaceState`。19 个成员分两种：

| 种 | 个数 | 成员 | 带的是 |
|---|---|---|---|
| 一样东西现在是这样、或没了 | 13 | `issueChanged`、`channelChanged`、`messageChanged`、`cronChanged`、`machineChanged`、`connectorChanged`、`sessionChanged`、`mediaChanged`、`userMentionsChanged`、`callChanged`；`issueRemoved`、`channelRemoved`、`cronRemoved` | 整个新值，或一个 id |
| 发生了一件事 | 6 | `sessionPhaseChanged`、`sessionReported`、`sessionLeft`、`sessionToolChanged`、`sessionToolsReset`、`progressChanged` | 这件事的内容 |

名字不贴的三处：

- 事实通常指记下来、不会变的一条。这里不存：各模块先落库，再告诉 `Core` 让内存里的那份跟上（[核心状态](docs/subsystems/core.md)的「先落库，后发事实」），重启时从库里重新算。
- 三分之二的成员不是「发生了什么」，是「它现在的值」。
- 这个词会吸别的意思：`scripts/stale-names.ts` 有一条规则专门拦 `RuntimeFacts`、`RowFacts`、`FactsCard`、`FactContext` 等十个名字，都是把「知道的一件事」叫成了 fact。

| 候选 | 中文 | 贴在哪 | 撞在哪 |
|---|---|---|---|
| `Change` | 变更 | 现有的定义就是「核心状态的一次改变」；11 个成员以 `Changed` 结尾；折出来的那一对叫 `Transition` | `Changes`（工单分支的改动）、`artifact_change`、`pkm_change` |
| `SpaceEvent` | 空间事件 | 它是事，是 `Core` 那条流里的一条；`Event` 当角色词（某条流里的一条）和 `SessionEvent`、`ChannelEvent` 一致 | 和 `LiveEvent` 从名字上分不出哪个改状态；13 个成员带的是值，不是事 |
| `Fact`（不改） | 事实 | 说得出「已经发生，`Core` 不能拒绝」；已经收成一个意思 | 上面三处 |

没考虑的：`Update`（请求形状的角色词）、`Patch`（核心状态明说不发 patch）、`Action`（四个 `XAction` 在用，且指意图）、`Delta`（[实体增量](.agents/notes/proposed/architecture/2026-10-27-presence-and-entity-deltas.md)指推给页面的）、`Mutation`（`PkmMutation`）、`Transition`（已经是前后状态的一对）。

建议 `Change`，中文叫变更，成员去掉 `Fact` 前缀（`IssueChanged`，`type` 的取值不变）。撞的三处一并收：工单的 `Changes` 改叫 `Diff`，它的接口本来就是 `issue.diff.get`，界面上仍叫改动；`artifact_change` 照第九组改 `artifact_batch`；`pkm_change` 存的是一次修改的前后文字，改叫什么待定。

## Alternatives considered

**按词批准。** 把导出名、字段、字面量拆成词，全部进概念表。protocol 一处就是 709 个词，最常见的是 `request`、`kind`、`changed` 这类角色词；批的是字面，一个词在两个模块指两样东西时只看得到出现次数。

**清单不存盘，只当命令的输出。** 新名词必须先写进概念表才能过检查，再存一份清单是第二份状态。放弃的原因：`concept-map.md` 就是一份手写的清单，已经漂了三张表名；不生成它，就得留着手写的。

**把定义写成声明上的注释，从注释生成概念表。** 定义挨着代码，不会漂。放弃的原因：一个概念常常同时是表、服务和形状，没有唯一的声明可挂；[代码风格](docs/style/code.md)不让注释复述名字已经说了的。

**继续往 `stale-names.ts` 加正则。** 它只拦已经退役的名字，新造的名词要等有人发现才写得出规则。

**只让模型审，不要结构规则。** 模型分得出同义和双关，但每次读的范围不同、结论不稳定，不能做门禁；它用在 AST 做不了的那一步。

**另起 `docs/reference/vocabulary.md`，用语表和 `concepts.md` 不动。** 概念会写在四处，定义在其中三处各有一份。

**概念表按中文叫法组织**（留着用语表的样子，往里加代码名）。一个叫法可以对着几个代码名（「聊清楚、安排活、完成」），按它查代码要反着找；按代码名组织，叫法是它的一列。

## Acceptance criteria

- 用户逐条定过[精确的概念](#精确的概念)，初稿的每个「待核实」有结论。
- `docs/concepts.md` 有概念、状态和动作、农场的皮、角色词和通用技术词四张表。
- 「删掉」一列的八处都不在了，没有留「已过时」的标记或只剩一个链接的空节；`vp run docs:verify` 过（链到它们的文档都改了）。
- `vp run vocabulary:check` 在提交前的钩子和 CI 里跑：在 `packages/protocol/src/issue/shapes.ts` 加一个带 `id` 的 `interface Ticket`，检查失败，说出名字、`Fix:` 和 `See`；删掉概念表的一行，检查失败。
- protocol 里拼不出来的导出名进棘轮；`scripts/vocabulary.test.ts` 用样例文件测三类的认法和拼名规则。
- `docs/reference/concept-map.md` 由 `vp run vocabulary` 写出，开头写明不手改；改一个表名不重写它，`docs:verify` 失败。
- `scripts/glossary.ts` 和 `vpx scripts/i18n.ts check` 读概念表，原来的检查照过。
- 一个概念的定义只在概念表的一行里，封闭联合的取值只在清单里：`docs/subsystems/` 讲模型和不变量，不重写这两样。

## Risks

- **拼名规则的例外多。** protocol 上没量过拼不出来的名字有多少；服务端内部更多。回退：规则只在 protocol 上拦，别处只出报告；例外超过三成就把拼名规则降成报告，只留概念的双向检查。
- **角色词表变成后门。** 往角色词里加一个词就能让任何名字通过。角色词表的改动和概念一样要用户批，PR 正文点名。
- **带 `id` 认不全概念。** `Changes`、`Question`、`Workplace` 没有 `id`，是从用语表补进初稿的。认定规则漏掉的，概念表里手写一行并注明依据；这类行多了说明规则要改。
- **改名的面。** [精确的概念](#精确的概念)里多数要改存盘的取值。每个概念一个改动，不和检查的落地混在一起。
