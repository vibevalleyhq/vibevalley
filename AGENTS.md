# AGENTS.md

VibeValley 是 AI 版的 Linear，一个在本机管编码 agent 的工作台，和 Multica 是一类东西：工单派给 agent 档案，服务端为它派一个帮工（经 Go 运行时 `pkg/oar` 驱动本机的编码 agent），在 `VIBEVALLEY_WORK_ROOT` 下，按档案设置在仓库目录或工单的 worktree 里一轮一轮干活，用户看改动、合进主分支；用户、助手（替用户派活的 agent）和帮工在群聊里说话。外面画成一座农场：仓库是岛，在做的工单是一块地，帮工在地上干活，群聊是田头（[概念](docs/concepts.md)）。后端、桌面壳、命令行与机器节点是 Go（`cmd/*`、`internal/*`、`pkg/*`，SQLite + SQLc，零 CGO）；前端页面 `apps/web`（Solid 2）、手机壳 `apps/mobile`（Expo）与官网 `apps/site`（Solid 2 静态生成）为 TypeScript；前后端跨端契约在 `packages/protocol`，由 `cmd/vibe-tsgen` 与 `scripts/gen/go-contract.ts` 对账。改 `apps/`、`packages/` 之前读 [docs/architecture.md](docs/architecture.md)；写文档照 [docs/AGENTS.md](docs/AGENTS.md) 和 [docs/style/writing.md](docs/style/writing.md)；子系统沉淀在 [docs/subsystems](docs/subsystems/README.md)，计划写成 [Agent Notes](.agents/notes/README.md)。

## 目录

```
cmd/vibe-server/           Go 控制平面服务端（127.0.0.1:8787；--web apps/web/dist 同时提供页面）
cmd/vibe-desktop/          Go 原生桌面壳：内置控制平面服务，打开工作台与农场页面；thin_desktop 构建标签可连独立服务端
cmd/vibe-machine/          Go 远端执行节点守护进程：向控制平面注册执行节点与目录，运行节点上的编码 agent
cmd/vibe/                  Go 命令行（vibe）：照领域模型一条命令一个操作（issue、repo、agent、session、runtime、memory、cron、artifact、worker、channel、pkm、auth、doctor、app、chat、version）
cmd/vibe-tsgen/            Go 协议形状生成器：向 packages/protocol/src/go-contract/ 生成类型并保持与 Go 结构体对账
internal/domain/           Go 业务域模块，按单数概念划分：agent、artifact、attachment、channel、connector、game、gateway、
                           issue、lan、mcp、media、memory、pkm、repo、setting、stack、user、voice、watch；arch_test.go 强制分层与依赖方向
internal/durable/          可恢复 agent 执行循环与调度（含 store/ SQLite 持久化）
internal/machine/          节点执行、worktree/目录挂载、租约与隧道；internal/provider/ 厂商 SSE；internal/vault/ 密钥与代理；internal/config/ 配置
pkg/                       Go 共享底座：db（统一平台 SQLite WAL 池、11 模块迁移与生成绑定）、oar（编码 agent 驱动与回放测试）、chord（实时同步链路与状态差值）、contract（委托契约与 tsgen）、migrate（嵌入迁移器）
apps/web/                  页面（Solid 2 + Vite）：桌面、浏览器、手机三个宿主共用的一份，由服务端（--web）在 / 提供；/ 打开工作台，/farm 是像素农场
                           （src/farm，PixiJS），其余是工作台：一个概念一个 src/features/<概念>，与服务域同名；分层
                           base（纯的）→ infra（服务端、宿主、浏览器）→ state（中间层）→ ui → ui/domain → ui/pixel → features → 皮（farm、tree）→ app，lint 查；public/ 是全部的图、像素字、指针和样音
                           （apps/web/README.md）
apps/mobile/               手机壳（Expo、React Native）：扫码配对，WebView 打开那台电脑「连接到本机」放出的页面；通知、锁屏不断的通话经桥给页面（apps/mobile/README.md）
apps/site/                 官网 vibevalley.dev（Vite + Solid 2 静态生成，每个文档一个接管根）：图和像素字直接用 apps/web/public 的（apps/site/README.md）
packages/protocol/         跨端契约：一个概念一个文件夹 src/<概念>/（shapes.ts、schema.ts、api.ts），根入口显式重导出跨端契约，
                           订阅（rpc.ts，SSE）、两端共用纯规则（src/rules）和宿主接口（host.ts）；go-contract/ 由 go-contract.ts 校验最新
packages/base-ui/          无样式的组件（照 Base UI 的 Solid 2 版）：键盘、焦点、ARIA、开合和选中的状态、浮层的定位；样子在 apps/web/src/ui
packages/engine/           像素农场的引擎：Pixi 的舞台、寻路、音效合成、日钟、按整数倍放大
packages/i18n/             对用户说的话：locales/<语言>/<宿主.模块>.json 的词典，代码里 t("key")；src/catalogs.ts 由 i18n:gen 写出
packages/ai/               语音和转写的无框架运行：Core 转写、WAV/RMS、MOSS 会话和播放对账、轮次
packages/provider/         厂商接入：转写模型、MOSS wire/校验、声网字幕分片；不依赖 ai、protocol 或应用；通话编排与鉴权归 Go internal/domain/voice
packages/pkm/              前端知识库与双链大纲引擎（后端在 internal/domain/pkm）：Logseq 风格 Markdown、PARA 目录、双链图谱、前端大纲键盘编辑与框选状态机
packages/artifact/         前端 Artifact 引擎（后端在 internal/domain/artifact）：块操作并发状态机 Page、Markdown 互转、HTML 检查、前端协同编辑器 BlockEditor
packages/bridge/           宿主之间的调用：一份契约（入参、出参、推送载荷都是 Schema），两头由它生成，传输是各宿主的适配器
packages/home/             农场的家目录在磁盘上的约定：在哪、server.json、settings.json、auth.json；供脚本与 Node 工具读写
packages/testkit/          测试共用的：在真实时间上等条件、测试金字塔（只在 devDependencies）
packages/tsrs/             TypeScript 跑在 tsrs（TypeScript 7 的 Rust 移植）上：顶替 oxlint-tsgolint 给 vp check 做带类型的 lint 和类型检查，
                           tsdk/ 是编辑器用的 TypeScript
packages/async/            异步原语：打断（AbortSignal）、TaskGroup、Queue、Hub、Semaphore、重试与超时、AsyncIterable 的组合子；时钟（Clock）
packages/health/           仓库的体检：热点（改动次数乘行数）和逃生口（类型的、吞掉错误的）的棘轮；这个仓库的配置在 scripts/audit/health.config.ts
packages/stories/          零件的故事（像 Storybook）：故事的格式和查看器；页面的故事分四层：设计体系、组件（ui/ 每个零件旁边一个 X.stories.tsx）、交互、界面
design/                    生图提示词、脚本和切图规则（写进 apps/web/public）；原图和效果图在单独的仓库 vibevalley-art，design/art.sh 链接进来
docs/                      当前的行为和约定；subsystems/ 是各子系统从架构角度沉淀下来的样子（docs/AGENTS.md）
.agents/notes/             Agent Notes：具体的计划，做完沉淀进 docs/subsystems
.agents/skills/            仓库自己的 skill：验收（vv-acceptance，入口加 references/ 下按块的分册）等；.claude/skills 链接到这里
scripts/                   按职责分为 gen/（生成物写出与 Go 契约/SQLc 对账）、audit/（AST/lint/类型/棘轮门禁）、docs/（Note、链接、术语与旧名检查）、release/（发布、回归与 verify-server.ts）
```

每个包的约定在它的 README。

## 命令

```bash
vp install                                                      # 根目录：装 apps/*、packages/* 的依赖（Vite+ 带的 pnpm 12，pnpm workspace）
vp check                                                        # 改完任何 TS/前端代码：格式（oxfmt）、lint（oxlint，带类型，跑在 tsrs 上）和全部包的类型；--fix 改格式
vpx scripts/audit/comment-review.ts                             # 提 PR 前：模型照 docs/style/code.md 审这个分支新加的注释，逐条核实再删或改（vv-comments；--all <目录> 清存量）
env -u GOROOT CGO_ENABLED=0 go run ./cmd/vibe-server --web apps/web/dist   # Go 服务端，127.0.0.1:8787，同时提供页面
env -u GOROOT CGO_ENABLED=0 go run ./cmd/vibe issue list        # Go 命令行：照领域模型操作（issue、repo、agent、session、runtime、memory、cron、artifact、worker、channel、pkm、auth、doctor、app、chat、version）
vp run server:check                                             # 改完 Go 代码、SQL 或 packages/protocol：packages:build、vp check、go-sqlc --check、go-contract --check、go vet、go test
vp run packages:build                                           # 改了 packages/ 的导出或类型、单跑 vp check 以前：打出各库给别人的声明（dist/，带缓存）
vpx scripts/gen/go-sqlc.ts                                      # 改完 pkg/db/migrations/*.sql 或 pkg/db/queries/*.sql：重生成 pkg/db/generated 并校验最新（--check 只查）
vpx scripts/gen/go-contract.ts                                  # 改完 Go pkg/contract 导出：同步生成 packages/protocol/src/go-contract（--check 只查）
vp run web:check                                                # 改完 apps/、packages/：类型（vp check），engine、宿主的桥、手机壳和页面规则的测试，页面构建
vp run --filter @vibevalley/web e2e                              # 页面全量自动检查；定点先用 e2e:component / e2e:integration / e2e:audit，纯截图用 e2e:visual（apps/web/README.md）
vp run --filter @vibevalley/web stories                          # 改了零件（ui/、ui/pixel/）：开零件的故事，两种主题、几种宽度看它；改零件就改它旁边的 X.stories.tsx
vp run --filter @vibevalley/web e2e:dev                          # 改了页面的响应式写法：Playwright 跑在 Solid 开发版上，输出响应式诊断与调用栈
vp run desktop:test                                             # 改完 cmd/vibe-desktop：同时测试内嵌与 -tags thin_desktop 模式
vp run desktop:dev                                              # 桌面版开发：运行 Go 桌面壳 ./cmd/vibe-desktop
vp run --filter @vibevalley/mobile test                          # 改完手机壳（类型在 vp check）；原生工程与模拟器端到端见 apps/mobile/README.md
vp run package:mac                                              # 构建 dist/vibe-desktop、VibeValley.app（含 web 与 vibe）、.dmg/.zip 与 dist 下的 release.json
vp run release alpha|beta|final                                 # 发版：算版本、跑校验（表结构不变），问过才打 tag 推送（docs/development.md）
vp run capabilities                                             # 改了 <概念>/api.ts 的接口或 can：重写 docs/reference/capabilities.md（docs:verify 查它）
vp run api:client                                               # 改了 <概念>/api.ts 的接口：重写 packages/protocol/src/client.ts 的 VibeValleyApi（docs:verify 查它）
vp run i18n:gen                                                 # 改了 packages/i18n/locales：重写 catalogs.ts；vpx scripts/gen/i18n.ts check|find <文字> 查问题、找键
vp run health                                                   # 看热点和逃生口；vp run health:verify 对棘轮（变少了跑 vp run health:write 降下来）
vp run practice:check                                           # 语法树实践棘轮（scripts/audit/practice-audit.ts，存量在 practice.ratchet.json，变少了跑 practice:write）
vp run deadcode                                                 # 改完代码：knip 查没人用的文件、导出和依赖，报出的照它说的删
vp run notes:catalog                                            # 加、挪、删 Note 或改了标题：重写 .agents/notes/CATALOG.md
vp run docs:verify                                              # 改完文档、Note 或 skill：Note 和 skill 的格式、目录、生成物、链接、旧名字
vp run site:check && vp run site:build                          # 改完 apps/site/：素材和静态生成测试，再构建到 apps/site/dist/client
```

Node 24（`.node-version` 定的那个）、Vite+（`vp`：pnpm 12、格式、lint、类型、测试、任务）与 Go（`env -u GOROOT CGO_ENABLED=0 go …`，零 CGO，跨平台编译）；`sqlc` 照根目录 `sqlc.yaml` 生成 SQL 绑定。先跑和改动有关的最窄的检查。

一件事的主线：oar 会话事件 → `internal/domain/gateway/projection.go` 与各域状态归约 → 核心状态经 `GET /api/v1/state`（`internal/domain/gateway/streams.go`）SSE 及 `pkg/chord` 增量链路推给页面；对话轨迹与持久化由 `internal/durable` 记录（[architecture.md](docs/architecture.md)、[子系统](docs/subsystems/README.md)）。

## 怎么让 agent 做对

agent 照着已有的代码抄，走最短的路，所以要让容易的写法就是对的写法。挡住一类问题，按下面的顺序选手段，能用前面的就不用后面的（[理由](docs/subsystems/process.md)）：

1. **代码（类型化与静态结构）**：清楚的模块边界、静态的拓扑与字面量标识、用 Go 强类型 / TS Zod Schema、品牌主键、判别联合表达的不变量；让非法状态不可编译，把一类问题整个消掉（[静态化、类型化与可分析化](docs/style/module-design.md#静态化类型化与可分析化)）。
2. **静态检查（可分析化）**：Go `arch_test.go` / `go vet`、严格的 TypeScript（tsrs）、带类型的 oxlint、全仓语法树与契约审计（`practice:check`、`schema-audit.ts`、`go-contract.ts --check`、`go-sqlc.ts --check`、`health:verify`）、确定性测试与形式化验证；花的 token 最少，失败时写清错在哪、`Fix:` 怎么改、`See` 哪个文件，agent 读一次即可改对（[写法](docs/style/code.md#检查管着的写法)）。
3. **文字**：注释、规矩、本文、skill，只写没法强制、要 agent 自己判断的；能少写就少写。只有跑起来才看得出对不对的，写成验证 skill（[.agents/skills](.agents/skills/README.md)，照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) 写）。
4. **人看**：最难扩展。agent 落代码太快，每个 PR 都细看做不到；人的精力花在杠杆最大的地方：设计让 agent 默认就做对的环境。

一条新规矩，先问能不能写成代码或检查；只有写不成的，才进下面的列表。

## 普通 TypeScript 与 Go 分层

前端、契约、共有包和工具脚本用普通 TypeScript（不用 Effect，[理由](docs/subsystems/foundation.md#为什么这样)）：`async`/`await`、`AbortSignal`、`await using`、工厂函数，异步原语在 `@vibevalley/async`，运行时校验只用 Zod，页面样式是 Tailwind v4；写法和评审要点在 [vv-typescript](.agents/skills/vv-typescript/SKILL.md)，样式在 [vv-tailwind](.agents/skills/vv-tailwind/SKILL.md)。后端与原生壳使用 Go（`env -u GOROOT CGO_ENABLED=0`），分层与包边界由根目录 `arch_test.go` 守住。

## 规矩

- **先有概念，再有皮**：服务端按实际概念分域（[概念](docs/concepts.md)）；农场只画它们，游戏规则（`internal/domain/game`）只读事件算画面，业务不调它（[农场的皮](docs/subsystems/farm.md)）。
- **核心状态只有一份**：帮工或农场的新状态加在 `packages/protocol/src/<概念>/shapes.ts` 与 `core/shapes.ts` 事实里，在 `internal/domain/gateway/projection.go` 折叠，不在前端另存一份（[核心状态](docs/subsystems/core.md)）。
- **`packages/protocol` 只放跨端契约**：按 `src/<概念>/{shapes,schema,api}.ts` 组织（`Schema` 写 `satisfies Codec<T.X>`），根入口只显式重导出跨端契约（`protocol-surface.ts` 棘轮守住）；`src/rules` 只放双端共用的纯函数（`rules/contract.test.ts` 查），仅服务端跑的规则归 Go 各自域（[契约、规则和数据库](docs/subsystems/foundation.md#契约规则和数据库)）。
- **生成的不手改**：SQLc 产物（`pkg/db/generated/`、`vpx scripts/gen/go-sqlc.ts --check`）、Go 导出契约（`packages/protocol/src/go-contract`、`vpx scripts/gen/go-contract.ts --check`）、`packages/protocol/src/client.ts`（`api:client`）、`packages/i18n/src/catalogs.ts`（`i18n:gen`）与生成的参考表均由脚本写出，`server:check` 和 `docs:verify` 校验最新（[契约、规则和数据库](docs/subsystems/foundation.md#契约规则和数据库)）。
- **包之间只经包名**：跨包只经 `package.json` 的 `exports` 写 `@vibevalley/*`（`no-cross-package-path` 查），包内跨目录写 `#/…`（`parent-import` 查）；库对外给 `dist/` 声明、运行读源码（[仓库和包](docs/subsystems/foundation.md#仓库和包)）。
- **表名是「模块_概念」**：单数 `<模块>` 或 `<模块>_<概念>`，索引以表名开头；11 个模块迁移对（`0001_durable`–`0011_gateway` `{up,down}.sql`）写在 `pkg/db/migrations/`，查询写在 `pkg/db/queries/*.sql`，单块 `sqlc.yaml` 生成 `pkg/db/generated/`（`package generated`），运行时经 `pkg/db.OpenPool` 共用单个 SQLite WAL 库（`platform` 作用域），由根目录 `sqlc_migrate_test.go` 与 `vpx scripts/gen/go-sqlc.ts --check` 校验（[契约、规则和数据库](docs/subsystems/foundation.md#契约规则和数据库)）。
- **内部不留兼容**：改名、改形状、改落盘格式直接改，不写兼容层或旧数据兜底；表结构直接修改 `pkg/db/migrations/` 对应模块迁移；对外 HTTP `v1` 是唯一例外（[地基](docs/subsystems/foundation.md#为什么这样)、[接口版本](docs/subsystems/core.md#为什么这样)）。
- **页面不折事实**：页面只读 `GET /api/v1/state` 推来的 `StateFrame`（`useCore()`、`useFrames()`）并写画面摆法；缺数据就补进契约与 `internal/domain/gateway/projection.go` 或调接口问服务端，不在页面重写服务端业务规则（[客户端](docs/subsystems/app.md)）。
- **封闭的联合穷尽处理**：按 `_tag`、`kind`、`type` 分支时 `switch` 覆盖全部成员或显式 `default`（`switch-exhaustiveness-check` 查）；枚举全表映射用 `Record<X, …>`（[检查管着的写法](docs/style/code.md#检查管着的写法)）。
- **类型驱动，境界 Fail-Fast**：TypeScript 运行时校验只用 Zod，边界一次解码为品牌主键、受约束值与判别联合，不符当场失败；Go 侧由结构体、显式错误与 `internal/vault/secret.go`（`Secret`）护持边界（[类型驱动与进门解码](docs/style/module-design.md#类型驱动与进门解码)）。
- **服务端模块与依赖方向**：Go 业务域按单数概念放在 `internal/domain/<域>`，依赖方向由根目录 `arch_test.go` 静态强制；栈装配与生命周期编排在 `internal/domain/stack/stack.go`；跨域反应走事件与接口端口（[模块和服务](docs/subsystems/foundation.md#模块和服务)、[模块设计](docs/style/module-design.md)、[命名](docs/style/naming.md)）。
- **处理函数要薄**：HTTP 处理函数（`internal/domain/gateway/handlers_*.go`）和页面组件只做转发与展示，规则留在所属领域服务或纯函数里（[架构](docs/architecture.md#分层)）。
- **帮工没有权限确认**：主服务端只听 `127.0.0.1`，帮工只在工作目录开工（[帮工](docs/subsystems/session.md)）；仅有的两个独立监听是语音线路（[语音](docs/subsystems/voice.md)），以及默认关闭、按设备独立持钥的「连接到本机」（[连接到本机](docs/subsystems/lan.md)、[用户和设备](docs/subsystems/user.md)）。
- **图标分两套**：工作台用 `apps/web/src/ui/icons.ts` 注册的 reicon 线条图标（`<Icon name>`），像素皮与头像、农机 logo、插画用 `design/pixel` 生成的像素图（`SpriteIcon`），都不用字符符号代替（[客户端](docs/subsystems/app.md)、[图标](docs/style/design.md#图标)）。
- **界面照田间工作台**：颜色、圆角、字号、阴影、动效和层级一律走 `apps/web/src/style.css` 令牌（`no-hex-color`、`design-tokens` 查）；选档、原子组件与自查照 [界面怎么做](docs/style/design.md)，Tailwind 写法照 [vv-tailwind](.agents/skills/vv-tailwind/SKILL.md)。
- **密钥**：含密钥的 `vibevalley.yaml`、家目录 `settings.json` 与 `.agora/` 不进仓库；日志、快照和文档里不出现真实密钥。
- **工具链**：TS/前端统一用 Vite+（`vp`：依赖版本集中在 `pnpm-workspace.yaml` catalog 并由 `catalog.test.ts` 查，格式与带类型 oxlint 集中在根 `vite.config.ts`）；后端与桌面壳使用 Go（`env -u GOROOT CGO_ENABLED=0`）与 `sqlc.yaml`；脚本经 `vpx` 直接跑 `.ts`（[仓库和包](docs/subsystems/foundation.md#仓库和包)）。
- **话放在哪**：对用户的话进 `packages/i18n/locales/{zh,en}/<宿主.模块>.json` 并调 `t("key")`（`vp run i18n:gen` 生成类型，`vpx scripts/gen/i18n.ts check` 查漏翻）；对助手模型的话用中文写进 `internal/domain/stack/prompts.go`；其余 TS 硬编码中文由 `vibevalley/no-cjk-literal` 拦下（[话放在哪](docs/subsystems/foundation.md#话放在哪)）。
- **代码风格**：代码和接口用实际业务概念，种地双关只留在农场的皮里（`stale-names.ts` 查，[用语表](docs/README.md#用语)、[状态和用语](docs/subsystems/issue.md#状态和用语)）；命名站在领域视角说管什么事，不用 `utils`、`state` 一类泛词（[命名](docs/style/naming.md)）；英文注释只写不看就会改错的约束与原因，不复述代码或历史（[代码风格](docs/style/code.md)）。
- **测试**：行为在能发现出错的最低层测，禁止硬编码睡眠等待（`no-test-sleep` 查，用测试时钟或 `until`、`waitFor`）；Go 服务端用 `pkg/oar/replaytest`、`VIBEVALLEY_TEST_RUNTIMES=1` 脚本帮工与真 git 离线测，页面 Playwright 走隔离真 `vibe-server`、只按 `data-testid` 找元素（`no-copy-selector` 查）；修缺陷补 `regression: ` 前缀测试（[测试金字塔](docs/subsystems/foundation.md#测试金字塔)、[检查和测试](docs/development.md#检查和测试)）。
- **边界和棘轮**：TS 长操作传 `AbortSignal`、后台任务归 `TaskGroup`、资源用 `await using`、时间走 `Clock`（`no-wall-clock` 查）；Go 阻塞与取消传 `context.Context`；调用方拒绝返回带 `bizCode` 的统一信封；存量语法债与逃生口由 `practice:check`、`health:verify` 与 `protocol-surface` 单向棘轮锁死（[异步、资源与错误](docs/subsystems/foundation.md#异步资源与错误)）。
- **改完要验证**：先跑最窄的静态与单元检查；改了接口、服务、页面或宿主，照 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 对应分册在真实程序上验收并附上证据，缺分册则照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) 补齐（[.agents/skills](.agents/skills/README.md)）。
- **分支、提交和 PR**：同批改动默认合一个 PR，只经 squash 合入 `main`；分支 `<类>/<主题>`，提交与 PR 用英文写改完后的行为（标题不超过 100 字符、不带 agent 署名，commit-msg hook 与 CI 查），操作照 [vv-pr](.agents/skills/vv-pr/SKILL.md)（[分支、提交和 PR](docs/development.md#分支提交和-pr)）。
- **文档和 Note**：改行为同改对应文档（优先改 `docs/subsystems/`，不在 `reference/` 另起一份，见 [文档规矩](docs/AGENTS.md)）；非平凡改动先写 `proposed/` Note，上线后把长期成立的沉淀进子系统并删掉 Note（[什么时候写](.agents/notes/README.md#什么时候写)）。

## 编辑本文

`CLAUDE.md` 只有一行 `@AGENTS.md`，引用本文；规矩都改在本文。每条规矩自成一句，细节链接到它的家。
