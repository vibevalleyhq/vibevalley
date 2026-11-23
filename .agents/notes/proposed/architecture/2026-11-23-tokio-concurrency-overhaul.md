# Agent Note: Tokio 并发模型收敛与同步阻塞清理

Status: proposed

## Problem

当前 Rust 服务端与 macOS 桌面外壳虽已引入共享 Tokio 运行时 [rt.rs](crates/runtime/src/rt.rs)（`vibevalley-io`），但业务层仍大量采用「自建 OS 线程 + `rt::block_on` 同步桥接 + 裸 `rt::handle().spawn`」混合模式。按主分支 `965e8a43c` 统计，并发原语分布如下：

| 指标 | 当前基线 | 暴露问题 |
|---|---|---|
| `rt::block_on` / `block_on` 调用 | 217 处 | 同步处理器与后台任务反复切回 Tokio 执行器，嵌套场景触发 `block_in_place` |
| `spawn_blocking` 调用 | 54 处 | 与裸 `std::thread::spawn` 混用，大量未纳入 `TaskTracker` 关机排空 |
| `std::thread::spawn` 调用 | 43 处 | 仅约 5 处属真正必要的 PTY / CoreAudio / FSEvents 阻塞线程，其余长期占用 OS 线程 |
| `thread::sleep` / `recv_timeout` | 23 / 22 处 | 阻塞线程内轮询与等待，取消延迟高且无法被 `CancellationToken` 即时唤醒 |
| `hub.spawn_task` vs `rt::handle().spawn` | 11 vs 22 处 | 约三分之二后台异步任务脱离 `Hub` 的 `TaskTracker` 管控 |
| `AtomicBool` 停止标志 | 25 处 | 分散维护停止状态，缺少层级取消传播 |
| `JoinSet` / `Semaphore` 使用 | 0 / 1 处 | 批量外呼与仓库扫描串行执行或无界扇出 |
| 根 [Cargo.toml](Cargo.toml) Tokio features | 缺少 `"process"` | 无法使用 `tokio::process::Command` 与 `.kill_on_drop(true)` 统一管控子进程超时 |

上述债项已导致五类直接运行时故障：

1. **桌面启动常驻线程钉死**：[late.rs](apps/mac/src/hosted/late.rs) 的 `LateServer` 未透传 `subscribe_slice()`、`subscribe_live()` 与 `slice_snapshot_json()`，导致 [hub.rs](crates/server/src/transport/bridge/hub.rs) 在服务端启动期间全部回退到阻塞 `watch_slice` + `"vibevalley-server-forward"` OS 线程，Mac 端每个宿主视图常驻钉死 6–15 条阻塞线程。
2. **`vibevalley-io` 工作线程饥饿**：[mod.rs](crates/server/src/modules/work/session/mod.rs) 的 `watch_session` 在异步任务内直接调用 `workspace_state_event`，后者同步执行 `rt::block_on`（SQLite 读/写配置）与 `std::fs` 文件读取，直接阻塞 Tokio I/O 工作线程。
3. **只读查询持写锁与粗粒度互斥锁**：[inputs.rs](crates/server/src/modules/content/media/inputs.rs) 的只读 `Inputs::list()` 开启 `BEGIN IMMEDIATE` 写事务并在持有 `self.inner.lock()` 期间执行 SQLite 查询，阻塞并发写事务与上传登记。
4. **桌面退出阻塞 GPUI 主线程**：[main.rs](apps/mac/src/main.rs) 与 [mod.rs](apps/mac/src/shell/mod.rs) 在 GPUI `on_app_quit` 的 `async move` 块内调用 `std::thread::spawn(...).join()`，同步挂起 GPUI 主线程等待服务关机。
5. **关机与 `ServerDb::close()` 竞态**：`orchestrator::work_async`（[mod.rs](crates/server/src/modules/team/orchestrator/mod.rs)）、`sessions::pump_async` 与子代理对账（[sessions.rs](crates/server/src/modules/work/session/sessions.rs)）、`media::jobs`（[jobs.rs](crates/server/src/modules/content/media/jobs.rs)）、`channel::embed_later`（[mod.rs](crates/server/src/modules/collab/channel/mod.rs)）和 `voice`（[mod.rs](crates/server/src/modules/collab/voice/mod.rs)）绕过 `Hub` 的 `TaskTracker` 裸派发，[start.rs](crates/server/src/start.rs) 执行 `ServerDb::close()` 时后台任务仍在读写已关闭连接池。

## Proposal

采用 **P0 → P1 → P2** 三阶段收敛路线，在不破坏 [architecture-topology.md](docs/architecture-topology.md) 规定的模块边界（`L0`–`L3` DAG 与 `mac-no-server-module-import`）的前提下，先清除线上阻塞与关机竞态，再完成并发原语与端到端异步收敛。

### P0：Wave 4 前置止血（随 Wave 4 落地）

1. **`LateServer` 异步就绪快速路径与移除转发线程**（[late.rs](apps/mac/src/hosted/late.rs)、[mod.rs](crates/server/src/transport/api/mod.rs)、[hub.rs](crates/server/src/transport/bridge/hub.rs)）
   - 在 `Server` trait 新增带默认空实现的 `ready_async(&self) -> Option<BoxFuture>`（或等价异步就绪通知接口），`LateServer` 内部以 `tokio::sync::watch` / `Notify` 暴露异步就绪状态，并透传 `subscribe_slice()`、`subscribe_live()` 与 `slice_snapshot_json()`。
   - [hub.rs](crates/server/src/transport/bridge/hub.rs) 在监听 `slice:*` 与 `live` 时，如 `server.ready_async()` 返回等待未来，先在 Tokio 异步任务中 `select!` 等待就绪或取消，再直接进入零线程 `WatchStream` / `broadcast::Receiver` 快速路径；删除 `LateServer` 中的 `"vibevalley-server-forward"` OS 线程，Mac 端收回 6–15 条常驻阻塞线程。
2. **`watch_session` 移出异步工作线程的同步阻塞**（[mod.rs](crates/server/src/modules/work/session/mod.rs)）
   - 将 `watch_session` 首次与轮询路径中的 `workspace_state_event(session, &sessions)` 迁入 `tokio::task::spawn_blocking`，阻止 SQLite 查询、`rt::block_on` 与 `std::fs` 读取占用 `vibevalley-io` 异步工作线程。
3. **`Inputs::list()` 移除只读写锁与缩小锁粒度**（[inputs.rs](crates/server/src/modules/content/media/inputs.rs)）
   - 将 `Inputs::list()` 从 `BEGIN IMMEDIATE` 写事务改为普通只读查询（通过 `self.db.run(...)` 顺序执行 `list_inputs` 与 `pinned_inputs`）。
   - 在执行数据库查询前释放 `self.inner.lock()`，仅在极短临界区内拷贝内存中的 `uploading` 集合快照再组装返回结果。
4. **`apps/mac` 非阻塞退出**（[main.rs](apps/mac/src/main.rs)、[mod.rs](apps/mac/src/shell/mod.rs)）
   - 将 `on_app_quit` 的 `async move` 块内 `std::thread::spawn(...).join()` 替换为 `cx.background_executor().spawn(async move { ... }).await`，保证落盘、关闭终端与服务关机在后台线程完成后退出，同时不阻塞 GPUI 主线程事件循环。
5. **关机排空与 `TaskTracker` 统一收口**（[lib.rs](crates/server/src/lib.rs)、[start.rs](crates/server/src/start.rs) 及 5 个业务模块）
   - 在 `Hub` 新增 `spawn_blocking_task`，底层委托 `self.tasks.spawn_blocking_on(..., vibevalley_runtime::rt::handle())`。
   - 将以下后台任务统一经 `hub.spawn_task` / `hub.spawn_blocking_task` 派发并响应 `hub.child_token()` 取消：
     - `team/orchestrator`：`Orchestrator::work_async`（[mod.rs](crates/server/src/modules/team/orchestrator/mod.rs)）；
     - `work/session`：`Sessions::pump_async` 与子代理启动对账（[sessions.rs](crates/server/src/modules/work/session/sessions.rs)）；
     - `content/media`：`Jobs::sweep_each_minute`、流事件延迟清理任务及媒体作业后台任务（[jobs.rs](crates/server/src/modules/content/media/jobs.rs)）；
     - `collab/channel`：`Chat::embed_later` 链接预览抓取（[mod.rs](crates/server/src/modules/collab/channel/mod.rs)）；
     - `collab/voice`：`Voice::tell` 与 `MossLine::heard` 中的 `orchestrator.brief` 调用（[mod.rs](crates/server/src/modules/collab/voice/mod.rs)）。
   - [start.rs](crates/server/src/start.rs) 的 `Started::close()` 保持 `self.hub.close()` 位于 `self.db.close()` 之前，并为 `Hub::close()` 中的 `tasks.wait()` 设置有界宽限超时，防止异常阻塞任务拖死测试或退出。

### P1：Wave 5 — Tokio 并发模型全面收敛

1. **统一异步子进程超时原语**
   - 在根 [Cargo.toml](Cargo.toml) 为 `tokio` 启用 `"process"` feature。
   - 在 `vibevalley-runtime` 提供统一的 `run_command_with_timeout`（基于 `tokio::process::Command` + `.kill_on_drop(true)` + `tokio::time::timeout`），迁移 [tailscale.rs](crates/server/src/modules/infra/remote/tailscale.rs)、[publish.rs](crates/server/src/modules/work/pull/publish.rs) 与 [grader.rs](crates/runtime/src/agent/eval/grader.rs)，与 `feat/w4-macos-oar-async` 对 [process.rs](crates/runtime/src/oar/process.rs)、[bash.rs](crates/runtime/src/agent/tools/bash.rs) 及 [mod.rs](apps/mac/src/update/mod.rs) 的异步迁移形成完整覆盖。
2. **消除剩余服务端自建 OS 线程与伪异步 I/O**
   - `content/artifact`（[blocks.rs](crates/server/src/modules/content/artifact/blocks.rs)、[collab.rs](crates/server/src/modules/content/artifact/collab.rs)、[entries.rs](crates/server/src/modules/content/artifact/entries.rs)）：4 条订阅流迁至 `hub.spawn_task` + `broadcast` + `tokio::select!`。
   - `collab/connector`（[bridge.rs](crates/server/src/modules/collab/connector/bridge.rs)）：直接在 `hub.spawn_task` 中运行 `async fn Adapter`，移除每个连接器 2–3 条 OS 线程与 `block_on` 胶水。
   - `team/agent`（[runtime.rs](crates/server/src/modules/team/agent/runtime.rs)）：以 `JoinSet` + `tokio::join!` + `tokio::time::timeout` 替换 `within()` 临时线程扇出。
   - `content/media`（[jobs.rs](crates/server/src/modules/content/media/jobs.rs)）与 HTTP 媒体流（[media.rs](crates/server/src/transport/http/media.rs)）：媒体作业调度迁至 `hub.spawn_task` + 按作业类型 `Semaphore`；HTTP 媒体文件读取改用 `tokio::fs::File`，消除每 64 KiB 块循环调用 `spawn_blocking`。
3. **有界并行扇出（`JoinSet` + `Semaphore` / `buffer_unordered`）**
   - 将串行或无界扇出的多目标操作收敛为有界并发：`repo.refresh_github`、`repo.summaries`、`repo.contributions_of`（[repo.rs](crates/server/src/modules/work/repo.rs)）、`pull::poll`（[mod.rs](crates/server/src/modules/work/pull/mod.rs)）、`runtime.refresh_usage`（[runtime.rs](crates/server/src/modules/team/agent/runtime.rs)）、`channel::embed_later`（[mod.rs](crates/server/src/modules/collab/channel/mod.rs)）以及 `McpHub::connect`（[mod.rs](crates/runtime/src/agent/resources/mcp/mod.rs)）。
4. **SQLite 读写池拆分与结构化取消**
   - 在 `ServerDb`（[base.rs](crates/server/src/base.rs)）拆分 `read_pool`（`read_only(true)` WAL 多连接并发读）与 `write_pool`（`max_connections(1)` 串行写，避免 `SQLITE_BUSY` 写写互锁）。
   - 将 `Chat`（[mod.rs](crates/server/src/modules/collab/channel/mod.rs)）的全局 `Mutex<Inner>` 从纯读路径剥离。
   - 为 [chat.rs](crates/server/src/modules/work/chat.rs) 的 `await_comment_delivery` 补充硬超时上限，防止投递异常导致调用方无限等待。
   - 用层级 `CancellationToken` 与 `TaskTracker` 并行关机替换全仓 25 处 `AtomicBool` 停止标志及自定义 `flume` 取消令牌（[stream.rs](crates/runtime/src/agent/ai/stream.rs)、[scheduler.rs](crates/runtime/src/agent/durable/scheduler.rs)）。

### P2：渐进式端到端异步化

- **双轨端点派发**：在 `Hub` 新增 `Hub::on_async<O: Op>` 并在 `Server` trait 新增 `call_async`，HTTP 与桌面桥接优先走异步路径；纯内存处理器（只读 `Core` 或极短内存计算）保留同步 `Hub::on`，避免无意义的 `BoxFuture` 分配。
- **按热点模块渐进迁出 `rt::block_on`**：优先将数据库与网络 I/O 密集的模块（`channel`、`artifact`、`media`、`remote`、`pull`、`infra/http`）改为原生 `async fn`，逐步清零 `rt::block_on`。
- **统一持久执行存储连接池**：将 `durable::SqliteStorage`（[sqlite.rs](crates/runtime/src/agent/durable/sqlite.rs)）统一接入 `ServerDb` 的单写连接池，消除独立连接带来的 WAL 竞争。
- **移除 `pollster`**：清零 `rt::block_on` 的 current-thread 回退路径后，从根 [Cargo.toml](Cargo.toml) 移除 `pollster` 依赖。

## Alternatives considered

**一次性全量重写 `Server` trait 与全部模块处理器为 `async fn`**：全仓端点处理器与同步辅助函数超过两百处，一次性改写会制造不可审查的巨型差异，阻塞 Wave 4 交付，且纯内存读处理器改写为异步反而引入状态机分配开销。采用 P0 止血、P1 收敛原语、P2 双轨渐进异步的三阶段策略，每一步都可独立验证并立即带来线程与延迟收益。

**保留现有同步线程模型、仅调大 Tokio blocking 池与 SQLite `busy_timeout`**：调大线程池上限只能延后阻塞耗尽，无法回收 `LateServer` 在桌面端常驻的 6–15 条 OS 线程，也不能消除 GPUI 主线程退出卡死、`watch_session` 导致的 I/O 执行器饥饿以及关机时的连接池竞态。

**为每个服务端模块或桌面面板创建独立 Tokio `Runtime`**：多运行时会放大线程上下文切换，并导致 `sqlx::PoolConnection` 等绑定运行时的对象跨运行时 `Drop` 时 panic，同时破坏统一排空顺序。维持单一共享 `vibevalley-io` 运行时并以 `Hub` 的 `TaskTracker` + `CancellationToken` 统一收口是最小复杂度方案。

**取消 `LateServer` 抽象、让 `apps/mac` 直接持有 `Arc<Hub>`**：桌面启动需要立即渲染首帧并支持 `VIBEVALLEY_FAKE_SERVER` 离线替身，且 `apps/mac/src/` 不应直接依赖服务端内部模块。在 `Server` trait 上暴露可选异步就绪接口并由 `LateServer` 透传 `subscribe_slice` / `subscribe_live`，既保住边界约束又消除常驻阻塞线程。

## Acceptance criteria

- **P0（Wave 4 前置）**：
  - `LateServer` 单元测试覆盖 attach 前后调用 `subscribe_slice` 与 `subscribe_live`，证实走异步快速路径且不再创建 `"vibevalley-server-forward"` 线程。
  - `watch_session` 不再在异步任务内直接调用 `workspace_state_event`；`Inputs::list()` 不再开启 `BEGIN IMMEDIATE` 且不在持 `self.inner` 互斥锁期间查询 SQLite。
  - `apps/mac` 的 [main.rs](apps/mac/src/main.rs) 与 [mod.rs](apps/mac/src/shell/mod.rs) 退出回调中不再存在 `std::thread::spawn(...).join()`。
  - 5 类后台任务全部经 `Hub` 的 `TaskTracker` 派发，`Started::close()` 在 `ServerDb::close()` 之前完成 `Hub::close()` 排空。
  - `cargo fmt --check`、`cargo clippy -p vibevalley-server -p vibevalley-mac --all-targets -- -D warnings`、`cargo nextest run -p vibevalley-server -p vibevalley-mac`、`vpx scripts/audit/module-boundaries.ts` 与 `vp run docs:verify` 全部通过。
- **P1（Wave 5）**：
  - 服务端非必要 `std::thread::spawn` 清零（仅保留 PTY / CoreAudio / FSEvents 等必需阻塞线程）；根 [Cargo.toml](Cargo.toml) 启用 `"process"` 且超时子进程均通过统一原语回收。
  - `ServerDb` 拆分读写池且在并发读写压测下无 `SQLITE_BUSY` 回归；批量外呼均由 `JoinSet` + `Semaphore` 限流；所有停止标志统一为 `CancellationToken`。
- **P2（端到端异步）**：
  - `Hub::on_async` 与 `Server::call_async` 上线，热点 I/O 模块清零 `rt::block_on`；`durable::SqliteStorage` 共用 `ServerDb` 写池；`pollster` 从工作区依赖移除。

## Risks

- **排空宽限超时与自等待死锁**：若在已受 `TaskTracker` 跟踪的任务内部调用 `Hub::close()`，或某阻塞任务未检查取消令牌（如长耗时网络/模型调用），`tasks.wait()` 会无限挂起。应对：禁止在后台任务内调用 `Hub::close()`；为 `Hub::close()` 的 `tasks.wait()` 增加有界超时（例如 5 秒），并在所有已纳入跟踪的循环中 `select!` 监听 `CancellationToken`。
- **`LateServer` 启动前取消与 `attach` 竞态**：若桌面视图在 `LateServer` 尚未就绪时即调用 `unwatch` 或关闭窗口，等待就绪的任务应立即退出而不悬挂。应对：在 [hub.rs](crates/server/src/transport/bridge/hub.rs) 等待 `ready_async()` 时始终以 `tokio::select!` 竞争 `task_cancel.cancelled()`，并通过单元测试覆盖启动前取消路径。
- **移除 `Inputs::list()` 写事务后的瞬态读一致性**：拆分 `list_inputs` 与 `pinned_inputs` 为无写锁只读查询后，极短窗口内新创建的 pin 可能尚未反映在列表快照中。应对：`list()` 仅用于展示与提示 `can_delete`，真正删除前 `delete()` 与 `remove()` 仍会在 SQLite 原子条件语句中二次校验 pin 状态，保证不误删在用输入。
- **P1 读写连接池拆分的 WAL 可见性与写锁顺序**：拆分 `read_pool` 与 `write_pool` 后，若同一请求先写后读需保证 WAL 快照看到刚提交的写入。应对：单写连接提交后新获取的读连接在 WAL 模式下自动读取最新检查点，涉及「读后写」不变量的事务保持在 `write_pool` 单事务内完成。
