# 记性

每个档案（含助手与帮工）拥有一份持久记忆（`Memory`），跨会话、跨仓库、跨重启共享：
- 新回合开始前按当前任务召回相关记忆；回合结束时记下本轮经验与工单摘要。
- 记忆存在本地的库里（`server.db` 的 `memory` 表）；TS 版的外部来源（Nowledge Mem、EverOS）Rust 版没有接。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 档案记忆的增删查、去重、300 条容量淘汰与中英文分词（`gse`） | 召回文本如何拼入会话提示与轨迹事件（[帮工](docs/subsystems/session.md)） |
| 开工前相关性召回（`pick`）及页面「下回想起什么」预览（`memory.recall`） | 单个会话已召回记忆的记录（[帮工](docs/subsystems/session.md)） |
| 助手与帮工共用的记性工具 | 程序性操作手册与技能书（[档案和农机](docs/subsystems/agent.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/vibevalley-server/src/modules/memory/mod.rs` | `Memories`：`memory` 表（`server.db`）的读写、`memory.*` 端点、工单一轮结束时记下的经历 |
| `crates/vibevalley-server/src/modules/memory/rules.rs` | 纯函数：切词、召回评分（`pick`）、去重、淘汰、搜索、出站前脱敏 |
| `crates/vibevalley-server/src/modules/memory/gse.rs` | 简体中文分词（照 gse 的词典与 HMM） |
| `crates/vibevalley-server/src/modules/tool/memory.rs` | 帮工档案的记性工具 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`memory.*`）。

## 模型和不变量

- **所有档案共用 `memory` 表，按档案 ID 归属**：
  - 帮工与助手统一读写 `memory` 表，同档案的多个 `Session` 共享记忆。
  - 用户在界面添加的条目记 `author: "user"`，在助手提示中标为「用户交代」，agent 整理时不得覆盖。
- **两种条目类型（`kind`）与容量上限**：
  - `note`：来自 `issue_report.remember`、`memory_create` 工具或用户手动添加。
  - `issue`：帮工完成工单回合时由服务端自动生成的工单经历（每个 `Session` 更新同一条）。
  - 单条上限 300 字符（UTF-16），每个档案最多保留 300 条，超出时在同一事务内淘汰最久未召回的条目。
- **高重合度自动去重**：同一仓库范围内若已存在完全相同、或分词重合度（`memoryLikeness`）≥ `0.8` 的条目，则跳过不重复记。
- **纯函数评分召回（`pick`，`vibevalley-memory`）**：
  - 排除当前 `Session` 已召回过的 ID 及自己写下的条目；跨仓库条目须共享至少 3 个词才进入候选。
  - 评分公式：`种类分 + 范围分 + min(共有词数, 8)×0.5 + exp(-距上次召回天数 / 30)` 加上文本相关度。
  - 每次召回最多 8 条、总长不超过 1600 字（其中 `issue` 类最多 3 条）。
- **出站强制脱敏**：离开本机的文本先经 `vibevalley-memory` 的脱敏抹掉密钥。

整理档案笔记时，服务在一笔 SQLx 事务中替换 agent 写下的笔记。用户写下的笔记保留。若任一条新笔记未能写入，整组笔记恢复原值。[命名查询](crates/vibevalley-server/src/modules/memory/sql/queries.sql) · [回滚回归](crates/vibevalley-server/tests/memory.rs)

## 怎么走

1. **新回合召回**：开会话（`crates/vibevalley-server/src/modules/agent/drive.rs`）时传入任务文本，召回的拼入 `【你记得的】`。
2. **回合结束记下**：正常结束的回合写入 `note` 与 `issue`。

## 和谁打交道

- **帮工与助手**：工单板开会话时召回、一轮结束时写入；助手把自己的笔记当记忆。
- **笔记（`pkm`）**：共用 `vibevalley-memory` 的切词。

## 为什么这样

- **显式字段提交 + 纯函数分词召回，不调额外模型**：结构化提交省去回合后调模型总结的延迟；`gse` 分词毫秒级完成且可确定性回归。

## 还没做的

- 用户全局画像（`profile`）、完整对话提炼与记忆树真实数据接入：[记忆都存在库里](.agents/notes/proposed/architecture/2026-10-18-profile-and-episode-memories.md)、[记忆树](.agents/notes/proposed/feature/2026-10-22-memory-tree.md)。

## 怎么验证

- `crates/vibevalley-server/src/modules/memory/rules_tests.rs`：切词（对 gse 的 golden）、召回、去重、淘汰与脱敏。
- `crates/vibevalley-server/tests/memory.rs`：记下、搜索、召回与忘掉经端点走一遍。
