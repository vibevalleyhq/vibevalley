# Agent Note: 测试共用一套工具和一个替身

Status: implemented

## Problem

「相等」「匹配」的断言在服务端写了五份（`testkit.Eq` 之外，`protocol` 里还有 `coreEqual`、`rulesEqual` 两份，`memory`、`connector`、`setting` 各一份），因为 `testkit` import 了 `protocol`，`protocol` 自己的测试用不了它。等某事发生的循环写了八份，期限 5、8、10 秒不一；还有十几处用 `time.Sleep` 赌时间，帮工没动静要等足一秒。客户端有三个 `FakeServer`（一个只包了 api，一个靠 `noSuchMethod` 冒充，一个继承 `VibeValleyServer`）、农场的 `fakeApi`、聊天测试自己的 `_Server`，`settle` 三份、`atlas` 七份；测试文件叫 `deska_`、`deskb_`，是一个大测试拆成两半留下的名字。

同一轮查到两处没人直接测的：核心状态的服务（`core`：开机读 `state.json`、丢掉不变的事实、一阵子的变化合成一帧、关机写盘），和生成的 HTTP 路由（`Mount`：数字 id 不是数字回 404、坏 JSON 回 400、错误按类型给状态码）。「不变的事实不发」一半在 `Reduce`、一半在 `core` 的 `SetManager`、`SetCommits` 里先比一遍。

## Decision

- **`internal/testkit` 不 import 农场的包**，和 `golden` 一样，`protocol` 的测试也用它：`Eq`、`Match`（失败时尽量打 JSON）、`Await`（等到条件成立，失败时给出最后看到的值）、`Until`（`Await` 的 bool 版）、`Settle`（查「不该发生」之前给路上的事一点时间）、`Git`、`Repo`。等待用同一个期限。种子里的 lab 档案和 pi 农机在 `internal/testkit/fixture`。各包不再写自己的断言和等待。
- **等会发生的事用 `Await`/`Until`，不用 `Sleep`**；只有查「不该再发生」的用 `Settle`。
- **`Reduce` 自己判断「一样就不算变」**，通话、管家、提交数、进度也一样；`core` 里的预检删掉。
- **`core` 和 `Mount` 有自己的测试**：`internal/core/core_test.go`、`internal/protocol/mount_test.go`（嵌入 `Handlers` 接口的假实现，只写用到的几个方法）。
- **客户端一个 `FakeServer`**：`app/test/support/server.dart`，继承 `VibeValleyServer`，每个请求交给一个处理函数并记下来；按「方法 路径」回答的 `Routes`、`settle`、`atlas`、`jsonResponse` 也只在这里。`support/desk.dart`（工作台的 `DeskBackend`、`pumpPage`）、`farm.dart`、`shell.dart` 建在它上面。测试文件按 `lib` 的层起名：`desk_<页>_test.dart`。

## Alternatives considered

**各包留自己的断言，只统一名字。** 少动文件，但失败信息还是五种样子，`Errorf` 和 `Fatalf` 混着用；改一次要改五处。

**客户端的替身按页面各写各的。** 每页的路由确实不同，所以保留了两种「后端」：`DeskBackend`（工作台的接口，写进去的能读回来）和 `Routes`（一张表）。但它们都只是处理函数，服务端只有一个替身，`VibeValleyServer` 加了方法只有它要跟。

## Consequences

- `protocol` 的规则测试从 `Errorf` 变成 `Fatalf`：第一处不对就停。
- `Settle` 是固定的 200 毫秒：查「没发生」的测试在很慢的机器上可能漏报，不会误报。
- `reduce.jsonl.gz` 重录：48 条重复的管家、通话事实从「变了」改成「没变」，状态一条没变。

## Verification

- `server/internal/core`：`TestStartedAgainFromStateJSON`、`TestApplyStampsAndKeepsNoNewsBack`、`TestStatesGatherABurstIntoOneFrame`（各跑三遍）。
- `server/internal/protocol`：`TestTheSameAgainIsNoNews`、`TestMountKeepsTheContract`。
- 换掉 `Sleep` 的三个 `workspace` 测试连跑五遍。
- `go test ./...`、`bun run flutter:check`。
