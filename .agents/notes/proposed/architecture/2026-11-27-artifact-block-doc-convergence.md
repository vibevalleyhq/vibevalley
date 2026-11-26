# Agent Note: 作品类型收敛与 Block Rich Doc 统一内容模型（#31）

Status: proposed

## Problem

当前 Artifact 子系统在 [docs/subsystems/artifact.md](docs/subsystems/artifact.md) 与 [crates/protocol/src/contract/artifact.rs](crates/protocol/src/contract/artifact.rs) 中定义了 **12 种独立 `ArtifactType`**（`docs`、`outline`、`slides`、`dashboard`、`motion`、`whiteboard`、`design`、`design-system`、`sheet`、`prototype`、`diagram`、`storyboard`），存在两类结构性摩擦：

1. **核心原语过碎、横切维护成本高**：每新增一种垂直用途都需要在 `crates/protocol/src/contract/artifact.rs`、`crates/core/src/artifact/`、`crates/server/assets/artifact/types/` 与 `apps/mac/ui/features/artifact/views/` 同步维护独立目录规范与专用视图，但它们底层已统一收敛在 `storage/` 目录与 `CollabDoc`（[crates/core/src/collab/doc.rs](crates/core/src/collab/doc.rs)）之上。
2. **垂直场景强耦合导致不可混排**：用户在撰写技术方案、复盘报告或设计评审时，往往需要在同一份作品里混排结构化长文、可折叠大纲、`<Compare>` 前后视觉对比、KPI 指标与 `VvChart` 图表、Mermaid/Pele 架构图、嵌入多维数据表视图、音视频演示与实时关联的工单卡片。现有 `docs` 仅能以原始 Markdown 文本加 JSON 围栏块勉强承载，缺少块级 CRDT 标识、块级在场锚点与可组合的交互块原语。

与此同时，[作品目录化存储、统一实时协同引擎与 12 类产品技能体系](.agents/notes/proposed/architecture/2026-11-24-artifact-unified-collab.md) 已完成去三引擎割裂并确立了 **「`storage/` 作品目录 + Loro CRDT + 5 张作品表」** 基座。本提案在此基座上将 12 种 `ArtifactType` 收敛为 **5 个高内聚核心原语**，**绝不回退到旧 SQL 行表 `artifact_block` / `artifact_block_revision` 或 SQL-KV `artifact_entry`**。

## Proposal

将全链路 `ArtifactType` 从 12 种收敛为 **5 个核心原语**，以 Notion 式的 **Block Rich Doc（`doc`）** 作为统一叙事与组合主载体；将具体行业/体裁模板、版式约束与写作工艺全部下沉为按需加载的 **SEP-2640 MCP Skills（`skill://artifact/*`）**。

### 1. 12 类 `ArtifactType` 向 5 个核心原语收敛映射

| 原 `ArtifactType`（12 类） | 收敛后核心原语（5 类） | 承载机制与产品形态 |
|---|---|---|
| `docs` | `doc`（Block Rich Doc） | 块级富文档主形态：支持分层章节、Markdown/富文本块、代码、数学公式与全类型内嵌块 |
| `outline` | `doc`（Block Rich Doc） | `LoroTree` 块树原生支持无限缩进、`toggle` 折叠与节点聚焦（zoom），无需拆出独立 `outline` 类型 |
| `slides` | `doc`（Block Rich Doc） | 由 `slideSection` / `pageBreak` 块或演示视图投影驱动，直接复用双窗演讲者模式（`PresenterPage`） |
| `dashboard` | `doc`（Block Rich Doc） | 由多列布局块、`kpi` 块、`chart` 块与 `baseEmbed` 查询视图组合而成，数据源归口 `base` 或内联数据集 |
| `diagram` | `doc`（Block Rich Doc） | 作为 `doc` 内一等 `diagram` 块（`VvDiagram` / Mermaid / Pele）存在，支持图文混排与块内协同 |
| `design-system` | `doc`（Block Rich Doc） | 由 `tokens` 结构块、组件色板/字阶样本块及 `manifest.json` 的 `isDefault` 标记承载，供 `app`/`canvas`/`doc` 继承 |
| `whiteboard` | `canvas`（Spatial Canvas） | 原生 `VvWhiteboard`（[crates/rich/src/whiteboard.rs](crates/rich/src/whiteboard.rs)）无限空间画布、连线、贴纸与分区容器 |
| `design` | `canvas`（Spatial Canvas） | 在 `canvas` 中以多画板（Artboard/Frame）容器 + 关联默认 `design-system` 令牌 + 右侧 `props` 控制面板承载 |
| `sheet` | `base`（Multidimensional Base） | 升级为多维结构化数据表（详见 [多维结构化数据表 Base 与 Agent 批量执行列架构（#32）](.agents/notes/proposed/architecture/2026-11-27-multidimensional-base-table.md)），并可经 `baseEmbed` 块嵌入 `doc` |
| `prototype` | `app`（Interactive App / Sandbox） | 独立 HTML/CSS/JS 可交互原型包，保留严格无 `allow-same-origin`、`connect-src 'none'` 隔离沙箱（[PrototypeView.tsx](apps/mac/ui/features/artifact/views/PrototypeView.tsx)），亦可被 `doc` 通过 `appEmbed` 预览引用 |
| `motion`、`storyboard` | `media`（Media / AV Asset） | 统一承载确定性时间轴短片（`timeline.json`）、分镜脚本（`shots.json`）、多轨音视频素材与直出流播放，衔接 [媒体与素材库](docs/subsystems/media.md) |

说明：按照根目录规矩「内部不留兼容」，枚举收窄随对应实现 PR 直接切换 `ArtifactType`（`doc | canvas | base | app | media`）；对历史导出包仅在导入入口提供一次性结构转换器，不在核心运行态保留双套枚举与双套 UI 视图。

### 2. Block Rich Doc（`doc`）核心块原语表

`doc` 内的每个块拥有稳定 `blockId`（对应 Loro `TreeID` 映射键）与强类型 `BlockSpec`（Rust enum + Zod Codec 单源生成），由 `crates/rich/` 原生组件与工作台组件渲染：

| 块类型 `kind` | 底层渲染与数据载体 | 核心能力与协作语义 |
|---|---|---|
| `heading` / `paragraph` / `bulletList` / `numberedList` / `todo` / `toggle` / `quote` / `callout` | `LoroTree` 节点 + `texts[blockId]`（`LoroText`） | 字符级 Fugue CRDT 共编、任意缩进与折叠聚焦（absorbs `outline`）、`TextRangeAnchor` 划词建议 |
| `code` / `math` | `VvCodeBlock`（`vibevalley-shiki`） / `math` | 语法高亮、行号折叠、大块异步离线程渲染（遵守 `crates/rich` 并发规矩） |
| `compare` | [Compare.tsx](apps/mac/ui/design/Compare.tsx) + [compareModel.ts](apps/mac/ui/design/compareModel.ts) | 前后双图滑块/并排对比、坐标批注（`issue`/`fixed`/`note`），图片路径直接引用 `asset/` |
| `chart` / `kpi` | `VvChart`（`vibevalley-chart`） | 原生矢量图表与指标卡，支持内联数据集或绑定 `base` 视图聚合查询 |
| `media` | 原生图像/音频/视频播放器 + `asset/` 或 `media_library_item` | 展示单图、语音试听、视频播放与字幕摘要，支持灯箱全屏预览 |
| `baseEmbed` | `baseArtifactId` + `viewId` + 局部 `filterOverride` | 在文档正文内实时内嵌多维表 `Base` 的 `Grid`/`Kanban`/`Gallery`/`Timeline`/`Calendar` 视图，共享实时增量流 |
| `diagram` | `VvDiagram`（Mermaid / Pele） | 架构拓扑、时序图、ER 图、状态机源码或结构图实时渲染与节点点击事件 |
| `appEmbed` / `genui` | `VvGenUi`（声明式试算器）或受隔离沙箱预览 `app` 作品 | 安全展示交互组件与小工具，不暴露宿主上下文 |
| `issueCard` | `issueId`（只存外键，实时投影自 `SpaceState`） | 嵌入活体工单卡片，直接呈现工单状态、阶段、负责人与一键验收/派活入口 |
| `slideBreak` / `columns` | 结构容器与分页符块 | 支持单栏/多栏看板排版（absorbs `dashboard`）与一键切换演讲者全屏视图（absorbs `slides`） |

### 3. 目录化存储与 Loro CRDT 容器映射

保留 `<storage>/artifact/<artifact_id>/` 目录模型（[crates/server/src/storage/artifact.rs](crates/server/src/storage/artifact.rs)）与 5 张数据库表（`artifact`、`artifact_version`、`artifact_collab`、`artifact_change`、`artifact_suggestion`），**不新增 `artifact_block` 等 SQL 行表**：

```text
<storage>/artifact/<artifact_id>/
├── manifest.json          # id、artifactType: "doc"、title、skills（关联的配方技能）、isDefault、version
├── structure/
│   ├── doc.loro           # Loro CRDT 二进制快照（与 DB artifact_collab 保持单作品写锁原子同步）
│   ├── index.md           # 确定性物化的可读 Markdown/Block-Fence 投影（供全文检索、单文件导出与 git diff）
│   └── tokens.json        # 可选：当作为默认设计体系（design-system 配方）时存放明暗令牌供其他作品读取
└── asset/                 # 本作品独占图片、音频、视频与附件（按 asset/<name> 引用）
```

CRDT 容器直接复用并收口到 [crates/core/src/collab/doc.rs](crates/core/src/collab/doc.rs) 既有的 5 个根容器：

1. **`tree`（`LoroTree` + `enable_fractional_index(0)`）**：维护文档块树层级、顺序、缩进父子关系与无环拖拽移动（`tree_move_after` / `tree_move_before`）。
2. **`entries`（`LoroMap` of `LoroMap`）**：以 `blockId` 为键保存每个块的强类型属性（`kind`、`props`、`collapsed`、`layout` 等），实现同块不同属性的并发无冲突合并。
3. **`texts`（`LoroMap` of `LoroText`）**：为每个含富文本/代码/源码的块按 `blockId` 分配独立 `LoroText`，支持人与多执行会话在同一块或不同块上并发键入与 `TextRangeAnchor` 持久化游标锚定。
4. **原子双写与确定性物化**：服务端 `collab.rs`（[crates/server/src/artifact/collab.rs](crates/server/src/artifact/collab.rs)）在单作品写序列化边界内提交 Loro 事务后，原子刷写 `artifact_collab`（SQLite/PostgreSQL）、`structure/doc.loro` 与确定性投影 `structure/index.md`；停机恢复时以 `artifact_collab` / `doc.loro` 为真源重建物化文件。

### 4. 人与多 Agent 并发块编辑、在场与评审机制

- **块级实时在场（`PresenceHub`）**：复用 [crates/core/src/collab/presence.rs](crates/core/src/collab/presence.rs) 的 `PresenceKind::BlockCursor` 与 `block_id` / `offset` / `end_offset` 字段，纯内存（带 TTL）广播人类与各执行会话当前聚焦的 `blockId` 与字符选区；UI 在对应块左侧槽位渲染彩色协作者头像与「正在编辑」呼吸条，绝不污染 `doc.loro`。
- **按 `origin` 归因与块级选择性撤销**：每次块增删改移均写入 `CommitMeta`（`user` / `session:<sid>:turn:<turn>` / `agent:<id>`），支持在左侧或右侧 `HistoryPanel` 按执行会话轮次预览 diff，并调用 `artifact.history.undoOrigin` 仅撤销特定 Agent 轮次的块改动，保留人类及其他会话的并发修订。
- **块级与片段级人机建议（`artifact_suggestion`）**：Agent 对人类刚编辑或标定保护的块发起修改时，通过 `artifact_suggestion` 创建结构化建议（支持 `text_splice` 划词替换与 `block_patch` 块属性/整块替换/插入/移动），经 `artifact.suggestion.follow` 在对应块下方内联呈现接受/拒绝卡片。

### 5. 垂直领域模板与写作规范下沉为 SEP-2640 MCP Skills

借助已独立的 [vibevalley-mcp](.agents/notes/proposed/architecture/2026-11-26-vibevalley-mcp-crate.md)（[crates/mcp/src/skills.rs](crates/mcp/src/skills.rs) 与 [crates/server/src/agent/mcp/mod.rs](crates/server/src/agent/mcp/mod.rs)），将「领域体裁」与「核心数据结构」彻底解耦：

- **5 个核心原语技能**：`skill://artifact/doc`、`skill://artifact/canvas`、`skill://artifact/base`、`skill://artifact/app`、`skill://artifact/media`，规定每种原语的存储布局、CRDT 操作规矩与沙箱安全红线。
- **按需加载的垂直配方技能**：原 `docs`、`outline`、`slides`、`dashboard`、`design`、`design-system`、`diagram`、`storyboard` 等体裁沉淀为 `skill://artifact/prd`、`skill://artifact/rfc`、`skill://artifact/slides-deck`、`skill://artifact/dashboard-report`、`skill://artifact/design-system`、`skill://artifact/diagram-arch`、`skill://artifact/storyboard-film` 等配方技能（存放在 `crates/server/assets/artifact/skills/`，经 `skills/list` 与 `skills/get` 按需渐进披露）。主助手与外部编码 agent（Antigravity、Claude Code、Codex）根据用户意图读取对应配方后，直接用统一的 `doc`/`canvas`/`base`/`app`/`media` 块工具拼装作品，不再因新增一种报告体裁而修改 Rust 协议与前端路由。
- **语义化块级 MCP 工具扩展**：在保留 `artifact_create`、`artifact_file_*` 的基础上，为 `doc` 补充低 Token 消耗的语义化块工具：`artifact_doc_outline`（仅读块树骨架与 `blockId`）、`artifact_block_upsert`、`artifact_block_move`、`artifact_block_delete` 与 `artifact_block_suggest`，避免执行会话为改一段话而全量读写 `index.md`。

## Alternatives considered

### Why not keep all 12 `ArtifactType`s and only enrich `docs` with more fenced JSON?

保留 12 套枚举与 12 套独立前端视图会持续成倍放大 `crates/protocol`、`crates/server/src/artifact/` 与 `apps/mac/ui/features/artifact/views/` 的维护成本，且用户仍无法在 `docs`、`outline`、`slides`、`dashboard` 之间平滑切换或混排。将叙事与结构展示体裁收口进 `doc` 块模型，并用 `skill://artifact/*` 承载领域写法，能从根源消除横向碎片。

### Why not restore SQL row-level `artifact_block` / `artifact_block_revision` tables?

如 [作品目录化存储、统一实时协同引擎与 12 类产品技能体系](.agents/notes/proposed/architecture/2026-11-24-artifact-unified-collab.md) 所论证，SQL 行表拆块会导致 SQLite/PostgreSQL 双后端查询与锁竞争复杂化、无法复用 Loro 字符级/树级 CRDT 与 Version Vector 增量同步，也破坏单目录快照与 `storage/` 的统一边界。以 `structure/doc.loro` + `artifact_collab` 作为唯一协同真源、`structure/index.md` 作为确定性可读投影，兼顾实时并发与可读可移植性。

### Why not collapse everything into 1 single `doc` type (eliminating `canvas`, `base`, `app`, `media`)?

无限自由空间画布（`canvas` / `VvWhiteboard`）、强类型关系型多维表（`base`）、需要严格无 `allow-same-origin` 隔离的可执行网页沙箱（`app`）与音视频时间轴直出流（`media`）在交互物理、安全沙箱边界与计算模型上与线性块文档存在本质差异。保留 **5 个核心原语** 并允许 `doc` 通过 `baseEmbed` / `appEmbed` / `media` 块组合引用它们，既保证内聚性，又不丢失专有视图能力与安全隔离。

## Acceptance criteria

- `crates/protocol/src/contract/artifact.rs` 中的 `ArtifactType` 收敛为 `doc | canvas | base | app | media` 5 类，并定义强类型 `DocBlock` / `BlockKind` 联合与 `BaseEmbedRef` / `IssueCardRef` 契约，TS 生成物与 Zod 校验同步通过 `cargo xtask protocol --check` 与 `vp run packages:check`。
- `crates/core/src/collab/doc.rs` 完整支持块树与块内 `LoroText` 的增删改移、持久化 `Cursor` 建议锚定、按 `origin` 选择性撤销以及 `doc.loro` 到 `structure/index.md` 的确定性物化往返测试（`crates/core/tests/collab_loro.rs`）。
- `crates/server/src/artifact/` 在保持 5 张作品表与 `storage/` 目录约束下提供语义化块工具（`artifact_doc_outline`、`artifact_block_upsert`/`move`/`delete`/`suggest`），并经 `crates/mcp` 以 SEP-2640 `skill://artifact/*` 暴露 5 类原语技能与垂直配方技能（`crates/server/tests/artifact.rs` 与 `mcp.rs` 通过）。
- `apps/mac/ui/features/artifact/` 交付统一 Block Rich Doc 编辑器与阅读态，支持 `/` 块插入、拖拽重排、多人/多 Agent 块级在场光标、内联建议卡片、`Compare`/`Chart`/`Diagram`/`BaseEmbed`/`IssueCard`/`Media` 块渲染及 `PresenterPage` 演示模式切换，通过 `vp run mac:check` 与 VDP 真实截图验收。

## Risks

- **大文档块树与物化同步开销**：若单篇 `doc` 含数千个块且每次按键均全量生成 `structure/index.md`，会放大 I/O 与延迟。缓解：沿用 [Loro 协作内容引擎：远端同步、流式合批与白板本地副本](.agents/notes/proposed/architecture/2026-11-22-loro-collaborative-content-engine.md) 的同 `origin` 微批合并窗口，对 `index.md` 采用防抖/脏标记增量刷新，并在历史超长时自动触发 `compact_shallow_snapshot`。
- **内嵌块跨实体订阅扇出（`baseEmbed` / `issueCard`）**：一篇文档嵌入多个 `base` 视图或大量工单卡片时可能产生过多监听。缓解：文档视图复用 `StateFeed` 既有 `board` 切片投影工单卡片，对 `baseEmbed` 合并按 `baseArtifactId` 去重订阅。
- **可执行块与沙箱边界回归**：将 `prototype` 并入 `app` 与 `doc` 内 `appEmbed` 时，绝不可放宽 `sandbox` 隔离。缓解：由共享 `SandboxFrame` 组件统一强制无 `allow-same-origin` 与 `connect-src 'none'`，并纳入 UI 单元测试与 `cargo xtask audit` 边界检查。
