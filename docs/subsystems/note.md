# Note

Note（`Note`）是 VibeValley 统一的知识、块级文档与多维数据工作台子系统，将原 12 类 `ArtifactType` 收敛为 **3+1 规范原语（`doc`、`base`、`canvas`、`media`）**，以 `<storage>/note/<id>/` 目录化存储、6 张关系表与 Loro CRDT 实时协同层为唯一底座，连接 Block Doc 写作、多维数据库 Base、`PageTree` 树形组织、`note_link` 双向图谱以及与 `Issue`、`Channel` 的 PKM + GTD 双向闭环。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 3+1 原语目录生命周期（`<storage>/note/<id>/{manifest.json,structure/,asset/}`）、不可变快照（`<storage>/note_snapshot/<id>/<storage_id>/`）、派生预览 `.preview.json` 与外部封面 `.cover-<seq>-<ts>.<ext>` | 底层 `StorageBackend` 对象镜像与通用附件表实现（[附件](docs/subsystems/attachment.md)） |
| 6 张关系表契约（`note`、`note_version`、`note_collab`、`note_change`、`note_suggestion`、`note_link`）与 `PageTree` 父子排序树 | 核心控制平面 6 路切片与 `Outbox`（[核心状态](docs/subsystems/core.md)） |
| 统一 Loro 1.18.0 CRDT 协同同步（`note.collab.*`）、纯内存实时在场（`PresenceHub`）、按 `origin` 归因审计/选择性撤销（`note.history.*`）与人机评审建议分流（`note_suggestion`） | 会话轨迹与工作区 Git worktree（[执行会话](docs/subsystems/session.md)、[仓库](docs/subsystems/repo.md)） |
| 24 块 `BlockKind` 结构化文档内核（`crates/core/src/note/doc.rs`）、Markdown 往返、Presenter 演示切分与交互规范 | 原生 GPUI/WKWebView 窗口宿主外壳（[客户端](docs/subsystems/app.md)） |
| 多维数据库 Base 内核（12 种 `BaseColumnKind`、4 种 `BaseViewKind`、Row=Page 关联 `page_note_id`、安全公式求值与 `agentAction` 批量派工） | 工单状态机与自动派活调度细节（[工单](docs/subsystems/issue.md)） |
| `note_link` N:M 双向图谱提取与查询、`NoteType` SEP-2640 渐进披露技能（`skill://note/*`）及 `vv_note_*` / `vv_doc_*` / `vv_base_*` 工具端口 | 频道消息投递与路由（[频道](docs/subsystems/channel.md)）、主助手提示词装配（[助手](docs/subsystems/orchestrator.md)） |
| 顶层 `crates/server/src/note/` 下并列维护 `library` 与 `media/` 入口 | 媒体生成任务机与素材库细则（[媒体和素材库](docs/subsystems/media.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/protocol/src/contract/note.rs`、`crates/protocol/src/contract/endpoints/note.rs` | 跨端强类型契约与 TS 生成源：`NoteType`、24 种 `BlockKind`、`DocView`、12 种 `BaseColumnKind` / 4 种 `BaseViewKind`、`NoteLink`、协同/在场/建议/历史消息与 33 个 `note.*` RPC + 3 条 SSE 订阅（`note.follow`、`note.suggestion.follow`、`note.presence.follow`） |
| `packages/protocol/src/note/schema.ts`、`packages/protocol/src/note/api.ts` | 前端边界 Zod Codec（`satisfies Codec<T.*>`）与强类型接口定义 |
| `crates/core/src/note/mod.rs`、`crates/core/src/note/doc.rs`、`crates/core/src/note/base.rs`、`crates/core/src/note/links.rs`、`crates/core/src/note/manifest.rs`、`crates/core/src/note/path.rs`、`crates/core/src/note/preview.rs`、`crates/core/src/note/starter.rs` | 纯领域内核：路径与大小护栏、Manifest 编解码、4 原语骨架初始化、24 块 `Doc` 解析/投影/Markdown 往返、Base 过滤/排序/分组/汇总/公式/提示词投影、`[[note:...]]`/`[[issue:...]]`/`#N` 链接解析与轻量 `NotePreview` 提取 |
| `crates/core/src/collab/doc.rs`、`crates/core/src/collab/presence.rs` | Loro 内容平面协同内核：`CollabDoc`（`texts`/`tree`/`entries`/`lists`）、`CommitMeta`、`TextRangeAnchor` 持久游标、浅快照压缩、按 `origin` 选择性撤销与 `PresenceHub`（`EphemeralStore`） |
| `crates/server/src/note/mod.rs`、`crates/server/src/note/manager.rs`、`crates/server/src/note/collab.rs`、`crates/server/src/note/doc.rs`、`crates/server/src/note/base.rs`、`crates/server/src/note/types.rs` | 服务端领域协调器 `Manager`：`OriginWriteBatcher` 微批合并、目录与 Loro 快照双同步、人类触碰路径检测与 `Suggestion` 自动分流、Doc/Base 视图投影与 Agent 列任务准备、嵌入式技能读取 |
| `crates/server/src/router.rs`、`crates/server/src/router/note.rs`、`crates/server/src/storage/note.rs` | 编译期穷尽路由分发、`note.base.runAgentColumn` 跨 `issue` 派工协调、`NoteStorage` 原子落盘/快照/预览缓存/封面存储 |
| `crates/server/src/db/entity/note.rs`、`crates/server/src/db/entity/note_version.rs`、`crates/server/src/db/entity/note_collab.rs`、`crates/server/src/db/entity/note_change.rs`、`crates/server/src/db/entity/note_suggestion.rs`、`crates/server/src/db/entity/note_link.rs`、`crates/server/src/service/note.rs` | 一表一文件实体定义、迁移 `crates/server/src/db/migration/m20261128_100001_replace_artifact_with_note.rs` 与统一数据服务 `NoteService`（`ctx.service.note`） |
| `crates/server/src/agent/tool/content.rs`、`crates/server/src/agent/mcp/mode.rs`、`crates/cli/src/domains/content/note.rs`、`crates/cli/src/domains/mcp/note.rs`、`crates/cli/src/domains/mcp/note_defs.rs`、`crates/mcp/src/skills.rs` | 进程内 Agent 工具、按运行模式收窄的只读/写权限过滤、CLI `vibevalley note ...` 子命令、MCP `vv_note_*` / `vv_doc_*` / `vv_base_*` 工具与 SEP-2640 `skill://note/*` 目录 |
| `crates/server/assets/note/types/`、`crates/rich/src/whiteboard.rs` | 4 种 `NoteType` 中英双语 `SKILL.md` / `SKILL.en.md` 与 `references/`；原生 `VvWhiteboard` 嵌入 `CollabDoc` |
| `apps/mac/ui/features/note/`（含 `hub/` 与 `hub/seeds/`） | 工作台 `/notes`、`/library`、`ContentShell`、`PageTree` 侧栏、24 块编辑器、Base 四视图、Row=Page 侧边抽屉、Presenter Mode、Backlinks 与 Channel 晋升弹窗 |

全部接口与调用方权限见 [capabilities.md](docs/reference/capabilities.md)（`note.*` 及同域 `library.*`、`media.*`）。

## 模型和不变量

### 1. 3+1 统一原语与 Notion 工程架构映射

`Note` 将原先碎片化的 12 种产物收敛为 **3+1 正交原语（`NoteType`）**，全链路不再保留 `ArtifactKind × ArtifactBody` 双层枚举：

| `NoteType` | 定位 | 入口文件 | 默认目录 | 导出后缀 | 收敛覆盖的原类型与能力 |
|---|---|---|---|---|---|
| `doc` | 结构化块级协作文档 | `"structure/doc.json"` | `structure`、`asset` | `.md` | 原 `docs`、`outline`、`slides`（经 `pageBreak`）、`dashboard`（经 `kpi` + `chart`）、`diagram`（经 `diagram`）、`prototype`（经 `preview` 沙箱块） |
| `base` | 多维结构化数据库与 Agent 流水线 | `"structure/base.json"` | `structure`、`asset` | `.base.json` | 原 `sheet` 与结构化台账；支持多表、四视图、公式列、Row=Page 与 `agentAction` |
| `canvas` | 自由空间画布、白板与设计稿 | `"structure/board.json"` | `structure`、`asset` | `.canvas.json` | 原 `whiteboard`、`design`、`design-system`（`VvWhiteboard` 原生画布） |
| `media` | 多媒体资产与时间轴/转写工程 | `"structure/media.json"` | `structure`、`asset`、`asset/{audio,video,image}` | `.media.json` | 原 `motion`、`storyboard`、录音转写与生成媒体合集 |

> 约束：入口文件与相对结构路径由 `crates/protocol/src/contract/note.rs` 的 `type_spec()` 单源声明；任意 `manifest.json` 的 `entry` 必须位于 `structure/` 下，且 `note_type` 仅允许 `doc | base | canvas | media`。

VibeValley 借鉴 Notion 工程体系的核心设计，并按本机 Rust 优先架构完成落地映射：

| Notion 工程原语 | VibeValley Note 落地实现 | 核心不变量 |
|---|---|---|
| **Block 数据模型** | `DocDocument { version: 1, blocks: Vec<DocBlock> }` 与封闭 24 元 `BlockKind` 联合（`#[serde(tag = "type")]`） | 每个块持有稳定 `id`、可选 `collapsed` 与嵌套 `children`；文本解析、word/slide 计数与链接提取全部在 Rust `crates/core/src/note/doc.rs` 完成，TS 不自解析 Markdown |
| **Collection / DataSource vs View 解耦** | `BaseSheet`（`id`、`name`、`columns`、`rows`）与 `BaseViewConfig`（`id`、`name`、`kind`、`group_by`、`hidden_columns`、`filters`、`sorts`、`summaries`）正交分离 | 同一份 `BaseSheet` 数据源可同时投影为 `table`、`board`、`gallery`、`timeline` 四个视图；切换或新增视图不复制行数据 |
| **Row = Page** | `BaseRow` 携带 `page_note_id: Option<NoteId>`，指向同空间的 `NoteType::Doc` 子笔记 | 每行既是一条结构化属性记录，也可关联一份完整 24 块 `doc` 页面；侧边 Peek 抽屉同时读写行属性与子页面正文 |
| **禁止动态 SQL DDL** | 不为用户的每张表执行 `CREATE TABLE` / `ALTER TABLE`；模式与数据统一编码为类型化 `BaseSheet` JSON 存于 `"structure/base.json"` | 新增/重命名/删改列永远是一次文件协同写入与版本号推进，无 Schema 迁移锁表与 SQL 注入面 |
| **本地 Rust 查询与公式引擎（替代 WASM SQLite）** | `project_base_view`（`crates/core/src/note/base.rs`）直接在 Rust 内存完成过滤、排序、分组、聚合与公式求值 | 不在客户端引入 WASM SQLite 缓存层与双写同步；桌面端、移动端与 MCP/CLI 共享完全一致的 `BaseViewSnapshot` |
| **细粒度 CRDT + 人机防护** | `CollabDoc`（Loro 1.18.0）+ `OriginWriteBatcher` + `note_change` + `note_suggestion` + `PresenceHub` | 多人多 Agent 并发写自动无冲突合并；所有写入附带 `origin` 支持选择性撤销；Agent 触碰人类编辑区域时自动分流为审阅建议 |

---

### 2. 存储目录契约与 6 张关系表

#### 2.1 目录化存储（`<home>/note/<id>/`）

每个 `Note` 在 `NoteStorage`（`crates/server/src/storage/note.rs`）下独占一个目录，镜像可插拔 `StorageBackend`：

```text
<home>/
├── note/<note_id>/
│   ├── manifest.json                   # NoteManifest：schemaVersion=1、id、noteType、title、entry、files[]、meta{}
│   ├── structure/                      # 结构化主入口与辅助文件（上限 2 MiB/文件）
│   │   ├── doc.json | base.json | board.json | media.json
│   │   └── ...
│   ├── asset/                          # 图片、音频、视频、CSV 等二进制资源（上限 32 MiB/文件）
│   ├── .preview.json                   # 派生预览缓存（schemaVersion=1, seq, NotePreview）
│   ├── .cover.json                     # 派生封面元数据（StoredCoverMeta，不入 manifest/CRDT）
│   └── .cover-<seq>-<ts>.<ext>         # 派生自动缩略图（image/png|jpeg|webp，上限 2 MiB）
└── note_snapshot/<note_id>/<storage_id>/
                                        # 不可变历史版本目录快照（note.version.create 时全量拷贝）
```

存储与路径安全不变量：

1. **三区白名单与防逃逸**：`validate_note_path` 仅放行 `manifest.json`、`structure/<rel>`、`asset/<rel>`，拒绝空段 `//`、`.`、`..`、反斜杠、控制字符、盘符前缀及超过 `PATH_MAX_LEN`（240 UTF-16 码元）的路径；`validate_deletable_path` 禁止删除 `manifest.json`。
2. **体量上限**：单笔记目录最多 `FILE_MAX_COUNT`（500）个文件；`manifest.json` 与 `structure/` 单文件上限 `STRUCTURE_FILE_MAX_BYTES`（2 MiB）；`asset/` 单文件上限 `ASSET_FILE_MAX_BYTES`（32 MiB）；笔记标题长度上限 `TITLE_MAX_LEN`（200 UTF-16 码元）。
3. **JSON 规范化与合并**：所有 `.json` 写入前必经 `canonical_json` 校验合法 UTF-8 JSON；`vv_note_patch` 与 `SuggestionChange.patch` 严格按 RFC 7396 `apply_json_merge_patch` 合并。
4. **乐观并发校验**：`NoteFileWriteItem.expected_hash`（SHA-256 十六进制串，`""` 表示要求文件尚不存在）不匹配时立即以 `BizCode::NoteRefused` 拒绝写入。
5. **原子写与派生隔离**：所有写入通过临时文件 `.tmp-<uuid_v7>` 刷盘后 `rename` 原子替换；`.preview.json` 与 `.cover-*` 以 `.` 开头，不进入 `manifest.files`、`CollabDoc` 与 `note_snapshot`，写入封面（`note.cover.set` / `POST /api/v1/note/{id}/cover`）不递增 `seq` 与 `version`。

#### 2.2 6 张数据库表契约

数据库由 `crates/server/src/db/entity/note*.rs`（严格一表一文件）定义，仅经 `crates/server/src/service/note.rs`（`ctx.service.note`）访问：

| 表名 | 主键 | 关键列与约束 | 索引 / 外键 | 用途 |
|---|---|---|---|---|
| `note` | `id` | `title`、`note_type`（`CHECK IN ('doc','base','canvas','media')`）、`parent_id`、`sort_order`、`channel_id`、`message_id`、`issue`、`by_id`、`by_name`、`version`、`seq`、`created_at`、`updated_at` | `FOREIGN KEY (issue) REFERENCES issue(id) ON DELETE SET NULL`；索引 `note_by_parent(parent_id, sort_order, updated_at)`、`note_by_channel`、`note_by_issue`、`note_by_type` | 笔记元数据、`PageTree` 层级与排序、单调协同序号 `seq` |
| `note_version` | `(note_id, version)` | `storage_id`、`size`、`note`、`by_id`、`by_name`、`message_id`、`created_at` | `FOREIGN KEY (note_id) REFERENCES note(id) ON DELETE CASCADE` | 不可变里程碑快照索引，只追加不覆写 |
| `note_collab` | `note_id` | `snapshot`（`BLOB`）、`updated_at` | `FOREIGN KEY (note_id) REFERENCES note(id) ON DELETE CASCADE` | Loro `CollabDoc` 二进制完整快照持久化真源 |
| `note_change` | `(note_id, seq)` | `kind`（`CHECK IN ('files')`）、`batch_id`（`UNIQUE`，存 Loro `Frontiers` base64）、`actor`、`targets`（修改路径 JSON）、`payload`（删除路径 JSON）、`created_at` | `FOREIGN KEY (note_id) REFERENCES note(id) ON DELETE CASCADE`；索引 `note_change_by_created` | `note.follow` 断线重连增量回放日志（超过 256 条下发 `NoteEvent::Reset`） |
| `note_suggestion` | `id` | `note_id`、`path`、`author`、`origin`、`at_rev`、`base_hash`、`change`（`SuggestionChange` JSON）、`cursor_start`、`cursor_end`、`start_offset`、`end_offset`、`status`（`CHECK IN ('open','accepted','rejected')`）、`created_at`、`resolved_at`、`resolved_by` | `FOREIGN KEY (note_id) REFERENCES note(id) ON DELETE CASCADE`；索引 `note_suggestion_by_note(note_id, created_at)` | 人机评审建议与持久 Loro `Cursor` 锚点 |
| `note_link` | `id` | `source_kind`（`note \| issue`）、`source_id`、`target_kind`（`note \| issue`）、`target_id`、`relation`（`link \| embed`）、`title`、`created_at` | 索引 `note_link_by_source(source_kind, source_id)`、`note_link_by_target(target_kind, target_id)` | N:M 跨 `Note` / `Issue` 出链与反向引用图 |

---

### 3. 统一 Loro CRDT 协同、在场与审阅防覆盖

1. **五容器 `CollabDoc` 结构（`crates/core/src/collab/doc.rs`）**：
   - `"texts"`（`LoroMap<LoroText>`）：按文件相对路径（或文本块键）维护字符级 Fugue CRDT，`text_update_diff` 以最小字符 diff 更新，保留并发位置上的其他协作者编辑。
   - `"tree"`（`LoroTree`，启用 `enable_fractional_index(0)`）：无环可移动树，供块树/白板嵌套分组使用。
   - `"entries"`（`LoroMap<LoroMap>`）：属性级并发合并容器；资产文件存入 `"__vvAssetSha256:<sha256>"` 哨兵标记而不把大二进制塞入 CRDT。
   - `"lists"`（`LoroMap<LoroList>`）与 `"entry_meta"`（`LoroMap`）：有序列表与路径 MIME 元数据。
   - 每次提交均把 `CommitMeta`（`author`、`agent`、`session_id`、`turn`、`origin`、`summary`、`at`）序列化进 Loro `commit_msg`，保证重启后 `origin` 不丢失。
2. **每笔记异步锁与按 `origin` 微批合并**：
   - `Manager::note_lock(note_id)` 串行化同一笔记的 CRDT 合并、物化落盘与 DB 事务。
   - 不携带 `expected_hash` 且 `announce = false` 的流式写入进入 `OriginWriteBatcher`，按 `(note_id, origin)` 严格隔离分桶（默认窗口 `25 ms`、单桶上限 `64` 次写入），绝不跨 `origin` 合并，确保后续 `note.history.undoOrigin` 精确剥离单一来源。
3. **版本向量双向增量同步**：
   - `note.collab.export` 接受可选 `version_vector`（base64）；当未传或客户端落后于浅快照压缩根 `shallow_since_vv` 时自动回退为 `snapshot: true` 全量导出，否则返回最小增量 `update`。
   - `note.collab.import` 导入客户端 Loro 字节流，重投影文件树并在与磁盘有差异时以原子事务推进 `seq`、物化目录、重算 `note_link` 并广播 `NoteEvent::Files`，同时可返回客户端缺失的 `server_update`。
4. **纯内存实时在场（`PresenceHub`）**：
   - 按 `note_id` 维护 `PresenceRoom`，底层使用 `loro::awareness::EphemeralStore`（默认 `DEFAULT_PRESENCE_TTL_MS = 30_000` ms），永不写 SQLite 也不推进 `note.seq`。
   - 携带单调毫秒时间戳补偿（`mutate_with_monotonic_clock`），防止同毫秒高频移动光标或注销墓碑帧被 Loro 静默丢弃；支持 `cursor`、`selection`、`highlight`、`viewport` 四种 `NotePresenceKind` 及 `node_id` / `offset` / `end_offset` / `selector` / `ViewportRect`。
   - `presence_highlight_script()` 为沙箱预览框注入 strict-CSP 安全的呼吸边框与作者徽标。
5. **人机协同防覆盖（`note_suggestion`）**：
   - 若历史 `note_change` 记录表明目标路径曾由人类（`actor == "user"`，且非 `manifest.json`）编辑，非人类发起的 `note.file.write`（文本文件）自动被拦截分流为 `SuggestionStatus::Open` 建议并通过 `note.suggestion.follow` 推送给用户，绝不静默覆盖人类内容。
   - 文本范围建议通过 `CollabDoc::anchor_text_range` 生成不随前文增删漂移的 `cursor_start` / `cursor_end`；用户调用 `note.suggestion.accept` 时按锚定范围或 `base_hash` 校验后原子合入文档并提交 Loro。
6. **时间旅行与选择性撤销（`note.history.*`）**：
   - `list` 倒序返回带 `CommitMeta` 与 `frontiers` 的提交线；`preview` 在目标 frontiers 无副作用检出只读快照；`restore` 将历史状态作为一次新提交恢复；`fork` 在指定 frontiers 克隆出独立新笔记；`undoOrigin` 逆向撤销指定 `origin`（例如 `session:<id>:turn:<n>`）的改动而完整保留人类与并发会话内容；`compact` 执行浅快照压缩并同步 `note_collab`。

---

### 4. 完整 24 块 Doc 规范与编辑交互标准

#### 4.1 `DocDocument` 与 24 种 `BlockKind` 契约

`"structure/doc.json"` 存储 `DocDocument { version: 1, blocks: Vec<DocBlock> }`，每个 `DocBlock` 包含 `id: String`、扁平化的 `BlockKind`（`#[serde(tag = "type")]`）、可选 `collapsed: Option<bool>` 与递归 `children: Option<Vec<DocBlock>>`。`project_doc_view` 统一计算 `slide_count`（`pageBreak` 计数 `+ 1`）、`word_count` 与 `extracted_links`。

全部 24 种 `BlockKind` 按编辑器斜杠分组规范如下：

| 分组 | `type` | 协议字段（camelCase） | Markdown 往返 / 链接提取 / 渲染约定 |
|---|---|---|---|
| **Basic** | `prose` | `text` | 普通段落；提取 `[[note:...]]`、`[[issue:...]]`、`#N`；支持行内富文本标记与自动补全 |
| **Basic** | `heading` | `level`（`1..=3`）, `text` | `#` / `##` / `###`；提取出链；供 `toc` 与 `NotePreview.Doc.outline` 收集目录大纲 |
| **Basic** | `list` | `ordered`, `items: string[]` | `- ` / `1. `；逐项提取出链；支持 `Tab` / `Shift+Tab` 嵌套缩进进 `children` |
| **Basic** | `todo` | `checked`, `text` | `- [ ] ` / `- [x] `；提取出链；收集至 `NotePreview.Doc.outline`（`kind: "todo"`） |
| **Basic** | `quote` | `text`, `attribution?` | `> ...` + 末行 `> — <attribution>` 往返；提取 `text` 内出链；左侧 `3px` 暖线引导 |
| **Basic** | `divider` | 无 | `---` / `***`；全宽 `1px` `border-line` 水平分隔线 |
| **Structure** | `toggle` | `title`, `text` | `<details><summary>title</summary>...</details>` 往返；支持 `collapsed` 折叠态，展开显示 `text` 与 `children`；提取 `title` 与 `text` 出链 |
| **Structure** | `callout` | `tone`, `title?`, `text` | `tone` 映射 `info \| ok \| warn \| bad` 语义底色与图标框；提取 `title` 与 `text` 出链 |
| **Structure** | `code` | `language?`, `code` | 围栏代码块 ```` ```lang ````；不从代码体内提取链接；调用原生 `VvCodeBlock` 语法高亮与一键复制 |
| **Structure** | `table` | `headers`, `rows: string[][]`, `alignments?` | GFM 管道表（支持 `:---` / `:---:` / `---:` 对齐）；提取表头与全部单元格出链；支持行列增删与内联编辑 |
| **Structure** | `bookmark` | `url`, `title?`, `description?` | 富链接卡片 `[title](url) — description`；展示域名徽标、标题与摘要，点击经宿主 `external` 打开 |
| **Structure** | `toc` | `maxLevel?` | `<!-- toc -->` 占位序列化；由同文档 `heading` 块动态投影锚点跳转目录（默认 `1..=3` 级），不落盘冗余目录文本 |
| **Structure** | `math` | `expression`, `display?` | 块级 `$$\n...\n$$` 或行内 `$...$`；交由 `crates/rich` 原生数学排版引擎（`TextViewMath`）渲染公式 |
| **Structure** | `columns` | `columns: DocColumn[]` | 多栏容器（每栏含 `blocks: DocBlock[]`）；支持 2–4 栏等分或可调列宽；递归投影字数与链接 |
| **Structure** | `pageBreak` | `title?`, `speakerNotes?` | 幻灯片分页边界；每新增 1 个使 `slide_count + 1`，在 Presenter Mode 中渲染为独立幻灯片标题与底部讲稿 |
| **Data & VV** | `kpi` | `items: DocKpiItem[]` | 指标卡片组（`label`、`value`、`delta?`、`tone?`）；数字使用 `tabular-nums` 等宽对齐 |
| **Data & VV** | `chart` | `title?`, `kind`, `labels`, `series` | 结构化多序列图表（`series: { name, data }[]`），由 `crates/rich` 原生 `vv_chart` 渲染 |
| **Data & VV** | `diagram` | `title?`, `source` | Mermaid 工程图谱（````` ```mermaid ````` 往返），由 `crates/rich` 原生 `vv_diagram` 渲染 |
| **Data & VV** | `compare` | `title?`, `beforeLabel`, `afterLabel`, `beforeAsset`, `afterAsset` | 前后视觉对比卡，引用 `"asset/"` 相对路径图片，支持滑杆/并排对比 |
| **Data & VV** | `media` | `mediaKind`, `src`, `caption?` | 图片/音频/视频块，优先引用 `"asset/"` 相对路径或附件 URL，支持 Lightbox 放大 |
| **Data & VV** | `preview` | `entry`, `height?`, `title?` | 可交互原型预览块，指向 `"structure/"` 下 HTML 入口，渲染于**无 `allow-same-origin`、`connect-src 'none'` 严格沙箱**内 |
| **Data & VV** | `baseEmbed` | `noteId`, `sheetId?`, `viewId?` | 内嵌一个 `NoteType::Base` 实时视图；自动向 `note_link` 写入 `LinkRelation::Embed` 边 |
| **Data & VV** | `issueCard` | `issueId` | 内嵌单张工单实时状态卡片；自动向 `note_link` 写入 `LinkRelation::Embed` 边 |
| **Data & VV** | `issueList` | `repo?`, `status?`, `tag?`, `limit?` | 动态嵌入工单筛选列表，只读投影 `BoardSlice` 实时状态 |

#### 4.2 编辑器交互规范

为保证写作手感与结构化操作零抖动，前端编辑器在 `apps/mac/ui/features/note/` 遵守以下硬约束：

1. **分类 `/` 斜杠命令菜单**：
   - 在块首或空格后键入 `/` 弹出锚定浮层（`z-20 bg-elevated border-line shadow-float`），按 `Basic`、`Structure & Media`、`VibeValley` 3 类分组展示全部 24 种块（含 `Icon`、中文标题、简短提示与输入快捷键如 `#`、`>`、`$$`）。
   - 支持拼音/英文/别名实时过滤，`ArrowUp`/`ArrowDown` 移动高亮，`Enter` 插入或就地转换当前空块并剥离 `/query` 文本，`Esc` 关闭浮层并保留原字符。
2. **`[[` Wikilink 与 `#` 工单自动补全**：
   - 输入 `[[` 触发跨实体浮层搜索（合并 `note.list` 笔记与 `BoardSlice` 工单），选中后插入 `[[note:<id>|<title>]]` 或 `[[issue:<id>|<title>]]`；输入 `![[` 可直接插入 `BaseEmbed` 或 `IssueCard` 嵌入块。
   - 输入 `#` 后接数字或关键词触发工单快选，生成 `#<number>` 行内可点击状态胶囊。
3. **Markdown 即时输入规则**：
   - 在 `prose` 块行首输入以下前缀并敲 `Space`（或直接匹配围栏）立即就地转为目标 `BlockKind`：`# ` / `## ` / `### ` → `heading(1..3)`；`- ` / `* ` → `list(ordered: false)`；`1. ` → `list(ordered: true)`；`- [ ] ` / `- [x] ` → `todo`；`> ` → `quote`；`---` → `divider`；```` ```<lang> ```` → `code`（或 `mermaid` 时转为 `diagram`）；`$$` → `math(display: true)`。
   - 空白块按 `Backspace` 自动退化回 `prose` 或与前块合并；遵循 `outlineEditor.ts` 的稳定几何网格与同构盒模型（阅读态与编辑态共享 `1px` `border-transparent` 占位与一致行高，杜绝点击跳动）。
4. **块悬停槽（Block Gutter）、`Turn Into` 与排序**：
   - 鼠标悬停在块行时，左侧固定宽度槽位显现 `+`（在下方插入块）与 `⋮⋮` 6 点手柄（不挤占正文宽度）。
   - 点击 `⋮⋮` 打开块菜单：支持 `Turn Into`（在文本兼容块 `prose` / `heading` / `list` / `todo` / `quote` / `toggle` / `callout` 之间无损转换 `text`）、`Move Up` / `Move Down`（快捷键 `Alt+ArrowUp` / `Alt+ArrowDown`）、`Duplicate`、`Copy Block Link` 与 `Delete`；支持拖拽至块上下热区排序或拖至块左右边缘自动包裹为 `columns` 并排分栏。
5. **Presenter Mode（全屏演讲者模式）**：
   - 从顶部工具栏「演示」进入全屏演示视图（隐藏工作台全局 `Rail` 与笔记侧栏，参考 `PresenterPage` 布局）：以 `PageBreak` 块切分页面，提供当前页主画布、下一张缩略预览、底部 `speakerNotes` 演讲备注、`ArrowRight`/`PageDown`/`ArrowLeft`/`Esc` 键盘翻页以及双主题切换与就绪回执检测。
6. **页尾与侧栏 Backlinks**：
   - 文档页尾提供可折叠「反向引用（Backlinks）」区块（及可选右侧信息栏），调用 `note.link.list` 实时展示所有出链（`outgoing`）与反向引用该笔记的笔记及工单（`backlinks`），每条标注来源实体类型图标、标题与 `link | embed` 关系。

---

### 5. 多维数据库 `Base` 规范

#### 5.1 12 种列类型（`BaseColumnKind`）与单元格值契约

`BaseSheet` 由列定义 `columns: Vec<BaseColumn>`、行记录 `rows: Vec<BaseRow>` 与多视图 `views: Vec<BaseViewConfig>` 组成。协议与核心层的 12 种 `BaseColumnKind`（含 Stage 1 收尾新增的 `NoteRef` 与 `Formula`）规范如下：

| `BaseColumnKind` | 线缆名 | `BaseCellValue` (`_tag`) | 展示、排序与求值规则 |
|---|---|---|---|
| `Text` | `text` | `Text { value }` | 单行/多行文本；支持 `eq`/`neq`/`contains`/`empty`/`notEmpty` 与字典序排序 |
| `Number` | `number` | `Number { value }` | 数值输入与格式化（整数去 `.0`，小数保留最多 4 位有效小数）；支持 `sum`/`avg`/`min`/`max` |
| `Select` | `select` | `Text { value }` | 单选枚举，渲染 `BaseColumn.options` 配置的 `label` 与语义 `color`（`stone`/`amber`/`green` 等）胶囊 |
| `MultiSelect` | `multiSelect` | `Strings { items }` | 多选枚举标签数组；按 `options` 顺序与文本展示 |
| `Date` | `date` | `Text { value }`（ISO-8601 日期或起止范围） | 日期选择器与本地化格式化；供 `timeline` 视图按时间跨度布局 |
| `Checkbox` | `checkbox` | `Bool { value }` | 复选框切换；数值转换时 `true = 1.0`、`false = 0.0` |
| `Media` | `media` | `Text { value }` 或 `Strings { items }`（`"asset/"` 相对路径或附件 id） | 缩略图胶囊预览；供 `gallery` 视图提取卡片封面 |
| `IssueRef` | `issueRef` | `IssueRef { issueId }` | 关联工单，渲染工单号、标题与实时状态徽标；点击打开工单抽屉或详情 |
| `AgentRef` | `agentRef` | `AgentRef { agentId }` | 关联执行角色档案，展示角色头像与名称 |
| `NoteRef` | `noteRef` | `NoteRef { noteId }` | 关联其他笔记（由 `stage1-finisher` 补齐协议与链接提取），渲染带 `NoteType` 图标的可跳转胶囊并写入 `note_link` |
| `Formula` | `formula` | 投影计算结果（`Text` / `Number` / `Bool` 显示值） | `BaseColumn.formula: Option<String>` 定义表达式，在 `project_base_view` 阶段纯 Rust 确定性求值，不落盘冗余计算列 |
| `AgentAction` | `agentAction` | `AgentRun { status, summary?, sessionId?, spawnedIssueId?, updatedAt }` | 读 `BaseColumn.agent_config`（`agent_id`、`prompt_template`、`target_column_id`、`spawn_issue_repo`），触发单行或全列批量 Agent 执行 |

#### 5.2 安全 Rust 公式引擎与 `project_base_view` 投影管线

1. **确定性无异常公式求值（`crates/core/src/note/base.rs`）**：
   - 语法支持 `{column_id}` 或 `{Column Name}` 单元格引用、数值四则运算（`+`、`-`、`*`、`/`，除零返回安全降级字符串而非 panic）、字符串拼接 `concat(a, b, ...)`、非空/集合计数 `count(...)` 与条件分支 `if(cond, a, b)`；解析或类型不匹配时返回干净的降级提示文本。
   - **禁止循环依赖**：若公式列间接引用自身或另一条成环公式列，检测环路并中断求值，输出确定性错误占位符。
2. **四步只读视图投影（`project_base_view`）**：
   - 输入 `BaseViewRequest { id, sheet_id?, view_id? }`，先选中目标 `BaseSheet` 与 `BaseViewConfig`（缺省取第一张表与首个视图，无视图时回落默认 `Table`）。
   - 依次执行：**（1）列裁剪**（过滤 `hidden_columns`）→ **（2）行筛选**（全部 `filters` 满足 `AND`，支持 `eq`、`neq`、`contains`、`notEmpty`、`empty`）→ **（3）公式求值与多列排序**（`sorts`，数值优先按浮点比较，其余按大小写无关字典序，最终以 `created_at`、`id` 稳定打破平局）→ **（4）分组与底部聚合**（按 `group_by` 列和 `options` 顺序生成 `BaseGroupSnapshot[]`；按 `summaries` 计算 `count`/`sum`/`avg`/`min`/`max` 输出 `BaseSummaryResult[]`）。

#### 5.3 四种视图（`BaseViewKind`）

| `BaseViewKind` | 布局与核心交互 | 关键配置字段 |
|---|---|---|
| `table` | 冻结表头与左侧首列（Title）、列宽拖拽、单元格内联编辑（文本/数字/下拉/日期/复选框/引用选择器）、底部每列聚合汇总栏 `summaries` | `hidden_columns`、`sorts`、`filters`、`summaries` |
| `board` | 按 `group_by`（通常为 `select` 或 `agentRef` 列）生成横向看板泳道，支持跨泳道拖拽更新单元格并即时重算分组计数 | `group_by`（未分类行归入 `"Uncategorized"`） |
| `gallery` | 响应式卡片网格，优先以行内 `media` 列缩略图或关联 `page_note_id` 封面作为头图，下方紧凑展示前 3–4 个可见属性 | `hidden_columns`、`filters`、`sorts` |
| `timeline` | 按 `date` 列渲染水平时间轴与甘特条，支持周/月缩放及拖拽调整起止日期并经 `note.base.upsertRow` 写回 | `date` 列（缺失时回落 `created_at`–`updated_at` 展示） |

#### 5.4 Row = Page 侧边 Peek 抽屉与 Agent 批量执行

- **Row = Page 机制**：每条 `BaseRow` 携带 `page_note_id: Option<NoteId>`。当用户打开某行的「展开为页面」时，若 `page_note_id` 为空，前端调 `note.create({ noteType: "doc", parentId: <base_note_id>, title: <row_title> })` 创建子文档并以 `note.base.upsertRow` 绑定 `page_note_id`；随后右侧滑出 Peek 抽屉（支持切换至全屏打开该子 `doc` 笔记），抽屉上半部分渲染该行全部字段属性表单，下半部分直接挂载完整 24 块 `doc` 编辑器。
- **`agentAction` 批量执行与派生工单**：
  1. 用户或主助手调用 `note.base.runAgentColumn`（指定 `column_id` 及可选 `row_ids`）。
  2. `Manager::prepare_base_agent_column_async` 校验 `agentConfig`，对每行执行 `format_agent_prompt` 替换 `{{column_id}}`、`{{Column Name}}` 与 `{{row_id}}`。
  3. `crates/server/src/router/note.rs`（以及工具端口 `crates/server/src/agent/tool/content.rs`）遍历任务：若配置了 `spawn_issue_repo`，自动调用 `Board::create_async` 派生真实工单并将 `status` 设为 `"spawned"`、记录 `spawned_issue_id`；否则记录准备完成状态。
  4. `apply_base_agent_column_outcomes_async` 原子写回该列的 `BaseCellValue::AgentRun`，若配置了 `target_column_id` 则同步写入摘要文本，并通过 `note.follow` 推送更新。

#### 5.5 MCP 工具族与 SEP-2640 技能体系

- **MCP 工具（`crates/cli/src/domains/mcp/note_defs.rs`）**：对外暴露 14 个工具，由 `crates/server/src/agent/mcp/mode.rs` 按执行模式实施只读/写权限控制（`Drafting`、`ReadOnlyAnswer`、`ReadOnlyReview`、`ReadOnlyCollaborator` 仅允许读取、列表与查询链接，禁止写入与修改树结构）：
  - 基础与协同（9 个）：`vv_note_list`、`vv_note_get`、`vv_note_create`、`vv_note_read`、`vv_note_write`、`vv_note_patch`、`vv_note_suggest`、`vv_note_tree_move`、`vv_note_link_list`。
  - Block Doc 专用（2 个）：`vv_doc_view`、`vv_doc_append_block`。
  - Base 专用（3 个）：`vv_base_view`、`vv_base_upsert_row`、`vv_base_run_agent_column`。
- **SEP-2640 渐进披露技能（`crates/mcp/src/skills.rs`）**：`crates/server/assets/note/types/{doc,base,canvas,media}/` 在编译期嵌入 `SKILL.md` / `SKILL.en.md` 与 `references/format.md`，通过标准 MCP `skills/list`、`skills/get` 及 `resources/read`（`skill://note/<type>`、`skill://note/<type>/references/format.md`）以及 `note.type.list` / `note.type.read` 按需披露，不占用常驻上下文窗口。

---

### 6. PKM + GTD 双向闭环

1. **`PageTree` 层级树与防环移动**：
   - `note.parent_id` 与 `note.sort_order` 构成可任意嵌套的工作区笔记树。
   - `note.tree.move`（`NoteService::set_parent_order_in_tx`）在数据库事务内沿 `parent_id` 向上回溯祖先链，严格拒绝自父节点或将父节点移入其任意后代节点的成环请求（返回 `BizCode::NoteRefused`）。
   - 删除父笔记时（`NoteService::delete`），在同一事务内把直接子笔记的 `parent_id` 置为 `NULL`（提升至根层），再清理关联的 `note_link` 边，绝不级联误删子文档。
2. **`note_link` N:M 双向知识图谱**：
   - `sync_note_links_async` 在每次 `note.create`、写入、还原、分叉、撤销与协作导入后自动刷新源节点出边：对 `doc` 提取 `BaseEmbed` / `IssueCard` 的 `Embed` 边及各文本块（含 `Prose`、`Heading`、`List`、`Todo`、`Callout`、`Quote`、`Toggle`、`Table`）中的 `[[note:<id>]]`、`[[issue:<id>]]`、`![[...]]` 与词边界 `#<digits>`（自动跳过行内代码、围栏代码块与 URL 锚点）；对 `base`、`canvas`、`media` 扫描结构文件链接（含 `NoteRef` 与 `page_note_id` 关系）。
   - 工单侧（`crates/server/src/issue/board.rs` 与 `edit.rs`）在创建与编辑工单描述时同样调用 `extract_markdown_links` 并通过 `replace_links_for_source(LinkEntityKind::Issue, ...)` 写入 `note_link`，从而使「工单引用笔记」与「笔记引用工单」在同一个图表中双向可见。
   - 查询接口 `note.link.list` 实时批查 `note` 与 `issue` 表，返回解析好最新标题与 `note_type` 的 `outgoing` 与 `backlinks`。
3. **`Note <-> Issue` 内联与卡片闭环**：
   - 文档内 `[[issue:<id>]]` 与 `#<number>` 渲染为带工单编号与状态灯的可点击内联胶囊；`issueCard` 与 `issueList` 块将工单实时进度嵌入方案文档。
   - 工单详情页除了展示直接外键关联（`note.issue == issue.id`）的笔记外，同步消费 `note.link.list({ entityKind: "issue", entityId })` 的 `backlinks`，直接呈现引用该工单的所有文档与 Base 行。
4. **频道消息晋升为笔记（Channel promote-to-Note）**：
   - 频道消息菜单（参考 `apps/mac/ui/features/channel/model/promote.ts` 的草稿构造约定）提供「保存为笔记」操作：默认将消息首行（去除 Markdown 标题前缀）或首附件名作为标题，保留正文与附件引用，并在文末附加引述回链 `> [来自 #<channel> #<seq>](/chat/<channel>?m=<seq>)`；当所选类型为 `doc` 时自动转为结构化 `DocBlock` 序列。
   - `note.create` 指定 `channel` 且 `announce = true` 时，经 `ChannelAnnounce::post_card_async` 在源频道投递带版本号的 `NoteCard`，完成「讨论 → 沉淀为结构化笔记 → 派发工单执行 → 写回验收」的完整工作流闭环。

## 怎么走

**1. 创建与多人/多 Agent 实时协同（含建议防覆盖）**

1. 主助手或执行会话先读 `skill://note/<type>`（`skills/get` 或 `note.type.read`）获取该原语目录规范。
2. 服务端调 `note.create` 初始化 `<home>/note/<id>/{manifest.json,structure/,asset/}`、切出初始不可变快照 `version = 1`，并在单一事务内写入 `note`、`note_version`、`note_collab`、`note_change(seq=1)`，随后同步 `note_link` 并按需向频道投递 `NoteCard`。
3. 人类通过前端编辑器与 Loro `CollabDoc`（`note.collab.import`/`export`）或 `note.file.write` 协同编辑；高频光标通过 `note.presence.update` 进驻纯内存 `PresenceHub` 并由 `note.presence.follow` 实时广播。
4. 若 Agent 对人类已编辑过的路径发起 `note.file.write`，服务端拦截写入并生成 `SuggestionStatus::Open` 记录推送至 `note.suggestion.follow`；用户经 `note.suggestion.accept` 审阅合并后推进 `seq` 并重算 `note_link`。

**2. Base 多维视图查询与 Agent 列批量派工**

1. 前端调用 `note.base.view` 读取 `"structure/base.json"`，Rust 端按请求 `view_id` 顺序执行列裁剪、筛选、公式求值、排序、分组与汇总，返回 `BaseViewSnapshot`。
2. 用户在 `Table` / `Board` / `Gallery` / `Timeline` 或 Row=Page 侧边抽屉中编辑单元格后，通过 `note.base.upsertRow` 增量更新单行（不重写整份文档历史）；如需为该行展开正文页面，创建子 `doc` 笔记并回填 `page_note_id`。
3. 点击 `agentAction` 列「运行」触发 `note.base.runAgentColumn`：服务端按行模板渲染提示词，经 `Board::create_async` 派生工单（或记录任务摘要），并将 `BaseCellValue::AgentRun` 写回 `"structure/base.json"`。

## 和谁打交道

- **统一存储（`storage/`）**：`NoteStorage` 管理 `<home>/note/<id>/` 与 `<home>/note_snapshot/<id>/`，并通过 `StorageBackend` 支持远端镜像与恢复。
- **顶层数据服务（`service/`）**：`Manager` 经 `ctx.service.note` 访问 6 张表，业务层零 `sea_orm::` 与 `db::entity` 导入。
- **核心协作内核（`crates/core/src/collab/`、`crates/core/src/note/`）**：复用 `CollabDoc`、`PresenceHub`、24 块 `doc` 内核与 `base` 投影内核。
- **工单（`issue/`）**：通过 `note.issue` 外键（`ON DELETE SET NULL`）、`note_link` 双向图谱以及 `router/note.rs` 的 `Board::create_async` 派生工单闭环。
- **频道（`channel/`）**：通过 `ChannelAnnounce` 在创建或新版本发布时投递 `NoteCard`，并支持消息晋升为笔记（带 `/chat/<channel>?m=<seq>` 回链）。
- **工具与 MCP（`agent/tool/`、`agent/mcp/`、`crates/cli/src/domains/mcp/`）**：提供进程内与 `/mcp` 标准化 14 枚 `vv_note_*`/`vv_doc_*`/`vv_base_*` 工具及 SEP-2640 技能目录。
- **媒体库与媒体任务（`library`、`media/`）**：与 `Note` 共居 `crates/server/src/note/` 模块，复用统一内容中心浏览体验（[媒体和素材库](docs/subsystems/media.md)）。

## 为什么这样

- **3+1 原语替代 12 类碎片化产物**：原 12 类 `ArtifactType`（`docs`/`outline`/`slides`/`dashboard`/`sheet`/`diagram`/`prototype` 等）造成大量重复渲染容器与 AI 技能维护成本；把写作/演示/图表收敛为 24 块 `doc`、把结构化数据集收敛为 `base`、保留 `canvas` 与 `media`，既覆盖全部场景又让 AI 只学 4 份核心规范即可稳定产出。
- **JSON 结构化目录 + Rust 内存投影替代动态 SQL DDL 与客户端 WASM SQLite**：为每张用户自定义 Base 表动态建 SQL 表会导致双后端（SQLite/PostgreSQL）DDL 爆炸、Loro CRDT 难以合并以及迁移失控；采用 `"structure/base.json"` + Rust `crates/core/src/note/base.rs` 纯投影后，多视图过滤排序、公式与 CRDT 版本向量天然统一且零前后端计算漂移。
- **按 `origin` 分桶微批 + `note_suggestion` 防覆盖替代锁表或直接覆盖**：流式 AI 生成若每次字符写入都写 SQLite 并混入人类提交，既会写放大又无法单独撤回 Agent 轮次；`OriginWriteBatcher` + `CommitMeta` + `human_touched_paths` 建议分流同时保障了高吞吐、可追溯撤销与人类内容主权。
- **外部衍生 `.cover-*` 与 `.preview.json` 隔离于 CRDT**：卡片封面截图与列表摘要属于可重算视图衍生缓存，若写入 `manifest.json` 或 `CollabDoc` 会污染 `seq`、触发无谓的协作同步风暴；隔离存盘确保封面刷新零协同噪声。
- **不可信网页预览沙箱隔离**：`BlockKind::Preview` 与可执行原型视图一律运行在无 `allow-same-origin`、`connect-src 'none'` 的沙箱容器内，彻底隔离宿主接口与本地文件权限。

## 还没做的

- `BaseRow.page_note_id`、`BaseColumnKind::{NoteRef, Formula}`、安全公式求值器与结构化 `Base` 外链提取收尾：`#32`、`#40`。
- 原生工作台 `/notes`、`PageTree` 侧栏、24 块富文档编辑器（`/`、`[[`、Markdown 输入规则、悬停槽、`Turn Into`、Presenter Mode、Backlinks）与 Base 4 视图 / Row=Page Peek 抽屉落地及频道晋升切换至 `note.create`：`#31`、`#38`、`#39`、`#128`、`#131`。
- `DocBlock` 1:1 映射到 `CollabDoc` 的 `LoroTree` + 每块独立 `LoroText`（替代整份 `"structure/doc.json"` 文本 diff）及块级增删改增量端点（如 `note.doc.updateBlock` / `moveBlock` / `deleteBlock`）：`#39`。

## 怎么验证

### 自动化测试

- `crates/core/tests/collab_loro.rs`：Loro 1.18.0 并发收敛、30 s TTL 在场驱逐、同毫秒单调更新、`TextRangeAnchor` 游标、时间旅行、浅快照压缩与按 `origin` 选择性撤销。
- `crates/core/tests/note_golden.rs`：4 原语目录布局、路径白名单与防逃逸校验、Manifest 编解码与 RFC 7396 Merge Patch golden 校验。
- `crates/core/src/note/doc.rs`、`crates/core/src/note/base.rs`、`crates/core/src/note/links.rs`、`crates/core/src/note/preview.rs` 单元测试：24 块 Markdown 往返、Base 过滤/排序/分组/汇总/公式、`[[note:...]]`/`[[issue:...]]`/`#N` 提取与 `NotePreview` 提取。
- `crates/server/tests/note.rs`：4 原语 CRUD、不可变快照、Tree 防环移动、`note_link` 双向查询、`note.doc.*`、`note.base.*`（含派生工单）、协同同步、建议流与实时在场。
- `crates/server/tests/mcp.rs`：14 枚 `vv_note_*` / `vv_doc_*` / `vv_base_*` 工具与 SEP-2640 `skill://note/*` 渐进披露集成测试。

### 多轮视觉与排版验收清单（Light + Dark VDP 质量标杆）

UI 工程师自测与 `@dev-vdp` 照 [vv-acceptance 应用分册](.agents/skills/vv-acceptance/references/app.md) 在隔离环境运行真实 `vibevalley-mac` 时，应在 **Light 与 Dark 双主题**、**典型密级与极端长内容** 以及 **宽窗（≥ 1280px）与窄窗（< 768px）** 下逐项核验并留存截图证据：

1. **双主题四级表面与设计令牌纪律（[design/01-philosophy-and-tokens.md](docs/design/01-philosophy-and-tokens.md)、[design/08-agent-ui-guide.md](docs/design/08-agent-ui-guide.md)）**
   - [ ] 四级表面严格呈 `bg-rail → bg-side → bg-page → bg-elevated` 递进，深色模式无弹窗/卡片沉底倒挂。
   - [ ] 零硬编码 hex/`rgb()`/`rgba()`，半透明底色统一经 `mix()`，通过 `vpx scripts/audit/ui-tokens.ts` 零违规。
   - [ ] 全局与局部图标仅使用 `reicon`（`<Icon name>`）或 Papertrails 纸雕产物，无系统 emoji 混入。
2. **排版层级与可读节奏**
   - [ ] `doc` 正文画布受限于舒适阅读宽度（`PageBody width="prose"`，`max-w-3xl`），标题 `text-2xl` / `text-xl` / `text-lg` 与正文 `text-sm`–`text-base` 阶梯分明；CJK 与英文/数字混排、代码块（`Maple Mono NF CN` / `Menlo`）行高舒适不粘连。
   - [ ] `Base` 数值列、汇总行与状态计数统一启用 `tabular-nums` 等宽对齐，长标题/长路径容器均带 `min-w-0` + `truncate`，无撑破父容器或重叠。
3. **24 块 Doc 编辑器与零位移交互**
   - [ ] 点击块进入编辑态与失焦回到阅读态无 `1px–4px` 垂直/水平跳动（阅读/编辑同构 `border-transparent` 盒模型）。
   - [ ] `/` 斜杠菜单在 Light/Dark 下均以 `bg-elevated border-line shadow-float` 浮起，分类清晰、高亮清晰、`Esc`/`Enter` 行为准确，不残余 `/` 文本。
   - [ ] `[[` 与 `#` 补全弹出不遮挡当前光标行；插入后的 `[[note:...]]`、`[[issue:...]]` 与 `#N` 胶囊对齐基线且点击可跳转。
   - [ ] 块左侧悬停 `+` 与 `⋮⋮` 手柄不挤占正文行宽；`Turn Into`、`Columns` 多列分栏、GFM `Table`、`Toggle`、`Callout`、`Quote`、`Code`、`Math`、`Diagram`、`Chart`、`KPI`、`Compare`、`Bookmark`、`Toc` 在双主题下边框与对比度均达标。
   - [ ] Presenter Mode 全屏无导航残留，当前页/下一页/备注栏/`Kbd` 键帽提示对齐，无 WebView 空白帧或越界溢出。
   - [ ] 页尾 `Backlinks` 面板展示正确数量与类型图标，折叠/展开平滑不破坏滚动位置。
4. **Base 四视图与 Row=Page 抽屉**
   - [ ] `Table` 视图表头吸顶、列分割清晰、底部汇总栏可读、单格编辑不撑裂行高。
   - [ ] `Board` 视图按 `group_by` 分泳道卡片简洁、跨泳道拖拽显示占位反馈并同步计数。
   - [ ] `Gallery` 视图卡片封面图比例一致、无拉伸变形；`Timeline` 视图日期轴与条块标签不互相遮盖。
   - [ ] 点击行展开 Row=Page 右侧 Peek 抽屉，属性表单与内嵌 `doc` 24 块编辑器在窄屏与宽屏下均可正常滚动与编辑，`agentAction` 列状态胶囊（`idle`/`running`/`spawned`/`error`）语义色准确。
5. **实时协同、建议与历史面板**
   - [ ] 多协作者在场胶囊与光标颜色在 Light/Dark 下可读且不遮挡文字；`NoteSuggestion` 审阅条清晰展示原内容/建议修改与「接受/拒绝」操作按钮。
   - [ ] `HistoryPanel` 时间线准确展示 `origin`（用户 / 主助手 / 执行会话轮次），预览与按来源撤销后界面无卡死或旧状态残留。
   - [ ] 全部页面测试（`nsh test`）与真实应用启动日志（`app.log` + `Shell.getState`）`0` JS/Rust 错误。
