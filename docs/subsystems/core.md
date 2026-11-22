# 核心状态和接口

`SpaceState` 是农场实时状态的唯一内存投影，仅由服务端持有，仅在 `Hub::apply`（`Core::apply`）中经纯函数 `reduce(state, fact)` 演进。外部通过 `POST /api/v1/*` 发命令，通过 SSE 流看状态、事件和订阅。本篇是接口和流的唯一一份清单。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `SpaceState` 的折叠（`apply`、`reduce`）、前后状态对 `Transition` 与序号 `seq` | 事实何时发出、各表如何持久化（[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)、[频道](docs/subsystems/channel.md)、[定时任务](docs/subsystems/issue.md#定时任务)） |
| 派生帧 `StateFrame`（`frameOf`）与单次特效计算（`effectsOf`） | 地块画面规则与游戏账本计算（[游戏](docs/subsystems/game.md)、[农场的皮](docs/subsystems/farm.md)） |
| 全部路由：SSE 流（`/api/v1/state`、`/events`、`/live`、工单观察流、订阅流）和其余 `GET`、`PUT` 路由 | 订阅里频道和 Artifact 的事件内容（[频道](docs/subsystems/channel.md)、[Artifact](docs/subsystems/artifact.md)）、工单观察流的内容（[工单](docs/subsystems/issue.md#观察执行)）、帮工 `/mcp` 的工具 |
| 接口表 `ENDPOINTS`、权限 `can`、幂等键 `requestKey`、试跑 `dryRun` 与 CLI 映射 | 各接口业务实现、模型工具（[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/core/src/core.rs`、`inbox.rs`、`patrol.rs` | `Core`：`reduce`、`frame_of`、`Transition`；收件箱纯计算（`inbox`、`inbox_entries`、`fresh_of`）与巡查规则（`patrol_step`） |
| `crates/server/src/lib.rs`、`event_bus.rs` | `Hub` 与有界异步 `EventBus`：持有 `Core`、按操作名注册处理函数（`Hub::on`）和订阅（`Hub::on_subscription`），`Hub::apply` 施加事实后非阻塞扇出 `Transition` 给独立线程订阅者（`Hub::subscribe_transitions` / `Hub::close_bus`），按 `STATE_EVERY_MS` 出帧，`live` 事件 |
| `crates/server/src/start.rs` | `start`：按序打开设置、档案、仓库、工单板、频道、媒体、助手，并接线 `IssueChat`、`SessionChat` 与助手频道订阅，注册所有端点；`Started::close` 先停 `Hub::close_bus()` 再清理各领域服务 |
| `crates/server/src/main.rs` | 二进制 `vibevalley-server`：`--web`、`--ready-json`，读环境变量，写 `server.json` |
| `crates/protocol/src/contract/` | `SpaceState`、`Fact`、`StateFrame`、`LiveEvent` 与接口表 `ENDPOINTS`（`endpoints.rs`），手写的源头，TS 由它生成 |
| `crates/protocol/src/envelope.rs` | 全信封、`BizCode`、`ApiError` |
| `crates/server/src/transport/http/mod.rs` | axum 路由：命令接口、`/state`、`/live`、订阅流、工单观察流、附件、网页 Artifact、`/mcp`；来源校验 `from_the_farm`；`media.rs` 媒体输入与语音流 |
| `crates/cli/src/` | 命令行 `vibevalley`：`main.rs` 入口、`client.rs` HTTP/SSE 客户端与退出码、`output.rs` 输出格式化、`domains/` 按五大业务域组织的强类型子命令 |

全部接口与权限矩阵见生成的 [capabilities.md](docs/reference/capabilities.md)。

## 模型和不变量

### 核心状态与事实

- **单一内存投影，按事实演进**：`SpaceState` 只在 `Hub::apply(facts)` 中修改。未改变状态的事实不广播、不递增 `seq`、不触发特效。
- **「事实」专指 `Hub::apply` 的输入**：农机能力叫 `RuntimeSupport`，会话事件映射叫 `Reaction`，一条频道消息和它的听众叫 `ChannelHearers`，排序键叫 `RowKeys`。
- **事实命名表达发生了什么**：实体新增或更新叫 `<实体>Changed`，移除叫 `<实体>Removed`，生命周期结清用动词过去式（`sessionPhaseChanged`、`sessionReported`、`sessionLeft`）。
- **批次原子可见，异步扇出不重入**：`Hub::apply`（`crates/server/src/lib.rs`）在局部状态上逐条折叠并收集每条 `Transition`（`{ before, fact, after }`）与特效，一次性替换可见状态、递增一次 `seq` 并立即释放核心锁，再经有界异步 `EventBus`（每订阅者独立线程 `vibevalley-bus-{name}`、容量 1024）非阻塞扇出 `Transition`，禁止在 `Hub::apply` 锁内同步写盘或重入。`reduce` 不得修改传入的旧状态。
- **先落库，后发事实**：各模块先提交数据库事务或文件，再调 `Hub::apply`。重启时从空状态由各模块从 `server.db` 及家目录文件恢复。
- **按依赖重算工单派生状态**：`reduce` 仅在工单或会话集合引用变化时重算工单状态与动作（`withIssueStatuses`）；聊天或花费事实不触发工单重算。一轮进行中的 `sessionPhaseChanged` 只改了 `doing` 或 `spent`（`since`、`quietSince` 不变，`phaseAffectsIssue`）时也跳过重算。
- **界面文案只在出帧时填充**：`frame_of` 在状态副本上填入 `phaseText`、`actionText`、`whenText`、工单 `stage` 与可执行动作；`reduce` 与持久层不含界面文案。

### 收件箱

八种待处理事项（`InboxKind`，定义在 `crates/core/src/inbox.rs`）：

| 种类 | 触发条件 | 默认巡查宽限期 |
|---|---|---|
| `review` | 工单处于 `reviewing`（帮工做完一轮或全部子单完成，等用户验收） | 2 小时 |
| `ask` | 工单处于 `asking`（帮工带着问题等用户回答） | 15 分钟 |
| `fix` | 工单处于 `stuck: failed`（上一轮失败） | — |
| `interrupted` | 工单处于 `stuck: interrupted`（上一轮停在半路） | 30 分钟 |
| `conflict` | 工单处于 `stuck: conflict`（合入主分支存在冲突） | 2 小时 |
| `quiet` | 工单处于 `stuck: quiet`（执行中长时间无事件） | 20 分钟 |
| `mention` | 频道或串中有未读且未回复的 `@用户` 消息（`Chat.userMentions`） | 15 分钟 |
| `cron-ask` | 助手创建的定时任务处于 `pending` 等待用户同意 | — |

- **纯函数现算，不落库**：`InboxEntry[]` 直接从 `SpaceState` 算出，放进每帧的 `StateFrame.inbox`；每条有稳定的 id，带 `who` 和预填好的文案 `words`（`label`、`title`、`body`、`tray`）。原生子工单成功完成后自动合入父分支，不单独产生 `review`。
- **开机时已有的不响铃（`fresh_of`）**：服务端开机与页面首次打开都先记下存量 id，之后新出现的 id 才响铃和通知，同一个只响一次。
- **巡查（`patrol_step`；规则和测例在 `crates/core/src/patrol.rs`）**：超过宽限期的按频道生成 `source = "patrol"` 摘要；同一件事 4 小时内最多报一次；用户读过报告所在的位置（`Chat::user_read_reports`），宽限期从读的时候起至少再延 2 小时。

### SSE 流和其余路由

| 路径 | 编码 Schema | 初始消息 | 后续推送 | 消费者 |
|---|---|---|---|---|
| `GET /api/v1/state` | `StateFrame` | 首帧 `StateFrame` | 每 200 毫秒合并一次，保留窗口内的有序特效 | HTTP 客户端 |
| `GET /api/v1/live`（别名 `/api/v1/events`） | `LiveEvent` | 无 | `SessionEvent`、`Notice`、`Runtime` | 页面 |
| `GET /api/v1/issue/watch/:id` | `IssueWatch` | 工单状态与保留的轨迹 | 状态、轨迹和缺口（[观察执行](docs/subsystems/issue.md#观察执行)） | `issue watch` |
| `GET /api/v1/subscribe/<名字>?payload=<JSON>` | 各订阅的 `event`（`packages/protocol/src/rpc.ts` 定义） | 补齐 `after` 之后的变化 | 之后的每次变化 | 页面：`channel.follow`、`channel.reports`、`artifact.follow`、`artifact.suggestion.follow` |

订阅流的入参解不开、或第一条事件之前就被拒绝（没有这个频道……），回的是普通的 JSON 错误信封，不是流；开始推送以后出错只结束流。

SSE 以外的路由：

- `GET /api/v1/attachment/<id>`：附件；`GET /api/v1/artifact/<id>/<version>` 与 `GET /api/v1/artifact/<id>/view`：网页与结构化 Artifact 沙箱视图。
- `PUT`、`GET /api/v1/media/input/<id>/content`：上传和读取媒体输入；`GET /api/v1/media/speech/<id>/stream`：合成语音的流（[媒体](docs/subsystems/media.md)）。
- `/mcp`：帮工的工具（[频道](docs/subsystems/channel.md)）。
- `/chord/ws`：执行治理文档 `space` 的 WebSocket 订阅（快照、按修订号续读与 `budget.raise` 命令，见 [Chord](crates/server/src/transport/chord/README.md)）。

- **客户端拥有流与订阅的生命周期**：原生页面经 `crates/server/src/transport/bridge` 直接收发 `StateFrame`、`LiveEvent` 与订阅事件，视图关闭或取消订阅时立即释放 `Subscription`；命令行的 `Client::sse`（`crates/cli/src/client.rs`）在 HTTP SSE 上按空行分帧解码，坏帧、HTTP 拒绝或退出时立即释放连接。
- **心跳**：每条 SSE 连接（含工单观察流和订阅流）每 20 秒发 `: ping` 心跳；订阅方断开时释放源订阅。
- **写接口返回 `seq` 对齐画面帧**：工单写接口（`issue.create`、`issue.update`、`issue.status.update`、`issue.comment.create`）在 `Hub::apply` 后返回当前 `seq`，页面以 `frame.seq >= reply.seq` 作为意图结算条件。

### HTTP 接口与命令行

- **统一 `POST /api/v1/<路径>` 与全信封 JSON 响应**：操作名中的 `.` 换为 `/` 即路径（如 `issue.status.update` → `/api/v1/issue/status/update`），参数统一放入 JSON 请求体。所有 JSON 接口统一返回全信封：成功返回 HTTP `200` 与 `{ bizCode: 0, message: "ok", data? }`（无返回值接口省略 `data`）；网关拒绝与业务错误按 `bizCodeMeta` 映射标准 HTTP 状态码（`400`、`401`、`403`、`404`、`405`、`409`、`413`、`415`、`500`、`502`、`503`），响应体统一为 `{ bizCode, message, error?: { next?, settings? } }`。二进制下载、HTML 预览、SSE 与 NDJSON 流保持各自媒体类型。
- **六位分段业务码 `BizCode`**：`BizCode`（契约里定义，Rust 在 `envelope.rs`）（成功为 `0`；`100xxx` 网关与协议、`200xxx` 鉴权与局域网、`300xxx` 工单与仓库、`400xxx` 会话与助手、`500xxx` 频道与连接器、`600xxx` 产物与知识库、`700xxx` 语音与媒体配置），经 `bizCodeMeta` 静态绑定 HTTP 状态码、语义分类 `kind` 与可重试性 `retryable`。
- **严格来源校验**：命令接口、订阅流和媒体路由都经 `from_the_farm`（`crates/server/src/transport/http/mod.rs`）：`Host` 为回环地址；若有浏览器 `Origin` 则须与 `Host` 同源，`Sec-Fetch-Site` 仅接受 `same-origin` 或 `none`，否则返回 `403`（`BizCode.Forbidden`）。
- **请求幂等键 `requestKey`**：`issue.create`、`issue.status.update`、`channel.thread.create`、`memory.create` 接受 `requestKey`（最长 64 字符，超长返回 `409` `BizCode.RequestKeyTooLong`）。同一个键五分钟内重试拿到第一次的回答（`crates/server/src/base.rs`），失败不缓存。
- **开关写成幂等设值**：回应、置顶、归档定义为带 `on: boolean` 的 `*.set` 接口，重复设置相同值不产生副作用。
- **破坏性操作配对试跑 `dryRun`**：删除、合并、关单接口在 `endpoints` 中指向对应的 `preview<动词>` 接口。试跑与真做共用同一套前置判断函数，试跑不写库、不碰 git。
- **拒绝响应附带下一步 `next`**：业务拒绝与未找到错误在 `error.next` 中携带 `{ say, run? }[]`，给出可直接运行的 CLI 命令或指引。
- **CLI 是纯 HTTP 客户端**：`crates/cli` 不载入服务端、不直连数据库，通过 `--server`、`VIBEVALLEY_SERVER` 或当前发布通道家目录的 `server.json`（未记录时回落到当前通道默认端口，见 `crates/protocol/src/home.rs`）连接服务端；失败时 stderr 打一行 JSON，退出码同 TS 版。
- **拥有者负责协调与身份分配**：处理器只传业务意图，由拥有者模块协调内部步骤并在锁内分配新实体 ID；查询缺失关联时列入 `missingSessions`，不伪造缺省对象。

## 怎么走

**施加一条事实**

1. 拥有者模块提交数据库事务或文件后，调用 `Hub::apply(facts)`。
2. `Core` 运行 `reduce`；若状态未变则直接结束。
3. 原子替换可见状态、递增 `seq` 并释放锁，经有界异步 `EventBus` 把 `Transition` 扇出给订阅它的模块（`Hub::subscribe_transitions`）。
4. HTTP 和像素场景在 200 毫秒窗口结束时接收当前状态和窗口内的有序特效。
5. 原生工作台订阅最新状态。空闲后的首次变化立即唤醒窗口。连续变化在同一帧线程合并。工作台快照的 `effects` 为空。每个窗口有一个容量为 1 的唤醒通道。窗口确认已应用当前帧后，才接收下一份快照。

**服务端启动**

1. `start`（`crates/server/src/start.rs`）从空状态起 `Hub`，按序打开设置、游戏、AI 服务、档案和农机、仓库、记性、轨迹、工单板（共用 `server.db`）、PR 与分支发布、定时任务、附件、媒体输入、频道、素材库、媒体任务、Artifact、笔记、助手、`IssueChat`、`SessionChat` 与连接器；各自从 `server.db` 与家目录文件读回并施加初始事实。
2. 工单板接回停机时在场的会话；`IssueChat`、`SessionChat` 与 `Orchestrator` 各自补投 SQLite 中未结算的 `channel_delivery` 与 `issue.report`。
3. `main.rs` 绑定端口（按 `VIBEVALLEY_PORT`，`0` 为随机端口；未设时取当前发布通道默认端口：`release` `8787`、`beta` `8788`、`alpha` `8789`、`dev` `8790`），写出 `server.json`，`--ready-json` 打印 `{"url","pid"}`。

## 和谁打交道

- **施加事实的模块**：工单板（`modules/work/issue` 与 `modules/work/session`，经 `modules/work/ledger.rs`）、`channel`、`media`、`cron`、`game`、`agent`。
- **订阅事实的模块（`EventBus`）**：`game`、`memory`、`runtime`、`library`、`issue`（`issue-watch`）、`session`（`session-chat`）。
- **外部客户端**：`apps/mac`（进程内经桥）、命令行 `vibevalley`（HTTP）。

## 为什么这样

- **单一内存状态 + 纯函数 `reduce`，不发 JSON patch**：新增状态由编译器强制各视图处理；发领域事实而非字段 patch，让账本和通知直接按事件语义反应。
- **「事实」只留一个意思，成员名带语义**：非核心状态概念改回本名，事实用 `<实体>Changed`/`<实体>Removed`/动词过去式，消除名词歧义。
- **页面读折好的帧，文案在出帧时填入**：避免前后端维护两套 `reduce`；界面文案不落盘、不进 `Transition`，改措辞或切语言无历史兼容负担。
- **命令走 `POST /api/v1/<op>`，状态和订阅走 SSE**：操作名即路径，省去 REST 参数拆分；`/state`、`/live`、`/events` 按职责分离，断线重连直接拿新帧；订阅也是 SSE。
- **能力表 `endpoints` 单源派生多端入口**：权限 `can`、Schema、试跑与路径写在同一行，自动生成或校验 Rust 的 `ENDPOINTS`、`VibeValleyApi` 与 `capabilities.md`。

## 还没做的

- `can` 只留 `user` 与 `remote`，agent 工具按档案配置：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `crates/core/tests/projection.rs`：`reduce` 与 `frame_of` 对 golden。
- `crates/server/tests/contract.rs`：信封、按端点的类型解码入参、`can`。
- `crates/server/tests/start.rs`：整个服务端起来、经 HTTP 走一遍。
- `crates/cli/tests/cli.rs`：命令行对着真的 `vibevalley-server`。
