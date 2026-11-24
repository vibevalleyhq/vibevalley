# Agent Note: 记忆表加上用户画像和干活的经过，相似的新记忆取代旧的

Status: proposed

## Problem

当前 Rust 服务端 `server.db` 的 `memory` 表（[记性](docs/subsystems/memory.md)，[实体定义](crates/server/src/db/entity/memory.rs)）仅包含 `kind`（`note` / `issue`）、`agent`、`body`、`terms`、`repo`、`session` 与召回计数，尚无 `scope`、`title`、`importance` 与 `replaced_by` 列，存在三项缺口：

| 缺项 | 现状 | 问题 |
|---|---|---|
| 用户画像（`profile`） | `kind` 只有 `note`、`issue` 两种，用户偏好记成某个档案名下的 `note` | 帮工和别的助手拿不到用户的全局偏好 |
| 干活经过（`episode`） | 只在会话轨迹里；自研 agent 对话压缩（`AgentEvent::Compacted`，[对话引擎](crates/runtime/src/agent/core/engine.rs)）压掉的部分不进 `memory` 表 | `memory_search` 搜不到历史回合的具体上下文与改动文件 |
| 相似取代 | 没有 `replaced_by` 列；重合度 ≥ `0.8` 的新条目直接跳过 | 用户改了偏好，新说法记不进去，旧说法一直被召回 |

## Proposal

| 新增 `kind` | 含义 | 范围 | 写入时机 |
|---|---|---|---|
| `profile` | 关于用户的事实与偏好 | 全农场共享（`scope = user`） | 用户添加、助手或帮工提交用户偏好 |
| `episode` | 单轮任务经过（说明、汇报、改动文件），以及助手对话被压缩掉的部分 | 归属对应档案 | 会话收工时、自研 agent 压缩助手对话时 |

1. **表结构**：在 `crates/server/src/db/schema/team_memory.sql` 为 `memory` 表增加 `scope`（`user` / `agent`）、`title`、`importance`（0–3）与 `replaced_by` 列，扩展 `kind` 支持 `profile`、`episode`；召回查询只读 `replaced_by is null` 的行，并重跑 `sqlc generate`。
2. **用户画像（`profile`）**：助手开始和压缩后按 `importance` 降序读取（上限 100 条 / 4000 字）拼入系统提示；帮工首轮拼入输入开头。
3. **干活经过（`episode`）**：收工时写入工单标题、说明、汇报与改动文件（上限 4000 字）。助手的对话在 [compaction](crates/runtime/src/agent/compaction/mod.rs) 完成压缩并写出 `Compacted` 摘要时，同步将该次压掉的摘要写入一条 `episode`。`episode` 只给 `memory_search` 检索摘录，不进开工自动召回。
4. **相似取代（`replaced_by`）**：新写入的 `note` 与已有条目分词重合度 ≥ `0.8` 时，在同一 SQLx 事务内插入新行并把旧行 `replaced_by` 指向新行；旧行不再召回，保留 30 天供界面对比。

## Alternatives considered

- **本地接入向量检索（embedding）**：需额外部署本地模型或调用付费接口；本地继续沿用 `modules/memory/gse.rs` 分词与评分检索即可满足个人工作台规模。
- **检索 `episode` 时再调一次模型总结**：每次搜索多花一轮模型费用；直接返回命中位置前后的原文摘录已足够定位。
- **压缩掉的对话另存成文件**：文件只能按名字列和全文扫，搜不进 `memory_search`，也不随库备份；存进 `memory` 表和别的记忆走同一套检索。

## Acceptance criteria

- `profile` 条目对全农场所有助手与帮工可见；单档案的 `note` 仍按档案隔离。
- 写入高重合度新记忆时旧条目被标上 `replaced_by`，不再被 `pick` 召回。
- `memory_search` 指定 `kind = "episode"` 可检索帮工历史回合与助手对话被压缩掉的部分。

## Risks

- 全局共享的 `profile` 若写入错误偏好会影响所有帮工，需在界面将用户画像单独分组以便审阅和删除。
- 对话压缩摘要结构调整时需保持与 `episode` 写入边界同步，写入失败只记日志、不阻断对话主链路。
