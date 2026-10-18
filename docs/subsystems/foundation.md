# 地基

服务端所有包共用的骨架，不是一块业务，农场上也不画出来：一个 Go 模块 `vibevalley`，按 `internal/`、`pkg/` 分；一个概念一个包，每个包只导出一个 `Service`，由 fx 按依赖组装；形状和规则只在 Go，Flutter 的类型从它生成；SQL 只在 sqlc，表结构只有一份；测试共用一套工具，帮工由脚本扮演。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 模块和目录：`cmd/`、`internal/`、`pkg/`、`tool/`、`migrations/` | 每个包对外的约定、导出什么（[server/README.md](server/README.md)、各包的 README） |
| 包怎么分、怎么起名、谁能 import 谁；`Service`、`Module`、生命周期（`base.Run`、`base.Parts`、`OnReady`） | 每块业务里面的行为（[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)、[项目](docs/subsystems/project.md)、[田头](docs/subsystems/channel.md)、[管家](docs/subsystems/manager.md)、[定时](docs/subsystems/schedule.md)、[种植计划](docs/subsystems/task.md)、[记性](docs/subsystems/memory.md)） |
| 形状和接口从哪来、`shapegen` 生成什么 | 核心状态折什么、帧里有什么（[architecture.md](docs/architecture.md)「核心状态」） |
| 规则放在哪个包、黄金数据跟着谁 | 某条规则本身（它的主人的子系统） |
| `pkg/x` 的通用小封装 | 声网、三家聊天软件、smith 这些库本身（`pkg/agora`、`pkg/weixin`…、[smith](server/pkg/smith/README.md)） |
| 存盘的地基：一个 SQLite 连接、迁移、sqlc、表名、uuidv7 主键、不认旧数据 | 每张表存什么（拥有它的子系统）；家目录里的文件和配置键（[architecture.md](docs/architecture.md)「存了什么」「配置」） |
| 测试的地基：`testkit`、`golden`、`oartest`、`newWorld`；死代码和旧名字的检查 | HTTP 的处理（`internal/handler`）、客户端的分层（[app/README.md](app/README.md)） |

## 在哪

- **模块**：`server/go.mod`，模块 `vibevalley`，Go 1.27.2，不用 cgo（SQLite 是 `modernc.org/sqlite`）。`cmd/server`（服务端）、`cmd/vibevalley`（命令行）、`cmd/migrate`（`status`、`up`）；`tool/shapegen`（Go）和 `tool/pi-prices.ts`（Node 24，自己的 `package.json`）。
- **地基包** `internal/base`：`app.go`（`NewApp`、`Start`、`Close`）、`lifecycle.go`（`Service`、`Readier`、`Run`、`Parts`、`BeforeReady`）、`hub.go`（`Hub[T]`）、`db.go`（`OpenDB`）、`ids.go`（`NewID`、`Code`）、`config.go`、`files.go`、`home_lease*.go`、`redact.go`。
- **组装**：`internal/workspace/workspace.go`（`layers`、`services`、`New`）；每个包的 `module.go`（`Module`）和 `service.go`（`Service`、`newService`）。HTTP 在它上面：`internal/handler`（`New`、`Listen`）。
- **形状**：`internal/protocol/shapes.go`、`api.go`、`seeds.json`；生成的 `internal/protocol/gen.go`、`app/lib/gen/vibevalley.dart`、[capabilities.md](docs/reference/capabilities.md)。
- **规则和黄金数据**：`protocol` 和各包的 `rules.go` 一类文件；`<包>/testdata/*.jsonl.gz`，读写工具 `internal/golden`。
- **通用小封装**：`pkg/x/str`、`num`、`ptr`、`clock`。
- **存盘**：`migrations/0001_schema.sql`、`migrations/migrations.go`（`Up`、`Names`、`Version`、可换的 `FS`）；`pkg/db/queries/<表>.sql`、生成的 `pkg/db/generated/`，配置 `server/sqlc.yaml`。
- **测试工具**：`internal/testkit`（`Eq`、`Match`、`Await`、`Until`、`Settle`、`Git`、`Repo`）、`internal/testkit/fixture`（`Config`、`Lab`、`Pi`、`NoGitHub`）、`pkg/smith/oartest`、`pkg/ai` 的 `FauxProvider`。
- **检查**：`scripts/deadcode.ts`（`bun run go:deadcode`）、`scripts/stale-names.ts`（`bun run names:verify`，也在 `docs:verify` 里）。

## 模型和不变量

**模块和目录**

- `server/` 只有一个 Go 模块。`internal/` 只给本模块用：农场的服务、`protocol`、HTTP、测试工具。`pkg/` 是能单独拿走的库，不 import `internal/`：`smith`、`ai`、`agentcore`、`db`、`agora`、`weixin`、`feishu`、`qq`、`x`。smith 连同它的 `internal/` 和 `cmd/oar`、`cmd/oar-bridge` 整块在 `pkg/smith` 下。`go vet ./...`、`go test ./...` 一次查完全部，smith 的测试约一分半。

**包和服务**

- **一块业务一个包**，都在 `server/internal/` 下，包名单数，用[用语表](docs/README.md#用语)和[概念](docs/concepts.md)里的词：`core`、`setting`、`agent`、`project`、`memory`、`runtime`、`session`、`channel`、`schedule`、`issue`、`task`、`tool`、`manager`、`gate`、`voice`、`connector`、`game`、`mcp`。子包只有 `agent/brain`（VibeValley 自己的 agent）和 `task/engine`。和别的包同名时在 import 处起别名（`internal/agent/brain` 在 `manager` 里叫 `vvagent`；标准库 `runtime` 用到时起别名）。
- **一个包只导出一个服务 `<包>.Service`**。一块业务里分开写的几部分是包内不导出的零件（`issue` 的 `issues`、`dispatch`、`merges`），`Service` 嵌入它们，它们导出的方法就是 `Service` 的方法；零件之间不能有同名的导出方法，Go 只在用到时报「ambiguous selector」。
- **`base` 只放地基**：数据库、`Hub`、存文件、id、`Config`、生命周期、日志脱敏。不放业务，不放服务之间传的形状；那些形状放在定义它的包的 `types.go`（`project.Workplace`、`session.HireOptions`），主人在上层、下层也要用的放在下层那个包。
- **包有先后**：`workspace.go` 的 `layers` 是 `core`、`setting`、`agent`、`project`、`memory`、`runtime`、`session`、`channel`、`schedule`、`issue`、`task`、`tool`、`manager`、`gate`、`voice`、`connector`、`game`、`mcp`。一个包只 import 排在它前面的包，往上调用或成环是编译错误。反方向的消息走 `base.Hub[T]`：只送给当时在订阅的，慢的订阅者排长队，不丢。`game` 只听别的包的事实，业务的服务不调它。
- **`Workspace` 上的字段是单数概念名**：`f.Project.List()`、`f.Issue.Merge(…)`；`handler`、`cmd/server` 和跨包的测试经它拿服务。`workspace` 只组装，不认识 HTTP；`handler` 在它上面。

**组装和生命周期**

- **构造函数的参数是它用到的服务和配置**，多的用带 `fx.In` 的参数结构体（`sessionsIn`、`managerIn`）；一个包的 `Service` 在参数里只出现一次（fx 不让同一个类型出现两次）。没有服务拿整个 `Workspace`。
- **`Module`**（`func(*base.Readies) fx.Option`）把零件的构造函数设成 `fx.Private`，只把 `base.Run[*Service](r, newService)` 交给 fx。`base.Run` 在构造时挂上 `OnStart`、`OnStop` 钩子，所以一个服务总在它用到的服务之后开、之前停，没有手排的顺序表。
- **三段生命周期**：`OnStart(ctx)` 订阅、开后台的活；`OnReady(ctx)`（可选）在全部服务都开了以后按开的顺序调，开机就要发布的放这里，订阅者都听得到；`OnStop()` 倒着停。`base.Parts` 按 `newService` 里的顺序开一个包的零件，一个开失败就把已开的倒着停掉。`base.BeforeReady` 在全部 `OnStart` 之后、第一个 `OnReady` 之前跑：`handler.Listen` 用它先开始答 HTTP，再让服务发开机的活。
- **`App`**：`NewApp` 先拿家目录的租约（`.vibevalley.lock`，第二个 App 在构造服务前失败，[理由](docs/subsystems/app.md)），再按 `layers` 建全部服务；fx 自己的日志关掉（`fx.NopLogger`），依赖成环、缺了谁由 `New` 的返回值报。`Start` 给的 ctx 到 `Close` 才取消，后台的活跟着停；`Close` 停服务、关库、最后放租约。现在 ready 的顺序是 `game`、`session`、`schedule`、`connector`。
- **一个服务拿着的是建的时候给它的那几个**：建好以后改 `Workspace` 上的字段，别的服务看不到；要换掉一样，在 `New` 时用 `fx.Replace`、`fx.Decorate`，或在 `Start` 之前改服务上留的测试口子（`Runtime.Probe`、`Runtime.Registry`、`Schedule.Now`、`Manager.PatrolNow`）。这些口子在字段注释里写明只给测试。

**形状和规则**

- **形状和接口只写在 Go**：`shapes.go`（核心状态、事实、事件、帧、请求和回答、两边共用的常量）和 `api.go`（`Handlers`，一个接口一个方法）。Go 的类型系统说不出的用注释指令：`//vibevalley:union`、`member`、`error`、`route`、`can`、`dart`、`const`。字段上 `omitzero` 是可选，指针是可空，切片、表、联合写不成指针的用 `vibevalley:"null"`；别的必填的切片和表，空时写成 `[]`、`{}`。
- **`tool/shapegen` 用 `go/ast` 读这两个文件**，写出 `gen.go`（联合的编解码和成员表 `XMembers`、枚举的值、错误类型、`Mount`）、`app/lib/gen/vibevalley.dart`（类型、sealed class、`VibeValleyApi`、共用常量、`seeds.json` 里客户端要的部分，经 `dart format`）和 [capabilities.md](docs/reference/capabilities.md)。`-check` 只查是不是最新，`bun run flutter:check` 先跑它。形状里用了它不认识的写法（匿名结构体、别的基本类型），它报错，不猜。Dart 名由 Go 名推出（`MCPServer` → `McpServer`），撞名的用 `//vibevalley:dart`。Dart 的数字一律是 `double`。
- **生成的不手改**：`gen.go`、`lib/gen/`、`capabilities.md`、`pkg/db/generated/`。`seeds.json` 是直接改的数据文件。
- **要每种都处理的地方穷尽**：Go 的编译器不查类型 `switch` 漏没漏成员，用生成的成员表写测试（`agent` 的 `TestProfileSnapshotCoversEveryMCPMember`）；Dart 的 sealed class 由编译器查。
- **规则在它的主人那里**：核心状态的折法（`Reduce`、`FrameOf`）和它用到的、几个包都用的规则在 `protocol`；只有一个包用的在那个包里、不导出：`connector/text.go`、`setting/rules.go`、`memory/recall.go`、`runtime/rules.go`、`runtime/quota.go`、`manager/words.go`、`manager/patrol_rules.go`、`channel/rules.go`、`game/progress.go`、`task/rules.go`、`issue/rules.go`、`schedule/rules.go`。别的包要用一条单一主人的规则，问它的服务（`runtime.Check`），或者挪回 `protocol`。留在 `protocol` 的单一用户函数都有理由：核心状态的初值和折法要用的、种子和默认值（`DefaultVoice`）、和别的规则共用解析的。
- **黄金数据跟着规则**：每个有规则的包有 `testdata/*.jsonl.gz`（成千上万条带种子的随机输入和结果）和 `TestRulesGolden`，经 `golden.Rules` 逐条比。黄金数据守折法和大量组合的规则，不是一段代码存在的理由：服务端不调、只被它录着的函数，`go:deadcode` 报。
- **通用的小封装只有 `pkg/x` 一份**：`str`（按 UTF-16 码元数、JavaScript 的 `\s` 认空白：`Units`、`Slice`、`Trim`、`Head`、`Cut`、`Clip`、`Lower`、`IsSpace`）、`num`（照 JavaScript 写数字：`Text`、`Fixed`、`Round`）、`ptr`（`To`、`Or`、`Value`）、`clock`（`NowMs`、`Sleep`）。不依赖农场的任何包；各包不再写自己的 `xxxPtr`、`chatTrim`。农场的说法（`Yuan`、`DayMs`）留在 `protocol`。

**存盘**

- **一个 SQLite 连接**：`base.OpenDB` 开 `vibevalley.db`（`foreign_keys`、WAL、`busy_timeout` 5000 毫秒），`SetMaxOpenConns(1)`，所以只有一个写者，seq 的顺序就是提交的顺序。时间存毫秒，开关的列写 `boolean`。
- **SQL 只在 sqlc**：查询在 `pkg/db/queries/<表>.sql`，一张表一个文件，只放主要读写这张表的；跨表的联查放在它返回的那张表的文件。服务里不手写 SQL，只调 `generated`，再把行读成自己的形状；只有 `migrations` 跑表结构。sqlc 推不出类型的表达式（`coalesce`、`max`）写 `cast(… as integer)`。sqlc 改名或删了查询文件不会删旧的生成文件：`TestGeneratedHasItsQueries` 查每个生成文件都有源。
- **表名是 `<模块>` 或 `<模块>_<概念>`**，单数，模块是拥有它的 `server/internal` 包（`issue`、`issue_session`、`channel_message`、`session_run`、`game_ledger`、`gate_device`）；`base`、`handler`、`protocol`、`workspace`、`mcp`、`testkit`、`golden` 不拥有表。索引名以表名开头（`channel_message_by_sender`）。全文索引的影子表（`<表>_data`、`_idx`…）不算。sqlc 生成的类型跟着表名（`generated.ChannelMessage`）。
- **一份表结构，不认旧数据**：`migrations/0001_schema.sql` 是整个库，改表直接改它，不另加迁移；目录里只能有这一个 `.sql`。存盘的格式只有现在这一种：表、家目录里的文件、环境变量、存下的取值都只认今天的名字，没有读旧名字、改写旧文件、搬数据的代码。改了格式，本机的旧库和旧文件删掉重建。
- **`migrations.Up(db)` 只接连接**：从 `PRAGMA database_list` 读出这条连接实际打开的主库，在同一条连接上读版本（`user_version`）、备份、迁移。已有文件库要升级时先 `VACUUM main INTO` 在旁边留 `.v<当前版本>`（已有同名的不覆盖；内存库、临时库不留）；备份失败不开始。每个文件一个事务，提交前查外键，版本号和它一起提交，失败回滚。库的版本比嵌入的迁移多就拒绝打开。服务端开机经 `OpenDB` 跑它，`cmd/migrate up` 手动跑，`cmd/migrate status` 看版本（经 `OpenDBAsIs`，不迁移）。
- **运行时新建的行主键是 uuidv7**：`base.NewID()`（`google/uuid` 的 `NewV7`，同一进程里单调递增），存成 `text`；协议里的 id 都是 `string`。不用 uuid 的：从文件来的自然键（档案、技能、项目、农机、连接器）、单例（`check (id = 1)`）、几列组成的主键。工单另有从 1 数的 `number`，消息在对话里有从 1 数的 `number`，没有全局 `seq`。`base.Code` 是给人念的配对码，不是 id。

**测试**

- **不连网、不花钱**：帮工由 smith 的 `oartest` 扮演（一个真实的会话：同样的记录、折叠和控制，没有程序、登录和模型；脚本按工单里的字眼跑命令、提交、发呆、失败、解决冲突），项目用临时目录里真的 git 仓库，模型用 `ai.FauxProvider`，声网和三家聊天软件是本地假服务；测试里 `Runtime` 不探测本机的农机。
- **测试跟着它测的包走，只碰得到它下面的**：包自己的测试用 `world_test.go` 的 `newWorld`（一个 `base.App`，只带排在前面的包和本包；`task` 的 `newWorldWith` 能多带后面的）；一路走过好几个包的在 `internal/workspace`，用 `workspace.New`；要走整个 API 的院门测试是外部测试包 `gate_test`，要碰的内部经 `export_test.go`。单个零件用它的构造函数直接建。
- **`testkit`、`golden` 不 import 农场的包**，`protocol` 自己的测试也用它们。各包不写自己的断言和等待：等会发生的事用 `Await`/`Until`（同一个期限），只有查「不该再发生」的用 `Settle`（固定 200 毫秒，慢机器上可能漏报，不会误报）；不用 `time.Sleep` 赌时间。
- **纯规则直接测**，一个输入进去、结果出来，不开会话。

## 怎么走

**加一个服务（一块业务里的零件）**

1. 在所属的包里写结构体、`newX(用到的服务…)`、`OnStart`、`OnStop`，开机要发布的写 `OnReady`。先看包里已有的导出方法名，不撞名。
2. 在 `module.go` 的 `fx.Provide(fx.Private, …)` 里加上 `newX`。
3. 在 `service.go` 里把它嵌进 `Service`，排进 `newService` 的 `base.Parts`。
4. 跑 `go vet ./... && go test ./...`。依赖成环或缺了谁，`New` 报错；要用排在后面的包，编译不过：改走 `Hub`，或者重新想它该在哪个包。

**加一个包**

1. 名字用单数、用语表里的词；写 `Service`、`newService`、`Module`，服务之间传的形状放进它的 `types.go`。
2. 按依赖插进 `workspace.go` 的 `layers` 和 `services`（字段用单数概念名），再加进 [server/README.md](server/README.md#服务) 的表；`TestNamesFollowTheModules` 从 `internal/` 的目录读模块，新包拥有的表自动认得。
3. 写 `world_test.go` 的 `newWorld`：带上 `layers` 里排在它前面的包。
4. 漏了 `services`，又没有别的服务用它，它就不会被建，fx 不报错：用 `TestReadiesInTheOrderItsServicesStarted` 一类的测试或 `verify-server` 看它真的起来了。

**加一张表或改表**

1. 在 `migrations/0001_schema.sql` 里拥有它的那一段直接改：表名 `<模块>_<概念>`，索引以表名开头，主键 `text` 存 uuidv7。
2. 写 `pkg/db/queries/<表>.sql`。
3. 跑 `cd server && GOTOOLCHAIN=go1.27.2 go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate`；表或查询文件改了名，手动删掉旧的 `generated/<旧名>.sql.go`。
4. 服务里调 `generated` 的方法，新行的 id 用 `base.NewID()`。
5. 删掉本机的 `vibevalley.db` 重建；`go test ./migrations/ ./pkg/db/` 查命名、基线和生成文件。

**加一个形状、事实或接口**

1. 改 `internal/protocol/shapes.go` 或 `api.go`：联合加 `//vibevalley:member`，接口带 `//vibevalley:route` 和 `//vibevalley:can`，两边共用的常量带 `//vibevalley:const`。
2. 同一个改动里跑 `cd server && go run ./tool/shapegen`。
3. Go 和 Flutter 编不过的地方就是还没接上的地方：`handler` 实现新的 `Handlers` 方法，新事实在 `Reduce` 里折，要每种都处理的 `switch` 补上。
4. 跑 `bun run flutter:check`（含 `shapegen -check`）和 `go test ./...`。

**改一条规则**

1. 改它的主人包里的纯函数；第二个包也要用，就让它问主人的服务，或挪回 `protocol`。
2. `VIBEVALLEY_GOLDEN=update go test ./internal/...` 重写黄金数据，看 diff 是不是只改了该改的。用环境变量，不用 `-update`：`go test ./...` 会把旗子发给每个测试二进制，没注册它的包会报错。
3. 跑 `bun run go:deadcode`。

## 和谁打交道

- **每个服务包**：照这里的约定写 `Service`、`Module`，经 `base` 拿数据库、`Hub`、配置、id。
- **`core`**：核心状态只经 `Core.Apply` 改；它最先建、最后关，`state.json` 在全部服务停了以后才写。
- **`handler`、`cmd/server`**：`handler.Listen` 开监听、建 `Workspace`、经 `BeforeReady` 在服务发开机的活之前开始答 HTTP；`handler.New` 在农场开之前把 `apiMux` 交给 `Gate.API`（院门要答 API，API 也答院门自己的页面）。
- **Flutter**：只读 `shapegen` 写的 `lib/gen/vibevalley.dart`；客户端的分层和替身在 [app/README.md](app/README.md)。
- **文档**：`shapegen` 写 [capabilities.md](docs/reference/capabilities.md)；`docs:verify` 跑 `stale-names.ts`，在 `server/internal`、`server/cmd`、`app/lib`、`app/test` 里查改掉的旧名字。

## 为什么这样

- **服务端是 Go，一个进程不带 Node；smith 放在模块里一起改。** 桌面版要带一份 Node 和整个服务端，手机端带不了；Go 编出一个约 19 MB、`CGO_ENABLED=0` 的二进制，Flutter 的应用直接带上它。放弃了「留在 TypeScript，起一个 Node 子进程」。smith 是主人自己的 oar 移植，只有这个项目在用、在改：单独成模块只换来两套 `go vet`、`go test` 和一个 `replace`，所以并进 `pkg/smith`，代价是 `go test ./...` 慢一分半。它的命令留在 `pkg/smith/cmd` 下，因为它们用 smith 的 `internal/`，搬到 `server/cmd` 要么公开那些包、要么把 smith 拆在两处。仓库根目录就是 `server/` 和 `app/` 两块，形状的源头放在 `server/` 下面，说清谁拥有接口。
- **`internal` 和 `pkg` 分开，`protocol` 在 `internal`。** 平铺在模块根上看不出哪些只给这个项目用。`protocol` 看起来是契约，但里面是农场的规则，客户端拿的是生成的 Dart，没有别的 Go 代码要用它；以后真要给别人用，先挪到 `pkg`。
- **一个概念一个包，包是一块业务，名字单数、用我们的词。** 服务都在一个包里时，分层只是约定，往上调编译器不说话，文件名前缀（`crew_`、`task_`）在替包做事。按「谁调谁」切层切口最少，但那是按代码现状分，游戏的状态会垫在最底下；按概念分，包就是产品里的东西（[概念先行](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)）。没切得更细（一个服务一个包、轨迹和令牌各一个包）：它们共用会话的规则和锁，拆开要导出一大片包内的东西，边界是浅的。包名用复数或皮上的说法（`tickets`、`channels`、`game` 当账本）时，名字和概念对不上，`channels` 还和频道撞名。`base` 里装过 `Site`、`Store`、`Settings`：每个包都 import `base`，等于每个包都能碰到全部业务，所以 `base` 只放地基。
- **一个包只导出一个服务，叫 `Service`。** 一个包露着好几个服务时（`issue` 的 `Issues`、`Dispatch`、`Merges`），调用处读成 `f.Dispatch.Hire`、`f.Merges.Harvest`，看不出都是工单的事；一块业务一个入口才是深模块。不叫 `project.Project`：这些名字要留给那个概念的值。不用包级函数 `project.List()`：要全局状态，fx 的依赖和每个测试一座农场都没了。不并成一个大结构体：零件各有自己的锁和后台的活，分开写好读，嵌入让方法直接成为 `Service` 的，不用逐个转发。`/mcp` 单独一个包，因为它是外面的 agent 进来的入口，工具会用到频道以外的业务。
- **依赖写在构造函数上，由 fx 组装。** 每个服务拿着整个 `Farm` 时，依赖是隐式的，测试里手搭半个 `Farm` 少一个就空指针，开停的顺序手排两遍，有些顺序要求表上看不出来。fx 让顺序从依赖图里来，测试能在完整的图里换掉任意一样（`fx.Replace`）。放弃了手写组装（编译器会报接错，但顺序表还得维护）和 google/wire（多一步生成、生命周期还得自己写）。代价是接错要到 `New` 时才报，读代码时看不到构造函数在哪里被调；加一个服务要在 `Module` 和 `services` 各加一行。`OnReady` 是 fx 没有的一段，开机发布的活放在那里，订阅的都听得到。
- **反方向走 `Hub`，不丢消息。** 下层要告诉上层的事（事实、执行的动静、给管家的消息）如果直接调，包就有环；发布的人不该被慢的订阅者挡住，也不该悄悄丢掉，所以慢的只排队。
- **形状的源头是 Go，生成器也是 Go。** 服务端是 Go、客户端是 Flutter，中间隔着 TypeScript 的 Effect Schema、导出脚本和两个 Node 生成器，加一个字段三种语言都得懂，还要一个契约脚本查 Go 是否符合 TypeScript。放弃了「Go 用反射导出 JSON Schema、留着 Node 生成器」（`gen.go` 既是生成物又是来源，会绕成圈）、「手写 JSON Schema 当源头」（几千行 JSON 没人手改，没有编译器查）、「用 `go/types` 或反射读形状」（反射丢了注释里的指令，`go/types` 要连 `gen.go` 一起类型检查，生成物坏了生成器自己也跑不起来）。`Mount` 和联合的编解码也生成：一百多个成员、七十多个接口，手写的样板会和形状悄悄对不上。Dart 的数字没有改成 `int`：Flutter 里到处按 `double` 算，那是另一件事。
- **规则跟着主人，黄金数据跟着规则。** `protocol` 按层切时有九千多行、四百多个导出的名字，改连接器的规则要跳去 `protocol`，没有哪个名字说得清是谁的。没拆成「形状包和规则包」：规则还是按层堆在一起。没让规则挪走后导出给别的包：违反一个包一个服务，让别人问服务把规则藏深一层。黄金数据没留一份共享的：重写时谁来写说不清；跟着包走，删一条规则就删它的用例。
- **黄金数据不能让一段代码活着。** 十几个 `protocol` 导出函数服务端从不调，只被黄金数据录着，没人敢动。`deadcode` 列出 `server/internal` 里从 `main` 走不到的函数，有就失败；豁免 `gen.go`（联合编解码覆盖全部成员）和 `testkit`、`golden`；`server/pkg` 是给别处用的库，不查。
- **通用小封装收进 `pkg/x`，一类一个包。** 按 UTF-16 数、按 JavaScript 认空白的算法有六七份，指针的小函数五份，有的用 Go 的空白、和客户端算的不一样；收成一份，黄金数据替它把关。不放 `base`：`base` 是农场的地基，放在 `pkg` 才能单独拿走，`protocol` 也不用为几个字符串函数依赖别的包。不并成一个 `pkg/x`：一个包什么都有就回到大杂烩，分包后 `str.Units`、`num.Fixed` 的名字本身说明是哪一类。
- **查询由 sqlc 生成，一张表一个文件。** 手写在服务里的 SQL 字符串，列和字段靠手对，表改了编译器不知道。按服务分文件和 Go 的包对得上，但一张表被几个服务读写时没有家；按表分，改表结构时要看的查询就在同名文件里。没用 ORM：要另写一套模型，查询不多，SQL 写得更直接。sqlc 不进 `go.mod`：会拉进一大串依赖，只在改查询时跑，版本钉在命令里。sqlc 读 `migrations/` 当表结构，不另写一份 schema。
- **表按模块命名。** 一个库里十几个模块的表共用一个命名空间：频道占了 `message`，`delivery` 会和 artifact 的投递撞。只在撞上时改名，每次都要先有人发现。没给每个模块一个 SQLite 库：跨模块的外键（`issue_session` → `issue`）和一个事务里写两个模块的表都没了。规矩写进 `TestNamesFollowTheModules`，加一张不合的表 `go test` 就失败。
- **一份表结构，不留兼容，不搬数据。** 每次改名都多一段搬旧数据的代码（搬家命令、导入器、开机时改文件名、一个接一个改表名的迁移），都在每次启动的路上，看表结构要把十几个迁移在脑子里叠起来；而项目还没有外部用户，搬数据的代码只让架构成形期的每一步更小心、更慢。放弃了「改表写迁移、搬数据只跑一次」：每次改名仍要写重建表、改 `check`、改存下的取值的 SQL 和测试，把种植计划改成 Task 时光搬数据就要重建四张表。也放弃了「开机看到旧文件顺手导入」：启动会变成一次不可中断的大迁移，出错时农场开不了门。真实的 TypeScript 农场用一次性的导入器搬过一次，导入器只在 git 历史里。以后有了用户，改存盘要重新写迁移：在 `0001_schema.sql` 后面加文件，并改这一条。
- **`Up` 只接数据库连接。** 留着 `Up(db, path)` 要每个调用者保证备份目标和连接的数据源是同一个；URI 内存库、转义的路径、工作目录变化会让这份配对知识散在入口。SQLite 自己知道实际的主库，迁移直接问它。
- **主键用 uuidv7。** 原来工单是随机码、计划是 `p1`、别的是自增整数，协议里一半 `string` 一半 `int64`；跨表、跨农场导数据时整数会打架。uuidv7 带时间、同一进程里单调，两样都省了。代价是已读位置和投递按 id 比先后：系统时钟往回调时，重启后的新消息可能排在旧消息前面；只有一个人在本机用，接受这个风险。
- **测试用脚本扮演帮工，用真的 git。** 真实的农机要联网、登录、花钱，慢而且结果不固定，留给手动验证。没把 smith 整个换成假的：测不到它的事件折叠和汇报时机，那正是最容易出错的地方。代价是脚本不是模型：模型会不会照规矩写「结论：」、会不会自己解决冲突，只能真跑时看（[verify-manager-evals](.agents/skills/verify-manager-evals/SKILL.md)、`verify-server`）。
- **测试跟着包走，共用一套工具。** 全部集成测试留在顶层包，语音、院门、田头的测试碰了一百来样包内的东西，要么全导出、要么全重写；分到各包、用 `newWorld` 只建它下面的，几乎不用改测试本身。没让所有跨包测试都用外部测试包加 `export_test.go`：每碰一样内部就要转一道，只给真要走整个 API 的院门用。断言和等待原来各写五份、八份，期限不一，还有赌时间的 `Sleep`；`testkit` 不 import 农场的包，`protocol` 也能用，各包就不必另写。
- **改名靠编译器和护栏，不靠全局替换。** `turn`、`station`、`harvest` 在 smith、游戏和界面文字里都是对的，盲目 `sed` 要花更多时间找回来。标识符改名用 `gopls rename` 和编译器（Dart 改生成的 `lib/gen`，`flutter analyze` 列出待改处），批量的同一写法用 ast-grep，字符串、SQL、Markdown 用 `rg` 逐处改；改掉的旧名写进 `scripts/stale-names.ts`，回来时 `docs:verify` 失败。

## 还没做的

- 概念先行剩下的几步（把代码里按皮起的名字对上概念）：[概念先行，农场是皮](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)。
- `shapes.go` 按概念拆成几个文件：要改生成器和大量文档里的路径，收益只是好找，还没做。
- Dart 的次数、时间、编号还是 `double`。

## 怎么验证

- `base/lifecycle_test.go` 的 `TestRunStartsEachServiceAfterWhatItIsBuiltFrom`：互相依赖的服务不管在 `fx.Provide` 里怎么排，都按依赖开、按同样的顺序 ready、倒着停；`base/ready_test.go` 的 `TestTransportPreparationPrecedesServiceReadyRequests`；`base/app_test.go` 的 `TestFailedStartCancelsItsLifetime`；`base/home_lease_test.go` 的四个租约测试。
- `workspace/workspace_test.go` 的 `TestReadiesInTheOrderItsServicesStarted`：真的农场 ready 的顺序是 `game`、`session`、`schedule`、`connector`。
- `migrations/names_test.go` 的 `TestNamesFollowTheModules`（表名、索引名、每张表有查询文件）和 `TestTheSchemaIsOneBaseline`；`migrations/identity_test.go` 的 `TestUpOwnsActualMainFileAndOriginalBackup`、`TestUpBackupFailureDoesNotBeginMigrations`、`TestUpRollsBackBrokenMigrationAndRestoresForeignKeys` 等；`base/db_test.go` 的 `TestDBMadeOnceAndOpenedAgain`、`TestDBRefusesASchemaItDoesNotKnow`；`pkg/db/generated_test.go` 的 `TestGeneratedHasItsQueries`。
- `base/ids_test.go` 的 `TestNewIDIsTimeOrderedUUIDv7`。
- `protocol/mount_test.go` 的 `TestMountKeepsTheContract`（生成的路由：坏 JSON 回 400、错误按类型给状态码）；`protocol/client_test.go` 的 `TestClientCallsEveryEndpoint`；`tool/shapegen/routes_test.go` 的 `TestRouteOwnsParameterBindings`；`bun run flutter:check` 跑 `shapegen -check`。
- 各包的 `TestRulesGolden`（`protocol`、`channel`、`connector`、`game`、`issue`、`manager`、`memory`、`runtime`、`schedule`、`setting`、`task`、`tool`）；`pkg/x/str` 的 `TestCountedInUTF16Units`、`pkg/x/num` 的 `TestAsJavaScriptWritesThem`、`TestRoundAProduct`。
- `bun run go:deadcode`、`bun run names:verify`；`cd server && go vet ./... && go test ./...`。
