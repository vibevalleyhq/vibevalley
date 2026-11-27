---
name: canvas
description: 空间画布与图表原语（Canvas）：承载无限白板节点连线、架构流程图、多画板 UI 稿与视觉原型。
tags: [note, visual, canvas]
---

# canvas：空间画布与图形

`canvas` 面向自由排版、思维导图、系统架构图与界面设计稿，主入口为 `structure/board.json`。

- 节点、连线与分组容器均以稳定 `id` 为键存放在 `structure/board.json` 的 `elements` 映射中（配合 `grid`、`theme` 与 `viewport`），静态矢量图与截图放入 `asset/`。
- 通过 `note_file_list` / `note_file_get` / `note_file_write` 增量更新画布 JSON；修改用户手绘区域优先使用 `note_suggestion_create`。

延伸参考：`note_type_read({ type: "canvas", reference: "format" })`。
