# server：VibeValley 的服务端

VibeValley 唯一的服务端：答 VibeValleyApi、`/api/site/events`、`/api/site/state` 和 `/mcp`，给 Flutter 客户端。`farm` 是一个库，`cmd/vibevalley` 单独跑它；Flutter 的 macOS 应用把 `cmd/vibevalley` 编进应用、开机拉起（[desktop.md](../docs/reference/desktop.md)）。行为见 [docs/reference/server.md](../docs/reference/server.md)；为什么用 Go、建在 smith 上见 [服务端用 Go 重写](../.agents/notes/implemented/architecture/2026-10-13-go-server-on-smith.md)。

Go 模块 `vibevalley`，Go 1.27.2，不用 cgo（SQLite 用 `modernc.org/sqlite`）。

## 目录

`internal/` 是只给本模块用的（农场的服务和协议），`pkg/` 是能单独拿去用的库，`cmd/` 是命令，`tool/` 是开发时的工具。

| 包 | 管什么 |
|---|---|
| `internal/protocol` | 形状和接口的唯一来源（`shapes.go`、`api.go`）和生成的 `gen.go`；核心状态的全部规则（`Reduce` 和各种纯函数）；`seeds.json`（种子档案、默认设置、农机的能力） |
| `internal/base`、`projects`、`memory`、`runs`、`chat`、`tickets`、`manager`、`channels`、`game` | 服务，一个概念一个包（见「服务」）；`base` 还有共用的数据库、`Site`、`Hub`、`Config` 和生命周期 |
| `internal/farm` | 把全部包组装成农场（`farm.go`：`Farm` 握着全部服务）；搬家：`vibevalley migrate`（`oldnames.go`）和 `vibevalley import`（`import.go`） |
| `internal/handler` | 全部 HTTP 处理：`VibeValleyApi`（`api.go`，每个处理只转给拥有它的服务）、工地事件流和状态流、`/mcp`（`http.go`） |
| `internal/farmtest` | 服务的测试共用的：比较、等待、一次性的 git 仓库、种子里的 pi 档案；只给测试 import，不 import 任何服务的包 |
| `migrations` | SQLite 的迁移（`0001_farm.sql`……），编进二进制，启动时按名字顺序跑，每个一次 |
| `pkg/db` | sqlc 的查询（`queries/`）和从它生成的 Go（`generated/`）；配置和生成命令在 `sqlc.yaml` |
| `pkg/ai`、`pkg/agentcore`、`pkg/agent` | VibeValley 自己的 agent：管家用它；`pkg/agent/oarruntime` 把它包成 oar 农机 `vibevalley`，帮工也能用 |
| `pkg/agora` | 声网（Agora）：签令牌、拼语音 agent 的请求；不认识农场 |
| `pkg/weixin`、`pkg/feishu`、`pkg/qq` | 微信、飞书、QQ 机器人的接口：登录、收、发；每个有 `API` 接口（测试换成假的）和真的 `Client`。不认识农场，账号和谁是主人在 `channels` 的桥里 |
| `pkg/smith` | oar 的 Go 移植（[README](pkg/smith/README.md)），驱动各家编码 agent |
| `cmd/vibevalley` | 单独跑的服务端：听 `$HOST:$PORT`（默认 `127.0.0.1:8787`）；环境变量先看已经设了的，再看 `--env-file` 和 `$VIBEVALLEY_HOME/.env`；`--log 文件` 把日志也追加到文件里。子命令 `migrate`、`import` 见 [server.md](../docs/reference/server.md)「搬家」 |
| `cmd/vibevalley-agent` | VibeValley 自己的 agent 的命令行 |
| `tool` | 开发时的工具，不进产品：`shapegen`（Go）从 `protocol` 的形状写出 `gen.go` 和 Flutter 的 `lib/gen`；两个 Node 脚本（自己的 `package.json`）：`pi-prices.ts` 写 pi 的价目表 `internal/runs/pi_prices.json`，`dump-pglite.ts` 给 `vibevalley import` 倒出旧数据库 |

## 服务

每个服务是一个结构体，在它所属概念的包里（`internal/runs`、`internal/tickets`……）。构造函数 `newX(…)` 的参数就是它用到的服务和配置（多的用带 `fx.In` 的参数结构体，如 `crewIn`、`foremanIn`），存在它自己的字段里；没有服务拿整个 `Farm`。每个包的 `Module`（`func(*base.Readies) fx.Option`）把它的构造函数交给 fx（`go.uber.org/fx`）；`base.App` 把 `base` 和给它的各包装在一个生命周期上：`NewApp` 建，`Start` 开，`Close` 停。`farm.New` 是带全部包的 App（[理由](../.agents/notes/implemented/architecture/2026-10-15-services-assembled-by-fx.md)、[分包](../.agents/notes/implemented/architecture/2026-10-16-a-package-per-concept.md)）。

服务按实际的概念分包（[概念](../docs/concepts.md)）：先是活本身，最后是画在上面的游戏。一个包只 import 表里排在它前面的包，编译器替我们守着；反方向的消息走 `base.Hub[T]`（`base/hub.go`：核心状态的事实、执行的动静、群聊和计划给管家的消息），只送给当时在订阅的，慢的排长队，不丢：

| 包 | 服务 |
|---|---|
| base | 数据库、`Site`（核心状态和它的事实）、`Store`（`config.json`：agent 档案、runtime 的设置、技能）、`Settings`（密钥、语音） |
| projects | `Projects`（仓库、worktree、每个项目同时能有几个执行）、`Codebase` |
| memory | `Memories`、`ManagerMemory`：档案和管家记得的事 |
| runs | `Runtimes`、`Crew`（为工单开的执行：会话、带话和叫醒、同时干活的上限，建在 smith 上）、`Trajectories`（执行的步骤、轨迹头）、`Tokens` |
| chat | `Chat`（群聊：田头、频道、工单串）、`FarmTools`（`/mcp`，执行在群聊里说话用的） |
| tickets | `Issues`（工单）、`Dispatch`（派活、排队、重开工单）、`Merges`（收成清单、收获）、`Playbooks` 和 `PlaybookLog`（计划）、`Schedules`、`Heartbeat`（巡查） |
| manager | `Foreman`（管家） |
| channels | `VoiceLine`、`Voice`、`Connectors`（微信、飞书、QQ）、`Lan`（院门） |
| game | `Ledger`（金币、连胜、成就）、`Commits`（等级）：只听别的包的事实，业务的服务不调它；只有 HTTP 那一层为主人在应用里做的事记账 |

HTTP（`handler`）在最上面，经 `Farm` 用全部服务；`farm` 只组装服务，不认识 HTTP。院门答的那部分 API（`apiMux`）在农场开之前交给 `Lan.API`。

- **生命周期**：服务有 `OnStart(ctx)`（订阅它听的消息、开后台的活）和 `OnStop()`（`base.Service`）。`Module` 里每个构造函数都包一层 `base.Run`，把它们挂到 fx 的生命周期上，所以一个服务总在它用到的服务之后开、之前停，不用手排顺序。有 `OnReady(ctx)` 的，在全部服务都开了以后按同样的顺序调：开机就要发布的活放那里，订阅的都听得到。`Start` 给的 ctx 一直有效，到 `Close` 才取消，后台的活跟着停。
- **加一个服务**：在它所属的包里写结构体，和 `newX(用到的服务…)`、`OnStart`、`OnStop`（需要时加 `OnReady`），在包的 `Module` 里加 `base.Run[*X](r, newX)`，再在 `farm.go` 的 `services` 里加一个字段（`Farm` 上就有了 `f.X`）。只在 `Module` 里、没人要的服务不会被建。依赖成环或缺了谁，`New` 报错；要用排在后面的包，编译就不过：改走 `Hub`，或者想想它是不是放错了包。
- **加一个包**：一个概念一个包，写它的 `Module`，按依赖插进 `farm.go` 的 `layers` 和上表。
- **测试**：单个服务用它的构造函数直接建，只给它要的那几样。要一座农场的，在包自己的测试里用 `newWorld`（`world_test.go`：只带排在前面的包和本包）；跨好几个包的在 `farm` 的测试里用 `New`。换掉其中一样用 `fx.Replace`、`fx.Decorate`，或在 `Start` 之前改服务上留的测试口子（`Runtimes.Probe`、`Schedules.Now`……）。

拒绝是普通的 `error`，文字给主人看；`handler/api.go` 把它变成 `FarmRefused`。

核心状态只经 `Site.Apply(protocol.FactX{…})` 改。数据库是 SQLite（`farm.db`，一个连接，所以 seq 的顺序就是提交的顺序；时间存毫秒），表在 `migrations/`；工单的查询由 sqlc 生成（`pkg/db`），别的服务直接写 SQL。

## 形状和规则从哪来

形状和规则都只在这里的 `protocol` 包（[理由](../.agents/notes/implemented/architecture/2026-10-15-go-owns-the-shapes.md)）。形状写在 `shapes.go`：结构体、`type X string` 加常量的枚举、带标签的联合（`//vibevalley:union` 和成员上的 `//vibevalley:member`）、接口的错误（`//vibevalley:error`）；接口写在 `api.go` 的 `Handlers` 里，每个方法带 `//vibevalley:route`。改了它们跑：

```bash
go run ./tool/shapegen          # 写 protocol/gen.go 和 ../app/lib/gen/vibevalley.dart；-check 只查是不是最新
```

可选的字段写 `omitzero`；能是 null 的写成指针，切片、表、联合写不成指针的加 `vibevalley:"null"`；别的必填的切片和表，空的时候写成 `[]`、`{}`（客户端的解码不收 null）。种子数据（`seeds.json`）直接改。

规则的测试有两种：直接写的（`chat_rules_test.go`、`playbook_rules_test.go`……），和黄金数据（`internal/protocol/testdata/*.jsonl.gz`：成千上万条带种子的随机输入和规则的结果）。`internal/protocol/golden_test.go` 逐条比；有意改了规则，`go test ./internal/protocol -update` 用 Go 的结果重写，再看 diff 是不是只改了该改的。Flutter 解码测试用的那一帧 `app/schema/site-frame.sample.json`、`Pick` 的 Dart 移植的对照 `app/schema/recall.sample.json`（一组固定的用例和 Go 挑的结果）也由它写。声网请求的对照 `internal/channels/testdata/voice-requests.json` 是手写的：改了 `Voice` 就手改它。

## 取舍

- **写错的环境变量**（`VIBEVALLEY_VOICE_MODEL`、`VIBEVALLEY_NOTICE_BATCH_MS`、`VIBEVALLEY_RETRY_WAKE_MS`、`VIBEVALLEY_FOREMAN_RUNTIME` 不认识的值）用默认值，不让服务端起不来；变量的清单见 [architecture.md](../docs/architecture.md)「环境变量」。
- **端口被占**：语音线路的端口被占时只记一行日志（[voice.md](../docs/reference/voice.md)），院门的写进院门的状态（[server.md](../docs/reference/server.md)「院门」），农场照常。
- **字数上限**：VibeValley 自己的 agent 里的（管家的 `MEMORY.md` 尾巴、工具结果的截断）按字符数；`protocol` 和服务里给人看的文字按 UTF-16 码元量（`base.Units`、`base.Slice`）。
- **农机**：pi 要 Node（smith 用内嵌的 Node 宿主跑 pi 的 SDK），cursor 接不上（smith 没有 JS 宿主），见 [agents-and-runtimes.md](../docs/reference/agents-and-runtimes.md) 和 [smith 的 GAPS](pkg/smith/GAPS.md)。

## 测试

```bash
go vet ./... && go test ./...
```

不连网、不花钱：帮工由 smith 的 `oartest` 扮演，项目用真的 git 仓库，模型用 `ai.FauxProvider`，声网、飞书、QQ、微信是本地的假服务；测试里 `Runtimes` 不探测本机的农机，管家没给模型时不出声。smith 的测试也在这个模块里，`go test ./...` 一起跑（smith 那部分约一分半）。
