# Agent Note: 多维结构化数据表 Base 与 Agent 批量执行列架构（#32）

Status: proposed

## Problem

当前 `sheet` 类型（[crates/server/assets/artifact/types/sheet/SKILL.md](crates/server/assets/artifact/types/sheet/SKILL.md) 与 [StructuredViews.tsx](apps/mac/ui/features/artifact/views/StructuredViews.tsx)）仅提供静态工作簿（`structure/workbook.json`、`structure/sheets/*.json` 与基础数值求和），在 VibeValley 实际工作流中存在三个核心缺口：

1. **缺少强类型字段与结构化视图**：单元格仅是弱约束 JSON 值，缺少单选/多选标签、日期区间、媒体附件（图/音/视频）、VibeValley 工单双向关联（`issueLink`）与确定性公式/汇总列；同一份数据也无法在表格（Grid）、看板（Kanban）、画廊（Gallery）、时间线（Timeline/Gantt）与日历（Calendar）间切换，更无法内嵌进文档协同阅读。
2. **缺少行级 Agent 批量执行原语**：当用户需要让角色批量处理一批行（如逐行调研竞品 URL、为 30 个分镜生成参考图/配音、批量审查一组接口并生成工单）时，目前只能手工拆单或写一次性脚本，无法在表内配置「Agent 执行列」、通过 OAR 并发调度、实时观测每格 `queued`/`running`/`done`/`failed` 状态并将结果自动回填或派生跟踪工单。
3. **缺少面向内外部编码 Agent 的结构化表工具**：`POST /mcp`（[crates/server/src/agent/mcp/mod.rs](crates/server/src/agent/mcp/mod.rs)）与 `vibevalley mcp`（[crates/cli/src/domains/mcp/mod.rs](crates/cli/src/domains/mcp/mod.rs)）目前仅暴露文件级读写（`artifact_file_get`/`write`），外部 agent 改一行数据容易整份重写 `sheets/*.json`，破坏他人并发编辑。

本提案结合 [作品类型收敛与 Block Rich Doc 统一内容模型（#31）](.agents/notes/proposed/architecture/2026-11-27-artifact-block-doc-convergence.md)，将原 `sheet` 升级为飞书多维表格 / Airtable / Notion Database 级的核心原语 **`Base`（`artifactType: "base"`）**，复用 `storage/` 目录 + Loro CRDT + OAR 运行时架构。

## Proposal

### 1. 存储布局与单一 Loro CRDT 真源

每份 `base` 作品仍遵循 `<storage>/artifact/<artifact_id>/` 目录规范（[crates/server/src/storage/artifact.rs](crates/server/src/storage/artifact.rs)）与 5 张作品表，**不引入动态 SQL 建表或回到 SQL-KV `artifact_entry`**：

```text
<storage>/artifact/<artifact_id>/
├── manifest.json          # id、artifactType: "base"、title、entry: "structure/base.json"、defaultViewId
├── structure/
│   ├── base.loro          # Loro CRDT 二进制快照（与 DB artifact_collab 原子同步）
│   ├── base.json          # 确定性物化快照（tables/fields/views/records 索引，供导出与调试）
│   └── prompts/           # 可选：agentColumn 引用的长提示词模板文件
└── asset/                 # 行内 media 列引用的图片、音频、视频与导出的 CSV/JSON 文件
```

Loro 容器布局映射至 `CollabDoc`（[crates/core/src/collab/doc.rs](crates/core/src/collab/doc.rs)）：

- **`fields`（`LoroMap` of `LoroMap`）**：以稳定 `fieldId` 为键存储字段定义（`name`、`type`、`options`、公式表达式、`agentColumn` 配置与列宽），支持并发改名与配置合并。
- **`views`（`LoroMap` of `LoroMap`）**：以稳定 `viewId` 为键存储多视图配置（`kind`、`filter`、`sort`、`groupBy`、`dateRangeFields`、`coverFieldId`、`visibleFieldIds`）。
- **`record_order`（`LoroList` / `LoroTree`）**：维护稳定行序 `recordId`，支撑多协作者并发插行与看板拖拽排序。
- **`records`（`LoroMap` of `LoroMap`）**：以 `recordId` 为外键、内部以 `fieldId` 为键存储单元格值，实现**单元格级无冲突并发合并**——人类修改某行标题列与执行会话回填同一行的 AI 输出列互不覆盖。
- **实时在场与来源归因**：`PresenceHub`（[crates/core/src/collab/presence.rs](crates/core/src/collab/presence.rs)）通过 `selector = "cell:<recordId>:<fieldId>"` 广播当前聚焦单元格；每次单元格或批量列写入带 `CommitMeta`（`origin`），支持通过 `artifact.history.undoOrigin` 一键撤销某一轮 Agent 批量填充。

### 2. 强类型字段系统（`FieldType`）

在 `crates/protocol` 定义封闭联合 `FieldType`（Rust 为源、生成 TS 形状与 Zod Codec）：

| 字段类型 | 存储值结构与校验规则 | 核心交互与生态联动 |
|---|---|---|
| `text` | UTF-8 字符串（支持轻量内联 Markdown） | 单元格内直接编辑，可作为主键标题列 |
| `number` | `f64` + `format`（`plain \| percent \| currency \| duration`）+ `precision` | 严格禁止脏字符串；视图底栏支持 `sum`/`avg`/`min`/`max` 聚合 |
| `select` / `multiSelect` | 预定义带令牌色值的选项 `optionId` 或数组 | 驱动 Kanban 分组与统一筛选器 |
| `date` | ISO-8601 字符串或 `{ start, end, includeTime }` 区间 | 驱动 Timeline/Gantt 与 Calendar 视图 |
| `checkbox` | `bool` | 一键勾选状态，可用于条件触发 `agentColumn` |
| `url` | 经校验的 `https://`、`http://` 或 `vv://` 资源 URI | 点击直达外部链接或内部 `vv://` 资源预览 |
| `media` | `MediaCellRef[]`（指向 `asset/<name>` 或 `attachmentId` / `media_library_item`） | 内联缩略图、音视频直播、灯箱预览；可承接 `media_*` 生图/语音任务输出 |
| `issueLink` | `{ issueId: string }`（单向存 ID，动态属性实时投影自 `SpaceState`） | 展示工单实时 `status`、`stage`、指派角色与 PR 状态；支持一键「从行创建工单」并双向同步状态 |
| `agentColumn` | `AgentColumnConfig` + 最近一次运行索引（运行时态走 `LiveState`） | 按行并发调用 OAR 执行提示词或派生工单，写回结构化输出或媒体资产（见 §4） |
| `formula` / `rollup` | 确定性表达式 AST（只读计算字段，不存手算静态值） | 在 `crates/core/src/base/formula.rs` 纯函数求值，支持引用同行字段或聚合 `issueLink`/分组指标 |

### 3. 单一真源驱动五视图与 Block Doc 内嵌

所有视图共享同一份 Loro `records` 数据与纯投影函数（`crates/core/src/base/projection.rs`），不各自维护副本：

1. **Grid / Table（多维表格）**：虚拟化滚动表头冻结、列类型专用编辑器、分组汇总、筛选/排序持久化与 CSV/JSON 导入导出。
2. **Kanban（看板）**：按任意 `select`、`multiSelect` 或 `issueLink.status` 分列分组；跨列拖拽卡片原子提交单元格更新（绑定 `issueLink` 时通过 `issue` 服务同步流转状态）。
3. **Gallery（画廊）**：以 `media` 字段作封面、自选核心字段作角标卡片，适合生图/配音评测矩阵与分镜资产库。
4. **Timeline / Gantt（时间线 / 甘特）**：基于 `date` 起止字段与父子/分组聚合渲染排期条（复用工单排期模型 `schedule.ts` 的区间语义）。
5. **Calendar（日历）**：按月/周日历网格投影 `date` 字段记录，支持点击空日期直接创建带默认日期的行。
6. **直接嵌入 Block Rich Doc（`#31`）**：在 `doc` 作品中插入 `baseEmbed` 块并指定 `{ baseArtifactId, viewId, filterOverride }`，即可在方案文档、复盘报告中实时交互操作任意一种 `Base` 视图，数据变更双向实时收敛。

### 4. Agent 执行列（`agentColumn`）与 OAR / 工单批量调度

`AgentColumnConfig` 在结构上显式声明执行契约：

```text
AgentColumnConfig:
  agentId: string                 # 目标角色（Agent profile），决定人设、权限与工作区策略
  runtimeOverride?: string        # 可选 OAR 引擎与模型覆盖
  promptTemplate: string          # 支持 {{field_name}} 插值，自动解析 media 路径与 issueLink 摘要
  skills: string[]                # 注入本次执行的 SEP-2640 Skill URI（如 skill://artifact/*）
  outputMode: "cell" | "issue"    # "cell" 结构化回填本列或映射列；"issue" 创建/更新关联工单并派活
  targetFieldMap?: Record<string, string> # 可选将 JSON 输出拆分回填到多个强类型字段
  trigger: "manual" | "onRowCreate" | "onDepsChanged"
```

**批量调度与运行状态流转**：

1. **依赖图校验**：保存 `formula`、`rollup` 与 `agentColumn` 配置时，在 `crates/core` 对字段引用关系做 DAG 拓扑校验，显式拒绝循环依赖；存在依赖链时按拓扑层级顺序触发下游列。
2. **有界并发入队**：用户或 Agent 触发「运行整列 / 运行选中行 / 单格重跑」后，服务端 `crates/server/src/artifact/base.rs` 为每格生成确定性 `CellRunKey`（`artifactId:recordId:fieldId:runId`），先落入实时状态 `LiveState`（`queued`），受 `RepoSummary.maxSessions` 与引擎 `maxWorking` 配额约束排队派往 OAR（`crates/server/src/runtime/session/`）。
3. **双模式执行**：
   - **`outputMode: "cell"`**：通过 OAR 启动轻量只读/沙箱执行会话，携带行上下文、`media` 附件路径与指定 `skills`；执行产出按字段类型校验后（文本、选项、`media` 附件入库）以 `CommitMeta::session` 提交进 Loro 单元格。
   - **`outputMode: "issue"`**：调用工单服务（`crates/server/src/issue/`）为该行创建或更新绑定的 `Issue`（写入 `issueLink` 列），并按工单标准流程开 worktree、经 OAR 跑编码会话与走验收（`in_review` → `done`），让每行代码任务拥有完整的 diff 审阅与回滚边界。
4. **实时状态追踪与断点续跑**：单元格角标实时展示 `queued` / `running` / `done` / `failed` 与关联 `sessionId`，点击直达 `/runs` 轨迹详情；批量中断或部分行失败时，支持仅重跑 `failed` 格而不重复消耗已 `done` 的行。

### 5. MCP / ACP 工具契约与 SEP-2640 Skills

为避免外部 agent（Antigravity、Claude Code、Codex）与 VibeValley 内置执行会话读写整份 JSON，在 `crates/server/src/agent/tool/`、`crates/mcp` 与 `crates/cli/src/domains/mcp.rs` 提供成套语义化工具：

- **Schema 与视图管理**：`vv_base_schema_get`（读表结构与视图列表）、`vv_base_field_upsert`（增改字段及 `agentColumn` 模板，带 DAG 校验）、`vv_base_view_upsert`（配置 Grid/Kanban/Gallery/Timeline/Calendar 视图）。
- **行级增量读写**：`vv_base_record_query`（按视图过滤、排序、分页读取记录，控制上下文窗口）、`vv_base_record_upsert`（按 `recordId` + `fieldId` 局部合并写格，记录 `origin`）、`vv_base_record_delete`。
- **批量执行控制**：`vv_base_column_run`（触发指定 `agentColumn` 对行子集或全视图入队执行，返回 `batchId`）、`vv_base_run_status`（查询批次与单元格运行态）。
- **SEP-2640 技能暴露**：通过 `skill://artifact/base`（基础建模与协作规范）及垂直配方（如 `skill://artifact/base-eval-matrix` 模型评测表、`skill://artifact/base-batch-pipeline` 批量内容生产管线）提供渐进披露指南。

## Alternatives considered

### Why not store Base rows in per-artifact dynamic SQL tables or JSONB rows?

动态 SQL 建表（DDL）在 SQLite / PostgreSQL 双后端（`crates/server/src/db/`）下会带来极高的迁移、索引与边界审计（`{db,service}/` 隔离）复杂度，且无法复用 Loro CRDT 的单元格级无冲突合并、`PresenceHub` 在场同步与按 `origin` 选择性撤销。以 Loro `doc` 容器为单一内容真源、`structure/base.json` 为确定性物化视图，与 `#31` 的 `doc` 架构完全同构。

### Why not keep `sheet` as a separate spreadsheet primitive alongside `base`?

同时保留 `sheet`（A1 自由格）与 `base`（强类型多维表）会造成用户心智分裂与两套表格 UI 维护。`base` 原生支持内联编辑、数值格式、确定性 `formula` 列、列聚合与 CSV 导入导出，足以覆盖研发预算、指标台账与对比矩阵等原 `sheet` 场景。

### Why not execute `agentColumn` with direct ad-hoc HTTP LLM calls outside OAR?

绕开 OAR 直接调模型接口会丢失 VibeValley 的核心运行时基础设施：轨迹记录（`Journal`）、费用与配额统计（`Spent` / `RuntimeQuota`）、MCP 工具访问、worktree 代码隔离以及工单验收流程。统一经 OAR / `runtime::session` 调度才能让批量行任务在 `/runs` 与 `/issues` 中可观测、可限流、可中断。

## Acceptance criteria

- `crates/protocol` 完成 `FieldType`、`FieldDef`、`ViewDef`、`AgentColumnConfig`、`CellRunState` 与 `vv_base_*` 工具参数契约定义并生成 TS 类型与 Zod Schema（`cargo xtask protocol --check` 通过）。
- `crates/core/src/base/` 实现基于 `CollabDoc` 的多维表 CRDT 读写、单元格级并发合并、纯 Rust 确定性 `formula`/`rollup` 求值、字段依赖 DAG 环检测及 5 种视图的纯投影单测。
- `crates/server/src/artifact/base.rs` 实现 `agentColumn` 批量调度器（受 `maxWorking`/`maxSessions` 并发控制，支持 `cell` 回填与 `issue` 派单双模式）、`LiveState` 运行态推送以及 `vv_base_*` MCP 工具与 `skill://artifact/base` 技能暴露（离线 scripted OAR 集成测试通过）。
- `apps/mac/ui/features/artifact/` 完成 `Base` 五视图切换（Grid/Kanban/Gallery/Timeline/Calendar）、强类型字段编辑器、`agentColumn` 批量触发与格内运行态指示器，并支持作为 `baseEmbed` 块嵌入 `#31` Block Rich Doc，通过 `vp run mac:check` 与 VDP 验收。

## Risks

- **大表行数量级下的物化与渲染性能**：当单表超过数千行时，每次写格全量生成 `structure/base.json` 与全量序列化推送会造成 CPU 与 IPC 抖动。缓解：服务端按视图分页查询（`vv_base_record_query`）、前端表格采用虚拟化渲染、`base.json` 仅在防抖窗口或快照提交时异步刷写，协同实时通道只传 Loro Version Vector 增量字节。
- **批量 `agentColumn` 触发并发风暴与费用失控**：误触全表 500 行执行可能瞬间占满引擎配额并产生高额 API 费用。缓解：批量执行超过阈值时前端强制弹出待跑行数与预估并发提示确认，服务端严格走引擎 `maxWorking` 有界队列，并提供一键暂停/取消批次能力。
- **`issueLink` 双向同步竞态**：表格内拖拽改状态与工单看板直接改状态同时发生时可能出现投影不一致。缓解：`issueLink` 仅在 Loro 中存 `issueId`，工单状态/阶段等动态属性永远以核心状态 `SpaceState`（`board` 切片）为唯一真源实时投影，不写回冗余副本。
