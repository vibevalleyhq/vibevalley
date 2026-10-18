# server：VibeValley 的服务端

VibeValley 唯一的服务端：答 VibeValleyApi、`/api/v1/events`、`/api/v1/state`、`/api/v1/live` 和 `/mcp`，给 Flutter 客户端。`workspace` 是一个库，`cmd/server` 单独跑它；Flutter 的 macOS 应用把 `cmd/server` 编进应用、开机拉起（[客户端](docs/subsystems/app.md)）。行为见 [子系统](docs/subsystems/README.md)；为什么用 Go、建在 smith 上见 [服务端用 Go 重写](docs/subsystems/foundation.md)。

Go 模块 `vibevalley`，Go 1.27.2，不用 cgo（SQLite 用 `modernc.org/sqlite`）。

作为应用或验证脚本的子进程启动时，设 `VIBEVALLEY_PORT=0` 并传 `--ready-json`：监听与工作区就绪后，stdout 只发布一行 `protocol.ServerReady`（实际 `url`、当前 `pid`），普通日志仍写 stderr。宿主不预占端口，也不把日志文字当协议；[桌面启动](docs/subsystems/app.md)按这个收据连接。

## 目录

`internal/` 是只给本模块用的（农场的服务和协议），`pkg/` 是能单独拿去用的库，`cmd/` 是命令，`tool/` 是开发时的工具。

| 包 | 管什么 |
|---|---|
| `internal/protocol` | 形状和接口的唯一来源（`shapes.go`、`api.go`）和生成的 `gen.go`；核心状态的折法（`Reduce`）和几个包都用的纯规则（只有一个主人的规则在主人包里）；`seeds.json`（种子档案、默认设置、农机的能力、成就） |
| `internal/base` | 地基，不放业务：数据库和迁移、`Hub`、存文件、id、`Config`（viper 读 YAML 和环境变量）、生命周期 |
| `internal/core`、`setting`、`agent`、`project`、`memory`、`runtime`、`session`、`channel`、`schedule`、`issue`、`task`、`manager`、`gate`、`voice`、`connector`、`game` | 服务，一块业务一个包（见「服务」） |
| `internal/workspace` | 把全部包组装成一个 Workspace（`workspace.go`：`Workspace` 握着全部服务） |
| `internal/handler` | 全部 HTTP 处理：`VibeValleyApi`（`api.go`，每个处理只转给拥有它的服务）、事件流和状态流；`/mcp` 挂的是 `mcp` 包的处理（`http.go`） |
| `internal/testkit` | 各包的测试共用的：比较（`Eq`、`Match`）、等待（`Until`、`Await` 等会发生的事，`Settle` 查不该发生的）、一次性的 git 仓库；只给测试 import，不 import 农场的包，`protocol` 自己的测试也用它。测试的起点（临时目录里的配置 `fixture.Config`、种子里的 lab 档案和 pi 农机）在 `testkit/fixture` |
| `migrations` | SQLite 的表结构：`0001_schema.sql` 是整个库，改表直接改它，不另加迁移（旧库删掉重建）；编进二进制，`Up` 在服务端开机时（或 `cmd/migrate up`）跑它 |
| `pkg/db` | sqlc 的查询（`queries/`，一张表一个文件）和从它生成的 Go（`generated/`）；配置和生成命令在 `sqlc.yaml` |
| `pkg/ai`、`pkg/agentcore` | agent 的底层：调模型、agent 循环；不认识农场。上面那层（VibeValley 自己的 agent）在 `internal/agent/brain` |
| `pkg/x` | 通用的小封装，一类一个包，不认识农场：`str`（按 JavaScript 和 Dart 的算法数字符串：UTF-16 长度、截取、trim、空白、截断加省略号）、`num`（照 JavaScript 写数字：`toFixed`、`String(n)`、`Math.round`）、`ptr`（可选字段的指针）、`clock`（毫秒时间、可取消的等待）。哪个包要这类东西用它，不在自己包里再写一份 |
| `pkg/agora` | 声网（Agora）：签令牌、拼语音 agent 的请求；不认识农场 |
| `pkg/weixin`、`pkg/feishu`、`pkg/qq` | 微信、飞书、QQ 机器人的接口：登录、收、发；每个有 `API` 接口（测试换成假的）和真的 `Client`。不认识农场，账号和谁是主人在 `connector` 里 |
| `pkg/smith` | oar 的 Go 移植（[README](server/pkg/smith/README.md)），驱动各家编码 agent |
| `cmd/server` | 单独跑的服务端：固定听 `127.0.0.1`，端口来自配置（默认 8787）；配置来自 `$VIBEVALLEY_HOME/vibevalley.yaml` 和 `VIBEVALLEY_*` 环境变量（`--config` 指别的文件）；`--log 文件` 把日志也追加到文件里 |
| `cmd/vibevalley` | 命令行：`<组> <操作>` 调农场的一个接口（从 `protocol.Endpoints` 来，经 `protocol.Client`），`state`、`events` 读两条流，`runtime chat <农机>` 在本机和一个农机直接聊（不经农场），`oar <命令>` 是 smith 的 oar 命令行（`pkg/smith/cli`，`detect`、`models`、`login`、`run`……），这两个的农机和服务端的一样（`runtime.Registry`），不带命令是 VibeValley 自己的 agent |
| `cmd/migrate` | 表结构：`status` 看库在第几版、`up` 跑基线；库和服务端读的是同一个（`--config`、`VIBEVALLEY_HOME`、`VIBEVALLEY_DB`）。服务端开机照旧自己跑 |
| `tool` | 开发时的工具，不进产品：`shapegen`（Go）从 `protocol` 的形状写出 `gen.go` 和 Flutter 的 `lib/gen`；Node 脚本 `pi-prices.ts`（自己的 `package.json`）写 pi 的价目表 `internal/runtime/pi_prices.json` |

## 服务

一个包是一块业务，只导出一个服务：`<包>.Service`（[理由](docs/subsystems/foundation.md)）。`Workspace` 和测试的服务表里，它的字段用单数的概念名，调用处读起来是 `f.Project.List()`、`f.Issue.Merge(…)`。一块业务里分开写的几部分是包内不导出的零件（`issue` 的 `issues`、`dispatch`、`merges`），`Service` 嵌入它们，它们导出的方法就是 `Service` 的方法；零件之间不能有同名的导出方法。

构造函数的参数就是它用到的服务和配置（多的用带 `fx.In` 的参数结构体，如 `sessionsIn`、`managerIn`），一个包的 `Service` 只要一个；没有服务拿整个 `Workspace`。每个包的 `Module`（`func(*base.Readies) fx.Option`）把零件的构造函数设成 `fx.Private`，只把 `Service` 交给 fx（`go.uber.org/fx`）；`base.App` 把给它的各包装在一个生命周期上：`NewApp` 建，`Start` 开，`Close` 停。`workspace.New` 是带全部包的 App（[理由](docs/subsystems/foundation.md)）。

`NewApp` 独占传入的 Home，第二个 App 在构造服务前失败；调用方应以 `Close` 结束整个 App，不能只关闭数据库。租约覆盖所有服务的最后写入（[理由](docs/subsystems/app.md)）。

服务按业务分包（[概念](docs/concepts.md)）：一个包是一块业务，接口窄、里面深；包名用单数，用[用语表](docs/README.md#用语)里的词。先是活本身，最后是画在上面的游戏。一个包只 import 表里排在它前面的包，编译器替我们守着；反方向的消息走 `base.Hub[T]`（`base/hub.go`：核心状态的事实、执行的动静、群聊和计划给管家的消息），只送给当时在订阅的，慢的排长队，不丢：

| 包 | `Workspace` 上的字段 | 管什么 |
|---|---|---|
| core | `Core` | 核心状态和它的事实、帧、事件流（`state.json`）；最先建、最后关 |
| setting | `Setting` | 钥匙和语音设置（`settings.json`，0600） |
| agent | `Agent` | 帮工档案、技能书、农机设置（`config.json`）；子包 `brain` 是 VibeValley 自己的 agent（会话、压缩、技能、记性、定时、帮手、编码工具；管家用它，`brain/oarruntime` 把它包成农机 `vibevalley`） |
| project | `Project` | 仓库、worktree、每个项目同时能有几个执行，和项目页要的统计（`codebase.go`：最近一次提交、语言、一年的提交） |
| memory | `Memory` | 档案记得的事（`memory.go`）和管家记得的事（`WriteManager`、`ForgetManager`、`Archive`） |
| runtime | `Runtime` | 农机的探测、额度、花费、价目表 |
| session | `Session` | 为工单开的 Session，农场里的帮工（`sessions.go`：会话、带话和叫醒、同时干活的上限，建在 smith 上）、执行的步骤和轨迹头（`trajectories.go`）、帮工会话的令牌（`tokens.go`） |
| channel | `Channel` | 频道、对话、串、消息、投递 |
| schedule | `Schedule` | 定时 |
| issue | `Issue` | 工单（`issue.go`）、派活、排队、重开工单（`dispatch.go`）、收成清单、收获（`merges.go`） |
| task | `Task` | 种植计划（Task）和它的经过（`task.go`、`log.go`）；子包 `engine` 是 agent 自己的任务图：形状、规则、存储（表 `task_graph`） |
| tool | `Tool` | agent 能调的工具，各定义一次：管家在进程里拿，Session 经 `/mcp` 拿 |
| manager | `Manager` | 管家（`manager.go`）和巡查（`patrol.go`：看 Inbox，放久了叫醒管家） |
| gate | `Gate` | 「连接到本机」 |
| voice | `Voice` | 声网（`agora.go`）和语音线路（`line.go`） |
| connector | `Connector` | 微信、飞书、QQ 接到频道 |
| game | `Game` | 服务端的全部游戏：账本（`ledger.go`：金币、连胜、成就）、等级（`commits.go`）、主人刚点的空地（`beds.go`）。只听别的包的事实，业务的服务不调它；只有 HTTP 那一层为主人在应用里做的事调它。账本的折法在 `progress.go`；出帧要用的（地里长什么、帮工在哪块地）在 protocol 的 `game_view.go`、`game_play.go` |
| mcp | `MCP` | `/mcp`：把 `tool` 给 Session 的工具交给编码 agent（在频道里说话、读、看未读、看谁在、记性）。和 HTTP 一样是入口，只认是谁、转给工具 |

服务之间传的形状放在定义它的包的 `types.go`（`project.Workplace`、`session.HireOptions`、`channel.Info`……）；`base` 不放形状。

HTTP（`handler`）在最上面，经 `Workspace` 用全部服务；`workspace` 只组装服务，不认识 HTTP。「连接到本机」答的那部分 API（`apiMux`）在农场开之前交给 `Gate.API`。

- **生命周期**：服务有 `OnStart(ctx)`（订阅它听的消息、开后台的活）和 `OnStop()`（`base.Service`）。`Module` 里的 `Service` 包一层 `base.Run`，挂到 fx 的生命周期上，所以一个服务总在它用到的服务之后开、之前停，不用手排顺序。一个包里的零件由 `base.Parts` 按 `newService` 里的顺序开，倒着停。有 `OnReady(ctx)` 的，在全部服务都开了以后按同样的顺序调：开机就要发布的活放那里，订阅的都听得到。`Start` 给的 ctx 一直有效，到 `Close` 才取消，后台的活跟着停。
- **加一块业务**：在它所属的包里加一个零件（结构体、`newX(用到的服务…)`、`OnStart`、`OnStop`，需要时加 `OnReady`），在 `Module` 里加进 `fx.Private` 的构造函数，在 `service.go` 里嵌进 `Service`、排进 `base.Parts`。依赖成环或缺了谁，`New` 报错；要用排在后面的包，编译就不过：改走 `Hub`，或者想想它是不是放错了包。
- **加一个包**：一块业务一个包，写它的 `Service` 和 `Module`，按依赖插进 `workspace.go` 的 `layers`、`services` 和上表。
- **测试**：单个零件用它的构造函数直接建，只给它要的那几样。要一座农场的，在包自己的测试里用 `newWorld`（`world_test.go`：只带排在前面的包和本包）；跨好几个包的在 `workspace` 的测试里用 `New`。换掉其中一样用 `fx.Replace`、`fx.Decorate`，或在 `Start` 之前改服务上留的测试口子（`Runtime.Probe`、`Schedule.Now`、`Manager.PatrolNow`……）。

拒绝是普通的 `error`，文字给主人看；`handler/api.go` 把它变成 `Refused`。

核心状态只经 `Core.Apply(protocol.FactX{…})` 改。数据库是 SQLite（`vibevalley.db`，一个连接，所以 seq 的顺序就是提交的顺序；时间存毫秒），表在 `migrations/`；SQL 只写在 `pkg/db/queries/<表>.sql`，Go 里只调 sqlc 生成的（`pkg/db/generated`）。

## 形状和规则从哪来

形状和规则都只在这里的 `protocol` 包（[理由](docs/subsystems/foundation.md)）。形状写在 `shapes.go`：结构体、`type X string` 加常量的枚举、带标签的联合（`//vibevalley:union` 和成员上的 `//vibevalley:member`）、接口的错误（`//vibevalley:error`）；接口写在 `api.go` 的 `Handlers` 里，每个方法带 `//vibevalley:route` 和 `//vibevalley:can`（谁能调：`owner`、`remote`、`manager`、`session`，写成 `protocol.Endpoints` 和 [能力表](docs/reference/capabilities.md)，「连接到本机」按它放行）；id 都是 uuid 字符串；数字的查询参数写 `*int64`，生成的 `Mount` 解析。改了它们跑：

```bash
go run ./tool/shapegen          # 写 protocol/gen.go 和 ../app/lib/gen/vibevalley.dart；-check 只查是不是最新
```

可选的字段写 `omitzero`；能是 null 的写成指针，切片、表、联合写不成指针的加 `vibevalley:"null"`；别的必填的切片和表，空的时候写成 `[]`、`{}`（客户端的解码不收 null）。两边都要的普通常量（管家的 id、同时干活的上限、会话选项的名字……）写在 `shapes.go` 开头，带 `//vibevalley:const <Dart 名>`，生成到 Dart；Dart 里不再手抄 Go 的值。种子数据（`seeds.json`）直接改，客户端要的那部分（成就表和每档的金币、每种动作怎么说，农机的名字、外形和能力，没见过的农机的兜底外形）也由 shapegen 写进 `lib/gen`。

规则在它的主人那里：核心状态的折法和它用到的、几个包都用的（田头、阶段、计划、游戏的画面……）在 `protocol`；只有一个包用的在那个包里、不导出（连接器的文字在 `connector/text.go`，设置和语音的检查在 `setting/rules.go`，记性怎么挑在 `memory/recall.go`，农机能不能派在 `runtime/rules.go`，管家怎么说钱在 `manager/words.go`，额度怎么说在 `runtime/quota.go`，田头给谁、叫不叫醒在 `channel/rules.go`，账本怎么折在 `game/progress.go`，计划的读、改、派在 `task/rules.go`，工单的文字在 `issue/rules.go`，到点和错过在 `schedule/rules.go`，巡查在 `manager/patrol_rules.go`）。规则的测试有两种：直接写的，和黄金数据（各包的 `testdata/*.jsonl.gz`：成千上万条带种子的随机输入和规则的结果，`internal/golden` 读写）。`golden.Rules` 逐条比；有意改了规则，`VIBEVALLEY_GOLDEN=update go test ./internal/...` 用 Go 的结果重写，再看 diff 是不是只改了该改的。黄金数据守的是折法和大量组合的规则，不是一段代码存在的理由：服务端不调、只被它录着的函数，`bun run go:deadcode` 会报，要么让服务端用上，要么删。Flutter 解码测试用的那一帧 `app/test/fixtures/state-frame.sample.json` 也由它写。声网请求的对照 `internal/voice/testdata/voice-requests.json` 是手写的：改了 `Voice` 就手改它。

## 取舍

- **写错的配置**：读不成数字的值、不是端口的端口让服务端起不来，开机就看到；能读却不认识的值（`voice.model` 不在列表里）用默认。键的清单见 [architecture.md](docs/architecture.md)「配置」。
- **存着的文件读不了**：`config.json` 挪到旁边（`config.json.unreadable-<时间>`），档案从种子开始；挪不成就不启动，绝不覆盖主人的文件。失败不当成功：写轨迹、合并后退出合并、退回待办这些出错时记日志或说给主人，不悄悄吞掉。
- **端口被占**：语音线路的端口被占时只记一行日志（[语音](docs/subsystems/voice.md)），「连接到本机」的写进「连接到本机」的状态（[连接到本机](docs/subsystems/gate.md)），农场照常。
- **字数上限**：VibeValley 自己的 agent 里的（管家的 `MEMORY.md` 尾巴、工具结果的截断）按字符数；`protocol` 和服务里给人看的文字按 UTF-16 码元量，空白照 JavaScript 的 `\s`：只有 `pkg/x/str` 一份（`str.Units`、`Slice`、`Trim`、`SpaceClass`、`Cut`、`Clip`），服务和规则都用它，黄金数据守着的就是这一份。
- **后台的活不能乱序落地**：后台读一份外面的状态（git、农机、额度）再写回的，两次读可能交叉，早开始的晚回来就会盖掉新的。要么一次一个（在订阅事件的那个循环里直接做，`base.Hub` 慢了只会排队、不会挡住发布的；或者一把锁包住读和写，如 `game` 的数提交），要么开始时拿号、落地时丢掉比已存的旧的（`runtime` 的农机信息）。
- **数字照 JavaScript 算**：规则里先乘再加减（`a*b+c`）的地方，乘积用 `float64(...)` 包起来。Go 在 arm64 上会把它合成一条 FMA，中间不舍入，结果就和 JavaScript、和 amd64 不一样（`1+0.1*7` 会是 1.7，不是 1.7000000000000002，金币就差一枚）。`num.Round` 自己先舍入输入。测试的输入不要写成常量，常量会在编译时精确折叠，测不出来。
- **农机**：pi 要 Node（smith 用内嵌的 Node 宿主跑 pi 的 SDK），cursor 接不上（smith 没有 JS 宿主），见 [agents-and-runtimes.md](docs/reference/agents-and-runtimes.md) 和 [smith 的 GAPS](server/pkg/smith/GAPS.md)。

## 测试

```bash
go vet ./... && go test ./...
```

不连网、不花钱：帮工由 smith 的 `oartest` 扮演，项目用真的 git 仓库，模型用 `ai.FauxProvider`，声网、飞书、QQ、微信是本地的假服务；测试里 `Runtime` 不探测本机的农机，管家没给模型时不出声。smith 的测试也在这个模块里，`go test ./...` 一起跑（smith 那部分约一分半）。
