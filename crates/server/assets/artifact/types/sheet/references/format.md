# 工作簿与工作表 Schema 规范（sheet / format）

## 1. 单工作表 `structure/sheets/<id>.json`

```json
{
  "id": "q3-budget",
  "title": "Q3 明细",
  "sourceAsset": "asset/raw-transactions.csv",
  "freeze": { "rows": 1, "cols": 1 },
  "columns": [
    { "key": "item", "label": "项目", "type": "string", "width": 220 },
    { "key": "category", "label": "分类", "type": "enum", "options": ["Compute", "Storage", "License"], "width": 120 },
    { "key": "q2", "label": "Q2 实际", "type": "number", "format": "currency" },
    { "key": "q3", "label": "Q3 预算", "type": "number", "format": "currency" },
    { "key": "delta", "label": "环比变化", "type": "formula", "format": "percent" }
  ],
  "rows": [
    {
      "id": "r_01",
      "cells": {
        "item": { "v": "GPU 推理集群" },
        "category": { "v": "Compute" },
        "q2": { "v": 42000 },
        "q3": { "v": 51000 },
        "delta": { "f": "=IFERROR((D2-C2)/C2, 0)" }
      }
    }
  ],
  "summaryRow": {
    "item": { "v": "合计" },
    "q2": { "f": "=SUM(C2:C2)" },
    "q3": { "f": "=SUM(D2:D2)" },
    "delta": { "f": "=IFERROR((D3-C3)/C3, 0)" }
  },
  "conditionalFormats": [
    { "column": "delta", "when": "gt", "value": 0.2, "tone": "warning" }
  ]
}
```

## 2. 单元格与数据类型规则

- 单元格对象支持：
  - `v`：原始值（`string | number | boolean | null`），不可把带千分位或币种符号的字符串放进 `number` 列。
  - `f`：以 `=` 开头的标准公式（支持 `SUM`、`AVERAGE`、`MIN`、`MAX`、`MEDIAN`、`COUNT`、`COUNTA`、`IF`、`IFERROR`、`SUMIF`、`COUNTIF`、`XLOOKUP`、跨表引用 `sheetId!A1:B10`）。
  - `note`：可选单元格批注（解释异常数据来源或业务口径）。
- 稳定行 ID（`rows[].id`）：采用永不复用的短 ID（如 `r_01`），确保插入/排序行时并发编辑、批注与 `artifact_suggestion` 定位不漂移。

## 3. CSV 资产互通

- 当原始数据超过数百行或来自外部系统导出时，将原件保存为 `asset/<name>.csv` 并在工作表设置 `sourceAsset: "asset/<name>.csv"`。
- 清洗或派生表放在独立的 `structure/sheets/*.json` 中，不破坏 `asset/*.csv` 原始凭证。
