# server：VibeValley 的服务端

VibeValley 唯一的服务端：答 VibeValleyApi、`/api/site/events`、`/api/site/state` 和 `/mcp`，给 Flutter 客户端。`farm` 是一个库，`cmd/vibevalley` 单独跑它；Flutter 的 macOS 应用把 `cmd/vibevalley` 编进应用、开机拉起（[desktop.md](../docs/desktop.md)）。行为见 [docs/server.md](../docs/server.md)；为什么用 Go、建在 smith 上见 [服务端用 Go 重写](../.agents/notes/implemented/architecture/2026-10-13-go-server-on-smith.md)。

Go 模块 `vibevalley`，Go 1.27.2，不用 cgo。

## 目录

一个 Go 模块 `vibevalley`：`internal/` 是只给本模块用的（农场的服务和协议），`pkg/` 是能单独拿去用的库（smith 和 VibeValley 自己的 agent），`cmd/` 是命令，`tool/` 是开发时的工具。

| 包 | 管什么 |
|---|---|
| `internal/protocol` | 形状和接口的唯一来源（`shapes.go`、`api.go` 里每个接口一个方法的 `Handlers`）和从它们生成的 `gen.go`（`Mount`、联合的编解码和成员表）；核心状态的规则（只有这一份）：`Reduce`、`EffectsOf`、`ViewOf`，聊天、计划、进度、定时、巡视、记性、额度、阶段的纯函数；`seeds.json`（种子档案、默认设置、农机的外形和能力） |
| `internal/base`、`projects`、`memory`、`runs`、`chat`、`tickets`、`manager`、`channels`、`game` | 服务，一个概念一个包（见「服务」）；`base` 还有大家共用的：数据库、`Site`（核心状态和事件流）、`Hub`、`Config`，和生命周期（`App`、`Run`） |
| `internal/farm` | 把全部包组装成农场（`farm.go`：`Farm` 握着全部服务）；`vibevalley import` 和 `migrate` 的搬家 |
| `internal/handler` | 全部 HTTP 处理：`VibeValleyApi`（`api.go`，每个处理只转给拥有它的服务）、工地事件流和状态流、`/mcp`；`New` 是全部，`apiMux` 是院门放过去的那部分 |
| `internal/farmtest` | 服务的测试共用的：比较、等待、一次性的 git 仓库、种子里的 pi 档案；只给测试 import |
| `pkg/ai`、`pkg/agentcore`、`pkg/agent` | VibeValley 自己的 agent（从已删的 TypeScript 包 `@heybro/ai`、`agent-core`、`agent` 移植）：管家用它，VibeValley 农机也是它 |
| `pkg/agora` | 声网（Agora）：签 RTC + RTM 令牌、用 agentkit 拼语音 agent（听法、字幕走 RTM 还是 data stream、会说话的大模型）、请它离开时「已经在走」算成功；不认识农场，用哪几家服务、说什么由调用的人给 |
| `pkg/weixin`、`pkg/feishu`、`pkg/qq` | 微信（腾讯 iLink）、飞书（扫码建应用、官方 SDK 的长连接）、QQ 机器人（网关、被动回复）的接口：登录、收、发、从消息里读出字；每个有 `API` 接口（测试换成脚本扮演的）和真的 `Client`。不认识农场：账号怎么存、谁是主人、发件表都在 `channels` 的桥里 |
| `pkg/agent/oarruntime` | VibeValley 自己的 agent 作为 oar 农机 `vibevalley` |
| `pkg/smith` | oar 的 Go 移植（[README](pkg/smith/README.md)），驱动各家编码 agent；带它自己的 `internal/` 和命令行 `cmd/oar`、`cmd/oar-bridge`；`testdata` 是从 oar 仓库带来的假 agent 和回放记录 |
| `cmd/vibevalley` | 单独跑的服务端（`vibevalley migrate` 把旧名字下的农场迁过来，见 [server.md](../docs/server.md)「搬家」）：`$HOST:$PORT`（默认 `127.0.0.1:8787`）；环境变量先看已经设了的，再看 `--env-file` 和 `$VIBEVALLEY_HOME/.env`；`--log 文件` 把日志也追加到文件里；`vibevalley import` 搬家（见下） |
| `cmd/vibevalley-agent` | VibeValley 自己的 agent 的命令行 |
| `tool` | 开发时的工具，不进产品：`shapegen`（Go）从 `protocol` 的形状写出 `gen.go` 和 Flutter 的 `lib/gen`；两个 Node 脚本（自己的 `package.json`）：`dump-pglite.ts` 倒出 TypeScript 服务端留下的数据库给 `vibevalley import`，`pi-prices.ts` 写 pi 的价目表 |

## 服务

每个服务是一个结构体，在它所属概念的包里（`internal/runs`、`internal/tickets`……）。构造函数 `newX(…)` 的参数就是它用到的服务和配置（多的用带 `fx.In` 的参数结构体，如 `crewIn`、`foremanIn`），存在它自己的字段里；没有服务拿整个 `Farm`。每个包的 `Module` 把它的构造函数交给 fx（`go.uber.org/fx`）；`base.App` 把 `base` 和给它的各包装在一个生命周期上：`NewApp` 建，`Start` 开，`Close` 停。`farm.New` 是带全部包的 App（[理由](../.agents/notes/implemented/architecture/2026-10-15-services-assembled-by-fx.md)、[分包](../.agents/notes/implemented/architecture/2026-10-16-a-package-per-concept.md)）。

服务按实际的概念分包（[概念](../docs/concepts.md)）：先是活本身，最后是画在上面的游戏。一个包只 import 表里排在它前面的包，编译器替我们守着；反方向的消息走 `base.Hub[T]`（核心状态的事实、执行的动静、群聊和计划给管家的消息），只送给当时在订阅的，慢的排长队，不丢：

| 包 | 服务 |
|---|---|
| base | 数据库、`Site`（核心状态和它的事实）、`Store`（`config.json`：agent 档案、runtime 的设置、技能）、`Settings`（密钥、语音） |
| projects | `Projects`（仓库、worktree、每个项目同时能有几个执行）、`Codebase` |
| memory | `Memories`、`ManagerMemory`：档案和管家记得的事 |
| runs | `Runtimes`、`Crew`（为工单开的执行：会话、带话和叫醒、同时干活的上限，建在 smith 上）、`Trajectories`（执行的步骤、工单的头）、`Tokens` |
| chat | `Chat`（群聊：广场、频道、工单串）、`FarmTools`（`/mcp`，执行在群聊里说话用的） |
| tickets | `Dispatch`（派活、重开工单）、`Merges`（收成清单、收获）、`Issues`（工单）、`Playbooks` 和 `PlaybookLog`（计划）、`Schedules`、`Heartbeat`（巡查） |
| manager | `Foreman`（管家） |
| channels | `VoiceLine`、`Voice`、`Connectors`（微信、飞书、QQ）、`Lan`（院门） |
| game | `Ledger`（金币、连胜、成就）、`Commits`（等级）：只听别的包的事实，业务的服务不调它；只有 HTTP 那一层为主人在应用里做的事记账 |

HTTP（`handler`）在最上面，经 `Farm` 用全部服务。院门要答 API，API 又要答院门自己的页面，所以农场建好以后、开之前，`handler.New` 把 `apiMux` 交给 `Lan.API`。

- **生命周期**：服务有 `OnStart(ctx)`（订阅它听的消息、开后台的活）和 `OnStop()`（`base.Service`）。`Module` 里每个构造函数都包一层 `base.Run`，把它们挂到 fx 的生命周期上，所以一个服务总在它用到的服务之后开、之前停，不用手排顺序。有 `OnReady(ctx)` 的，在全部服务都开了以后按同样的顺序调：开机就要发布的活放那里，订阅的都听得到。`Start` 给的 ctx 一直有效，到 `Close` 才取消，后台的活跟着停。
- **加一个服务**：在它所属的包里写结构体，和 `newX(用到的服务…)`、`OnStart`、`OnStop`（需要时加 `OnReady`），在包的 `Module` 里加 `base.Run[*X](r, newX)`，再在 `farm.go` 的 `services` 里加一个字段（`Farm` 上就有了 `f.X`）。只在 `Module` 里、没人要的服务不会被建。依赖成环或缺了谁，`New` 报错；要用排在后面的包，编译就不过：改走 `Hub`，或者想想它是不是放错了包。
- **加一个包**：一个概念一个包，写它的 `Module`，按依赖插进 `farm.go` 的 `layers` 和上表。
- **测试**：单个服务用它的构造函数直接建，只给它要的那几样（如 `newCodebase(projects)`）。要一座农场的，在包自己的测试里用 `newWorld`（`world_test.go`：`base.App` 带上排在前面的包和本包，不带后面的），所以测试也只碰得到它下面的东西；`tickets` 的 `newWorldWith` 能多带后面的包（计划的测试要看账本）。跨好几个包的（派帮工、收获、记账一路走下来）在 `farm` 的测试里用 `New`。院门的测试要走整个 API，是 `channels` 目录里的外部测试包 `channels_test`，要碰的内部经 `export_test.go`。换掉其中一样，用 `fx.Replace(…)` 或 `fx.Decorate(…)`；已经有窄接口或测试接口的（田头的 `chatCrew`、计划的 `planCrew`、`Runtimes.Registry`、`Runtimes.Probe`、`Schedules.Now`、`Heartbeat.Now`），建好以后、`Start` 之前改它们的字段也行。

拒绝是普通的 `error`，文字给主人看；`handler/api.go` 把它变成 `FarmRefused`。

核心状态只经 `Site.Apply(protocol.FactX{…})` 改。数据库是 SQLite（`farm.db`，一个连接，所以 seq 的顺序就是提交的顺序），表在 `migrations/`（启动时按名字顺序跑），查询写在 `pkg/db/queries`、由 sqlc 生成成 `pkg/db/generated`，时间存毫秒。

## 形状和规则从哪来

形状和规则都只在这里的 `protocol` 包（[理由](../.agents/notes/implemented/architecture/2026-10-15-go-owns-the-shapes.md)）。形状写在 `shapes.go`：结构体、`type X string` 加常量的枚举、带标签的联合（`//vibevalley:union` 和成员上的 `//vibevalley:member`）、接口的错误（`//vibevalley:error`）；接口写在 `api.go` 的 `Handlers` 里，每个方法带 `//vibevalley:route`。改了它们跑：

```bash
go run ./tool/shapegen          # 写 protocol/gen.go 和 ../app/lib/gen/vibevalley.dart；-check 只查是不是最新
```

可选的字段写 `omitzero`；能是 null 的写成指针，切片、表、联合写不成指针的加 `vibevalley:"null"`；别的必填的切片和表，空的时候写成 `[]`、`{}`（客户端的解码不收 null）。种子数据（`seeds.json`）直接改。

规则的测试有两种：直接写的（`chat_rules_test.go`、`playbook_rules_test.go`……），和黄金数据（`internal/protocol/testdata/*.jsonl.gz`：成千上万条带种子的随机输入和规则的结果，由当年的 TypeScript 规则写下，Go 的规则从那份移植）。`internal/protocol/golden_test.go` 逐条比；有意改了规则，`go test ./internal/protocol -update` 用 Go 的结果重写，再看 diff 是不是只改了该改的。Flutter 解码测试用的那一帧 `app/schema/site-frame.sample.json`、`Pick` 的 Dart 移植的对照 `app/schema/recall.sample.json`（一组固定的用例和 Go 挑的结果）也由它写。声网请求的对照 `internal/channels/testdata/voice-requests.json` 是手写的：改了 `Voice` 就手改它。

## 取舍

- **管家只跑在 VibeValley 自己的 agent 上**：`VIBEVALLEY_FOREMAN_RUNTIME=pi` 会被拒绝。
- **pi 农机要 Node**：smith 用一个内嵌的 Node 宿主跑 pi 的 SDK；用 claude、codex、VibeValley 等农机的帮工不需要。
- **pi 的价目表** 是 pi-ai 内置的那份（`internal/runs/pi_prices.json`），不含 pi 配置里自加的模型。
- **语音线路的端口被占** 时只记一行日志，其余照常；院门的端口被占时同样，原因写在院门的状态里。
- **没有 cursor 农机**：oar 默认的农机里本来就不带它，smith 也没有 JS 宿主。
- **数据库** 是 SQLite 文件 `$VIBEVALLEY_HOME/farm.db`；`VIBEVALLEY_DB` 给的是文件夹时用里面的 `farm.db`，`memory` 只在内存里。
- **写错的环境变量**（`VIBEVALLEY_VOICE_MODEL`、`VIBEVALLEY_NOTICE_BATCH_MS`、`VIBEVALLEY_RETRY_WAKE_MS`、`VIBEVALLEY_FOREMAN_RUNTIME` 不认识的值）用默认值，不让服务端起不来。
- **语音令牌** 从签发起一小时过期，到期前用 `/api/voice/renew` 续（[voice.md](../docs/voice.md)）。
- **字数上限**（管家的 MEMORY.md 尾巴、工具结果的截断）按字符数；移植来的规则里给人看的文字按 UTF-16 码元量，和当年 TypeScript 的那份一样。

## 从 TypeScript 服务端搬家

已删的 TypeScript 服务端留下的家（默认 `~/.heybro`，当年 Electron 桌面版的 alpha、beta 是 `~/.heybro-alpha`、`~/.heybro-beta`：那时这个项目还叫 heybro）里的文件和这里的一样，照搬；数据库是 PGlite，只有 Node 打得开，先倒成 JSON 再导进 SQLite。两步都不改原来的家，原来的服务端开着也能倒（倒的是数据库的一份拷贝）；导的时候 Go 服务端要停着。

```bash
(cd server/tool && npm install)                                  # 带 @electric-sql/pglite
node server/tool/dump-pglite.ts ~/.heybro /tmp/heybro-dump.json
cd server && go run ./cmd/vibevalley import ~/.heybro --into ~/Library/Application\ Support/vibevalley --dump /tmp/heybro-dump.json
```

- 拷过去的：`db/` 以外的一切（`farm.json`、`config.json`、`crew.json`、`spend.json`、`settings.json`、`.env`、`foreman/`、`steps/`、`logs/`……），文件权限照旧。
- 每张表的行原样进 `farm.db`：id、seq 不变，自增从 PostgreSQL 的序列停下的地方接着走，串、已读、投递和连接器的发件箱都还对得上；时间变成毫秒，JSON 存成文本，布尔变成 0/1。
- `--into` 已经有农场（有消息、账本、记性、定时、计划、连接器，或者 `farm.json` 里有帮工和收获）就不导，加 `--force` 才换掉它的数据库、盖掉同名文件。
- 只打印表名和行数，不打印内容：倒出来的 JSON 里有连接器的密钥，用完删掉。
- 管家跑在 pi 上时的会话 `manager/` 照拷，这里不读（管家只跑在 VibeValley 自己的 agent 上）。

## 测试

```bash
go vet ./... && go test ./...
```

不连网、不花钱：帮工由 smith 的 `oartest` 扮演，项目用真的 git 仓库，模型用 `ai.FauxProvider`，声网、飞书、QQ、微信是本地的假服务；测试里 `Runtimes` 不探测本机的农机，管家没给模型时不出声。smith 的测试也在这个模块里，`go test ./...` 一起跑（smith 那部分约一分半）。
