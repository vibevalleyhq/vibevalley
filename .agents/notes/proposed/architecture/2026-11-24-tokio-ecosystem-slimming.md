# Agent Note: Tokio 生态精简、类型化 HTTP 鉴权与异步链路追踪

Status: proposed

## Problem

在完成 P0–P2 Tokio 并发模型收敛（[2026-11-23-tokio-concurrency-overhaul.md](.agents/notes/proposed/architecture/2026-11-23-tokio-concurrency-overhaul.md)）后，Tokio 栈上仍存在五类结构性样板、可观测性与并发验证缺口：

| 缺口 | 代码位置 | 现状与影响 |
|---|---|---|
| HTTP 网关鉴权分散且存在裸 `TcpStream` 解析器 | [mod.rs](crates/server/src/transport/http/mod.rs)、[media.rs](crates/server/src/transport/http/media.rs)、[machine_ws.rs](crates/server/src/transport/http/machine_ws.rs)、[mcp_proxy.rs](crates/cli/src/machine_agent/mcp_proxy.rs) | 服务端 13 处 HTTP 路由入口顶部手动重复 `authenticate(...)`、`authenticate_with_token(...)`、`state.is_remote \|\| !from_the_farm(&headers)` 或 Bearer/scope 校验；CLI 的 `LocalMcpProxy` 另行手写原始 `TcpStream` HTTP/1.1 请求与 chunked 解析器，造成双套网关栈 |
| 流式上传与分块下载手写胶水 | [media.rs](crates/server/src/transport/http/media.rs)、[mod.rs](crates/server/src/transport/http/mod.rs)、根 [Cargo.toml](Cargo.toml) | `tokio-util` 仅启用 `"rt"`；`media::upload` 手写约 90 行 `Chunk`、`UploadReader`、`flume::bounded(2)` 与 64 KiB 切片循环，`media::content` 与 `attachment` 各自手写 `try_unfold` + `vec!` 分块读循环；多处结构仅为了 `cancel()` 手写 `impl Drop` |
| 缺少默认 `trace_id` 与 `tracing::Span` 链路传播 | [lib.rs](crates/server/src/lib.rs)、[mod.rs](crates/server/src/transport/http/mod.rs)、[host.rs](apps/mac/src/host.rs)、[record.rs](crates/runtime/src/oar/record.rs) | `Hub::invoke`、`invoke_async`、`call_with`、`call_with_async` 仅在挂载 `InvokeObserver` 时才分配非零 `trace_id`，常规运行时恒为 `0`；四条派发路径均未建立 `tracing::Span` 或对异步未来调用 `.instrument(...)`，并发异步日志跨 `session`、`oar`、`sqlx` 与 macOS `OsLogLayer` 时无法按请求关联，`oar-voyage/3` 轨迹记录的 `traceId` 亦为空 |
| 时序测试依赖挂钟睡眠且无法直接套用虚拟时钟 | [rt.rs](crates/runtime/src/rt.rs)、[crates/server/Cargo.toml](crates/server/Cargo.toml)、[crates/runtime/Cargo.toml](crates/runtime/Cargo.toml) | 未在 `[dev-dependencies]` 启用 `tokio/test-util`；多处测试依赖真实 `std::thread::sleep`；即使开启 `#[tokio::test(start_paused = true)]`，直接派发至全局多线程 `rt::handle()` 的任务以及 `jiff::Timestamp::now()` / `std::time::Instant::now()` 仍不受当前线程测试运行时暂停时钟约束 |
| 原子并发内核缺少穷举交错验证 | [lib.rs](crates/server/src/lib.rs)、[mod.rs](crates/runtime/src/oar/acp/mod.rs)、[sessions.rs](crates/server/src/modules/work/session/sessions.rs)、[sandbox.rs](crates/runtime/src/sandbox.rs) | 随并发原语与多机执行层演进，仓库内 4 处原子/无锁状态机仅靠普通单次并发测试覆盖，难以捕获弱内存序或极罕见线程交错下的丢失唤醒与双重终止 |

具体表现如下：

1. **鉴权不变量未编码进路由签名，且存在非 Axum 网关**：[mod.rs](crates/server/src/transport/http/mod.rs) 的 7 处端点（`command`、`slice`、`live`、`subscribe`、`artifact_view`、`artifact_page`、`issue_watch`）重复手写 `authenticate(&state, &headers, uri.path()).await`，`attachment` 手写 `authenticate_with_token(...)`，`mcp` 手写 `state.is_remote || !from_the_farm(&headers) || token.starts_with("vv_dev_")`；[media.rs](crates/server/src/transport/http/media.rs) 的 `upload`、`content`、`speech` 各自重复 `state.is_remote || !from_the_farm(&headers)`，且 `content` 返回裸 `StatusCode::FORBIDDEN` 而其余返回 JSON `Envelope`；[machine_ws.rs](crates/server/src/transport/http/machine_ws.rs) 重复拆解 Bearer/`?token=` 并校验 `SCOPE_REMOTE_MACHINE`。同时，[mcp_proxy.rs](crates/cli/src/machine_agent/mcp_proxy.rs) 手写了约 150 行 `read_http_request`、`read_chunked_body`、`write_http_response` 与 `reason_phrase` 解析回环 HTTP/1.1 流量。
2. **手写流式适配与取消守卫放大维护面**：[media.rs](crates/server/src/transport/http/media.rs) 为把 `axum::body::Body` 喂给同步 `Read` 接口 `inputs.upload(&id, Box::new(reader))`，自建了 `Chunk`、`UploadReader`、`flume::bounded(2)`、64 KiB 切片与 300 秒截止循环；`media::content` 与 [mod.rs](crates/server/src/transport/http/mod.rs) 的 `attachment` 均手写 `futures_util::stream::try_unfold` 逐块分配 `Vec<u8>`。此外，[lib.rs](crates/server/src/lib.rs)（`Hub`）、[event_bus.rs](crates/server/src/event_bus.rs)（`EventBus`）、[runtime_inbox.rs](crates/server/src/runtime_inbox.rs)（`RuntimeInboxObserver`）与 [hub.rs](crates/server/src/transport/bridge/hub.rs)（`Client`、`Pump`）中多处仅负责取消 `CancellationToken` 的 `impl Drop` 样板可由 `DropGuard` 替代。
3. **并发异步日志断链**：常规运行未开启 DevTools 观察器时，`Hub` 传给业务模块与 `oar` 的 `trace_id` 恒为 `0`，[record.rs](crates/runtime/src/oar/record.rs) 经 [voyage.rs](crates/runtime/src/oar/voyage.rs) 归一化后省略 `traceId`。派发层缺少 `tracing::Span` 进入与跨 `.await` / `spawn_blocking` 传播，致使并行请求、通道投递与执行会话事件在日志与 `OsLogLayer` 中混杂难辨。
4. **虚拟时钟测试的结构性陷阱**：[event_bus.rs](crates/server/src/event_bus.rs)、[tests.rs](crates/server/src/transport/http/tests.rs)、[cron.rs](crates/server/tests/cron.rs)、[media_jobs.rs](crates/server/tests/media_jobs.rs)、[tests.rs](crates/runtime/src/agent/ai/tests.rs)、[tests.rs](crates/runtime/src/agent/tools/tests.rs) 与 [conformance.rs](crates/runtime/src/agent/durable/conformance.rs) 等测试使用真实 `std::thread::sleep`。单纯启用 `tokio/test-util` 仍不足以让服务端计时器进入虚拟时钟：`#[tokio::test(start_paused = true)]` 仅暂停当前线程测试运行时上的 `tokio::time::*`，对硬编码派发到全局多线程 `vibevalley_runtime::rt::handle()` 的任务无效，也无法拦截 `jiff::Timestamp::now()` 或 `std::time::Instant::now()` 挂钟读取。
5. **并发内核缺少形式化交错测试**：`Hub` 的 `dirty_seqs: [AtomicI64; 6]` + 唤醒合并、`oar/acp` 的多原子轮次与中止状态机、`Sessions::generation` 代次递进以及 `Sandbox` 的 `terminated` CAS 属于少数真正依赖原子内存序的内核代码，普通测试难以穷举竞争交错。

## Proposal

围绕现有 Tokio / `axum` / `tokio-util` / `tracing` 依赖树推进五项精简与基础设施收口，严守 [architecture-topology.md](docs/architecture-topology.md) 的控制面边界。

### 1. 全仓 HTTP 网关 100% Axum 收敛与类型化鉴权提取器

- **服务端类型化鉴权提取器（`crates/server/src/transport/http/auth.rs`）**：基于 `axum::extract::FromRequestParts<HttpState>` 实现四类编译期强约束提取器，使未声明对应提取器的路由无法获取 `CallerContext`：
  - `Authenticated(pub CallerContext)`：校验 Bearer 令牌（含 `/api/v1/remote/pair/exchange` 配对例外）或本地 `from_the_farm` 同源请求；失败时返回标准 JSON `Envelope` 错误响应。覆盖 `command`、`slice`、`live`、`subscribe`、`artifact_view`、`artifact_page`、`issue_watch`。
  - `AuthenticatedWithQueryToken(pub CallerContext)`：在 `Authenticated` 基础上允许 `?token=` 查询参数承载远程令牌，覆盖 `attachment` 等无法附带自定义请求头的路径。
  - `LocalOnly`：强约束 `!state.is_remote && from_the_farm(&headers)`；拒绝时返回 `refuse(BizCode::Forbidden, "forbidden")` JSON `Envelope`。覆盖 `media::upload`、`media::speech` 以及 `mcp` 的本机同源守卫（`mcp` 仍额外拒绝 `vv_dev_` 远程令牌）。
  - `LocalOnlyStatus`：与 `LocalOnly` 校验逻辑相同，但拒绝时返回裸 `StatusCode::FORBIDDEN`，严格保持 `media::content` 既有对外契约。
  - `machine_ws::upgrade` 复用 `auth.rs` 的令牌提取与 `RemoteAuth` 校验逻辑（收口为拒绝回落 `LocalOwner` 且强制 `SCOPE_REMOTE_MACHINE` 的专用提取器）。
- **惯用 Axum 路由组织与 `tower` 边界**：在 [mod.rs](crates/server/src/transport/http/mod.rs) 按安全策略拆分 `axum::Router` 子路由（远程/本地鉴权 API 与仅本机访问的媒体/MCP 路由），结合 `axum::extract::DefaultBodyLimit` 与显式 `MAX` 校验，以及轻量 `tower` / `tower-http` HTTP 网关中间件（如请求级 `Span` 与统一头守卫）。`tower` 严格限定在 HTTP 网关边界，不应侵入 `Hub` 内部派发。
- **CLI 回环 MCP 代理迁移至 Axum（[mcp_proxy.rs](crates/cli/src/machine_agent/mcp_proxy.rs)）**：删除手写的原始 `TcpStream` HTTP/1.1 请求解析器、`read_chunked_body`、`write_http_response` 与 `reason_phrase`，改用 `axum::Router`（挂载 `POST /mcp` 与 `DefaultBodyLimit::max(MAX_BODY_BYTES)`）+ `axum::serve(listener, app).with_graceful_shutdown(cancel.cancelled_owned())`，使全仓 100% 生产 HTTP 网关统一为原生 Axum，业务模块与线协议机械细节彻底解耦。

### 2. 启用 `tokio-util` I/O 原语与 `DropGuard` 清理手写胶水

- 在根 [Cargo.toml](Cargo.toml) 为 `tokio-util` 增加 `"io"` 与 `"io-util"` features。
- 改造 [media.rs](crates/server/src/transport/http/media.rs) 的 `media::upload`：用 `tokio_util::io::StreamReader` 将 `body.into_data_stream()` 映射为 `AsyncRead`，前置有界字节统计包装流以维持 `512_000_000` 字节上限，再经 `tokio_util::io::SyncIoBridge` 桥接至 `spawn_blocking` 中的 `inputs.upload(&id, Box::new(reader))`，保留 300 秒上传总截止时间；删除手写的 `Chunk`、`UploadReader`、`flume::bounded(2)` 与 64 KiB 切片循环。
- 改造 [media.rs](crates/server/src/transport/http/media.rs) 的 `media::content` 与 [mod.rs](crates/server/src/transport/http/mod.rs) 的 `attachment` 分段下载：在 `file.seek(SeekFrom::Start(start))` 之后，以 `tokio::io::AsyncReadExt::take(length)` 配合 `tokio_util::io::ReaderStream::with_capacity(..., 64 * 1024)` 替代手写 `try_unfold` + `vec!` 循环，并在文件长度不足预期时保留截断报错语义。
- 对仅负责在释放时取消令牌的结构（如 `Hub`、`RuntimeInboxObserver` 或仅持有取消职责的内部守卫），改用 `CancellationToken::drop_guard()`（`DropGuard`），删除仅调用 `cancel()` 的手写 `impl Drop`（仍需执行 `join` 或反注册的结构保留显式 `Drop`）。

### 3. 无条件签发 `trace_id` 与异步 `tracing::Span` 链路传播

- 在 [lib.rs](crates/server/src/lib.rs) 的 `Hub::invoke`、`Hub::invoke_async`、`Hub::call_with`、`Hub::call_with_async` 中，无论是否挂载 `InvokeObserver`，只要调用方传入 `caller_ctx.trace_id == 0`，均无条件通过 `self.next_trace_id.fetch_add(1, Ordering::Relaxed)` 分配非零 `trace_id` 并写入 `effective_ctx`；抽成单一内部辅助函数，消除四处重复逻辑。
- 在上述四条派发路径上建立 `tracing::debug_span!("hub.op", op, trace_id = effective_ctx.trace_id, caller = ?effective_ctx.caller)`：
  - 同步路径（`invoke`、`call_with`）通过 `let _entered = span.enter();` 覆盖 `dispatch_typed` / `dispatch_call`；
  - 异步路径（`invoke_async`、`call_with_async`）使用 `tracing::Instrument::instrument(span)` 包裹 `dispatch_typed_async` / `dispatch_call_async`，回落 `tokio::task::spawn_blocking` 时以 `tracing::Span::current().in_scope(...)` 跨线程延续同一 `Span`；
  - HTTP 门（[mod.rs](crates/server/src/transport/http/mod.rs)）入口建立 `tracing::debug_span!("http.request", method = %method, path = %path)`，使鉴权、解码、SSE/流式响应与下游 `Hub` 调用处于同一父子 Span 树中。
- 单次请求触发的 `Hub` 派发、`sqlx` 查询、`EventBus`、`session` 调度、macOS `OsLogLayer`（[host.rs](apps/mac/src/host.rs)）与 `oar` 持久化的 `oar-voyage/3` JSONL 记录（[record.rs](crates/runtime/src/oar/record.rs)）由此自动关联。

### 4. 双层确定性虚拟时钟测试架构（`tokio/test-util` + `Clock`）

针对「`#[tokio::test(start_paused = true)]` 仅暂停当前线程测试运行时上的 `tokio::time::*`，对全局多线程 `rt::handle()` 与挂钟时间戳无效」这一根本约束，采用两层正交方案：

- **Layer 1（单调异步计时器）**：
  - 仅在 [crates/server/Cargo.toml](crates/server/Cargo.toml) 与 [crates/runtime/Cargo.toml](crates/runtime/Cargo.toml) 的 `[dev-dependencies]` 中启用 `tokio = { workspace = true, features = ["test-util"] }`。
  - 在 [rt.rs](crates/runtime/src/rt.rs) 新增 `rt::current_or_global_handle()`（`tokio::runtime::Handle::try_current().unwrap_or_else(|_| rt::handle().clone())`），并在生产路径保持行为完全不变（外部同步线程仍落回全局 `vibevalley-io` 多线程运行时）；将内部异步截止时间统一为 `tokio::time::Instant`。
  - `Hub`（[lib.rs](crates/server/src/lib.rs)）、`EventBus`（[event_bus.rs](crates/server/src/event_bus.rs)）、`Ticker`（[base.rs](crates/server/src/base.rs)）、`SliceFeed`（[slice_feed.rs](crates/server/src/slice_feed.rs)）、[game.rs](crates/server/src/modules/skin/game.rs)、[journal.rs](crates/server/src/modules/work/session/journal.rs)、`FaultGate`、SSE 心跳与 `AbortWatchdog` 通过 `rt::current_or_global_handle()` 派发任务后，在 `#[tokio::test(start_paused = true)]` 测试中自动附着到暂停的当前线程虚拟时钟，通过 `tokio::time::advance(...)` 瞬时、确定性地驱动超时、去抖、心跳与延迟注入测试。
- **Layer 2（挂钟 / 日历领域时间）**：
  - 为依赖墙上时钟或日历时刻的领域逻辑注入极简 `Clock` trait（生产环境使用零状态 `SystemClock`，测试环境注入可控 `ManualClock`），覆盖 `cron` 定时触发、`remote` 配对令牌过期、`media` 输入/作业 TTL 与巡查（patrol）时间窗口，消除挂钟睡眠与日期边界竞态。

### 5. 面向并发内核的定向 `loom` 模型检验（Phase 2）

不把 `#[cfg(loom)]` 散布到业务模块中，而是采用「内核隔离 + 按需穷举」策略：

- **提炼 4 个纯同步并发内核**：将真正依赖原子操作与无锁内存序的最小状态机逻辑抽离至独立内部子模块，仅在内核内部通过极薄的 `#[cfg(loom)]` 同步垫片（切换 `std::sync::atomic` / `loom::sync::atomic` 与 `std::thread` / `loom::thread`）对接：
  1. `SliceFeed` / `Hub` 的 `dirty_seqs: [AtomicI64; 6]` 与唤醒合并（[lib.rs](crates/server/src/lib.rs)、[slice_feed.rs](crates/server/src/slice_feed.rs)）；
  2. `oar/acp` 的多原子轮次与中止状态机（`replaying`、`abort_wanted`、`abort_killed`、`in_flight_prompts`、`detached_continuation`，[mod.rs](crates/runtime/src/oar/acp/mod.rs)）；
  3. `Sessions::generation` 代次竞争内核（[sessions.rs](crates/server/src/modules/work/session/sessions.rs)）；
  4. `Sandbox` / `Process` 单次终止 CAS（`terminated.compare_exchange`，[sandbox.rs](crates/runtime/src/sandbox.rs)）。
- **独立门禁命令**：在对应 crate 的 `[target.'cfg(loom)'.dev-dependencies]` 声明 `loom`，通过显式开关命令 `RUSTFLAGS="--cfg loom" cargo test --release`（后续可封装为 `vp run rust:loom`）运行穷举线程交错检查；常规开发与发布构建完全不编入 `loom`，零运行时开销。

## Alternatives considered

**全仓侵入式 `loom` 改造**：若在业务模块和 Tokio 异步任务层大范围铺设 `#[cfg(loom)]` 垫片，不仅会带来严重的条件编译样板与状态空间爆炸，还会因 `loom` 无法直接驱动完整 Tokio I/O 运行时而失去可行性。将 `loom` 严格收敛到上述 4 个纯原子并发内核，既获得形式化交错检验，又保持业务代码零侵入。

**立即引入 `turmoil`（Tokio 确定性网络模拟器）**：`turmoil` 擅长模拟多节点 TCP/UDP 分区、丢包与重排；当前 VibeValley 以单宿主控制面为主，多节点 `Machine` WebSocket 协作规模尚未复杂到需要整套虚拟网络栈。待后续分布式 `Machine` 调度与断线重连拓扑变复杂时，可将 `turmoil` 作为 `loom` 之后的网络层补充，而非当下必需依赖。

**引入 `toasty` ORM 替代 `sqlc` + `sqlx`**：`toasty` 仍处于早期不稳定阶段，且抽象层会遮蔽 SQLite WAL 模式下的 `write_pool`（单连接串行写）与 `read_pool`（只读多连接并发读）控制。VibeValley 现有的 `sqlc` 命名查询与 `sqlx` 绑定已在编译期校验 SQL 类型且零运行时反射开销，不应替换为 ORM。

**采用 `warp` 替代 `axum`**：`warp` 在 Tokio 生态中已被 `axum` 取代，其基于嵌套 `Filter` 组合子的类型错误信息冗长且难于维护；`axum` 的 `FromRequestParts` 提取器与 `Router` 状态模型更直接、可读性更高，且服务端当前已全面使用 `axum 0.8`。

**引入 `tonic`（gRPC）作为前后端或移动端传输层**：VibeValley 的客户端包含进程内 GPUI 桥、`nsh` TSX 工作台、基于纯 Web Fetch 的 `apps/mobile` 以及支持 `--json` 输出的 `vibevalley` CLI。引入 `tonic` 不仅带来 HTTP/2 与 `.proto` 工具链负担，还会打破「Rust `crates/protocol/src/contract` 单源生成 TS 契约」的架构简洁性。

**绕过 `axum` / `tokio` 直接手写 `hyper` 或 `mio`**：`hyper` 与 `mio` 已经是 `axum` 和 `tokio` 的底层实现。把业务控制面路由、SSE、WebSocket 与流式正文下沉到手写 `hyper` Service 或 `mio` 事件循环，只会制造大量协议状态机样板，在本地控制面吞吐量级下无实际收益。

**将 `Hub` 内部派发包装为 `tower::Service`**：`Hub` 同时服务进程内 GPUI 桥、类型化直调 `Hub::invoke`、HTTP 门、CLI 与 MCP，调用约定为 `Op` 类型与 `CallerContext` 而非 HTTP `Request`/`Response`。强行把 `Hub` 内部路由套入 `tower::Service` 会引入不必要的 `Service` trait 样板、装箱与泛型传染；`tower` 应严格限定在 HTTP 网关边界。

## Acceptance criteria

1. **全仓 Axum 收敛与类型化 HTTP 鉴权**：
   - 新增 `crates/server/src/transport/http/auth.rs` 实现 `Authenticated`、`AuthenticatedWithQueryToken`、`LocalOnly`、`LocalOnlyStatus`（及 `machine_ws` 复用提取器）；[mod.rs](crates/server/src/transport/http/mod.rs)、[media.rs](crates/server/src/transport/http/media.rs) 与 [machine_ws.rs](crates/server/src/transport/http/machine_ws.rs) 路由函数中不再手写重复鉴权样板，路由按安全策略分组并配置 `DefaultBodyLimit`。
   - [mcp_proxy.rs](crates/cli/src/machine_agent/mcp_proxy.rs) 完成迁移至 `axum::Router` + `axum::serve(...).with_graceful_shutdown(...)`，删除手写 `TcpStream` HTTP/1.1 与 chunked 解析器，现有 MCP 代理测试全部通过。
   - HTTP 测试验证远程与本地监听器的拒绝状态码与响应体契约完全不变：`media::content` 保持裸 `403`（`StatusCode::FORBIDDEN`），其余端点保持 `Envelope` JSON 拒绝体，`/api/v1/remote/pair/exchange`、`attachment` 的 `?token=`、`mcp` 拒绝 `vv_dev_` 以及 `machine/ws` 强校验 `SCOPE_REMOTE_MACHINE` 均有回归覆盖。
2. **`tokio-util` I/O 与 `DropGuard`**：
   - 根 [Cargo.toml](Cargo.toml) 启用 `tokio-util` `"io"` 与 `"io-util"`；[media.rs](crates/server/src/transport/http/media.rs) 删除手写 `Chunk`、`UploadReader` 与 `flume::bounded(2)` 通道，改用 `StreamReader` + `SyncIoBridge`，`media::content` 与 `attachment` 改用 `ReaderStream`。
   - 媒体上传（含 512 MB 超限、非法 `Content-Type`、中途断流与 300 秒超时）及范围播放（`206 Partial Content`、`416 Range Not Satisfiable`）测试全部通过。
3. **`trace_id` 与 `tracing::Span` 链路追踪**：
   - 未挂载 `InvokeObserver` 时，`Hub::invoke`、`invoke_async`、`call_with`、`call_with_async` 均签发单调递增的非零 `trace_id`；外部传入非零 `trace_id` 时原样透传。
   - 单元测试断言 `hub.op` 与 `http.request` Span 字段（`op`、`trace_id`）跨越 `.await` 与 `spawn_blocking` 保持一致，且 `oar` 持久化的 `oar-voyage/3` 记录写入非零 `traceId`。
4. **双层虚拟时钟测试架构**：
   - `tokio/test-util` 仅声明在 `[dev-dependencies]`，不进入主 `[dependencies]`。
   - [rt.rs](crates/runtime/src/rt.rs) 提供 `rt::current_or_global_handle()`；Layer 1 计时组件统一使用 `tokio::time::Instant`，在 `#[tokio::test(start_paused = true)]` 下通过 `tokio::time::advance(...)` 稳定通过且零真实挂钟睡眠。
   - Layer 2 `Clock` trait 覆盖 `cron`、`remote` 配对过期、`media` TTL 与巡查时间边界测试。
5. **定向 `loom` 模型检验（Phase 2）与全量检查**：
   - 上述 4 个并发内核通过独立 `RUSTFLAGS="--cfg loom" cargo test --release` 交错模型检验，业务模块中不出现 `#[cfg(loom)]`。
   - `vp run rust:check`、`vpx scripts/audit/module-boundaries.ts` 与 `vp run docs:verify` 全部通过。

## Risks

- **HTTP 错误响应形态静默漂移**：提取器与子路由重构后，若把 `media::content` 误归入返回 JSON `Envelope` 的 `LocalOnly`，会破坏依赖裸 `StatusCode::FORBIDDEN` 的客户端与测试；`mcp` 拒绝 `vv_dev_`、`pair/exchange` 例外与 `mcp_proxy` 既有 400/413/405 状态码亦属契约。应对：拆出独立的 `LocalOnlyStatus` 与 `LocalOnly`，为每个特例端点和 `mcp_proxy` 保留回归测试。
- **`SyncIoBridge` 阻塞运行时或放宽上传限额**：`SyncIoBridge` 只能在 `spawn_blocking` 线程中调用，误用于异步工作线程会触发 Tokio panic；若替换 `UploadReader` 时遗漏流式字节计数器或 300 秒截止控制，大文件上传可能突破 `512_000_000` 字节上限或无限挂起。应对：在 `StreamReader` 前置有界字节统计包装流以在超限时立即中止，并沿用 `tokio::time::timeout(Duration::from_secs(300), ...)` 约束上传生命周期。
- **过度打点导致日志噪音与 `OsLogLayer` 开销**：若将 `hub.op` 或 `http.request` 设为 `info_span!` 或序列化完整 JSON 请求体，会在高频切片推送与轮询时淹没桌面日志并拖慢 `OsLogLayer`。应对：统一使用 `debug_span!`，仅记录低基数标量字段（`op`、`trace_id`、`caller`、`method`、`path`），不记录 `payload` 正文。
- **虚拟时钟误附着与测试挂起**：引入 `rt::current_or_global_handle()` 后，若某 `#[tokio::test(start_paused = true)]` 测试内部混合了真实 TCP/子进程 I/O 或同步 `rt::block_on`，当前线程测试运行时可能因缺少后台线程推进或时钟暂停而卡死；若把 `"test-util"` 误写入根 `[workspace.dependencies]`，则会污染生产构建。应对：严格仅在 `[dev-dependencies]` 声明 `"test-util"`，纯计时器单元测试使用 `start_paused = true`，涉及真实子进程与套接字的集成测试保持现实时间驱动；`Clock` trait 仅注入真正依赖挂钟/日历的 4 处领域模块，避免无谓的全局依赖穿透。
- **`loom` 垫片扩散与组合爆炸**：若将过大的业务结构体或过多并发线程塞入单个 `loom` 用例，会导致探索分支指数级膨胀、测试超时。应对：每个 `loom` 内核只保留最小原子状态与 2–3 个线程的竞争模型，并把 `loom` 门禁保留在独立 opt-in 命令中运行，不拖慢日常 `vp run rust:check`。
