# Agent Note: 一个包一个 Service

Status: implemented

## Problem

[按业务分深模块](2026-10-16-deep-modules-singular-names.md)以后，一个包是一块业务，但一个包对外还露着好几个服务：`issue` 有 `Issues`、`Dispatch`、`Merges`，`game` 有 `Ledger`、`Commits`、`Beds`，`memory` 有 `Memories`、`ManagerMemory`。服务名多数是复数（`Projects`、`Runtimes`、`Connectors`），也有别的叫法（`Store`、`Foreman`、`Lan`）。调用处读起来是 `f.Dispatch.Hire`、`f.Merges.Harvest`，看不出它们都是工单的事；模块的边界在包上，对外的入口却是好几个类型。

## Decision

- **一个包只导出一个服务，类型叫 `Service`**：`project.Service`、`issue.Service`、`game.Service`……每个包都一样。不用概念名，因为 `project.Project` 已经是「一个项目」那个值，`run.Run` 要留给一次干活的记录。
- **用的地方叫它的概念名，单数**：`Farm` 和测试的服务表里是 `Project`、`Issue`、`Game`……，调用处读起来是 `f.Project.List()`、`f.Issue.Merge(…)`；构造函数和 `fx.In` 结构体里，一个包的 `Service` 只出现一次（fx 不让同一个类型出现两次）。
- **一个包里原来的几个服务，是不导出的零件**：`Service` 嵌入它们，它们导出的方法就是 `Service` 的方法。`Module` 把零件的构造函数设成 `fx.Private`，只把 `Service` 交给 fx；`base.Parts` 按 `newService` 里的顺序开、ready，倒着停。零件之间撞名的改了名：`memory` 管家的那一半是 `Manager`、`WriteManager`、`ForgetManager`，巡查的时钟是 `PatrolNow`（巡查后来挪进了 `manager`）。
- **服务是一个值，不是包级函数**：`project.List()` 这样的包级函数背后要有全局状态；服务由 fx 按依赖建出来，测试里每个测试建自己的一座农场。
- **`/mcp` 是单独的包 `mcp`**：给编码 agent（Claude Code、codex 加上技能，别的 agent）用的入口，和 HTTP 一样在最上面，只转给拥有它的服务。原来它是 `channel` 里的 `FarmTools`；以后的工具会用到频道以外的业务。

包的清单和每个包管什么见 [server/README.md](../../../../server/README.md#服务)「服务」。

## Alternatives considered

**类型用概念名：`project.Project`、`issue.Issue`。** 读起来最像概念。没选：这些名字已经或者要给那个概念的值（一个项目、一次 run），服务和值撞名。

**包级函数 `project.List()`。** 调用处最短。没选：要全局状态，fx 的依赖和每个测试一座农场都没了。

**类型加前缀：`VvRuntime`、`VvCrew`。** 没选：整个模块都是 VibeValley 的，前缀只说明「不是 oar 的」，import 的限定符已经说了。

**只改名，不并：`issue.Issues`、`issue.Dispatch` 留着，各叫各的。** 改得少。没选：对外还是几个入口，调用的人要知道一块业务里面怎么分的；一块业务一个入口才是深模块。

**并成一个大结构体，不嵌入。** 没选：几个零件各有自己的锁和后台的活，拆开写更好读；嵌入让方法直接成为 `Service` 的，不用一个个转发。

**`/mcp` 留在 `channel`。** 现在的四个工具都是频道的。没选：MCP 是外面的 agent 进来的入口，以后要有工单、记性、小队的工具，放在哪块业务里都不对。

## Consequences

- 单纯的改名用 gopls（`gopls rename`，按类型找引用）做，并包靠嵌入手写；以后改服务名也照这样，不用正则。
- 零件导出的方法撞名时，Go 不在定义处报错，用到时才报「ambiguous selector」。加零件之前先看包里已有的方法名。
- ready 的顺序按包认：`farm` 的测试里是 `game`、`run`、`schedule`、`connector`。`Farm` 的服务表里 `Game` 排在 `Run` 前面，让等级先数出来。
- 手动开服务的测试（`workspace/work_test.go`）按包开，一个 `Service` 只开一次，否则它的零件会开两遍。
- `mcp` 的测试在它自己的包里，带排在下面的包和一个扮演帮工、记下令牌的 pi。
- [Run、Session、Crew 的提案](../../../../docs/subsystems/session.md)里的服务也照这个约定。

## Verification

- `server/internal` 下每个服务包只导出一个服务类型 `Service`；`go vet ./...` 通过；`go test ./internal/... ./cmd/...` 全部通过，测试函数 247 个，和改之前一样（`TestFarmToolsOverMcp` 挪成 `mcp` 的 `TestToolsOverMcp`）。
- `farm` 的 `TestFarmReadiesInTheOrderItsServicesStarted`：ready 的顺序还是等级、执行、定时、连接器。
- 行为、HTTP 接口、存盘格式没变。
