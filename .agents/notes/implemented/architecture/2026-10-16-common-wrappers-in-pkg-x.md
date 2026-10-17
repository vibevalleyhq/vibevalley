# Agent Note: 通用的小封装收进 pkg/x

Status: implemented

## Problem

字符串、数字、指针、时间这类小封装，各包都自己写了一份。客户端按 UTF-16 数字、按 JavaScript 的 `\s` 认空白，服务端要算得和它一样，可这套算法有好几份：

- `protocol/text.go` 一份；
- `channel` 一份（`chatIsSpace`、`chatTrim`、`chatUnits`、`chatClip`，正则里还把空白字符类手写了三遍）；
- `base` 的 `ClipLine`（用的是 Go 的空白，和别处不一样）、`Head`；
- `worker` 的 `Cut`、`clip`；
- `protocol` 的 `Clip`、`playbookSlice`；
- `manager` 的 `managerUnits`。

照 JavaScript 写数字的有 `protocol` 的 `NumberText`、`ToFixed`，计划和定时里另有一份简写的 `playbookNumberText`。可选字段要的指针，有 `testkit.Ptr`、`voicePtr`、`lanPtr`、`corePtr`、`rulesPtr`，解引用的 `str()` 写了三遍。`base.NowMs`、`base.Sleep` 和农场无关，却放在地基里。

## Decision

- **`server/pkg/x` 下一类一个包**，都不依赖农场的任何包：
  - `str`：`SpaceClass`、`Spaces`、`IsSpace`、`Trim`/`TrimStart`/`TrimEnd`、`Units`、`Slice`、`Head`（不截半个字）、`Cut`（截断加「…」）、`Clip`（压成一行再截断）、`Lower`；
  - `num`：`Text`（`String(n)`）、`Fixed`（`toFixed`）、`Round`（`Math.round`）；
  - `ptr`：`To`、`Or`、`Value`；
  - `clock`：`NowMs`、`Sleep`。
- **别处的副本都删掉**，调用方改用它们。`base.ClipLine` 并进 `str.Clip`：空白统一按 JavaScript 的算，也就是客户端的算法。`playbookNumberText` 换成 `num.Text`。
- **农场的说法留在农场**：`Yuan`（钱怎么说）留在 `protocol`；`DayMs` 是要生成到 Dart 的共用常量，留在 `shapes.go`。

## Alternatives considered

**全放进 `base`。** `base` 是农场的地基（数据库、`Hub`、配置、生命周期）；字符串和数字的算法谁都能用，放在 `pkg/` 才能单独拿走，也让 `protocol` 不用为几个字符串函数去依赖别的业务包。

**一个 `pkg/x` 包装下全部。** 少几个 import。没选：一个包里什么都有，就回到了大杂烩；分包后，名字本身就说明了是哪一类（`str.Units`、`num.Fixed`、`ptr.To`）。

## Consequences

- 改一处算法（比如 JavaScript 的空白再多一个字符），只改 `pkg/x/str`，黄金数据替它把关。
- `base.ClipLine` 以前按 Go 的空白压行（会把 U+0085 当空白、不认 U+FEFF），现在和别处一样按 JavaScript 的；这条路径只用在给人看的一行摘要上。
- 新写的包遇到这类需求，先看 `pkg/x`；真缺一样，加进对应的包，不在自己包里另起一份。

## Verification

- `pkg/x/str`、`pkg/x/num` 有自己的测试（emoji 的 UTF-16 长度、截到半个字、JavaScript 的空白、`toFixed` 的进位）。
- `go test ./...`、黄金数据（`protocol`、`connector`、`setting`、`memory`、`runtime`、`manager`）全部通过：几份副本换成同一份以后，记下的结果一条没变。
