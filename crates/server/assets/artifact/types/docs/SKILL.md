# docs：协作文档

`docs` 面向人与帮工共同撰写、反复修订的结构化长文（方案、复盘、调研、手册）。存储形态为 `body = "blocks"`（`artifact_create` 传 `artifactType: "docs"` 或 `kind: "markdown"`）。

## 核心工作流

1. **创建**：`artifact_create({ title, artifactType: "docs", content })` 一次导入初始 Markdown 块树，或省略 `content` 先建空文档再逐块写入。
2. **局部修订（严禁整篇重写）**：
   - 先用 `artifact_block_list({ id })` 读最新块 ID、层级与 `rev`（或查看 `<artifact-view-context>` 里的 `selectedBlockIds`）。
   - 多步改动优先用 `artifact_block_batch({ id, ops })` 一次提交 `create`（可用 `tempId` 让同批后续操作引用）/ `update`（带 `baseRev`）/ `move` / `delete`；单步改动也可直接调 `artifact_block_create`、`artifact_block_update`、`artifact_block_delete`。
3. **尊重用户手写的块**：帮工对用户亲手写过的块调用 `artifact_block_update` / `delete` 或 `artifact_block_batch` 修改时，服务端会自动转为一条待确认建议（`suggestion`），不要反复硬写同一块。

## 原生可视化与交互块（`chart` / `genui`）

`docs` 中的代码块支持两种纯原生渲染器（用 `type: "code"`、`language: "chart"` 或 `"genui"`，或初始 Markdown 中用围栏代码块）：

- **数据图表（```` ```chart ````）**：放入合法 JSON（`type`: `bar` | `line` | `area` | `scatter` | `bubble` | `pie` | `donut` | `combo` | `heatmap` | `boxplot` | `histogram` | `sparkline`；可选 `subtitle`、`xAxis`、`yAxis`、`legend`、`annotations`）：
  ```json
  {"type":"bar","title":"周吞吐量","categories":["W1","W2","W3"],"series":[{"name":"完成","data":[6,9,12]}],"showValues":true}
  ```
- **交互式声明 UI（```` ```genui ````）**：适合预算试算、参数对比、迷你仪表盘。顶层字段 `title`、`root_id`、`state`（初始状态字典）、`nodes`（扁平节点表，布局容器经 `children` 引用节点 ID；控件 `slider`/`switch`/`select`/`tabs` 用 `bind` 双向绑定 `state`；展示节点 `metric`/`text`/`badge`/`progress`/`callout`/`table`/`chart` 用 `{"expr":"..."}` 或 `${expr}` 响应变化）：
  ```json
  {"title":"成本试算","root_id":"root","state":{"seats":5,"price":20},"nodes":[{"id":"root","kind":"stack","gap":12,"children":["seats_in","total"]},{"id":"seats_in","kind":"slider","bind":"seats","label":"席位数","min":1,"max":50,"step":1},{"id":"total","kind":"metric","label":"月度成本","value":{"expr":"seats * price"},"format":"currency"}]}
  ```

## 写作与版式准则

- **结论先行**：首段用 2–3 句说清核心判断或决定，不堆砌寒暄铺垫。
- **扫读节奏**：每 3–5 段用二级/三级标题分段；并列要点超过 3 项改用 `bulleted` / `numbered`；行动项用 `todo`；关键警示或原话用 `quote`。
- **行内标记**：善用 `**加粗**` 标出句首锚点词，代码、路径、配置项一律用 `` `code` ``。

按需延伸阅读：`artifact_type_read({ type: "docs", reference: "structure" })`。
