# Agent Note: 服务端用 Go 重写，帮工建在 smith 上

Status: implemented

## Problem

服务端（`apps/server`，约九千行 TypeScript，加上管家用的 `@heybro/ai`、`agent-core`、`agent` 约四千行）把管家、帮工（oar）、田头、项目和收获、农机、语音令牌都放在一个 Node 进程里。桌面版要带一份 Node 和整个服务端，手机端更带不了。主人当时要的是**一个 MyGo 就能搞定一切**：一个 Go 进程，窗口（MyGo，WKWebView）、农场、帮工、语音都在里面，不带 Node。

帮工这块原来靠 oar（TypeScript）。smith 是主人自己写的 oar 的 Go 移植，VibeValley 用到的 oar 接口它都有：`createSubagents` 对 `agents.New/Spawn/OnReport/Close`，`stallOf`、`classifyTool`、`failureAdvice` 对 `observe` 包，`createSessionKernel`、`sealSession`、输入拒绝对 `kernel` 包，`scriptedRuntime` 对 `oartest`，运行时注册对 `runtimes/defaults`。

## Decision

服务端是 Go 写的一个库（`server`，模块 `vibevalley`），`cmd/server` 单独跑它；Flutter 的 macOS 应用把 `cmd/server` 编成 `vibevalley-server` 放进应用、开机作为子进程拉起（[客户端迁到 Flutter](2026-10-13-flutter-client-over-ts-server.md)）。对外是原来那一份 HTTP 和 SSE 契约（`VibeValleyApi`、`/api/events`、`/api/state`、`/mcp`），Flutter 连它（冻结的网页当时也连它，后来删了，[网页退役](../simplification/2026-10-14-retire-the-web-page.md)）。TypeScript 的服务端和它独用的 agent 包已经删掉（[一个服务端、一个客户端](../simplification/2026-10-14-one-server-one-client.md)）。说明在 [server/README.md](../../../../server/README.md)。

### 目录

```
server/            Go 模块 vibevalley，不用 cgo
  pkg/smith/               oar 的 Go 移植；testdata 里是从 oar 仓库带来的假 agent 和回放记录
  internal/protocol/       形状（shapes.go、api.go）、核心状态的规则（Reduce、视图、聊天、计划、进度……）
  internal/                服务，一个概念一个包（base、runs、chat、tickets、manager、channels……）；farm 把它们串成一个 Farm，handler 答 HTTP 和 SSE
  pkg/ai、agentcore、agent/  VibeValley 自己的 agent（DeepSeek），管家和 vibevalley 农机用
  cmd/server               单独跑的服务端
  cmd/vibevalley           VibeValley 自己的 agent 的命令行
  cmd/migrate              表结构：看版本、跑迁移、写下一个
  tool/                    shapegen 和两个 Node 脚本（开发时用，产品里没有）
```

smith 原先是单独的模块，后来并进来（[internal 和 pkg](2026-10-15-server-internal-and-pkg.md)）。

### 形状只定义一次

（这一段后来被 [形状的源头是 Go](2026-10-15-go-owns-the-shapes.md) 取代：形状改写在 Go 的 `internal/protocol/shapes.go`，由 `tool/shapegen` 生成其余的。）当时 TypeScript 的 protocol 仍是形状的唯一来源。`tools/export-schemas.ts` 导出 OpenAPI、`site.schema.json`（事实、工地事件、帧、账本）和 `seeds.json`（种子档案、默认设置、农机的外形和能力）；`server/tool/go_types.ts` 生成 `internal/protocol/gen.go`：每个形状一个类型，带标签的联合是一个包着成员的结构体，每个接口是 `Handlers` 里的一个方法，`Mount` 负责解码请求、编码回答和带标签的错误。加一个接口，Go 不实现就编不过。protocol 里每个导出的形状都有 `identifier`，Go 和 Dart 的类型名都由它定。

### 核心状态只有一份

服务端用 Go 的 `Reduce` 折事实，`EffectsOf`、`ViewOf` 推出 `StateFrame` 给 Flutter。（后面这些后来被 [网页退役](../simplification/2026-10-14-retire-the-web-page.md) 取代：网页和 TypeScript 的规则删了，规则只剩 Go 一份，对照数据成了 Go 自己的黄金数据。）当时冻结的网页还用 TypeScript 的 `reduce` 折 `/api/events` 上的事实，两份靠对照测试拦住分歧：`tool/parity.ts` 用 TypeScript 的规则折几千个随机事实（每种事实、在不在场的帮工、超长的中文和表情），Go 的 `reduce_golden_test.go` 逐个比状态、特效和视图，一个字段不同就失败。其余纯规则（聊天、计划、进度、定时、巡视、记性）照同样的办法移植和对照（`tool/rules-parity.ts`、`tool/play-parity.ts`）。

### 服务和持久化

服务是 `farm` 里的结构体，经 `*Farm` 互相找到，`newX(f)` 建、`start(ctx)` 开后台的活、`ready(ctx)` 发开机就要发布的东西、`close()` 停；服务之间的发布订阅用 `Hub[T]`。（服务怎么建、怎么串，后来被 [服务由 fx 组装](2026-10-15-services-assembled-by-fx.md) 取代：构造函数列出用到的服务，不再经 `*Farm` 互相找；服务后来又按概念分成了包，见 [一个概念一个包](2026-10-16-a-package-per-concept.md)。）`state.json`、`config.json` 和家目录里别的文件格式不变；数据库从 PGlite 换成 SQLite（modernc，纯 Go），一个文件 `$VIBEVALLEY_HOME/vibevalley.db`，表照 PG 的迁移折成最后的样子（`migrations/`），时间存毫秒，一个连接。原来的农场当时用 `vibevalley import` 搬过来；这个命令后来删了，存盘只认现在的格式（[只有一份表结构，不认旧数据](2026-10-16-one-schema-no-old-data.md)）。

### 管家和帮工

管家跑在 VibeValley 自己的 agent 上（`ai`、`agentcore`、`agent`，`packages/ai`、`agent-core`、`agent` 的移植），同一个 agent 包成 smith 的农机 `vibevalley`（`pkg/agent/oarruntime`；改名前叫 `heybro`，[改名 VibeValley](../process/2026-10-15-rename-to-vibevalley.md)）。帮工是 smith `agents` 的子会话。

## Alternatives considered

**留在 TypeScript，MyGo 起一个 Node 子进程。** 最省事，但还是要带 Node，主人要的正是不带。

**smith 当外部 Go 模块拉。** smith 是主人自己的，放在 `server/pkg/smith` 和 VibeValley 一起改、一起测。

**Go 类型手写，靠契约测试对齐。** MyGo 原型这么做过（生成样本、动态 JSON）；手写的类型会悄悄漂移，生成的不会。

**网页马上改收 `StateFrame`。** 能立刻去掉第二份 `reduce`，但同时改网页和服务端风险大；先用对照测试守住。网页后来冻结了，没有改。

## Consequences

- 服务端一个 Go 二进制（约 19 MB），不带 Node；`CGO_ENABLED=0` 编得过，Flutter 应用直接带上它。宿主从 MyGo 换成了 Flutter，库的形状不受影响。
- **两份 `reduce`**：只要冻结的网页还在，改核心状态的规则就要两边一起改、重新生成对照数据；对照测试只覆盖随机生成到的情形。（网页后来删了，规则只剩 Go 一份，见 [网页退役](../simplification/2026-10-14-retire-the-web-page.md)。）
- **pi 农机要 Node**：smith 跑 pi 要一个内嵌的 Node 宿主，用 pi 的帮工仍然需要机器上有 Node；VibeValley 自己的农机和 claude、codex 等 CLI 不需要。
- **管家只跑在 VibeValley 自己的 agent 上**：pi 做管家要把 VibeValley 的工具放进 pi 的进程，smith 的 pi 农机没有这个口子；`manager.runtime=pi` 被拒绝（管家在 pi 上那一版随 TypeScript 服务端一起没了）。
- **pi 的价目表** 是 pi-ai 内置的那份（`tool/pi-prices.ts` 导出），不含 pi 配置里自加的模型。
- 和 TypeScript 服务端行为不同的几处（语音线路端口被占只记日志、写错的环境变量用默认值、字数按字符数）列在 [server/README.md](../../../../server/README.md)「取舍」；语音令牌一小时过期见 [voice.md](../../../../docs/reference/voice.md)「服务端」。
- **smith 的测试数据**：`pkg/smith/testdata` 从 oar 仓库拷来，上游改了要手工同步。
- 声网请求的对照（`internal/voice/testdata/voice-requests.json`）是 TypeScript 服务端生成过的一份，现在冻结，Go 的 `Voice` 是唯一的来源。

## Verification

- `go vet ./... && go test ./...`：不连网、不花钱；帮工由 smith 的 `oartest` 扮演，项目用真的 git 仓库，模型用 `ai.FauxProvider`，声网、飞书、QQ、微信是本地的假服务。帮工、项目、收获、田头、计划、管家、连接器、语音线路都有 Go 的测试（`internal/*/*_test.go`）。
- 对照：`internal/protocol/reduce_golden_test.go`、`rules_golden_test.go`、`play_golden_test.go` 逐条比 `testdata/*.jsonl.gz`。当时这份数据由 tools 的 `parity`、`rules-parity`、`play-parity` 用 TypeScript 的规则算出；网页退役以后它成了 Go 自己的黄金数据（[网页退役](../simplification/2026-10-14-retire-the-web-page.md)）。
- 契约：当时 `tools/go-contract.ts` 用网页自己的 TypeScript 客户端调一个正在跑的 Go 服务端，逐个解码回答和事件流；形状改由 Go 写以后两边出自同一份，它删了（[形状的源头是 Go](2026-10-15-go-owns-the-shapes.md)）。
