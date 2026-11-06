# Agent Note: 边界与 Schema 约束准则、扫描脚本与全仓收敛清单

Status: proposed

## Problem

当前代码虽然广泛使用了 Effect `Schema`，但缺乏统一的边界约束规则与自动化巡检手段。通过 [scripts/schema-audit.ts](scripts/schema-audit.ts) 对 `packages/protocol/src` 与 `apps/server/src` 扫描，共发现 **6 类、65 处** Schema 与边界坏味道：

| 类型代号 | 问题描述 | 扫描命中数 | 典型表现 |
|---|---|---|---|
| `inline-literals` | 内联手抄 `Schema.Literals([...])`，未复用 `*Values` 或原子 Schema | 16 处 | [apps/server/src/tool/schemas.ts](apps/server/src/tool/schemas.ts) 手抄 `["change", "branch", "answer"]`；[packages/protocol/src/mailbox/schema.ts](packages/protocol/src/mailbox/schema.ts) 重复手写 `["dictated", "conversation", "api"]` |
| `inline-union` | `shapes.ts` 内联写 `"a" \| "b"` 字符串联合，未提取枚举常量 | 6 处 | `IssueReportMemory.scope`、`TriggerMeta.voiceMode`、`TriggerMeta.kind`、`PkmEditOp` |
| `optional-enum` | 非 `Update`/`Filter` 结构体将枚举字段标为 `optionalKey`（`?:`） | 20 处 | `Channel.notify?: Notify`、`Memory.author?: ActorKind`、`FactSessionLeft.closed?: SessionClose`、`ArtifactRequest.kind?: ArtifactKind` |
| `tool-downgrade` | 工具层将协议已有的枚举或 Brand ID 降级为裸 `Schema.String` | 15 处 | [apps/server/src/tool/schemas.ts](apps/server/src/tool/schemas.ts) 将 `priority`、`status`、`type`、`parent`、`block` 写成 `Schema.String`，导致业务层再手写 `priorityOf`、`statusOf` |
| `unbranded-id` | 协议内部将已有 Brand ID 的引用字段退化为裸 `string` | 14 处 | `Issue.blockedBy: string[]`（而在 `IssueRequest` 中是 `IssueId[]`）、`Artifact.issue?: string`、`TriggerMeta.issue?: string`、`PkmComment.block: string` |
| `db-wire-coupling` | 存储层直接拿前端协议 Schema 反序列化 SQLite JSON 列 | 4 处 | [apps/server/src/issue/rows.ts](apps/server/src/issue/rows.ts) 直接用 `jsonOrNone(S.PullRequest)`、`jsonOrNone(S.Conflict)` 等解码数据库列 |

## Proposal

确立 **“边界解析，内部信任（Parse at the boundary, trust inside）”** 四条准则，配套 [scripts/schema-audit.ts](scripts/schema-audit.ts) 自动扫描，分批清零存量问题。

### 1. 四条边界与枚举约束准则

1. **枚举非空准则（Enum 必居其一，不滥用 `optional`）**：
   - 闭合枚举代表明确的状态、分类或模式。在实体、事件与创建请求上，枚举字段**不得**声明为 `optionalKey`（如 `Channel.notify` 必为 `"all" | "mentions" | "none"`，默认 `"all"`；`Memory.author` 必为 `ActorKind`；`FactSessionLeft.closed` 必为 `SessionClose`）。
   - **仅允许两类例外**：
     1. 增量修改或过滤请求（`*Update`、`*Filter`）：不传代表“不修改该字段”或“不按该字段过滤”；
     2. 依赖前置生命周期阶段的子状态（如 `Issue.delivered` 仅在 `status === "done"` 时存在，`Issue.canceled` 仅在 `status === "canceled"` 时存在，`Run.outcome` 仅在运行结束后存在）。
2. **枚举单源准则（禁止内联手抄 `Schema.Literals([...])`）**：
   - 凡是跨文件或跨层出现的闭合词集，统一在领域模块定义一次 `*Values = [...] as const` 与对应的原子 `Schema.Literals(*Values)`。
   - HTTP 接口、LLM 工具参数、SQLite `check (col in (...))` 均对齐同一份词集，禁止在 `tool/schemas.ts` 或 `mailbox/schema.ts` 内联手抄字面量数组。
3. **工具与协议同源准则（禁止降级为 `Schema.String`）**：
   - [apps/server/src/tool/schemas.ts](apps/server/src/tool/schemas.ts) 中的枚举字段（`priority`、`status`、`deliver`、`tier`、`type`）直接引用 `@vibevalley/protocol/schema` 导出的原子 Schema 并附加 `.annotate({ description })`，删除业务函数里的 `priorityOf`、`statusOf` 二次解析。
4. **Brand ID 一致性准则**：
   - 既然定义了 `IssueId`、`SessionId`、`ArtifactId`、`BlockId`、`MessageId`，所有指向该实体的外键字段（如 `Issue.blockedBy`、`Artifact.issue`、`TriggerMeta.issue`、`PkmComment.block`）统一使用对应 Brand ID，不退化为裸 `string`。

### 2. 四个正反代码案例

#### 案例 1：工具边界复用枚举 Schema，消除 `tool/issue.ts` 二次校验
- **反例（现状）**：[apps/server/src/tool/schemas.ts](apps/server/src/tool/schemas.ts) 把 `priority`、`status` 写成 `Schema.String`，进了 [apps/server/src/tool/issue.ts](apps/server/src/tool/issue.ts) 再调 `priorityOf(p.priority)`、`statusOf(p.status)` 手动判错。
- **正例（收敛后）**：`tool/schemas.ts` 直接用 `S.Priority.annotate(...)`、`S.IssueStatus.annotate(...)`；模型在 JSON Schema 里直接看到合法 `enum` 列表，业务函数直接拿到 `T.Priority` 强类型。

#### 案例 2：消除实体上的假可选枚举（`optional-enum`）
- **反例（现状）**：
  - [packages/protocol/src/channel/shapes.ts](packages/protocol/src/channel/shapes.ts) 中 `Channel.notify?: Notify`；
  - [packages/protocol/src/memory/shapes.ts](packages/protocol/src/memory/shapes.ts) 中 `Memory.author?: ActorKind`；
  - [packages/protocol/src/session/shapes.ts](packages/protocol/src/session/shapes.ts) 中 `FactSessionLeft.closed?: SessionClose`。
  - 数据库列本身都是 `not null`（如 `channel.notify text not null default 'all'`、`memory.author text not null`、`session.closed`），协议却标成了 `?`，逼迫消费方写 `channel.notify ?? "all"`。
- **正例（收敛后）**：将 `Channel.notify: Notify`、`Memory.author: ActorKind`、`FactSessionLeft.closed: SessionClose` 改为必填枚举，与数据库 `not null` 约束严格一致。

#### 案例 3：外键统一使用 Brand ID（`unbranded-id`）
- **反例（现状）**：[packages/protocol/src/issue/shapes.ts](packages/protocol/src/issue/shapes.ts) 中 `IssueRequest.blockedBy?: IssueId[]` 用了 `IssueId`，但紧挨着的 `Issue.blockedBy: string[]` 却退化成了 `string[]`；`Artifact.issue?: string` 与 `TriggerMeta.issue?: string` 同样退化为 `string`。
- **正例（收敛后）**：统一改为 `IssueId[]` 与 `IssueId`，防止把工单号 `#42` 和工单 UUID 混传。

#### 案例 4：合并重复的内联字面量（`inline-literals` & `inline-union`）
- **反例（现状）**：`"dictated" | "conversation" | "api"` 在 [packages/protocol/src/mailbox/shapes.ts](packages/protocol/src/mailbox/shapes.ts)（2 处）、[packages/protocol/src/mailbox/schema.ts](packages/protocol/src/mailbox/schema.ts)（2 处）、[apps/server/src/mailbox/envelope.ts](apps/server/src/mailbox/envelope.ts)（1 处）和 [apps/server/src/ingress/ingress.ts](apps/server/src/ingress/ingress.ts)（1 处）共手抄了 **6 遍**。
- **正例（收敛后）**：在 `voice` 或 `mailbox` 协议中定义一次 `VoiceModeValues = ["dictated", "conversation", "api"] as const` 与 `VoiceMode = Schema.Literals(VoiceModeValues)`，6 处全部引用同一类型与 Schema。

### 3. 全量扫描清单与分步收敛计划

运行 `node scripts/schema-audit.ts` 可实时输出当前剩余项：

1. **步骤 1（清零 `inline-union` 与 `inline-literals`）**：提取 `VoiceMode`、`GitHubTriggerKind`、`MemoryScope`、`PkmMoveDirection`、`PkmMovePosition`、`CronKind` 等枚举常量与原子 Schema，消除 22 处内联手抄。
2. **步骤 2（清零 `optional-enum` 假可选枚举）**：将数据库 `not null` 或有明确默认值的枚举字段（`Channel.notify`、`Memory.author`、`FactSessionLeft.closed`、`ArtifactRequest.kind`）改为必填枚举；将合法的阶段性可选枚举加入审计脚本白名单并注释原因。
3. **步骤 3（清零 `tool-downgrade`）**：在 [apps/server/src/tool/schemas.ts](apps/server/src/tool/schemas.ts) 中复用协议枚举与 ID Schema（注意同步更新 `testdata/parameters.json` 快照），删掉 [apps/server/src/tool/issue.ts](apps/server/src/tool/issue.ts) 中的手动枚举转换函数。
4. **步骤 4（清零 `unbranded-id`）**：将 `Issue.blockedBy`、`Artifact.issue`、`TriggerMeta.issue`、`PkmBlock.parent`、`PkmComment.block` 等统一收紧为 Brand ID。

## Alternatives considered

- **靠人工 Code Review 盯防枚举退化与可选滥用**：存量已有 60 余处不一致，人工很难在每次改动时记住所有对应的 `*Values` 常量；用 [scripts/schema-audit.ts](scripts/schema-audit.ts) 量化扫描并逐步收紧为 CI 门禁更可靠。
- **一刀切禁止所有 `?` 枚举字段**：像 `IssueUpdate.priority?`（不传代表不改）和 `Issue.delivered?`（未完成工单无交付结论）在业务上确实不存在值，审计脚本必须区分“实体常态属性”与“Patch/阶段条件属性”。

## Acceptance criteria

- `node scripts/schema-audit.ts` 可直接运行并按 6 个类别输出所有待收敛位置。
- 完成步骤 1～4 后，`inline-literals`、`inline-union`、非白名单 `optional-enum`、`tool-downgrade` 与 `unbranded-id` 计数降为 0。
- `vp check --deny-warnings`、`vp test` 与 `vp run docs:verify` 全部通过。

## Risks

- 将 [apps/server/src/tool/schemas.ts](apps/server/src/tool/schemas.ts) 中的 `Schema.String` 收紧为 `S.Priority`、`S.IssueStatus` 后，生成的工具 JSON Schema 会增加 `"enum": [...]` 字段，需同步更新 `apps/server/src/tool/testdata/parameters.json` 黄金快照并确认管家提示词前缀缓存测试通过。
