# dashboard：可溯源数据看板

`dashboard`（`body = "store"`，`artifactType: "dashboard"`）严格把**源数据集**与**展示页面**分离，确保看板上的每一个核心数字都由真实数据算出，并能被工作台的「数据源」抽屉逐项核对。

## 条目结构

- `datasets/<id>`（JSON）：结构化行数组（如 `[{"region":"East","revenue":128000}]`）或 `{ "rows": [...] }`。
- `dash/params`（JSON）：当前筛选器默认值（如 `{"quarter":"all"}`），用户在页面切换筛选器会自动写回。
- `files/index.html`（text）：看板界面与图表脚本（无需写 `<html>`/`<head>` 外壳，沙箱自动注入主题令牌与 `window.dash` 运行时；如需 Chart.js / ECharts / D3，可从白名单 CDN `cdn.jsdelivr.net` 或 `cdnjs.cloudflare.com` 加载，或直接手写响应式 SVG/HTML 图表）。

## `window.dash` 运行时与数据溯源（必守）

1. **严禁心算硬编码数字**：所有汇总指标一律在脚本中调用 `dash.data("<id>")` 与 `dash.calc`（`sum`、`avg`、`min`、`max`、`median`、`count`、`groupBy`、`pctChange`、`formatNumber`、`formatCurrency`、`formatPct`）实时计算渲染。
2. **标注 `[data-source]` 溯源属性**：每个展示核心汇总数字的元素必须带上：
   ```html
   <div id="kpi-rev" data-source="sales" data-field="revenue" data-agg="sum"></div>
   ```
   单行取值用 `data-agg="row" data-row="0"`。渲染完成后调用 `dash.scan()`，工作台会自动核对页面显示值与源表计算值是否一致！
3. **响应数据与筛选变化**：用 `dash.onData(draw)` 与 `dash.onParams(draw)` 注册重绘函数；修改筛选器调 `dash.setParams({ region: "East" })`。

按需延伸阅读：`artifact_type_read({ type: "dashboard", reference: "features" | "design-defaults" })`。
