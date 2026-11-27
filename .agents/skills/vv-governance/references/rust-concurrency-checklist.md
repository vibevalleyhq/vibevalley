# Rust 并发与异步边界评审清单

在 VibeValley 里评审涉及并发、异步、HTTP/SSE、时钟、无锁状态机或原生富文本渲染的 Rust PR / 重构时，逐节核对以下检查项。每条写清**查什么**、**怎么判通过**和**对照文件**；只列证据与改法，不凭印象放行。

## 1. Tokio 运行时边界（`rt`、`pollster`、`rt::handle`、`block_on`）

- [ ] **零 `pollster` 残留**：确认 `Cargo.toml` 与源码中没有引入或调用 `pollster::block_on`；统一走 `vibevalley_rt`（`crates/rt/src/lib.rs`，`vibevalley_runtime::rt` 重导出）。
- [ ] **`rt::current_or_global_handle()` vs `rt::handle()`**：在可能运行于 `#[tokio::test(start_paused = true)]` 测试上下文的异步服务/任务里，必须调用 `rt::current_or_global_handle()` 挂到当前环境运行时，禁止绕过测试时钟直接 `rt::handle().spawn(...)`。仅长生命周期宿主锚点（如 `Listener` in `crates/server/src/gateway/http/mod.rs`）或明确需要 `rt::handle().enter()` 进入全局 `vibevalley-io` 运行时时才用 `rt::handle()`。
- [ ] **禁止在 `async fn` / Tokio worker 内同步阻塞**：异步函数内不得调用 `rt::block_on`、`Handle::block_on` 或 `std::thread::sleep`，必须 `.await` 对应的 `*_async` 接口；同步阻塞工作必须通过任务隔离（见第 2 节）。
- [ ] **`Drop` 里的异步收尾不死锁**：优先提供显式 `async fn close_async(&self)` / `async fn shutdown(self)`（如 `Hub::close_async`、`EventBus::close_async`、`Listener::shutdown`）；若保留同步 `Drop` 兜底调用 `rt::block_on`，其后台任务必须锚定在全局多线程运行时（`rt::handle()`），确保在 `CurrentThread` 测试运行时里不会因 `block_in_place` 或自等死锁。

## 2. `Hub::on_async` 与 `spawn_blocking_traced`

- [ ] **I/O 型 RPC 与订阅默认走异步**：`Hub` 命令注册优先用 `Hub::on_async`（收 owned `AsyncCtx`），长订阅优先用 `Hub::on_subscription_async`（如 `crates/server/src/runtime/session/mod.rs`、`crates/server/src/channel/mod.rs`、`crates/server/src/note/mod.rs`），避免每次 RPC 都无谓占用一个阻塞线程。
- [ ] **阻塞工作只经 `spawn_blocking_traced`**：SQLite 同步查询、git 子进程、文件扫描或 CPU 密集计算需要离开异步 executor 时，必须通过 `crate::spawn_blocking_traced`（`crates/server/src/router.rs`）派发，禁止裸调 `tokio::task::spawn_blocking` 或 `std::thread::spawn`，以免丢失 `tracing::Span::current()` 与 `trace_id`。
- [ ] **不跨 `.await` 持同步锁**：检查所有 `std::sync::Mutex` / `RwLock` 守卫作用域，确保在任何 `.await` 之前已经 drop。

## 3. Axum Extractor 与统一 SSE / Range 流

- [ ] **安全边界声明在函数签名里**：`crates/server/src/gateway/http/` 下每个 handler 必须在参数列表里声明类型化的 `FromRequestParts<HttpState>` extractor（`Authenticated`、`AuthenticatedQuery`、`LocalOnly`、`LocalOnlyStatus`、`MachineAuth`，见 `crates/server/src/gateway/http/auth.rs`），禁止在 handler 函数体里手写零散 token / loopback 判断。
- [ ] **请求体上限与流式上传边界**：JSON 路由保留 `DefaultBodyLimit::max(...)`；仅流式上传路由（如 `media::upload`）可配 `DefaultBodyLimit::disable()`，且必须套上 `bounded_upload_stream`（字节上限 + deadline 超时，见 `crates/server/src/gateway/http/media.rs`）。
- [ ] **统一 SSE 通道**：`/api/v1/slice/{name}`、`/api/v1/live`、`/api/v1/subscribe/{name}` 等 SSE 端点必须走 `sse_with_shutdown`（`Sse::new` + `KeepAlive` 心跳 + `CancellationToken::cancelled_owned()`）与 `WatchStream` / `BroadcastStream`，禁止为每个连接独占阻塞 OS 线程（`crates/server/src/gateway/http/mod.rs`）。
- [ ] **统一 Range 流式下载**：二进制分段读取必须走 `parse_byte_range` + `file_range_stream`（`ReaderStream` + 截断 `UnexpectedEof` 保护），正确返回 `206 Partial Content` / `416 Range Not Satisfiable` 与 `Content-Range`、`Accept-Ranges: bytes` 头。

## 4. 虚拟时钟与确定性生命周期（`start_paused`、`ManualClock`、`close_async`）

- [ ] **异步定时测试禁睡墙钟**：涉及超时、退避、重试、心跳或节流的异步测试必须使用 `#[tokio::test(start_paused = true)]` + `tokio::time::advance(...)` + `tokio::task::yield_now().await`（参考 `crates/rt/src/lib.rs`、`crates/server/src/router.rs`、`crates/server/src/context/outbox.rs`），不得依赖真实毫秒睡眠。
- [ ] **业务时钟注入 `ManualClock`**：调度、巡查、过期窗口等逻辑必须经 `Arc<dyn Clock>` 读取时间，测试注入 `ManualClock`（`crates/core/src/clock.rs`），禁止直读 `SystemTime::now()`。
- [ ] **生命周期关闭可瞬时排空**：启动了后台任务的 `Hub`、`EventBus`、`Remote` 等组件测试，收尾必须显式 `.await` `close_async()`，并验证在虚拟时钟下瞬时完成、无泄漏任务。

## 5. `loom` 并发状态机内核（`preemption_bound`、`--features loom`）

- [ ] **无锁/原子核心隔离在 `loom_sync` 后**：原子 bitmask、水位线、状态流转内核（如 `crates/server/src/context/feed.rs`、`crates/runtime/src/oar/acp/turn_state.rs`）通过 `loom_sync`（`crates/runtime/src/loom_sync.rs`）切换标准库与 `loom` 原语，确保模型直接覆盖生产状态机。
- [ ] **配置 `preemption_bound` 的 `#[cfg(all(test, feature = "loom"))]` 模型**：`loom::model::Builder` 设置合理的 `preemption_bound = Some(2)`（或等价有界抢占），覆盖多生产者并发推进、唤醒合并（0 → 非 0 才 notify）、无丢失唤醒及水位不倒退等不变量。
- [ ] **验证模型确实编过并跑通**：改了原子顺序（`Acquire`/`Release`/`AcqRel`）或状态迁移分支时，必须带 `--features loom` 执行 `loom` 检查，避免只跑常规 `cargo test` 漏掉 `loom_models`。

## 6. `crates/rich` 离 UI 线程渲染

- [ ] **大代码块与图表异步离线程渲染**：在 `crates/rich/src/{code_block,diagram,canvas,chart}.rs` 中，命中阈值且未命中 `LruCache::get_by` 缓存的渲染负载，必须先画纯文本/占位首帧并经 `crate::highlight::run_offloaded` 后台执行，回填前校验 `AtomicU64` + `generation` 防止旧结果覆盖新内容。
- [ ] **Mermaid / Canvas / Chart 缓存与 SVG 光栅化路径**：`crates/rich/src/{diagram,canvas,chart}.rs` 必须走 `LruCache::get_by`（零键堆分配命中）并用 `ImageSrc::svg_markup` 保留 `<text>` 标签。
- [ ] **Mac 原生面板后台准备**：`apps/mac/src/viewer.rs` 与 `apps/mac/src/markdown_pane.rs` 的文件读取和 `vibevalley_rich::tokenize_scopes` 必须放在 `cx.background_spawn` 后台执行，禁止在 GPUI 绘制/视图构建路径上同步读盘或分词。

## 验证命令

改动涉及上述任一节时，运行下列对应检查并附真实输出：

```bash
vp run audit:rust
vp run audit:boundaries
vp run rust:loom
vp run rust:check
```
