# AGENTS.md

VibeValley 是 AI 版的 Linear，一个在本机管编码 agent 的工作台，和 Multica 是一类东西：任务派给角色（Agent），服务端为它派一个执行会话（Session，经 Rust 的 oar 驱动本机的编码引擎；支持带可选仓库提示的目录会话及零目录约束的无目录会话），由 Agent 自主管理 Git 分支/`git worktree`、验证与 PR 交付并向工单回写结构化多态交付凭据（`DeliveryReceipt`）；用户、主助手（替用户派活的 agent）和执行会话在频道里说话。外面另有一层 Papertrails 纸雕农场皮肤：仓库是院，在做的任务是一块地，帮工在地上干活，默认频道画成田头（[概念](docs/concepts.md)）。它是全原生的，桌面宿主运行于 macOS：服务端和命令行是 Rust（`crates/`），桌面应用是 `apps/mac`（GPUI 窗口，里面带着服务端；工作台是 nsh 跑的 TSX 页面，3D 纸雕农场由 Rust `wgpu` 画），另提供独立原生移动端 `apps/mobile`（`nsh/mobile`，iOS 优先、Android 就绪，经默认关闭的 Tailscale / 回环受认证远程门接入 Mac，见[移动端与远程访问](docs/subsystems/app.md#移动端与远程访问)）；契约、词典、工具说明和提示以 Rust 为源，TS 由它生成。改 `crates/`、`apps/`、`packages/` 之前读 [docs/architecture.md](docs/architecture.md)；写文档照 [docs/AGENTS.md](docs/AGENTS.md) 和 [docs/style/writing.md](docs/style/writing.md)；长期现状沉淀在 [docs/subsystems](docs/subsystems/README.md)，未上线规划与提案放在 VibeValley Issue 看板。

## 目录

```
crates/kit/                Ring 0 通用基础框架（vibevalley-kit，零工作区依赖、零 ORM 实体、`default = []`）：内聚 rt 共享 Tokio 运行时 + core（Clock/Secret/RetryPolicy/UTF-16/ErrorClass/DirtyMask）+ sync（loom/KeyLock/FlightGroup/WakeGate/TeardownGate）+ cache（NonZeroUsize LruCache/TtlCache/ReadThrough）+ trace（subscriber/spawn_traced/ObserverSlot）+ task（TaskGroup/Ticker/CronExpr/QuotaPool/DirLease）+ queue（KeyedLane/BatchCoalescer/BoundedSink/transactional outbox）+ 可选 storage（`storage-fs`/`storage-s3`：StorageBackend/StagingArea/path+CAS guard/OrphanSweeper）、db（`db-sql`/`postgres`：统一 SQLite+PG 连接池引擎/PostCommitHooks/SeqAllocator/schema/telemetry）与 net（`net-client`/`net-gateway`：出站 SSRF 防护与网关原语）
crates/protocol/           契约与环境约定（vibevalley-protocol）：src/contract/ 一个概念一个文件（含 EndpointId 与 SUBSCRIPTIONS），native.rs 为 NativeEndpointId，typescript.rs 写出 packages/protocol 的 shapes.gen.ts 和 endpoints.gen.ts；home.rs 为家目录与 server.json 约定
crates/i18n/               对用户说的话（vibevalley-i18n）：locales/<语言>/<宿主.模块>.json 的词典，Rust 里 t("key")
crates/core/               纯领域规则、切片投影与内容协同内核（vibevalley-core）：projection.rs 6 路切片投影（board/sessions/collab/inbox/ops/farm）、任务状态和阶段、收件箱、巡查、农场画面、简报起草、定时任务（cron/）与 Loro 内容平面协同内核（collab/）
crates/git/ · files/       仓库 Git 封装（vibevalley-git）与工作区文件搜索和监听（vibevalley-files）
crates/runtime/            运行时与自研 agent（vibevalley-runtime）：重导出 vibevalley_kit::rt、oar/ 驱动（Claude Code、Codex、ACP、scripted；含基于 arc-swap 的零开销 OarObserver 与 oar-voyage/3 记录）与可选 agent 特性下的模型请求（DeepSeek，reqwest + backon）、持久执行引擎、工具、对话循环和内置 vibevalley 运行时
crates/engines/            底层引擎：纯 Rust 正则（onig）、语法高亮（shiki）与图谱渲染（pele），供 crates/rich 使用
crates/rich/               原生富内容组件与辅助（vibevalley-rich）：Markdown、代码块、图谱、画布、图表、GenUI 与拼音匹配（engine/ 含 canvas、chart、genui、pinyin、whiteboard）
crates/server/             服务端（二进制 vibevalley-server）：扁平单数目录、浅层顶层装配：
                           入口与路由：main.rs → log::init → create_app(config)（app.rs：App、create_app、App::close）→ gateway::serve；router.rs 为 ~200 行薄入口门（check_can、trace_id span、FaultGate、InvokeObserver、订阅表与全部 EndpointId / NativeEndpointId 编译期穷尽分发，非 RPC 流拆出为 GatewayPorts）；
                           共享地基与数据服务：log/（init、span、spawn_traced、spawn_blocking_traced、observer）、db/（基于 vibevalley-kit 统一连接池的双后端 SQLite/PostgreSQL Database、migration/ 与严格一表一文件 db/entity/<table_name>.rs 共 31 张业务表实体；`outbox_item` 与 `seq_counter` 机制表由 `vibevalley-kit` 参数化 SQL 承接）、独立顶层 service/（Service 聚合全部业务视角持久化查询，挂载于 Context::service；crates/server/src/{db,service}/ 之外零 sea_orm:: 与 db::entity 导入）、context/（共享 Context：service Arc<Service>、task TaskGroup、live Arc<LiveState>、outbox Arc<Outbox>、feed Arc<StateFeed>、clock SharedClock，加 error.rs、http.rs、text.rs 与最小破环 port.rs）、storage/（统一文件/附件/媒体输入/笔记目录存储 Storage），以及顶层基础文件 setting.rs、provider.rs、repo.rs；
                           外部接入：gateway/（api/、bridge/、http/、remote/，收拢进程内桥、Axum HTTP/SSE 门与默认关闭的受认证远程监听门，不导入业务域）；
                           扁平深业务域（全单数，主结构体为 <domain>::Service 或朴素单数名）：runtime/（session/，支持无目录启动 `cwd: Option<PathBuf>`，经 SessionDriver 与 agent/ 解耦，不含服务端 worktree 保姆层）、agent/（profile/、memory/、tool/、mcp/、orchestrator/）、issue/（board、edit、family、refine、pull/、chat；工单只收多态 DeliveryReceipt，父子工单为纯任务拆解与 DAG 阻塞）、note/（manager.rs 目录生命周期 + 24 块 doc + 多维库 base + 统一多人/多 Agent 实时协同 collab + 3+1 NoteType 渐进披露技能 types + 并列 library 与 media/，6 张笔记表），以及 channel/、connector/、cron/、voice/、machine/、debug/、game.rs、fake/；assets/ 是工具说明（tools/）、3+1 笔记原语技能指南（note/types/）、主助手和执行会话的提示
crates/cli/                命令行（二进制 vibevalley，clap）：按业务域组织的纯 HTTP 客户端；评测另拆为可选二进制 vibevalley-eval（--features eval）
apps/mac/                  原生应用（二进制 vibevalley-mac）：src/ 是窗口外壳（src/shell/*）、终端、宿主能力和 Papertrails 场景（src/diorama：3D 纸雕农场与开场）；
                           crates/ 是桌面独占支撑 crate（diorama、terminal、workspace）；
                           ui/ 是 nsh 跑的 TSX：app（含 6 项主导航，详见 docs/subsystems/app.md）、workspace（侧栏/Git/文件/命令面板）、design（共享令牌与组件）、features/<概念>（含 3+1 原语笔记实时共编视图、5 栏设置与远程访问面板）、farm、infra
apps/mobile/               独立原生移动应用（nsh/mobile，iOS 优先、Android 就绪）：经 @vibevalley/protocol/remote 连接 Mac 远程门，4 标签页（收件箱、频道、会话、任务）与 97 枚 reicons 矢量回退
apps/island/               刘海上的灵动岛（Swift）：单独的小程序（apps/island/README.md）
apps/site/                 官网 vibevalley.dev（Vite + Solid 2 静态生成），Papertrails 图用根目录 assets/ 的
assets/                    从 vibevalley-assets 同步的轻量 Papertrails 产物：diorama/、brand/、icons/、avatars/、engines/、site/
packages/protocol/         页面用的契约：src/<概念>/shapes.gen.ts 和 endpoints.gen.ts 是生成的；Zod（schema.ts）、端点表（api.ts）、双端规则（rules/）、
                           纯 Web Fetch 远程传输层（@vibevalley/protocol/remote：remote/transport.ts）、client.ts、宿主接口（host.ts）是手写的
packages/i18n/             页面里 t("key")：src/catalogs.ts 由 i18n:gen 从 crates/i18n/locales 写出
design/                    设计令牌（tokens.json）与素材同步脚本（sync-assets.sh、diorama.sh）；所有原始素材与生成脚本在同级仓库 vibevalley-assets
docs/                      当前的行为和约定；subsystems/ 是各子系统从架构角度沉淀下来的样子（docs/AGENTS.md）
.agents/skills/            仓库自己的 skill：验收（vv-acceptance）等；.claude/skills 链接到这里
scripts/                   gen/（生成物写出）、audit/（lint 插件、死代码、注释审查）、docs/（链接、术语与旧名检查）、release/（发版、回归与验收沙箱 verify-server.ts）、tsrs/（vp check 用的 TypeScript）
```

每个包的约定在它的 README。

## 命令

```bash
vp install                                                      # 根目录：装 TS 依赖（Vite+ 带的 pnpm 12），打出各包的声明
vp run nsh:install                                              # 把 nsh 的命令行装到 .tools/bin：打 apps/mac/ui 的包、跑 mac:check 之前
cargo run -p vibevalley-mac                                     # 原生应用，里面带着服务端；dev 通道默认 127.0.0.1:8790 与 ~/.vibevalley-dev，VIBEVALLEY_HOME、VIBEVALLEY_STORE 改位置
cargo run -p vibevalley-server                                  # 只跑服务端；按发布通道默认端口（dev 8790 / alpha 8789 / beta 8788 / release 8787），VIBEVALLEY_CHANNEL、VIBEVALLEY_HOME、VIBEVALLEY_WORK_ROOT、VIBEVALLEY_PORT、VIBEVALLEY_DATABASE_URL（--database-url）改位置与数据库后端
cargo run -p vibevalley-cli -- issue list                       # 命令行：issue、session、repo、cron、agent、orchestrator、runtime、memory、channel、chat、note、library、media、attachment、state、setting、doctor（--json 输出原始 JSON）
make fmt                                                        # 一键格式化 Rust + TS（cargo fmt + vp check --fix --deny-warnings）
make gen                                                        # 改完契约/接口/词典后一次性重生成 protocol、api:client、capabilities 与 i18n
make i18n                                                       # 改了 crates/i18n/locales：重写 catalogs.ts 并校验词典（i18n:gen + check）
make rust                                                       # 或 cargo xtask check：改完 crates/、xtask/ 或 apps/mac/src，跑 fmt、clippy（-D warnings）与测试
make rust-clippy                                                # 全仓 cargo clippy --workspace --all-targets -- -D warnings
make rust-test [PKG=<crate>]                                    # nextest --profile fast（传 PKG 仅跑单 crate，省略跑全仓快速集）
make rust-changed                                               # 或 cargo xtask changed --base <ref> [--fast]：按开销递增检查改到的 Rust crate 及其反向依赖
make rust-fast [BASE=origin/main]                               # 分层 Fast-Fail：fmt --check → xtask audit → xtask changed --base $(BASE) --fast（跳过长耗时压测）
make verify-fast [BASE=origin/main]                             # 迭代/合批快捷验证：rust-fast + protocol + ts + mac:check + mobile:check + docs:verify
make pr-check                                                   # 提 PR 前终态门禁：make verify + vp run mobile:check
make rust-loom                                                  # 或 cargo xtask loom：对并发状态机内核跑 loom 穷举模型检验（--features loom --profile loom）
make rust-audit                                                 # 或 cargo xtask audit：检查 Rust 模块边界（扁平 DAG、gateway/ 隔离与 {db,service}/ 数据边界）与异步并发棘轮（xtask/src/{boundaries,ratchets}.rs）
make protocol-write                                             # 或 cargo xtask protocol --write：改了 crates/protocol/src/contract，重写 shapes.gen.ts 和 endpoints.gen.ts
make goldens                                                    # 或 cargo xtask goldens --check：跑 golden 测试
make protocol                                                   # 或 cargo xtask protocol：生成的 TS 契约和 golden 是不是最新，和提交的不同就失败
vp run mac:check                                                # 或 make mac：改完 apps/mac/ui，nsh 类型检查、打包和工单按钮行为测试
vp run mobile:check                                             # 或 make mobile：改完 apps/mobile，nsh 类型检查、打包、测试与 lint
make vdp [SCENE=all] [VDP_OUT=/tmp/vv-vdp]                      # 重编并用单条 WebSocket 跑固定 VDP 场景（note/issues/chat/library/dashboard/settings/all）
make vdp-ui [SCENE=note]                                        # 纯改 UI 跳过 Cargo 重编（--ui-only ~5s）；复用已有包用 make vdp-fast（--skip-build）
vp run icons:gen                                                # 改了 crates/rich/src/icon.rs：重新生成 97 枚 reicons 矢量路径表 iconPaths.gen.ts
vp check                                                        # 改完 apps/mac/ui 以外的 TS：格式（oxfmt）、lint（oxlint，带类型，跑在 tsrs 上）和类型；--fix 改格式
vp run packages:check                                           # 改完 packages/：打出声明、vp check、各包的测试
vp run scripts:test                                             # 改完 scripts/：它自己的测试
vp run site:check && vp run site:build                          # 或 make site：改完 apps/site/，素材和静态生成测试，再构建
vp run docs:verify                                              # 或 make docs：改完文档或 skill，格式、目录、链接、旧名字、用语、词典和生成的参考表
make deadcode                                                   # 或 vp run deadcode：knip 查 TS 里没人用的文件、导出和依赖
make patrol                                                     # 或 vp run patrol -- scan：串行跑确定性传感器选靶与巡检账本管理（vv-patrol）
make comment-review                                             # 提 PR 前：模型审这个分支新加的注释（vv-comments）
make package-alpha-dmg                                          # 或 vp run package:mac:alpha:dmg：打出本地 Alpha .app + .dmg 安装包
make verify                                                     # 在 Mac 上检查 Rust、边界/棘轮、契约、软件包、脚本、原生页面和文档
vp run release alpha|beta|final                                 # beta/final 先跑 make verify；确认后推 tag，每个标签通过 CI 才打包
```

Rust 照 `rust-toolchain.toml`，Node 24（`.node-version`），Vite+（`vp`：pnpm 12、格式、lint、类型、测试、任务）。先跑和改动有关的最窄的检查。服务端不自动重载：改了 `crates/` 要重新构建、重启它。

一件事的主线：oar 的会话事件或外部请求 → 经 `gateway/` 与 `router.rs` 分发至目标域处理器 → 经独立顶层 `service/`（`ctx.service`）事务落库（外部投递同事务写入 `Outbox`）并返回脏掩码 `SliceMask`（实时运行流与农场特效进 `LiveState`）→ `StateFeed` 调 `vibevalley-core` 纯投影函数更新 6 路域切片（`board`、`sessions`、`collab`、`inbox`、`ops`、`farm`）并经 `gateway/bridge/` 或 HTTP `GET /api/v1/slice/{name}` 推给客户端；执行会话和主助手的每一步记成轨迹（[architecture.md](docs/architecture.md)、[子系统](docs/subsystems/README.md)）。

## 怎么让 agent 做对

agent 照着已有的代码抄，走最短的路，所以要让容易的写法就是对的写法。挡住一类问题，按下面的顺序选手段，能用前面的就不用后面的（[理由](docs/subsystems/process.md)）：

1. **代码（类型与静态结构）**：清楚的模块边界、结构体和 enum 表达的不变量、进门一次解码；让非法状态不可编译，把一类问题整个消掉（[静态化、类型化与可分析化](docs/style/module-design.md)）。
2. **静态检查**：Rust 的类型、clippy（`-D warnings`）和测试；TS 一侧是严格的 TypeScript（tsrs）、带类型的 oxlint 和 nsh 的类型检查；失败时写清错在哪、怎么改、看哪个文件（[写法](docs/style/code.md)）。
3. **文字**：注释、规矩、本文、skill，只写没法强制、要 agent 自己判断的；只有跑起来才看得出对不对的，写成验证 skill（[.agents/skills](.agents/skills/README.md)，照 [create-verification-skill](.agents/skills/create-verification-skill/SKILL.md) 写）。
4. **人看**：最难扩展；人的精力花在设计让 agent 默认就做对的环境上。

一条新规矩，先问能不能写成类型、clippy 规则或测试；只有写不成的，才进下面的列表。

## 规矩

- **Rust 为准，速度优先**：服务端的行为以 Rust 为准；只接 DeepSeek 不做多厂商路由、语音直连 MOSS Live 不接声网 SDK、不支持 `cursor`/`dsh` 驱动，成本高、价值低的路径直接裁剪并沉淀在对应子系统文档。
- **先有概念，再有皮**：服务端按实际概念平铺单数模块（[概念](docs/concepts.md)）；农场只画它们，游戏规则只读事件算画面，业务不调它（[农场的皮](docs/subsystems/farm.md)）。
- **单一持久化真源与切片投影**：持久化状态只经顶层 `crates/server/src/service/`（`Context::service`）落库，不维护内存影子库；外部投递同事务写入 `Outbox`，运行中流与农场特效留在 `LiveState`，前端 6 路切片由 `StateFeed` 按 `SliceMask` 调用 `vibevalley-core` 纯投影函数生成（[核心状态](docs/subsystems/core.md)）。
- **数据库与持久化边界收口在 `db/` 与 `service/`**：`crates/server/src/db/entity/` 严格一表一文件（`<table_name>.rs`，共 31 张业务表；`outbox_item` 与 `seq_counter` 由 `vibevalley-kit` 参数化 SQL 承接），全部业务视角 SeaORM 查询收拢在独立顶层 `crates/server/src/service/`（`Service` 挂载于 `Context::service`），`crates/server/src/{db,service}/` 之外禁止出现任何 `sea_orm::` 或 `db::entity` 导入，且 `crates/server/src/service/` 禁止直接引用 `durable::entities`。
- **笔记目录化存储 + 全类型多人/多 Agent 实时协同**：每篇笔记为 `storage/` 托管的目录 `<storage>/note/<note_id>/{manifest.json,structure/,asset/}`，数据库保留 6 张表（`note`、`note_version`、`note_collab`、`note_change`、`note_suggestion`、`note_link`），全链路采用 3+1 `NoteType` 原语（`doc`、`base`、`canvas`、`media`，各配渐进披露技能），全类型支持多人 + 多 Agent Loro CRDT 实时协同、在线在场、按 `origin` 历史、评审建议与双向链接图谱（[Note](docs/subsystems/note.md)）。
- **边界解码一次，门内全是类型**：HTTP、文件、厂商响应、模型给的工具参数，各在进门处用 serde 解码成结构体和 enum；门内不传 `serde_json::Value`、不按字符串分支；钥匙包进 `Secret`（打印只出提示）；页面在边界用 Zod 解码（`satisfies Codec<T.X>`）（[类型驱动与进门解码](docs/style/module-design.md)）。
- **深模块**：每个模块对外一个窄接口；不靠一个带 `kind` 的入口复用多种操作（[模块设计](docs/style/module-design.md)）。
- **Rust 异步与并发**：共用单一 `vibevalley_kit::rt`（`vibevalley_runtime::rt` 重导出），异步函数与 `Drop` 禁 `rt::block_on`（用 `close_async`），测试用 `start_paused` + `ManualClock` 及 `--features loom` 内核，`crates/rich` 重计算离线程卸载，按需复用 `vibevalley_kit::{sync::KeyLock, cache::{LruCache, TtlCache}, task::Ticker, queue::{KeyedLane, BoundedSink}}`（[Rust 异步并发规范](docs/style/rust-async-concurrency.md)，`cargo xtask audit`）。
- **封闭的联合穷尽处理**：Rust 的 `match` 不写吞掉新成员的 `_`（`router.rs` 对全部 `EndpointId` 与 `NativeEndpointId` 穷尽分发）；TS 按 `_tag`、`kind`、`type` 分支时 `switch` 覆盖全部成员（`switch-exhaustiveness-check` 查）。
- **契约改在 Rust**：形状和接口表改 `crates/protocol/src/contract`，TS 的类型由它生成；页面要用的同改手写的 `schema.ts` 与 `api.ts`，它们的测试对着生成物查（[契约](docs/subsystems/foundation.md#契约规则和数据库)）。
- **生成的不手改**：`packages/protocol` 的 `shapes.gen.ts` 与 `endpoints.gen.ts`（`cargo xtask protocol --write`）、`client.ts`（`api:client`）、`packages/i18n/src/catalogs.ts`（`i18n:gen`）、`iconPaths.gen.ts`（`icons:gen`）、golden（`cargo xtask goldens`）和生成的参考表由脚本写出，`cargo xtask protocol` 和 `vp run docs:verify` 查是不是最新。宿主 `state.db` 与服务端、持久执行统一使用 `SeaORM` + `SeaQuery`（服务端与持久执行同时支持 SQLite 与 PostgreSQL，前向增量迁移由 `seaql_server_migrations` / `seaql_migrations` 跟踪并在启动时校验表结构）。
- **内部不留兼容**：改名、改形状、改落盘格式直接改，不写兼容层、旧数据兜底或迁移脚本；对外 HTTP `v1` 是唯一例外（[接口版本](docs/subsystems/core.md)）。
- **页面不折状态，计算下沉 Rust**：领域计算、Markdown/载荷解析、事件流折叠、汇总聚合与切片投影统一放在 Rust（`crates/core` 与 `crates/rich`），经契约切片/接口或 `vibevalley/rich` 原生模块单源输出给桌面、移动端与命令行；TS 只做薄类型绑定、视图呈现、文案本地化与本地 UI 交互态（筛选、折叠、选中、草稿、拖拽预览），缺数据就补进契约与纯投影或调接口问服务端（[架构](docs/architecture.md#分层)、[客户端](docs/subsystems/app.md)）。
- **页面守 `nsh` 响应式**：动态 JSX 分支用 `<If>`、列表用带稳定 `key` 的 `<Each>` 或 `<List>`，不解构 `props`、不提前求值访问器、多处派生用 `computed()`（[NSH TSX 规范](docs/style/nsh-tsx.md)）。
- **处理函数要薄**：`gateway/` 的 HTTP 门、进程内桥、`router.rs` 和页面组件只做鉴权、转发与展示，规则留在所属模块或纯函数里（[架构](docs/architecture.md)）。
- **执行会话没有权限确认**：服务端只听 `127.0.0.1`，执行会话只在工作区开工（[执行会话](docs/subsystems/session.md)）。
- **包之间只经包名**：TS 跨包只经 `package.json` 的 `exports` 写 `@vibevalley/*`（`no-cross-package-path` 查）；Rust 跨 crate 只经 `Cargo.toml` 的依赖。
- **图标分两套**：工作台用 `crates/rich/src/icon.rs` 原生 `VvIcon` 渲染的 97 枚 reicon 线条图标（TS 侧由 `apps/mac/ui/design/icons.ts` 声明 `IconName`，经 `<Icon name>` 使用；无原生 `VvIcon` 的载体及 `apps/mobile` 使用 `scripts/gen/icons.ts` 单源生成的 `iconPaths.gen.ts` 与 `<Canvas>` + `Path2D` 矢量回退），角色头像、引擎标识与品牌图标使用从 `vibevalley-assets` 经 `design/sync-assets.sh` 同步到 `assets/{avatars,engines,brand,icons}/` 的 Papertrails 纸雕产物，都不用字符符号代替（[图标与令牌](docs/design/01-philosophy-and-tokens.md)）。
- **界面照田间工作台**：工作台、工作区外壳、移动端和原生壳面的颜色、圆角、字号、阴影和缓动一律走 `design/tokens.json`（由 `vp run tokens:gen` 同步写出 `apps/mac/ui/design/theme.json`、`apps/mac/ui/nsh.json`、`apps/mac/src/theme_tokens.rs` 及 `apps/mobile` 令牌）；照 [设计系统](docs/design/README.md) 与 [Agent UI 指南](docs/design/08-agent-ui-guide.md)，class 写法照 [vv-tailwind](.agents/skills/vv-tailwind/SKILL.md)。
- **UI 迭代克制与两层 VDP 验收**：页面与编辑器遵循「克制、无冗余框线」原则（不画盒套盒与常驻装饰框、编辑/切换控件 hover 或激活才浮现、浮层不遮挡前序内容、`<Scroll horizontal>` 的 `contentClass` 显式带 `flex-row`、双主题下原生画布适配深色表面、表格密排单元格避免双控件重叠截断）；高频页面与交互节点通过零开销 `useVdpNode` / `<VdpAnchor>` 暴露 `testID` 供 VDP 探针定位。做页面验收默认复用 `scripts/vdp/` 固定 TS 场景（`vp run vdp <场景...> --ui-only`），纯改 UI 时跳过 Cargo 重编，只靠看 `manifest.json`、`index.html` 与截图 pick 问题，禁止每轮从零手搓一次性采图脚本。
- **密钥**：家目录的 `settings.json` 不进仓库；日志、快照和文档里不出现真实密钥。
- **话放在哪**：对用户的话进 `crates/i18n/locales/{zh,en}/<宿主.模块>.json`，Rust 调 `vibevalley_i18n::t`，TS 调 `t("key")`（`vpx scripts/gen/i18n.ts check` 查漏翻）；对模型的话用中文写进 `crates/server/assets`（[话放在哪](docs/subsystems/foundation.md)）。
- **代码风格**：代码和接口用实际业务概念，种地双关只留在农场的皮里（`stale-names.ts` 查，[用语表](docs/README.md#用语)）；命名站在领域视角说管什么事，不用 `utils`、`state` 一类泛词和自造架构黑话，服务端顶层业务域与结构体一律用单数（顶层持久化服务层为 `service::Service`，深业务域为 `<domain>::Service`，基础模块为 `Storage`/`Setting`/`Provider`/`Repo`/`Game`，依赖字段为 `app.issue`/`ctx.service`），复数只用于集合、计数与列表接口（[命名](docs/style/naming.md)）；英文注释只写不看就会改错的约束与原因（[代码风格](docs/style/code.md)）。
- **测试**：行为在能发现出错的最低层测；服务端的测试在 `crates/*/tests`，用 scripted 引擎与真 git 离线跑；页面的测试用 `nsh/test` 喂样例的 `Transport`，纸雕场景与开场逻辑在 `apps/mac/src/diorama/` 单元测试中核验；不写硬编码睡眠等待（TS 由 `no-test-sleep` 查）；修缺陷补 `regression` 测试。
- **改完要验证与编译/测试提速（分层 Fast-Fail）**：先跑最窄的静态与单元检查，迭代与合批验证统一调用 `Makefile` 快捷目标：`make rust-fast [BASE=<基线>]`（`fmt --check` ~0.5s → `xtask audit` ~1s → `xtask changed --fast` 定向 `clippy` + `--profile fast` 单测 5–15s）和 `make verify-fast [BASE=<基线>]`；把全仓 1850+ 条 `make verify` 留到最终 PR/发版前统一跑一次，禁止修几行就重复重跑全仓测试。保持本机 Cargo wrapper 一致（启用 `sccache` 时建议配置 `SCCACHE_CACHE_SIZE=40G`，不要反复用 `RUSTC_WRAPPER=""` 切换导致指纹重建；`.vibevalley/check` 在关联 git worktree 中自动注入 `SCCACHE_BASEDIRS` 与 `CARGO_INCREMENTAL=0` 共享跨树缓存），禁止并发多个 Cargo 进程竞争锁；`[profile.dev]` 与 `[profile.test]` 统一本仓 crate `opt-level` 以复用编译产物；多 Agent 并行时 `workspace:"share"` 工兵阶段（Stage A）严禁跑 `cargo`（仅跑快速 TS/lint/文档校验），由单集成者合并后统一编译（Stage B）；改了接口、服务、页面或纸雕场景，照 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 跑 `vp run vdp` 在真实程序上验收并附上证据（纯 UI 改动加 `--ui-only`）。
- **两败验前提、实证审查与结构化复盘**：同一门禁基于同一前提连败 2 次强制停手证伪前提、改动前先减后加并按可验证单元排序提交；高危审查与性能优化按 [vv-governance](.agents/skills/vv-governance/SKILL.md)（`interrogate` / `blast-radius` / `benchmark-checklist`）与 [vv-patrol](.agents/skills/vv-patrol/SKILL.md) 传感器闭环留存可执行实证，复盘教训能机检的一律补静态防线、不堆砌进本文（[工程流程](docs/subsystems/process.md)）。
- **分支、提交和 PR**：同批改动默认合一个 PR，只经 squash 合入 `main`；分支 `<类>/<主题>`，提交与 PR 用英文写改完后的行为（标题不超过 100 字符、不带 agent 署名，commit-msg hook 与 CI 查），操作照 [vv-pr](.agents/skills/vv-pr/SKILL.md)（[分支、提交和 PR](docs/development.md)）。
- **双层 SSOT（Issue + 子系统文档）**：改行为同改对应文档（优先改 `docs/subsystems/`，见 [文档规矩](docs/AGENTS.md)）；未上线的非平凡改动先在 VibeValley Issue 看板建单（标明 `Category`: `feature | bug-fix | architecture | simplification | process | testing`、`Domain Tags`、`priority`、`criteria`，`architecture` 类 Issue 须写清 `Alternatives considered`），上线后把长期成立的模型与取舍沉淀进子系统文档并关闭 Issue。

## 编辑本文

`CLAUDE.md` 只有一行 `@AGENTS.md`，引用本文；规矩都改在本文。每条规矩自成一句，细节链接到它的家。
