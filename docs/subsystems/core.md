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
| `internal/domain/gateway/projection.go`、`overlay.go`、`overlay_sql_store.go` | 核心状态 `SpaceState` 维护、投影折叠、出帧拼装（`StateFrame`）及 `gateway` SQLite 叠加态持久化（11 个 `sqlc` 作用域之一） |
| `packages/protocol/src/core/shapes.ts` | `SpaceState`、`Fact`、`StateFrame`、`ServerEvent`、`LiveEvent` |
| `packages/protocol/src/api.ts`、`endpoint.ts` | 汇总各概念的 `endpoints`、`Endpoint`、六位业务码 `BizCode`、`bizCodeMeta`、全信封 Schema 与 `ApiError` |
| `internal/domain/gateway/` | `gateway.go`（路由注册、鉴权、`/api/v1/*` 命令处理分发）；`handlers_{work,collab,media,platform}.go`；`streams.go`（SSE 与订阅流）；`cron_runner.go`（后台定时调度） |
| `internal/domain/stack/link_server.go`、`machine_hub.go` | `/chord/ws` 客户端 Chord 增量链接与 `/machine/ws` 远程 `vibe-machine` 反向链路 |
| `pkg/contract/`、`pkg/contract/tsgen/` | Go 侧协议视图定义，与 `packages/protocol` 通过 `scripts/gen/go-contract.ts` 保持双向契约一致 |
| `packages/protocol/src/rpc.ts` | 订阅的名字、入参和事件 Schema |
| `cmd/vibe/` | CLI 入口（`main.go`、`client.go`）与按领域拆分的子命令 |

全部接口与权限矩阵见生成的 [capabilities.md](docs/reference/capabilities.md)。

## 模型和不变量

### 核心状态与事实

- **单一内存投影，按事实演进**：`SpaceState` 的演进集中在网关投影（`internal/domain/gateway/projection.go`、`overlay.go`），未改变状态的事实不递增 `seq`、不触发无意义重推。
- **「事实」专指核心投影演进单元**：农机能力叫 `RuntimeSupport`，会话事件映射叫 `Reaction`，事实命名表达发生了什么（`<实体>Changed`、`<实体>Removed` 或生命周期动词过去式）。
- **先落库，后推状态**：各领域模块先提交 SQLite 事务或文件，再更新投影触发 `StateFrame` 发布；重启时由服务栈从库重新装配状态。
- **界面文案在出帧时填充**：`StateFrame` 在出帧阶段填入 `phaseText`、`actionText`、`whenText`、工单 `stage` 与可执行动作，持久层不含界面文案。

### SSE 流和其余路由

| 路径 | 编码 Schema | 初始消息 | 后续推送 | 消费者 |
|---|---|---|---|---|
| `GET /api/v1/state` | `StateFrame` | 首帧 `StateFrame` | 合并窗口后的 `StateFrame` | 页面、`vibe` 客户端 |
| `GET /api/v1/live` | `LiveEvent` | 无 | `SessionEvent`、`Notice`、`Runtime` | 页面 |
| `GET /api/v1/events` | `ServerEvent` | `snapshot`（`SpaceState`） | 每条 `Fact` 及 `LiveEvent` | 调试 |
| `GET /api/v1/issue/watch/:id` | `IssueWatch` | 工单状态与保留的轨迹 | 状态、轨迹和缺口（[观察执行](docs/subsystems/issue.md#观察执行)） | CLI / 观察客户端 |
| `GET /api/v1/subscribe/<名字>?payload=<JSON>` | 各订阅的 `event`（`packages/protocol/src/rpc.ts`） | 补齐 `after` 之后的变化 | 之后的每次变化 | 页面：`channel.follow`、`channel.reports`、`artifact.follow`、`artifact.suggestion.follow` |

订阅流的入参解不开、或第一条事件之前就被拒绝（没有这个频道……），回的是普通的 JSON 错误信封，不是流；开始推送以后出错只结束流。

SSE 以外的路由：

- `GET /api/v1/attachment/<id>`：附件；`GET /api/v1/artifact/<id>/<version>`：网页 Artifact。
- `PUT`、`GET /api/v1/media/input/<id>/content`：上传和读取媒体输入；`GET /api/v1/media/speech/<id>/stream`：合成语音的流（[媒体](docs/subsystems/media.md)）。
- WebSocket `/api/v1/voice/moss/line`、`/api/v1/voice/vision/line`：页面的实时语音线路，HTTP 服务端只接这两条升级（[语音](docs/subsystems/voice.md)）。
- `/mcp` 与内置工具调度（[频道](docs/subsystems/channel.md)）。
- `POST /v1/chat/completions`：OpenAI 兼容的助手入口（[助手](docs/subsystems/orchestrator.md)）。
- WebSocket `/chord/ws`（`Stack.HandleClientWebSocket`）与 `/machine/ws`（`MachineHub.HandleWebSocket`）：基于 `pkg/chord` 的双向多路复用 RPC 与实时增量订阅链路（[地基](docs/subsystems/foundation.md#chord-增量同步与多路复用链路pkgchord)）。
- `/egress`（`vault.EgressProxy`）：经短期能力令牌鉴权的受控出站代理入口（[设置和配置](docs/subsystems/setting.md#模型和不变量)）。
- **定时调度循环（`gateway/cron_runner.go`）**：网关随启动拉起时区感知的 cron 轮询（支持五段式 `cron` 与 DST 跳过处理），到期执行 `RunDueCrons` 派单并落盘更新运行游标（[定时任务](docs/subsystems/issue.md#定时任务)）。

- **客户端拥有连接的完整生命周期**：`packages/protocol/src/stream.ts` 在坏帧、回调抛错、HTTP 拒绝、取消和静默超时退出时中止请求并释放 reader；清理失败不覆盖原始错误。重连不留下旧连接。
- **有界中继与心跳**：每条 SSE 连接（含工单观察流和订阅流）经有界队列与定时心跳维持，积压超出上限时主动断开释放源订阅，客户端重连后重拉快照或最新帧。
- **客户端分帧**：`packages/protocol/src/stream.ts` 的 `readStream` 接受 LF 和 CRLF 空行分隔的事件；换行和空行可跨网络 chunk。完整帧经该流已有的 Schema 解码后按顺序回调一次；取消、静默超时或坏帧会终止读取。
- **写接口返回 `seq` 对齐画面帧**：工单写接口（`issue.create`、`issue.update`、`issue.status.update`、`issue.comment.create`）提交后返回当前 `seq`，页面以 `frame.seq >= reply.seq` 作为意图结算条件。

### HTTP 接口与命令行

- **统一 `POST /api/v1/<路径>` 与全信封 JSON 响应**：操作名中的 `.` 换为 `/` 即路径（如 `issue.status.update` → `/api/v1/issue/status/update`），参数统一放入 JSON 请求体。所有 JSON 接口统一返回全信封：成功返回 HTTP `200` 与 `{ bizCode: 0, message: "ok", data? }`（无返回值接口省略 `data`）；网关拒绝与业务错误按 `bizCodeMeta` 映射标准 HTTP 状态码，响应体统一为 `{ bizCode, message, error?: { next?, settings? } }`。二进制下载、HTML 预览、SSE 与 NDJSON 流保持各自媒体类型。
- **六位分段业务码 `BizCode`**：`endpoint.ts` 集中定义 `BizCode`（成功为 `0`；`100xxx` 网关与协议、`200xxx` 鉴权与局域网、`300xxx` 工单与仓库、`400xxx` 会话与助手、`500xxx` 频道与连接器、`600xxx` 产物与知识库、`700xxx` 语音与媒体配置），经 `bizCodeMeta` 静态绑定 HTTP 状态码、语义分类 `kind` 与可重试性 `retryable`。
- **严格来源校验**：命令接口、订阅流、媒体路由和语音线路校验来源（回环 `Host` 与同源头检查），越界返回 `403`（`BizCode.Forbidden`）。
- **请求幂等键 `requestKey`**：`issue.create`、`issue.status.update`、`channel.thread.create`、`memory.create` 接受 `requestKey`（最长 64 字符，超长返回 `409` `BizCode.RequestKeyTooLong`）。网关按操作缓存近期成功键的信封响应，失败不缓存。
- **开关写成幂等设值**：回应、置顶、归档定义为带 `on: boolean` 的 `*.set` 接口，重复设置相同值不产生副作用。
- **破坏性操作配对试跑 `dryRun`**：删除、合并、关单接口在 `endpoints` 中指向对应的 `preview<动词>` 接口。试跑与真做共用同一套前置判断函数，试跑不写库、不碰 git。
- **拒绝响应附带下一步 `next`**：业务拒绝与未找到错误在 `error.next` 中携带 `{ say, run? }[]`，给出可直接运行的 CLI 命令或指引；语音配置问题另附 `error.settings`。
- **CLI 是纯 HTTP 客户端**：`cmd/vibe` 不加载内部存储，通过 `--server`、`VIBEVALLEY_SERVER` 或 `$VIBEVALLEY_HOME/server.json` 连接服务端。
- **拥有者负责协调与身份分配**：处理器只传业务意图，由领域模块协调内部步骤并在锁内分配新实体 ID。

## 怎么走

**服务端重启恢复与推帧**

1. 拥有者模块提交 SQLite 事务后更新核心状态投影。
2. 服务端绑定回环监听后，由 `internal/domain/stack/stack.go` 按序恢复持久化领域状态与会话、加载投影并写出 `server.json` 与就绪收据。
3. `/api/v1/state`、`/api/v1/live` 与 `/api/v1/events` 向已连接客户端广播最新状态帧与事件。

## 和谁打交道

- **施加状态变更的模块**：`issue`、`stack`/`watch`、`channel`、`media`、`connector`、`voice`、`game`。
- **外部客户端**：`apps/web`、`cmd/vibe` 与经 `lan` 放行的配对设备。

## 为什么这样

- **单一内存状态 + 投影出帧，不发 JSON patch**：新增状态由静态类型约束各视图处理；文案在出帧时填入，避免前后端维护两份折叠逻辑。
- **命令走 `POST /api/v1/<op>`，状态和订阅走 SSE**：操作名即路径，`/state`、`/live`、`/events` 按职责分离，断线重连直接拿新帧。
- **能力表 `endpoints` 与 `pkg/contract` 双端校验**：权限 `can`、Schema、试跑与路径由 `vpx scripts/gen/go-contract.ts --check` 与 `internal/domain/gateway/contract_parity_test.go` 守住前后端一致。

## 还没做的

- `can` 只留 `user` 与 `remote`，agent 工具按档案配置：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。

## 怎么验证

- `env -u GOROOT CGO_ENABLED=0 go test -count=1 ./internal/domain/gateway/... ./pkg/contract/...`：路由、全信封、幂等、`Seq` 同步与 Go/TS 契约一致性测试。
- `packages/protocol/src/api.test.ts` 与 `vp run server:check`：接口命名规范、生成产物对齐与服务端类型检查。
- `env -u GOROOT CGO_ENABLED=0 go test -count=1 ./cmd/vibe/...`：CLI 全接口与错误引导格式测试。
