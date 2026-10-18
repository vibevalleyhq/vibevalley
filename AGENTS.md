# AGENTS.md

VibeValley 是 AI 版的 Linear，一个在本机管编码 agent 的工作台，和 Multica 是一类东西：工单派给 agent 档案，服务端为它开一次执行（smith 的子 agent，smith 是 oar 的 Go 移植），在 `VIBEVALLEY_WORK_ROOT` 下项目的 worktree 里一轮一轮干活，主人看改动、合进主分支；主人、管家（替主人派活的 agent）和执行在群聊里说话。外面画成一座农场：项目是岛，在做的工单是一块地，执行是在地上干活的帮工，群聊是田头（[概念](docs/concepts.md)）。仓库是两块加一个官网：服务端 `server/`（Go）、客户端 `app/`（Flutter），和官网 `site/`（Astro）；形状和规则都在 Go 的 `server/internal/protocol`，Flutter 的类型从它生成。改 `server/`、`app/` 之前读 [docs/architecture.md](docs/architecture.md)；写文档照 [docs/AGENTS.md](docs/AGENTS.md) 和 [docs/style/writing.md](docs/style/writing.md)；子系统沉淀在 [docs/subsystems](docs/subsystems/README.md)，计划写成 [Agent Notes](.agents/notes/README.md)。

## 目录

```
server/                    服务端，一个 Go 模块 vibevalley；cmd/server 单独跑它，cmd/vibevalley 是命令行（农场的每个接口、和农机直接聊、自己的 agent），cmd/migrate 管表结构
server/internal/           农场的服务，一块业务一个包，名字用单数，每个包只导出一个 Service：core、setting、agent、project、
                           memory、runtime、session、channel、schedule、issue、task、tool、manager、gate、voice、connector、game；
                           agent 的子包 brain 是 VibeValley 自己的 agent，task 的子包 engine 是任务图的引擎；base 是地基，workspace 把它们组装起来，handler 是全部 HTTP 处理，mcp 把 tool 里的工具交给编码 agent
server/migrations/         SQLite 的表结构：一个基线 0001_schema.sql，直接改它；也是 sqlc 读的表结构
server/internal/protocol/  形状（shapes.go、api.go）和规则的唯一来源；tool/shapegen 从它写出 gen.go 和 Flutter 的 lib/gen
server/pkg/                能单独拿去用的库：x（通用的小封装：str 字符串、num 数字、ptr 指针、clock 时间）、smith（oar 的 Go 移植，驱动各家编码 agent）、agent 的底层（agentcore 循环、ai 调模型）、
                           agora（声网的令牌和语音 agent）、weixin、feishu、qq（三家聊天软件的机器人接口）
server/pkg/db/             查询（queries/*.sql）和 sqlc 从它生成的 Go（generated/）
app/                       客户端（Flutter）：读折好的核心状态，像素村用 Flame；macOS 版把 Go 服务端带在里面
site/                      官网 vibevalley.dev（Astro 静态生成，Tailwind，会动的部分是 React island）：图和像素字直接用 app/assets 的
design/                    生图提示词、脚本和切图规则；原图和效果图在单独的仓库 vibevalley-art，design/art.sh 链接进来
docs/                      当前的行为和约定；subsystems/ 是各子系统从架构角度沉淀下来的样子（docs/AGENTS.md）
.agents/notes/             Agent Notes：具体的计划，做完沉淀进 docs/subsystems
.agents/skills/            项目自己的 skill，多是验证 skill（verify-*）；.claude/skills 链接到这里
scripts/                   文档和 Note 的检查
```

每个包的约定在它的 README。

## 命令

```bash
cd server && go run ./cmd/server                                # 服务端，127.0.0.1:8787
cd server && go run ./cmd/vibevalley issue list                 # 命令行：调农场的接口（help 列出全部），runtime chat <农机> 直接聊，oar <命令> 是 smith 的 oar 命令行
cd server && go run ./cmd/migrate status                        # 库在第几版；up 跑迁移（开机也会跑）；改了 0001_schema.sql 就删掉本机的库重建
cd server && go vet ./... && go test ./...                      # 改完服务端
bun run go:deadcode                                             # 改完服务端：server/internal 里没有只靠测试活着的函数
cd server && go run ./tool/shapegen                             # 改完 protocol/shapes.go 或 api.go：重写 gen.go 和 Flutter 的 lib/gen
cd server && GOTOOLCHAIN=go1.27.2 go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate   # 改完 pkg/db/queries 或 migrations：重写 pkg/db/generated
cd server && VIBEVALLEY_GOLDEN=update go test ./internal/...           # 有意改了规则：用 Go 的结果重写各包的黄金数据，再看 diff
cd server && go test -tags evals -run TestManagerEvalsLive -count=1 -v ./internal/manager   # 改了管家的提示或工具描述：真模型重放管家的样例（要 DEEPSEEK_API_KEY、花钱，先问主人；verify-manager-evals）
cd app && flutter run -d macos --dart-define=VIBEVALLEY_SERVER=http://127.0.0.1:8787   # 客户端连开着的服务端
bun run flutter:check                                           # 改完 app 或形状：生成的是否最新、analyze、test、import 分层
bun run app:imports                                             # 改完 app/lib 的 import：只能往下一层走（flutter:check 也跑）
bun run package:mac                                             # macOS 应用（带 Go 服务端）和 .dmg；--channel alpha|beta 见 app/README.md
bun run notes:catalog                                           # 加、挪、删 Note 或改了标题：重写 .agents/notes/CATALOG.md
bun run docs:verify                                             # 改完文档、Note 或 skill：Note 和 skill 的格式、目录是否最新、链接
bun run site:check && bun run site:build                       # 改完 site/：类型和模板，再生成到 site/dist（不开 astro dev）
```

Go 1.27，Flutter 3.47，Bun 1.4（根目录的命令、文档和 Note 的检查），Node 24（只跑 `server/tool` 的 `pi-prices.ts`）。先跑和改动有关的最窄的检查。服务端不自动重载：改了 `server/` 要重启它。

一件事的主线：smith 的会话事件 → `internal/session/facts.go`（纯函数）读成事实和事件 → `Core.Apply` 用 `protocol.Reduce` 折进核心状态 → `GET /api/v1/state` 把折好的 `StateFrame` 经 SSE 推给 Flutter；事件由 `session/events.go`、`session/trajectories.go` 记成每个 Session 和管家的日志（[architecture.md](docs/architecture.md)、[server.md](docs/reference/server.md)）。

## 怎么让 agent 做对

agent 照着已有的代码抄，走最短的路，所以要让容易的写法就是对的写法。挡住一类问题，按下面的顺序选手段，能用前面的就不用后面的（[理由](.agents/notes/implemented/process/2026-10-17-make-the-easy-thing-the-right-thing.md)）：

1. **代码**：更好的结构、更强的类型和不变量、清楚的边界；用代码把一类问题整个消掉，以后不用再想它。
2. **静态检查**：lint 规则、测试、CI、形式化验证（如 TLA+）；花的 token 最少，问题在落地前就报出来。
3. **文字**：注释、规矩、本文、skill，只写没法强制、要 agent 自己判断的；能少写就少写。只有跑起来才看得出对不对的，写成验证 skill（[.agents/skills](.agents/skills/README.md)，照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) 写）。
4. **人看**：最难扩展。agent 落代码太快，每个 PR 都细看做不到；人的精力花在杠杆最大的地方：设计让 agent 默认就做对的环境。

一条新规矩，先问能不能写成代码或检查；只有写不成的，才进下面的列表。

## 规矩

- **先有概念，再有皮**：服务端按实际的概念分模块（工单、执行、项目、群聊……，[概念](docs/concepts.md)）；农场只画它们，每个农场里的东西都对得上一件实际的事；游戏规则只读事件、算画面，业务不调它（[提案](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)）。
- **核心状态只有一份**：帮工或农场的新状态，在 Go 的 `internal/protocol/shapes.go` 里加字段或事实，在 `internal/protocol/core.go` 里折，只由服务端 `Core.Apply` 施加。不要在服务端、客户端里另存一份帮工的状态（[理由](.agents/notes/implemented/architecture/2026-10-11-farm-core-state.md)）。
- **形状和规则只在 Go**：形状写在 `server/internal/protocol/shapes.go`、接口写在 `api.go`；核心状态的折法和它用到的、几个包都用的规则是 `protocol` 里的纯函数，只有一个主人的规则是主人包里不导出的纯函数，黄金数据（`testdata/*.jsonl.gz`，经 `internal/golden`）跟着规则走（[理由](.agents/notes/implemented/architecture/2026-10-16-rules-live-with-their-owner.md)）；改了形状，同一个改动里跑 `go run ./tool/shapegen`；有意改了规则，`VIBEVALLEY_GOLDEN=update go test ./internal/...` 重写黄金数据（[server](server/README.md#形状和规则从哪来)、[理由](.agents/notes/implemented/architecture/2026-10-15-go-owns-the-shapes.md)）。
- **生成的不手改**：`internal/protocol/gen.go` 和 Flutter 的 `lib/gen/` 由 `tool/shapegen` 写，`bun run flutter:check` 查它们是不是最新；`pkg/db/generated` 由 sqlc 写（[理由](.agents/notes/implemented/architecture/2026-10-15-sqlc-queries.md)）。
- **表名是「模块_概念」**：单数，`<模块>` 或 `<模块>_<概念>`，模块是拥有它的 `server/internal` 包（`issue`、`issue_session`、`channel_message`、`session_run`）；索引以表名开头；SQL 只写在 `pkg/db/queries/<表>.sql`，一张表一个文件，Go 里只调 sqlc 生成的；`migrations` 的测试查这几条（[理由](.agents/notes/implemented/architecture/2026-10-17-names-by-module.md)）。
- **不留兼容**：架构还在成形，不为兼容少走一步：改名、改形状、改存盘的格式（`vibevalley.db` 的表、家目录的文件、环境变量、存下的取值）都直接改，不写兼容层，不在读的地方兜底旧数据，也不写数据搬运；表结构直接改 `server/migrations/0001_schema.sql`，不另加迁移（`migrations` 的测试查这条），本机的旧库和旧文件作废，删掉重建；启动时只认今天的名字（[理由](.agents/notes/implemented/architecture/2026-10-16-one-schema-no-old-data.md)）。
- **Flutter 不折事实**：它读 `GET /api/v1/state` 折好的 `CoreState`；要新的数据就加进 protocol 的字段和 `Reduce`，Dart 里只写跟着时钟走的画面；服务端的规则（能不能派、下回想起什么、冲突怎么交代）不在 Dart 里重写，加一个字段或接口问服务端（[理由](.agents/notes/implemented/architecture/2026-10-13-flutter-client-over-ts-server.md)、[客户端问服务端](.agents/notes/implemented/architecture/2026-10-16-the-client-asks-the-server.md)）。
- **客户端分层**：`gen`、`sprites`、`audio`、`rules`（只读的纯函数）、`ui`、`data`（服务端状态、偏好、界面的选中/面板）、`host`（本机外壳）、`game`（客户端的动作）、`shared`（几张皮共用的画面）、`chat`（田头）、`voice`、`phone`（农场里的手机和小游戏）、`debug`（调试台）在下；`village` 是像素渲染层；`workbench`、`farm` 是两张皮；`app` 只做组合，`shell` 是外壳。依赖只能往下走（次序在 `scripts/app-imports.ts`，`bun run app:imports` 查），皮之间不互相 import，两张都用的放进 `shared`；下层不 import `app`（[理由](.agents/notes/implemented/architecture/2026-10-16-client-layers.md)）。
- **通用的小封装在 `pkg/x`**：字符串（按 UTF-16 数、JavaScript 的空白）、数字（照 JavaScript 写）、指针、时间各一个包；要用就 import，不在自己包里再写一份 `xxxPtr`、`chatTrim`（[理由](.agents/notes/implemented/architecture/2026-10-16-common-wrappers-in-pkg-x.md)）。
- **封闭的联合穷尽处理**：要每种都处理的地方（按 `_tag` 或 `type` 分支），`switch` 覆盖每一种，加新成员时让编译器或测试报错：Dart 的 sealed class 由编译器查；Go 的编译器不查类型 `switch`，用生成的成员表（`XMembers`）写测试。
- **服务端的服务**：每个包只导出一个服务 `<包>.Service`，一块业务里分开写的几部分是它嵌入的不导出的零件；`Workspace` 上的字段用单数概念名（`f.Issue.Merge`）。构造函数的参数是它用到的服务（不拿整个 `Workspace`），在包的 `Module` 里用 `base.Run` 交给 fx，再加进 `workspace.go` 的 `services`；包只 import 排在它前面的包，往上走 `base.Hub`；服务之间传的形状放在定义它的包里，`base` 只放地基；`OnStart(ctx)` 订阅和开后台的活，开机就要发布的放 `OnReady(ctx)`（[server](server/README.md#服务)）。
- **处理函数要薄**：HTTP 处理（`internal/handler`）和界面（Flutter 的页面）只做转发和展示，规则在拥有它的服务或纯函数里。
- **帮工没有权限确认**：服务端只听 127.0.0.1，永远不要对外；帮工只在工作目录里开工（[理由](.agents/notes/implemented/architecture/2026-10-10-helpers-as-oar-subagents.md)）。例外只有两个，都是单独的监听：语音线路只有一个接口、每通电话一把钥匙，经隧道给声网（[理由](.agents/notes/implemented/feature/2026-10-10-voice-through-our-manager.md)）；院门默认关着，只放主人在本机点过头的设备、每台一把钥匙，不放 `/mcp`（[理由](.agents/notes/implemented/feature/2026-10-14-yard-gate.md)）。
- **图标是像素素材**：界面上的按钮图标用 `design/pixel` 生成的贴图（形状照 Hugeicons：`icons/ref.py`、`gen.sh`、`process.py`），不用 ▶、■ 这类字符代替（[流程](.agents/notes/implemented/process/2026-10-09-image-pipeline-with-codex.md)）。
- **密钥**：写了钥匙的 `vibevalley.yaml`（`$VIBEVALLEY_HOME/vibevalley.yaml` 或 `--config` 给的）、`.agora/` 不进仓库；日志和文档里不出现密钥。
- **工具链**：Go 用 `gofmt`、`go vet`，Dart 用 `dart format`、`flutter analyze`；`scripts/` 的检查用 Bun 跑，`server/tool/` 的脚本用 Node 跑，都不带构建。
- **代码风格**：格式交给工具（`gofmt`、`dart format -l 160`），不手调；代码和接口用实际的概念，界面上的字用中文、用农场的叫法（[用语表](docs/README.md#用语)）；注释用英文，只写不看就会写错或改错的：为什么、顺序和锁、安全边界、格式和取值、要和别处保持一致的，不复述代码、不写概述和历史（[建议和不建议的写法](docs/style/code.md)）。
- **测试**：服务端的测试用 smith 的 `oartest` 扮演帮工、用真的 git 仓库、模型用 `ai.FauxProvider`，不连网；纯函数的规则直接测；Flutter 用 `flutter test`（服务端用 `MockClient` 假的）。改了帮工、项目、收获、核心状态或游戏规则的行为，补对应的测试。
- **改完要验证**：先跑最窄的检查；改了接口、服务或页面，照对应的验证 skill（`verify-server`、`verify-app`）在真的程序上看一遍，汇报时附上它要的证据；一类改动没有验证 skill，又花了工夫才验证完，就照 `create-verification-skill` 补一个（[.agents/skills](.agents/skills/README.md)）。
- **文档和 Note**：改了行为就在同一个改动里改文档；有子系统文档（`docs/subsystems/`）的，改它，不在 `reference/` 另写一份；非平凡的工作先写计划 Note（行为、模块边界、共享约定、持久化格式、流程、测试策略），做完把仍然成立的沉淀进子系统、删掉 Note；局部的、机械的改动和界面微调不用写（[规矩](.agents/notes/README.md#什么时候写)）。

## 编辑本文

`CLAUDE.md` 只有一行 `@AGENTS.md`，引用本文；规矩都改在本文。每条规矩自成一句，细节链接到它的家。
