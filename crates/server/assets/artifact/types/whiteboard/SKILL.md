# whiteboard：无限协作白板与叙事画布

`whiteboard` 由原生双层画布渲染（支持无限平移缩放、方格/点阵网格、吸附对齐、25 款内置编辑风贴纸、卡片/便签、分区容器、弯曲时间轴丝带、压力感应画笔、正交/平滑连接线与 JSON Canvas 互通）。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`），画布结构存于 `structure/board.json`，贴图与插图附件存于 `asset/`。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json          # id、artifactType: "whiteboard"、title、entry: "structure/board.json"
├── structure/
│   └── board.json         # 画布元信息、分区容器、按稳定 id 索引的 elements 与 connectors
└── asset/
    └── sketch-hero.svg    # 外置插图/截图，在元素中写 asset/sketch-hero.svg
```

`structure/board.json` 核心结构：
```json
{
  "version": 1,
  "grid": "architectural",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "elements": {
    "t1": { "id": "t1", "type": "text", "variant": "title", "x": 80, "y": 32, "w": 680, "h": 54, "label": "产品发布时间线", "highlight": "12 天" },
    "n1": { "id": "n1", "type": "shape", "shape": "card", "x": 120, "y": 140, "w": 200, "h": 116, "title": "锁定范围", "body": "核心功能已拍板", "fill": "sun", "sticker": "berry-lock" },
    "e1": { "id": "e1", "type": "arrow", "curve": "smooth", "from": { "id": "n1", "side": "e" }, "to": { "id": "n2", "side": "w" }, "label": "交付" }
  }
}
```

## 多人与多执行会话实时协作规则

1. **按元素稳定 ID 并发同步（`artifact_collab`）**：所有移动、改尺寸、改文案、新增与连线变更均通过 `artifact_collab` 按 `elements[id]` 细粒度合并并同步落盘到 `structure/board.json`；**严禁整份重写 `elements` 导致其他人的并发拖拽丢失**。
2. **来源追踪（`artifact_change`）**：每批画布编排均记录 `origin`，支持回放工作坊演进过程、按来源撤销某次自动排版或分叉方案；重要评审节点用 `artifact_version` 留存快照。
3. **审阅建议流（`artifact_suggestion`）**：当需要删改用户亲手摆放或撰写的卡片/便签时，优先通过 `artifact_suggestion` 提出调整建议，或在旁边空白区新增对照方案而非直接抹除。
4. **实时在场与施工框（Presence）**：协作光标、视口跟随与状态气泡通过实时 presence 广播（纯内存，**绝不写入 `structure/board.json`**）。执行会话绘制大片区域前先查看实时选区与空白坐标，必要时用临时 `claim` 框占座、画完即移除。

## 空间排版纪律

- 先用 `title` + `subtitle`（带 `highlight`）定下画布叙事基调，再用暖色 `card` + 顶部内置 `sticker` 呈现关键节点。
- 卡片间距至少留 `64px–100px` 供平滑连线与贴纸溢出呼吸；同类节点放入 `container` 并设置 `parentId` 联动移动。

按需延伸阅读：`artifact_type_read({ type: "whiteboard", reference: "elements" | "pictures" })`。
