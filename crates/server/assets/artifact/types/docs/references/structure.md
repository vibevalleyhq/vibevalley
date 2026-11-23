# 文档结构与节奏（docs / structure）

## 常见文档骨架

1. **技术方案 / 设计评审**：背景与问题（1 段）→ 核心方案（分点 + 代码块）→ 权衡与放弃的路 → 验收待办（`todo`）。
2. **调研对比**：一句话选型结论 → 候选方案优劣对照 → 风险与迁移步骤。
3. **会议纪要 / 复盘**：决议清单 → 根因时间线 → 负责人与截止行动项（`todo`）。

## 并发与冲突处理

- 编辑前先用 `artifact_block_list` 拿到最新 `rev`；多块新增/调整顺序用 `artifact_block_batch`。
- 每次 `artifact_block_update`（或 `artifact_block_batch` 中的 `update`）必须携带刚读到的 `baseRev`。
- 若返回 `status: "conflict"`，先读取返回的当前 `text` 与新 `rev`，理解对方改动后再决定是否继续修改，绝不盲目覆盖。

## 何时嵌入 `chart` 与 `genui`

- 只需要呈现静态趋势、分布或对比指标时，优先放一个 `language: "chart"` 代码块，比纯文字表格更易扫读。
- 需要让用户自己拖滑块、切开关或切换场景看指标/图表联动时，放一个 `language: "genui"` 代码块（在 `chart` 节点中可用 `source: { "mode": "reactive", "chart_kind": "bar"|"line", "categories": [...], "series": [{ "name": "...", "values": { "expr": "..." } }] }` 联动状态）。
