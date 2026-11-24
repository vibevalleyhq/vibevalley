# docs 结构规范与原生交互块（docs / structure）

## 1. 目录与 `manifest.json` 约定

- `manifest.json` 维护章节顺序（`sections`）与入口（`entry`），新增章节文件后在同一协作事务中更新 `sections` 列表。
- 章节文件命名采用两位序号加 kebab-case 短名（如 `structure/01-goals.md`、`structure/02-api-contract.md`、`structure/03-rollout.md`），保持目录自然有序。
- `asset/` 下按用途归类（如 `asset/diagrams/`、`asset/screenshots/`），Markdown 内一律写相对路径 `![说明](asset/screenshots/flow.png)`。

## 2. 并发编辑与建议流工作法

- **读后改**：先拉取 `artifact_collab` 最新协作视图与实时在场光标，确认目标章节无冲突热点。
- **分区并行**：多个执行会话共同撰写长方案时，由协调者或分工约定每人负责不同 `structure/0x-*.md`；共享 `index.md` 摘要最后收口。
- **审阅优先**：修改用户刚写下的需求、结论或验收标准时，发起 `artifact_suggestion`（附简洁修改理由），等待用户一键接受或拒绝。
- **里程碑快照**：评审前、定稿后各打一个 `artifact_version` 快照，保留可追溯的目录基线；若某轮自动化改写偏离预期，用 `artifact_change` 按 `origin` 精准撤销该轮改动。

## 3. 原生 `chart` 与 `genui` 围栏块

在 `structure/*.md` 中可直接放入两种原生渲染代码块：

- **数据图表（```` ```chart ````）**：支持 `bar` | `line` | `area` | `scatter` | `bubble` | `pie` | `donut` | `combo` | `heatmap` | `boxplot` | `histogram` | `sparkline`，可选 `subtitle`、`xAxis`、`yAxis`、`legend`、`annotations`：
  ```json
  {
    "type": "bar",
    "title": "每周交付吞吐",
    "categories": ["W1", "W2", "W3", "W4"],
    "series": [{ "name": "已完成", "data": [6, 9, 12, 15] }],
    "showValues": true
  }
  ```
- **交互式声明 UI（```` ```genui ````）**：适合预算试算、容量估算、参数敏感性分析。顶层字段 `title`、`root_id`、`state`、`nodes`（容器 `stack`/`grid`/`card`/`tabs` 经 `children` 引用子节点；控件 `slider`/`switch`/`select`/`tabs` 用 `bind` 双向绑定 `state`；展示节点 `metric`/`text`/`badge`/`progress`/`callout`/`table`/`chart` 用 `{"expr":"..."}` 或 `${expr}` 联动）：
  ```json
  {
    "title": "容量与成本试算",
    "root_id": "root",
    "state": { "seats": 10, "unitPrice": 24 },
    "nodes": [
      { "id": "root", "kind": "stack", "gap": 12, "children": ["seats_in", "total"] },
      { "id": "seats_in", "kind": "slider", "bind": "seats", "label": "席位数", "min": 1, "max": 100, "step": 1 },
      { "id": "total", "kind": "metric", "label": "月度费用", "value": { "expr": "seats * unitPrice" }, "format": "currency" }
    ]
  }
  ```
