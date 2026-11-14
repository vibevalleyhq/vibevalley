# 核心状态和接口

`SpaceState` 是农场实时状态的唯一内存投影，仅由服务端持有，仅在 `Core.apply` 中经纯函数 `reduce(state, fact)` 演进。外部通过 `POST /api/v1/*` 发命令，通过 SSE 流看状态、事件和订阅。本篇是接口和流的唯一一份清单。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `SpaceState` 的折叠（`apply`、`reduce`）、前后状态对 `Transition` 与序号 `seq` | 事实何时发出、各表如何持久化（[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)、[频道](docs/subsystems/channel.md)、[定时任务](docs/subsystems/issue.md#定时任务)） |
| 派生帧 `StateFrame`（`frameOf`）与单次特效计算（`effectsOf`） | 地块画面规则与游戏账本计算（[游戏](docs/subsystems/game.md)、[农场的皮](docs/subsystems/farm.md)） |
| 全部路由：SSE 流（`/api/v1/state`、`/events`、`/live`、工单观察流、订阅流）和其余 `GET`、`PUT` 路由 | 订阅里频道和 Artifact 的事件内容（[频道](docs/subsystems/channel.md)、[Artifact](docs/subsystems/artifact.md)）、工单观察流的内容（[工单](docs/subsystems/issue.md#观察执行)）、帮工 `/mcp` 的工具、语音线路的协议（[语音](docs/subsystems/voice.md)） |
| 接口表 `endpoints`、权限 `can`、幂等键 `requestKey`、试跑 `dryRun` 与 CLI 映射 | 各接口业务实现、「连接到本机」配对鉴权（[连接到本机](docs/subsystems/lan.md)）、模型工具（[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/core/core.ts` | `Core` 服务：持有状态、盖时间戳、发布事实与三条流 |
| `apps/server/src/gateway/projection/` | `reduce.ts`、`frame.ts`（`makeProjection`）：组装各模块规则注入 `Core` |
| `packages/protocol/src/core/shapes.ts` | `SpaceState`、`Fact`、`StateFrame`、`ServerEvent`、`LiveEvent` |
| `packages/protocol/src/api.ts`、`endpoint.ts` | 汇总各概念的 `endpoints`、`Handlers`、`Endpoint`、六位业务码 `BizCode`、`bizCodeMeta`、全信封 Schema 与 `ApiError` |
| `apps/server/src/gateway/http/` | `app.ts` 挂全部路由；`api.ts` 命令接口、`requestKey` 去重、附件和网页 Artifact；`streams.ts` 三条全局 SSE 和工单观察流；`rpc.ts` 订阅流和来源校验 `fromTheFarm`；`media.ts` 媒体；`mcp.ts` 的 `/mcp` 和 `/v1/chat/completions`；`line.ts` 语音线路的 WebSocket；`handlers/<概念>.ts` |
| `packages/protocol/src/rpc.ts` | 订阅的名字、入参和事件 Schema |
| `apps/cli/src/main.ts`、`infra/farm.ts`、`commands/` | CLI 入口、找服务端与全局参数、按领域 1:1 拆分的子命令 |

全部接口与权限矩阵见生成的 [capabilities.md](docs/reference/capabilities.md)。

## 模型和不变量

### 核心状态与事实

- **单一内存投影，按事实演进**：`SpaceState` 只在 `Core.apply(...facts)` 中修改。未改变状态的事实不广播、不递增 `seq`、不触发特效。
- **「事实」专指 `Core.apply` 的输入**：农机能力叫 `RuntimeSupport`，会话事件映射叫 `Reaction`，一条频道消息和它的听众叫 `ChannelHearers`，排序键叫 `RowKeys`。
- **事实命名表达发生了什么**：实体新增或更新叫 `<实体>Changed`，移除叫 `<实体>Removed`，生命周期结清用动词过去式（`sessionPhaseChanged`、`sessionReported`、`sessionLeft`）。
- **批次原子可见，单条保留因果**：`apply(...facts)`（`core/core.ts`）是同步函数：在局部状态上逐条折叠并收集每条 `Transition`（`{ before, fact, after }`）与特效，再一次性替换可见状态、递增一次 `seq`，然后按序发布事实、`Transition` 和特效，返回前全部做完。中间没有 `await`，所以没有锁，oar 的同步回调可以就地调 `apply`。`reduce` 不得修改传入的旧状态。
- **先落库，后发事实**：各模块先提交数据库事务或文件，再调 `Core.apply`。Core 不存 `state.json` 文件，重启时从空状态由各模块从数据库恢复。
- **按依赖重算工单派生状态**：`reduce` 仅在工单或会话集合引用变化时重算工单状态与动作（`withIssueStatuses`）；聊天或花费事实不触发工单重算。一轮进行中的 `sessionPhaseChanged` 只改了 `doing` 或 `spent`（`since`、`quietSince` 不变，`phaseAffectsIssue`）时也跳过重算。
- **出帧按引用复用子视图**：`gateway/projection/frame.ts` 给每个 `Core` 一份单槽缓存，`inbox`、农场 `viewOf` 和定时任务的文案在依赖的集合引用与界面语言都没变时直接复用上一帧的结果。
- **界面文案只在出帧时填充**：`frameOf(state, effects)` 在状态副本上填入 `phaseText`、`actionText`、`whenText`、工单 `stage` 与可执行动作；`reduce` 与持久层不含界面文案。

### SSE 流和其余路由

| 路径 | 编码 Schema | 初始消息 | 后续推送 | 消费者 |
|---|---|---|---|---|
| `GET /api/v1/state` | `StateFrame` | 首帧 `StateFrame` | 200ms 窗口合并后的 `StateFrame` | 页面、`issue show --watch` |
| `GET /api/v1/live` | `LiveEvent` | 无 | `SessionEvent`、`Notice`、`Runtime` | 页面 |
| `GET /api/v1/events` | `ServerEvent` | `snapshot`（`SpaceState`） | 每条 `Fact` 及 `LiveEvent` | 调试 |
| `GET /api/v1/issue/watch/:id` | `IssueWatch` | 工单状态与保留的轨迹 | 状态、轨迹和缺口（[观察执行](docs/subsystems/issue.md#观察执行)） | `issue watch` |
| `GET /api/v1/subscribe/<名字>?payload=<JSON>` | 各订阅的 `event`（`packages/protocol/src/rpc.ts`） | 补齐 `after` 之后的变化 | 之后的每次变化 | 页面：`channel.follow`、`channel.reports`、`artifact.follow`、`artifact.suggestion.follow` |

订阅流的入参解不开、或第一条事件之前就被拒绝（没有这个频道……），回的是普通的 JSON 错误信封，不是流；开始推送以后出错只结束流。

SSE 以外的路由：

- `GET /api/v1/attachment/<id>`：附件；`GET /api/v1/artifact/<id>/<version>`：网页 Artifact。
- `PUT`、`GET /api/v1/media/input/<id>/content`：上传和读取媒体输入；`GET /api/v1/media/speech/<id>/stream`：合成语音的流（[媒体](docs/subsystems/media.md)）。
- WebSocket `/api/v1/voice/moss/line`、`/api/v1/voice/vision/line`：页面的实时语音线路，HTTP 服务端只接这两条升级（[语音](docs/subsystems/voice.md)）。
- `/mcp`：帮工的工具（[频道](docs/subsystems/channel.md)）。
- `POST /v1/chat/completions`：OpenAI 兼容的助手入口（[助手](docs/subsystems/orchestrator.md)）。声网打来的电话不走它，走语音线路自己的回环监听上的 `POST /llm/<通话>/chat/completions`（`gateway/voice/line.ts`）。

- **客户端拥有连接的完整生命周期**：`packages/protocol/src/stream.ts` 在坏帧、回调抛错、HTTP 拒绝、取消和静默超时退出时中止请求并释放 reader；清理失败不覆盖原始错误。重连不留下旧连接。
- **有界中继与心跳**：每条 SSE 连接（含工单观察流和订阅流）经 `bounded`（`core/core.ts`）配容量 64 的队列，每 20 秒发 `: ping` 心跳。积压满 64 条时主动断开连接并释放源订阅，客户端重连后重新拿快照或最新帧。
- **客户端分帧**：`packages/protocol/src/stream.ts` 的 `readStream` 接受 LF 和 CRLF 空行分隔的事件；换行和空行可跨网络 chunk。完整帧经该流已有的 Schema 解码后按顺序回调一次；取消、静默超时或坏帧会终止读取。
- **写接口返回 `seq` 对齐画面帧**：工单写接口（`issue.create`、`issue.update`、`issue.status.update`、`issue.comment.create`）在 `Core.apply` 后返回当前 `seq`，页面以 `frame.seq >= reply.seq` 作为意图结算条件。

### HTTP 接口与命令行

- **统一 `POST /api/v1/<路径>` 与全信封 JSON 响应**：操作名中的 `.` 换为 `/` 即路径（如 `issue.status.update` → `/api/v1/issue/status/update`），参数统一放入 JSON 请求体。所有 JSON 接口统一返回全信封：成功返回 HTTP `200` 与 `{ bizCode: 0, message: "ok", data? }`（无返回值接口省略 `data`）；网关拒绝与业务错误按 `bizCodeMeta` 映射标准 HTTP 状态码（`400`、`401`、`403`、`404`、`405`、`409`、`413`、`415`、`500`、`502`、`503`），响应体统一为 `{ bizCode, message, error?: { next?, settings? } }`。二进制下载、HTML 预览、SSE 与 NDJSON 流保持各自媒体类型。
- **六位分段业务码 `BizCode`**：`endpoint.ts` 集中定义 `BizCode`（成功为 `0`；`100xxx` 网关与协议、`200xxx` 鉴权与局域网、`300xxx` 工单与仓库、`400xxx` 会话与助手、`500xxx` 频道与连接器、`600xxx` 产物与知识库、`700xxx` 语音与媒体配置），经 `bizCodeMeta` 静态绑定 HTTP 状态码、语义分类 `kind` 与可重试性 `retryable`。
- **严格来源校验**：命令接口、订阅流、媒体路由和语音线路的升级都经 `fromTheFarm`（`gateway/http/rpc.ts`）：`Host` 为回环地址；若有浏览器 `Origin` 则须与 `Host` 同源，`Sec-Fetch-Site` 仅接受 `same-origin` 或 `none`，否则返回 `403`（`BizCode.Forbidden`）。
- **请求幂等键 `requestKey`**：`issue.create`、`issue.status.update`、`channel.thread.create`、`memory.create` 接受 `requestKey`（最长 64 字符，超长返回 `409` `BizCode.RequestKeyTooLong`）。网关按操作缓存最近 500 个成功键的信封响应，失败不缓存。
- **开关写成幂等设值**：回应、置顶、归档定义为带 `on: boolean` 的 `*.set` 接口，重复设置相同值不产生副作用。
- **破坏性操作配对试跑 `dryRun`**：删除、合并、关单接口在 `endpoints` 中指向对应的 `preview<动词>` 接口。试跑与真做共用同一套前置判断函数，试跑不写库、不碰 git。
- **拒绝响应附带下一步 `next`**：业务拒绝与未找到错误在 `error.next` 中携带 `{ say, run? }[]`，给出可直接运行的 CLI 命令或指引；语音配置问题另附 `error.settings`。
- **CLI 是纯 HTTP 客户端**：`apps/cli` 不加载服务端、不直连数据库，通过 `--server`、`VIBEVALLEY_SERVER` 或 `$VIBEVALLEY_HOME/server.json` 连接服务端；失败时 stderr 的一行 JSON 和退出码见 [apps/cli/README.md](apps/cli/README.md)。
- **拥有者负责协调与身份分配**：处理器只传业务意图，由拥有者模块协调内部步骤并在锁内分配新实体 ID；查询缺失关联时列入 `missingSessions`，不伪造缺省对象。

## 怎么走

**施加一条事实**

1. 拥有者模块提交数据库事务或文件后，调用 `Core.apply(...facts)`。
2. `Core` 盖上当前时间戳并运行 `reduce`；若状态未变则直接结束。
3. 原子替换可见状态、递增 `seq`，按序向 `/events`、`facts`、`transitions` 广播事实与特效。
4. `/state` 连接在 200ms 窗口后调用 `frameOf` 生成 `StateFrame` 推给客户端。

**服务端重启恢复**

1. `gateway/http/app.ts` 先绑定 HTTP 端口；配置为 `port: 0` 时在这里得到真实端口，再用它组装服务，恢复的会话和 `lan` 转发不会拿到 `:0`。
2. `Core` 从空状态启动；各模块在构造阶段从数据库加载工单、频道、定时任务和在场会话并施加初始事实。
3. `services.ts` 按模块顺序调各模块的 `boot()`，每个一次：Repo 第一次看 GitHub、Session 接回或放走停机时在场的会话（`vibevalley` 农机上答到一半的帮工接着答）再恢复投递并叫醒、Media、Issue 和 Cron 补跑、Watch 恢复会话串并按游标读完漏读的频道事件再开始巡查、Game 开始统计 commit。助手在构造时续接被重启打断的回合。
4. 写出 `server.json` 与就绪收据。

## 和谁打交道

- **施加事实的模块**：`issue`、`session`、`channel`、`media`、`connector`、`cron`、`voice`、`game`。
- **订阅事实的模块**：`game`、`watch`（收件箱）、`issue`、`channel`、`media`。
- **外部客户端**：`apps/web`、`apps/cli` 与经 `lan` 放行的配对设备。

## 为什么这样

- **单一内存状态 + 纯函数 `reduce`，不发 JSON patch**：新增状态由编译器强制各视图处理；发领域事实而非字段 patch，让账本和通知直接按事件语义反应。
- **「事实」只留一个意思，成员名带语义**：非核心状态概念改回本名，事实用 `<实体>Changed`/`<实体>Removed`/动词过去式，消除名词歧义。
- **页面读折好的帧，文案在出帧时填入**：避免前后端维护两套 `reduce`；界面文案不落盘、不进 `Transition`，改措辞或切语言无历史兼容负担。
- **命令走 `POST /api/v1/<op>`，状态和订阅走 SSE**：操作名即路径，省去 REST 参数拆分；`/state`、`/live`、`/events` 按职责分离，断线重连直接拿新帧；订阅也是 SSE，「连接到本机」那道门不用转发 WebSocket。
- **能力表 `endpoints` 单源派生多端入口**：权限 `can`、Schema、试跑与路径写在同一行，自动生成或校验 `Handlers`、`VibeValleyApi`、`capabilities.md` 与 `lan` 放行表。

## 还没做的

- `can` 只留 `user` 与 `remote`，agent 工具按档案配置：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `apps/server/src/core/core.test.ts`：事实去重、`seq` 递增、批次原子提交与低调度预算下的同步回调测试。
- `packages/protocol/src/api.test.ts`、`apps/server/src/gateway/http/api.test.ts`、`apps/server/src/flows/request.test.ts`：接口命名规范、`requestKey` 幂等与帧 `seq` 同步测试。
- `apps/cli/src/main.test.ts`：CLI 全接口覆盖、试跑与错误 `next` 测试。
