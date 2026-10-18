# Agent Note: 服务端的游戏收在一处

Status: implemented

## Problem

[按业务分深模块](.agents/notes/implemented/architecture/2026-10-16-deep-modules-singular-names.md)以后，业务包里已经没有游戏规则，但服务端的游戏还散在几处：

- **服务**：账本、金币、成就和等级在 `ledger`。这个名字只说了账本，但它其实是全部游戏的服务。
- **核心状态里夹着游戏的决定**：主人点了一块空地再说话，`site.WantBed` 记下这块地。之后 10 秒内雇的帮工，`Site.Apply` 会在折之前改写 `FactHired.Station`。核心状态的入口替游戏做了决定，雇帮工的事实也带着一个游戏的偏好。
- **规则**：金币、成就、等级在 `protocol/progress.go`，地里长什么、特效在 `view.go`。帮工在哪块地、做过什么（`HelperPlay`）和 `Reduce` 混在 `farm.go`。从文件名看不出哪些是游戏。

## Decision

- **服务在 `game` 包**：`ledger` 改名 `game`，装 `Ledger`、`Commits` 和 `Beds`。业务包不 import `game`；HTTP 那一层只为游戏自己的接口（挑称号、搬金币、点空地）调它。主人做的、不改状态的事（看了改动、和语音管家说上话）由经手的服务说给 `core.Did`，游戏订阅 `core.OwnerDids` 记账，不管从哪个入口来（[客户端问服务端](.agents/notes/implemented/architecture/2026-10-16-the-client-asks-the-server.md)）。
- **核心状态不替游戏做决定**：`Site` 没有 `WantBed`，`FactHired` 没有 `Station`。主人点的空地由 `Beds` 记下；它听到 `FactHired`，再施加 `FactStation` 把帮工挪过去。`FactStation` 的规则在 protocol：那块地空着就挪，不空、不在地里、已经在那块地都不变。
- **规则留在 protocol，文件名带 `game_`**（后来账本的折法只剩 `game` 一个读者，挪进了 `game/progress.go`，见[收敛接缝](.agents/notes/implemented/architecture/2026-10-17-converge-the-seams.md)）：`game_progress.go`（金币、成就、等级、要记的账）、`game_view.go`（地里长什么、特效）、`game_play.go`（`HelperPlay`：地块、动作历史、工具次数）。`Reduce` 的 `switch` 还在 `farm.go`，游戏的分支只调 `game_play.go` 的函数。
- **特效留在 `Site`**：`Site.Apply` 用纯函数 `EffectsOf(before, fact)` 算特效，和帧一起发。
- **核心状态里的游戏字段不动**：`CoreState.Progress`、`Commits` 和 `Helper.Play` 照旧在帧里，客户端读一帧就够。

行为见 [server.md](docs/reference/server.md)「游戏」，包见 [server/README.md](server/README.md#服务)「服务」。

## Alternatives considered

**特效也搬进 `game`。** `EffectsOf` 要用折之前的状态。`game` 要么自己存一份状态，违反[核心状态只有一份](.agents/notes/implemented/architecture/2026-10-11-farm-core-state.md)，要么在 `Site` 发出事件以后才算，特效会晚一帧到。没选：`Site` 只是跑一个纯函数，不做游戏的决定。

**规则拆成 `protocol/game` 子包。** 边界最清楚。没选：shapegen、黄金数据和 Flutter 的生成都按 `protocol` 一个包来；游戏的形状和事实、帧在同一个联合里，拆开要倒转依赖。

**保留 `FactHired.Station`，由派活的路径带着地块。** 地块是主人点的，要经过管家（LLM）才雇到帮工，中间隔着一句话和 10 秒。把它一路传过管家和派活，业务就认识了游戏。

**留叫 `ledger`。** 没选：这个包不只记账了，`game` 也是用户和概念里的词。

## Consequences

- 帮工先站到第一块空着的地，再挪到主人点的那块。两个事实隔不到 200 毫秒，通常在同一帧里；分在两帧时，客户端会看到它挪一下。
- 以前 `FactHired.Station` 对已经在地里的帮工不起作用。`FactStation` 会挪它，但服务端每次雇的都是新 id（`w<n>`），`Beds` 只在 `FactHired` 之后施加，所以行为不变。
- 黄金数据 `reduce.jsonl.gz` 里带 `station` 的 154 个 `hired`：69 个是新帮工，拆成 `hired` 加 `station`；85 个是已经在地里的帮工，去掉 `station`（原来就不起作用）。重写以后，原有每一行的状态、画面、来电和特效都和以前一样。
- `Fact` 和 `SideEvent` 多了 `station`，Dart 由 shapegen 生成，客户端没有用到 `FactHired.station`。

## Verification

- `go vet ./...` 通过；`go test ./internal/... ./cmd/...` 全部通过，测试函数 247 个（多了两个）。
- `protocol/game_play_rules_test.go` 的 `TestStationOnlyToAFreeBed`：挪到空地；已经在那块地、地被占了、超出地数、`-1`、不在地里的帮工都不变。
- `game/beds_test.go` 的 `TestBedsTheNextHelperTakesThePlantedBed`：点了地以后雇的帮工站到那块地；没点时站到第一块空地；点的地被占了就不挪；点一次只用一次。
- `go run ./tool/shapegen -check`、`bun run flutter:check` 通过。
