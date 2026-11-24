# 工程图示 Schema 与 Mermaid 约定（diagram / format）

## 1. 结构化图模型 `structure/diagram.json`

适用于架构拓扑、数据流与可交互检查节点属性的工程图：

```json
{
  "kind": "architecture",
  "direction": "LR",
  "groups": [
    { "id": "g_client", "label": "客户端平面", "tone": "neutral" },
    { "id": "g_server", "label": "服务端核心", "tone": "accent" }
  ],
  "nodes": [
    { "id": "mac_ui", "group": "g_client", "kind": "app", "label": "macOS Workbench", "subtitle": "GPUI + nsh" },
    { "id": "router", "group": "g_server", "kind": "service", "label": "Gateway Router", "subtitle": "HTTP / SSE" },
    { "id": "collab", "group": "g_server", "kind": "engine", "label": "artifact_collab", "subtitle": "CRDT Sync" },
    { "id": "storage", "group": "g_server", "kind": "store", "label": "storage/", "subtitle": "Dir-per-Artifact" }
  ],
  "edges": [
    { "id": "e1", "from": "mac_ui", "to": "router", "label": "SSE / JSON", "style": "solid" },
    { "id": "e2", "from": "router", "to": "collab", "label": "CRDT ops", "style": "solid" },
    { "id": "e3", "from": "collab", "to": "storage", "label": "materialize", "style": "dashed" }
  ],
  "notes": [
    { "id": "note1", "target": "storage", "text": "manifest.json + structure/ + asset/" }
  ]
}
```

- `kind`：`"architecture"` | `"sequence"` | `"er"` | `"state"` | `"flowchart"`。
- `direction`：`"LR"`（从左到右，推荐架构/流水线）| `"TB"`（从上到下，推荐分层/调用栈）。
- `nodes[].kind`：`"app"` | `"service"` | `"engine"` | `"store"` | `"queue"` | `"external"` | `"actor"` | `"state"` | `"entity"`；可选 `icon: "asset/<name>.svg"`。

## 2. 声明式 Mermaid 源码 `structure/diagram.mmd`

适合时序图（`sequenceDiagram`）、ER 图（`erDiagram`）与状态机（`stateDiagram-v2`）：
- 当 `manifest.json` 设 `"entry": "structure/diagram.mmd"` 时，以 `.mmd` 为单一真源，避免 JSON 与 `.mmd` 双源漂移！
- 含括号、斜杠或冒号的节点标签一律使用双引号包裹（例如 `A["Gateway (HTTP/SSE)"]`），避免解析语法错误。
- 不使用原始 HTML 标签（如 `<br/>` 或 `<b>`），保持跨渲染器纯净。
