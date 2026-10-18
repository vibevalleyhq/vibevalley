# Agent Note: 规则跟着它的主人，黄金数据跟着规则

Status: implemented

## Problem

`protocol` 有九千多行、四百多个导出的名字：线上的形状、核心状态的折法，和每个概念自己的纯规则（连接器把 markdown 变成纯文字、设置怎么检查、记性怎么挑、钱用完了怎么说……）都在里面。它是按「层」切的：改连接器的规则要进 `protocol`，读连接器的代码要跳去 `protocol`，`protocol` 的导出越来越多，没有哪个名字说得清是谁的。规则留在 `protocol` 原来有两个理由：TypeScript 和 Dart 要对照同一份黄金数据（[Go 拥有形状](2026-10-15-go-owns-the-shapes.md)），和读写黄金数据的工具只是 `protocol` 包内的测试代码。第一个已经没了：规则只在 Go，客户端问服务端（[客户端问服务端](2026-10-16-the-client-asks-the-server.md)）。第二个是工具的问题。

## Decision

- **规则在主人那里**：核心状态的折法（`Reduce`），和它用到的、或者几个包都用的规则（田头怎么投递、帮工的阶段、计划、游戏的画面、JavaScript 的字符串规则、`Yuan`、`ConflictTask`）留在 `protocol`。只有一个包用的，挪进那个包、不导出（每个包只导出一个服务）：
  - `connector/text.go`：纯文字、拆长消息、合并晚到的、配对码、短 id、给主人看的一行；
  - `setting/rules.go`、`voice_rules.go`：设置和语音的检查、和默认值比出覆盖（`DefaultVoice` 和形状留在 `protocol`，语音服务和测试也读）；
  - `memory/recall.go`：怎么挑、怎么写成一行、快忘了的；`memory.Recall` 交给帮工的是写好的行和它们的 id，帮工只加开头那句；
  - `runtime/rules.go`：农机能不能派、档案有什么问题；管家、计划、派活都问 `runtime.Check`；
  - `manager/words.go`：管家怎么说花费；
  - 后来又挪了一批（见[收敛接缝](2026-10-17-converge-the-seams.md)阶段 3）：`channel/rules.go`（给谁、叫不叫醒，读 @ 和地址，叫醒时怎么说）、`game/progress.go`（账本怎么折）、`task/rules.go`（读规划的回答、改步骤、步骤的工单、能开工的）、`issue/rules.go`（工单和活的文字互转、关没关、下一张计划的 id）、`schedule/rules.go`（到没到点、错没错过）、`manager/patrol_rules.go`（巡查的宽限和记性，读 protocol 的 `InboxEntries`）、`runtime/quota.go`（额度怎么说）。
  - 留在 protocol 的单一用户函数，各有理由：核心状态的初值和折法要用的（`EmptyCoreState`、`EmptyProgress`、`WithStations`、`EffectsOf`）、种子和默认值（`FactsOf`、`DefaultVoice`）、读 `Phase` 的（`DoingOf`）、和 `NextRun` 共用时区解析的 `ScheduleProblem`、和 `TasksOf` 互为反向的 `TaskIssues`。
- **黄金数据跟着规则**：读写 `testdata/*.jsonl.gz` 的工具是 `internal/golden`（不依赖任何业务包，`protocol` 自己的测试也能用）。每个包的 `TestRulesGolden` 用 `golden.Rules` 跑自己的用例。重写全部：`VIBEVALLEY_GOLDEN=update go test ./internal/...`；用环境变量，不用 `-update`，因为 `go test ./...` 会把旗子发给每个测试二进制，没注册它的包会报错。
- **顺手清掉的**：`base.InboxLines`（田头的规矩放在地基里）挪到 `protocol` 的田头规则；`voice.go` 里没人用的语音选项列表和 `Needs*Key`，没人用的 `ConnectorLabel`；`helpers.go` 剩下的是字符串和数字的规则，改名 `text.go`。

## Alternatives considered

**把 `protocol` 拆成形状和规则两个包。** 名字更清楚，但规则还是按层堆在一起，问题只是从一个包挪到另一个包。

**规则挪走，导出给别的包用。** 一条规则几个包都用，比如 `AgentIssues`，就成了 `runtime` 导出的第二个东西，违反一个包一个服务。让别人问服务（`runtime.Check`）把规则藏在服务后面，深一层。

**黄金数据留在 `protocol` 一份，各包去读里面自己那部分。** 不用拆文件。没选：`-update` 时谁来写这份共享的文件说不清；跟着包走，删一条规则就删它的用例。

## Consequences

- `protocol` 少了两千来行规则和一万多条用例；它剩下的都和折法有关，或者确实几个包在用。
- 一条规则以后要被第二个包用，有两条路：问它的服务，或者挪回 `protocol`。这要当时判断。
- 巡查、工单状态、游戏的进度还在 `protocol`：折法或来电直接用到它们。

## Verification

- `go test ./...` 通过；各包的 `TestRulesGolden`：`connector` 4400 条、`setting` 3200 条、`runtime` 1700 条、`manager` 800 条、`memory` 250 条，`protocol` 剩 8100 条。
- `VIBEVALLEY_GOLDEN=update go test ./internal/...` 以后再跑一遍，全部通过。
