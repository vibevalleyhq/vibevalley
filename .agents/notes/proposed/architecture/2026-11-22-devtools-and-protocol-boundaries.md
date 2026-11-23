# Agent Note: VibeValley DevTools 与跨边界强类型协议准则

Status: proposed

## Problem

VibeValley 的原生应用在单进程内叠加了四层链路：GPUI 原生外壳（`apps/mac/src/`）、`nsh` 托管界面（`apps/mac/ui/`）、进程内 Rust 服务端（`crates/server/`）以及经 OAR 驱动的本地编码引擎子进程（`crates/runtime/src/oar/`）。随着直连对话、多工作区和实时协作内容接入，排障与跨层演进暴露出两类结构问题：

1. **排障手段原始且割裂**：现有调试钩子（[debug.rs](apps/mac/src/debug.rs)）仅支持每秒把外壳状态整份落盘到 `VIBEVALLEY_DEBUG_DUMP`，或按文本行驱动 `VIBEVALLEY_DEBUG_SCRIPT`。排障时既看不到实时时间线（`Core::apply` 事实、Bridge RPC／订阅、OAR 原始线缆帧与主线程慢调用的因果对齐），也无法点选界面元素查看 `testID`、布局边界或注入延迟验证 150 ms 防闪与骨架屏；CLI 侧也没有对应命令供排障 Agent 拉取同一份运行态。
2. **跨进程／跨运行时边界的强类型收口与明确划线**：服务端与工作台之间已由 `crates/protocol` 生成强类型契约，GPUI 外壳与托管界面之间的核心帧与动作（`Host*` 帧与 `HostAction`）也已落入 [host.rs](crates/protocol/src/contract/host.rs) 与 [host/schema.ts](packages/protocol/src/host/schema.ts)，但 `host.*` 宿主 RPC（`HostOp`）与外壳纯内存单测尚未全部收口；同时若缺少清晰边界准则，跨边界强类型协议化容易被误扩为进程内业务模块之间的过度 RPC 化。

## Proposal

建立一套统一的 **VibeValley DevTools**（参考 Vue DevTools v7 与 Nuxt DevTools 的应用语义调试驾驶舱）及底层的 **`DebugKit` 强类型协议**，同时确立仓库的**跨边界协议化准则**——跨运行时、跨渲染载体与跨进程边界收拢进 `crates/protocol` 强类型契约，同一 Rust 进程内的业务模块维持窄 trait 与直接调用。

### 1. VibeValley DevTools：应用语义调试驾驶舱

#### 入口、形态与外观

- **启用门禁**：仅在 `VIBEVALLEY_DEBUG=1` 或开发模式显式开关开启时挂载；默认发布态完全关闭。
- **悬浮胶囊与展开态**：开启后在窗口底边显示极简悬浮胶囊，实时呈现 5 项高频信号：发布通道与回环端口、当前工作台路由、活跃执行会话与订阅数、最新切片序号 `seq` 以及最近一帧绘制耗时。点击胶囊或按 `⇧⌥D` 展开左侧窄图标栏浮层，并支持拆出为独立 GPUI 窗口。
- **UI 载体复用**：DevTools 界面直接作为 `HostedView("devtools")` 渲染，复用 [tokens.json](design/tokens.json) 令牌与工作台基础组件，不引入第二套前端框架或独立 Web 调试服务。

#### 八个应用语义视图

| 视图 | 负责内容 | 关键能力 |
|---|---|---|
| **Overview** | 进程与运行环境总览 | 通道、回环端口、SQLite 路径、可用引擎探测结果、`bundle.nshc` 字节码命中态、内置服务启动耗时 |
| **Routes** | 路由与分栏面板 | 当前工作台路由树、活跃项目全部 `PaneKind` 列表，以及一键切换 `FakeServer` 夹具场景 |
| **Inspector** | 元素与布局检查 | 点选画布高亮 `testID` 与布局边界框、查看关联托管视图状态与框架修订号、一键跳到对应 `.tsx` 或 `.rs` 源码 |
| **Timeline** | 四泳道因果时间线 | 对齐显示 4 条时间轨：① `Core::apply` 事实、② Bridge RPC 与订阅事件、③ OAR／ACP 原始线缆事件、④ GPUI 主线程耗时超过 16 ms／50 ms 的慢帧与阻塞点 |
| **Trajectory** | 轨迹视图（Agent OS 核心排障） | 按任务执行会话、工作区直连对话、主助手会话与子代理树直读 `Trajectories`、`oar::voyage`／JSONL `record` 与 `antigravity_db` 诊断：按轮次展开系统提示／附加提示快照、思考块、工具调用原始入参与输出（含截断前后字节数）、每步耗时瀑布条与子代理嵌套树；逐轮呈现 `EventTokens`（input／cacheRead／cacheWrite／reasoning／output／上下文窗口占比）、权限／交互提问节点与静默上游错误（如 `agy` `step_type = 17`、`QUOTA_EXHAUSTED`、`INVALID_THINKING_SIGNATURE`）；与 Timeline 泳道双向定位，并支持一键导出脱敏轨迹供 `vibevalley-eval replay`／`inspect` 复现 |
| **Graph** | 活体拓扑图 | 展示 `HostedView → 活跃 subscribe` 扇出关系，以及 `任务 → Worktree → OAR 子进程` 的实时占用与归属 |
| **State & Cache** | 状态与缓存检视 | 检索 `SpaceState` 与 6 路域切片（`board`、`sessions`、`collab`、`inbox`、`ops`、`farm`）、查看像素图集与附件缓存命中率；未来并入 Loro 文档前沿与 `EphemeralStore` 在线态（见 [Loro 协作内容引擎](.agents/notes/proposed/architecture/2026-11-22-loro-collaborative-content-engine.md)） |
| **Lab & Overrides** | 故障演练与打包 | 全局延迟注入（`0` / `+300 ms` / `+1000 ms`）以实测 150 ms 防闪与骨架屏、模拟订阅断连重连、一键导出脱敏 `debug-bundle.zip` |

#### 统一 `DebugKit` 协议与零开销关闭原则

- **强类型契约**：在 `crates/protocol` 定义 `DebugKit` 协议（`DebugSnapshot`、`DebugTimelineEvent`、`DebugTrajectorySummary`、`DebugTrajectoryDetail`、`DebugGraph`、`DebugOverride`、`DebugCommand`）及默认脱敏的只读轨迹查询接口（`debug.trajectory.list`、`debug.trajectory.get`，直读 `Trajectories` 与 `oar::voyage`），由 `protocol:ts` 同步生成 TS 形状。
- **四点汇流、关闭零开销（脊柱插槽已落地）**：仅在 4 个天然汇流点检查原子开关，关闭态零锁零堆分配，开启态写入固定容量环形缓冲。服务端 `Hub` 的 `CallerContext` / `ClientIdentity` / `InvokeObserver` / `FaultGate` / `HostDebugBridge` 插槽、OAR 零开销 `OarObserver` 钩子与主助手 `record_to` JSONL 落盘已在三核解耦中落位，待 V1 接入环形缓冲与采集实现：
  1. `BridgeHub` / `Hub::call_with`（全部 RPC、订阅与切片推送）
  2. `Core::apply`（全部核心状态事实与 `SliceMask`）
  3. GPUI `Shell` 主线程帧／派发计时与 `HostDebugBridge` 快照
  4. `oar::Session`（`OarObserver` 原始线缆事件与子进程状态）
- **一套协议服务三端**：
  1. **DevTools 浮层**（`HostedView("devtools")` 经进程内桥订阅）
  2. **`vibevalley debug ...` CLI**（经回环 HTTP 门查询快照、时间线、拓扑与覆盖项，供开发者和排障 Agent 直接读取运行态）
  3. **自动化验收驱动**：逐步收编替代 [debug.rs](apps/mac/src/debug.rs) 的 1 秒定时整份 dump 与非类型化文本脚本，把截图、动作回放和状态断言统一到同一组强类型命令上。

### 2. 跨边界协议化准则

遵循「跨边界强类型协议化，进程内保持直调」原则，按是否跨越运行时、渲染载体或进程边界决定是否引入协议：

#### 优先协议化的三条边界

1. **GPUI `Shell` ↔ 托管界面（`HostFrame` / `HostAction` / `HostOp`）**：`Host*` 帧与 `HostAction` 已落入 [host.rs](crates/protocol/src/contract/host.rs) 与 [host/schema.ts](packages/protocol/src/host/schema.ts) 并接入 [frames.rs](apps/mac/src/hosted/frames.rs) 与 [bridge.rs](apps/mac/src/hosted/bridge.rs)；V1 继续将剩余 `host.*` 载荷（`HostOp`）收拢到 `crates/protocol`，使 GPUI `Shell` 状态机可注入模拟宿主端并在无 macOS GUI 窗口下跑纯内存单元测试。
2. **内容协作引擎 ↔ 渲染前端（`CollabTransport`）**：配合 [Loro 协作内容引擎](.agents/notes/proposed/architecture/2026-11-22-loro-collaborative-content-engine.md)，在服务端 CRDT Proxy 与白板／块文档／沙箱前端之间只暴露极薄的 `CollabTransport` 协议（增量更新字节、`EphemeralStore` 帧、版本向量补齐），不把 CRDT 内部结构泄漏到业务接口。
3. **运行态观测 ↔ 调试端（`DebugKit`）**：以本提案定义的 `DebugKit` 协议统一桌面浮层、CLI 与验收脚本。

#### 边界内禁区（保持直调）

- **同一 Rust 进程内业务模块不应 JSON／RPC 化**：如 `crates/server/src/modules/work/{issue,session,workplace}` 之间及服务端各域模块之间，应继续使用窄 Rust trait 与强类型结构体直接调用（见 [模块设计](docs/style/module-design.md)）。进程内人为引入序列化层只会增加样板、丢失编译期穷尽校验并放大维护成本。

### 3. 分阶段路线

1. **V1 — `DebugKit` 内核 + 胶囊与核心视图（含轨迹视图）+ 外壳协议定型**：
   - 在 `crates/protocol` 落定 `DebugKit` 协议（含 `debug.trajectory.list` / `debug.trajectory.get`）与 `HostFrame`/`HostAction`/`HostOp` 强类型定义，替换 [frames.rs](apps/mac/src/hosted/frames.rs) 与 [bridge.rs](apps/mac/src/hosted/bridge.rs) 中的无类型 JSON 拼接。
   - 在 4 个汇流点接入 `AtomicBool` 零开销采集与定长环形缓冲；上线 `vibevalley debug snapshot|timeline|trajectory|graph|override` CLI。
   - 在 `apps/mac` 上线底边悬浮胶囊与 `HostedView("devtools")` 的 Overview、Routes、Timeline、Trajectory（按轮次瀑布流、系统提示／思考块／原始工具载荷、逐轮 `EventTokens` 与静默错误定位）、State & Cache 与 Lab & Overrides（含延迟注入与脱敏 `debug-bundle.zip` 导出）。
2. **V2 — 画布 Inspector、活体 Graph、轨迹评测联动与旧钩子退役**：
   - 补齐 Inspector（画布点选高亮 `testID`、边界框与源码跳转）和 Graph（订阅与 `任务 → Worktree → OAR` 实时拓扑）。
   - 打通 Trajectory 与 Timeline 双向定位、子代理嵌套树钻取及一键导出脱敏轨迹供 `vibevalley-eval replay` / `inspect` 复现。
   - 接入 Loro 前沿与 `EphemeralStore` 视图，并用强类型 `DebugCommand` 收编替换 [debug.rs](apps/mac/src/debug.rs) 的文本脚本与定时文件 dump。

## Alternatives considered

**继续扩展 `apps/mac/src/debug.rs` 的定时 dump 与文本脚本**：每秒序列化整份 `Shell` 状态写盘，既无法捕捉瞬时主线程卡顿和跨层因果时序，也不支持交互式点选、延迟注入与实时订阅观察；继续堆命令字只会让非类型化字符串协议越来越难维护。

**为每个业务模块引入独立的内部事件总线或进程内 RPC**：把 `crates/server/src/modules/` 内部拆成 JSON 消息传递会破坏 Rust 编译期类型边界与窄模块接口，增加序列化开销且无实际跨进程需求。仅在 4 个跨层汇流点采集调试事件，既能看到完整因果链，又守住进程内直调的简洁边界。

**内置第三方浏览器 DevTools 或外挂独立 Web 调试服务**：VibeValley 原生应用已彻底脱离 WebView，内置浏览器调试器违背原生定位；外挂独立 Web 服务则会增加端口、打包与样式维护成本。直接复用 `HostedView("devtools")` 与 [tokens.json](design/tokens.json) 可在同进程内零额外运行时依赖完成呈现。

## Acceptance criteria

- **关闭态零开销**：未设置 `VIBEVALLEY_DEBUG=1` 时，4 个汇流点仅执行一次 `AtomicBool::load(Ordering::Relaxed)`，基准测试证明 `Core::apply` 与 `BridgeHub` 转发零额外堆分配，且默认界面不渲染悬浮胶囊。
- **V1 协议与视图验证**：
  - `crates/protocol` 与 `packages/protocol` 生成物包含 `DebugKit` 与 `HostFrame`/`HostAction`/`HostOp`，`vp run protocol:check` 通过，且 GPUI `Shell` 状态机具备脱离 macOS 窗口运行的纯内存单元测试。
  - 开启 `VIBEVALLEY_DEBUG=1` 后，底边胶囊与 `⇧⌥D` 浮层可正常显示 Overview、Routes、Timeline（4 条泳道因果对齐）、Trajectory（覆盖任务执行会话、工作区直连对话与主助手会话的逐轮瀑布流、原始工具入参／输出、逐轮 `EventTokens` 与 `agy` `step_type = 17` 静默错误）、State & Cache 与 Lab & Overrides；注入 `+300 ms` 延迟可稳定复现并截图验证 150 ms 防闪与骨架屏；`vibevalley debug snapshot --json` 与 `debug trajectory --json` 返回与浮层同源的脱敏结构化结果。
- **脱敏与资源上限**：导出的 `debug-bundle.zip`、`debug.trajectory.*` 及 `DebugKit` 全部响应经单元测试验证不含任何 `Secret` 密钥、API Key、认证头或环境变量凭据；持续高吞吐运行下环形缓冲内存占用严格有界且不增长。
- **V2 完整验收**：Inspector 可命中画布 `testID` 并跳至源码，Graph 准确反映订阅与 `任务 → Worktree → OAR` 拓扑，Trajectory 支持与 Timeline 双向定位、子代理树展开及导出供 `vibevalley-eval replay` / `inspect` 复现，原有 `VIBEVALLEY_DEBUG_SCRIPT` 验收用例全部迁至强类型 `DebugCommand` 并通过。

## Risks

- **敏感凭据随快照或 `debug-bundle.zip` 泄漏**：OAR 线缆帧、环境变量和 HTTP 头可能携带 token 或密钥。应对方式是在 `DebugKit` 采集边界强制过统一的字段脱敏器，复用 `Secret` 打码规则，并在导出前对文本载荷执行正则兜底扫描与单测拦截。
- **高频事件导致环形缓冲抖动或观测影响被测系统**：流式 token 与高频帧推送可能挤占环形缓冲或干扰主线程计时。应对方式是采用固定容量分泳道环形缓冲（如每泳道独立上限，单条载荷截断至固定字节数），并在后台线程完成快照序列化与 `debug-bundle.zip` 打包。
- **调试端暴露面扩大**：`vibevalley debug ...` 与故障注入能力仅应服务本机调试。应对方式是所有 `DebugKit` 端点严格绑定 `127.0.0.1` 回环门，仅在 `VIBEVALLEY_DEBUG=1` 或开发模式开关启用时注册响应，发布态默认拒绝全部调试与覆盖接口。
- **外壳协议迁移期间的双份维护**：将 [frames.rs](apps/mac/src/hosted/frames.rs) 与 [bridge.rs](apps/mac/src/hosted/bridge.rs) 迁入 `crates/protocol` 若长期保留旧手拼路径会引发漂移。应对方式是按专题（`rail`/`files`/`git`/`palette`/`doc`）一次性切换并立即删除旧构造代码，不留兼容层。
