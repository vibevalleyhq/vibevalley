# docs：协作文档

`docs` 面向人与帮工共同撰写、反复修订的结构化长文（方案、复盘、调研、手册）。存储形态为 `body = "blocks"`（`artifact_create` 传 `artifactType: "docs"` 或 `kind: "markdown"`）。

## 核心工作流

1. **创建**：`artifact_create({ title, artifactType: "docs", content })` 一次导入初始 Markdown 块树，或省略 `content` 先建空文档再逐块写入。
2. **局部修订（严禁整篇重写）**：
   - 先读最新块与 `rev`（或查看 `<artifact-view-context>` 里的 `selectedBlockIds`）。
   - 插入：`artifact_block_create({ id, afterBlock, parentId, type, level, text })`。
   - 修改：`artifact_block_update({ id, block, baseRev, text, type, level, checked, language })`。
   - 删除：`artifact_block_delete({ id, block })`。
3. **尊重用户手写的块**：帮工对用户亲手写过的块调用 `artifact_block_update` / `delete` 时，服务端会自动转为一条待确认建议（`suggestion`），不要反复硬写同一块。

## 写作与版式准则

- **结论先行**：首段用 2–3 句说清核心判断或决定，不堆砌寒暄铺垫。
- **扫读节奏**：每 3–5 段用二级/三级标题分段；并列要点超过 3 项改用 `bulleted` / `numbered`；行动项用 `todo`；关键警示或原话用 `quote`。
- **行内标记**：善用 `**加粗**` 标出句首锚点词，代码、路径、配置项一律用 `` `code` ``。

按需延伸阅读：`artifact_type_read({ type: "docs", reference: "structure" })`。
