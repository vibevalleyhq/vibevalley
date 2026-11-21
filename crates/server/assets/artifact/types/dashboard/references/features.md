# `window.dash` 接口速查（dashboard / features）

- `dash.data(id)` → 返回 `datasets/<id>` 的行数组深拷贝。
- `dash.datasets()` → 返回全部数据集 ID 列表。
- `dash.calc.sum(rows, field)` / `avg` / `min` / `max` / `median` / `count(rows)`
- `dash.calc.groupBy(rows, keyField, valField, "sum" | "avg" | "count")` → `[{ key, value, rows }]`
- `dash.calc.pctChange(curr, prev)` → 百分比变化数值。
- `dash.calc.formatNumber(n, digits)` / `formatCurrency(n, "USD", digits)` / `formatPct(n, digits)`
- `dash.params` / `dash.setParams(patch)` / `dash.resetParams(defaults)`
- `dash.onData(fn)` / `dash.onParams(fn)` / `dash.scan()`
- `dash.colors` → `{ accent, leaf, wheat, berry, water, ink, muted, grid, series: [...] }`（自动适配浅色/深色主题）。
