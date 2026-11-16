# slides：结构化幻灯片

`slides` 用多条目存储（`body = "store"`，`artifactType: "slides"`）管理一套可逐页编辑、渐进揭示、双窗演讲与打印矢量 PDF 的演示文稿。只需改某一页时，只更新对应的 `project/slides/<id>.html`，不必重交整套讲稿。

## 目录结构

- `"project/deck.json"`（必填，JSON）：讲稿清单、画幅比例（`"16:9"` 默认 1920×1080，或 `"4:3"` 1440×1080）与演讲者备注：
  ```json
  {
    "title": "季度产品发布",
    "aspectRatio": "16:9",
    "slides": [
      { "id": "s01-cover", "file": "s01-cover.html", "title": "封面", "notes": "开场问候与核心议题" },
      { "id": "s02-kpi", "file": "s02-kpi.html", "title": "关键指标", "notes": "按空格逐步揭示三张卡片" }
    ]
  }
  ```
- `"project/deck.css"`（可选，text）：全套共用的排版类与配色变量。若农场已设默认 `design-system`，其 `--color-*`、`--font-*` 令牌会自动注入 `:root`。
- `project/slides/<file>`（必填，text）：每页一个独立的 HTML 片段（外层 `<div class="slide">...</div>`），严禁写 `<html>`/`<body>` 或翻页脚本。
- `assets/<name>`（可选，asset）：挂接附件图片或字体，在 HTML/CSS 中直接写 `assets/<name>`，沙箱渲染器会自动重写为安全内网地址。

## 核心规则

1. **一页一事，版式交替**：连续两页不重复同一种列表版式；封面、大字论断、三栏指标卡、双栏对比、架构图示、金句收尾交替出现。
2. **渐进揭示（`.fragment`）**：需要按顺序登场的卡片或要点加 `class="fragment"`，工作台放映时按方向键逐步显现，打印 PDF 时自动全部展开。
3. **严防溢出**：画布固定 `1920×1080`（或 `1440×1080`），正文不超过 5 条要点，单页字数控制在 60 字以内，留足呼吸留白。
4. **轻量单文件备选**：若只需一次性短小的 3–5 页简报，仍可用 `artifact_create({ kind: "html", display: "slides" })`。

按需延伸阅读：`artifact_type_read({ type: "slides", reference: "format" | "craft" | "layout" })`。
