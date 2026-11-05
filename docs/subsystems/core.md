# 核心状态和接口

`WorkspaceState` 是农场实时状态的唯一内存投影，仅由服务端持有，仅在 `Core.apply` 中经纯函数 `reduce(state, fact)` 演进。外部通过 `POST /api/v1/*` 发命令，通过三条 SSE 流看状态与事件。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `WorkspaceState` 的折叠（`apply`、`reduce`）、前后状态对 `Transition` 与序号 `seq` | 事实何时发出、各表如何持久化（[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)、[频道](docs/subsystems/channel.md)、[定时任务](docs/subsystems/cron.md)） |
| 派生帧 `StateFrame`（`frameOf`）与单次特效计算（`effectsOf`） | 地块画面规则与游戏账本计算（[游戏](docs/subsystems/game.md)、[农场的皮](docs/subsystems/farm.md)） |
| 三条 SSE 流：`/api/v1/state`、`/api/v1/events`、`/api/v1/live` | 频道 WebSocket 订阅（[频道](docs/subsystems/channel.md)）、帮工 `/mcp`、语音线路（[语音](docs/subsystems/voice.md)） |
| 接口表 `endpoints`、权限 `can`、幂等键 `requestKey`、试跑 `dryRun` 与 CLI 映射 | 各接口业务实现、「连接到本机」配对鉴权（[连接到本机](docs/subsystems/lan.md)）、模型工具（[管家](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/core/core.ts` | `Core` 服务：持有状态、盖时间戳、发布事实与三条流 |
| `apps/server/src/projection/` | `reduce.ts`、`frame.ts`、`projection.ts`：组装各模块规则注入 `Core` |
| `packages/protocol/src/core/shapes.ts` | `WorkspaceState`、`Fact`、`StateFrame`、`ServerEvent`、`LiveEvent` |
| `packages/protocol/src/api.ts`、`endpoint.ts` | 汇总各概念的 `endpoints`、`Handlers`、`Endpoint` 与 `errorStatus` |
| `apps/server/src/http/` | `api.ts` 路由与 `requestKey` 去重、`streams.ts` 三条 SSE、`handlers/<概念>.ts` |
| `apps/cli/src/main.ts`、`farm.ts` | CLI 命令定义、全局参数与类型化请求封装 |

全部接口与权限矩阵见生成的 [capabilities.md](docs/reference/capabilities.md)。

## 模型和不变量

### 核心状态与事实

- **单一内存投影，按事实演进**：`WorkspaceState` 只在 `Core.apply(...facts)` 中修改。未改变状态的事实不广播、不递增 `seq`、不触发特效。
- **「事实」专指 `Core.apply` 的输入**：农机能力叫 `RuntimeSupport`，会话事件映射叫 `Reaction`，频道路由输入叫 `ChannelRouteInput`，排序键叫 `RowKeys`。
- **事实命名表达发生了什么**：实体新增或更新叫 `<实体>Changed`，移除叫 `<实体>Removed`，生命周期结清用动词过去式（`sessionPhaseChanged`、`sessionReported`、`sessionLeft`）。
- **批次原子可见，单条保留因果**：`apply(...facts)` 先在局部状态上逐条折叠并收集每条 `Transition`（`{ before, fact, after }`）与特效，再一次性替换可见状态并递增一次 `seq`。`reduce` 不得修改传入的旧状态。
- **先落库，后发事实**：各模块先提交 SQLite 事务或文件，再调 `Core.apply`。Core 不存 `state.json` 文件，重启时从空状态由各模块从数据库恢复。
- **按依赖重算工单派生状态**：`reduce` 仅在工单或会话集合引用变化时重算工单状态与动作（`withIssueStatuses`）；聊天或花费事实不触发工单重算。
- **界面文案只在出帧时填充**：`frameOf(state, effects)` 在状态副本上填入 `phaseText`、`actionText`、`whenText`、工单 `stage` 与可执行动作；`reduce` 与持久层不含界面文案。

### 三条 SSE 流

| 路径 | 编码 Schema | 初始消息 | 后续推送 | 消费者 |
|---|---|---|---|---|
| `GET /api/v1/state` | `StateFrame` | 首帧 `StateFrame` | 200ms 窗口合并后的 `StateFrame` | 页面、`issue show --watch` |
| `GET /api/v1/live` | `LiveEvent` | 无 | `SessionEvent`、`Notice`、`Runtime` | 页面 |
| `GET /api/v1/events` | `ServerEvent` | `snapshot`（`WorkspaceState`） | 每条 `Fact` 及 `LiveEvent` | 调试 |

- **有界中继与心跳**：每条连接配容量 64 的有界 relay，每 20 秒发 `: ping` 心跳。积压满 64 条时主动断开连接并释放源订阅，客户端重连后重新拿快照或最新帧。
- **写接口返回 `seq` 对齐画面帧**：工单写接口（`issue.create`、`issue.update`、`issue.status.update`、`issue.comment.create`）在 `Core.apply` 后返回当前 `seq`，页面以 `frame.seq >= reply.seq` 作为意图结算条件。

### HTTP 接口与命令行

- **统一 `POST /api/v1/<路径>`**：操作名中的 `.` 换为 `/` 即路径（如 `issue.status.update` → `/api/v1/issue/status/update`），参数统一放入 JSON 请求体。
- **严格来源校验**：HTTP 与 WebSocket 要求 `Host` 为回环地址；若有浏览器 `Origin` 则须与 `Host` 同源，`Sec-Fetch-Site` 仅接受 `same-origin` 或 `none`，否则返回 `403`。
- **请求幂等键 `requestKey`**：`issue.create`、`issue.status.update`、`channel.thread.create`、`memory.create` 接受 `requestKey`（最长 64 字符）。网关按操作缓存最近 500 个成功键的响应，失败不缓存。
- **开关写成幂等设值**：回应、置顶、归档定义为带 `on: boolean` 的 `*.set` 接口，重复设置相同值不产生副作用。
- **破坏性操作配对试跑 `dryRun`**：删除、合并、关单接口在 `endpoints` 中指向对应的 `preview<动词>` 接口。试跑与真做共用同一套前置判断函数，试跑不写库、不碰 git。
- **拒绝响应附带下一步 `next`**：`Refused` 与 `Missing` 携带 `next: { say, run? }[]`，给出可直接运行的 CLI 命令或指引。
- **CLI 是纯 HTTP 客户端**：`apps/cli` 不加载服务端、不直连数据库，通过 `--server`、`VIBEVALLEY_SERVER` 或 `$VIBEVALLEY_HOME/server.json` 连接服务端。
- **拥有者负责协调与身份分配**：处理器只传业务意图，由拥有者模块协调内部步骤并在锁内分配新实体 ID；查询缺失关联时列入 `missingSessions`，不伪造缺省对象。

## 怎么走

**施加一条事实**

1. 拥有者模块提交 SQLite 事务或文件后，调用 `Core.apply(...facts)`。
2. `Core` 盖上当前时间戳并运行 `reduce`；若状态未变则直接结束。
3. 原子替换可见状态、递增 `seq`，按序向 `/events`、`facts`、`transitions` 广播事实与特效。
4. `/state` 连接在 200ms 窗口后调用 `frameOf` 生成 `StateFrame` 推给客户端。

**服务端重启恢复**

1. `Core` 从空状态启动；各模块在构造阶段从数据库加载工单、频道、定时任务和在场会话并施加初始事实。
2. 启动层（`start`/`ready`）按序恢复：Session 检查目录并标记中断 Run、Channel 恢复会话串、Mailbox 重放投递、Cron 补跑任务、Orchestrator 续接回合、Game 重折账本与统计 commit。
3. HTTP 监听启动，写出 `server.json` 与就绪收据。

## 和谁打交道

- **施加事实的模块**：`issue`、`session`、`channel`、`connector`、`cron`、`voice`、`game`。
- **订阅事实的模块**：`game`、`inbox`、`issue`、`channel`。
- **外部客户端**：`apps/web`、`apps/cli` 与经 `lan` 放行的配对设备。

## 为什么这样

- **单一内存状态 + 纯函数 `reduce`，不发 JSON patch**：新增状态由编译器强制各视图处理；发领域事实而非字段 patch，让账本和通知直接按事件语义反应。
- **「事实」只留一个意思，成员名带语义**：非核心状态概念改回本名，事实用 `<实体>Changed`/`<实体>Removed`/动词过去式，消除名词歧义。
- **页面读折好的帧，文案在出帧时填入**：避免前后端维护两套 `reduce`；界面文案不落盘、不进 `Transition`，改措辞或切语言无历史兼容负担。
- **命令走 `POST /api/v1/<op>`，状态走三条 SSE**：操作名即路径，省去 REST 参数拆分；`/state`、`/live`、`/events` 按职责分离，断线重连直接拿新帧。
- **能力表 `endpoints` 单源派生多端入口**：权限 `can`、Schema、试跑与路径写在同一行，自动生成或校验 `Handlers`、`VibeValleyApi`、`capabilities.md` 与 `lan` 放行表。

## 还没做的

- `can` 只留 `owner` 与 `remote`，agent 工具按档案配置：[agent 带什么：工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)。
- 状态提交与外部副作用统一为事务后任务：[状态先提交，副作用由 worker 在提交之后做](.agents/notes/proposed/architecture/2026-10-22-commit-then-effects.md)。

## 怎么验证

- `apps/server/src/core/core.test.ts`、`apps/server/src/core/golden.test.ts`：事实去重、`seq` 递增、批次原子提交与黄金数据测试。
- `packages/protocol/src/api.test.ts`、`apps/server/src/http/api.test.ts`、`apps/server/src/flows/request.test.ts`：接口命名规范、`requestKey` 幂等与帧 `seq` 同步测试。
- `apps/cli/src/main.test.ts`、`apps/cli/src/golden.test.ts`：CLI 全接口覆盖、试跑与错误 `next` 测试。
