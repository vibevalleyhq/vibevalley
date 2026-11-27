---
name: base
description: 多维结构化数据库（Base）：支持多 Sheet、筛选/排序/分组/汇总、Table/Board/Gallery/Timeline 多视图，以及对选中行批量派发 Agent 执行列（agentAction）。
tags: [note, database, base]
---

# base：多维数据库与 Agent 执行列

`base` 是 VibeValley 的多维表格与结构化知识库原语，主入口为 `structure/base.json`，用于台账、实验对比、竞品跟踪、需求矩阵与批量 Agent 自动化流水线。

## 核心能力

1. **多视图实时投影**：通过 `note_base_view` 获取经 Rust 端计算的 `BaseViewSnapshot`（筛选 `filters`、排序 `sorts`、分组 `groups`、统计汇总 `summaries`，支持 `table`/`board`/`gallery`/`timeline` 四种视图）。
2. **行级增量写入**：用 `note_base_upsert_row` 新增或更新单行字段，不整表重写 `structure/base.json`。
3. **Agent 执行列（`agentAction`）**：配置含 `promptTemplate` 与 `spawnIssueRepo` 的 `agentAction` 列后，调 `note_base_run_agent_column` 可批量将行上下文渲染为任务，按需派生工单并把执行状态写回目标列。

延伸参考：`note_type_read({ type: "base", reference: "format" })`。
