# 记性

每个档案（含管家与帮工）拥有一份持久记忆（`Memory`），跨会话、跨仓库、跨重启共享：
- 新回合开始前按当前任务召回相关记忆；回合结束时记下本轮经验与工单摘要。
- 记忆默认存在本地的库里，可双向同步 Nowledge Mem 与 EverOS。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 档案记忆的增删查、去重、300 条容量淘汰与中英文分词（`gse` + FTS5） | 召回文本如何拼入会话提示与轨迹事件（[帮工](docs/subsystems/session.md)） |
| 开工前相关性召回（`pick`）及页面「下回想起什么」预览（`memory.recall`） | 单个 `Session` 已召回记忆 ID 的记录（`session.recalled` 列，[帮工](docs/subsystems/session.md)） |
| 本地的库与 Nowledge Mem、EverOS 并发读取、按名次合并与后台异步写入 | 外部来源地址与密钥在 `settings.json` 中的保存与校验（[设置和配置](docs/subsystems/setting.md)） |
| 管家与帮工共用的 `MemoryPort` 及管家压缩归档（`archive/`）读取 | 程序性操作手册与技能书（[档案和农机](docs/subsystems/agent.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/memory/memory.ts` | `Memory` 服务、`MemoryPort` 实现、`memory` 表与它的全文索引（`term_vector`）读写 |
| `apps/server/src/memory/recall.ts` | 纯函数评分挑选（`pick`）与检索排序 |
| `apps/server/src/memory/gse.ts` | 简体中文分词与英文整词提取（`termsList`） |
| `apps/server/src/memory/sources.ts` | 多记忆来源聚合、2 秒读超时与后台异步写队列 |
| `apps/server/src/memory/nowledge.ts`、`everos.ts` | Nowledge Mem（MCP）与 EverOS（HTTP）外部来源适配器 |
| `apps/web/src/features/memory/Memory.tsx`、`tree/` | 工作台「记忆」页与记忆树视图 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`memory.*`、`orchestrator.archive.*`）。

## 模型和不变量

- **所有档案共用 `memory` 表，按档案 ID 归属**：
  - 帮工与管家统一读写 `memory` 表，同档案的多个 `Session` 共享记忆。
  - 主人在界面添加的条目记 `author: "owner"`，在管家提示中标为「主人交代」，agent 整理时不得覆盖。
- **两种条目类型（`kind`）与容量上限**：
  - `note`：来自 `issue_report.remember`、`memory_create` 工具或主人手动添加。
  - `issue`：帮工完成工单回合时由服务端自动生成的工单经历（每个 `Session` 更新同一条）。
  - 单条上限 300 字符（UTF-16），每个档案最多保留 300 条，超出时在同一事务内淘汰最久未召回的条目。
- **高重合度自动去重**：同一仓库范围内若已存在完全相同、或分词重合度（`memoryLikeness`）≥ `0.8` 的条目，则跳过不重复记。
- **纯函数评分召回（`pick`）**：
  - 排除当前 `Session` 已召回过的 ID 及自己写下的条目；跨仓库条目须共享至少 3 个词才进入候选。
  - 评分公式：`种类分 + 范围分 + min(共有词数, 8)×0.5 + min(bm25, 5)×0.3 + exp(-距上次召回天数 / 30)`。
  - 每次召回最多 8 条、总长不超过 1600 字（其中 `issue` 类最多 3 条）。
- **外部来源读限时、写异步，出站强制脱敏**：
  - 读取时本地库与外部来源并发查询，外部来源限时 2 秒；超时或失败只记日志，多来源结果按名次交错抽取并去重。
  - 写入时本地库当场落盘，外部来源放入后台队列串行发送；所有出站文本均经 `base/redact.ts` 抹除密钥。

## 怎么走

1. **新回合召回（`Memory.recall`）**：`Session` 传入任务文本与已召回 ID；`Memory` 合并本地与外部结果并更新 `recalled` 计数，拼入 `【你记得的】`。
2. **回合结束记下（`Memory.write` / `Memory.keep`）**：正常结束的回合写入 `note` 与 `issue` 并推入外部后台队列；会话离场时触发 EverOS `memory/flush`。

## 和谁打交道

- **帮工与管家（`session`、`orchestrator`）**：`Session` 在回合前后调用 `recall`、`write`、`keep`、`endSession`，并为管家注入 `MemoryPort`。
- **笔记与设置（`pkm`、`setting`）**：向 `Pkm` 提供 `termsList` 分词；从 `Setting` 读取 `memorySources` 配置。

## 为什么这样

- **显式字段提交 + 纯函数分词召回，不调额外模型**：结构化提交省去回合后调模型总结的延迟；`gse` 分词加 Postgres 全文索引毫秒级完成且可确定性回归。
- **多来源按名次轮流合并，慢来源不挡干活**：本地评分与外部向量量纲不同，按名次交错最稳妥；2 秒读超时与异步写队列隔离外部故障。

## 还没做的

- 主人全局画像（`profile`）、完整对话提炼与记忆树真实数据接入：[记忆都存在库里](.agents/notes/proposed/architecture/2026-10-18-memory-in-sqlite.md)、[记忆树](.agents/notes/proposed/feature/2026-10-22-memory-tree.md)。

## 怎么验证

- `apps/server/src/memory/*.test.ts`：分词与召回黄金数据、重合去重、容量淘汰、多来源超时隔离与出站脱敏测试。
- `apps/server/src/flows/memory.test.ts`：跨会话、跨仓库、跨重启的记忆写入与不重复召回流程测试。
