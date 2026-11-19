# 看板排版准则（dashboard / design-defaults）

- **首屏结构**：顶部标题与全局筛选栏 → 3–4 张核心 KPI 卡片（大号等宽数字 `tabular-nums` + 对比基准）→ 主趋势图/结构对比图 → 明细排行表。
- **克制用色**：同一张图不超过 4 条序列色（优先取 `dash.colors.series`），涨跌用语义色（`dash.colors.leaf` / `dash.colors.berry`），背景使用 `var(--vv-page)` 与 `var(--vv-side)`。
- **空态兜底**：筛选结果为空行时渲染清晰的「当前筛选条件下无记录」提示与重置按钮。
