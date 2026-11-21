# 元素坐标、排版与连线规范（whiteboard / elements）

- **坐标系**：左上角为 `(x, y)`，单位像素，宽高 `w`、`h` 为正数。
- **局部更新**：移动或改字优先发 `{ op: "patch", path: "elements/n1", value: "{\"x\":240,\"y\":180}", ifRev: 1 }`，不覆盖其它字段；改尺寸同时传 `w`、`h`。
- **标题与批注（`text`）**：
  - `variant: "title"` 用衬线大标题建立页面主视觉（典型 `w: 680, h: 48`）。
  - `variant: "subtitle"` 配 `highlight` 字段给关键指标/天数加浅色底衬突出。
  - `variant: "callout"` 配 `icon: "⚠"` 与指向目标节点的 `arrow`，表达阻塞或待确认项。
- **卡片与色彩语义**：
  - 优先使用 `shape: "card"` 搭配 `title`（加粗标题）+ `body`（副说明），顶部挂内置 `sticker` 让重点步骤一目了然。
  - 色彩：`sun`（暖黄步骤）、`peach`（暖橘高亮节点/交接）、`leaf`（通过/核心流程）、`water`（数据/外部系统）、`lavender`（设计/灵感）、`berry`（阻塞/风险）、`side`/`page`（中性背景）。
- **连线曲率**：
  - 节点关联或时间线引线优先用 `"curve": "smooth"`；时间线卡片指到丝带时可设 `"head": "none"` 保持干净；架构拓扑图按需使用 `"orthogonal"`。
