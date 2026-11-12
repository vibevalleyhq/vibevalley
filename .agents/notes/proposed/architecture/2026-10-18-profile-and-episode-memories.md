# Agent Note: 记忆表加上用户画像和干活的经过，相似的新记忆取代旧的

Status: proposed

## Problem

`memory` 表（[记性](docs/subsystems/memory.md)，[0001_schema.up.sql](apps/server/db/migrations/0001_schema.up.sql)）已经有 `scope`（`user` / `agent`）、`title`、`importance`（0–3）和 `replaced_by` 列，召回的查询（[memory.sql](apps/server/db/queries/memory.sql)）也只读 `replaced_by is null` 的行。还缺三样：

| 缺项 | 现状 | 问题 |
|---|---|---|
| 用户画像（`profile`） | `kind` 只有 `note`、`issue` 两种，用户的偏好记成某个档案名下的 `note` | 帮工和别的助手拿不到用户的全局偏好 |
| 干活经过（`episode`） | 只在会话轨迹里；助手对话被 pi-durable 压缩（`pi.compaction`）后，压掉的部分不进 `memory` 表 | `memory_search` 搜不到历史回合的具体上下文与改动文件 |
| 相似取代 | 没有代码写 `replaced_by`；重合度 ≥ `0.8` 的新条目直接跳过 | 用户改了偏好，新说法记不进去，旧说法一直被召回 |

## Proposal

| 新增 `kind` | 含义 | 范围 | 写入时机 |
|---|---|---|---|
| `profile` | 关于用户的事实与偏好 | 全农场共享（`scope = user`） | 用户添加、助手或帮工提交用户偏好 |
| `episode` | 单轮任务经过（说明、汇报、改动文件），以及助手对话被压缩掉的部分 | 归属对应档案 | 会话收工时、pi-durable 压缩助手对话时 |

1. **表结构**：`0001_schema.up.sql` 里 `memory.kind` 的 `check` 加入 `profile`、`episode`。
2. **用户画像（`profile`）**：助手开始和压缩后按 `importance` 降序读取（上限 100 条 / 4000 字）拼入系统提示；帮工首轮拼入输入开头。
3. **干活经过（`episode`）**：收工时写入工单标题、说明、汇报与改动文件（上限 4000 字）。助手的对话由 pi-durable 压缩（[durable.ts](apps/server/src/modules/runtime/durable.ts) 的 `compaction` 设置）；[host.ts](apps/server/src/modules/session/host.ts) 读到 `pi.compaction` 条目时，把这次压掉的摘要写成一条 `episode`。`episode` 只给 `memory_search` 检索摘录，不进开工自动召回。
4. **相似取代（`replaced_by`）**：新写入的 `note` 与已有条目重合度 ≥ `0.8` 时，同一事务插入新行并把旧行 `replaced_by` 指向新行；旧行不再召回，保留 30 天供界面对比。

## Alternatives considered

- **本地接入向量检索（embedding）**：需额外部署本地模型或调用付费接口；外部记忆源已提供语义检索，本地保持 Postgres `term_vector` / `term_query` 分词检索。
- **检索 `episode` 时再调一次模型总结**：每次搜索多花一轮模型费用；直接返回命中位置前后的原文摘录已足够定位。
- **压缩掉的对话另存成文件**：文件只能按名字列和全文扫，搜不进 `memory_search`，也不随库备份；存进 `memory` 表和别的记忆走同一套检索。

## Acceptance criteria

- `profile` 条目对全农场所有助手与帮工可见；单档案的 `note` 仍按档案隔离。
- 写入高重合度新记忆时旧条目被标上 `replaced_by`，不再被 `pick` 召回。
- `memory_search` 指定 `kind = "episode"` 可检索帮工历史回合与助手对话被压缩掉的部分。

## Risks

- 全局共享的 `profile` 若写入错误偏好会影响所有帮工，需在界面将用户画像单独分组以便审阅和删除。
- `pi.compaction` 条目里的摘要格式归 pi-durable，升级时可能变；写 `episode` 前在边界解码，解码失败只记日志、不挡对话。
