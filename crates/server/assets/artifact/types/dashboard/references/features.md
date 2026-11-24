# 数据集契约、聚合函数与溯源规则（dashboard / features）

## 1. 数据集文件 `structure/data/<id>.json`

```json
{
  "id": "revenue",
  "title": "月度区域营收",
  "updatedAt": "2026-11-24T10:00:00Z",
  "sourceRef": "asset/raw-export.csv",
  "schema": [
    { "name": "month", "type": "string" },
    { "name": "region", "type": "string" },
    { "name": "revenue", "type": "number", "unit": "USD" },
    { "name": "orders", "type": "number" }
  ],
  "rows": [
    { "month": "2026-07", "region": "East", "revenue": 128000, "orders": 42 },
    { "month": "2026-07", "region": "West", "revenue": 96000, "orders": 31 }
  ]
}
```

## 2. 支持的聚合与格式化

- 聚合函数（`source.agg`）：`sum`、`avg`、`min`、`max`、`median`、`count`、`row`（配合 `rowIndex` 取单行）、`pctChange`（配合 `compareField` 或 `comparePeriod` 计算同比/环比）。
- 分组查询（`groupBy`）：指定 `keyField`、`valField` 与 `agg`（`"sum" | "avg" | "count"`），输出排序后的分类序列供柱状图、折线图或明细表消费。
- 数值格式（`format`）：`number`、`currency`（指定币种与小数位）、`percent`、`compact`（如 `1.8M`）。
- 筛选联动（`filters`）：所有 `panels` 声明 `filterBindings`（如 `{ "region": "region" }`），切换筛选器时实时重算指标并同步触发工作台数据溯源校验。

## 3. 并发刷新与冲突规避

- 刷新数据优先只更新目标 `structure/data/<id>.json` 的 `rows` 与 `updatedAt`，不动 `structure/dashboard.json` 中的视觉布局。
- 调整图表配色或排版时只修改目标 `panel` 对象（保持 `panel.id` 稳定），避免破坏协作者的聚焦状态与 `artifact_suggestion` 锚点。
