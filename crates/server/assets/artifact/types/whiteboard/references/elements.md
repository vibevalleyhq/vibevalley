# 白板元素坐标、类型与连线规范（whiteboard / elements）

## 1. 坐标系与增量更新

- 左上角为 `(x, y)`，单位像素，宽高 `w`、`h` 均为正数。
- 移动或改字时通过 `artifact_collab` 只提交变更字段（如仅更新 `elements.n1.x`、`elements.n1.y`），保持元素 `id` 稳定，不覆盖同元素的其他属性。

## 2. 元素类型清单（`structure/board.json` -> `elements[id]`）

- **标题与批注（`type: "text"`）**：
  - `variant`: `"title"`（衬线主视觉标题）| `"subtitle"`（配 `highlight` 短语底衬）| `"callout"`（配 `icon: "⚠"` 标出阻塞或风险）| `"body"`。
- **卡片与几何图形（`type: "shape"`）**：
  - `shape`: `"card"` | `"sticky"` | `"rect"` | `"diamond"` | `"ellipse"` | `"cylinder"` | `"triangle"` | `"pill"`。
  - 字段：`title`、`body`、`badge`、`sticker`、`fill`（`sun` 暖黄、`peach` 暖橘、`leaf` 叶绿、`water` 湖蓝、`lavender` 淡紫、`berry` 莓红、`wheat` 麦色、`side` 灰底、`page` 纯底）。
- **时间线丝带（`type: "timeline"`）**：
  - 包含 `points: [{ x, y }, ...]` 与 `milestones: [{ t, label, kind: "major" | "minor", caption }]`，沿平滑曲线穿过里程碑大胶囊与编号圆点。
- **分区容器（`type: "container"`）**：
  - `title`、`fill`；子元素设置 `"parentId": "<containerId>"` 后随容器联动移动，支持对齐与网格整理（Tidy）。
- **连接器（`type: "arrow"`）**：
  - `curve`: `"smooth"` | `"orthogonal"` | `"straight"`；`style`: `"solid"` | `"dashed"`；`head`: `"arrow"` | `"none"`；`from`/`to` 绑定 `{ id, side: "n" | "s" | "e" | "w" }` 或绝对坐标 `{ x, y }`；可选 `label` 与 `bends`。
- **手绘轨迹（`type: "path"`）**：
  - `mode`: `"pen"` | `"highlighter"`，`points: [{ x, y, pressure }]`，`stroke`、`strokeWidth`。
- **表格、图片与贴纸**：
  - `type: "table"`（`headers`、`rows`）；`type: "image"`（`src: "asset/<name>"`）；`type: "sticker"` 或 `type: "svg"`。
- **施工占座框（`type: "claim"`）**：绘制复杂区域前临时放置提示，完成后移除。

## 3. 交付前核对清单

- [ ] 所有连线的 `from.id`/`to.id` 与容器 `parentId` 均指向存在的元素 ID，无悬空引用。
- [ ] 节点间留白 ≥ `64px`，文字与卡片边框不截断、连线不横穿无关文字。
- [ ] 临时 `claim` 框在完成绘制后已清理，未把实时光标/在场信息写入 `board.json`。
