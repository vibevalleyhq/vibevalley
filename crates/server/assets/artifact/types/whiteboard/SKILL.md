# whiteboard：无限协作白板与叙事画布

`whiteboard`（`body = "store"`，`artifactType: "whiteboard"`）由工作台原生渲染无限平移缩放画布，人与帮工可按元素 ID 并发新增、拖拽、改尺寸、手绘、贴纸装饰与局部修订，适合产品发布时间线、系统架构图、头脑风暴与概念关系图。

## 条目结构

- `board/meta`（JSON）：`{ "title": "...", "mode": "board", "grid": true }`
- `elements/<id>`（JSON）：每个画布元素一条独立记录，局部挪动或改字用 `artifact_entry_batch` 的 `patch`（带 `ifRev`）：
  - **富文本标题/批注（`type: "text"`）**：`{ "id": "t1", "type": "text", "variant": "title" | "subtitle" | "callout" | "body", "x": 120, "y": 40, "w": 680, "h": 54, "label": "产品发布时间线", "highlight": "12 天", "icon": "⚠", "align": "left" | "center" }`（`title` 使用衬线展示字体；`highlight` 为内联高亮短语；`callout` 适合风险与阻塞提示）。
  - **卡片与几何图形（`type: "shape"`）**：`{ "id": "n1", "type": "shape", "shape": "card" | "sticky" | "rect" | "diamond" | "ellipse" | "pill", "x": 120, "y": 140, "w": 200, "h": 116, "title": "锁定范围", "body": "核心功能已拍板", "fill": "sun" | "peach" | "leaf" | "water" | "lavender" | "berry" | "wheat" | "side" | "page", "sticker": "berry-lock", "badge": "Day 1" }`（`sticker` 可填内置手绘贴纸 ID 或 emoji，也可附带经清洗的 `stickerSvg` 浮在卡片上沿）。
  - **时间线丝带（`type: "timeline"`）**：`{ "id": "tl1", "type": "timeline", "x": 80, "y": 290, "w": 840, "h": 90, "fill": "peach", "points": [{ "x": 80, "y": 350 }, { "x": 380, "y": 320 }, { "x": 680, "y": 308 }, { "x": 920, "y": 280 }], "milestones": [{ "t": 0.08, "label": "Day 1", "kind": "major" }, { "t": 0.45, "label": "4", "kind": "minor", "caption": "联调冲刺 4 天" }] }`（沿坐标平滑穿过里程碑大胶囊 `major` 与白色编号圆点 `minor`）。
  - **分区容器（`type: "container"`）**：`{ "id": "z1", "type": "container", "x": 80, "y": 80, "w": 640, "h": 360, "title": "核心服务边界", "fill": "side" }`
  - **平滑/折线/直线连接器（`type: "arrow"`）**：`{ "id": "e1", "type": "arrow", "curve": "smooth" | "orthogonal" | "straight", "style": "solid" | "dashed", "head": "arrow" | "none", "from": { "id": "n1", "side": "s" }, "to": { "id": "tl1", "x": 200, "y": 340 }, "label": "SSE", "bends": [] }`
  - **手绘轨迹（`type: "path"`）**：`{ "id": "p1", "type": "path", "points": [{ "x": 100, "y": 120 }, { "x": 160, "y": 140 }], "stroke": "#a83a2c", "strokeWidth": 3 }`
  - **独立贴纸或矢量插图（`type: "sticker" | "svg"`）**：`{ "id": "s1", "type": "sticker", "sticker": "truck", "x": 420, "y": 240, "w": 110, "h": 72, "label": "运输" }` 或 `type: "svg"` 带 `svg` 字段。
  - **表格与沙箱小挂件**：`type: "table"`（`headers`、`rows`）与 `type: "html"`（内嵌沙箱 iframe，`embed.load()`/`embed.save()`）。
  - **占座施工框（`type: "claim"`）**：帮工绘制复杂区域前先写一条 `claim` 框提示正在绘制，画完同批 `delete` 掉。
- `presence/<id>`（JSON，可选）：`{ "id": "orch", "name": "主助手", "color": "coral" | "teal" | "blue" | "leaf" | "wheat" | "lavender", "x": 520, "y": 110, "status": "排版中" }`，在画布上显示实时协作光标与名牌。

## 空间排版纪律

- 先用 `title` + `subtitle`（带 `highlight`）定下画布叙事基调，再用暖色 `card` + 顶部 `sticker` 呈现关键里程碑或核心节点。
- 卡片间距至少留 `64px–100px` 供平滑连线与贴纸溢出呼吸；`from.side`/`to.side`（`"n" | "s" | "e" | "w"`）顺着主轴接出，时间线引线可用 `"head": "none"` 保持轻盈。

按需延伸阅读：`artifact_type_read({ type: "whiteboard", reference: "elements" | "pictures" })`。
