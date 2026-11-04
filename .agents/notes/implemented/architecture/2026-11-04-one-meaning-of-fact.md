# Agent Note: 「事实」只有一个意思，每种事实说出发生了什么

Status: implemented

## Problem

代码里叫 fact 的东西说的是至少五件不相干的事，最核心的那个自己也说不清：

| 名字 | 它其实是什么 |
|---|---|
| `T.Fact`、`FactIn`、`core.apply(...facts)`、`Transition.fact`、`core.facts` | 改核心状态的一件事（用语表里「事实」的意思） |
| `session/facts.ts` 的 `eventFacts`、`FactContext` | 把 oar 的一个会话事件读成核心的改动、轨迹的一步、花费和告警（一个 `Reaction`）；事实只是它产出的四样之一 |
| `RuntimeFacts`、`RuntimeInfo.facts`、`presets.json` 的 `runtimeFacts`、`factsOf` | 一种农机支持什么：steer、拒收哪些参数、能力、是不是进程内 |
| `ChannelRouteFact` | 路由一条频道消息的输入，和 `ChannelRouteResult` 成对 |
| 页面的 `RowFacts`、`rowFacts` | 看板一行排序和分组用的键 |

`SideEvent` 也在这一窝：它是 `/api/v1/events` 流的一项（事实，加上快照、轨迹的一步、提醒、农机），不是什么「旁路」的事件。

`T.Fact` 的十五种成员名字是名词（`issue`、`session`、`channel`、`message`、`connector`……），读不出发生了什么。按语义它们其实是三种：

- **一个东西现在是这样**（新出现或改了，载荷是它的整份）：`issue`、`session`、`channel`、`cron`、`connector`、`ownerMentions`、`message`、`gameProgress`，以及只改一个字段的 `sessionPhase`、`voiceCall`。
- **一个东西从核心状态里拿掉**：`issueGone`、`channelGone`、`cronGone`。
- **一件带着结果的事**：`sessionReport`（一轮的汇报：结果、问题、检查）、`sessionGone`（帮工离开，带着怎么走的、合了几个）。

所以订阅事实的人（游戏账本的 `entriesFor`、信箱的 `onFact`）要拿前后两份状态比才知道发生了什么，读代码的人也一样。

## Decision

「事实」保留，只留一个意思：改核心状态的一件事，用语表那一行不变。别的地方不叫 fact；每种事实的名字用过去时说出它是哪一种。

### 1. 事实的成员

规则：整份换成新样子的叫 `<东西>Changed`，从核心状态拿掉的叫 `<东西>Removed`，带结果的事用它自己的动词。

| 原来的 `type` | 现在 | 接口 |
|---|---|---|
| `issue` | `issueChanged` | `FactIssueChanged` |
| `issueGone` | `issueRemoved` | `FactIssueRemoved` |
| `session` | `sessionChanged` | `FactSessionChanged` |
| `sessionPhase` | `sessionPhaseChanged` | `FactSessionPhaseChanged` |
| `sessionReport` | `sessionReported` | `FactSessionReported` |
| `sessionGone` | `sessionLeft` | `FactSessionLeft` |
| `message` | `messageChanged` | `FactMessageChanged` |
| `channel` | `channelChanged` | `FactChannelChanged` |
| `channelGone` | `channelRemoved` | `FactChannelRemoved` |
| `ownerMentions` | `ownerMentionsChanged` | `FactOwnerMentionsChanged` |
| `cron` | `cronChanged` | `FactCronChanged` |
| `cronGone` | `cronRemoved` | `FactCronRemoved` |
| `connector` | `connectorChanged` | `FactConnectorChanged` |
| `gameProgress` | `progressChanged` | `FactProgressChanged` |
| `voiceCall` | `callChanged` | `FactCallChanged` |

`message` 不叫 `messagePosted`：改字、删掉、加表情也发它，载荷是消息现在的样子。`issueGone` 不叫 `issueDeleted`：主人删掉和派活失败撤回都发它，意思是「核心状态里不再有它」。

### 2. 同名不同物的，换成它们自己的名字

| 原来 | 现在 |
|---|---|
| `session/facts.ts`、`eventFacts`、`FactContext` | `session/reaction.ts`、`reactionTo`、`ReactionContext`（它返回的本来就叫 `Reaction`） |
| `RuntimeFacts`、`RuntimeInfo.facts`、`runtimeFacts`、`factsOf`、`unknownFacts` | `RuntimeSupport`、`RuntimeInfo.support`、`runtimeSupport`、`supportOf`、`noSupport` |
| `ChannelRouteFact` | `ChannelRouteInput` |
| `RowFacts`、`rowFacts` | `RowKeys`、`rowKeys` |
| `SideEvent`、`SideEventSnapshot`、`SideEventSessionEvent`、`SideEventNotice`、`SideEventRuntime` | `ServerEvent`、`ServerEventSnapshot`、`ServerEventStep`、`ServerEventNotice`、`ServerEventRuntime` |

### 3. 检查

`scripts/stale-names.ts` 认得旧名字（`RuntimeFacts`、`ChannelRouteFact`、`RowFacts`、`SideEvent`、`eventFacts`、旧的 `Fact*` 接口名和几个不会和别处重名的旧 `type`），写回旧名字时报出来、说换成什么；`message`、`session` 这类会和别处重名的旧 `type` 由 `Fact` 的类型拦。

### 4. 数据和文档

- 线上形状变了：`/api/v1/events` 的事实和 `RuntimeInfo.support`，不留兼容（AGENTS.md「内部不留兼容」），命令行、页面和服务端一起换。
- 黄金数据里录下的事实（`core/testdata/reduce.jsonl.gz`、`game/testdata/rules.jsonl.gz`）只在 `fact`、`facts` 两个键下改了 `type`；按上表把旧数据换过名字，和新数据逐行相等，答复不用重写。
- 文档里「事实」的用法不变，写着旧成员名和已经删掉的事实（`FactConflict`、「`run` 到 `report` 两个事实」）的改成了现在的。

## Alternatives considered

- **总名改成 `Change`（变化）。** 英文的 change 已经是「改动」：工单的改动、`issue.diff.get`、`ArtifactChange`；中文文档里「事实」有一百多处、用语表里有定义。问题不在总名，在成员的名字和别的东西借用了它。
- **按语义拆成两个类型（实体的新样子、发生的事），实体走通用的 `saved`/`removed`。** 方向对，但它是[提交即事实](.agents/notes/proposed/architecture/2026-10-22-commit-then-effects.md)和[实体增量](.agents/notes/proposed/architecture/2026-10-27-presence-and-entity-deltas.md)那一步的事：到那时 `xxxChanged`、`xxxRemoved` 变成表里的行和给页面的增量，`sessionReported`、`sessionLeft` 这类才进只追加的事件日志。这次的名字到那时仍然成立，不用再改一遍。
- **只改同名不同物的几处。** 读的人仍然看不出 `issue`、`session` 这类事实是什么意思。

## Consequences

- 读一条事实就知道是哪一种：东西的新样子（`Changed`）、拿掉（`Removed`）、带结果的事（`sessionReported`、`sessionLeft`）。订阅的人仍要比前后两份状态才知道「完成了」这类更细的事：那要等事实分成实体的增量和只追加的事件日志（见上）。
- `fact` 只在核心状态里出现；农机支持什么、路由的输入、看板的排序键、事件流的一项各有自己的名字，`stale-names` 拦回退。
- 代价：事件流的形状变了，录下的黄金数据换了一遍名字；十五个 `type` 都比原来长。

## Verification

- `vp run server:check`、`vp run web:check`、`vp run docs:verify` 通过；`vpx scripts/stale-names.ts` 拦旧名字。
- 黄金数据：旧数据换过名字和新数据逐行相等，`core/golden.test.ts`、`game` 的测试不改答复就通过。
