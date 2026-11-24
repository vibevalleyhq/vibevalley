# diagram：工程架构与逻辑图示

`diagram` 面向严格语义化的工程图表：系统架构拓扑、调用时序图（Sequence）、实体关系图（ER）、状态机（State Machine）与数据流图。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`），支持结构化图模型 `structure/diagram.json` 与声明式 Mermaid 源码 `structure/diagram.mmd`（按需择一或配套），配图/导出矢量归档于 `asset/`。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json             # id、artifactType: "diagram"、title、diagramKind、entry
├── structure/
│   ├── diagram.json          # 语义化节点、分组边界、有向边、协议标注与布局方向
│   └── diagram.mmd           # 可选 Mermaid 声明源（适合时序图/状态机/ER 快速文本协同）
└── asset/
    └── custom-icon.svg       # 可选节点图标或导出矢量，按 asset/<name> 引用
```

`manifest.json` 示例：
```json
{
  "id": "art_diag_01",
  "artifactType": "diagram",
  "title": "Artifact 目录存储与实时协作拓扑",
  "diagramKind": "architecture",
  "entry": "structure/diagram.json"
}
```

## 多人与多执行会话实时协作规则

1. **语义节点级同步（`artifact_collab`）**：`structure/diagram.json` 按稳定 `node.id` / `group.id` / `edge.id` 存储，`structure/diagram.mmd` 按文本 CRDT 同步。多人与多执行会话可并行补充不同子系统边界与调用边，由 `artifact_collab` 无冲突合并并写回目录文件；**严禁改一条边就重置全部节点 ID**。
2. **来源追踪与架构演进（`artifact_change`）**：每次新增模块、修改依赖方向或重划边界均记录 `origin`，支持回放架构评审演进、按来源撤销实验性改动或分叉备选拓扑；评审拍板后用 `artifact_version` 留存基线快照。
3. **审阅建议流（`artifact_suggestion`）**：修改用户已定稿的模块边界、数据流向或核心状态转移时，通过 `artifact_suggestion` 提议并写明架构依据，经用户确认后合入。
4. **实时在场感知（Presence）**：先查看协作者当前选中的子图或节点 ID，避开用户正在调整的边界分组，并行完善其他子域或边注释。

## 工程图示核心原则

- **语义高于装饰**：与自由创意画布 `whiteboard` 不同，`diagram` 强调**精确依赖方向、严格边界归属与零歧义协议标注**（每条边写清协议/事件/数据载荷）。
- **单图单视点**：一张图只讲一个层次（如 L1 服务拓扑、或单个请求时序、或核心表 ER），避免把部署、类结构与业务时序揉进同一张巨图。

按需延伸阅读：`artifact_type_read({ type: "diagram", reference: "format" | "craft" })`。
