# Agent Note: 服务由 fx 组装

Status: implemented

## Problem

服务端的 25 个服务都在 `internal/farm` 一个包里，每个都拿着整个 `*Farm`（`newX(f)`），用到谁就去 `f.X` 找。

- **依赖是隐式的**：一个服务用了哪些别的服务，只能读它的代码才知道。测试里手搭半个 `Farm`，少放一个就空指针。地图页给项目加 `slots` 时就碰上了：`Codebase` 开始用 `Crew`，测试里搭的 `Farm` 没有 Crew。
- **顺序是手排的**：`New` 里按「谁先建好别人才能用」排一遍，`services()` 再抄一遍，开和停都跟着这张表。有些顺序上的要求在表上看不出来，比如 `Tasks.start` 在重启时改计划的状态，要账本先在听，现在只是因为它在表里排得靠后。
- **没有边界**：在同一个包里，一个服务能碰到任何别的服务，连没导出的字段也能碰。

主人要的是：先把整体架构理清楚，再用 fx 组装。

## Decision

行为和约定见 [server/README.md](../../../../server/README.md#服务)「服务」。

- **依赖写在构造函数上**：每个服务的 `newX(…)`，参数就是它用到的服务和配置。用到的多，就用带 `fx.In` 的参数结构体（`crewIn`、`foremanIn`）。用到的服务存在它自己的字段里，没有服务再拿 `*Farm`。`Farm` 只是最上面的门面：HTTP、`cmd/server` 和测试经它拿服务；`services` 嵌在它里面，所以 `f.Chat` 照旧能用。
- **按概念分模块组装**（每个模块一个包，包的 `Module` 是一个 `fx.Module`；`farm.go` 的 `layers` 按顺序列出它们，见 [一个概念一个包](2026-10-16-a-package-per-concept.md)）：
  - base：数据库、`Site`、`Store`、`Settings`；
  - projects：`Projects`、`Codebase`；
  - memory：`Memories`、`ManagerMemory`；
  - runs：`Runtimes`、`Crew`、`Trajectories`、`Tokens`；
  - chat：`Chat`、`FarmTools`；
  - tickets：`Dispatch`、`Merges`、`Issues`、`TaskLog`、`Tasks`、`Schedules`、`Heartbeat`；
  - manager：`Foreman`；
  - channels：`VoiceLine`、`Voice`、`Connectors`、`Lan`；
  - game：`Ledger`、`Commits`。

  HTTP 在最上面。调用只往下走，往回传的是 Hub 上的消息。最初是按「谁调谁」倒推出来的几层，主人看了觉得奇怪：那样分是按代码现状分，不是按产品分，游戏的状态还垫在最底下。后来改成按实际的概念分（[概念先行，农场是皮](../../proposed/architecture/2026-10-15-concepts-first.md)）。为了让项目不往上调执行，每个项目同时能有几个执行（`project.max_workers`）挪到了 `Projects`；游戏模块只听事实；`Crew` 拆出了派活（`Dispatch`）和合并（`Merges`）。
- **生命周期交给 fx**：`base.Run[*X](r, newX)` 把服务的 `OnStart`、`OnStop` 挂成 fx 的钩子。钩子在构造的时候挂上，所以一个服务总在它用到的服务之后开、之前停，不再有手排的表。
  - `OnReady(ctx)` 是 fx 本身没有的一段：开的时候把它记下来，最后一个钩子在全部服务都开了以后，按同样的顺序调。
  - `Start`（`base.App`）把一个能取消的 ctx 交给 fx，后台的活到 `Close` 时跟着停。
  - fx 自己的日志关掉（`fx.NopLogger`），出错走 `New` 的返回值。
- **院门和 API 的环，等全部建好再接**：院门要答 API，API 又要答院门自己的页面。全部服务建好以后、农场开之前，再把 `apiMux` 交给 `Lan`（现在是 `handler.New` 做）。
- **测试的口子**：
  - 单个服务用它的构造函数直接建。
  - 整座农场要换掉其中一样，用 `New(cfg, fx.Replace(…))`。语音的测试就这样换掉读本机环境的 `Settings`。以前它在建好以后改 `f.Settings`，别的服务经 `Farm` 现找，所以拿得到新的；现在各服务在建的时候就拿着自己的，只有在建的时候换，大家才都换到。

## Alternatives considered

**手写组装，不用 fx。** 依赖写进构造函数以后，`New` 里三四十行就能接好，接错了编译器会报。没选它：主人要用 fx，而 fx 给的也确实有用——顺序从依赖图里来，不用维护两张表；测试能在完整的图里换掉任意一样；`fx.Visualize` 能画出依赖图。代价是接错要到运行 `New` 时才报（每个建农场的测试都会先撞上），读代码时也看不到构造函数在哪里被调。

**google/wire。** 在编译期生成接线代码，没有反射；但要多一步生成、多一份生成出来的文件，生命周期还得自己写。只有 25 个服务，不值得。

**先拆包，再组装。** 按层拆成 Go 包，越界和成环就成了编译错误。可是服务之间共用很多包内的小函数，测试都是在同一个包里跑整座农场的，一起拆的话，改动要翻几倍，风险也大。依赖写进构造函数、按层排好以后，拆包就成了机械活，可以一层一层来。后来就这样拆了：[一个概念一个包](2026-10-16-a-package-per-concept.md)。

**把开机时发布的活都挪进 `OnReady`，让开的顺序完全无关紧要。** 按约定，`Tasks.OnStart` 在重启时放弃规划中的计划、暂停在做的计划，这些该放在 `OnReady`。但挪过去以后，它会在 `Crew` 接回帮工之后才跑，行为会变（见 Consequences）。这次只改组装，不改行为。它现在发的事实只有计划状态的变化，账本不记这两种变化，田头和连接器也不听，所以谁先开不影响结果。

## Consequences

- 加一个服务不用再排顺序，但要在它的包的 `Module` 和 `farm.go` 的 `services` 各加一行。漏了 `services`，又没有别的服务用它，它就不会被建，fx 也不报错。
- 依赖成环、缺了谁，`New` 会报错。
- 一个服务拿着的，是建的时候给它的那几个。建好以后改 `Farm` 上的字段，别的服务看不到。
- 重启时，规划中的计划会被放弃，同时本该请走规划的帮工，但请走这一步不生效：`Crew.Dismiss` 只认已经接回来的帮工，而接回帮工在 `OnReady`，比 `Tasks.OnStart` 晚。这在组装以前就是这样，这次没改。
- 服务端多了 fx、dig、zap 几个依赖。

## Verification

- `go vet ./... && go test ./...` 通过；当时 `internal/farm` 跑一遍 21 秒，和以前一样。
- `internal/base/lifecycle_test.go` 和 `internal/workspace/workspace_test.go`：
  - 三个互相依赖的服务，不管在 `fx.Provide` 里怎么排，都按依赖开，全部开了以后按同样的顺序 ready，再倒着停；
  - 真的农场 ready 的顺序是 Commits、Crew、Schedules、Connectors。
- 编出来的服务端在一个新的家目录里跑起来：`/api/health`、`/api/projects`（带 `slots`）、`/api/state` 都正常；收到 SIGTERM 后正常退出，写下 `state.json`。
