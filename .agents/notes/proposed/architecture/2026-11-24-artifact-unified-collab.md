# Agent Note: 作品目录化存储、统一实时协同引擎与 12 类产品技能体系

Status: proposed

## Problem

现有 Artifact 子系统在服务端并存三套互斥的存储与编辑实现（块文档 `Blocks`、HTML 划词 patcher、SQL-KV 多条目 `Store` `artifact_entry`），并叠加相互重叠的 `ArtifactKind` × `ArtifactBody` × `ArtifactType` 三套分类枚举：

- **三引擎割裂**：`docs`/`outline` 走 `artifact_block` + `artifact_block_revision`（`crates/server/src/content/artifact/blocks.rs` 1,019 行），`html` 走划词字符串替换（`crates/core/src/artifact/html.rs` 903 行），其余 6 类走 SQL-KV 行表 `artifact_entry`（`entries.rs` 998 行）。同一套实时协同、建议与历史能力被迫在三套引擎间写三份适配胶水。
- **碎片化 SQL 存储**：文档块与作品结构文件被拆成零散的 SQL 行与二进制大字段，既不便于以真实目录结构查看、打包与复用资源，也拉高了 SQLite / PostgreSQL 双后端的表数量与查询复杂度。
- **类型覆盖与技能边界不齐**：仅有 8 种产品类型，缺少电子表格（`sheet`）、可运行网页原型（`prototype`）、工程图谱（`diagram`）与分镜脚本（`storyboard`），且 `outline` 等类型缺少完整的 `references/` 分册。

与此同时，**全类型支持多人 + 多 Agent 实时协同编辑是不可妥协的产品不变量**：实时协同同步（CRDT）、在线在场（人与 Agent 光标/聚焦）、按 `origin` 归因的变更历史（预览/恢复/分叉/按来源选择性撤销）与人机评审建议（创建/接受/拒绝）必须完整保留并统一覆盖全部产品类型。

## Proposal

采用**「`storage/` 作品目录 + 统一多人/多 Agent 实时协同层 + 12 类 `ArtifactType` 渐进披露技能」**架构，消除三引擎割裂与碎片 SQL 行存储，随[服务端扁平化与单数架构重构](.agents/notes/proposed/architecture/2026-11-24-first-principles-server-spine.md)在同一 PR（`refactor/server-flat-architecture`）中一步到位直接切换。

### 1. 存储层：每个作品即 `storage/` 托管的真实文件目录

每个 Artifact 是由 `crate::storage::Storage` 统一管理的具体目录 `<storage>/artifact/<artifact_id>/`：

```text
<storage>/artifact/<artifact_id>/
├── manifest.json       # id、artifact_type (ArtifactType)、title、结构入口与索引元数据
├── structure/          # 按 ArtifactType 存放真实结构文件（Markdown / JSON / HTML / CSS / JS / Mermaid 等）
└── asset/              # 归属该作品的图片、音频、视频、CSV、附件与生成媒体（使用 asset/ 相对路径引用）
```

- 结构文件以真实文件存放在 `structure/` 中，不再塞进碎片化的 `artifact_block` 或 SQL-KV `artifact_entry` 行表。
- 不可变版本快照（`artifact_version`）经 `storage_id` 引用 `storage/` 下的作品目录快照，避免大文件与历史版本膨胀 SQL 表。

### 2. 统一多人 + 多 Agent 实时协同层（不可妥协，覆盖全部 12 类）

全部 12 种 `ArtifactType` 共用**同一套**实时协同引擎，支撑多人类与多 Agent 并发编辑同一作品目录：

- **实时协同状态与在线在场（`artifact_collab` + `PresenceHub`）**：统一承载 CRDT / 并发状态同步与人与 Agent 的实时在场（光标、选区、聚焦节点与视口），协同变更无冲突合并后物化同步到 `storage/` 下对应的作品目录文件。
- **按来源归因的变更日志与时间旅行（`artifact_change`）**：记录每次提交的 `origin`（人类用户或具体执行会话），支持 `artifact.history.{list,preview,restore,fork,undoOrigin,compact}`（只读预览、恢复、分叉、浅快照压缩与按 `origin` 选择性撤销）。
- **人机评审建议（`artifact_suggestion`）**：统一支持 `artifact.suggestion.{list,create,accept,reject}`，Agent 修改人类编辑区域时通过建议分流，绝不盲目覆盖并发人类改动。

### 3. 彻底裁剪旧三引擎与重复表（8 表 → 5 表，全仓 38 → 35）

- **消除重叠枚举**：删除 `ArtifactKind` 与 `ArtifactBody`，全链路只保留单一 `ArtifactType`（12 种产品类型）。
- **删除 3 张碎片表与旧引擎代码**：删除 `artifact_block`、`artifact_block_revision` 与 SQL-KV `artifact_entry` 表及实体文件；删除 `crates/server/src/artifact/block.rs` 与 `entry.rs`；删除旧 `Blocks` 引擎与 `Html` 字符串划词 patcher（`crates/core/src/artifact/html.rs` 划词逻辑）；删除 `artifact.block.*`、`artifact.submit`、`artifact.markdown.get`、`artifact.entry.*`、`artifact.entry.follow`、`artifact.html.edit`、`artifact.outline.import` 与频道 `BlockRef` 引用。
- **仅保留 5 张清晰作品表**（严格遵守 `crates/server/src/db/entity/<table_name>.rs` 一表一文件，全仓实体数从 38 降至 35，全部查询经独立顶层 `crates/server/src/service/artifact.rs` / `ctx.service.artifact` 访问）：

| 表与实体文件 | 职责 |
|---|---|
| `artifact`（`crates/server/src/db/entity/artifact.rs`） | 作品元数据：`id`、`title`、`artifact_type`、`version`、`channel_id`、`issue_id`、`message_id`、`is_default`、`created_at`、`updated_at`、`deleted_at` |
| `artifact_version`（`crates/server/src/db/entity/artifact_version.rs`） | 不可变版本快照索引：指向 `storage/` 下的作品目录快照（`storage_id`、`summary`、`author_id`、`message_id`、`created_at`） |
| `artifact_collab`（`crates/server/src/db/entity/artifact_collab.rs`） | 统一 CRDT 实时协同状态快照 |
| `artifact_change`（`crates/server/src/db/entity/artifact_change.rs`） | 按 `origin` 归因的变更日志（支撑历史回放、分叉与按来源撤销） |
| `artifact_suggestion`（`crates/server/src/db/entity/artifact_suggestion.rs`） | 人机协同评审建议（创建、接受与拒绝） |

同目录并列的 `crates/server/src/artifact/library.rs` 与 `crates/server/src/artifact/media/`（`library.*`、`media.*` 端点）完整保留。

### 4. 12 类 `ArtifactType` 目录与按类型渐进披露技能契约

产品类型从 8 类扩展至 **12 类**（全单数 / 规范 kebab-case，与 `ArtifactType::as_str()` 一致）。每一种 `ArtifactType` 在 `crates/server/assets/artifact/types/<type>/` 下拥有独立的渐进披露技能（`SKILL.md` 中文模型指南、`SKILL.en.md` 英文指南与 `references/*.md` 格式/工艺分册），经 `artifact.type.list` 与 `artifact.type.read` 按需加载，规定该类型的目录结构（`manifest.json`、`structure/`、`asset/`）、多人/多 Agent 实时协同规矩与工艺验收标准：

| 类别 | `ArtifactType` | 用途 | 规范目录布局（`<storage>/artifact/<id>/`） |
|---|---|---|---|
| 既有升级（8 类） | `docs` | 技术规格、PRD、RFC 与结构化长文 | `manifest.json` + `structure/*.md` + `asset/` |
| 既有升级 | `outline` | 层级大纲、思维树与工作记录 | `manifest.json` + `structure/outline.json` + `asset/` |
| 既有升级 | `slides` | 演示幻灯片 | `manifest.json` + `structure/deck.json` + `structure/slides/*.json` + `asset/` |
| 既有升级 | `dashboard` | 数据看板与指标面板 | `manifest.json` + `structure/dashboard.json` + `structure/data/*.json` + `asset/` |
| 既有升级 | `motion` | 确定性时间轴短片与动画工程 | `manifest.json` + `structure/timeline.json` + `structure/scenes/*.json` + `asset/{audio,video,image}/` |
| 既有升级 | `whiteboard` | 自由空间画布与视觉白板 | `manifest.json` + `structure/board.json` + `asset/` |
| 既有升级 | `design` | 界面画板与视觉稿（可选关联设计体系） | `manifest.json` + `structure/frames/*.json` + `asset/` |
| 既有升级 | `design-system` | 色彩、字体、间距与组件令牌库（支持全空间 `is_default`） | `manifest.json` + `structure/tokens.json` + `structure/components/*.json` + `asset/` |
| 新增（4 类） | `sheet` | 结构化多表电子表格与数据集 | `manifest.json` + `structure/workbook.json` + `structure/sheets/*.json` + `asset/*.csv` |
| 新增 | `prototype` | 可交互运行的 HTML/CSS/JS 网页原型包 | `manifest.json` + `structure/index.html` + `structure/styles.css` + `structure/app.js` + `asset/` |
| 新增 | `diagram` | 工程图谱（架构拓扑、时序、ER、状态机） | `manifest.json` + `structure/diagram.json` / `.mmd` + `asset/` |
| 新增 | `storyboard` | 分镜头视听制作脚本（衔接媒体生成与 `motion`） | `manifest.json` + `structure/shots.json` + `asset/{frames,refs,audio}/` |

## Alternatives considered

**纯不可变文件包且删除实时协同（零服务端协同引擎）**：虽能再减少 3 张表，但会彻底丧失多人与多 Agent 实时共编、在线光标在场、按 `origin` 选择性撤销与人机建议评审，违背核心产品定位；因此否决。

**保留 `artifact_block` + `artifact_entry` + `Html` 三套旧引擎仅做扁平搬家**：保留三套互不兼容的存储路径与重复接口，新扩 4 类 `ArtifactType`（`sheet`、`prototype`、`diagram`、`storyboard`）仍会受限于 SQL-KV 行表，维护与双后端测试负担成倍放大。

**保留 SQL-KV `artifact_entry` 承载统一协同**：把所有 Markdown、HTML、JSON 与媒体索引塞入关系表行中，无法直接复用 `storage/` 的真实目录组织、内容寻址与快照复用；改为 `storage/` 目录 + 统一 `artifact_collab`/`artifact_change`/`artifact_suggestion` 协同层，职责边界更清晰。

## Acceptance criteria

- `crates/server/src/db/entity/` 仅保留 5 个作品表实体（`artifact.rs`、`artifact_version.rs`、`artifact_collab.rs`、`artifact_change.rs`、`artifact_suggestion.rs`），删除 `artifact_block.rs`、`artifact_block_revision.rs`、`artifact_entry.rs`（全仓实体数 38 → 35）；全部查询经独立顶层 `crates/server/src/service/artifact.rs` 访问。
- 删除 `crates/server/src/artifact/{block,entry}.rs`、旧 `Html` 划词 patcher、`ArtifactKind`、`ArtifactBody`、`BlockRef`、`artifact.block.*`、`artifact.submit`、`artifact.entry.*`、`artifact.entry.follow`、`artifact.html.edit` 与 `artifact.outline.import`。
- 每个作品在 `storage/` 下物化为 `<storage>/artifact/<artifact_id>/{manifest.json,structure/,asset/}`，统一协同层（`artifact_collab`、`artifact_change`、`artifact_suggestion` 与 `PresenceHub`）覆盖全部 12 种 `ArtifactType`，协同变更加锁合并后同步落盘。
- `crates/server/assets/artifact/types/` 包含全部 12 种 `ArtifactType` 的完整 `SKILL.md`、`SKILL.en.md` 与 `references/*.md` 及中英双语 i18n 键。
- 随 `refactor/server-flat-architecture` 通过全仓 Rust、TS、契约、边界审计与文档验证（`make verify`、`vp run mac:check`、`vp run docs:verify`）。

## Risks

- **CRDT 状态与 `storage/` 目录文件物化一致性**：协同合并与落盘须在单作品写序列化边界内原子刷写（写临时文件后重命名），并支持停机恢复时从 `artifact_collab` 重建物化视图，防止半写脏文件。
- **高并发多 Agent 编辑冲突与建议风暴**：多个执行会话同时修改同一文件时，须按 `origin` 归因合并相邻建议并在 `PresenceHub` 广播聚焦区域，避免相互覆盖人类编辑。
- **可运行原型（`prototype`）沙箱安全**：`prototype` 包含可执行 HTML/CSS/JS，客户端预览必须维持严格无 `allow-same-origin`、`connect-src 'none'` 的沙箱隔离，阻断脚本访问宿主接口。
