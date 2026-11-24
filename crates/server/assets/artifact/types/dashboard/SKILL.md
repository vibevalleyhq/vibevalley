# dashboard：可溯源数据看板

`dashboard` 严格把**源数据集**与**看板布局配置**分离，确保看板上展示的每一个 KPI 与图表序列均由真实数据实时计算，并支持字段级数据溯源核对、筛选器持久化与 CSV 导出。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`）。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json               # id、artifactType: "dashboard"、title、entry: "structure/dashboard.json"
├── structure/
│   ├── dashboard.json          # 筛选器、KPI 卡片、图表组件、表格布局与字段溯源绑定
│   └── data/
│       ├── revenue.json        # 结构化行数据集（rows + schema + source 元信息）
│       └── funnel.json
└── asset/
    └── raw-export.csv          # 可选原始数据附件或口径说明图，按 asset/<name> 引用
```

`structure/dashboard.json` 最小示例：
```json
{
  "title": "Q3 经营看板",
  "filters": [{ "id": "region", "label": "区域", "type": "select", "options": ["all", "East", "West"], "default": "all" }],
  "panels": [
    {
      "id": "kpi_rev",
      "kind": "kpi",
      "label": "总营收",
      "source": { "dataset": "structure/data/revenue.json", "field": "revenue", "agg": "sum" },
      "format": "currency"
    },
    {
      "id": "trend_rev",
      "kind": "chart",
      "chartType": "line",
      "source": { "dataset": "structure/data/revenue.json", "x": "month", "y": "revenue", "seriesBy": "region" }
    }
  ]
}
```

## 多人与多执行会话实时协作规则

1. **数据与视图解耦同步（`artifact_collab`）**：数据更新写入 `structure/data/*.json`，布局与图表配置写入 `structure/dashboard.json`，通过 `artifact_collab` 实时无冲突合并并落盘；多个执行会话可并行刷新不同数据集或调整不同 `panels` 卡片而不互相覆盖。
2. **来源追踪与口径审计（`artifact_change`）**：每次数据集刷新与指标口径修改均记入 `artifact_change`（附 `origin`），支持回放历史口径变化、按来源回滚异常导入；月度/季度汇报前用 `artifact_version` 冻结不可变目录快照。
3. **口径审阅建议（`artifact_suggestion`）**：修改用户已确认的指标公式、聚合口径或删改 KPI 面板时，通过 `artifact_suggestion` 发起审阅建议，由用户接受后再生效。
4. **实时在场感知（Presence）**：先查看其他协作者聚焦的面板 ID 或数据集文件；用户在界面临时切换筛选器仅作用于个人视图，不随意改写共享 `filters[].default` 干扰他人。

## 数据溯源铁律

- **严禁心算硬编码数字**：所有 KPI、环比与图表序列必须通过 `source` 绑定到 `structure/data/*.json` 的具体字段与聚合函数（`sum`/`avg`/`min`/`max`/`median`/`count`/`pctChange`），供工作台实时校验显示值与源表一致。
- **清晰标注空态与口径**：每个数据集记录 `schema` 与 `updatedAt`；筛选后无数据时提供清晰空态与一键重置筛选提示。

按需延伸阅读：`artifact_type_read({ type: "dashboard", reference: "features" | "design-defaults" })`。
