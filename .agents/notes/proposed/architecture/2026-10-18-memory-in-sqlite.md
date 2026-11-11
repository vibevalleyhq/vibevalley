# Agent Note: 记忆都存在农场的库里：用户画像和干活的经过进 memory 表

Status: proposed

## Problem

当前 Postgres `memory` 表（[记性](docs/subsystems/memory.md)）只有按档案隔离的 `note` 和 `issue` 两种条目，还缺两样：

| 缺项 | 现状 | 问题 |
|---|---|---|
| 用户画像（`profile`） | 记在单个助手名下 | 帮工与其他助手拿不到用户的全局偏好 |
| 干活经过（`episode`） | 散在事件轨迹与助手 `archive/` 文件里 | `memory_search` 搜不到历史回合的具体上下文与改动文件 |

## Proposal

| 新增 `kind` | 含义 | 范围 | 写入时机 |
|---|---|---|---|
| `profile` | 关于用户的事实与偏好 | 全农场共享（`scope = user`） | 用户添加、助手或帮工提交用户偏好 |
| `episode` | 单轮任务经过（说明、汇报、改动文件）及助手压缩归档切片 | 归属对应档案 | 会话收工时、助手上下文压缩时 |

1. **表结构**：在 `0001_schema.up.sql` 的 `memory` 表扩展 `kind`（加入 `profile`、`episode`），增加 `title`、`importance`（0–3）与 `replaced_by`。
2. **用户画像（`profile`）**：助手启动和压缩后按 `importance` 降序读取（上限 100 条 / 4000 字）拼入系统提示；帮工首轮拼入输入开头。
3. **干活经过（`episode`）**：收工时写入工单标题、说明、汇报与改动文件（上限 4000 字），助手压缩时也将切片写入；`episode` 仅用于 `memory_search` 检索摘录，不进入开工自动召回。
4. **相似取代（`replaced_by`）**：新写入 `note` 与已有条目重合度 ≥ `0.8` 时，同事务插入新行并将旧行 `replaced_by` 指向新行；旧行不再召回，保留 30 天供界面对比。

## Alternatives considered

- **本地接入向量检索（embedding）**：需额外部署本地模型或调用付费接口；外部记忆源已提供语义检索，本地保持 Postgres `term_vector` / `term_query` 分词检索。
- **检索 `episode` 时再调一次模型总结**：每次搜索多花一轮模型费用；直接返回命中位置前后的原文摘录已足够定位。

## Acceptance criteria

- `profile` 条目对全农场所有助手与帮工可见；单档案的 `note` 仍按档案隔离。
- 写入高重合度新记忆时自动标记旧条目 `replaced_by`，旧条目不再被 `pick` 召回。
- `memory_search` 指定 `kind = "episode"` 可检索帮工历史回合与助手压缩归档片段。

## Risks

- 全局共享的 `profile` 若写入错误偏好会影响所有帮工，需在界面将用户画像单独分组以便审阅和删除。
