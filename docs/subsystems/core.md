# 核心状态和接口

持久化状态以双后端数据库与独立顶层数据服务 `service/`（`Service`，挂载于 `Context::service`）为唯一真源；运行中会话流、心跳与农场特效留在内存 `LiveState`；每次事务写入返回脏切片掩码 `SliceMask`，由 `StateFeed` 结合 `crates/core/src/projection.rs` 纯投影函数产出 6 路独立切片。外部命令经薄入口门 `Router`（`router.rs`）和 `POST /api/v1/*` 进入，状态、事件与订阅走 SSE 流。本篇是状态投影、路由、流与远程访问的唯一清单。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 脏切片掩码 `SliceMask`、统一事务性 `Outbox`、瞬态 `LiveState`、序号 `seq` 与 6 路切片（`BoardSlice`、`SessionsSlice`、`CollabSlice`、`InboxSlice`、`OpsSlice`、`FarmFrame`）的 `StateFeed` 单航班投影与推流 | 各业务表结构与具体业务规则（[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)、[频道](docs/subsystems/channel.md)、[定时任务](docs/subsystems/issue.md#定时任务)） |
| 地块与笔记外的切片聚合与收件箱纯计算（`crates/core/src/inbox.rs`） | 地块画面规则与游戏账本计算（[游戏](docs/subsystems/game.md)、[农场的皮](docs/subsystems/farm.md)） |
| 全部路由：SSE／快照流（`/api/v1/slice/{name}`、`/live`、`/events`、工单观察流、订阅流）和其余 `GET`、`PUT` 路由 | 订阅里频道和 Note 协同的事件内容（[频道](docs/subsystems/channel.md)、[Note](docs/subsystems/note.md)）、工单观察流的内容（[工单](docs/subsystems/issue.md#观察执行)）、帮工 `/mcp` 的工具 |
| 接口表 `ENDPOINTS`（`EndpointId`）与 `NATIVE_ENDPOINTS`（`NativeEndpointId`）、`Router` 编译期穷尽分发、权限 `can`、`CallerContext`、幂等键 `requestKey`、试跑 `dryRun`、`InvokeObserver`、`FaultGate`、`HostDebugBridge`、`GatewayPorts` 与 CLI 映射 | 各接口业务实现、模型工具（[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/core/src/projection.rs`、`crates/core/src/inbox.rs`、`crates/core/src/clock.rs` | 纯投影函数：6 路切片投影（含结构化领域摘要 `BoardSummary` / `MediaSummary` / `ChannelSummary`）与离线 `SliceBundle`；收件箱纯计算（`inbox`）；挂钟抽象 `Clock` / `ManualClock` |
| `crates/server/src/`（`main.rs`、`app.rs`、`router.rs`） | `main.rs` 按 `log::init(...)` → `create_app(config).await?` → `gateway::serve(...)` 启动并写 `server.json`；`app.rs` 提供浅层不可变组合根 `App`、`create_app(config)` 与 `App::close()`；`router.rs` 提供约 200 行薄入口门 `Router`（`check_can`、`trace_id` span、`FaultGate`、`InvokeObserver`、订阅表鉴权与全部 `EndpointId` / `NativeEndpointId` 编译期穷尽分发） |
| `crates/server/src/log/`、`crates/server/src/db/`、`crates/server/src/service/`、`crates/server/src/context/` | `log/` 收拢 `init`、`span`、`spawn_traced`、`spawn_blocking_traced` 与 `observer`（`InvokeObserver`）；`db/` 提供双后端 `Database`、`migration/` 与严格一表一文件的 `db/entity/<table_name>.rs`（共 36 表）；独立顶层 `service/` 提供业务视角持久化查询聚合 `Service`（`outbox`、`storage`、`channel`、`connector`、`note`、`session`、`issue`、`memory`、`cron`、`remote`），`crates/server/src/{db,service}/` 之外零 `sea_orm::` 与 `db::entity` 导入；`context/` 提供共享 `Context`（`service: Arc<Service>`、`task: TaskGroup`、`live: Arc<LiveState>`、`outbox: Arc<Outbox>`、`feed: Arc<StateFeed>`、`clock: SharedClock`）及 `error.rs`、`http.rs`、`text.rs` |
| `crates/protocol/src/contract/`、`crates/protocol/src/native.rs`、`crates/protocol/src/envelope.rs` | 契约形状、`SliceKind`、5 域切片、`FarmFrame`、`SliceBundle`、`LiveEvent`、`DebugKit`（`debug.rs`）、远程访问契约（[remote.rs](crates/protocol/src/contract/remote.rs)）、GPUI 壳强类型协议（`host.rs`）、`EndpointId`、`NativeEndpointId`、带 `CAN` 的 `SUBSCRIPTIONS`、全信封、`BizCode` 与 `ApiError` |
| `crates/server/src/gateway/`（`api/`、`bridge/`、`http/`、`remote/`） | `api/` 定义对外服务契约与非 RPC `GatewayPorts`；`bridge/` 为 GPUI 进程内桥；`http/` 为全 Axum 网关（`auth.rs` 四类鉴权提取器、`media.rs` 上传与 Range 下载、`machine_ws.rs` 机器连接、统一 SSE 与 `/mcp`）；`remote/` 为默认关闭的受认证远程访问控制与独立监听门 |
| `crates/cli/src/` | 命令行 `vibevalley`：`main.rs` 入口（含全局 `--server` / `--token`）、`client.rs` HTTP/SSE 客户端（支持 `auth.json` 与 Bearer 鉴权、`Client::slice`）与退出码、`output.rs` 输出格式化、`domains/` 按业务域组织的强类型子命令（含 `auth` 与 `remote`） |

全部接口与权限矩阵见生成的 [capabilities.md](docs/reference/capabilities.md)。

## 模型和不变量

### 状态真源、瞬态与切片投影

- **单一持久化真源与事务性 `Outbox`**：持久化状态只经顶层 `service/`（`ctx.service`）落库，不维护内存影子库或启动重放水合。每次业务写入在同一数据库事务内提交业务表与异步投递 `Outbox`（`outbox_item` 表），返回受影响的脏切片掩码 `SliceMask`；事务提交后调用 `ctx.mark_dirty(mask)` 通知 `StateFeed`。
- **数据访问硬边界**：`crates/server/src/db/entity/` 严格一表一文件（`<table_name>.rs`，共 36 表），全部 SeaORM 查询集中在独立顶层 `crates/server/src/service/`；`crates/server/src/{db,service}/` 之外禁止出现任何 `sea_orm::` 或 `db::entity` 导入。
- **瞬态只进 `LiveState`**：运行中会话的实时步骤流、心跳与像素农场突发特效只写 `LiveState`（`context/` 的 `live.rs`），不入库，避免高频瞬态触发数据库写入。
- **单航班脏合并与 6 路切片**：`StateFeed`（`context/` 的 `feed.rs`）经无堆分配原子唤醒门 `SliceWakeGate`（含 `--features loom` 并发模型检验）合并连续脏信号；仅对 `SliceMask` 命中的切片查询当域视图并调用 `crates/core/src/projection.rs` 纯投影函数，产出预编码共享 `Arc<str>` JSON 快照写入 `tokio::sync::watch`（农场特效只发往 `SliceKind::Farm`）。未变脏的切片不查库、不序列化、不唤醒下游消费者。
- **界面文案只在投影时填充；跨视图摘要保持纯结构化枚举**：6 个纯投影函数（`board`、`sessions`、`collab`、`inbox`、`ops`、`farm`）按需在对应切片上填入 `phaseText`、`actionText`、`whenText`、任务 `stage` 与可执行动作；持久层不含界面文案。`BoardSummary`（`laneCounts`、`runningSlots`、`maxRunning`、`byIssue: BoardIssueSummary`）、`MediaSummary`（`activeCount`、`activeIds`）与 `ChannelSummary`（`unreadTotal`、`unreadUnder`）仅输出结构化枚举、计数与实体 id，绝不拼本地化自然语言句子。`SliceBundle` 仅用于离线夹具与 `export_scenarios` 导出，不对外提供聚合 HTTP 端点。
- **薄入口门 `Router`、`trace_id`、`tracing::Span` 与零开销 `DebugKit`**：`Router`（`router.rs`）统一透传 `CallerContext`（`caller`、`principal: CallerPrincipal`、`client: Option<ClientIdentity>`、`trace_id: u64`）；当 `trace_id == 0` 时无条件分配单调非零值，并在异步与阻塞路径经 `log/` 的 `spawn_traced` / `spawn_blocking_traced` 传播请求 `tracing::Span`。`Router` 对 `ENDPOINTS` 与 `NATIVE_ENDPOINTS` 做编译期穷尽 `match` 分发并直委各域处理器，零运行时 handler `HashMap` 与 `attach_*` 晚绑定槽位。`crates/server/src/debug/` 提供 `DebugKit` 及 9 个仅限 `Caller::User` 的 `debug.*` 端点，仅在 `VIBEVALLEY_DEBUG=1` 时启用环形缓冲、`FaultGate` 与 `OarObserver`（未启用一律返回 `BizCode::Refused`）；`Router` 与 `FaultGate` 始终跳过 `debug.*` 前缀调用，全部输出与纯 Rust ZIP 诊断包（`debug-bundle.zip`）均经统一脱敏器。面向原生桌面应用远程实时调试时，`vibevalley debug`（`crates/cli/src/domains/debug.rs`）经由 VDP 回环协议（`--remote-debugging-port` / `VIBEVALLEY_DEBUG_PORT`、`debug.json` 与随机令牌，见[客户端](docs/subsystems/app.md#本地轻应用与-vdp-远程调试)）直连运行中的 `vibevalley-mac` 实例。

### 收件箱

九种待处理事项（`InboxKind`，定义在 `crates/protocol/src/contract/inbox.rs` 与 `crates/core/src/inbox.rs`）：

| 种类 | 触发条件 |
|---|---|
| `review` | 任务处于 `reviewing`（执行会话做完一轮或全部子单完成，等用户验收） |
| `ask` | 任务处于 `asking`（执行会话带着问题等用户回答） |
| `fix` | 任务处于 `stuck: failed`（上一轮失败） |
| `interrupted` | 任务处于 `stuck: interrupted`（上一轮停在半路） |
| `conflict` | 任务处于 `stuck: conflict`（合入主分支存在冲突） |
| `quiet` | 任务处于 `stuck: quiet`（执行中长时间无事件） |
| `mention` | 频道或话题中有未读且未回复的 `@用户` 消息（`userMentions`）或持久运行时提及 |
| `cron-ask` | 主助手创建的定时任务处于 `pending` 等待用户同意 |
| `budget_reached` | 持久执行引擎（`pi.inbox`）触发预算上限告警（`InboxFrom::Runtime` / `InboxTarget::Runtime { task_id, session_id }`） |

- **纯函数现算并合流运行时告警**：`StateFeed` 投影 `inbox` 切片时将当域任务、频道提及、待批定时任务与持久执行引擎告警（`pi.inbox`）交由 `crates/core/src/inbox.rs` 算出 `InboxSlice.items`，每条有稳定的 id、带 `who` 和预填文案 `words`（`label`、`title`、`body`、`tray`）。子任务成功完成后自动合入父分支，不单独产生 `review`。
- **首次打开已有的不响铃（`freshOf`）**：页面首次打开经 `packages/protocol/src/rules/inbox.ts` 的 `freshOf` 记下存量 id，之后新出现的 id 才响铃和通知，同一个只响一次。

### 切片、SSE 流和其余路由

| 路径 | 编码 Schema | 初始消息 | 后续推送 | 消费者 |
|---|---|---|---|---|
| `GET /api/v1/slice/{name}`（`name` ∈ `board` \| `sessions` \| `collab` \| `inbox` \| `ops` \| `farm`） | `BoardSlice` / `SessionsSlice` / `CollabSlice` / `InboxSlice` / `OpsSlice` / `FarmFrame` | 带 `Accept: application/json` 或 `?once=1` 直接返回当前 JSON 快照；SSE 首帧推送最新切片（支持 `Last-Event-ID` 或 `?after=<seq>` 续读跳过已收序号） | 经 `StateFeed`（`tokio::sync::watch` + `WatchStream`）脏合并推送（`id: <seq>\ndata: <json>\n\n`），无阻塞线程开销；`farm` 携带窗口内有序 `effects` | HTTP 客户端、CLI |
| `GET /api/v1/live`（别名 `/api/v1/events`） | `LiveEvent` | 无 | 经 `GatewayPorts` 订阅 `LiveState` 广播流推送 `SessionEvent`、`Notice`、`Runtime` | 页面 |
| `GET /api/v1/issue/watch/:id` | `IssueWatch` | 任务状态与保留的轨迹 | 状态、轨迹和缺口（[观察执行](docs/subsystems/issue.md#观察执行)） | `issue watch` |
| `GET /api/v1/subscribe/<名字>?payload=<JSON>` | 各订阅的 `event`（`SUBSCRIPTIONS` 与 `packages/protocol/src/api.ts` 定义，均声明 `Subscription::CAN`） | 经 `Router` 校验 `CallerContext` 与 `CAN`，通过后补齐 `after` 之后的变化 | 之后的每次变化 | 页面与远程客户端：`channel.follow`、`channel.reports`、`note.follow`、`note.suggestion.follow`、`note.presence.follow`、`session.watch`、`issue.watch` |

订阅流的调用方无权（不满足 `Subscription::CAN`）返回 `403`（`BizCode::Forbidden`），入参解不开或第一条事件之前被拒绝回普通 JSON 错误信封，不是流；开始推送以后出错只结束流。

SSE 以外的路由：

- `GET /api/v1/attachment/<id>`：附件流式下载（经 `storage/` 与 `NativeEndpointId::AttachmentFile` 校验 `CallerContext` 权限，接受 `Authorization: Bearer` 或 `?token=`，以 `tokio::fs::File` 支持 HTTP `Range` 分块读取）；笔记沙箱视图按需经无 `allow-same-origin` 严格 CSP 提供预览。
- `PUT`、`GET /api/v1/media/input/<id>/content`：上传和读取媒体输入（`NativeEndpointId::MediaInputUploadFile`、`NativeEndpointId::MediaInputFile`）；`GET /api/v1/media/speech/<id>/stream`：合成语音的流（[媒体](docs/subsystems/media.md)）。
- `/mcp`：执行会话的工具（[频道](docs/subsystems/channel.md)）。

- **客户端拥有流与订阅的生命周期**：原生页面与像素场景经 `crates/server/src/gateway/bridge/` 按需订阅 `slice:<name>`、`LiveEvent` 与订阅事件，视图关闭或取消订阅时立即释放 `Subscription`；命令行的 `Client::slice` 与 `Client::sse`（`crates/cli/src/client.rs`）在 HTTP 上直读 JSON 快照或按空行分帧解码 SSE，坏帧、HTTP 拒绝或退出时立即释放连接。
- **心跳**：每条 SSE 连接（含切片流、工单观察流和订阅流）每 20 秒发 `: ping` 心跳；订阅方断开时释放源订阅。
- **写接口返回 `seq` 对齐切片**：任务写接口（`issue.create`、`issue.update`、`issue.status.update`、`issue.comment.create`）提交并推进 `StateFeed` 后返回当前 `seq`，页面以对应切片的 `slice.seq >= reply.seq` 作为意图结算条件。

### HTTP 接口与命令行

- **统一 `POST /api/v1/<路径>` 与全信封 JSON 响应**：操作名中的 `.` 换为 `/` 即路径（如 `issue.status.update` → `/api/v1/issue/status/update`），参数统一放入 JSON 请求体。所有 JSON 接口统一返回全信封：成功返回 HTTP `200` 与 `{ bizCode: 0, message: "ok", data? }`（无返回值接口省略 `data`）；网关拒绝与业务错误按 `bizCodeMeta` 映射标准 HTTP 状态码（`400`、`401`、`403`、`404`、`405`、`409`、`413`、`415`、`500`、`502`、`503`），响应体统一为 `{ bizCode, message, error?: { next?, settings? } }`。二进制下载、HTML 预览、SSE 与 NDJSON 流保持各自媒体类型。
- **六位分段业务码 `BizCode`**：`BizCode`（契约里定义，Rust 在 `crates/protocol/src/envelope.rs`：成功为 `0`；`100xxx` 网关与协议、`200xxx` 鉴权与局域网、`300xxx` 任务与仓库、`400xxx` 会话与助手、`500xxx` 频道与连接器、`600xxx` 作品与素材、`700xxx` 语音与媒体配置），经 `bizCodeMeta` 静态绑定 HTTP 状态码、语义分类 `kind` 与可重试性 `retryable`。
- **严格来源校验与编译期类型化 Axum 鉴权提取器**：`crates/server/src/gateway/http/` 的 `auth.rs` 通过 `FromRequestParts` 在路由签名层强制校验鉴权策略：`Authenticated` 校验 Bearer 令牌或本机 `from_the_farm` 同源请求（`Host` 回环、`Origin` 同源、`Sec-Fetch-Site` 为 `same-origin` 或 `none`），失败返回 `Envelope` JSON 错误（覆盖普通 RPC、`media::upload` 等）；`AuthenticatedQuery` 允许 `?token=` 承载令牌（覆盖 `/api/v1/attachment/{id}`、`note_cover`、`media::content` 与 `media::speech`，并在媒体路由拒绝 `SCOPE_REMOTE_MACHINE` 机器令牌越权访问）；`LocalOnly` 强约束 `!state.is_remote && from_the_farm(&headers)`（仅保留给 `/mcp`，同时拒绝 `vv_dev_` 远程令牌）；`machine_ws::upgrade` 强校验 Bearer 令牌且要求 `SCOPE_REMOTE_MACHINE`，绝不回落本机默认身份。流式上传（`media::upload`）经 `tokio_util::io::StreamReader` + `SyncIoBridge` 维护 `512_000_000` 字节上限与 300 秒截止；分段下载（`attachment` 与 `media::content`）经 `file_range_stream`（`tokio::io::AsyncReadExt::take` + `tokio_util::io::ReaderStream::with_capacity(..., 64 * 1024)`）流式输出 HTTP `Range`。
- **请求幂等键 `requestKey`**：`issue.create`、`issue.status.update`、`channel.thread.create`、`memory.create` 接受 `requestKey`（最长 64 字符，超长返回 `409` `BizCode.RequestKeyTooLong`）。同一个键五分钟内重试拿到第一次的回答（由 `context/` 的 `error.rs` `RequestKeys` 与 `ctx.service` 共同维护），失败不缓存。
- **开关写成幂等设值**：回应、置顶、归档定义为带 `on: boolean` 的 `*.set` 接口，重复设置相同值不产生副作用。
- **破坏性操作配对试跑 `dryRun`**：删除、合并、关单接口在 `endpoints` 中指向对应的 `preview<动词>` 接口。试跑与真做共用同一套前置判断函数，试跑不写库、不碰 git。
- **拒绝响应附带下一步 `next`**：业务拒绝与未找到错误在 `error.next` 中携带 `{ say, run? }[]`，给出可直接运行的 CLI 命令或指引。
- **CLI 是纯 HTTP 客户端**：`crates/cli` 不载入服务端、不直连数据库；目标地址按 `--server` / `VIBEVALLEY_SERVER` > `$VIBEVALLEY_HOME/auth.json` > 当前发布通道家目录 `server.json`（未记录时回落通道默认端口，见 `crates/protocol/src/home.rs`）依次解析，Bearer 令牌按 `--token` / `VIBEVALLEY_REMOTE_TOKEN` > 与目标地址匹配的 `auth.json`（`0600`）附带 `Authorization: Bearer`；提供 `vibevalley auth`（`login` / `whoami` / `status` / `logout`）与 `vibevalley remote`（`status` / `enable` / `disable` / `code` / `revoke`），失败时 stderr 打一行 JSON，退出码保持一致。
- **拥有者负责协调与身份分配**：`Router`（`router.rs`）只负责鉴权、追踪、观察与编译期穷尽分发，直接调用拥有者域的强类型 `async fn`（进程内零 JSON 往返编解码），由拥有者模块协调内部步骤并分配新实体 ID；查询缺失关联时列入 `missingSessions`，不伪造缺省对象。

### 受控远程访问

- **默认关闭与绑定约束**：`crates/server/src/gateway/remote/` 默认关闭远程监听；仅本机 `Caller::User` 调用 `remote.enable` 时，服务端按显式 `bindAddr` / `VIBEVALLEY_REMOTE_BIND` → 在线 Tailscale IPv4（`100.64.0.0/10`）→ 纯 Rust 探测到的本机非回环私网 LAN IPv4（`lan.rs`，用于同一 Wi-Fi 局域网直连，不依赖 `tailscale`）→ `127.0.0.1`（供 iOS Simulator 或无局域网环境本地联调）的优先级选取监听地址，在独立端口（通道默认端口 `+ 100`，如 dev `8890` / release `8887`）启动远程监听，默认拒绝绑定通配或公网地址（显式设置 `VIBEVALLEY_REMOTE_ALLOW_ALL=1` 可用于局域网或反向代理部署）；`remote.disable` 立即停机并持久化关闭状态。
- **一次性配对码、平台分类与作用域**：`remote.pair.create`（仅 `Caller::User`）在远程开启时生成 5 分钟有效、单次使用的高熵配对码与 `vibevalley://pair?url=<encoded>&code=<code>` 深链，支持可选 `scope`（`SCOPE_REMOTE_CLIENT = "remote:default"`、`SCOPE_REMOTE_MACHINE = "remote:runtime"`）；`remote.pair.exchange` 接受 6 类 `RemotePlatform`（`ios`、`android`、`cli`、`machine`、`sandbox`、`other`）并受失败速率限制保护，核验后立即作废配对码、持久化 `scope` 并签发 `vv_dev_*` 持久 Bearer 令牌，数据库（`remote_device`）只存 SHA-256 哈希，线缆类型 `RemoteDeviceSummary` 永不返回 `token_hash`。
- **构造注入的远程鉴权与最小权限边界**：`App` 启动时将远程鉴权能力不可变注入 `GatewayPorts`（零晚绑定槽位）；远程监听门除 `remote.pair.exchange` 外强制校验 `Authorization: Bearer <token>`（`GET /api/v1/attachment/{id}` 同时支持 `?token=` 供媒体标签读取），认证通过后构造 `Caller::Remote` 与 `CallerPrincipal::RemoteDevice { device_id, scope }` 并更新 `last_seen_at`，已撤销（`remote.device.revoke`）或未知令牌立即返回 `401`（`BizCode::Unauthorized`）。远程门开放已认证设备访问 `GET /api/v1/slice/{name}`（支持 `Last-Event-ID` 续读）、`/live`、经 `Subscription::CAN` 放行的 `/subscribe/{name}`、`GET /api/v1/attachment/{id}`（`attachment.file` 授权 `Caller::User` 与 `Caller::Remote`）及 `can` 包含 `remote` 的业务端点，严格拦截 `debug.*`、`/mcp` 及全部 `Caller::User` 专属管理端点（`remote.{status,enable,disable,pair.create,device.revoke}`、`setting.update`、`agent.{create,update,delete}`、`provider.*`、`connector.{login,verify,logout,channel.set}`、`repo.pr.submit`）。

## 怎么走

**一次状态写入与切片更新**

1. 请求经 `gateway/bridge/` 或 `gateway/http/` 进入 `Router`（`router.rs`），完成 `check_can`、`trace_id` span、`FaultGate` 与 `InvokeObserver` 记录后，按 `EndpointId` / `NativeEndpointId` 编译期穷尽分发到目标域处理器。
2. 目标域经 `ctx.service`（`Service`）在数据库事务内落库（需要异步外部投递时同事务写入 `Outbox`）并计算脏切片掩码 `SliceMask`。
3. 事务提交后调用 `ctx.mark_dirty(mask)` 唤醒 `StateFeed`；运行中会话流与农场特效直接写入 `LiveState`。
4. `StateFeed` 经 `SliceWakeGate` 对 `dirty` 命中的切片做单航班合并查询与纯投影，写入 `tokio::sync::watch`；未变脏的切片不查库、不序列化、不唤醒下游。
5. `gateway/http/` 经 `WatchStream` 直接推 SSE，`gateway/bridge/` 以轻量 Tokio 任务与每连接 `CancellationToken` 维持单帧 ACK（确认 `rev` 后再推下一份快照）。

**服务端启动与停机**

1. `main.rs` 调用 `log::init(...)` 初始化日志与追踪，随后调用 `create_app(config).await?`（`app.rs`）。
2. `create_app` 打开 `Database` 与顶层 `Service`，构造共享 `Context`（`service: Arc<Service>`、`TaskGroup`、`LiveState`、`Outbox`、`StateFeed`、`SharedClock`），按无环依赖顺序不可变构造基础服务（`Storage`、`Setting`、`Provider`、`Repo`）与全部扁平业务域（`runtime/`、`agent/`、`issue/`、`note/`、`channel/`、`connector/`、`cron/`、`voice/`、`machine/`、`debug/`、`game.rs`），组装 `Router` 与 `GatewayPorts`。
3. 后台任务统一挂入 `TaskGroup`，接回停机时在场的执行会话并补投未结算的 `Outbox` 条目；无需内存影子库启动水合。
4. `gateway::serve(...)` 绑定回环监听端口（按 `VIBEVALLEY_PORT`，`0` 为随机端口；未设时取当前发布通道默认端口：`release` `8787`、`beta` `8788`、`alpha` `8789`、`dev` `8790`），按配置启停 `gateway/remote/`，写出 `server.json`，`--ready-json` 打印 `{"url","pid"}`。
5. 停机时调用 `App::close()` 取消 `TaskGroup`、排空后台任务并关闭数据库连接池（SQLite 执行 `PRAGMA wal_checkpoint(TRUNCATE)` / `PRAGMA optimize`）。

## 和谁打交道

- **写库并标脏切片的域**：`issue/`、`runtime/`、`channel/`、`note/`、`cron/`、`agent/`、`game.rs`。
- **消费 `Outbox` 与 `LiveState` 的模块**：`runtime/`、`agent/`、`channel/`、`connector/`、`note/`、`game.rs`。
- **外部客户端**：`apps/mac`（经 `gateway/bridge/` 按切片订阅）、`apps/mobile`（通过 `@vibevalley/protocol/remote` 的 `HttpRemoteTransport` 经 `gateway/remote/` 带 Bearer 令牌与 `Last-Event-ID` 订阅）、命令行 `vibevalley`（经 `gateway/http/` 访问 `/api/v1/slice/{name}`）。

## 为什么这样

- **数据库单一真源 + 事务性 `Outbox` + 瞬态 `LiveState`**：取消内存影子库与启动水合，消除 SQL 与内存双写漂移；外部投递与业务写入同事务提交保证因果一致；运行中流与农场特效留在 `LiveState`，避免高频瞬态写库。
- **浅层组合根 `App` + 薄 `Router` 编译期穷尽分发**：以 `app.rs` 与 `router.rs` 取代动态路由表与晚绑定槽位，新增或删除端点在编译期暴露缺口，进程内调用零 JSON 往返编解码。
- **独立顶层 `service/` + 一表一文件 `db/entity/`**：`db/` 只管连接、迁移与 36 张表实体（`<table_name>.rs`），`service/` 统一承担业务视角持久化查询，`crates/server/src/{db,service}/` 之外零 `sea_orm::` 与 `db::entity` 导入，双后端兼容与查询优化集中治理。
- **页面读投影好的切片，文案在投影时填入**：避免前后端维护两套状态折叠；界面文案不落盘，改措辞或切语言无历史兼容负担。
- **命令走 `POST /api/v1/<op>`，切片和订阅走 SSE**：操作名即路径，省去 REST 参数拆分；`/api/v1/slice/{name}`、`/live`、`/events` 按职责分离，支持 `Last-Event-ID` 续读与按需 JSON 快照；能力表 `ENDPOINTS` 单源派生多端入口与 `capabilities.md`。

## 还没做的

- `can` 只留 `user` 与 `remote`，agent 工具按角色配置：`#52`。

## 怎么验证

- `crates/core/tests/projection.rs`：`SliceMask` 与 6 路切片纯投影对 golden。
- `crates/server/tests/contract.rs`：信封、按端点的类型解码入参、`can`。
- `crates/server/tests/start.rs`：整个服务端起来、经 HTTP 走一遍。
- `crates/cli/tests/cli.rs`：命令行对着真的 `vibevalley-server`。
