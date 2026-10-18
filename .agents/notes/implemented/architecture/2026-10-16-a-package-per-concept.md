# Agent Note: 一个概念一个包

Status: implemented

## Problem

服务端的服务已经按概念分了模块（[服务由 fx 组装](.agents/notes/implemented/architecture/2026-10-15-services-assembled-by-fx.md)），可它们还都在 `internal/farm` 一个包里，两万五千行。分层只是约定：一个服务碰得到任何别的服务，连没导出的字段也碰得到，往上调了编译器不说话，只能靠读代码发现。文件名前缀（`crew_`、`task_`、`foreman_`、`voice_`）在替包做事，而且已经和模块对不上：`task_ledger.go` 是游戏，`foreman_memory.go` 是记性，`voice_settings.go` 是大家都用的设置。

## Decision

行为和约定见 [server/README.md](server/README.md#服务)「服务」。

包名、`base` 的拆分和形状放在哪，后来按 [按业务分深模块，包名用单数](.agents/notes/implemented/architecture/2026-10-16-deep-modules-singular-names.md) 改了。

- **一个模块一个包**，都在 `server/internal/` 下：`base`、`projects`、`memory`、`runs`、`chat`、`tickets`、`manager`、`channels`、`game`，`farm` 在最上面。一个包只 import 排在它前面的包，分层从约定变成编译错误。原来的 agents 模块改叫 `memory`：smith 有个 `agents` 包，`runs` 两个都要用，而且这个包里只有记性。
- **`base` 放大家共用的**：数据库、`Site`、`Store`、`Settings`、`Hub`、`Config`、服务之间传的形状（`types.go`），按 JavaScript 算长度的文本函数，和生命周期（`App`、`Run`）。原来散在各处、被下层借用的小函数（配对码、可取消的睡眠、读数字环境变量、截断）也挪到这里，不让下层 import 上层。
- **HTTP 处理单独一个包 `internal/handler`**，在 `farm` 上面：`VibeValleyApi` 的实现、工地事件流和状态流、`/mcp`。`farm` 只组装服务，不认识 HTTP。院门要答 API，所以 `handler.New(f)` 在农场开之前把 `apiMux` 交给 `Lan.API`；`cmd/server` 和院门的测试都先调它。`/mcp` 的处理还是 `FarmTools` 建的，语音线路和院门是各自服务里单开的监听，不搬。
- **声网的逻辑在 `pkg/agora`**：签令牌、用 agentkit 拼 agent（听法、字幕走哪条路、会说话的大模型）、「已经在走」算停成功。它不 import `internal/`，用哪几家服务、人设是什么由调用的人给；`voice/agora.go` 只把农场的语音设置（protocol 的联合、缺 key 时的中文提示、语音线路）换成它要的。凭据的类型是 `agora.Credentials`，`Settings` 也用它。
- **微信、飞书、QQ 的接口也在 `pkg`**（`pkg/weixin`、`pkg/feishu`、`pkg/qq`）：每家的消息形状、`API` 接口和真的 `Client`（登录、收、发、从消息里读出字），连同对着本地假服务器的测试。`channels` 留下桥（账号、只认主人、配对、发件表、补发）和三个适配器，适配器把三家的接口接到桥上。
- **每个包有自己的 `Module`**（`func(*base.Readies) fx.Option`），`base.App` 把 `base` 和给它的包装在一个生命周期上；`farm.New` 是带全部包的 App，加上 HTTP 和院门的 API。生命周期的方法跨了包，所以导出：`OnStart`、`OnStop`、`OnReady`。构造函数只在自己包的 `Module` 里用，还是 `newX`。
- **文件名去掉前缀**：包已经说了它属于谁（`session/facts.go`、`task/task.go`、`game/ledger.go`），只有同一个包里分不清的留着（`voice/line.go`、`voice_agora.go`）。包内没导出的名字不改前缀，那只是噪音。
- **测试跟着它测的包走**，而且只碰得到它下面的东西：
  - 包自己的测试用 `newWorld`（`world_test.go`）：一个 `base.App`，带排在前面的包和本包。`tickets` 的 `newWorldWith` 能多带后面的包，计划的测试要看账本。
  - 一路走过好几个包的（派帮工、收获、记账）留在 `farm`，用 `New`。它们要碰的几样内部变成了导出的测试口子：`Runtimes.Registry`、`Runtimes.Probe`、`Schedules.Now`、`Heartbeat.Now`、`Dispatch.TryQueued`，读计数的 `Runtimes.UsageAsked`、`Commits.Asked`；别的改成直接查数据库。
  - 院门的测试要走整个 API，留在 `channels` 目录、做外部测试包 `channels_test`，要碰的内部经 `export_test.go`，生产代码里不多导出。
  - 各包测试共用的（比较、等待、一次性的 git 仓库）在 `internal/testkit`，它不 import 农场的任何包，`protocol` 自己的测试也用它；种子里的 lab 档案和 pi 农机在 `internal/testkit/fixture`。

## Alternatives considered

**按层分，不按概念分。** 按「谁调谁」切成几层包，切口最少。没选：fx 那次已经因为这个改成按概念分（[概念先行，农场是皮](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)），包就是那些模块。

**更细的包（一个服务一个包）。** `Crew`、`Runtimes`、`Trajectories` 共用会话的规则和步骤，拆开要导出一大片包内的东西，而且没有哪个边界是这样守出来的。

**全部集成测试留在 `farm`。** 改动最少，可语音、院门、田头的测试碰了一百来样包内的东西，要么全导出，要么全重写。分到各包、用 `newWorld` 只建它下面的，几乎不用改测试本身。

**所有跨包测试都用外部测试包加 `export_test.go`。** 能用 `farm.New`，可每碰一样内部就得在 `export_test.go` 里转一道，田头、管家的测试要转几十样。只给院门用，因为它真要整个 API。

**`handler` 放在 `farm` 下面，`farm` 组装时建它。** 院门的 API 就能在 `farm.New` 里接好，调用的人不用记得先调 `handler.New`。没选：`handler` 要用全部服务，放在下面就得再列一遍全部服务的结构体，两份清单；放在上面，`farm` 是服务，`handler` 是服务上的 HTTP，方向和别的包一致。

**声网整个搬进 `pkg/agora`，连语音设置一起。** 设置是 protocol 的形状，`pkg` 是能单独拿去用的库，不该 import `internal/`。

## Consequences

- 往上调用或成环，编译不过；放错包的东西会在这里暴露出来，不会再悄悄长回去。
- 加一个服务要在它的包的 `Module` 和 `farm.go` 的 `services` 各加一行；加一个包还要插进 `layers`。
- 有几样只为测试导出的口子（上面列的）。它们写在字段和方法的注释里，生产代码不该用。
- 一个包的测试看不到排在后面的服务在做什么：`newWorld` 里没有管家、没有账本。依赖它们的断言只能放在 `farm`，或者用 `newWorldWith` 带上。
- 文档和 Note 里的路径都改成了新的包和文件名。

## Verification

- `go vet ./... && go test ./...` 通过；测试函数从 155 个变成 156 个：一个生命周期测试挪到 `base`，`crewCommentOn` 的断言单独成了 `runs` 的一个测试，没有丢。
- `base/lifecycle_test.go`：服务按依赖开、ready、倒着停；`workspace/workspace_test.go`：真的农场 ready 的顺序还是 Commits、Crew、Schedules、Connectors。
