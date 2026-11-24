# 树状大纲数据格式规范（outline / format）

## 1. `manifest.json`

```json
{
  "id": "art_outline_01",
  "artifactType": "outline",
  "title": "发布前架构拆解",
  "entry": "structure/outline.json",
  "meta": {
    "defaultZoomId": null,
    "tags": ["architecture", "q3"]
  }
}
```

## 2. `structure/outline.json` 字段定义

采用**稳定 ID 字典 + 有序子节点数组**（CRDT 友好，避免深层嵌套路径因父节点移动而失效）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | `number` | 结构版本号，固定 `1` |
| `rootIds` | `string[]` | 顶层节点有序 ID 列表 |
| `nodes` | `Record<string, OutlineNode>` | 以稳定唯一 `id`（如 `n_01` / ULID）为键的节点表 |

`OutlineNode` 字段：
- `id`（必填）：创建后永不更改，保证跨协作会话引用与建议定位稳定。
- `text`（必填）：单行核心陈述，支持行内 Markdown（`**加粗**`、`` `code` ``、`[图](asset/...)`）。
- `kind`（必填）：`"bullet"` | `"heading"` | `"todo"` | `"quote"` | `"code"`（`code` 可配合 `language: "chart" | "genui"` 嵌入原生图表或试算器）。
- `checked`（可选，`kind: "todo"`）：`boolean`，亦可在 `props.status` 记录 `TODO` / `DOING` / `DONE` / `CANCELED`。
- `collapsed`（可选）：`boolean`，默认展开状态提示（个人临时折叠状态优先留存在客户端视图，不强写打断他人）。
- `children`（必填）：直接子节点 `id` 有序数组；严禁出现环引用或悬空 ID。
- `props`（可选）：`Record<string, string | number | boolean>`，结构化键值对（如 `priority`、`owner`、`due`、`source`）。
- `attachments`（可选）：`string[]`，指向 `asset/` 的相对路径数组（如 `["asset/diagram.png"]`）。

## 3. 协作与一致性不变量

- **单父约束**：除 `rootIds` 外，每个节点恰好被一个父节点的 `children` 引用；移动子树只修改原父与目标父的 `children`，不改节点 `id`。
- **并发编辑**：多人/多执行会话并发在同级插入节点时由 `artifact_collab` CRDT 列表保序合并；改写用户手写节点的 `text` 或删除其子树时走 `artifact_suggestion`。
- **增量同步**：严禁为改一个错字重写整个 `nodes` 字典；始终提交针对目标 `nodeId` 的最小增量变更。
