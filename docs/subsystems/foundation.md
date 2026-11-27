# 地基

服务端、命令行、原生应用和脚本共用的工程骨架：Cargo 工作区与 pnpm 工作区、深模块、边界一次解码的类型、契约的生成、双后端数据库存储（SQLite + PostgreSQL）与测试分层。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| Cargo 工作区（18 个成员：`crates/*`、`crates/engines/*`、`apps/mac`、`apps/mac/crates/*`、`xtask`）、pnpm 工作区（剩下的 TS 包与页面）、依赖版本、构建与检查 | 各 crate、各包的对外约定（各自的 `README.md` 或 `lib.rs` 开头） |
| 服务端扁平单数业务域与接入网关（`crates/server/src/{gateway,service}/` 与顶层业务域） | 各模块的业务行为（对应子系统文档） |
| 契约（`crates/protocol` 的 Rust 源与生成的 `packages/protocol` TS 类型） | 核心状态折叠与接口路由（[核心状态](docs/subsystems/core.md)） |
| 双后端数据库存储（SQLite + PostgreSQL）、表与实体归属哪个模块 | 业务表含义（各子系统）与家目录文件（[架构](docs/architecture.md#存了什么)） |
| 测试分层、测试用的替身农机 | 页面分层与宿主打包（[客户端](docs/subsystems/app.md)） |
| 词典（`crates/i18n/locales/`，编进 Rust 并生成 `packages/i18n`）与模型提示（`assets/`）分工 | 界面用词标准（[用语表](docs/README.md#用语)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `Cargo.toml`、`rust-toolchain.toml`、`rustfmt.toml`、`Makefile`、`xtask/` | Rust 工作区成员、工具链、格式、`cargo xtask`（`check`、`changed`、`loom`、`goldens`、`protocol`、`audit`、`arch-audit`、跨层导航 `trace`/`map`/`deps`/`ssot-check` 与纯 Rust 零新依赖 QA 套件 `qa/{crap,dry,mutate,uml,viewer}`）与 `make` 入口 |
| `pnpm-workspace.yaml`、`vite.config.ts` | TS 工作区包列表、依赖版本 catalog、oxfmt 与 oxlint 配置、TS 检查任务（`ts:check`、`docs:verify`…） |
| `scripts/{gen,audit,docs,release}/` | 工程脚本：`gen/`（词典含中文纯英文残值守卫与 3+1 `NoteType` 全覆盖校验、令牌、97 枚 reicons 矢量路径 [icons.ts](scripts/gen/icons.ts) 与应用图标生成）、`audit/`（lint 插件、死代码、注释审查）、`docs/`（链接、术语与旧名检查）、`release/`（发版、回归与验收沙箱） |
| `crates/server/src/{main.rs,app.rs,boot.rs,router.rs}` | `main.rs` → `log::init` → `create_app(config)`（[app.rs](crates/server/src/app.rs)：不可变组合根 `App` 与 `App::close`）→ `boot.rs`（事件桥与调度启动）→ `gateway::serve`；[router.rs](crates/server/src/router.rs) 为约 200 行薄入口门（`check_can`、`trace_id` span、`FaultGate`、`InvokeObserver`、订阅表鉴权与全部 `EndpointId` / `NativeEndpointId` 编译期穷尽分发，非 RPC 流拆出为 `GatewayPorts`），零运行时 handler `HashMap` 与 `attach_*` 晚绑定槽位 |
| `crates/server/src/{db,service,context,storage,log}/` | `db/` 管双后端（SQLite + PostgreSQL）`Database`、`migration/` 与严格一表一文件 `db/entity/<table_name>.rs`（共 36 张表）；独立顶层 [service/](crates/server/src/service/mod.rs)（`Service` 挂于 `Context::service`，`crates/server/src/{db,service}/` 之外零 `sea_orm::` 与 `db::entity` 导入）；`context/` 提供 `Context`（`service`、`task`、`live`、`outbox`、`feed`、`clock`、`port.rs`）；`storage/` 提供插件化存储后端；`log/` 提供追踪与 `InvokeObserver` |
| `crates/server/src/` 与 `crates/server/src/gateway/` | 扁平单数深业务域（`runtime/`、`agent/`、`issue/`、`note/`、`channel/`、`connector/`、`cron/`、`voice/`、`machine/`、`debug/`、`game.rs`、`fake/`，顶层基础文件 `setting.rs`、`provider.rs`、`repo.rs`）与外部接入网关 `gateway/{api,bridge,http,remote}`（零业务域导入） |
| `crates/protocol/src/contract/`、`crates/protocol/src/home.rs` | 线上类型（含 5 域切片、`FarmFrame`、`debug.rs`、`vdp.rs`、[remote.rs](crates/protocol/src/contract/remote.rs) 与 `host.rs` 壳协议，`ts-rs` 写出 `packages/protocol` 的 `*.gen.ts`，`cargo xtask protocol` 查最新）与家目录约定（`server.json`、语言及进程级缓存的本机设备名 `computer_name()`） |
| `crates/mcp/src/` | 纯协议包 `vibevalley-mcp`：`protocol.rs`（`PROTOCOL_STATELESS` / `PROTOCOL_LEGACY` / `-32020`）、`stateless.rs`（`McpHandler`、SEP-2575 `server/discover` 与 `_meta`、SEP-2243 `HttpHeaders`）、`skills.rs`（SEP-2640 `skill://note/*`、`skills/list`、`skills/get`）、`stdio.rs`、`config.rs`（`McpServerConfig`）与 `redact.rs`（密钥脱敏）；严格不包含任何编码 agent 探测或安装逻辑 |
| `crates/core/src/` | 纯规则中心：`reduce`、`SliceMask` 与按域切片投影、状态派生、收件箱、依赖、挂钟抽象 [clock.rs](crates/core/src/clock.rs)（`Clock` / `ManualClock`）、定时任务（`cron/`）、笔记内核（`note/`） |
| `crates/runtime/src/` | 进程级共享 Tokio 运行时 `rt.rs`（`rt::handle`、`rt::current_or_global_handle`、`run_command_with_timeout`）、幂等析构门 `teardown_gate.rs`、`oar/` 驱动与自研 `agent/` 持久对话引擎（`execution.db`） |
| `crates/rich/`、`crates/engines/{onig,pele,shiki}` | 原生富内容组件与内部引擎（`canvas`、`chart`、`genui`、`pinyin`）及底层正则/高亮/图谱引擎 |
| `apps/mac/crates/workspace/src/store/mod.rs` | 原生应用外壳的 `state.db`（SQLite）：项目、终端与布局；连同 `diorama`、`terminal` 共 3 个桌面支撑 crate |
| `crates/i18n/src/lib.rs`、`crates/i18n/locales/` | 消息格式与词典；词典构建时编进去，前端 `web.*` 词典挂在可选特性 `web` 下（仅 `crates/rich` 开启） |
| `crates/server/src/fake/runtime.rs` | 测试和验收沙箱用的替身农机 `pi`（`VIBEVALLEY_TEST_RUNTIMES=1`） |
| `packages/protocol/src/<概念>/` | 页面用的契约：生成的 `shapes.gen.ts`，手写的 `schema.ts`（Zod）和 `api.ts`（额外导出或别名才设 `shapes.ts`）；`src/rules/` 是页面用的纯函数规则；`@vibevalley/protocol/remote`（[transport.ts](packages/protocol/src/remote/transport.ts)）导出零平台依赖的纯 Web Fetch `HttpRemoteTransport`（Bearer 鉴权、`Last-Event-ID` SSE 续读与 `vibevalley://pair` 解析）；`src/client.ts` 是生成的 `VibeValleyApi` |

## 模型和不变量

### 仓库和包

- **Rust 为准**：服务端（`vibevalley-server`）、命令行（`vibevalley-cli`）、原生应用（`apps/mac`）都是 Rust；TS 承接桌面工作台（`apps/mac/ui`）、独立原生移动端（`apps/mobile`，`nsh/mobile`，iOS 优先、Android 就绪）、2 个共用包（`packages/{protocol,i18n}`）、官网（`apps/site`）与脚本，不维护浏览器应用与 Electron 桌面壳。
- **一个 Cargo 工作区（18 个成员）**：成员按层组织为 `crates/*`（`protocol`、`mcp`、`i18n`、`core`、`git`、`files`、`runtime`、`rich`、`server`、`cli`）、`crates/engines/{onig,pele,shiki}`、`apps/mac`、桌面支撑 `apps/mac/crates/{diorama,terminal,workspace}` 与 `xtask`（包名仍保留 `vibevalley-*`，使 `core` 不遮蔽 `::core`），版本与 edition 写在根 `Cargo.toml` 的 `[workspace.package]`，依赖各 crate 自己写；`cargo xtask check` 跑 `cargo fmt --check`、`cargo clippy -D warnings` 与 `cargo test`。
- **TS 依赖版本集中**：版本在 `pnpm-workspace.yaml` 的 catalog，各包写 `catalog:`（`scripts/audit/catalog.test.ts` 查）。
- **跨包走包名**：TS 跨包写 `@vibevalley/*`（`no-cross-package-path` 查）；`apps/mac/ui` 经 `nsh.json` 的别名解析它们；`packages/*` 的类型导出指向 `dist/*.d.ts`（`vp run packages:build`）。

### 模块和服务

架构、边界与测试如何共同设计，见[模块设计](docs/style/module-design.md)。

- **跨边界强类型协议化，进程内保持直调**：跨越运行时、渲染载体或进程边界的交互（`HostFrame`/`HostAction`/`HostOp`、`DebugKit`、`VdpCommand`、`MachineWireFrame`、`Remote*`）统一收拢进 `crates/protocol` 强类型契约，开放 MCP 协议与 SEP-2640 Skills 独立收口在 `crates/mcp`（`vibevalley-mcp`）；同一 Rust 进程内业务模块之间维持窄 trait 与直接调用，不引入进程内 JSON/RPC 或 `tower::Service` 包装层。
- **深模块、扁平单数域无环 DAG 与严格数据边界**：每个模块对外一个窄结构体（`<domain>::Service` 或朴素单数名 `Storage`/`Setting`/`Provider`/`Repo`/`Game`），里面的表、锁和线程不露出去。服务端模块平铺于 `crates/server/src/` 顶层形成无环 DAG（最小破环收口在 `context/port.rs`），`gateway/` 禁止导入任何业务域模块（只依赖 `Router` 与 `GatewayPorts`），`crates/server/src/db/entity/` 严格一表一文件（`<table_name>.rs`，共 36 表），全部 SeaORM 持久化查询收拢在独立顶层 `crates/server/src/service/`（`Service` 挂载于 `Context::service`），**`crates/server/src/{db,service}/` 之外禁止出现任何 `sea_orm::` 或 `db::entity` 导入**；`xtask/src/arch_audit.rs` 的 15 条守卫（含 `NoRawGitCommand`、`NoSyncProcessInServer`、`NoBlockingReqwest`、`NoSeaOrmOutsideService`、`OneTableOneEntityFile`、`NoGatewayReverseImport`、`ServerDomainDag`、`NoLateBindHook`、`ThinAppAndRouter`、`ThinModRs` 等）与 [boundaries.rs](xtask/src/boundaries.rs) 在 `cargo xtask audit` 中强制拦截。
- **按序不可变启动与统一停机**：`create_app(config)`（[app.rs](crates/server/src/app.rs)）按无环依赖顺序不可变构造 `Database`、`Service`、`Context`、基础服务与全部扁平业务域，组装 `Router` 与 `GatewayPorts`，零运行时 handler `HashMap` 与 `attach_*` 晚绑定槽位；停机通过 `App::close()` 统一取消 `TaskGroup` 排空后台任务并关闭数据库连接池。状态持久化写入经 `ctx.service` 与同事务 `Outbox` 提交并返回 `SliceMask`，经 `StateFeed` 单航班纯投影更新 6 路切片，瞬态流与农场特效留在 `LiveState`。
- **操作与发言主体统一用 `Actor`**：`kind` 是 `user`、`agent`、`system`，`agent` 带 `role` 与 `forUser`；HTTP 来的是 `user`，助手的工具是 `agent`（`orchestrator`），`/mcp` 是 `agent`（`worker`），定时任务是 `system`。
- **同一个家目录只有一个工单板**：工单板在它的数据旁放一个锁文件，别的进程只能读快照。
- **跨层导航与纯 Rust 零新依赖 QA 套件（`xtask`）**：`xtask/Cargo.toml` 保持零新增第三方依赖（仅 `serde` + `serde_json`），复用 [rust_scan.rs](xtask/src/rust_scan.rs) 与 `xtask/src/qa/{mod,lang}.rs` 纯 `std` Rust + TypeScript/TSX 词法分析器提供两套原生命令：
  - **跨层导航与 SSOT 巡检**：`cargo xtask trace`（6 层端点到客户端追踪）、`cargo xtask map`（模块 `pub`/`pub(crate)` 门面与复杂度热点）、`cargo xtask deps`（模块依赖环与 UI 跨 feature 深层导入）、`cargo xtask ssot-check`（`ts-enum-mirror`、`host-dto-bypass`、`env-registry-drift` 与 `--dupes` 结构克隆雷达），统一输出处方式 `--json` 诊断（`rule`、`file`、`line`、`symbol`、`why`、`fix_hint`）。
  - **质量门禁套件（Policy / Topology IR / `.metrics/` 三层隔离）**：`cargo xtask crap`（`CRAP = CC² × (1 − coverage)³ + CC`）、`dry`（同语言结构克隆）、`mutate`（`target/mutation-workers/` 隔离增量变异测试）、`uml`（Policy `:levels` Dependency Rule 校验与独立 `std::net::TcpListener` 本地 Web 查看器 `viewer`），全部共享 `(namespace, name, visibility)` 主键。

### 异步、资源与错误

- **边界解码一次，门内全是类型**：HTTP 的入参经 `Router`（serde）按端点的类型解成结构体，解不开当场拒绝；GPUI 宿主桥的 `host.*` 调用在入口经 `HostOp::from_wire`（`crates/protocol/src/contract/host.rs`）一次性解码为封闭枚举后穷尽分发；文件、厂商响应、模型给的工具参数各在进门处解成结构体和 enum。门内不传 `serde_json::Value`，不按字符串分支（由 `NoValueInInternalSig` 守卫）。
- **统一结构化日志**：`crates/server/src/log/` 与根 `Cargo.toml` 声明工作区 `tracing` 与 `tracing-subscriber`；`vibevalley-server` 与 `vibevalley-mac` 启动调用 `log::init` 读取 `VIBEVALLEY_LOG`／`RUST_LOG`（未设且 `VIBEVALLEY_DEBUG=1` 时默认 `info`，否则 `warn`）。
- **钥匙是 `Secret`**：`settings.json` 里的钥匙与 `S3Backend` 凭据读成 `Secret`（`crates/server/src/setting.rs`），打印只出提示。
- **拒绝带 `BizCode`**：对调用方的拒绝是 `ApiError`（带 `bizCode` 与 `next`），网关写成全信封；模块内部可分辨的失败是 `thiserror` 的 enum；预期的结果（合进去或冲突）返回 enum，不当错误。
- **共享异步底座与单一运行时**：全进程共享唯一多线程 Tokio 运行时 `vibevalley_runtime::rt`（工作线程 `vibevalley-io-{n}`，初始化即安装 `rustls` `ring` 提供方，无 `pollster` 依赖）。`Router`（`router.rs`）对全部 `EndpointId` / `NativeEndpointId` 做编译期穷尽分发并直接调用各域异步处理函数；热读插槽用 `arc-swap`，全局互斥锁用 `parking_lot`（无毒化），重试退避用 `backon`。后台异步与阻塞任务分别经 `TaskGroup` 与 `log::spawn_traced` / `spawn_blocking_traced` 管理，停机统一在 `App::close()` 中异步排空；超时的外部子进程统一使用 `run_command_with_timeout`（`tokio::process::Command` + `.kill_on_drop(true)` + `tokio::time::timeout`），批量多目标外呼以 `JoinSet` + `Semaphore` 有界并发。
- **无条件 `trace_id` 与 `tracing::Span` 传播**：`Router` 在调用方未传入非零 `trace_id` 时无条件分配单调非零标识并建立请求 span（跨 `spawn_traced` 与 `spawn_blocking_traced` 自动延续），使服务端模块、`sqlx`、macOS `OsLogLayer` 与 `oar-voyage/3` 记录自动关联。
- **两层确定性虚拟时钟与定向 `loom` 内核检验**：单调异步计时器经 [rt.rs](crates/runtime/src/rt.rs) 的 `rt::current_or_global_handle()` 派发（生产回落全局 `vibevalley-io` 运行时，`#[tokio::test(start_paused = true)]` 下附着当前线程测试时钟，统一使用 `tokio::time::Instant`，`tokio/test-util` 仅限 `[dev-dependencies]`）；挂钟与日历期限逻辑（`cron`、`remote`、`media`、`patrol`）注入 `Clock` / `ManualClock`（[clock.rs](crates/core/src/clock.rs)）。真正依赖原子内存序的四处并发内核（`SliceWakeGate`、`AcpTurnMachine`、`SessionGenerationTable`、`TeardownGate`）抽离至独立子模块并通过 `cargo xtask loom`（`--features loom`）做穷举交错模型检验，业务模块中不出现 `#[cfg(loom)]`。

### 契约、规则和数据库

- **契约以 Rust 为源，生成 TS**：`crates/protocol/src/contract/` 的类型是数据源，`cargo xtask protocol --write` 写出 `packages/protocol` 的 `shapes.gen.ts` 与 `endpoints.gen.ts`，`cargo test` 里的 `tests/typescript.rs` 查最新；页面在边界解码用的 Zod Schema 与 `api.ts` 手写，由 `schema.test.ts`、`api.test.ts` 对着生成物查。词典在 `crates/i18n/locales/`，`vp run i18n:gen` 写出 TS 目录。
- **生成文件不手改**：`packages/protocol` 的 `*.gen.ts`、`packages/protocol/src/client.ts`、`packages/i18n/src/catalogs.ts`、`iconPaths.gen.ts`（`vp run icons:gen`）、[capabilities.md](docs/reference/capabilities.md) 由脚本生成并有检查。
- **双后端数据库单库分工（SQLite + PostgreSQL）**：桌面宿主 `state.db` 保留 SQLite（`apps/mac/crates/workspace` 使用 `SeaORM` + `SeaQuery`）。服务端全业务域、工单账本与 `durable::SeaOrmStorage` 共用唯一的 `Database`（`crates/server/src/db/mod.rs`），基于 `SeaORM 2.0.4` + `SeaQuery` 同时支持 SQLite 与 PostgreSQL：默认 SQLite 模式在 `server.db` 启用 WAL、外键约束与 `busy_timeout`，拆分多连接只读 `read_conn()`（`read_only(true)`，上限 6 连接并发 WAL 读）与单连接 `write_conn()`（`max_connections(1)` 串行写，SQLite 写事务统一使用 `BEGIN IMMEDIATE` 避免读写升级死锁），停机时协调执行 `PRAGMA wal_checkpoint(TRUNCATE)` 与 `PRAGMA optimize`；传入 `--database-url` / `VIBEVALLEY_DATABASE_URL`（`postgres://...`）时连接 PostgreSQL 连接池共享读写。启动时自动执行服务端与 `durable` 的 `Migrator::up`。全部业务查询通过顶层 `crates/server/src/service/`（`Service`，挂载于 `Context::service`）调用，其余模块禁止导入 `sea_orm::` 或 `db::entity`。
- **工单结算与持久执行共用写事务**：账本把工单事实、轮次和待投递结果写入调用方的 `SeaORM` `DatabaseTransaction`（经 `DbTx` 桥接持久执行存储）。一次业务写入占用一个保存点。外层批次提交成功后，服务才发布订阅通知。保存点回滚只撤销这一次写入。[事务](crates/runtime/src/agent/durable/store.rs) · [工单账本](crates/server/src/game.rs)
- **宿主 `state.db` 同用 SeaORM + SeaQuery**：宿主桌面独占存储（[宿主调用点](apps/mac/crates/workspace/src/store/mod.rs)）通过实体目录与 SeaQuery DDL（[schema.rs](apps/mac/crates/workspace/src/store/schema.rs)）建表与迁移（保留 `PRAGMA user_version = 1` 兼容），由 `cargo test -p vibevalley-workspace` 校验。

**提交耗时。** 在同一台 Apple Silicon Mac 上，release 构建用临时 WAL 库测量文档写入。每个并发线程写自己的文档 60 次，等待每次提交回执。两种驱动交错运行 11 轮。表中为各轮总延迟 p95 的中位数，单位为微秒。这个负载只覆盖持久写入。执行 `cargo run --release -p vibevalley-runtime --example commit_latency` 可分别看到进入回调、执行回调和等待回执的耗时。[基准程序](crates/runtime/examples/commit_latency.rs)

| 并发写者 | 原 rusqlite 批提交 | SQLx 批提交 |
| --- | --- | --- |
| 1 | 42 | 90 |
| 3 | 276 | 509 |
| 6 | 754 | 1027 |

- **按序加表与双后端迁移**：服务端与 `durable` 表结构通过 `SeaORM` 实体与前向增量 `Migrator`（`seaql_server_migrations` / `seaql_migrations`）管理，禁止直接原地修改已发布的迁移文件；SQLite 与 PostgreSQL 在建表与索引层面保持等价，启动时由 [verify.rs](crates/server/src/db/verify.rs) 自动核验表与列是否与实体一致，遇到旧版未跟踪迁移或结构漂移时快速失败并由桌面端展示诊断与备份重置入口。

### 测试金字塔

一个行为在能发现它出错的最低层测；高一层只验证新增的接线。

| 层 | 入口 | 位置 |
|---|---|---|
| 规则 | 纯函数 | 各 crate 的 `#[cfg(test)]`（如 `crates/core/src/core.rs`、`crates/core/src/scenario.rs`） |
| 模块 | 模块的类型、真 git、脚本农机（`vibevalley-runtime::oar` 的 `scripted`）、脚本模型 | `crates/server/tests/issue_board.rs`、`crates/server/tests/*.rs` |
| 服务端整体 | 起真的 `vibevalley-server`、经 HTTP | `crates/server/tests/start.rs`、`crates/cli/tests/cli.rs` |
| 页面 | `nsh/test`，样例的 `Transport` | `apps/mac/ui/app/*.test.tsx`、`apps/mac/ui/features/*/*.test.ts` |
| 纸雕场景 | 切片映射、开场资源与 `vibevalley-diorama` 单测 | `apps/mac/src/diorama/`、`apps/mac/crates/diorama/` |

- **不靠睡眠等待**：Rust 测试用 `until` 与 `TurnGate`（[support/mod.rs](crates/server/tests/support/mod.rs)）确定性同步轮次；TS 测试禁止写死 `setTimeout` 或 `waitForTimeout`（`vibevalley/no-test-sleep` 查）。
- **对照 golden**：`reduce` 与出帧、`note` 的规则对着 golden；`note` 的 golden 由 `cargo xtask goldens --check` 校验（`crates/core/tests/projection.rs`、`crates/core/tests/note_golden.rs`）。

### 话放在哪

- **对用户的话进词典**：`crates/i18n/locales/{zh,en}/<命名空间>.json`；TS 调 `t("key")`（`vibevalley/no-cjk-literal` 拦硬编码中文），Rust 调 `vibevalley_i18n::t`。`vibevalley-i18n` 将前端 `web.*` 词典收在可选特性 `web` 下（默认关闭，保持 `vibevalley-cli` 与独立服务端精简），仅 `crates/rich` 开启该特性并向 `apps/mac` 暴露原生 `VvI18n`（`"vibevalley/rich"` `.translate(...)`），使生产 UI 包无需打入 JS 词典；由 `vp run i18n:gen` 生成的 `@vibevalley/i18n` JS 词典目录（`packages/i18n/src/catalogs.ts`）专供 Node 脚本与无宿主 `nsh test` 按需加载。
- **词典检查覆盖两端**：`vpx scripts/gen/i18n.ts check` 检查缺键、未用键、语言（含 `zh` 非白名单纯英文残值守卫及 3+1 `NoteType` 全覆盖校验）与占位符；识别 TS 模板键和 Rust `format!` 动态键的字面量前缀。Rust 与 TS 的缺键都使检查失败，删词条时两种语言一起删，再运行 `vp run i18n:gen`。
- **对模型的话在 `assets/`**：助手的提示在 `crates/server/assets/orchestrator/prompts.json`，工具说明在 `crates/server/assets/tools/`，以 Rust 为准；中文编写，要求模型按用户的语言回答。
- **语言**：存于家目录 `settings.json` 的 `locale`（`vibevalley-protocol::home`）。

## 怎么走

**新增或修改表。** 服务端改 `crates/server/src/db/entity/<table_name>.rs`（严格一表一文件）、`crates/server/src/db/migration/` 与 `crates/server/src/service/`（或 `durable` 的实体/迁移），并保证 SQLite 与 PostgreSQL 测试均通过（`cargo test -p vibevalley-server --test dual_db`）。宿主 `state.db` 改 [宿主迁移与实体](apps/mac/crates/workspace/src/store/schema.rs) 后跑 `cargo test -p vibevalley-workspace`。[开发指南](docs/development.md)

**新增或修改接口**

1. 改 `crates/protocol/src/contract/<概念>.rs`，跑 `cargo xtask protocol --write` 重写 TS 类型；页面要用的同改 `packages/protocol/src/<概念>/` 的 `schema.ts`、`api.ts`。
2. 在 `crates/server/src/<概念>` 实现强类型异步处理方法，并在 [router.rs](crates/server/src/router.rs) 的编译期穷尽 `match` 中直委分发（非 RPC 流走 `GatewayPorts`）。
3. 跑 `vp run api:client`、`vp run capabilities` 更新生成的客户端与能力表。

## 为什么这样

- **只有一个服务端，Rust 的**：原生应用和命令行直接用它的类型；工程选择单机 Rust 控制面，只保留 macOS 桌面应用、Rust CLI 与独立移动端外壳。
- **扁平单数装配与 `{db,service}/` 硬边界**：放弃旧的多层人工分组目录（`work/`、`team/`、`collab/`、`content/`、`skin/`、`infra/`）与运行时 `Hub` 路由表，让目录直接反映无环 DAG 依赖；放弃把业务查询塞进 `db/` 或允许业务域直连 `sea_orm::`，由独立顶层 `service/` 统一承担持久查询并由 `arch-audit` 静态守卫。
- **独立 `vibevalley-mcp`（不塞进 `crates/protocol`，不含编码 agent 探测/安装）**：放弃把第三方开放 MCP 传输层和 `skill://` 解析放进 `crates/protocol`（避免污染前后端契约边界与拖慢无关 crate 编译），放弃引入碎片化的外部第三方 MCP SDK crate，也严格禁止把各编码 agent 探测/安装写进 `crates/mcp`（后者统一归属 OAR `crates/runtime/src/oar/`，`crates/mcp` 只提供纯 `McpServerConfig` 契约）。
- **零新依赖原生 `xtask` 导航与 QA 套件**：放弃引入 `syn`、`oxc_parser` 或外部 CLI（`ast-grep`、`jscpd`、`dependency-cruiser`、Python/Clojure 原工具），复用 `rust_scan.rs` 与纯 `std` 词法分析器保持秒级编译与跨端统一诊断格式；UML 查看器使用独立 `std::net::TcpListener` 单页服务，避免把离线工程分析视图耦合进 `apps/mac`。
- **服务端与宿主统一采用 SeaORM + SeaQuery**：单机用户无需外部数据库即可运行 SQLite WAL；服务端通过 `Database` 的 SeaORM 实体与异步查询同时支持 `--database-url` PostgreSQL 部署，桌面宿主 `state.db` 亦去除 `sqlc`/`sqlx` 生成器依赖，全部迁移至纯 Rust SeaORM + SeaQuery。
- **共享单一运行时与薄 `Router` 直委**：全部端点走异步 `Router` 编译期穷尽分发，全进程共用 `vibevalley_runtime::rt` 与 `TaskGroup`，避免为每个模块拆独立运行时导致跨运行时 `PoolConnection` 析构异常。
- **定向隔离 `loom`、不引入重型模拟网络栈**：`loom` 仅包裹四个纯原子并发内核而不侵入业务异步任务；以单宿主控制面为主，暂不引入 `turmoil` 整套网络模拟栈。
- **对模型的话保持中文、不进词典**：避免双份提示调优与评测漂移。

## 怎么验证

- `make rust`（`cargo xtask check`）：格式、clippy 与全部 Rust 测试。
- `make rust-audit`（`cargo xtask audit`）：静态校验扁平单数无环 DAG、`gateway/` 隔离、`{db,service}/` 数据边界（15 条 `arch-audit` 规则）以及异步并发棘轮（`SERVER_BLOCK_ON_CEILING`、`no-pollster`、`no-raw-git-command`、`no-sync-process-in-server`、`no-blocking-reqwest` 等）。
- `cargo xtask trace` / `map` / `deps` / `ssot-check` 与 `cargo xtask crap|dry|mutate|uml`：跨层追踪、门面复杂度、依赖环、跨端 SSOT 巡检与四件套质量门禁。
- `make protocol`（`cargo xtask protocol`）：生成的线上类型与 golden 是最新的。
- `vp check`、`vp run packages:check`、`vp run mac:check`、`vp run mobile:check`：TS 与原生页面（桌面与移动端）。
- `vp run docs:verify`：生成物（含 `icons.ts --check`）、词典（含中文纯英文残值守卫）、旧名字与文档链接。
