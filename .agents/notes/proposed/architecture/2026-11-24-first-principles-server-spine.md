# Agent Note: 服务端扁平化与单数架构重构

Status: proposed

## Problem

`crates/server` 在[模块边界](xtask/src/boundaries.rs)与并发棘轮（[xtask/src/ratchets.rs](xtask/src/ratchets.rs)）收敛之后，仍存在四项结构债务：

1. **SQL 与内存影子库双写**：业务模块写入数据库后仍须构造 `Vec<Fact>` 经 `Hub::apply` 镜像到内存状态，启动时再由 15 条 SQL → `Fact` 路径重放恢复；字段定义与派生逻辑分散在协议形状、SQL 实体、启动水合、`reduce` 与切片投影 5 处，容易漂移。
2. **多套因果机制与跨层直连 SeaORM**：域间通信并存直接调用、字符串动态路由 `Hub::invoke`、隐式异步事件扇出 `EventBus` 与分散的局部 outbox 表；各业务域直接导入 `sea_orm::` 与数据库实体，查询逻辑分散且难以统一守护双后端（SQLite / PostgreSQL）兼容。
3. **多层人工分组与动态中心装配**：源码按 `work/`、`team/`、`collab/`、`content/`、`skin/`、`infra/`、`transport/`、`app/` 多层嵌套，跨层路径长且归属模糊（例如附件放在 `content/` 却被多域共用）；入口分裂为 `app/bootstrap.rs`、`Started` 与星型中心 `Hub`（两张运行时 handler `HashMap`、9 个晚绑定 `attach_*` 槽位），停机生命周期分散在 `ShutdownList`、`TaskTracker` 与自持弱引用中。
4. **半同步 `block_on` 墙与复数命名混用**：服务端内部仍存在 `vibevalley_runtime::rt::block_on` 阻塞边界，且服务、目录与结构体混用复数名。

## Proposal

采用一步到位直接切换（Direct Cutover），不保留 `Hub`、兼容垫片或双模过渡桥，将 `crates/server` 收敛为扁平、全单数、浅层装配的四块结构，所有命名使用通用工程词，不造生僻概念名。

### 1. 入口与浅层装配

- **启动链路**：`main.rs` → `log::init(...)` → `create_app(config).await?` → `gateway::serve(...)`。
- **`app.rs`**：提供不可变组合根 `App`、`create_app(config)` 与 `App::close()`（取代 `app/bootstrap.rs`、`Started` 与 `Hub`），按无环依赖顺序构造全部基础服务与业务域，停机时统一取消 `TaskGroup` 并关闭数据库连接池。
- **`router.rs`**：约 200 行薄入口门 `Router`，集中处理 `check_can` 权限校验、`trace_id` span、`FaultGate`、`InvokeObserver` 与订阅表鉴权，对 `crates/protocol` 生成的 202 个 `EndpointId` 与 7 个 `NativeEndpointId` 做编译期穷尽 `match` 分发并直委各域处理器；非 RPC 流与端口拆出为薄 `GatewayPorts`，彻底删除运行时 handler `HashMap` 与所有 `attach_*` 晚绑定槽位。

### 2. 共享地基与可观测性

- **`log/`**：统一日志与追踪初始化（`init`）、请求 span 与跨任务上下文传播（`span`、`spawn_traced`、`spawn_blocking_traced`）以及调用观察接口（`observer`：`InvokeObserver`）。
- **`db/`**：双后端（SQLite / PostgreSQL）`Database` 连接池、`migration/`、仅模块内可见的 `pub(super) mod entity;` 与统一查询服务层 `db/service/`（`DbService` 聚合 `outbox`、`storage`、`channel`、`connector`、`artifact`、`session`、`issue`、`memory`、`cron`、`remote`）。**硬规矩：`crates/server/src/db/` 之外禁止出现任何 `sea_orm::` 导入或实体访问。**
- **`context/`**：共享上下文 `Context`（字段名 `ctx`，持有 `db: Arc<DbService>`、`task: TaskGroup`、`live: Arc<LiveState>`、`outbox: Arc<Outbox>`、`feed: Arc<StateFeed>`、`clock: SharedClock` 及 HTTP/下载客户端），并收拢 `error.rs`（业务错误与 `RequestKeys` 幂等键）、`http.rs`、`text.rs` 与仅用于打破循环的最小 `port.rs`（如 `SessionDriver`）。
- **`storage/`**：统一文件、附件与媒体输入存储（`Storage`），消除跨域探入旧 `content/attachment`。
- **顶层基础文件**：`setting.rs`（`Setting`）、`provider.rs`（`Provider`）、`repo.rs`（`Repo`）。

### 3. 外部接入层（`gateway/`）

- 合并旧 `transport/` 与 `infra/remote/`，内含 `api/`（服务契约与非 RPC `GatewayPorts`）、`bridge/`（GPUI 进程内桥）、`http/`（Axum HTTP / SSE / `/mcp` / `/api/v1/attachment/{id}` / `/api/v1/machine/ws` 网关）与 `remote/`（默认关闭的受认证远程监听门与配对控制）。
- `gateway/` 只通过 `Router` 与 `GatewayPorts` 访问服务端，禁止导入任何业务域模块；对外 HTTP `v1` 路径、JSON 线缆契约与 SSE `Last-Event-ID` 语义保持不变。

### 4. 扁平深业务域（全单数命名）

全部业务域平铺于 `crates/server/src/` 顶层，目录与字段一律采用单数；深业务域主结构体统一为 `<domain>::Service`，单概念与基础模块使用朴素单数名（`Storage`、`Setting`、`Provider`、`Repo`、`Game`）：

| 模块 | 内部子模块 | 说明 |
|---|---|---|
| `runtime/` | `session/`、`worktree/` | 纯执行会话运行时与 git worktree 管理，经 `SessionDriver` 与 `agent/` 解耦 |
| `agent/` | `profile/`、`memory/`、`tool/`、`mcp/`、`orchestrator/` | 角色档案、记忆、工具、MCP 与主助手 |
| `issue/` | `board`、`edit`、`family`、`refine`、`pull/`、`chat` | 任务板、编辑、父子任务、起草、PR 与任务话题 |
| `artifact/` | `block`、`entry`、`collab`、`library`、`media/` | 块文档、结构化条目、协同、媒体库与媒体任务 |
| 其余扁平域 | `channel/`、`connector/`、`cron/`、`voice/`、`machine/`、`debug/`、`game.rs`、`fake/` | 频道、连接器、定时任务、语音、运行机器、诊断包、游戏账本与测试替身 |

### 5. 数据流、纯投影与落地顺序

- **单一真源与切片投影**：持久化写入只经 `ctx.db`（`DbService`）落库并在同一事务写入 `Outbox`（`outbox_item` 表），返回脏掩码 `SliceMask` 后调用 `ctx.mark_dirty(mask)`；`StateFeed` 对脏切片做单航班合并，调用 `crates/core/src/projection.rs` 纯函数与 `LiveState` 瞬态流生成 6 路切片（`board`、`sessions`、`collab`、`inbox`、`ops`、`farm`）写入 `tokio::sync::watch`。运行中会话流、心跳与农场特效只进 `LiveState`，不入库。
- **落地顺序**：
  1. 锁定架构、核心状态与[命名规范](docs/style/naming.md)文档。
  2. 抽出全部 SeaORM 查询进入 `crates/server/src/db/service/`，并将 `db/entity/` 设为 `pub(super)`。
  3. 建立 `NativeEndpointId`、`log/`、`context/`、`storage/` 与顶层基础文件（`setting.rs`、`provider.rs`、`repo.rs`、`fake/`）。
  4. 扁平迁移 `runtime/`、`agent/`、`issue/`、`artifact/`、`channel/`、`connector/`、`cron/`、`voice/`、`machine/`、`debug/`、`game.rs` 与 `gateway/`。
  5. 切换 `main.rs`、`app.rs` 与 `router.rs`，删除旧 `app/`、`transport/`、`work/`、`team/`、`collab/`、`content/`、`skin/`、`infra/` 及内存影子状态与 `EventBus`。
  6. 更新 `xtask` 静态边界检查与 `SERVER_BLOCK_ON_CEILING` 棘轮，跑通 SQLite + PostgreSQL 双后端与全仓验证。

## Alternatives considered

**保留多级分组目录（`work/`、`team/`、`collab/`、`content/`、`skin/`、`infra/`）**：多一层人工分类目录会拉长导入路径，并制造跨组共享模块（如附件、仓库、远程访问）的归属歧义；平铺顶层单数模块在目录层面直接反映真实依赖边界，配合 `xtask` DAG 检查更清晰。

**允许各业务域直接调用 `sea_orm::`**：查询语句和双后端兼容细节分散到十余个业务域后，静态审计与查询优化成本倍增；集中到 `db/service/` 并将 `entity/` 设为 `pub(super)`，让编译器直接守住数据访问边界。

**渐进式 / 双模过渡桥**：在过渡期同时维护 `Hub` 垫片、新旧两套路由与半影子状态会成倍增加双写漂移风险；服务端内部受[不留兼容](AGENTS.md#规矩)约束，直接切换成本更低。

## Acceptance criteria

- `crates/server/src/` 完成扁平单数布局：`main.rs`、`app.rs`、`router.rs`、`log/`、`db/`、`context/`、`storage/`、`setting.rs`、`provider.rs`、`repo.rs`、`gateway/` 与全部顶层业务域到位；旧 `app/`、`transport/`、`work/`、`team/`、`collab/`、`content/`、`skin/`、`infra/` 全部删除。
- `crates/server/src/db/` 之外零 `sea_orm::` 导入，且 `db/entity/` 为 `pub(super)`。
- `router.rs` 对 202 个 `EndpointId` 与 7 个 `NativeEndpointId` 实现编译期穷尽 `match` 分发，零运行时 handler `HashMap` 与 `attach_*` 晚绑定槽位。
- `xtask/src/ratchets.rs` 中 `SERVER_BLOCK_ON_CEILING` 降至仅保留同步宿主与启动边界；`xtask/src/boundaries.rs` 守住扁平模块 DAG、`gateway/` 隔离与 `db/` 私有边界。
- SQLite 与 PostgreSQL 双后端测试全绿；`make verify`、`make rust-loom`、`vp run mac:check`、`vp run mobile:check`、`vp run site:check`、`vp run docs:verify` 与 `vp run deadcode` 全部通过。

## Risks

- **PostgreSQL 切片重投影延迟**：移除内存影子库后，脏切片重投影直接经 `DbService` 查询当域视图；通过合理索引、`SliceMask` 单航班合并去抖及高频瞬态走 `LiveState` 控制延迟。
- **像素农场特效时序**：农场特效改为经 `LiveState` 突发注入 `FarmFrame`；通过 CPU 像素场景确定性测试校验帧序列不回退。
- **对外契约与回归兼容**：扁平化重组须保持对外 HTTP `v1` 线缆契约、SSE `Last-Event-ID` 续读与全流程回归测试（`scripts/release/regression.ts`）零破坏。
