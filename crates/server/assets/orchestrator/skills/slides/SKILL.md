---
name: slides
description: 用户要演示稿、汇报提纲或可视化汇报时用：优先使用 noteType 为 doc（带 divider 分节、`chart`/`genui` 交互块）的笔记，或用 noteType 为 canvas 的自由画布笔记交付。
---

# 演示与汇报笔记

通过 **笔记（Note）** 组织结构化汇报与可视化内容：

1. **块级汇报文档（`noteType: "doc"`）**：调 `note_type_read({ type: "doc" })` 后创建 `doc` 笔记，按章节用 `divider`、`heading`、`chart`、`genui` 与 `callout` 组织汇报流，并可用 `note_doc_append_block` 局部补充页块。
2. **自由画布展板（`noteType: "canvas"`）**：需要空间排版、架构演进图或流程节点连线时，使用 `canvas` 笔记并在 `structure/canvas.json` 中维护节点与 `asset/` 图资源。

用用户的语言写汇报，也用用户的语言回答。
