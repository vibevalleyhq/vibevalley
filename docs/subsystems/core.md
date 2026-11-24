# 核心状态和接口

`SpaceState` 是农场实时状态的唯一内存投影，仅由服务端持有，仅在 `Hub::apply`（`Core::apply`）中经纯函数 `reduce(state, fact)` 演进。外部通过 `POST /api/v1/*` 发命令，通过 SSE 流看状态、事件和订阅。本篇是接口和流的唯一一份清单。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `SpaceState` 的折叠（`apply`、`reduce`）、脏切片掩码 `SliceMask`、前后状态对 `Transition` 与序号 `seq` | 事实何时发出、各表如何持久化（[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)、[频道](docs/subsystems/channel.md)、[定时任务](docs/subsystems/issue.md#定时任务)） |
| 5 域切片（`BoardSlice`、`SessionsSlice`、`CollabSlice`、`InboxSlice`、`OpsSlice`）与独立 `FarmFrame` 投影，及统一有界合并推流 `SliceFeed<T>` | 地块画面规则与游戏账本计算（[游戏](docs/subsystems/game.md)、[农场的皮](docs/subsystems/farm.md)） |
| 全部路由：SSE／快照流（`/api/v1/slice/{name}`、`/live`、`/events`、工单观察流、订阅流）和其余 `GET`、`PUT` 路由 | 订阅里频道和 Artifact 的事件内容（[频道](docs/subsystems/channel.md)、[Artifact](docs/subsystems/artifact.md)）、工单观察流的内容（[工单](docs/subsystems/issue.md#观察执行)）、帮工 `/mcp` 的工具 |
| 接口表 `ENDPOINTS`、权限 `can`、调用上下文 `CallerContext`、幂等键 `requestKey`、试跑 `dryRun`、可插拔脊柱钩子（`InvokeObserver`、`FaultGate`、`HostDebugBridge`、`RemoteAuth`）与 CLI 映射 | 各接口业务实现、模型工具（[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/core/src/core.rs`、`inbox.rs`、`clock.rs` | `Core`：`reduce`、`SliceMask`、6 路切片投影（含 `SpaceView` 中的结构化领域摘要 `BoardSummary` / `MediaSummary` / `ChannelSummary`）、离线 `slice_bundle`、`Transition`；收件箱纯计算（`inbox`）；Layer 2 挂钟抽象 `Clock` / `ManualClock` |
| `crates/server/src/lib.rs`、`base.rs`、`app/hub/event_bus.rs`、`app/hub/slice_feed.rs`、`app/hub/slice_wake.rs`、`app/hub/runtime_inbox.rs` | `Hub`、读写分离 `ServerDb` 连接池、有界异步 `EventBus`、预编码共享 `Arc<str>` 的 6 路脏合并 `SliceFeed<T>`、无堆分配原子唤醒门 `SliceWakeGate`（`dirty_seqs` + `pending_mask`）与 `RuntimeInboxObserver`：持有 `Core`、端点表、同步/异步双轨命令总线 `Hub::invoke` / `invoke_async`（无条件 `trace_id` + `hub.op` `tracing::debug_span!`）、带 `Subscription::CAN` 权限校验的订阅表、`tokio::sync::broadcast` 实时事件流与 `CancellationToken`/`TaskTracker` 停机作用域（`DropGuard` 收口），按 `Applied.dirty: SliceMask` 仅推送变脏切片（`effects` 仅进 `farm`），经 `Fact::RuntimeInboxChanged` 将持久 `pi.inbox` 运行时告警折入 `SpaceState`；经 `Slot<T>`（`ArcSwapOption<Arc<T>>`）与 `OnceLock` 挂接 `CallerContext`/`ClientIdentity` 与 `InvokeObserver`/`FaultGate`/`HostDebugBridge`/`RemoteAuth`/`LiveVoicePort` 窄端口，脊柱本身零 `crate::<domain>::*` 导入 |
| `crates/server/src/app/bootstrap.rs` | `start`：经 `ServerDb` 连接池按 `L0` → `L1` → `L2` → `L3` 依赖次序打开并注入全部模块，注册端点、订阅与 `LiveVoicePort`，并通过 `ShutdownList` 协调排空；仅在 `VIBEVALLEY_DEBUG=1` 时挂接观察器、`FaultGate` 与 `OarObserver`；对外 `Started` 仅暴露 `hub`、`set_mcp_url` 与 `close` |
| `crates/server/src/main.rs` | 二进制 `vibevalley-server`：初始化工作区 `tracing_subscriber`（`VIBEVALLEY_LOG`/`RUST_LOG`，`VIBEVALLEY_DEBUG=1` 默认 `info` 否则 `warn`），支持 `--web`、`--ready-json`，读环境变量，写 `server.json` |
| `crates/protocol/src/contract/` | `SpaceState`、`Fact`（含 `RuntimeInboxChanged`）、`SliceKind`、5 域切片（含 `BoardSummary` / `MediaSummary` / `ChannelSummary`）、`FarmFrame`、`SliceBundle`、`LiveEvent`、`DebugKit`（`debug.rs`）、远程访问契约（[remote.rs](crates/protocol/src/contract/remote.rs)，含 6 类 `RemotePlatform` 与 `scope` 常量）、GPUI 壳强类型协议（`host.rs`：`Host*` 帧、`HostAction` 与 `HostOp`）、接口表 `ENDPOINTS` 与带 `CAN` 权限表的 `SUBSCRIPTIONS`（`endpoints.rs`），手写的源头，TS 由它生成 |
| `crates/protocol/src/envelope.rs` | 全信封、`BizCode`、`ApiError` |
| `crates/server/src/transport/http/{auth,mod,media,machine_ws}.rs` | 全 Axum 网关：`auth.rs` 定义四类编译期强类型鉴权提取器（`Authenticated`、`AuthenticatedQuery`、`LocalOnly`、`LocalOnlyStatus`）及 `from_the_farm` 同源守卫；`mod.rs` 按安全策略拆分 `authenticated_api_routes`、`machine_routes`、`local_only_routes` 并以 `http.request` `debug_span!` 追踪请求；统一 SSE（`sse_with_shutdown`）与 `tokio-util` `ReaderStream` / `SyncIoBridge` 分块流式读取（`/api/v1/attachment/{id}` 与 `media.rs` 上传/Range 下载）；包含本机门与独立受认证远程监听门（`serve_remote`） |
| `crates/cli/src/` | 命令行 `vibevalley`：`main.rs` 入口（含全局 `--server` / `--token`）、`client.rs` HTTP/SSE 客户端（支持 `auth.json` 与 Bearer 鉴权、`Client::slice`）与退出码、`output.rs` 输出格式化、`domains/` 按五大业务域组织的强类型子命令（含 `infra` 域下的 `auth` 与 `remote`） |

全部接口与权限矩阵见生成的 [capabilities.md](docs/reference/capabilities.md)。

## 模型和不变量

### 核心状态与事实

- **单一内存投影，按事实演进**：`SpaceState` 只在 `Hub::apply(facts)` 中修改。未改变状态的事实不广播、不递增 `seq`、不触发特效。
- **「事实」专指 `Hub::apply` 的输入**：农机能力叫 `RuntimeSupport`，会话事件映射叫 `Reaction`，一条频道消息和它的听众叫 `ChannelHearers`，排序键叫 `RowKeys`。
- **事实命名表达发生了什么**：实体新增或更新叫 `<实体>Changed`，移除叫 `<实体>Removed`，生命周期结清用动词过去式（`sessionPhaseChanged`、`sessionReported`、`sessionLeft`）。
- **批次原子可见，按脏掩码精准出切片**：`Hub::apply`（`crates/server/src/lib.rs`）在局部状态上逐条折叠并收集每条 `Transition`（`{ before, fact, after }`）、特效与累计脏切片掩码 `Applied.dirty: SliceMask`，一次性替换可见状态、递增一次 `seq` 并立即释放核心锁，再经有界异步 `EventBus`（每订阅者在共享 `vibevalley_runtime::rt` 运行时上以轻量 Tokio 任务消费容量 1024 的 `tokio::sync::mpsc`，同步处理体经 `spawn_blocking` 执行，由 `CancellationToken` 协作停机）非阻塞扇出 `Transition`，同时仅唤醒 `dirty` 命中的 `SliceFeed<T>`（`effects` 仅发往 `SliceKind::Farm`），禁止在 `Hub::apply` 锁内同步写盘或重入。`reduce` 不得修改传入的旧状态。
- **先落库，后发事实**：各模块先提交数据库事务或文件，再调 `Hub::apply`。重启时从空状态由各模块从 `server.db` 及家目录文件恢复。
- **按依赖重算工单派生状态**：`reduce` 仅在工单或会话集合引用变化时重算工单状态与动作（`withIssueStatuses`）；聊天或花费事实不触发工单重算。一轮进行中的 `sessionPhaseChanged` 只改了 `doing` 或 `spent`（`since`、`quietSince` 不变，`phaseAffectsIssue`）时跳过工单重算且不标脏 `BOARD`。
- **界面文案只在出切片时填充；跨视图摘要保持纯结构化枚举**：6 个纯投影函数（`board_slice`、`sessions_slice`、`collab_slice`、`inbox_slice`、`ops_slice`、`farm_frame`）按需在对应切片上填入 `phaseText`、`actionText`、`whenText`、工单 `stage` 与可执行动作；`reduce` 与持久层不含界面文案。`SpaceView` 内的 `BoardSummary`（`laneCounts`、`runningSlots`、`maxRunning`、`byIssue: BoardIssueSummary` 含 `lane`/`cardKind`/`familyDone`/`familyTotal`/`needsWorktreeCheck`/`prompt: Option<IssuePromptKind>`）、`MediaSummary`（`activeCount`、`activeIds`）与 `ChannelSummary`（`unreadTotal`、`unreadUnder`）仅输出结构化枚举、计数与实体 id，绝不拼本地化自然语言句子，使中英双语切换与工作台/像素农场双皮肤解耦。`SliceBundle` 仅用于离线夹具与 `export_scenarios` 导出，不对外提供聚合 HTTP 端点。
- **无条件 `trace_id`、`tracing::Span` 与零开销 `DebugKit`**：`Hub` 与 `Server::call_with` / `call_with_async` 统一透传 `CallerContext`（`caller`、`principal: CallerPrincipal`、`client: Option<ClientIdentity>`、`trace_id: u64`）；当 `trace_id == 0` 时无条件由 `next_trace_id` 分配单调非零值，并在同步（`span.enter()`）与异步（`.instrument(span)` + `spawn_blocking` 继承）路径建立 `debug_span!("hub.op", op, trace_id, caller)`。`Slot<T>`（`ArcSwapOption<Arc<T>>`）挂载 `InvokeObserver`、`FaultGate` 与 `HostDebugBridge` 三处钩子；未挂载时仅做无锁原子读取，零锁零堆分配。`crates/server/src/infra/debug/` 提供 `DebugKit` 及 9 个仅限 `Caller::User` 的 `debug.*` 端点，仅在 `VIBEVALLEY_DEBUG=1` 时启用四泳道定长环形缓冲（`CoreApply`、`BridgeRpc`、`OarWire`、`GpuiFrame`，每泳道 512 条）、`FaultGate` 与 `OarObserver`；未启用时一律以 `BizCode::Refused` 拒绝。`Hub::call_with` 与 `FaultGate` 始终跳过 `debug.*` 前缀调用，全部输出与纯 Rust ZIP 诊断包（`debug-bundle.zip`）均经过统一脱敏器。本机 `vibevalley` CLI 不提供 `debug` 子命令。

### 收件箱

九种待处理事项（`InboxKind`，定义在 `crates/protocol/src/contract/inbox.rs` 与 `crates/core/src/inbox.rs`）：

| 种类 | 触发条件 |
|---|---|
| `review` | 工单处于 `reviewing`（帮工做完一轮或全部子单完成，等用户验收） |
| `ask` | 工单处于 `asking`（帮工带着问题等用户回答） |
| `fix` | 工单处于 `stuck: failed`（上一轮失败） |
| `interrupted` | 工单处于 `stuck: interrupted`（上一轮停在半路） |
| `conflict` | 工单处于 `stuck: conflict`（合入主分支存在冲突） |
| `quiet` | 工单处于 `stuck: quiet`（执行中长时间无事件） |
| `mention` | 频道或串中有未读且未回复的 `@用户` 消息（`Chat.userMentions`）或持久运行时提及 |
| `cron-ask` | 助手创建的定时任务处于 `pending` 等待用户同意 |
| `budget_reached` | 持久执行引擎（`pi.inbox`）触发预算上限告警（`InboxFrom::Runtime` / `InboxTarget::Runtime { task_id, session_id }`） |

- **纯函数现算并经事实合流运行时告警**：`RuntimeInboxObserver`（`crates/server/src/app/hub/runtime_inbox.rs`）订阅持久 `pi.inbox` 文档并通过 `Hub::apply` 施加 `Fact::RuntimeInboxChanged`，由 `reduce` 折叠进 `SpaceState.runtime_inbox_items` 并仅在变化时标脏 `SliceMask::INBOX`；`inbox_slice(state, seq)` 由 `inbox(state)` 直接合并算出 `InboxSlice.items`，每条有稳定的 id，带 `who` 和预填好的文案 `words`（`label`、`title`、`body`、`tray`）。原生子工单成功完成后自动合入父分支，不单独产生 `review`。
- **首次打开已有的不响铃（`freshOf`）**：页面首次打开经 `packages/protocol/src/rules/inbox.ts` 的 `freshOf` 记下存量 id，之后新出现的 id 才响铃和通知，同一个只响一次。

### 切片、SSE 流和其余路由

| 路径 | 编码 Schema | 初始消息 | 后续推送 | 消费者 |
|---|---|---|---|---|
| `GET /api/v1/slice/{name}`（`name` ∈ `board` \| `sessions` \| `collab` \| `inbox` \| `ops` \| `farm`） | `BoardSlice` / `SessionsSlice` / `CollabSlice` / `InboxSlice` / `OpsSlice` / `FarmFrame` | 带 `Accept: application/json` 或 `?once=1` 直接返回当前 JSON 快照；SSE 首帧推送最新切片（支持 `Last-Event-ID` 或 `?after=<seq>` 续读跳过已收序号） | 经 `SliceFeed<T>`（`tokio::sync::watch` + `WatchStream`）脏合并推送（`id: <seq>\ndata: <json>\n\n`），无阻塞线程开销；`farm` 携带窗口内有序 `effects` | HTTP 客户端、CLI |
| `GET /api/v1/live`（别名 `/api/v1/events`） | `LiveEvent` | 无 | 经 `Hub::subscribe_live()`（有界 `tokio::sync::broadcast`）推送 `SessionEvent`、`Notice`、`Runtime` | 页面 |
| `GET /api/v1/issue/watch/:id` | `IssueWatch` | 工单状态与保留的轨迹 | 状态、轨迹和缺口（[观察执行](docs/subsystems/issue.md#观察执行)） | `issue watch` |
| `GET /api/v1/subscribe/<名字>?payload=<JSON>` | 各订阅的 `event`（`SUBSCRIPTIONS` 与 `packages/protocol/src/api.ts` 定义，均声明 `Subscription::CAN`） | 经 `Server::subscribe_with` 校验 `CallerContext` 与 `CAN`，通过后补齐 `after` 之后的变化 | 之后的每次变化 | 页面与远程客户端：`channel.follow`、`channel.reports`、`artifact.follow`、`artifact.entry.follow`、`artifact.suggestion.follow`、`artifact.presence.follow`、`session.watch`、`issue.watch` |

订阅流的调用方无权（不满足 `Subscription::CAN`）返回 `403`（`BizCode::Forbidden`），入参解不开或第一条事件之前被拒绝回普通 JSON 错误信封，不是流；开始推送以后出错只结束流。

SSE 以外的路由：

- `GET /api/v1/attachment/<id>`：附件流式下载（校验 `CallerContext` 与 `attachment.file` 权限，接受 `Authorization: Bearer` 或 `?token=`，以 `tokio::fs::File` 支持 HTTP `Range` 分块读取）；`GET /api/v1/artifact/<id>/<version>` 与 `GET /api/v1/artifact/<id>/view`：网页与结构化 Artifact 沙箱视图。
- `PUT`、`GET /api/v1/media/input/<id>/content`：上传和读取媒体输入；`GET /api/v1/media/speech/<id>/stream`：合成语音的流（[媒体](docs/subsystems/media.md)）。
- `/mcp`：帮工的工具（[频道](docs/subsystems/channel.md)）。

- **客户端拥有流与订阅的生命周期**：原生页面与像素场景经 `crates/server/src/transport/bridge` 按需订阅 `slice:<name>`、`LiveEvent` 与订阅事件，视图关闭或取消订阅时立即释放 `Subscription`；命令行的 `Client::slice` 与 `Client::sse`（`crates/cli/src/client.rs`）在 HTTP 上直读 JSON 快照或按空行分帧解码 SSE，坏帧、HTTP 拒绝或退出时立即释放连接。
- **心跳**：每条 SSE 连接（含切片流、工单观察流和订阅流）每 20 秒发 `: ping` 心跳；订阅方断开时释放源订阅。
- **写接口返回 `seq` 对齐切片**：工单写接口（`issue.create`、`issue.update`、`issue.status.update`、`issue.comment.create`）在 `Hub::apply` 后返回当前 `seq`，页面以对应切片的 `slice.seq >= reply.seq` 作为意图结算条件。

### HTTP 接口与命令行

- **统一 `POST /api/v1/<路径>` 与全信封 JSON 响应**：操作名中的 `.` 换为 `/` 即路径（如 `issue.status.update` → `/api/v1/issue/status/update`），参数统一放入 JSON 请求体。所有 JSON 接口统一返回全信封：成功返回 HTTP `200` 与 `{ bizCode: 0, message: "ok", data? }`（无返回值接口省略 `data`）；网关拒绝与业务错误按 `bizCodeMeta` 映射标准 HTTP 状态码（`400`、`401`、`403`、`404`、`405`、`409`、`413`、`415`、`500`、`502`、`503`），响应体统一为 `{ bizCode, message, error?: { next?, settings? } }`。二进制下载、HTML 预览、SSE 与 NDJSON 流保持各自媒体类型。
- **六位分段业务码 `BizCode`**：`BizCode`（契约里定义，Rust 在 `envelope.rs`）（成功为 `0`；`100xxx` 网关与协议、`200xxx` 鉴权与局域网、`300xxx` 工单与仓库、`400xxx` 会话与助手、`500xxx` 频道与连接器、`600xxx` 产物与素材、`700xxx` 语音与媒体配置），经 `bizCodeMeta` 静态绑定 HTTP 状态码、语义分类 `kind` 与可重试性 `retryable`。
- **严格来源校验与编译期类型化 Axum 鉴权提取器**：[auth.rs](crates/server/src/transport/http/auth.rs) 通过 `FromRequestParts<HttpState>` 在路由签名层强制校验鉴权策略：`Authenticated` 校验 Bearer 令牌或本机 `from_the_farm` 同源请求（`Host` 回环、`Origin` 同源、`Sec-Fetch-Site` 为 `same-origin` 或 `none`），失败返回 `Envelope` JSON 错误；`AuthenticatedQuery` 允许 `?token=` 承载令牌（覆盖 `/api/v1/attachment/{id}`）；`LocalOnly` 强约束 `!state.is_remote && from_the_farm(&headers)`（返回 `Envelope` JSON 拒绝，`/mcp` 同时拒绝 `vv_dev_` 远程令牌）；`LocalOnlyStatus` 同等校验但拒绝时返回裸 `403 StatusCode::FORBIDDEN`（保持 `media::content` 契约）；`machine_ws::upgrade` 强校验 Bearer 令牌且要求 `SCOPE_REMOTE_MACHINE`，绝不回落本机默认身份。流式上传（`media::upload`）经 `tokio_util::io::StreamReader` + `SyncIoBridge` 维护 `512_000_000` 字节上限与 300 秒截止；分段下载（`attachment` 与 `media::content`）经 `file_range_stream`（`tokio::io::AsyncReadExt::take` + `tokio_util::io::ReaderStream::with_capacity(..., 64 * 1024)`）流式输出 HTTP `Range`。
- **请求幂等键 `requestKey`**：`issue.create`、`issue.status.update`、`channel.thread.create`、`memory.create` 接受 `requestKey`（最长 64 字符，超长返回 `409` `BizCode.RequestKeyTooLong`）。同一个键五分钟内重试拿到第一次的回答（`crates/server/src/db/mod.rs`），失败不缓存。
- **开关写成幂等设值**：回应、置顶、归档定义为带 `on: boolean` 的 `*.set` 接口，重复设置相同值不产生副作用。
- **破坏性操作配对试跑 `dryRun`**：删除、合并、关单接口在 `endpoints` 中指向对应的 `preview<动词>` 接口。试跑与真做共用同一套前置判断函数，试跑不写库、不碰 git。
- **拒绝响应附带下一步 `next`**：业务拒绝与未找到错误在 `error.next` 中携带 `{ say, run? }[]`，给出可直接运行的 CLI 命令或指引。
- **CLI 是纯 HTTP 客户端**：`crates/cli` 不载入服务端、不直连数据库；目标地址按 `--server` / `VIBEVALLEY_SERVER` > `$VIBEVALLEY_HOME/auth.json` > 当前发布通道家目录 `server.json`（未记录时回落通道默认端口，见 `crates/protocol/src/home.rs`）依次解析，Bearer 令牌按 `--token` / `VIBEVALLEY_REMOTE_TOKEN` > 与目标地址匹配的 `auth.json`（`0600`）附带 `Authorization: Bearer`；提供 `vibevalley auth`（`login` / `whoami` / `status` / `logout`）与 `vibevalley remote`（`status` / `enable` / `disable` / `code` / `revoke`），失败时 stderr 打一行 JSON，退出码同 TS 版。
- **拥有者负责协调与身份分配**：处理器只传业务意图，跨域写入统一走强类型进程内命令总线 `Hub::invoke<O>`（与 HTTP 共用 `O::CAN`、`InvokeObserver` 与 `FaultGate`），由拥有者模块协调内部步骤并在锁内分配新实体 ID；查询缺失关联时列入 `missingSessions`，不伪造缺省对象。

### 受控远程访问

- **默认关闭与绑定约束**：`crates/server/src/infra/remote/` 默认关闭远程监听；仅本机 `Caller::User` 调用 `remote.enable` 时，服务端按显式 `bindAddr` / `VIBEVALLEY_REMOTE_BIND` → 在线 Tailscale IPv4（`100.64.0.0/10`）→ `127.0.0.1`（供 iOS Simulator 或本地联调）的优先级选取监听地址，在独立端口（通道默认端口 `+ 100`，如 dev `8890` / release `8887`）启动 `serve_remote`，默认拒绝绑定通配或公网地址（显式设置 `VIBEVALLEY_REMOTE_ALLOW_ALL=1` 可用于局域网或反向代理部署）；`remote.disable` 立即停机并持久化关闭状态。
- **一次性配对码、平台分类与作用域**：`remote.pair.create`（仅 `Caller::User`）在远程开启时生成 5 分钟有效、单次使用的高熵配对码与 `vibevalley://pair?url=<encoded>&code=<code>` 深链，支持可选 `scope`（`SCOPE_REMOTE_CLIENT = "remote:default"`、`SCOPE_REMOTE_MACHINE = "remote:runtime"`）；`remote.pair.exchange` 接受 6 类 `RemotePlatform`（`ios`、`android`、`cli`、`machine`、`sandbox`、`other`）并受失败速率限制保护，核验后立即作废配对码、持久化 `scope` 并签发 `vv_dev_*` 持久 Bearer 令牌，数据库（`remote_device`）只存 SHA-256 哈希，线缆类型 `RemoteDeviceSummary` 永不返回 `token_hash`。
- **`RemoteAuth` 插槽与最小权限边界**：`Hub` 通过无锁 `ArcSwapOption` 挂载 `RemoteAuth`；远程监听门除 `remote.pair.exchange` 外强制校验 `Authorization: Bearer <token>`（`GET /api/v1/attachment/{id}` 同时支持 `?token=` 供媒体标签读取），认证通过后构造 `Caller::Remote` 与 `CallerPrincipal::RemoteDevice { device_id, scope }` 并更新 `last_seen_at`，已撤销（`remote.device.revoke`）或未知令牌立即返回 `401`（`BizCode::Unauthorized`）。远程门开放已认证设备访问 `GET /api/v1/slice/{name}`（支持 `Last-Event-ID` 续读）、`/live`、经 `Subscription::CAN` 放行的 `/subscribe/{name}`、`GET /api/v1/attachment/{id}`（`attachment.file` 授权 `Caller::User` 与 `Caller::Remote`）及 `can` 包含 `remote` 的业务端点，严格拦截 `debug.*`、`/mcp` 及全部 `Caller::User` 专属管理端点（`remote.{status,enable,disable,pair.create,device.revoke}`、`setting.update`、`agent.{create,update,delete}`、`provider.*`、`connector.{login,verify,logout,channel.set}`、`repo.pr.submit`）。

## 怎么走

**施加一条事实**

1. 拥有者模块提交数据库事务或文件后，调用 `Hub::apply(facts)`。
2. `Core` 运行 `reduce`，收集变更与脏切片掩码 `dirty: SliceMask`；若状态未变则直接结束。
3. 原子替换可见状态、递增 `seq` 并释放锁，经有界异步 `EventBus` 把 `Transition` 扇出给订阅它的模块（`Hub::subscribe_transitions`）。
4. `Hub` 仅向 `dirty` 命中的切片 `SliceFeed<T>` 发出脏信号（`effects` 仅入 `farm` 通道）；未变脏的切片不复制、不序列化、不唤醒下游消费者。
5. `SliceFeed<T>` 以 `tokio::sync::watch` 持有最新切片快照，空闲后首次变脏立即唤醒，连续变化自动合并为最新快照；HTTP SSE 经 `WatchStream` 直接推送，`BridgeHub` 以轻量 Tokio 任务与每连接 `CancellationToken` 维持单帧 ACK（确认 `rev` 后再推下一份快照）。

**服务端启动**

1. `start`（`crates/server/src/app/bootstrap.rs`）从空状态起 `Hub`，按序打开设置、游戏、AI 服务、档案和农机、仓库、记性、轨迹、工单板（共用 `server.db`）、PR 与分支发布、定时任务、附件、媒体输入、频道、素材库、媒体任务、Artifact、助手、`IssueChat`、`SessionChat`、`RuntimeInboxObserver` 与连接器；各自从 `server.db` 与家目录文件读回并施加初始事实。
2. 工单板接回停机时在场的会话；`IssueChat`、`SessionChat` 与 `Orchestrator` 各自补投 SQLite 中未结算的 `channel_delivery`、`session_mailbox` 与 `issue.report`。
3. `main.rs` 绑定端口（按 `VIBEVALLEY_PORT`，`0` 为随机端口；未设时取当前发布通道默认端口：`release` `8787`、`beta` `8788`、`alpha` `8789`、`dev` `8790`），写出 `server.json`，`--ready-json` 打印 `{"url","pid"}`。

## 和谁打交道

- **施加事实的模块**：工单板（`work/issue` 与 `work/session`，经 `work/ledger.rs`）、`channel`、`media`、`cron`、`game`、`agent`、`RuntimeInboxObserver`。
- **订阅事实的模块（`EventBus`）**：`game`、`memory`、`runtime`、`library`、`issue`（`issue-watch`）、`session`（`session-chat`）。
- **外部客户端**：`apps/mac`（进程内经桥按切片订阅）、`apps/mobile`（通过 `@vibevalley/protocol/remote` 的 `HttpRemoteTransport` 经远程门带 Bearer 令牌与 `Last-Event-ID` 订阅）、命令行 `vibevalley`（HTTP `/api/v1/slice/{name}`）。

## 为什么这样

- **单一内存状态 + 纯函数 `reduce` + 按域切片**：写入端仍以单一 `SpaceState` 与领域 `Fact` 维持无环归约与编译器穷尽检查，读侧拆为 5 域切片 + 独立 `FarmFrame`，避免频道消息或游戏特效触发工单板与会话列表全量重渲染。
- **「事实」只留一个意思，成员名带语义**：非核心状态概念改回本名，事实用 `<实体>Changed`/`<实体>Removed`/动词过去式，消除名词歧义。
- **页面读折好的切片，文案在出切片时填入**：避免前后端维护两套 `reduce`；界面文案不落盘、不进 `Transition`，改措辞或切语言无历史兼容负担。
- **命令走 `POST /api/v1/<op>`，切片和订阅走 SSE**：操作名即路径，省去 REST 参数拆分；`/api/v1/slice/{name}`、`/live`、`/events` 按职责分离，支持 `Last-Event-ID` 续读与按需 JSON 快照；移除零消费者的 `/api/v1/state` 与 `/chord/ws`。
- **能力表 `endpoints` 单源派生多端入口**：权限 `can`、Schema、试跑与路径写在同一行，自动生成或校验 Rust 的 `ENDPOINTS`、`VibeValleyApi` 与 `capabilities.md`。

## 还没做的

- `can` 只留 `user` 与 `remote`，agent 工具按档案配置：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。
- 取消 `Hub` / `SpaceState` 影子库与 `EventBus`，直接切换至四层全单数服务端脊柱（`App`、`ServerDoor`、`ServerDb` 事务 + `SliceProjector` + 统一 `Outbox`）：[第一性原理服务端脊柱重构](.agents/notes/proposed/architecture/2026-11-24-first-principles-server-spine.md)。

## 怎么验证

- `crates/core/tests/projection.rs`：`reduce`、`SliceMask` 与切片投影对 golden。
- `crates/server/tests/contract.rs`：信封、按端点的类型解码入参、`can`。
- `crates/server/tests/start.rs`：整个服务端起来、经 HTTP 走一遍。
- `crates/cli/tests/cli.rs`：命令行对着真的 `vibevalley-server`。
