# Agent Note: 全仓收敛审计清单（C1–C14 与 S1–S6 待选收敛项）

Status: proposed

## Problem

在完成去 `watch` 化、领域无关 `AgentSession` 与全局 `SpaceState` 切片拆解这三条主线架构重构之外，全仓约 43.5 万行手写代码中仍积累了不少扩张期遗留：未接线子系统、重复基础设施、双源契约与测试脚手架混入发布包、线上隐形存储/CPU 泄漏，以及若干低调但真实的产品缺陷（例如错写的清单文件名与内存假持久）。

按照「先把三核架构与数据库布局拆干净，再按拍板逐批收敛」的节奏，需要把这批收敛项完整沉淀为单一账本，避免后续重复排查或误删已受保护的刻意设计。

## Proposal

将剩余全仓收敛机会拆为三组挂账：**第一梯队（`C1`–`C14`）**为低争议清理与缺陷修复，**第二梯队（`S1`–`S6`）**为产品边界与模块取舍（已明确拍板方向，按项排期实施），**延后收敛组（`I1`–`I3`）**负责统一进程内 IO 调度底座与常用依赖减压。

### 第一梯队：零争议收敛与缺陷修复（`C1`–`C14`，Stage 4A）

Stage 4A 在分支 `refactor/full-repo-convergence` 上按 Wave 1 / Wave 2 推进，除 `C2` 更深层的 Rust 直出瘦客户端重构外，其余项均随本批收口落地：

1. **`C1`（`crates/runtime` 零消费者 `pi.live` 每 token 刷盘与 `Axum` WebSocket 冗余特性）— Stage 4A 收口**：Wave 1 已移除 [live.rs](crates/runtime/src/agent/durable/storage/live.rs)、[sqlite.rs](crates/runtime/src/agent/durable/storage/sqlite.rs) 与 `agent/core` 中无生产消费者的 `put_deferred`/`pi.live` 延迟刷盘线程与 `LiveDoc`/`LiveState` 逐 token 序列化（流式 delta 保留内存观察器）；Wave 2 同步移除 `crates/server/Cargo.toml` 上不再使用的 `axum/ws` 特性。
2. **`C2`（`packages/protocol/` 死导出与死 Zod 镜像清理）— Stage 4A 部分落地，深层瘦客户端留作后续**：Wave 2 已清理 `packages/protocol/src/**` 中 48 处零引用死 Zod 镜像与遗留声明（`Fact*` × 20、`Fact`、`ServerEvent`、`SpaceState`、`LedgerEntry*` × 14、`Secret`、`suggestionId`、`IssueReport*`、`IssueWatch`、`MediaSpeechEvent`、`MediaAudioRequest`、`PlayAction`/`SessionPlay`/`ProgressNews`），移除 `packages/protocol/src/schema.ts` 的 13 个内部非对象死导出与 `packages/protocol/src/api.ts` 的 21 个未用 `*Handlers` 转发，并删除重复的 `agent/shapes.ts` 与 `media/shapes.ts`（改为直用生成物 `AgentProblemLevelValues`、`JobKindValues`），同时完整保留全部真实边界编解码器（6 域切片、订阅、`Host*`、`Remote*`、`Debug*`、iframe `postMessage` 及 `schema.test.ts`/`api.test.ts` 覆盖）。更深层的结构改造（由 [typescript.rs](crates/protocol/tests/typescript.rs) 直出瘦 `VibeValleyApi` 与 `BizCode` 并退役 19 份 `*/api.ts`）因牵动 `scripts/gen/{api-client,capabilities}.ts`，留作后续专项评估。
3. **`C3`（删除 `crates/rich/` 已被白板取代的死交互 Canvas 引擎与 `hooks.rs`）— Wave 1 已落地**：[原生白板](apps/mac/ui/features/artifact/WhiteboardView.tsx)已接管交互编辑，[canvas.rs](crates/rich/src/canvas.rs) 只用静态 SVG 渲染。已内联 `svg.rs` 依赖的静态标签矩形与路由原语，删除 `crates/rich/src/engine/canvas/{ops,hit,geometry}.rs`、`crates/rich/src/hooks.rs` 与三份对应测试（净减 ~3.2k 行）。
4. **`C4`（`apps/mac` 壳层重复打包与像素场景死路径清理）— Stage 4A 收口**：Wave 1 已从主入口 [App.tsx](apps/mac/ui/App.tsx) 剥离仅属于 [ShellApp.tsx](apps/mac/ui/ShellApp.tsx) 的 workspace 面板包体（主包 `bundle.nshc` 减少 ~1.14 MB）并清理 9 处零调用 `hostApi.*` 包装；Wave 2 同步清理原生壳已退役的 `CatalogScene`（`apps/mac/src/pixel/catalog.rs`）、死 `Action`、旧音频桥处理器与旧着色素描路径。
5. **`C5`（`crates/runtime/` 与 `team/memory/` 清除 5 处线上隐形泄漏及死扩展/兼容兜底）— Stage 4A 收口**：Wave 1 已修复 5 处运行期泄漏（停写 `gov.evaluated_permissions`、`abort_trace`，`CoreState::records` 改为落盘按需读回与有界缓存，移除每轮 `Transcript::prefix_hash` SHA-256 重算，以及无预算空写事务），并删除零调用 `FileMemory`、`ConversationHandle`（`crates/runtime/src/agent/harness/handle.rs`）与 Go 兼容 base64 垫片（核实 `TodoExtension` 与 `SharedExecution` 仍有生产调用，予以保留）；Wave 2 同步审计 `team/memory/` 的 `memory.terms`（保留 `content/pkm` 所需的 `terms_list` 直至 Stage 4B `S2`）。
6. **`C6`（统一 `media` 与 `library` 公网下载及 `Moss` 客户端）— Wave 2 收口**：在 [http.rs](crates/server/src/modules/infra/http.rs) 提取绑定 DNS 验证的 `PublicDownload` 收拢 [library](crates/server/src/modules/content/library/mod.rs) 与媒体下载及 MOSS 客户端，删除平行的 `crates/server/src/modules/content/media/image_provider.rs`、`until_stopped` 与冗余 `OfflineImages` 测试缝。
7. **`C7`（修复 `collab/connector/` 连接池与 Token 缓存）— Wave 2 收口**：让 [adapter.rs](crates/server/src/modules/collab/connector/adapter.rs) 复用 `infra/http` 共享连接池，提取飞书/QQ 共用 Token 缓存（完整保留 `feishu.rs` Protobuf 解码）。
8. **`C8`（修复 `pyrepo.toml` 错字与 `defineStored` 重启丢失偏好缺陷）— Stage 4A 收口**：Wave 1 已将 [polyfill.ts](apps/mac/ui/infra/polyfill.ts) 的 `localStorage` 与 [stored.ts](apps/mac/ui/infra/state/stored.ts) 接入 `nsh` 持久化 `Storage`（[storage.ts](apps/mac/ui/infra/state/storage.ts)）并在前端接入 `host.info` 主题回读；Wave 2 同步修正 [repo.rs](crates/server/src/modules/work/repo.rs) 的 `"pyrepo.toml"` → `"pyproject.toml"` 错字并在 Mac [host_bridge.rs](apps/mac/src/shell/host_bridge.rs) 补齐 `host.info` 主题字段回读。
9. **`C9`（清理 `crates/core` 死导出与废止的 `patrol` / 每帧冗余文案）— Wave 1 已落地**：已删除不再运行的 `crates/core/src/patrol.rs`、孤立未编译测试 `crates/core/src/tests.rs`（抢救保留唯一有效回归测试至 `core.rs`）与 [inbox.rs](crates/core/src/inbox.rs) 的 `brief::*` / `inbox_entries` / `fresh_of` 每帧丢弃构造，收窄并清理全 crate 零调用导出（`brief::cure_words` 仍与 `server.issue.brief.{cure,cureHead,cureTail}` 词典配套保留，净减 ~1k 行）。
10. **`C10`（清理 `work` 域冗余订阅与 `ServerConfig` 测试缝）— Wave 2 收口**：移除 `Ledger::subscribe`/`Board::record_pull_request` 旧路径，统一复用 `base::RequestKeys`、`ModuleDb` 与定时 ticker，收拢散落的测试配置项。
11. **`C11`（收敛内容中心 UI 分裂与 `artifact/collab.rs` 重复锁/兼容清洗）— Stage 4A 收口**：Wave 1 已统一内容中心侧栏计数口径（[navigation.ts](apps/mac/ui/features/content/navigation.ts)）并清理 [frame.ts](apps/mac/ui/infra/frame.ts) 与 [artifact/frame.ts](apps/mac/ui/features/artifact/frame.ts) 死分支（核实 [Search.tsx](apps/mac/ui/features/pkm/Search.tsx) 仍有 `Shell.tsx` / `QuickSwitcher.tsx` 活调用与 8 条 `web.pkm.search.*` 词条，随 Stage 4B `S2` 统一退役）；Wave 2 同步整合 [collab.rs](crates/server/src/modules/content/artifact/collab.rs) 重复锁分发与 `entries.rs` 历史重清洗。
12. **`C12`（`crates/cli` 与 `workspace` 零星去重与死导出清理）— Wave 2 收口**：抽取 `crates/cli` 共用入口消除与 `vibevalley_eval` 的粘贴重复，清理零星仅测导出。
13. **`C13`（运行时支持矩阵单源化与失效的 `spent_today` 决断）— Stage 4A 收口**：Wave 1 已在 [oar/mod.rs](crates/runtime/src/oar/mod.rs) 落地 `BUILTIN_RUNTIME_SPECS` / `runtime_spec` / `runtime_refused_options` 单一能力真源；Wave 2 同步接入 [presets.rs](crates/server/src/modules/team/agent/presets.rs)、清理服务端与 Mac 壳遗留的 `"dsh"` 条目，并决断 `spent_today`。
14. **`C14`（边界 `serde_json::Value` 强类型收口）— Stage 4A 收口**：Wave 1 已在 [claude.rs](crates/runtime/src/oar/claude.rs) 与 [codex.rs](crates/runtime/src/oar/codex.rs) 完成 OAR 驱动边界强类型 `Deserialize` 解码；Wave 2 同步收口 [media/vendor.rs](crates/server/src/modules/content/media/vendor.rs)、[publish.rs](crates/server/src/modules/work/pull/publish.rs) 与 `modules/team/mcp/` 工具入参边界解码。

### 第二梯队：已拍板产品边界收敛（`S1`–`S6`，Stage 4B 待实施）

| 编号 | 所在与体量 | 核心事实 | 已拍板方向 |
| :--- | :--- | :--- | :--- |
| `S1` | `crates/rich` `genui` + `chart`（~19k 行） | 提示词与技能零引用，`onGenUiAction` 未接线 | **保留并补全接线**：补齐提示词/技能引用与 `onGenUiAction` 交互闭环 |
| `S2` | `pkm` 平行栈 vs `ArtifactType::Outline`（~7.7k 行） | [pkm.md](docs/subsystems/pkm.md) 现仍独立维护，而主工作台默认指向大纲作品 | **合并清理**：补齐 `.md` 导入等缺口后并入大纲作品，退役清理未用 `pkm` 平行栈与死接口 |
| `S3` | `crates/runtime` `eval` + `OarExtension` + `codemode`（~7.6k 行 + 6 重型依赖） | 生产只跑 `SqliteStorage`，未挂载扩展却全量编译 `rquickjs` 与 5 个 `oxc_*` crate | **明确保留**：核心能力不得删除；仅可按需评估用 Cargo `eval` 可选特性降低日常编译开销 |
| `S4` | `collab/voice/` Agora + `cloudflared` + Dictation（~2.1k 行） | 原生端当前仅走 MOSS Live（[live_voice.rs](apps/mac/src/live_voice.rs)） | **聚焦适配 MOSS Live**：围绕原生端 MOSS Live 收敛，淘汰未使用的 Agora / `cloudflared` / Dictation 路径 |
| `S5` | `crates/engines/pele` 33 种图谱（约 3.5–4 万行） | 由 [diagram.rs](crates/rich/src/diagram.rs) 调用 | **完整保留**：已移入下方「核实保留基线（不得误删）」 |
| `S6` | `artifact/collab.rs` 旧 `presence/*` 拦截与 `blocks::demo`（~330 行） | 网页已走强类型接口，仅缺 helper MCP 专用工具 | **淘汰旧的、迁移到新的**：补齐 helper MCP 专用工具后删除旧 `presence/*` 拦截与 `blocks::demo` 演示脚本 |

### 延后收敛组：IO 调度收敛与常用依赖减压（`I3` 剩余项）

`I1`（进程级唯一共享 Tokio 运行时 `vibevalley_runtime::rt` 与 `CancellationToken`/`TaskTracker` 级联停机）、`I2`（基于 `tokio::sync::watch` + `WatchStream` 的 `SliceFeed<T>`、`tokio::sync::broadcast` 承载 `LiveEvent` 与穷尽 `ChannelEvent` 单源广播、`EventBus` / `BridgeHub` 异步任务收口与 `spawn_blocking`）以及 `I3` 已落地项（`arc-swap` 无锁热读观察者/插槽、`parking_lot` 全仓去毒化、`backon` 统一指数退避、`crates/runtime` 与 `crates/cli` 生产路径收口工作区 `reqwest`，以及 `feat/devtools-v1` 接入的工作区 `tracing` + `tracing-subscriber`）均已沉淀进[地基](docs/subsystems/foundation.md)、[核心状态](docs/subsystems/core.md)与[频道](docs/subsystems/channel.md)。

本组尚待后续排期的 `I3` 减压项如下（不引入重型 Actor 框架，进程内模块间继续保持强类型 trait 直调）：

| 依赖 / 项 | 取代目标与当前落点 | 收益 |
| :--- | :--- | :--- |
| `moka`（或 `quick_cache`） | 手写 `Mutex<HashMap>` 缓存淘汰与并发击穿防护 | 提供有界容量、TTL 与单飞加载 |
| `notify-debouncer-mini`（待评估） | [crates/files/Cargo.toml](crates/files/Cargo.toml) 下手写监听防抖状态机 | 减少重复防抖状态机维护 |

（`I3` 的测试侧 `ureq` 收尾已随 Stage 4A Wave 2 将 `crates/server` 剩余测试迁移至工作区 `reqwest::blocking` 并从 `Cargo.toml` 彻底移除 `ureq`。）

### 核实保留基线（不得误删）

以下模块虽在单层检索中看似低引用，经子系统文档、跨端检索或产品拍板已核实为核心资产或刻意优化：`crates/core/src/scenario.rs`（`scenarios` 门控测试夹具）、`crates/rich/src/engine/pinyin/`（`VvPinyin` 全端检索）、`crates/engines/{onig,shiki,pele}`（高亮与 `S5` 完整 33 种图谱引擎）、`crates/runtime` 的 `eval` / `OarExtension` / `codemode`（`S3` 明确保留的核心能力，仅可按需评估 Cargo 可选特性减编）、`apps/mac/crates/pixel/`（独立 `opt-level=3` 渲染包）、`library/` 内容寻址表与 `artifact_collab` 双存、`Voice::speak` 与 `feishu.rs` Protobuf 解码。

## Alternatives considered

### 为什么不连同三核架构重构与数据库布局收口一起全做进本批？

三核解耦（`EventBus`、`AgentSession` + `SessionMailbox`、5 域切片 + 删 `/api/v1/state`）与 `crates/server/src/db/{schema,queries,generated}/` 收口本身已经跨全栈全部包与客户端；把 ~15k–75k 行的裁剪、依赖删减与产品线取舍强行混在同一个窗口执行，会放大回归定位难度，也剥夺产品侧对 `S1`–`S6` 的单独拍板机会。因此先落 Note 登记总账，待核心架构稳定后按梯队逐批清理。

### 为什么不直接放着不记 Note？

不记账会在后续开发中反复有人误用已废弃接口（例如 `pi.live`、`Hooks` trait、`Canvas` 旧交互接口），或把已核实保留的刻意设计（例如独立 `pixel` crate、`scenario.rs`）当死代码误删；沉淀为 `proposed` Note 能把已耗费的四路审计事实固定在仓库里。

## Acceptance criteria

- 当任一 `C1`–`C14`、`S1`–`S6` 或 `I1`–`I3` 项进入实施时，对应修改需通过 `vp run release:verify`、`vp run deadcode` 与受影响模块的原生真机 `vv-acceptance`；
- 全部选定项沉淀或否决完毕后，将长期成立的架构不变量并入 `docs/subsystems/*.md` 并按 [Notes 流程](.agents/notes/README.md)删除本 Note。

## Risks

- **文件行号与位置随三核重构漂移**：本 Note 仅绑定模块与文件路径职责，后续逐项开动前应先 `rg` 复核最新调用点；
- **待淘汰旧路径若延迟过久可能继续被新功能挂载**：在 `C1`–`C14` 与 `S2` / `S4` / `S6` 清理落地前，不应继续往已决定淘汰的旧路径（如 `Hooks`、`pkm` 平行栈、Agora / `cloudflared` / Dictation、旧 `presence/*` 拦截）新增功能代码。
