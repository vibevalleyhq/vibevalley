# Agent Note: VibeValley DevTools 与跨边界强类型协议准则

Status: proposed

## Problem

VibeValley 的原生应用在单进程内叠加了四层链路：GPUI 原生外壳（`apps/mac/src/`）、`nsh` 托管界面（`apps/mac/ui/`）、进程内 Rust 服务端（`crates/server/`）以及经 OAR 驱动的本地编码引擎子进程（`crates/runtime/src/oar/`）。随着直连对话、多工作区和实时协作内容接入，排障与跨层演进暴露出两类结构问题：

1. **排障手段原始且割裂**：既有调试钩子（[debug.rs](apps/mac/src/debug.rs)）仅支持每秒把外壳状态整份落盘到 `VIBEVALLEY_DEBUG_DUMP`，或按文本行驱动 `VIBEVALLEY_DEBUG_SCRIPT`，缺少实时因果时间线、运行态轨迹检视、延迟注入与画布元素定位。
2. **跨进程／跨运行时边界的强类型收口与明确划线**：服务端与工作台之间已由 `crates/protocol` 生成强类型契约，但跨运行时边界仍需明确准则——跨边界统一收拢进 `crates/protocol`，同一 Rust 进程内业务模块保持窄 trait 直调，避免过度 RPC 化。

## Proposal

建立统一的 **VibeValley DevTools** 及底层的 **`DebugKit` 强类型协议**，同时确立仓库的**跨边界协议化准则**——跨运行时、跨渲染载体与跨进程边界收拢进 `crates/protocol` 强类型契约，同一 Rust 进程内的业务模块维持窄 trait 与直接调用。

**V1 现已落地（`feat/devtools-v1`）**，并已沉淀进 [architecture.md](docs/architecture.md)、[app.md](docs/subsystems/app.md)、[core.md](docs/subsystems/core.md) 与 [foundation.md](docs/subsystems/foundation.md)；本文保留剩余 **V2** 范围与产品决策记录。

### 1. 已落地的 V1 范围与产品决策

- **强类型契约与宿主边界**：
  - [debug.rs](crates/protocol/src/contract/debug.rs) 与 [endpoints.rs](crates/protocol/src/contract/endpoints.rs) 落定 `DebugKit` 21 组强类型与 9 个仅限 `Caller::User` 的端点（`debug.snapshot`、`debug.timeline.list`、`debug.timeline.clear`、`debug.trajectory.list`、`debug.trajectory.get`、`debug.graph`、`debug.override.get`、`debug.override.set`、`debug.bundle.export`），同步生成 [debug/shapes.gen.ts](packages/protocol/src/debug/shapes.gen.ts)、[client.ts](packages/protocol/src/client.ts) 与 [capabilities.md](docs/reference/capabilities.md)。
  - [host.rs](crates/protocol/src/contract/host.rs) 与 [host/schema.ts](packages/protocol/src/host/schema.ts) 补齐 40 成员封闭枚举 `HostOp`（`HostOp::from_wire` / `op_name`）及 `HostAction::{ToggleDevtools, DetachDevtools, CloseDevtools}`，`apps/mac` 宿主桥在边界一次解码并穷尽匹配。
- **零开销采集内核与统一日志**：
  - 根 [Cargo.toml](Cargo.toml) 引入工作区 `tracing` 与 `tracing-subscriber`，`vibevalley-server` 与 `vibevalley-mac` 启动初始化 `try_init()`（读取 `VIBEVALLEY_LOG` / `RUST_LOG`，`VIBEVALLEY_DEBUG=1` 默认 `info`，否则 `warn`）。
  - [crates/server/src/modules/infra/debug/](crates/server/src/modules/infra/debug/mod.rs) 实现 `DebugKit`：仅在 `VIBEVALLEY_DEBUG=1` 时挂接 `InvokeObserver`、`FaultGate` 与 `OarObserver`（未启用时 9 个端点一律返回 `BizCode::Refused`，且热路径无锁零堆分配）；提供四泳道定长环形缓冲（`CoreApply`、`BridgeRpc`、`OarWire`、`GpuiFrame`，每泳道 512 条，单载荷上限 4096 字节）、跳过 `debug.*` 的 `FaultGate`、统一脱敏器（实时 `Secret` 值 + 敏感键名 + 常见令牌前缀正则）、覆盖任务／工作区对话／主助手与 `oar-voyage/3` JSONL 及静默错误检测的只读轨迹检视器，以及零依赖纯 Rust ZIP 打包导出（`debug-bundle.zip`）。
- **桌面外壳与六视图工作台**：
  - [devtools.rs](apps/mac/src/shell/devtools.rs) 在 `VIBEVALLEY_DEBUG=1` 时渲染底边 5 信号悬浮胶囊（`devtools-capsule`）、支持 `⇧⌥D` 切换浮层（`devtools-overlay`）与拆出独立 GPUI 窗口，并经 `ShellDebugHandle` 上报路由、客户端、包模式、端口、启动耗时、缓存统计与有界帧耗时。
  - [DevToolsApp.tsx](apps/mac/ui/features/devtools/DevToolsApp.tsx) 以 `HostedView("devtools")` 渲染 6 个应用语义视图：**Overview**（含活体拓扑 `Graph`）、**Routes**、**Timeline**、**Trajectory**、**State & Cache**、**Lab & Overrides**。
- **产品决策——不提供 `vibevalley debug` CLI**：V1 明确省略 `vibevalley debug ...` 命令行子命令；DevTools V1 面向 `HostedView("devtools")` 进程内桥与本机回环 `POST /api/v1/debug/*` 接口（均受 `VIBEVALLEY_DEBUG=1` 与 `Caller::User` 门禁保护），避免在用户 CLI 中暴露调试子命令面。

### 2. 跨边界协议化准则

遵循「跨边界强类型协议化，进程内保持直调」原则，按是否跨越运行时、渲染载体或进程边界决定是否引入协议：

1. **GPUI `Shell` ↔ 托管界面（`HostFrame` / `HostAction` / `HostOp`）**：已全部收拢至 [host.rs](crates/protocol/src/contract/host.rs) 与 [host/schema.ts](packages/protocol/src/host/schema.ts)，支持脱离 macOS GUI 窗口的纯内存单元测试。
2. **内容协作引擎 ↔ 渲染前端（`CollabTransport`）**：配合 [Loro 协作内容引擎](.agents/notes/proposed/architecture/2026-11-22-loro-collaborative-content-engine.md)，在服务端 CRDT Proxy 与白板／块文档／沙箱前端之间只暴露薄同步协议。
3. **运行态观测 ↔ 调试端（`DebugKit`）**：以 `crates/protocol` 中的 `DebugKit` 契约统一桌面浮层与后续强类型验收驱动。
4. **边界内禁区（保持直调）**：同一 Rust 进程内的业务模块（如 `crates/server/src/modules/work/{issue,session,workplace}` 之间）继续使用窄 Rust trait 与强类型结构体直接调用（见 [模块设计](docs/style/module-design.md)），不引入进程内 JSON／RPC 层。

### 3. 剩余 V2 范围

| 项 | 负责内容 |
|---|---|
| **画布 `Inspector`** | 点选画布高亮 `testID` 与布局边界框、查看关联托管视图状态与修订号、一键跳至对应 `.tsx` 或 `.rs` 源码 |
| **Trajectory 进阶联动** | Trajectory 与 Timeline 双向定位、子代理嵌套树钻取、一键导出脱敏轨迹供 `vibevalley-eval replay` / `inspect` 复现 |
| **Loro 状态检视** | 在 `State & Cache` 中接入 Loro 文档前沿与 `EphemeralStore` 在线态视图（见 [Loro 协作内容引擎](.agents/notes/proposed/architecture/2026-11-22-loro-collaborative-content-engine.md)） |
| **退役旧调试钩子** | 用强类型 `DebugCommand` 收编替换 [debug.rs](apps/mac/src/debug.rs) 的 1 秒定时整份 dump 与非类型化 `VIBEVALLEY_DEBUG_SCRIPT` 文本脚本 |

## Alternatives considered

**在 `vibevalley` CLI 中增设 `vibevalley debug` 子命令**：CLI 面向日常任务与代理自动化，暴露调试与故障注入子命令会扩大命令行接口面与维护成本；本机排障脚本已可直接调回环 `POST /api/v1/debug/*`（需 `VIBEVALLEY_DEBUG=1`），故决定不新增 `vibevalley debug` CLI。

**继续扩展 `apps/mac/src/debug.rs` 的定时 dump 与文本脚本**：每秒序列化整份 `Shell` 状态写盘，既无法捕捉瞬时主线程卡顿和跨层因果时序，也不支持交互式点选、延迟注入与实时订阅观察；继续堆命令字只会让非类型化字符串协议越来越难维护。

**为每个业务模块引入独立的内部事件总线或进程内 RPC**：把 `crates/server/src/modules/` 内部拆成 JSON 消息传递会破坏 Rust 编译期类型边界与窄模块接口，增加序列化开销且无实际跨进程需求。仅在 4 个跨层汇流点采集调试事件，既能看到完整因果链，又守住进程内直调的简洁边界。

**内置第三方浏览器 DevTools 或外挂独立 Web 调试服务**：VibeValley 原生应用已彻底脱离 WebView，内置浏览器调试器违背原生定位；外挂独立 Web 服务则会增加端口、打包与样式维护成本。直接复用 `HostedView("devtools")` 与 [tokens.json](design/tokens.json) 可在同进程内零额外运行时依赖完成呈现。

## Acceptance criteria

- **V1（已落地）**：
  - 未设置 `VIBEVALLEY_DEBUG=1` 时，`Hub` 不挂接观察器与故障门（热路径仅一次 `ArcSwapOption` 无锁读取），9 个 `debug.*` 接口一律返回 `BizCode::Refused`，桌面不渲染悬浮胶囊与 `HostedView("devtools")`。
  - `DebugKit` 与 `HostFrame`/`HostAction`/`HostOp` 协议、TS 生成物、`vp run protocol:check` 与 `apps/mac` 纯内存单测全部通过。
  - 开启 `VIBEVALLEY_DEBUG=1` 后，底边胶囊、`⇧⌥D` 浮层与独立拆窗展示 Overview（含拓扑）、Routes、Timeline（4 泳道因果对齐）、Trajectory（任务／工作区对话／主助手逐轮瀑布流、原始载荷、`EventTokens` 与静默错误）、State & Cache 与 Lab & Overrides（延迟注入跳过 `debug.*`、脱敏 `debug-bundle.zip` 导出）。
  - 单元测试验证脱敏器拦截实时 `Secret`、敏感键与令牌前缀，环形缓冲严格有界（512/泳道）。
- **V2（待实施）**：
  - 画布 `Inspector` 可命中 `testID` 并跳至源码；`State & Cache` 展示 Loro 前沿与 `EphemeralStore`；Trajectory 支持与 Timeline 双向定位、子代理树展开及导出供 `vibevalley-eval replay` / `inspect` 复现；原有 `VIBEVALLEY_DEBUG_SCRIPT` 验收用例全部迁至强类型 `DebugCommand` 并移除旧 [debug.rs](apps/mac/src/debug.rs) 脚本与定时 dump 路径。

## Risks

- **敏感凭据随快照或 `debug-bundle.zip` 泄漏**：OAR 线缆帧、环境变量和 HTTP 头可能携带 token 或密钥。应对方式是在 `DebugKit` 采集边界与导出前强制经过统一脱敏器与最终字节扫描，并保留回归单测拦截。
- **高频事件导致环形缓冲抖动或观测影响被测系统**：流式 token 与高频帧推送可能挤占缓冲或干扰主线程计时。应对方式是分泳道定长环形缓冲（512/泳道，单载荷 4096 字节截断），并在后台完成快照聚合与 ZIP 打包。
- **V2 验收迁移期间双套入口并存**：在强类型 `DebugCommand` 落地前，[debug.rs](apps/mac/src/debug.rs) 仍承担现有自动化截图脚本。应对方式是待 V2 补齐后一次性切换验收脚本并删除旧路径，不长期并行维护。
