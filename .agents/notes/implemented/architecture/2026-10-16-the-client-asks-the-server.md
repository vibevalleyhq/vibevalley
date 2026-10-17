# Agent Note: 客户端问服务端，不重写它的规则

Status: implemented

## Problem

「规则只在 Go」管住了核心状态的折法，却没管住给人看的结论。客户端为了在页面上提前说一句，把服务端的规则逐行移植了一份：农机为什么不能派活（`moneyStop`），档案能不能用（`agentIssues`，连同每台农机的能力表），下回开工会想起哪几条、哪几条快忘了（`recall.dart` 的 `pick`、`nextForgotten`，还有 Go 写样本、Dart 逐条比的对照测试），让帮工解决冲突时交代的那句话（`conflictTask`）。每条规则两份实现、两套测试，改一边另一边不报错。服务端这边，HTTP 处理也越了界：看过改动、和语音管家说上话要不要记账，由 handler 在答完接口后顺手调游戏决定；给某一步的评论在 handler 里拼。

## Decision

- **服务端算好，客户端读**：
  - `RuntimeInfo.stop`：`MoneyStop` 的那句话，服务端在每次给出农机信息时填（花费变了重算）。
  - `POST /api/agents/check`：给一组档案（没存的草稿也行），回每个的 `AgentIssue`；档案页、编辑页、派活的下拉框都用它（`data/remote.dart` 的 `watchAgentIssues`）。
  - `GET /api/agents/{id}/recall?project=&text=`：`Pick` 挑出的几行和字数，不计成想起过；`Memory.fading` 标出再记十条就会丢的。
  - `POST /api/projects/check`：新增项目时会拒绝的第一处（`projectProblem`），新增项目的对话框提交前问它；Dart 里的项目名正则和那句话删了。
  - `POST /api/settings/check`：保存时会拒绝的第一处（`SettingsProblem`、`VoiceProblem`），语音页边改边问。语音设置发整份，`setting.Save` 用 `VoiceOverrides` 自己留下和默认不一样的；客户端不再知道「默认值」怎么比。
  - `POST /api/workers/{id}/resolve`：服务端看这个帮工的冲突（核心状态里标的，没有就现查），用 `ConflictTask` 以主人的名义告诉它。
  - 跟着状态走的话在出帧时由 `protocol.FrameOf` 填进状态的副本（起初写在 `Reduce` 里，会进 `state.json`，后来挪了，见[收敛接缝](2026-10-17-converge-the-seams.md)）：帮工在干什么（`Worker.phaseText`，没动静多久写成 `{span}`，客户端按自己的钟填，和收件箱的 `{ago}` 一样）、定时什么时候跑、下次几点（`Schedule.whenText`、`nextText`，按定时自己的时区说）、连胜倍率（`Progress.multiplier`）。
  - 额度：`RuntimeInfo.quota` 带剩几成和那句话（`runtime/quota.go`），管家和额度条都读它。
  - 成就表、每档的金币在 `seeds.json`，经生成到 `lib/gen` 的 `achievements`；Dart 不再手抄一份成就表和金币。
  - 每种动作怎么说（跑命令、读文件……）在 `seeds.json` 的 `actionText`，Go 的 `ActionText` 和 Dart 生成的 `actionText` 读同一份；原来 Dart 的 `actionMeaning` 抄了一份，已经和 Go 差了两个词。
  - 计划：`PlaybooksOf` 给计划填 `layers`、`asksForYou`、`spent`、`settled`，给每一步填 `blockedBy`；`playbook.Events` 给每条动态填 `text`（步骤用现在的标题）。
- **Go 里不留「为了对照」的规则**：只给页面读帧用的小函数（哪些频道、某个帮工的工单串、未读几条、某档成就叫什么、离下一档还差多少、庄稼熟没熟、能不能收），开着的服务端不调，只在 Go 里录黄金数据，Dart 另有一份。这种删掉 Go 的，留在客户端：它们是读帧，不是折事实。判断用 `go run golang.org/x/tools/cmd/deadcode@latest ./...`：protocol 里导出却从 `main` 走不到的，要么让服务端用上（填进形状），要么删。
- **客户端里一份数据一个来源**：档案和农机只从 `deskConfigProvider` 读（服务端推的 `SideEventRuntime` 让农机保持最新），`agentsProvider`、`runtimesProvider` 是从它派生的；看板不再自己读档案，农场不再每分钟轮询农机。工地事件只有 `sideEventsProvider` 一条。
- **两边都要的值由生成带过去**：`//vibevalley:const` 和 `seeds.json` 的客户端部分（[Go 拥有形状](2026-10-15-go-owns-the-shapes.md)）。这一篇管的是规则，那一篇管的是值。
- **处理函数只转发**：`worker.Comment` 拼评论，`game.ChooseTitle` 定称号的账，`core.Open` 是「主人一开口农场就开张」；数字 id 的路径参数在 `api.go` 里写 `int64`，生成的 `Mount` 统一解析（不是数字就 404）；主人做的、不改状态的事由经手的服务说给 `core.Did`（`OwnerReviewed`、`OwnerTalked`），游戏订阅 `core.OwnerDids` 记账。不用事实：`Core.Apply` 不发不改状态的事实，事实就是状态的变化。不让游戏 import `issue`、`voice`：游戏要先于帮工准备好（帮工读它的提交数），依赖它们就排到后面去了。
- **顺手修的**：主人给没有工单串的帮工带话，`TellWorker` 报错、handler 吞掉了，话没到；现在没有串就直接交给帮工，handler 也把错误交回去。

## Alternatives considered

**保留 Dart 的移植，用黄金数据守着两边一致。** `recall` 就是这么做的。守得住，但每条规则都要 Go 写样本、Dart 读样本，改规则要改两份再重写样本；页面要的只是结论。

**把这些结论都放进核心状态。** 帧里就有，不用另外问。没选：档案的问题依赖草稿、记性的预览依赖主人正在打的字，都不是农场的状态；农机的 `stop` 跟着农机信息走，已经在 `RuntimeInfo` 里。

**游戏记账用事实（`FactReviewed`）。** 和别的账一样从事实来。没选：这些事不改状态，`Apply` 不会发，硬塞会让「事实就是状态的变化」不再成立。

## Consequences

- 页面上的这几句要等服务端回答，第一次打开时晚一下才出现；本机的服务端很快，可以接受。
- 测试替身要回答这几个接口（`test/support/desk.dart` 只回最简单的那一条，其余规则在 Go 测）。
- 少了 `recall.dart`、`recall_parity_test.dart`、`recall.sample.json` 和它的生成，以及 Dart 里 `moneyStop`、`agentIssues`、`conflictTask`、`voiceProblem`、`settingsProblem`、`voiceOverrides`、`keyHint`、`actionText`、`quotaText`、`quotaLeft`、`streakMultiplier`、`xpToNext`、手抄的成就表、`whenText`、`nextRun`、`nextText`、按正则认 @ 的 `mentionsIn`、`addressOf`、`layersOf`、`blockedBy`、`asksForYou`、`playbookSpent`、`isSettled`、`playbookEventText`、`Need` 和 `needOf` 和它们的测试；Go 里少了 `ChannelsOf`、`JobThreadOf`、`ThreadUnder`、`UnreadIn`、`TierTitle`、`Standing`、`IsRipe`、`CanMerge`、`EmptyChat`、`RuntimePresets`、`CanSteer`、`base.Placeholders`。
- 计划的 id 不再照 JavaScript 的 `Number` 读（`p0x10`、`p1.5` 以前算数），只认 `p` 加整数；庄稼选麦子还是胡萝卜改用 FNV 哈希，不再模仿 JavaScript 的 UTF-16。黄金数据重录：只有 `nextId` 和地块的 `crop` 变了。
- 定时的「下次几点」以前按这台机器的时区算，现在按定时自己的时区（Go 有时区库，Dart 没有）。

## Verification

- `server/internal/memory`：`TestPreviewPicksWithoutCountingAndTheLongestUnusedFade`。
- `server/internal/game`：`TestTheOwnersReviewAndCallAreCounted`。
- `server/internal/protocol`：`TestReduceKeepsSchedules` 查定时的两句话只在帧里；`TestTheFrameSaysTheWordsOnACopy`；`reduce.jsonl.gz`、`play.jsonl.gz` 重录后只多了 `phaseText`、`whenText`、`nextText`、`multiplier`。
- `server/internal/runtime`：`TestQuotaWords`。
- `server/internal/protocol`：`TestPlaybookAsIssues` 查读回来的计划带上分层和在等谁；`server/internal/issue` 的 `TestNextPlaybookID`。
- `server/internal/playbook`：动态的 `text` 用步骤的标题。
- `server/internal/workspace`：`TestConflictingBranchStaysUntilResolved` 用 `Issue.Resolve` 交代冲突，没有冲突的帮工被拒绝。
- `bun run flutter:check`：档案页、编辑页、派活、记性面板、两处冲突按钮的测试改成读服务端的回答。
