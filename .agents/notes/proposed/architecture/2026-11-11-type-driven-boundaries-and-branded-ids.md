# Agent Note: 扩展剩余跨模块品牌主键与 SQL 主外键自动品牌生成

Status: proposed

## Problem

总纲 [module-design.md](docs/style/module-design.md#静态化类型化与可分析化) 与 [地基](docs/subsystems/foundation.md#边界审计) 已落地全栈共用 `Schema` 的直接 Fail-Fast 边界（`VibeValleyApi` 按 `ApiError` 与 `Endpoint.result` 解码、SSE `stream.ts`、服务端自有表 `storedJsonOrUndefined(schema, "table.column")`、配置 `PortNumber` / `PositiveFinite` 进门窄化）、清零了协议与厂商层重复内联 `Schema.Literals` 及子包非递归 `Schema.Codec` 双写，并通过 `vibevalley/tagged-error-tag`、`vibevalley/effect-idioms`、`vibevalley/unstable-effect-door`、`practice:check`（`duplicate-error-tag` / `provide-in-loop` / `cached-per-call`）和 [schema-audit.ts](scripts/audit/schema-audit.ts)（`db-enum-mismatch`、`redacted-json-exposure`、`unbranded-id`）建立了零存量静态门禁。

在已锁死的 6 个核心品牌主键（`IssueId`、`SessionId`、`ArtifactId`、`BlockId`、`SuggestionId`、`MessageId`）之外，全仓还剩两项跨表结构与生成器的增量演进：

1. **其余跨模块实体主键仍使用裸 `string`**：
   - [0001_schema.up.sql](apps/server/db/migrations/0001_schema.up.sql) 共 27 张表使用 `text primary key`，`packages/protocol/src/**/shapes.ts` 中频道、档案、触发器、定时任务、运行记录、附件、媒体作业、连接与机器（`ChannelId`、`AgentId`、`TriggerId`、`CronId`、`RunId`、`AttachmentId`、`MediaInputId`、`MediaJobId`、`ConnectionId`、`DeviceId`、`MachineId`）仍声明为裸 `string`。
   - 对这些尚未品牌化的实体，用户与模型输入的未解析引用（如频道名、档案名、`vv://` 地址）与已解析主键在函数签名上仍共用 `string`。
2. **SQL 生成器尚未从主键与外键约束自动派生品牌类型**：
   - [pg-generate.ts](apps/server/scripts/pg-generate.ts) 已自动将 `CHECK (col IN (...))` 转为字面量联合，但所有 `text` 主键与外键列仍生成裸 `Schema.String`，查库返回后需在业务层手工调用 `S.issueId(row.id)` 或 `S.sessionId(row.session)` 补标。

## Proposal

按「每次一个实体 ID 独立演进 + SQL 元数据自动生成」推进剩余品牌化，避免单次跨 20 余个模块的大爆炸改动：

### 1. 分批补齐剩余跨模块品牌主键并拆清 `Ref` 与 `Id`

1. 按扇入顺序逐批在 [common/shapes.ts](packages/protocol/src/common/shapes.ts) 与 [common/schema.ts](packages/protocol/src/common/schema.ts) 引入 `ChannelId`、`AgentId`、`TriggerId`、`CronId`、`RunId`、`AttachmentId`、`MediaInputId`、`MediaJobId`、`ConnectionId`、`DeviceId`、`MachineId`。
2. 对接受人类或模型混合写法（`#41`、编号、频道名、档案名、`vv://`）的协议请求与工具入参，保留在 `*Request` / `*Input` 边界（或显式命名为 `*Ref`），仅在所属服务的解析入口（`Issue.idOf`、`Channel.placeOf`、`Agent.named`）返回品牌主键，内部服务方法只收品牌主键。
3. 每完成一个实体的品牌化，同步将其字段名加入 [schema-audit.ts](scripts/audit/schema-audit.ts) 的 `unbranded-id` 硬门禁词表。

### 2. 让 `pg-generate.ts` 读取 `pg_constraint` 直接生成品牌主外键

1. 在 [pg-generate.ts](apps/server/scripts/pg-generate.ts) 读取 Postgres 系统表 `pg_constraint` 的主键（`p`）与外键（`f`）元数据，将已登记品牌的表主键及引用它的外键列（含查询参数与返回列）直接生成为对应品牌 `Schema`（如 `IssueId`、`SessionId`、`ChannelId`）。
2. 重新生成 `apps/server/db/generated/*.sql.ts` 后，清理服务端 `rows.ts`、`assignment.ts`、`history.ts` 中手工补标的 `issueId(row.id)` / `sessionId(row.session)` 转换。

## Alternatives considered

- **取代并收口旧的边界与 HTTP 客户端评估计划（原 `2026-11-06-schema-at-boundaries.md`）**：前后端已共享 `@vibevalley/protocol/schema`，生成的 `VibeValleyApi` 已直接用 `ApiError` 与 `Endpoint.result` Schema 做边界 Fail-Fast 解码并通过回归测试，服务端自有表可空 JSON 列已统一改走 `storedJsonOrUndefined`，相关准则已沉淀进 [地基](docs/subsystems/foundation.md#边界审计) 与 [模块设计](docs/style/module-design.md#静态化类型化与可分析化)，故删除旧 Note。
- **一次性把剩余 11 个实体主键在单个提交中全部品牌化**：`ChannelId` 与 `AgentId` 贯穿服务端 20 余个模块、前端 `features/` 及测试夹具，单次全量替换审阅面过大；按实体逐个合入并配合 `unbranded-id` 棘轮锁死更稳妥。
- **把文件路径、普通展示文本、Git 分支名等所有字符串全部做成 `Brand`**：仅在跨函数易混传的**持久实体身份**与**受不变量约束的值对象**（端口、正有限数、密钥）上加 `Brand`；给普通文本打品牌只会制造无意义的包装噪音。

## Acceptance criteria

- `ChannelId`、`AgentId`、`TriggerId`、`CronId`、`RunId`、`AttachmentId` 等跨模块主键分批完成品牌化，并纳入 [schema-audit.ts](scripts/audit/schema-audit.ts) 的 `unbranded-id` 硬门禁。
- [pg-generate.ts](apps/server/scripts/pg-generate.ts) 对已登记品牌的主外键自动产出品牌 `Schema`，业务层手工品牌重标代码清零。
- 将 SQL 主外键品牌生成规则沉淀进 [地基](docs/subsystems/foundation.md) 后删除本 Note 并更新 `CATALOG.md`。

## Risks

- **复合语义列不能机械按列名打品牌**：例如 `channel.subject_id` 根据 `subject_kind` 可能是工单或会话，`issue_assignment_execution.executor` 在 `orchestrator` 角色下存档案 ID 而在 `worker` 角色下存 `SessionId`。`pg-generate.ts` 应严格依据真实 `PRIMARY KEY` / `FOREIGN KEY` 约束元数据映射品牌，不应按列名猜测。
