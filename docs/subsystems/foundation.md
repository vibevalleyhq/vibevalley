# 地基

服务端、命令行、原生应用和脚本共用的工程骨架：Cargo 工作区与 pnpm 工作区、深模块、边界一次解码的类型、契约的生成、双后端数据库存储（SQLite + PostgreSQL）与测试分层。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| Cargo 工作区（17 个成员：`crates/*`、`crates/engines/*`、`apps/mac`、`apps/mac/crates/*`）、pnpm 工作区（剩下的 TS 包与页面）、依赖版本、构建与检查 | 各 crate、各包的对外约定（各自的 `README.md` 或 `lib.rs` 开头） |
| 服务端六大业务域模块与传输层（`crates/server/src/{modules,transport}/`） | 各模块的业务行为（对应子系统文档） |
| 契约（`crates/protocol` 的 Rust 源与生成的 `packages/protocol` TS 类型） | 核心状态折叠与接口路由（[核心状态](docs/subsystems/core.md)） |
| 双后端数据库存储（SQLite + PostgreSQL）、表与实体归属哪个模块 | 业务表含义（各子系统）与家目录文件（[架构](docs/architecture.md#存了什么)） |
| 测试分层、测试用的替身农机 | 页面分层与宿主打包（[客户端](docs/subsystems/app.md)） |
| 词典（`crates/i18n/locales/`，编进 Rust 并生成 `packages/i18n`）与模型提示（`assets/`）分工 | 界面用词标准（[用语表](docs/README.md#用语)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `Cargo.toml`、`rust-toolchain.toml`、`rustfmt.toml` | Rust 工作区成员、工具链与格式 |
| `pnpm-workspace.yaml`、`vite.config.ts` | TS 工作区包列表、依赖版本 catalog、oxfmt 与 oxlint 配置、检查任务（`rust:check`、`docs:verify`…） |
| `scripts/{gen,audit,docs,release}/` | 工程脚本：`gen/`（契约、词典、令牌、97 枚 reicons 矢量路径 [icons.ts](scripts/gen/icons.ts) 与 sqlc 生成）、`audit/`（lint 插件、死代码、注释审查、Rust 静态模块边界门禁 [module-boundaries.ts](scripts/audit/module-boundaries.ts)）、`docs/`（Note、链接、术语与旧名检查）、`release/`（发版、回归与验收沙箱） |
| `crates/server/src/lib.rs`、`crates/server/src/base.rs`、`crates/server/src/start.rs` | `Hub`（核心状态、端点表、`Hub::invoke` / `invoke_async` 双轨命令总线、无条件 `trace_id` 与 `tracing::Span` 链路、无锁 `Slot<T>` 插槽与 `TaskTracker` 停机域）、双后端 `ServerDb`（`read_conn()` / `write_conn()`，SQLite 读写分离连接池 + PostgreSQL 连接池）与按 `L0`–`L3` 顺序组装并通过 `ShutdownList` 阶段排空的 `start` |
| `crates/server/src/db/{entities,migration}/` | 服务端 13 域双后端（SQLite + PostgreSQL）SeaORM 实体与迁移（含共享 `seq_counter` 与 `infra_remote` 远程配置/设备表，实体由 `module_boundaries` 测试锁死仅限所属域模块调用） |
| `crates/server/src/modules/`、`crates/server/src/transport/` | 按六大域分组的业务模块（`work`、`team`、`collab`、`content`、`skin`、`infra`，含 `infra/debug/` `DebugKit` 与 `infra/remote/` 远程访问控制）与传输层（`api`、`bridge`、`http`） |
| `crates/protocol/src/contract/`、`crates/protocol/tests/typescript.rs`、`crates/protocol/src/home.rs` | 线上类型（含 5 域切片、`FarmFrame`、`debug.rs` 的 `DebugKit`、[remote.rs](crates/protocol/src/contract/remote.rs) 的远程访问契约与 `host.rs` 的 `Host*` 帧/`HostAction`/`HostOp` 壳协议，`ts-rs` 写出 `packages/protocol` 的 `*.gen.ts`，`vp run protocol:check` 查最新）与家目录约定（`server.json`、语言） |
| `crates/core/src/` | 纯规则中心：`reduce`、`SliceMask` 与按域切片投影、状态派生、收件箱、依赖、挂钟抽象 [clock.rs](crates/core/src/clock.rs)（`Clock` / `ManualClock`）、定时任务（`cron/`）、作品引擎（`artifact/`） |
| `crates/runtime/src/` | 进程级共享 Tokio 运行时 `rt.rs`（`rt::handle`、`rt::current_or_global_handle`、`run_command_with_timeout`）、幂等析构门 `teardown_gate.rs`、`oar/` 驱动与自研 `agent/` 持久对话引擎（`execution.db`） |
| `crates/rich/`、`crates/engines/{onig,pele,shiki}` | 原生富内容组件与内部引擎（`canvas`、`chart`、`genui`、`pinyin`）及底层正则/高亮/图谱引擎 |
| `apps/mac/crates/workspace/src/store/mod.rs` | 原生应用外壳的 `state.db`（SQLite）：项目、终端与布局；连同 `pixel`、`terminal` 共 3 个桌面支撑 crate |
| `crates/i18n/src/lib.rs`、`crates/i18n/locales/` | 消息格式与词典；词典构建时编进去，前端 `web.*` 词典挂在可选特性 `web` 下（仅 `crates/rich` 开启） |
| `crates/server/src/testing.rs` | 测试和验收沙箱用的替身农机 `pi`（`VIBEVALLEY_TEST_RUNTIMES=1`） |
| `packages/protocol/src/<概念>/` | 页面用的契约：生成的 `shapes.gen.ts`，手写的 `schema.ts`（Zod）和 `api.ts`（额外导出或别名才设 `shapes.ts`）；`src/rules/` 是页面用的纯函数规则；`@vibevalley/protocol/remote`（[transport.ts](packages/protocol/src/remote/transport.ts)）导出零平台依赖的纯 Web Fetch `HttpRemoteTransport`（Bearer 鉴权、`Last-Event-ID` SSE 续读与 `vibevalley://pair` 解析）；`src/client.ts` 是生成的 `VibeValleyApi` |

## 模型和不变量

### 仓库和包

- **Rust 为准**：服务端（`vibevalley-server`）、命令行（`vibevalley-cli`）、原生应用（`apps/mac`）都是 Rust；TS 承接桌面工作台（`apps/mac/ui`）、独立原生移动端（`apps/mobile`，`nsh/mobile`，iOS 优先、Android 就绪）、4 个共用包（`packages/{protocol,i18n,testkit,tsrs}`）、官网（`apps/site`）与脚本，不维护浏览器应用与 Electron 桌面壳。
- **一个 Cargo 工作区（16 个 crate）**：成员按层组织为 `crates/*`（`protocol`、`i18n`、`core`、`git`、`files`、`runtime`、`rich`、`server`、`cli`）、`crates/engines/{onig,pele,shiki}`、`apps/mac` 与桌面支撑 `apps/mac/crates/{pixel,terminal,workspace}`（包名仍保留 `vibevalley-*`，使 `core` 不遮蔽 `::core`），版本与 edition 写在根 `Cargo.toml` 的 `[workspace.package]`，依赖各 crate 自己写；`vp run rust:check` 跑 `cargo fmt --check`、`cargo clippy -D warnings` 与 `cargo test`。
- **TS 依赖版本集中**：版本在 `pnpm-workspace.yaml` 的 catalog，各包写 `catalog:`（`scripts/audit/catalog.test.ts` 查）。
- **跨包走包名**：TS 跨包写 `@vibevalley/*`（`no-cross-package-path` 查）；`apps/mac/ui` 经 `nsh.json` 的别名解析它们；`packages/*` 的类型导出指向 `dist/*.d.ts`（`vp run packages:build`）。

### 模块和服务

架构、边界与测试如何共同设计，见[模块设计](docs/style/module-design.md)。

- **跨边界强类型协议化，进程内保持直调**：跨越运行时、渲染载体或进程边界的交互（`HostFrame`/`HostAction`/`HostOp`、`DebugKit`、`MachineWireFrame`、`Remote*`）统一收拢进 `crates/protocol` 强类型契约；同一 Rust 进程内业务模块之间（如 `modules/work/{issue,session,workplace}`）维持窄 trait 与直接调用，不引入进程内 JSON/RPC 或 `tower::Service` 包装层。
- **深模块与严格 `L0`–`L3` 无环 DAG**：每个模块对外一个类型和它的几个方法，里面的表、锁和线程不露出去；不靠一个带 `kind` 的入口复用多种操作。服务端模块收敛为 4 层无环 DAG（`L0` 共享契约与纯规则、`L1` 基础叶子模块、`L2` 四个互不直调的同级业务域 `work` / `collab` / `content` / `team/memory`、`L3` 编排与触发层，其中 `work/chat` 归属 `L3` 直连 `Board`/`Sessions` 与 `collab/channel::Chat`），跨域写入走强类型 `Hub::invoke` / `invoke_async`，异步反应走 `EventBus`，只读跨层依赖走窄 Port trait，脊柱与 `apps/mac/src/` 禁止导入具体业务模块；边界由 `vp run audit:boundaries`（[module-boundaries.ts](scripts/audit/module-boundaries.ts)）在 CI 与 `release:verify` 中强制拦截（详见 [目标架构与部署拓扑](docs/architecture-topology.md#32-总控端内部子模块与调用收敛control-plane)）。
- **按序不可变启动与阶段排空**：`start`（`crates/server/src/start.rs`）按 `L0` → `L1` → `L2` → `L3` 次序一次性打开模块并注入窄 Port，不留启动后置挂钩；停机通过 `ShutdownList` 按 `pre_drain` → `JoinSet` 有界并发排空 → `finalizers` 逆序收口，且 `Hub::close_async()`（排空 `TaskTracker` 与层级 `CancellationToken`）始终在 `ServerDb::close()` 之前完成。状态只经 `Hub::apply` 改，模块之间的上行反应经 `Hub` 的异步 `EventBus`（`Hub::subscribe_transitions`）。
- **操作与发言主体统一用 `Actor`**：`kind` 是 `user`、`agent`、`system`，`agent` 带 `role` 与 `forUser`；HTTP 来的是 `user`，助手的工具是 `agent`（`orchestrator`），`/mcp` 是 `agent`（`worker`），定时任务是 `system`。
- **同一个家目录只有一个工单板**：工单板在它的数据旁放一个锁文件，别的进程只能读快照（`Board::snapshot`）。

### 异步、资源与错误

- **边界解码一次，门内全是类型**：HTTP 的入参经 `decode`（`crates/server/src/lib.rs`，serde）按端点的类型解成结构体，解不开当场拒绝；GPUI 宿主桥的全部 40 个 `host.*` 调用在入口经 `HostOp::from_wire`（`crates/protocol/src/contract/host.rs`）一次性解码为封闭枚举后穷尽分发；文件、厂商响应、模型给的工具参数各在进门处解成结构体和 enum。门内不传 `serde_json::Value`，不按字符串分支。
- **统一结构化日志**：根 `Cargo.toml` 声明工作区 `tracing` 与 `tracing-subscriber`；`vibevalley-server` 与 `vibevalley-mac` 启动调用 `try_init()` 读取 `VIBEVALLEY_LOG`／`RUST_LOG`（未设且 `VIBEVALLEY_DEBUG=1` 时默认 `info`，否则 `warn`）。
- **钥匙是 `Secret`**：`settings.json` 里的钥匙读成 `Secret`（`crates/server/src/modules/infra/setting.rs`），打印只出提示。
- **拒绝带 `BizCode`**：对调用方的拒绝是 `ApiError`（带 `bizCode` 与 `next`），网关写成全信封；模块内部可分辨的失败是 `thiserror` 的 enum；预期的结果（合进去或冲突）返回 enum，不当错误。
- **双轨异步底座与共享运行时**：全进程共享唯一多线程 Tokio 运行时 `vibevalley_runtime::rt`（工作线程 `vibevalley-io-{n}`，初始化即安装 `rustls` `ring` 提供方，无 `pollster` 依赖）。`Hub` 对纯内存读取保留同步 `Hub::on` 避免多余 `BoxFuture` 分配，对数据库与网络 I/O 端点提供原生异步 `Hub::on_async`（对应 `Server::call_with_async`）；热读脊柱插槽封装为无锁 `Slot<T>`（`ArcSwapOption<Arc<T>>`），全局互斥锁用 `parking_lot`（无毒化），重试退避用 `backon`。后台异步与阻塞任务分别经 `Hub::spawn_task` / `spawn_blocking_task` 纳入 `TaskTracker` 与层级 `CancellationToken`；超时的外部子进程统一使用 `run_command_with_timeout`（`tokio::process::Command` + `.kill_on_drop(true)` + `tokio::time::timeout`），批量多目标外呼以 `JoinSet` + `Semaphore` 有界并发。
- **双轨无条件 `trace_id` 与 `tracing::Span` 传播**：`Hub` 的 `invoke`、`invoke_async`、`call_with`、`call_with_async` 在调用方未传入非零 `trace_id` 时无条件通过 `next_trace_id` 分配单调非零标识，并建立 `tracing::debug_span!("hub.op", op, trace_id, caller)`（异步路径使用 `.instrument(span)`，跨 `spawn_blocking` 以 `Span::current().in_scope(...)` 延续），使服务端模块、`sqlx`、macOS `OsLogLayer` 与 `oar-voyage/3` 记录自动关联。
- **两层确定性虚拟时钟与定向 `loom` 内核检验**：单调异步计时器经 [rt.rs](crates/runtime/src/rt.rs) 的 `rt::current_or_global_handle()` 派发（生产回落全局 `vibevalley-io` 运行时，`#[tokio::test(start_paused = true)]` 下附着当前线程测试时钟，统一使用 `tokio::time::Instant`，`tokio/test-util` 仅限 `[dev-dependencies]`）；挂钟与日历期限逻辑（`cron`、`remote`、`media`、`patrol`）注入 `Clock` / `ManualClock`（[clock.rs](crates/core/src/clock.rs)）。真正依赖原子内存序的四处并发内核（`SliceWakeGate`、`AcpTurnMachine`、`SessionGenerationTable`、`TeardownGate`）抽离至独立子模块并通过 `vp run rust:loom`（`--features loom`）做穷举交错模型检验，业务模块中不出现 `#[cfg(loom)]`。

### 契约、规则和数据库

- **契约以 Rust 为源，生成 TS**：`crates/protocol/src/contract/` 的类型是数据源，`vp run protocol:ts` 写出 `packages/protocol` 的 `shapes.gen.ts` 与 `endpoints.gen.ts`，`cargo test` 里的 `tests/typescript.rs` 查最新；页面在边界解码用的 Zod Schema 与 `api.ts` 手写，由 `schema.test.ts`、`api.test.ts` 对着生成物查。词典在 `crates/i18n/locales/`，`vp run i18n:gen` 写出 TS 目录。
- **生成文件不手改**：`packages/protocol` 的 `*.gen.ts`、`packages/protocol/src/client.ts`、`packages/i18n/src/catalogs.ts`、`iconPaths.gen.ts`（`vp run icons:gen`）、[capabilities.md](docs/reference/capabilities.md) 由脚本生成并有检查。
- **双后端数据库单库分工（SQLite + PostgreSQL）**：桌面宿主 `state.db` 保留 SQLite（`apps/mac/crates/workspace` 由 sqlc 生成编译期 SQLx 查询）。服务端全业务域、工单账本与 `durable::SeaOrmStorage` 共用唯一的 `ServerDb`（`crates/server/src/base.rs`），基于 `SeaORM 2.0.4` + `SeaQuery` 同时支持 SQLite 与 PostgreSQL：默认 SQLite 模式在 `server.db` 启用 WAL、外键约束与 `busy_timeout`，拆分多连接只读 `read_conn()`（`read_only(true)`，上限 6 连接并发 WAL 读）与单连接 `write_conn()`（`max_connections(1)` 串行写，SQLite 写事务统一使用 `BEGIN IMMEDIATE` 避免读写升级死锁），停机时协调执行 `PRAGMA wal_checkpoint(TRUNCATE)` 与 `PRAGMA optimize`；传入 `--database-url` / `VIBEVALLEY_DATABASE_URL`（`postgres://...`）时连接 PostgreSQL 连接池共享读写。启动时自动执行服务端与 `durable` 的 `Migrator::up`。
- **工单结算与持久执行共用写事务**：账本把工单事实、轮次和待投递结果写入调用方的 `SeaORM` `DatabaseTransaction`（经 `DbTx` 桥接持久执行存储）。一次业务写入占用一个保存点。外层批次提交成功后，服务才发布订阅通知。保存点回滚只撤销这一次写入。[事务](crates/runtime/src/agent/durable/store.rs) · [工单账本](crates/server/src/modules/work/ledger.rs)
- **宿主 `state.db` 仍用 sqlc + SQLx**：宿主桌面独占存储（[宿主调用点](apps/mac/crates/workspace/src/store/mod.rs)）继续通过 [sqlc 配置](sqlc.yaml) 与 [生成器](scripts/gen/sqlc-rust/generate.ts) 生成查询绑定，由 `vp run sql:check` 校验。

**提交耗时。** 在同一台 Apple Silicon Mac 上，release 构建用临时 WAL 库测量文档写入。每个并发线程写自己的文档 60 次，等待每次提交回执。两种驱动交错运行 11 轮。表中为各轮总延迟 p95 的中位数，单位为微秒。这个负载只覆盖持久写入。执行 `cargo run --release -p vibevalley-runtime --example commit_latency` 可分别看到进入回调、执行回调和等待回执的耗时。[基准程序](crates/runtime/examples/commit_latency.rs)

| 并发写者 | 原 rusqlite 批提交 | SQLx 批提交 |
| --- | --- | --- |
| 1 | 42 | 90 |
| 3 | 276 | 509 |
| 6 | 754 | 1027 |

- **按序加表与双后端迁移**：服务端与 `durable` 表结构通过 `SeaORM` 实体与 `Migrator` 管理，SQLite 与 PostgreSQL 在建表与索引层面保持等价。

### 测试金字塔

一个行为在能发现它出错的最低层测；高一层只验证新增的接线。

| 层 | 入口 | 位置 |
|---|---|---|
| 规则 | 纯函数 | 各 crate 的 `#[cfg(test)]`（如 `crates/core/src/core.rs`、`crates/core/src/scenario.rs`） |
| 模块 | 模块的类型、真 git、脚本农机（`vibevalley-runtime::oar` 的 `scripted`）、脚本模型 | `crates/server/tests/issue_board.rs`、`crates/server/tests/*.rs` |
| 服务端整体 | 起真的 `vibevalley-server`、经 HTTP | `crates/server/tests/start.rs`、`crates/cli/tests/cli.rs` |
| 页面 | `nsh/test`，样例的 `Transport` | `apps/mac/ui/app/*.test.tsx`、`apps/mac/ui/features/*/*.test.ts` |
| 像素场景 | 真的素材、样例帧，在 CPU 上画 | `apps/mac/src/pixel/tests.rs` |

- **不靠睡眠等待**：Rust 测试用 `until` 与 `TurnGate`（[support/mod.rs](crates/server/tests/support/mod.rs)）确定性同步轮次；TS 测试禁止写死 `setTimeout` 或 `waitForTimeout`（`vibevalley/no-test-sleep` 查）。
- **对照 golden**：`reduce` 与出帧、artifact 的规则对着 golden；artifact 的 golden 由 `vp run goldens` 校验与更新（`crates/core/tests/projection.rs`、`crates/core/tests/artifact_golden.rs`）。

### 话放在哪

- **对用户的话进词典**：`crates/i18n/locales/{zh,en}/<命名空间>.json`；TS 调 `t("key")`（`vibevalley/no-cjk-literal` 拦硬编码中文），Rust 调 `vibevalley_i18n::t`。`vibevalley-i18n` 将前端 `web.*` 词典收在可选特性 `web` 下（默认关闭，保持 `vibevalley-cli` 与独立服务端精简），仅 `crates/rich` 开启该特性并向 `apps/mac` 暴露原生 `VvI18n`（`"vibevalley/rich"` `.translate(...)`），使生产 UI 包无需打入 JS 词典；由 `vp run i18n:gen` 生成的 `@vibevalley/i18n` JS 词典目录（`packages/i18n/src/catalogs.ts`）专供 Node 脚本与无宿主 `nsh test` 按需加载。
- **词典检查覆盖两端**：`vpx scripts/gen/i18n.ts check` 检查缺键、未用键、语言与占位符；识别 TS 模板键和 Rust `format!` 动态键的字面量前缀。Rust 与 TS 的缺键都使检查失败，删词条时两种语言一起删，再运行 `vp run i18n:gen`。
- **对模型的话在 `assets/`**：助手的提示在 `crates/server/assets/orchestrator/prompts.json`，工具说明在 `crates/server/assets/tools/`，以 Rust 为准；中文编写，要求模型按用户的语言回答。
- **语言**：存于家目录 `settings.json` 的 `locale`（`vibevalley-protocol::home`）。

## 怎么走

**新增或修改表。** 服务端改 `crates/server/src/db/{entities,migration}/`（或 `durable` 的 `entities/migration`）与所属域模块，并保证 SQLite 与 PostgreSQL 测试均通过（`cargo test -p vibevalley-server --test dual_db`）。宿主 `state.db` 改 [宿主迁移](apps/mac/crates/workspace/sql/migrations) 与命名查询后运行 `sqlc generate`。[开发指南](docs/development.md)

**新增或修改接口**

1. 改 `crates/protocol/src/contract/<概念>.rs`，跑 `vp run protocol:ts` 重写 TS 类型；页面要用的同改 `packages/protocol/src/<概念>/` 的 `schema.ts`、`api.ts`。
2. 在 `crates/server/src/modules/<概念>` 用 `Hub::on_async`（I/O 端点）或 `Hub::on`（纯内存短读）注册处理函数。
3. 跑 `vp run api:client`、`vp run capabilities` 更新生成的客户端与能力表。

## 为什么这样

- **只有一个服务端，Rust 的**：原生应用和命令行直接用它的类型；工程选择单机 Rust 控制面，只保留 macOS 桌面应用、Rust CLI 与独立移动端外壳。
- **服务端采用 SeaORM + SeaQuery 双后端（SQLite 开箱即用，PostgreSQL 可选接入），宿主 `state.db` 保留 sqlc**：单机用户无需外部数据库即可运行 SQLite WAL；服务端通过 `ServerDb` 的 SeaORM 实体与异步查询同时支持 `--database-url` PostgreSQL 部署；桌面宿主 `state.db` 保持轻量级 sqlc + SQLx 绑定。
- **按端点特征分同步与异步、共享单一运行时**：纯内存读端点保持同步 `Hub::on`，I/O 端点走原生异步 `Hub::on_async`；全进程共用 `vibevalley_runtime::rt` 与 `TaskTracker`，避免为每个模块拆独立运行时导致跨运行时 `PoolConnection` 析构异常。
- **定向隔离 `loom`、不引入重型模拟网络栈**：`loom` 仅包裹四个纯原子并发内核而不侵入业务异步任务；以单宿主控制面为主，暂不引入 `turmoil` 整套网络模拟栈。
- **对模型的话保持中文、不进词典**：避免双份提示调优与评测漂移。

## 怎么验证

- `vp run rust:check`：格式、clippy 与全部 Rust 测试。
- `vp run audit:rust`：静态校验零 `pollster`、仅缩减 `rt::block_on(` 上限（`SERVER_BLOCK_ON_CEILING = 91`）与零睡眠边界。
- `vp run audit:boundaries`：静态校验脊柱、桌面宿主与服务端 `L0`–`L3` 分层边界及零循环依赖（纳入 `release:verify`）。
- `vp run protocol:check`：生成的线上类型与 golden 是最新的。
- `vp check`、`vp run packages:check`、`vp run mac:check`、`vp run mobile:check`：TS 与原生页面（桌面与移动端）。
- `vp run docs:verify`：生成物（含 `icons.ts --check`）、词典、旧名字与文档链接。
