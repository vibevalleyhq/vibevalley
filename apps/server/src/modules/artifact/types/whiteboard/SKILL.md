# whiteboard：无限白板与架构画布

`whiteboard`（`body = "store"`，`artifactType: "whiteboard"`）由工作台原生渲染无限平移缩放画布，人与帮工可按元素 ID 并发新增、拖拽、连线与局部修订，适合系统架构图、业务泳道、头脑风暴与概念关系图。

## 条目结构

- `board/meta`（JSON）：`{ "title": "...", "mode": "board", "grid": true }`
- `elements/<id>`（JSON）：每个画布元素一条独立记录，局部挪动或改字用 `artifact_entry_batch` 的 `patch`（带 `ifRev`）：
  - **几何图形（`type: "shape"`）**：`{ "id": "n1", "type": "shape", "shape": "rect" | "sticky" | "diamond" | "ellipse", "x": 120, "y": 140, "w": 200, "h": 84, "label": "网关层", "fill": "leaf" | "water" | "wheat" | "berry" | "neutral" }`
  - **分区容器（`type: "container"`）**：`{ "id": "z1", "type": "container", "x": 80, "y": 80, "w": 640, "h": 360, "label": "核心服务边界", "fill": "neutral" }`
  - **正交折线箭头（`type: "arrow"`）**：`{ "id": "e1", "type": "arrow", "from": { "id": "n1", "side": "e" }, "to": { "id": "n2", "side": "w" }, "label": "SSE", "bends": [{ "x": 380, "y": 182 }] }`
  - **文字标签（`type: "text"`）**：`{ "id": "t1", "type": "text", "x": 120, "y": 40, "w": 360, "h": 40, "label": "请求链路总览" }`
  - **表格（`type: "table"`）**：`{ "id": "tb1", "type": "table", "x": 120, "y": 500, "w": 480, "h": 180, "headers": ["模块", "职责"], "rows": [["channel", "事件序号"], ["watch", "游标与席位"]] }`
  - **矢量插图（`type: "svg"`）**：`{ "id": "v1", "type": "svg", "x": 760, "y": 120, "w": 240, "h": 180, "sketch": "marker" | "clean", "svg": "<svg viewBox=\"0 0 240 180\">...</svg>" }`
  - **沙箱小挂件（`type: "html"`）**：`{ "id": "app1", "type": "html", "x": 760, "y": 340, "w": 320, "h": 220, "html": "<div>...</div>", "state": {} }`（内嵌独立沙箱 iframe，可用 `embed.load()` / `embed.save(patch)`）。
  - **占座施工框（`type: "claim"`）**：帮工绘制复杂区域前可先写一条 `claim` 框提示正在绘制，画完在同一批 `delete` 掉。

## 空间排版纪律

- 节点间距至少留 `80px–120px` 供箭头与标签呼吸；容器内边距至少留 `40px`（顶部标题留 `52px`）。
- 优先按左→右或上→下单一主轴排列，`from.side` / `to.side`（`"n" | "s" | "e" | "w"`）顺着流向接出，避免斜穿其它节点。

按需延伸阅读：`artifact_type_read({ type: "whiteboard", reference: "elements" | "pictures" })`。
