# AGENTS.md

VibeValley 是 AI 版的 Linear，一个在本机管编码 agent 的工作台，和 Multica 是一类东西：工单派给 agent 档案，服务端为它开一次执行（smith 的子 agent，smith 是 oar 的 Go 移植），在 `VIBEVALLEY_WORK_ROOT` 下项目的 worktree 里一轮一轮干活，主人看改动、合进主分支；主人、管家（替主人派活的 agent）和执行在群聊里说话。外面画成一座农场：执行是帮工，群聊是田头（[概念](docs/concepts.md)）。仓库是两块加一个官网：服务端 `server/`（Go）、客户端 `app/`（Flutter），和官网 `site/`（Astro）；形状和规则都在 Go 的 `server/internal/protocol`，Flutter 的类型从它生成。改 `server/`、`app/` 之前读 [docs/architecture.md](docs/architecture.md)；写文档照 [docs/AGENTS.md](docs/AGENTS.md)；决策和提案记在 [Agent Notes](.agents/notes/README.md)。

## 目录

```
server/                    服务端，一个 Go 模块 vibevalley；cmd/vibevalley 单独跑它
server/internal/           农场的服务，一个概念一个包：base、projects、memory、runs、chat、tickets、manager、channels、game；
                           farm 把它们组装起来，handler 是全部 HTTP 处理
server/migrations/         SQLite 的迁移，启动时按名字顺序跑；也是 sqlc 读的表结构
server/internal/protocol/  形状（shapes.go、api.go）和规则的唯一来源；tool/shapegen 从它写出 gen.go 和 Flutter 的 lib/gen
server/pkg/                能单独拿去用的库：smith（oar 的 Go 移植，驱动各家编码 agent）、VibeValley 自己的 agent（agent、agentcore、ai）、
                           agora（声网的令牌和语音 agent）、weixin、feishu、qq（三家聊天软件的机器人接口）
server/pkg/db/             查询（queries/*.sql）和 sqlc 从它生成的 Go（generated/）
app/                       客户端（Flutter）：读折好的核心状态，像素村用 Flame；macOS 版把 Go 服务端带在里面
site/                      官网 vibevalley.dev（Astro 静态生成，Tailwind，会动的部分是 React island）：图和像素字直接用 app/assets 的
design/                    生图提示词、脚本和切图规则；原图和效果图在单独的仓库 vibevalley-art，design/art.sh 链接进来
docs/                      当前的行为和约定（docs/AGENTS.md）
.agents/notes/             Agent Notes：决策和提案
scripts/                   文档和 Note 的检查
```

每个包的约定在它的 README。

## 命令

```bash
cd server && go run ./cmd/vibevalley                                # 服务端，127.0.0.1:8787
cd server && go vet ./... && go test ./...                      # 改完服务端
cd server && go run ./tool/shapegen                             # 改完 protocol/shapes.go 或 api.go：重写 gen.go 和 Flutter 的 lib/gen
cd server && GOTOOLCHAIN=go1.27.2 go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate   # 改完 pkg/db/queries 或 migrations：重写 pkg/db/generated
cd server && go test ./internal/protocol -update                         # 有意改了规则：用 Go 的结果重写黄金数据，再看 diff
cd app && flutter run -d macos --dart-define=VIBEVALLEY_SERVER=http://127.0.0.1:8787   # 客户端连开着的服务端
bun run flutter:check                                           # 改完 app 或形状：生成的是否最新、analyze、test
bun run package:mac                                             # macOS 应用（带 Go 服务端）和 .dmg；--channel alpha|beta 见 app/README.md
bun run notes:catalog                                           # 加、挪、删 Note 或改了标题：重写 .agents/notes/CATALOG.md
bun run docs:verify                                             # 改完文档或 Note：Note 的格式、目录是否最新、链接
bun run site:check && bun run site:build                       # 改完 site/：类型和模板，再生成到 site/dist（不开 astro dev）
```

Go 1.27，Flutter 3.47，Bun 1.4（根目录的命令、文档和 Note 的检查），Node 24（只跑 `server/tool` 的两个脚本）。先跑和改动有关的最窄的检查。服务端不自动重载：改了 `server/` 要重启它。

一件事的主线：smith 的会话事件 → `internal/runs/facts.go`（纯函数）读成事实和步骤 → `Site.Apply` 用 `protocol.Reduce` 折进核心状态 → `GET /api/site/state` 把折好的 `SiteFrame` 经 SSE 推给 Flutter；步骤由 `runs/steps.go`、`runs/trajectories.go` 记成每个帮工和管家的轨迹（[architecture.md](docs/architecture.md)、[server.md](docs/server.md)）。

## 规矩

- **先有概念，再有皮**：服务端按实际的概念分模块（工单、执行、项目、群聊……，[概念](docs/concepts.md)）；农场只画它们，每个农场里的东西都对得上一件实际的事；游戏规则只读事件、算画面，业务不调它（[提案](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)）。
- **核心状态只有一份**：帮工或农场的新状态，在 Go 的 `internal/protocol/shapes.go` 里加字段或事实，在 `internal/protocol/farm.go` 里折，只由服务端 `Site.Apply` 施加。不要在服务端、客户端里另存一份帮工的状态（[理由](.agents/notes/implemented/architecture/2026-10-11-farm-core-state.md)）。
- **形状和规则只在 Go**：形状写在 `server/internal/protocol/shapes.go`、接口写在 `api.go`，规则是同一个包里的纯函数；改了形状，同一个改动里跑 `go run ./tool/shapegen`；有意改了规则，`go test ./internal/protocol -update` 重写黄金数据（[server](server/README.md#形状和规则从哪来)、[理由](.agents/notes/implemented/architecture/2026-10-15-go-owns-the-shapes.md)）。
- **生成的不手改**：`internal/protocol/gen.go` 和 Flutter 的 `lib/gen/` 由 `tool/shapegen` 写，`bun run flutter:check` 查它们是不是最新；`pkg/db/generated` 由 sqlc 写（[理由](.agents/notes/implemented/architecture/2026-10-15-sqlc-queries.md)）。
- **表名用单数**：`issue`、`issue_run`；老的复数表改到时在迁移里改名，查询一起搬进 sqlc。
- **Flutter 不折事实**：它读 `GET /api/site/state` 折好的 `FarmState`；要新的数据就加进 protocol 的字段和 `Reduce`，Dart 里只写跟着时钟走的画面（[理由](.agents/notes/implemented/architecture/2026-10-13-flutter-client-over-ts-server.md)）。
- **封闭的联合穷尽处理**：要每种都处理的地方（按 `_tag` 或 `type` 分支），`switch` 覆盖每一种，加新成员时让编译器或测试报错：Dart 的 sealed class 由编译器查；Go 的编译器不查类型 `switch`，用生成的成员表（`XMembers`）写测试。
- **服务端的服务**：一个服务是它所属概念的包（`internal/runs`、`internal/tickets`……）里的一个结构体，构造函数的参数是它用到的服务（不拿整个 `Farm`），在包的 `Module` 里用 `base.Run` 交给 fx，再加进 `farm.go` 的 `services`；包只 import 排在它前面的包，往上走 `base.Hub`；`OnStart(ctx)` 订阅和开后台的活，开机就要发布的放 `OnReady(ctx)`（[server](server/README.md#服务)）。
- **处理函数要薄**：HTTP 处理（`internal/handler`）和界面（Flutter 的页面）只做转发和展示，规则在拥有它的服务或纯函数里。
- **帮工没有权限确认**：服务端只听 127.0.0.1，永远不要对外；帮工只在工作目录里开工（[理由](.agents/notes/implemented/architecture/2026-10-10-helpers-as-oar-subagents.md)）。例外只有两个，都是单独的监听：语音线路只有一个接口、每通电话一把钥匙，经隧道给声网（[理由](.agents/notes/implemented/feature/2026-10-10-voice-through-our-manager.md)）；院门默认关着，只放主人在本机点过头的设备、每台一把钥匙，不放 `/mcp`（[理由](.agents/notes/implemented/feature/2026-10-14-yard-gate.md)）。
- **图标是像素素材**：界面上的按钮图标用 `design/pixel` 生成的贴图（形状照 Hugeicons：`icons/ref.py`、`gen.sh`、`process.py`），不用 ▶、■ 这类字符代替（[流程](.agents/notes/implemented/process/2026-10-09-image-pipeline-with-codex.md)）。
- **密钥**：`.env`（`$VIBEVALLEY_HOME/.env` 或 `--env-file` 给的）、`.agora/` 不进仓库；日志和文档里不出现密钥。
- **工具链**：Go 用 `gofmt`、`go vet`，Dart 用 `dart format`、`flutter analyze`；`scripts/` 的检查用 Bun 跑，`server/tool/` 的两个脚本用 Node 跑，都不带构建。
- **代码风格**：格式交给工具（`gofmt`、`dart format -l 160`），不手调；代码和接口用实际的概念，界面上的字用中文、用农场的叫法（[用语表](docs/README.md#用语)）；注释用英文，只写不看就会写错或改错的：为什么、顺序和锁、安全边界、格式和取值、要和别处保持一致的，不复述代码、不写概述和历史（[建议和不建议的写法](docs/code-style.md)）。
- **测试**：服务端的测试用 smith 的 `oartest` 扮演帮工、用真的 git 仓库、模型用 `ai.FauxProvider`，不连网；纯函数的规则直接测；Flutter 用 `flutter test`（服务端用 `MockClient` 假的）。改了帮工、项目、收获、核心状态或游戏规则的行为，补对应的测试。
- **文档和 Note**：改了行为就在同一个改动里改文档；非平凡的决策（行为、模块边界、共享约定、持久化格式、流程、测试策略）新增或更新它的 Note；局部的、机械的改动和界面微调不用写（[规矩](.agents/notes/README.md#什么时候写)）。

## 编辑本文

`CLAUDE.md` 只有一行 `@AGENTS.md`，引用本文；规矩都改在本文。每条规矩自成一句，细节链接到它的家。
