# Rust 异步并发、网关、虚拟时钟与 Loom 规范

服务端、运行时、命令行与原生桌面壳运行在单一共享 Tokio 运行时上，并围绕强类型边界、双层确定性时钟、可模型检验状态机内核与 UI 离线程卸载收敛。本文规定 Rust 异步并发、Axum 网关、虚拟时钟测试、Loom 内核与富内容卸载的现行写法；模块边界与错误契约另见 [module-design.md](docs/style/module-design.md) 与 [architecture-topology.md](docs/architecture-topology.md)。

## Tokio 运行时与零阻塞

### 单一共享运行时

进程全局唯一的 Tokio 多线程运行时由 [rt.rs](crates/runtime/src/rt.rs) 维护（工作线程名为 `vibevalley-io-<n>`，线程数读取 `VIBEVALLEY_IO_WORKERS` 并钳位在 `1–16`，缺省按硬件并发数钳位在 `2–4`）。工作区不应引入额外异步执行器或 `pollster`，跨同步/异步边界统一通过 `vibevalley_runtime::rt` 暴露的四项原语协作：

| 原语 | 职责 | 适用边界 |
|---|---|---|
| `rt::handle()` | 返回全局 `vibevalley-io` 运行时 `&'static Handle` | 跨运行时生命周期托管任务（如绑定 OS socket 的长期监听器） |
| `rt::current_or_global_handle()` | 优先返回当前 `Handle::try_current()`，不在 Tokio 中则回落 `rt::handle()` | 所有需附着到测试虚拟时钟的服务端与运行时后台任务 |
| `rt::spawn()` | 直接派发到全局 `vibevalley-io` | 不参与测试虚拟时钟的全局长驻后台动作 |
| `rt::block_on()` | 仅在纯同步入口桥接 Future（多线程下走 `block_in_place`，单线程下进入上下文并 `park`） | CLI / 同步测试 / `Started::close()` 根入口；严禁进入异步链路 |

### 异步处理函数与 `Drop` 禁 `rt::block_on`

在 `async fn` 处理器、Tokio 工作任务或异步回调内部不应调用 `rt::block_on`。阻塞工作线程会引发线程池饥饿，并在 `CurrentThread` 运行时上触发死锁或 panic。

所有持有后台任务与订阅的服务端组件应提供原生异步关闭入口 `close_async(&self)`（见 [lib.rs](crates/server/src/lib.rs) 的 `Hub::close_async`、[event_bus.rs](crates/server/src/event_bus.rs) 的 `EventBus::close_async` 与 `Subscription::close_async`、[mod.rs](crates/server/src/transport/http/mod.rs) 的 `Listener::shutdown`、[repo.rs](crates/server/src/modules/work/repo.rs) 的 `Repos::close_async`、[mod.rs](crates/server/src/modules/work/pull/mod.rs) 的 `Pulls::close_async`、[journal.rs](crates/server/src/modules/work/session/journal.rs) 的 `Trajectories::close_async` 与 [mod.rs](crates/server/src/modules/infra/remote/mod.rs) 的 `Remote::close_async`）。只需在释放时触发取消的结构应直接持有 `CancellationToken::drop_guard()` 返回的 `DropGuard`，不手写仅调用 `cancel()` 的 `impl Drop`（如 `Hub` 与 [mcp_proxy.rs](crates/cli/src/machine_agent/mcp_proxy.rs) 的 `LocalMcpProxy`）。

### `apps/mac/src` 零 `rt::handle`

桌面宿主 `apps/mac/src/` 不应直接调用 `vibevalley_runtime::rt::handle()` 或 `rt::spawn()` 绕过服务端生命周期。GPUI 界面后台动作应经 `cx.background_executor()` 调度，服务端请求统一通过 `Server::call_with_async` 或桌面桥接发出，保证关闭窗口与退出应用时无脱管后台任务。

### `BridgeHub` 并发配额

桌面宿主视图在 [mod.rs](apps/mac/src/hosted/mod.rs) 中以 `BRIDGE_CONCURRENCY = 16` 初始化 `vibevalley_server::transport::bridge::Hub::new(server, BRIDGE_CONCURRENCY)`，配合 [bridge.rs](apps/mac/src/hosted/bridge.rs) 的 `Outbox` 按 topic 对连续相同帧做载荷去重。保留 `16` 个并发配额可避免多标签页慢速 `session.openWorkspace` 握手占满桥接队列，饿死 `session.send`、`channel.message.send`、`runtime.list` 与工单变更等高频交互 RPC。

### `tokio-util` 流式 I/O 与 UTF-8 行解码

根 [Cargo.toml](Cargo.toml) 为 `tokio-util` 启用 `"rt"`、`"io"`、`"io-util"` 与 `"codec"`。跨异步流与字节分块边界的适配应使用以下原语，禁止手写 `Vec<u8>` 分片缓冲或裸 UTF-8 切片：

- **SSE / NDJSON 行解码**：应使用 `FramedRead::new(StreamReader::new(stream), LinesCodec::new())`（见 [deepseek.rs](crates/runtime/src/agent/ai/providers/deepseek.rs) 与 [remote.rs](apps/mac/src/hosted/remote.rs)）。严禁对单个 TCP byte chunk 直接调用 `String::from_utf8_lossy`，否则跨分片的多字节 UTF-8 中文字符会被截断成替换符。
- **异步流转同步 `Read`**：在 `spawn_blocking` 线程内消费 HTTP 请求或响应体时，应使用 `SyncIoBridge::new(StreamReader::new(stream))`（见 [media.rs](crates/server/src/transport/http/media.rs) 与 [http.rs](crates/server/src/modules/infra/http.rs)），不可在 Tokio 异步工作线程直接调用 `SyncIoBridge::read`。
- **范围文件分块下载**：应使用 `ReaderStream::with_capacity(file.take(length), FILE_STREAM_CHUNK_BYTES)`（`FILE_STREAM_CHUNK_BYTES = 64 * 1024`，见 [mod.rs](crates/server/src/transport/http/mod.rs) 的 `file_range_stream`），在保证流式背压的同时对截断文件返回 `UnexpectedEof`。

## Hub 与 Axum 网关收敛

### `Hub::on_async` 与 `spawn_blocking_traced` 边界

[lib.rs](crates/server/src/lib.rs) 为端点与订阅提供双轨派发：

- I/O 密集或长耗时端点应使用 `Hub::on_async::<O, _, _>`（入参 `AsyncCtx`）与 `Hub::on_subscription_async`，在 Tokio 任务上直接挂起等待而零 OS 线程占用。
- 纯内存短读取或极短计算端点可保留同步 `Hub::on::<O>`，避免无谓的状态机装箱。
- 异步端点或后台任务需要执行文件系统访问或同步外部调用时，应通过 `crate::spawn_blocking_traced`（或 `Hub::spawn_blocking_task`）卸载到阻塞池，不应在 Tokio I/O 工作线程上直接执行阻塞操作；数据库查询统一使用异步 SeaORM `DatabaseConnection`（`ServerDb::read_conn()` / `write_conn()`）在 Tokio 任务上直接 `.await`。`spawn_blocking_traced` 会捕获当前 `tracing::Dispatch` 与 `tracing::Span::current()` 并在工作线程 `in_scope` 内恢复。

### Axum `FromRequestParts` 类型化鉴权

[auth.rs](crates/server/src/transport/http/auth.rs) 通过实现 `FromRequestParts<HttpState>` 的五个强类型提取器，把安全契约写进路由函数参数签名。HTTP 处理函数内部不应再重复手写 header 或 token 校验分支：

| 提取器 | 校验规则 | 拒绝响应 | 典型路由 |
|---|---|---|---|
| `Authenticated(CallerContext)` | Bearer 令牌（含 `/api/v1/remote/pair/exchange` 配对握手）或本机 `from_the_farm` | JSON `Envelope` | `command`、`slice`、`live`、`subscribe`、`artifact_view`、`artifact_page`、`issue_watch` |
| `AuthenticatedQuery(CallerContext)` | 同 `Authenticated`，额外允许 `?token=` 查询参数 | JSON `Envelope` | `/api/v1/attachment/{id}`（浏览器 `<img>` / `<a>` 直连） |
| `LocalOnly` | 强制 `!state.is_remote && from_the_farm(&parts.headers)` | `BizCode::Forbidden` JSON `Envelope` | `media::upload`、`media::speech`、`mcp` |
| `LocalOnlyStatus` | 同 `LocalOnly` | 裸 `StatusCode::FORBIDDEN` | `media::content` |
| `MachineAuth(RemoteDeviceIdentity)` | 强制 Bearer 或 `?token=` 且校验 `SCOPE_REMOTE_MACHINE`，绝不回落 `LocalOwner` | `BizCode::Unauthorized` / `BizCode::Forbidden` | `/api/v1/machine/ws`（[machine_ws.rs](crates/server/src/transport/http/machine_ws.rs)） |

### 统一 SSE、字节范围解析与 CLI 代理

- **SSE 统一出口**：[mod.rs](crates/server/src/transport/http/mod.rs) 中全部 SSE 路线（`slice`、`live`、`subscribe`、`issue_watch`）统一经 `sse_with_shutdown(stream, state.shutdown)` 挂载 `take_until(shutdown.cancelled_owned())` 停机打断与 `HEARTBEAT`（`20 s`）保活 ping，确保停机时活跃长连接立即收敛。
- **字节范围统一解析**：`attachment` 与 `media::content` 统一调用 `parse_byte_range(text, size)` 处理 `Range: bytes=...` 与越界 `416 Range Not Satisfiable`。
- **CLI 回环 MCP 代理**：[mcp_proxy.rs](crates/cli/src/machine_agent/mcp_proxy.rs) 的 `LocalMcpProxy` 统一运行在 `axum::Router` + `DefaultBodyLimit::max(MAX_BODY_BYTES)` + `axum::serve(listener, app).with_graceful_shutdown(...)` 上，不再自建裸 `TcpStream` HTTP/1.1 解析器；请求级清理通过 `PendingGuard` 在 `Drop` 时回收未完成 `request_id`。

### `ShutdownList` 三阶段优雅停机

[start.rs](crates/server/src/start.rs) 的 `ShutdownList` 在 `Started::close()`（`SHUTDOWN_GRACE = 10 s`）中按三阶段确定性排空整个服务端：

1. `pre_drain`（FIFO）：首先取消根 `CancellationToken`（`hub.cancel`），并卸载 `hub.machine_bus`、`debug.detach` 与 `hub.remote_auth` 等脊柱钩子，阻断新外部输入进入。
2. `concurrent`（`JoinSet` 并行，受 `grace` 超时限制）：并发关闭各业务模块、`hub.bus` 与 `hub.runtime_inbox`。
3. `finalizers`（LIFO）：最后按逆序刷盘并释放脊柱底座资源（`trajectories` → `hub` → `db`）。

### `trace_id`、`hub.op` 与后台 Actor 连续 Tracing Span

- **无条件 `trace_id`**：[lib.rs](crates/server/src/lib.rs) 的 `Hub::invoke`、`invoke_async`、`call_with`、`call_with_async` 通过 `ensure_trace_id` / `ensure_trace_id_owned` 为所有 `trace_id == 0` 的调用原子分配单调递增非零 `next_trace_id`，即使未挂载 `InvokeObserver` 也保持可追踪性。
- **低基数边界 Span**：HTTP 网关的 `trace_request` 中间件建立 `tracing::debug_span!("http.request", method = %req.method(), path = %req.uri().path())`；`Hub` 四条派发路径建立 `tracing::debug_span!("hub.op", op, trace_id = effective_ctx.trace_id)`，异步路径通过 `.instrument(span)` 跨越 `.await` 延续。禁止把完整 JSON 请求体写入 Span 字段。
- **后台 Actor 与跨总线传播**：后台长循环在入口建立命名 Span 并对异步派发调用 `.in_current_span().with_current_subscriber()`（覆盖 `session.pump`、`orchestrator.work`、`connector.bridge`、`machine.conn`、`machine.ws`、`pull.poll`、`repo.probe`）；[event_bus.rs](crates/server/src/event_bus.rs) 的 `EventBus::publish` 在 `Delivery` 中捕获当前 `Span` 与 `Dispatch` 并在工作线程 `spawn_blocking` 中恢复执行。

## 虚拟时钟双层测试与零睡眠

测试针对单调异步延时与日历/墙钟有效期分别采用正交的两层虚拟时钟，禁止在测试中依赖真实挂钟流逝：

| 层次 | 机制 | 覆盖对象 | 测试写法 |
|---|---|---|---|
| Layer 1（单调异步计时） | `#[tokio::test(start_paused = true)]` + `rt::current_or_global_handle()` + `tokio::time::Instant` | 超时、退避重试、心跳、切片去抖、`AbortWatchdog`、会话静默计时 | 用 `tokio::time::advance(dur).await` 瞬时推进；结束前调用 `hub.close_async().await` 与模块 `close_async().await` |
| Layer 2（墙钟与日历时间） | [clock.rs](crates/core/src/clock.rs) `Clock` trait、`SystemClock`、`ManualClock`（经 `ServerConfig.clock` 注入） | `cron` 调度、`remote` 配对过期、`media` 输入/任务 TTL、工单巡查、游戏记录 | 测试构造 `Arc::new(ManualClock::new(...))`，调用 `set()` / `advance()` 确定性越过时间窗 |

- **`tokio/test-util` 隔离**：`tokio` 的 `"test-util"` 特性仅允许声明在各 crate 的 `[dev-dependencies]` 中（如 [crates/server/Cargo.toml](crates/server/Cargo.toml) 与 [crates/runtime/Cargo.toml](crates/runtime/Cargo.toml)），不可进入 `[workspace.dependencies]` 污染生产构建。
- **防止虚拟时钟测试退出死锁**：在 `#[tokio::test(start_paused = true)]` 的 `CurrentThread` 运行时中，`Hub` 与模块后台任务附着在同一测试运行时上。测试末尾不应直接触发同步 `Hub::close()` 或 `EventBus::drop()` 里的 `rt::block_on`（会阻塞唯一测试线程导致无法驱动被 `await` 的后台任务），应显式 `await` `close_async()`。
- **禁用 `std::thread::sleep` 与裸 TCP Mock**：单元测试与集成测试不应使用 `std::thread::sleep` 等待异步结果收敛；HTTP 桩统一使用进程内 `axum::Router` + `TcpListener::bind("127.0.0.1:0")` + `CancellationToken::drop_guard()`（见 [http.rs](crates/server/src/modules/infra/http.rs) 的 `spawn_mock`）。

## Loom 并发状态机内核

### `--features loom` 与 `[profile.loom]`

根 [Cargo.toml](Cargo.toml) 定义 `[profile.loom]`（`inherits = "dev"`、`opt-level = 2`、`debug = false`、`incremental = true`），[crates/runtime/Cargo.toml](crates/runtime/Cargo.toml) 与 [crates/server/Cargo.toml](crates/server/Cargo.toml) 定义可选特性 `loom = ["dep:loom"]`。日常通过 `vp run rust:loom` 运行全量模型检验。

- **为何不用全局 `--cfg loom`**：工作区 `Cargo.lock` 传递引入的 `event-listener` 会在全局 `RUSTFLAGS="--cfg loom"` 下激活其内部 `cfg(loom)` 编译分支并与非 loom 依赖树冲突；使用显式 Cargo feature `--features loom` 可将模型检验精确限定在 `vibevalley-runtime` 与 `vibevalley-server`。
- **零侵入垫片与状态空间上界**：`#[cfg(feature = "loom")]` 仅允许出现在 [crates/server/src/loom_sync.rs](crates/server/src/loom_sync.rs)、[crates/runtime/src/loom_sync.rs](crates/runtime/src/loom_sync.rs) 及各内核文件的 `mod loom_models` 测试子模块中，业务代码保持零条件编译。每个模型只包含最小原子状态与 2–3 条线程；三线程竞争模型应设置 `builder.preemption_bound = Some(2)` 防止状态空间爆炸。

### 四个状态机内核范式

| 内核 | 位置 | 同步原语与核心不变量 |
|---|---|---|
| `TeardownGate` | [teardown_gate.rs](crates/runtime/src/teardown_gate.rs) | `ARMED -> TERMINATING -> TERMINATED` 三态门 + `RollbackGuard`：并发调用不重复执行关闭闭包，正在关闭时不提前返回 `Ok`，失败或 unwind 时回滚 `ARMED` 并唤醒等待者 |
| `AcpTurnMachine` | [turn_state.rs](crates/runtime/src/oar/acp/turn_state.rs) | 单字 `AtomicU64` 位压缩状态（`REPLAYING_BIT`、`ABORT_WANTED_BIT`、`DETACHED_BIT` 与低位 `in_flight`）：通过单一 `cas_update` 保证 `prompt` 完成、分离 `usage_update` 与 `abort`/`Cancel` 交错下 `TurnFinished` 精确触发一次且计数永不下溢 |
| `SliceWakeGate` | [slice_wake.rs](crates/server/src/slice_wake.rs) | 无锁全局提交 `seq`、6 域切片单调水位 `dirty_seqs: [AtomicI64; 6]`（`store_max` CAS 推进）与 `pending_mask: AtomicU8`（仅 `0 -> 非零` 触发 `Notify`），确保跨线程零丢失唤醒与切片序号永不倒退 |
| `SessionGenerationTable` | [gen_table.rs](crates/server/src/modules/work/session/gen_table.rs) | 互斥锁内原子递增分配 `generation` 并安装会话句柄，旧泵退出时调用 `remove_if_current(id, generation)` 校验代次，杜绝旧泵误逐新会话与句柄泄漏/双释放 |

## 原生富内容离线程卸载

`crates/rich` 中的计算密集型组件（[code_block.rs](crates/rich/src/code_block.rs) 的 `VvCodeBlock` 语法高亮、[diagram.rs](crates/rich/src/diagram.rs) 的 `VvDiagram` Mermaid 渲染、[canvas.rs](crates/rich/src/canvas.rs) 的 `VvCanvas` 与 [chart.rs](crates/rich/src/chart.rs) 的 `VvChart`）对未命中 `LruCache::get_by`（[cache.rs](crates/rich/src/cache.rs)，命中时按借用切片比对、零堆键分配）缓存的负载统一经 [highlight.rs](crates/rich/src/highlight.rs) 的 `run_offloaded`（在 Tokio 上下文中走 `Handle::spawn_blocking`，否则派发至共享 2 线程 `vv-rich-offload` 后台池并支持 panic 恢复）与 `AtomicU64` 代次取消守卫移出 GPUI UI 线程：

- 超过阈值（如 `ASYNC_HIGHLIGHT_BYTE_THRESHOLD = 4_096`、`ASYNC_HIGHLIGHT_LINE_THRESHOLD = 120`、`ASYNC_CANVAS_BYTE_THRESHOLD = 4_096`、`ASYNC_CHART_BYTE_THRESHOLD = 4_096`）的未缓存高亮、Mermaid `vibevalley-pele`、JSON Canvas 与 `vibevalley-chart` 排版不得在 GPUI 主线程同步阻塞，首帧应先渲染纯文本或占位视图，后台计算完成后按 `generation` / `latest_gen` 校验并局部刷新 `Signal`。
- 禁止在 [highlight.rs](crates/rich/src/highlight.rs) 之外调用 `tokio::runtime::Handle::try_current()` 并在失败分支静默回退到同步执行：GPUI UI 线程本身并不处于 Tokio 运行时内，该回退会把重计算直接拉回 UI 主线程造成掉帧；后台卸载统一经 `run_offloaded` 稳定派发。

## 静态护栏清单

以下工程检查直接守住本文约束，提交前按改动范围运行：

| 检查 / 脚本 | 守卫范围 | 触发方式 |
|---|---|---|
| [rust-ratchets.ts](scripts/audit/rust-ratchets.ts) | 禁止引入 `pollster`、锁定服务端非测试 `rt::block_on(` 仅缩减上限（`SERVER_BLOCK_ON_CEILING = 91`）、禁止 `apps/mac/src` 使用 `rt::handle`、禁止 `crates/server/tests/`、`apps/mac/src/`、`crates/cli/src/` 与 `crates/runtime/src/` 使用 `std::thread::sleep`、禁止 `crates/rich` 在 `highlight.rs` 外经 `Handle::try_current()` 回退同步执行等 | `vp run audit:rust` |
| [module-boundaries.ts](scripts/audit/module-boundaries.ts) | 守住服务端 `L0–L3` 无环 DAG、模块无循环依赖、脊柱（`lib.rs` / `ports.rs` / `transport/`）与 `apps/mac/src` 不直接导入 `crate::modules::*` | `vp run audit:boundaries` |
| Rust 工作区全检 | `cargo fmt`、`cargo clippy --all-targets -- -D warnings`、工作区测试 | `vp run rust:check` |
| Loom 状态机模型检验 | 4 个并发状态机内核穷举交错检查（`--features loom --profile loom`） | `vp run rust:loom` |
