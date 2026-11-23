# Agent Note: Loro 协作内容引擎：四平面边界、实时感知、块内共编与时间旅行

Status: proposed

> [!NOTE]
> **Wave 2 落地状态（核心 Phase A / B / C 已落地并沉淀至 [Artifact 子系统](docs/subsystems/artifact.md)）**
> - **已落地**：`crates/core/src/collab/` Loro 1.18.0 内容平面内核（纯内存 `PresenceHub`、`CollabDoc`、`CommitMeta`、持久 `Cursor` 建议锚点与同 `origin` 折叠、时间旅行 `checkout`/分叉、浅快照压缩、按 `origin` 选择性撤销）；服务端 `crates/server/src/modules/content/artifact/collab.rs` 与 `artifact_collab` 表（零 `presence/*` 落库、`artifact.presence.{update,follow}`、`artifact.history.*`）；原生 `VvWhiteboard` 平滑插值光标/占位框/一键 Follow 与 `onCursorMove`/`onViewportChange`；工作台 `WhiteboardView`、`BlocksView`、`HtmlFrame` 严 CSP 沙箱高亮与 `TimelineBar.tsx`。
> - **尚未落地 / 待定余项**：远端浏览器 / 跨设备 `loro-crdt` WASM/JS 双向同步协议与断线 Version Vector 差量同步；执行会话逐 token 流式写入时的微批事务合批窗口优化；`VvWhiteboard` 进程内本地 Loro 副本直写（当前经进程内桥提交服务端 CRDT Proxy）。

## Problem

当前作品（`Artifact`，见 [Artifact 子系统](docs/subsystems/artifact.md)）的三种存储形态均采用服务端中心化的粗粒度并发控制，在人类与多个执行会话同时编辑时存在四类结构性缺口：

1. **感知状态写放大**：`whiteboard` 通过向 `artifact_entry` 写入 `presence/*` 条目广播光标与占位，每次高频移动都会触发 SQLite 写锁、递增 `artifact.seq` 并写变更日志；`blocks` 与 `html`／`slides`／`design` 沙箱预览则缺少统一的实时在场指示与跟随视口能力。
2. **整块／整条目覆盖冲突**：`blocks` 仅在整块级别以 `baseRev` 判冲突，同一段落内并发改字直接报错并退回为 `conflict` 修订；`store` 仅在整条目级别以 `ifRev` 判乐观锁，并发修改同一白板元素的坐标与样式或同一数据集的不同字段会整批失败。
3. **易碎锚点与无历史回放**：`artifact.html.edit` 依赖选中文本及前后各 32 字的 `HtmlAnchor` 字符串匹配，上游源码微调即锚点失配；`blocks` 的建议（`Suggestion`）绑定整块 `baseRev`，任何同块改动都会使建议作废；作品缺少统一的时间轴回放与按单轮执行会话精准撤销的机制。
4. **嵌套层级缺少安全并发原语**：白板容器编组与大纲块层级移动依赖分数顺序键与应用层校验，多端并发重排或重设父节点容易产生顺序漂移或非法父子环。

## Proposal

引入纯 Rust 实现的 **Loro** CRDT 作为 VibeValley **内容平面专属**的协作引擎，将临时在场感知、文档／画布／网页的字符与属性级并发共编、人类编辑区建议保护以及时间旅行回放收敛到一套内核（`crates/core/src/collab/`）与一致的传输语义上。

### 四平面边界（严守单平面职责）

VibeValley 的状态分为四个职责正交的平面，仅内容平面引入 Loro，其余三个平面不应使用 CRDT：

| 平面 | 负责范围 | 权威引擎与不变量 | 是否引入 Loro |
|---|---|---|---|
| **控制平面（Control Plane）** | 核心状态（`SpaceState`）、任务流转、角色、设置、频道元信息与进程间协调（`Chord`） | `Core::reduce` + SQLite 强事务（[核心状态](docs/subsystems/core.md)），单点校验所有业务不变量 | **严禁** |
| **事件流平面（Stream Plane）** | 执行会话轨迹（`SessionEvent`）、频道消息编号（`number`）、只追加变更日志（`seq`） | Append-only 单调序列，写入后不可变 | **严禁** |
| **代码平面（Code Plane）** | 仓库代码编辑、提交、改动审阅与合入主分支 | Git worktree 与三方合并（[仓库](docs/subsystems/repo.md)） | **严禁** |
| **内容平面（Content Plane）** | 作品（`outline`、`whiteboard`、`blocks`、`html`、`slides`、`dashboard`、`motion`、`design`、`design-system`） | Loro CRDT 容器（`LoroText`、`LoroTree`、`LoroMap`、`LoroList`）+ 内存态 `EphemeralStore` | **唯一允许** |

### 统一内存感知层（`EphemeralStore`）

使用 Loro 的 `EphemeralStore` 承载全部临时在场状态，以固定 TTL 自动过期，**全程驻留内存，不写入 `server.db`，也不递增 `artifact.seq`**，正式淘汰 `presence/*` 数据库条目：

- **原生白板（`VvWhiteboard`，`crates/rich/src/whiteboard.rs`）**：同步人类与执行会话的平滑插值光标、状态气泡（`status`）、区域占位虚线框（`claim`）与当前视口矩形；用户可一键「跟随（Follow）」某个执行会话的视口，画布随其编辑焦点自动平移缩放，手动拖拽立即解除跟随。
- **块文档（`blocks`）**：同步行内流式输入光标与正在改写的选区范围，替代仅到块级的静默等待。
- **沙箱预览（`html`、`slides`、`dashboard`、`design`）**：服务端将 `EphemeralStore` 中的目标选择器／组件区域与作者信息编码为 `HtmlShellCommand` 推入沙箱，由外壳脚本绘制呼吸高亮框与作者徽章；沙箱继续保持无 `allow-same-origin` 与 `connect-src 'none'` 的严格 CSP 隔离。

### 字符级与属性级真共编、服务端 CRDT Proxy 与人类保护边界

将三种作品内容映射到 Loro 原生容器，取代粗粒度锁与字符串锚点：

- **`LoroText`（Fugue 算法）**：存储块文档正文与 `html`／`slides`／`design` 的源码文本，消除整块 `baseRev` 文本冲突与 32 字前后文 `HtmlAnchor` 失配。
- **`LoroTree`（Kleppmann Movable Tree）**：存储白板嵌套容器／编组层级与块文档的大纲父子层级，保证并发拖拽分组与重排无环且可收敛。
- **`LoroMap` / `LoroList`**：存储白板元素几何与样式字段、幻灯片目录、看板参数与设计体系令牌，实现属性级自动合并，淘汰整条目 `ifRev` 覆盖拒绝。
- **Rust 服务端作为 CRDT Proxy**：执行会话与主助手继续调用现有语义化 MCP 工具（`artifact_entry_batch`、`artifact_block_*`、`artifact_html_edit` 等），不直接读写 CRDT 操作码。服务端在边界把每次工具调用转换为单次 Loro 事务，并写入固定格式的提交来源 `origin = "session:<id>:turn:<n>"`（人类本地操作写入 `origin = "user"`）。
- **人类编辑区域保护与持久 `Cursor` 建议**：对人类已写入的块文本或源码片段，执行会话的改写事务不直接覆盖原文本，而是以 Loro 持久化 `Cursor` 锚定起止位置，挂接行内建议（`Suggestion`）。即使用户或另一执行会话在上游插入／删除文本，建议锚点仍随 CRDT 索引精确漂移；用户按 `Tab` 接受或按 `Esc` 拒绝，不再因整块 `baseRev` 变化而整体作废。

### 时间旅行回放与按执行会话选择性撤销

利用 Loro 原生版本图与提交元数据构建统一的历史体验：

- **时间轴拖曳回放（Time Travel Scrub）**：每次提交记录元数据（`author`、`agent`、`session_id`、`turn`、`summary`），通过 `LoroDoc::checkout(frontiers)` 在客户端或服务端瞬时投影任意历史快照。工作台提供时间轴滑块，按作者与执行会话着色分段，支持只读预览、一键恢复到指定版本或从任意历史点分叉（fork）为新作品。
- **浅快照压缩（Shallow Snapshot Compaction）**：对长生命周期作品定期截断过旧操作日志并保留浅快照基线，控制单作品内存占用与冷启动回放延迟。
- **按 `origin` 选择性撤销（Selective Per-Agent Undo）**：通过追踪 `origin = "session:<id>:turn:<n>"` 的变更集，允许用户仅撤销某一个执行会话或其中某一轮的全部修改，同时完整保留人类与其他执行会话在此期间施加的并发编辑。

### 分阶段落地路线

1. **Phase A — 统一感知层与预览高亮**：在服务端建立纯内存 `EphemeralStore` 广播通道并移除 `presence/*` 落库；在 `VvWhiteboard` 实现平滑光标、状态气泡、占位框与一键 Follow 视口；在 `blocks` 实现行内光标，在 `html`／`slides`／`design` 沙箱接入 DOM 呼吸高亮与作者徽章。
2. **Phase B — `crates/core/src/collab/` Loro 内核迁移**：在 `crates/core` 新增 Loro 协作模块，将 `whiteboard`、`blocks`、`html`（及结构化 `store` 作品）的读写切换至 Loro 文档快照与增量更新流；Rust 服务端承担 MCP 语义工具到 `origin` 事务的 CRDT Proxy 翻译；接入基于持久化 `Cursor` 的人类区行内建议；保持 Markdown、`.canvas`、HTML、Store JSON 可读导出以及沙箱 CSP 约束不变。
3. **Phase C — 时间旅行、选择性撤销与多端互通**：上线时间轴滑块（含作者色段、恢复与分叉）、浅快照压缩与按 `session:<id>:turn:<n>` 的选择性撤销；利用官方 `loro-crdt` WASM/JS 绑定预留远端浏览器与跨设备协同协议兼容层。

## Alternatives considered

**选 `Yjs` / `yrs` 代替 Loro**：`yrs` 在 Rust 侧缺少与 Loro 同等的一等 `Movable Tree`（`LoroTree`）原语、原生 `checkout(frontiers)` 时间旅行和浅快照压缩支持，且与 `EphemeralStore` 并非同一套原生 Rust/WASM 协同底座。VibeValley 服务端与原生白板均以 Rust 为单一核心，Loro 的 Rust 原生优先设计与容器集合更贴合白板、块文档与历史回放需求。

**全局引入 CRDT 覆盖控制面、事件流面与代码面**：任务状态机依赖严格转移校验与并发配额，轨迹与消息依赖只追加序号，代码协作依赖 Git 提交图与 CI 检查；在这些平面引入 CRDT 会破坏强不变量并制造不可解释的状态合并。因此将 Loro 严格限定在内容平面。

**继续在现有 `baseRev` / `ifRev` 与 `HtmlAnchor` 上打补丁**：在中心化乐观锁上叠加自定义三方文本合并与字符偏移重算，本质上是在重复造弱化的 OT 引擎，既无法消除 `presence/*` 写放大，也难以支撑树形编组并发与按 `origin` 选择性撤销。

（大纲笔记已收口为 `ArtifactType::Outline`，直接复用了 `LoroTree` + `LoroText` 底座，并通过 `artifact.outline.import` 与 Markdown 导出维持外部 `.md` 互通，独立 `pkm` 平行栈已退役。）

## Acceptance criteria

- **Phase A**：`whiteboard` 不再向 `artifact_entry` 表写入 `presence/*` 记录；多个执行会话并发编辑白板时，客户端渲染平滑光标、状态气泡与占位框，点击 Follow 可持续追踪目标视口且拖拽即退出；`html`／`slides`／`design` 沙箱可在不放宽 CSP 的前提下显示实时区域呼吸高亮与作者徽章。
- **Phase B**：`crates/core/src/collab/` 通过离线并发 fuzz／属性测试，覆盖两个执行会话与人类同时修改同一块文本、同一白板元素不同属性、同一容器树层级及同一 HTML 源码片段，全部无冲突收敛且导出 Markdown / `.canvas` / HTML / Store JSON 字节一致；执行会话对人类编辑区的修改生成带持久化 `Cursor` 的建议，上游编辑后仍能准确 `Tab` 应用或 `Esc` 丢弃。
- **Phase C**：作品详情页可通过时间轴滑块无卡顿预览任意历史前沿并恢复或分叉；对交错写入的「人类 + 会话 A + 会话 B」历史，撤销 `session:A:turn:2` 后仅移除该轮改动，人类与会话 B 的改动完整保留；浅快照压缩后冷启动载入耗时与内存占用保持在预设阈值内。

## Risks

- **二进制快照的可调试性与迁移成本**：Loro 二进制更新流不如明文 JSON 直观。应对方式是在 `crates/core/src/collab/` 提供确定性可读投影导出与 CLI 检查命令（`vibevalley artifact read` / `artifact entry list` 继续返回人类可读形态），并保留从旧表结构一次切入的确定性导入逻辑（按 `AGENTS.md` 不长期保留双写兼容层）。
- **高频更新导致快照膨胀**：执行会话逐 token 流式写入 `LoroText` 若每次都提交独立事务会产生过多元数据。应对方式是在 CRDT Proxy 内按短时间窗口或语义块节流合并事务，并在 Phase C 启用浅快照定期压缩。
- **白板原生渲染与 Loro 树同步延迟**：`VvWhiteboard` 在 GPUI 进程内直接渲染，若每次鼠标拖拽都经 HTTP 往返会掉帧。应对方式是本地交互先施加到进程内 Loro 副本并立即重绘，异步经进程内桥向服务端提交增量更新字节；断线重连后通过版本向量（Version Vector）差量补齐。
- **语义工具与 CRDT 建议的交互歧义**：当执行会话在同一轮连续修改同一人类段落时，多条碎片建议会干扰用户决策。应对方式是 CRDT Proxy 将同一 `origin = "session:<id>:turn:<n>"` 对同一锚区间的连续修改折叠为单条建议再呈交工作台。
