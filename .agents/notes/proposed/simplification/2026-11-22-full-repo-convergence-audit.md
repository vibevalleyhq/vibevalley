# Agent Note: 全仓收敛审计清单（C1–C14 与 S1–S6 待选收敛项）

Status: proposed

## Problem

在完成去 `watch` 化、领域无关 `AgentSession` 与全局 `SpaceState` 切片拆解这三条主线架构重构之外，全仓约 43.5 万行手写代码中仍积累了不少扩张期遗留：未接线子系统、重复基础设施、双源契约与测试脚手架混入发布包、线上隐形存储/CPU 泄漏，以及若干低调但真实的产品缺陷（例如错写的清单文件名与内存假持久）。

按照「先把三核架构与数据库布局拆干净，再按拍板逐批收敛」的节奏，需要把这批收敛项完整沉淀为单一账本，避免后续重复排查或误删已受保护的刻意设计。

## Proposal

将剩余全仓收敛机会拆为两档挂账：**第一梯队（`C1`–`C14`）**为低争议清理与缺陷修复，**第二梯队（`S1`–`S6`）**涉及产品边界或依赖取舍，待后续逐项拍板后独立实施。

### 第一梯队：零争议收敛与缺陷修复（`C1`–`C14`）

1. **`C1`（`crates/runtime` 零消费者 `pi.live` 每 token 刷盘与 `Axum` WebSocket 冗余特性）**：`chord_space` 与 `/chord/ws` 已纳入 `SpaceState` 切片重构并随之删除；在此之后，建议继续移除 [live.rs](crates/runtime/src/agent/durable/storage/live.rs)、[sqlite.rs](crates/runtime/src/agent/durable/storage/sqlite.rs) 中无生产消费者的 `put_deferred`/`pi.live` 延迟刷盘线程与 `Core::engine` 逐 token 序列化（实际流式 delta 已走内存观察器），并移除 `crates/server/Cargo.toml` 上不再使用的 `axum/ws` 特性。
2. **`C2`（削掉 `packages/protocol/` ~4.8k 行死 Zod 镜像与重复 RPC 壳）**：仅 ~5.6% 导出的 Zod Schema 在生产边界（SSE 与 iframe `postMessage`）执行运行时校验，其余经桥返回的数据在 [client.ts](packages/protocol/src/client.ts) 直接跳过解码，却把全部 `*/api.ts` 与 schema 对象树打入工作台包。后续应直接由 [typescript.rs](crates/protocol/tests/typescript.rs) 从 Rust 契约生成瘦 `VibeValleyApi` 与 `BizCode`，删净 19 份手写 `*/api.ts` 与死 Result Schema，仅保留真正跨边界输入的少数解码器。
3. **`C3`（删除 `crates/rich/` 已被白板取代的死交互 Canvas 引擎与 `hooks.rs`）**：[原生白板](apps/mac/ui/features/artifact/WhiteboardView.tsx)已接管交互编辑，[canvas.rs](crates/rich/src/canvas.rs) 只用静态 SVG 渲染。迁出 `svg.rs` 依赖的 25 行标签矩形辅助后，删除 [ops.rs](crates/rich/src/engine/canvas/ops.rs)、[hit.rs](crates/rich/src/engine/canvas/hit.rs) 交互命中、[geometry.rs](crates/rich/src/engine/canvas/geometry.rs) 交互几何、两份对应测试及 0 生产调用的 [hooks.rs](crates/rich/src/hooks.rs)（约 3k 行）。
4. **`C4`（`apps/mac` 壳层重复打包与像素场景死路径清理）**：从主入口 [App.tsx](apps/mac/ui/App.tsx) 剥离仅属于 [ShellApp.tsx](apps/mac/ui/ShellApp.tsx) 的 workspace 面板包体（避免 ~4.7k 行打入主工作台包）；移除 0 调用 `Action`、`host.*` 音频旧桥与 `hostApi.*` 包装、已退役的 `CatalogScene`（[catalog.rs](apps/mac/src/pixel/catalog.rs)）、旧着色素描路径与仅服务 headless 测试的前端兜底壳。
5. **`C5`（`crates/runtime/` 与 `team/memory/` 清除 5 处线上隐形泄漏及死扩展/兼容兜底）**：停写无人读取的 `gov.evaluated_permissions`、`abort_trace`、`CoreState::records` 空消费者累积、`Transcript::prefix_hash` 每轮全量 SHA-256 及无预算下的空转写事务（[engine.rs](crates/runtime/src/agent/core/engine.rs) / [budget.rs](crates/runtime/src/agent/extensions/budget.rs)）；清理 0 调用 `TodoExtension`、`FileMemory`、`ConversationHandle`、`SharedExecution` 与 `memory.terms` 冗余分词列及 4 处旧 TS/Go 兼容兜底。
6. **`C6`（统一 `media` 与 `library` 公网下载及 `Moss` 客户端）**：删去平行 [image_provider.rs](crates/server/src/modules/content/media/image_provider.rs)、每图重起 Tokio 运行时的 `until_stopped` 与冗余测试缝 `OfflineImages`，在 [http.rs](crates/server/src/modules/infra/http.rs) 提取单一绑定 DNS 验证的 `PublicDownload` 并收拢 [library](crates/server/src/modules/content/library/mod.rs) 与媒体下载。
7. **`C7`（修复 `collab/connector/` 每请求自建 Tokio/Client 与 50Hz/200Hz 忙轮询）**：让 [adapter.rs](crates/server/src/modules/collab/connector/adapter.rs) 与 [bridge.rs](crates/server/src/modules/collab/connector/bridge.rs) 复用 `infra/http` 运行时与共享连接池，以 `Notify`/`watch` 替换 5 ms/20 ms 睡眠轮询，提取共用飞书/QQ Token 缓存。
8. **`C8`（修复 `pyrepo.toml` 错字与 `defineStored` 重启丢失偏好缺陷）**：修正 [repo.rs](crates/server/src/modules/work/repo.rs) 把 `"pyproject.toml"` 误写成 `"pyrepo.toml"` 的缺陷；把 [polyfill.ts](apps/mac/ui/infra/polyfill.ts) 中基于内存 `Map` 的伪 `localStorage` 与 [stored.ts](apps/mac/ui/infra/state/stored.ts) 接入持久化 KV，并在 `host.info` 补齐主题状态回读。
9. **`C9`（清理 `crates/core` 死导出与废止的 `patrol` / 每帧冗余文案）**：移除不再运行的 [patrol.rs](crates/core/src/patrol.rs) 与 [inbox.rs](crates/core/src/inbox.rs) 丢弃型 `brief::*` 每帧构造；清理 `crates/core` 与 `collab/channel` 的 0 调用导出与重复纯函数。
10. **`C10`（清理 `work` 域冗余订阅与 `ServerConfig` 测试缝）**：移除 `Ledger::subscribe`/`Board::record_pull_request` 旧路径，统一复用 `base::RequestKeys`、`ModuleDb` 与定时 ticker，收拢散落的测试配置项。
11. **`C11`（收敛内容中心 UI 分裂与 `artifact/collab.rs` 重复锁/兼容清洗）**：消除内容中心侧栏计数口径分歧、删除冗余搜索弹窗 [Search.tsx](apps/mac/ui/features/pkm/Search.tsx) 与 `frame.ts` 死分支；整合 [collab.rs](crates/server/src/modules/content/artifact/collab.rs) 重复锁分发与 `entries.rs` 历史重清洗。
12. **`C12`（`crates/cli` 与 `workspace` 零星去重与死导出清理）**：抽取 `crates/cli` 共用入口消除 `vibevalley_eval` 粘贴，清理零星仅测导出。
13. **`C13`（运行时支持矩阵单源化与失效的 `spent_today` 决断）**：让 [presets.rs](crates/server/src/modules/team/agent/presets.rs) 与 [oar/mod.rs](crates/runtime/src/oar/mod.rs) 共享单一能力真源（去掉过时 `"dsh"` 预设与漂移字段），明确补齐 `spent_today` 统计或移除无效每日限额。
14. **`C14`（边界 `serde_json::Value` 强类型收口）**：将媒体厂商应答、`gh`/`glab` CLI 输出、MCP 工具入参与 OAR 驱动 JSON 解析在进门处一次性解码为 `Deserialize` 结构体（[media/vendor.rs](crates/server/src/modules/content/media/vendor.rs)、[publish.rs](crates/server/src/modules/work/pull/publish.rs)、[claude.rs](crates/runtime/src/oar/claude.rs)）。

### 第二梯队：待决策战略级裁剪（`S1`–`S6`）

| 编号 | 所在与体量 | 核心事实 | 备选方案 |
| :--- | :--- | :--- | :--- |
| `S1` | `crates/rich` `genui` + `chart`（~19k 行） | 提示词与技能零引用，`onGenUiAction` 未接线 | 全删 / 仅删 `genui` 留 `chart` / 全留并补接线 |
| `S2` | `pkm` 平行栈 vs `ArtifactType::Outline`（~7.7k 行） | [pkm.md](docs/subsystems/pkm.md) 现仍独立维护，而主工作台默认指向大纲作品 | 补 `.md` 导入后退役 `pkm` / 保留仓库并只清 8 个死接口 |
| `S3` | `crates/runtime` `eval` + `OarExtension` + `codemode`（~7.6k 行 + 6 重型依赖） | 生产只跑 `SqliteStorage`，未挂载扩展却全量编译 `rquickjs` 与 5 个 `oxc_*` crate | 彻底删除 / 收拢进 Cargo `eval` 可选特性 |
| `S4` | `collab/voice/` Agora + `cloudflared` + Dictation（~2.1k 行） | 原生端当前仅走 MOSS Live（[live_voice.rs](apps/mac/src/live_voice.rs)） | 全删未使用语音通道 / 仅收紧内部测试缝 |
| `S5` | `crates/engines/pele` 33 种图谱（约 3.5–4 万行小众图） | 仅 [diagram.rs](crates/rich/src/diagram.rs) 调用，含大量小众非标图 | 裁剪为常用标准 Mermaid 图谱集 / 保持完整引擎 |
| `S6` | `artifact/collab.rs` 旧 `presence/*` 拦截与 `blocks::demo`（~330 行） | 网页已走强类型接口，仅缺 helper MCP 专用工具 | 补工具删旧拦截并裁撤演示脚本 / 仅先结构化旧解析 |

### 核实保留基线（不得误删）

以下模块虽在单层检索中看似低引用，经子系统文档与跨端检索已核实为核心资产或刻意优化：`crates/core/src/scenario.rs`（`scenarios` 门控测试夹具）、`crates/rich/src/engine/pinyin/`（`VvPinyin` 全端检索）、`crates/engines/{onig,shiki}`（高亮）、`apps/mac/crates/pixel/`（独立 `opt-level=3` 渲染包）、`library/` 内容寻址表与 `artifact_collab` 双存、`Voice::speak` 与 `feishu.rs` Protobuf 解码。

## Alternatives considered

### 为什么不连同三核架构重构与数据库布局收口一起全做进本批？

三核解耦（`EventBus`、`AgentSession` + `SessionMailbox`、5 域切片 + 删 `/api/v1/state`）与 `crates/server/src/db/{queries,generated}/` 收口本身已经跨全栈全部包与客户端；把 ~15k–75k 行的裁剪、依赖删减与产品线取舍强行混在同一个窗口执行，会放大回归定位难度，也剥夺产品侧对 `S1`–`S6` 的单独拍板机会。因此先落 Note 登记总账，待核心架构稳定后按梯队逐批清理。

### 为什么不直接放着不记 Note？

不记账会在后续开发中反复有人误用已废弃接口（例如 `pi.live`、`Hooks` trait、`Canvas` 旧交互接口），或把已核实保留的刻意设计（例如独立 `pixel` crate、`scenario.rs`）当死代码误删；沉淀为 `proposed` Note 能把已耗费的四路审计事实固定在仓库里。

## Acceptance criteria

- 当任一 `C1`–`C14` 或 `S1`–`S6` 项进入实施时，对应修改需通过 `vp run release:verify`、`vp run deadcode` 与受影响模块的原生真机 `vv-acceptance`；
- 全部选定项沉淀或否决完毕后，将长期成立的架构不变量并入 `docs/subsystems/*.md` 并按 [Notes 流程](.agents/notes/README.md)删除本 Note。

## Risks

- **文件行号与位置随三核重构漂移**：本 Note 仅绑定模块与文件路径职责，后续逐项开动前应先 `rg` 复核最新调用点；
- **`S1`–`S6` 若延迟过久可能继续被新功能挂载**：在明确决策前应避免继续往未接入生产路径（如 `Hooks`、`genui`、`OarExtension`）新增功能代码。
