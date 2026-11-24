# Artifact

Artifact（`Artifact`）是用户、主助手和执行会话共同创作与交付的结构化文档、大纲、演示、看板、白板、原型、表格、工程图谱与视听作品，统一归入 `/library` 内容中心，在 `/artifacts` 详情页与聊天旁栏中实时共编与预览。底层采用单一架构——**`storage/` 托管的作品文件目录 + 统一多人/多 Agent 实时协同层**，彻底消除旧 `Blocks` / `Html` patcher / SQL-KV `artifact_entry` 三引擎割裂与 `ArtifactKind` × `ArtifactBody` 重叠枚举，全链路仅保留 **12 种 `ArtifactType`**，且每一种类型都支持并发多人 + 多 Agent 实时协同编辑。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 作品文件目录（`<storage>/artifact/<artifact_id>/{manifest.json,structure/,asset/}`）、元数据（`artifact`）、不可变版本快照索引（`artifact_version`）、默认设计体系标记（`is_default`）、工单外键关联（`issue_id`）与频道作品卡片投递 | 频道消息路由、卡片回复与唤醒（[频道](docs/subsystems/channel.md)） |
| 统一内容平面实时协同层（覆盖全部 12 类 `ArtifactType`）：`artifact_collab` CRDT 并发同步、`PresenceHub` 纯内存实时在场（人与 Agent 光标/聚焦）、`artifact_change` 按 `origin` 归因变更日志与时间旅行（`artifact.history.*`）、`artifact_suggestion` 人机评审建议（`artifact.suggestion.*`） | 控制平面核心状态（[核心状态](docs/subsystems/core.md)）、事件流平面（[执行会话](docs/subsystems/session.md)）与代码平面（[仓库](docs/subsystems/repo.md)） |
| 12 种 `ArtifactType` 的独立渐进披露双语技能（`crates/server/assets/artifact/types/`、`artifact.type.list`、`artifact.type.read`） | 底层内容寻址对象存储实现（[附件](docs/subsystems/attachment.md)） |
| 在顶层模块 `crates/server/src/artifact/` 下并列维护 `library.*` 与 `media.*` 入口 | 媒体任务与素材库业务细节（[媒体和素材库](docs/subsystems/media.md)）；助手与执行会话提示拼装（[执行会话](docs/subsystems/session.md)、[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/server/src/artifact/` | 顶层扁平模块：`mod.rs`（作品目录生命周期、版本快照、元数据与默认设计体系）、`collab.rs`（统一多人/多 Agent 实时协同层：`PresenceHub`、`CollabDoc` CRDT 并发合并并物化到 `storage/` 作品目录、`artifact_suggestion` 人机建议与 `artifact.history.*` 时间旅行/按 `origin` 选择性撤销）、`types.rs`（嵌入 `crates/server/assets/artifact/types/` 12 种类型的双语 `SKILL.md` / `SKILL.en.md` 与 `references/` 分册）；同目录并列 `library.rs` 与 `media/` |
| `crates/server/src/storage/` | 托管每个作品的实体文件目录 `<storage>/artifact/<artifact_id>/{manifest.json,structure/,asset/}` 与不可变版本目录快照 |
| `crates/server/src/db/entity/` 与 `crates/server/src/service/` | 严格一表一文件，仅 5 张作品表：`artifact.rs`、`artifact_version.rs`、`artifact_collab.rs`、`artifact_change.rs`、`artifact_suggestion.rs`（无 `artifact_block`、`artifact_block_revision` 与 SQL-KV `artifact_entry`）；全部 SeaORM 查询收拢在顶层 `service/` 的 `artifact.rs`（`ArtifactService`，挂于 `ctx.service.artifact`） |
| `crates/core/src/collab/` | Loro 内容平面协同内核：`presence.rs`（纯内存 `PresenceHub`）与 `doc.rs`（`CollabDoc`、`CommitMeta`、持久化游标建议、时间旅行、浅快照压缩与按 `origin` 选择性撤销） |
| `crates/protocol/src/contract/artifact.rs`、`packages/protocol/src/artifact/` | 跨端契约（Rust 为源、生成 TS 形状与端点）：单一 12 类 `ArtifactType`、目录与版本接口、统一协同/在场/建议/历史接口与边界 Zod Schema |
| `apps/mac/ui/features/artifact/`、`apps/mac/ui/features/content/` | 原生应用 nsh TSX 页面：二元内容中心（作品 + 素材）、12 类作品专用视图、实时协作者光标与在场胶囊、建议接受/拒绝交互、`TimelineBar` 时间旅行滑块、`<artifact-view-context>` 上报 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`artifact.*` 及同属 `artifact/` 域的 `library.*`、`media.*`）。

## 模型和不变量

### 目录化存储（`storage/`）与仅 5 张表

- **每个作品即一个 `storage/` 托管目录**：每个 Artifact 在 `storage/` 下对应 `<storage>/artifact/<artifact_id>/`，包含三部分：
  - `manifest.json`：记录 `id`、`artifact_type`（`ArtifactType`）、`title` 与结构入口/索引元数据。
  - `structure/`：按 `ArtifactType` 存放真实结构文件（Markdown、JSON、HTML/CSS/JS、Mermaid 等），不再拆成零散的 SQL `artifact_block` 或 SQL-KV `artifact_entry` 行。
  - `asset/`：归属该作品的图片、音频、视频、CSV、附件与生成媒体，结构文件一律以 `asset/` 相对路径引用。
- **不可变版本快照（`artifact_version`）**：里程碑版本经 `storage_id` 引用 `storage/` 下的作品目录快照；提交新版本只追加 `artifact_version` 并推进 `artifact.version`，绝不覆写历史快照，不把大文件塞进 SQL 行。
- **5 张关系表职责清晰**：数据库仅保存 `artifact`（元数据与 `issue_id` / `is_default` / `deleted_at`）、`artifact_version`（版本快照索引）、`artifact_collab`（CRDT 协同状态）、`artifact_change`（按 `origin` 归因的变更日志）与 `artifact_suggestion`（人机评审建议）。
- **频道投递事务一致**：在频道发布作品卡片时，卡片元数据、版本号与消息引用在同一数据库事务中提交；写入失败则整体回滚，订阅方只看到已提交的卡片。频道消息不再维护 `BlockRef` 块级引用。

### 统一多人 + 多 Agent 实时协同层（不可妥协，覆盖全部 12 类）

- **全类型一致协同**：全部 12 种 `ArtifactType` 运行在同一套实时协同层之上，支持多人类与多 Agent 并发编辑同一作品目录；协同变更经 CRDT 无冲突合并后物化同步至 `storage/` 下的 `manifest.json` 与 `structure/` 文件。
- **纯内存实时在场（`PresenceHub`）**：按 `artifact_id` 维护驻留内存的 `PresenceHub`（带 TTL 过期淘汰），通过 `artifact.presence.update` 与订阅流 `artifact.presence.follow` 实时同步人与 Agent 的光标、选区、聚焦区域与视口，零数据库写入。
- **按 `origin` 归因的变更日志与时间旅行（`artifact_change`、`artifact.history.*`）**：每次协同提交附带 `CommitMeta` 归因（人类用户、具体执行会话或撤销操作），支持历史列表、只读预览、一键恢复、分叉为新作品、浅快照压缩与按 `origin` 选择性撤销（仅撤指定执行会话轮次，保留人类与其他并发会话改动）。
- **人机评审建议（`artifact_suggestion`、`artifact.suggestion.*`）**：Agent 改动人类正在或已经编辑的内容时，通过持久化建议分流（`create` / `accept` / `reject`）并经 `artifact.suggestion.follow` 推送，绝不盲目覆盖并发人类改动。

### 12 种 `ArtifactType` 与独立渐进披露技能契约

全链路取消 `ArtifactKind` 与 `ArtifactBody`，仅保留 12 种 `ArtifactType`（规范单数 / kebab-case）。每一种类型在 `crates/server/assets/artifact/types/<type>/` 拥有独立的渐进披露技能（`SKILL.md`、`SKILL.en.md`、`references/*.md`），由主助手与执行会话按需经 `artifact.type.list` 与 `artifact.type.read` 读取，定义该类型的目录结构、并发协同规矩与工艺标准：

| `ArtifactType` | 用途 | `structure/` 与 `asset/` 约定 |
|---|---|---|
| `docs` | 技术规格、PRD、RFC 与结构化长文 | `"structure/*.md"` + `asset/` |
| `outline` | 层级大纲、思维树与工作记录 | `"structure/outline.json"` + `asset/` |
| `slides` | 演示幻灯片 | `"structure/deck.json"` + `"structure/slides/*.json"` + `asset/` |
| `dashboard` | 数据看板与指标面板 | `"structure/dashboard.json"` + `"structure/data/*.json"` + `asset/` |
| `motion` | 确定性时间轴短片与动画工程 | `"structure/timeline.json"` + `"structure/scenes/*.json"` + `asset/{audio,video,image}/` |
| `whiteboard` | 自由空间画布与视觉白板（原生 `VvWhiteboard`） | `"structure/board.json"` + `asset/` |
| `design` | 界面画板与视觉稿（可选关联设计体系） | `"structure/frames/*.json"` + `asset/` |
| `design-system` | 色彩、字体、间距与组件令牌库（支持全空间 `is_default`） | `"structure/tokens.json"` + `"structure/components/*.json"` + `asset/` |
| `sheet` | 结构化多表电子表格与数据集 | `"structure/workbook.json"` + `"structure/sheets/*.json"` + `"asset/*.csv"` |
| `prototype` | 可交互运行的 HTML/CSS/JS 网页原型包（严格无 `allow-same-origin` 沙箱预览） | `"structure/index.html"` + `"structure/styles.css"` + `"structure/app.js"` + `asset/` |
| `diagram` | 工程图谱（架构拓扑、时序、ER、状态机） | `"structure/diagram.json"` / `.mmd` + `asset/` |
| `storyboard` | 分镜头视听制作脚本（衔接媒体生成与 `motion`） | `"structure/shots.json"` + `asset/{frames,refs,audio}/` |

- **全空间默认设计体系（`is_default`）**：同一时刻至多一个 `artifact_type = 'design-system'` 标为 `is_default = true`，供 `slides`、`dashboard`、`design`、`prototype` 预览时注入默认主题令牌。
- **当前视图上下文（`<artifact-view-context>`）**：工作台在对话发消息时附带当前查看位置（页码、数据集、选中元素、画板或播放秒数），让主助手与执行会话直接定位修改目标。

## 怎么走

**多人与多 Agent 共创一份作品**

1. 主助手或执行会话调 `artifact_type_read` 读取目标 `ArtifactType` 的技能指南与目录规范。
2. 调用 `artifact_create` 创建作品：服务端在 `storage/` 下初始化 `<storage>/artifact/<artifact_id>/{manifest.json,structure/,asset/}`，经 `ctx.service.artifact` 写入元数据、`artifact_collab` 与初始版本快照，按需在频道或工单话题投递作品卡片。
3. 人类与多个 Agent 通过统一实时协同层并发编辑同一作品目录：在场光标经 `artifact.presence.follow` 实时呈现，协同变更无冲突合并后同步落盘到 `storage/` 目录文件，冲突的人类编辑区域经 `artifact_suggestion` 评审分流。
4. 用户可随时通过 `artifact.history.*` 预览历史、按 `origin` 选择性撤销某次 Agent 改动，或通过 `artifact.version.create` 固化不可变目录快照。

## 和谁打交道

- **统一存储（`storage/`）**：托管每个作品的文件目录与版本快照。
- **顶层数据服务（`service/`）**：经 `ctx.service.artifact`（`ArtifactService`）读写 5 张作品表，业务域零 `sea_orm::` 与 `db::entity` 导入。
- **频道（`channel/`）**：发布作品卡片并记录 `channel_id` / `message_id` 与 `<artifact-view-context>`；无 `BlockRef` 块引用。
- **工单（`issue/`）**：通过 `issue_id` 外键关联工单，工单删除时自动置空。
- **工具与主助手（`agent/`）**：通过 `agent/` 的 `tool/` 暴露作品创建、目录与协同编辑、建议、历史与类型指南工具（`artifact_type_list`、`artifact_type_read` 等），自动绑定会话工单与角色身份。
- **媒体库与媒体任务（`library`、`media/`）**：与作品模块共驻 `crates/server/src/artifact/`，继续独立维护 `library.*` 与 `media.*` 端点（[媒体和素材库](docs/subsystems/media.md)）。

## 为什么这样

- **目录化文件存储 + 单一协同层取代三套割裂引擎**：删去 `artifact_block`、`artifact_block_revision`、SQL-KV `artifact_entry` 与旧 `Html` 字符串 patcher 后，12 种类型全部落到真实目录结构与同一套 CRDT/在场/建议/历史引擎上，既保留不可妥协的多人/多 Agent 实时协同，又大幅削减重复代码与表结构。
- **单一 `ArtifactType` 与独立渐进披露技能**：移除 `ArtifactKind` × `ArtifactBody` 正交冗余，12 种产品类型各自维护清晰的目录规范与工艺技能，按需加载不挤占常驻上下文。
- **不可信脚本一律运行在无同源权限沙箱内**：`prototype`、`slides`、`dashboard`、`motion`、`design` 等可执行视图在 `sandbox`（无 `allow-same-origin`、`connect-src 'none'`）中渲染，彻底隔离宿主接口。

## 还没做的

- 作品目录化存储、统一实时协同引擎与 12 类产品技能直接切换：[作品目录化存储、统一实时协同引擎与 12 类产品技能体系](.agents/notes/proposed/architecture/2026-11-24-artifact-unified-collab.md)。
- Loro 远端浏览器 WASM/JS 双向同步与流式 token 微批事务合并等演进：[Loro 协作内容引擎：四平面边界、实时感知、块内共编与时间旅行](.agents/notes/proposed/architecture/2026-11-22-loro-collaborative-content-engine.md)。

## 怎么验证

- `crates/core/tests/collab_loro.rs`：内容平面实时协同单测与并发收敛测试（Ephemeral TTL、并发修改收敛、持久游标建议、时间旅行、浅快照压缩与按 `origin` 选择性撤销）。
- `crates/server/tests/artifact.rs`：作品目录创建与物化、版本快照、5 张表持久化、12 种 `ArtifactType` 双语技能读取、实时在场、人机建议与按 `origin` 选择性撤销，以及 `issue_id` 置空外键测试。
- `crates/server/tests/mcp.rs`：主助手与执行会话经 `/mcp` 调用作品工具并发共编。
- `apps/mac/ui/features/artifact/` 页面测试：二元内容中心、实时在场与建议交互、`TimelineBar` 时间旅行（`nsh/test`）。

演讲者视图在 HTML 发回页数后显示页码、下一页与备注。尚未收到回执时，页面显示「等待演示页就绪」。载入错误显示具体原因（[原生页面验收](.agents/skills/vv-acceptance/references/app.md#演示页的就绪回执)）。
