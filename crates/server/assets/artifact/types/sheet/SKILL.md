# sheet：多工作表数据表格与数据集

`sheet` 面向预算测算、排期表、对比矩阵、指标台账与结构化数据集。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`），工作簿元信息存于 `structure/workbook.json`，每张工作表独立存于 `structure/sheets/*.json`，原始导入或导出的 CSV 归档于 `asset/*.csv`。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json                 # id、artifactType: "sheet"、title、entry: "structure/workbook.json"
├── structure/
│   ├── workbook.json             # 工作表顺序、命名区域、币种/小数格式与全局校验规则
│   └── sheets/
│       ├── summary.json          # 汇总表（含跨表公式、冻结行列与条件格式）
│       └── q3-budget.json        # 明细表（列定义 + 稀疏/行结构单元格）
└── asset/
    └── raw-transactions.csv      # 原始 CSV 源数据或快照导出，按 asset/<name>.csv 引用
```

`structure/workbook.json` 示例：
```json
{
  "title": "Q3 研发预算测算",
  "locale": "zh-CN",
  "currency": "CNY",
  "sheets": [
    { "id": "summary", "title": "总览", "file": "structure/sheets/summary.json" },
    { "id": "q3-budget", "title": "Q3 明细", "file": "structure/sheets/q3-budget.json" }
  ],
  "namedRanges": { "TotalBudget": "q3-budget!D2:D25" }
}
```

## 多人与多执行会话实时协作规则

1. **单元格级并发同步（`artifact_collab`）**：每张工作表独立文件、单元格按稳定行/列键存储，多人与多执行会话可同时填写不同工作表或不同单元格，通过 `artifact_collab` 无冲突合并并写回目录文件；**严禁为改几行数据整表重写覆盖他人的实时输入**。
2. **来源追踪与公式审计（`artifact_change`）**：每次单元格赋值、公式修改与批量导入均记录 `origin`，支持回放历史数值变化、按来源撤销某次批量填充或分叉假设情景；财报/评审切点通过 `artifact_version` 生成不可变目录快照。
3. **审阅建议流（`artifact_suggestion`）**：修改用户亲手输入的假设参数、公式或删除已有数据行时，通过 `artifact_suggestion` 提议修改（附原值、新值与影响说明），由用户接受或拒绝。
4. **实时在场感知（Presence）**：编辑前先检查协作者当前选中的工作表与单元格范围（active range），避开用户正在编辑的单元格或公式栏，优先在独立工作表或未占用列操作。

## 表格建模铁律

- **原始输入与计算公式分离**：汇总、占比、同比一律写显式公式（如 `=SUM(D2:D25)`、`=IFERROR((C2-B2)/B2, 0)`），绝不把心算结果硬编码为静态数字覆盖公式。
- **类型一致，禁止脏字符串**：数值列存原生 JSON `number`（格式交由列 `format` 控制），日期统一 ISO-8601（`YYYY-MM-DD`），大批量源表优先保存原始文件于 `asset/*.csv` 并在工作表元信息中标注 `sourceAsset`。

按需延伸阅读：`artifact_type_read({ type: "sheet", reference: "format" | "craft" })`。
