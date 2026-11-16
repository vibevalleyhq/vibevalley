---
name: slides
description: 用户要一份幻灯片、演示稿、汇报 PPT，或要把一段内容讲给别人听时用。正式套稿用结构化 slides（artifactType 填 slides，调 artifact_type_read 读分册）；轻量单页稿交网页 Artifact，display 填 slides，工作台负责翻页、放映、演讲者视图和存成 PDF。
---

# 幻灯片

VibeValley 支持两种幻灯片交付方式：

## 1. 结构化多文件套稿（推荐：`artifactType: "slides"`）

适合正式汇报、带分步揭示（`.fragment`）、自定义画幅（`16:9` 1920×1080 或 `4:3` 1440×1080）、独立每页 HTML 或复用农场默认 Design System 令牌的演示稿：

1. 先调 `artifact_type_read`（`type` 填 `slides`）读规范；需要细看格式、质感或版式时再传 `reference`（`format`、`craft`、`layout`）。若返回了 `defaultArtifactId`，先读那套默认 Design System 的令牌。
2. 用 `artifact_create`（`artifactType` 填 `slides`）建套稿，或带初始 `entries` 一次写入：
   - `"project/deck.json"`：`aspectRatio`（`"16:9"` 或 `"4:3"`）和 `slides` 清单（`id`、`file`、`title`、`notes`）。
   - `"project/deck.css"`：全套共用的排版与颜色变量。
   - `project/slides/01.html`、`02.html`……：每页一个独立 HTML 片段，分步揭示给元素加 `class="fragment"`。
3. 后续只改某一页时，用 `artifact_entry_batch` 单独更新对应的 `project/slides/<id>.html` 或合并修改 `"project/deck.json"`，不必重交整份稿子。

## 2. 轻量单文件快稿（`kind: "html"`，`display: "slides"`）

如果只是几页简短周报，也可以直接交一份网页 Artifact（`artifact_create`，`kind` 填 `html`，`display` 填 `slides`）。工作台读你写的页面：一页一个 `<section>`（支持 `.fragment` 分步揭示和 `<aside class="notes">` 演讲备注），排成 16:9，翻页、全屏放映、演讲者视图、存成 PDF 都由工作台完成。

- `title`：封面或分节页，`<h1>` 大标题，`<p>` 一句副标题。
- 不写 class：普通一页，`<h2>` 标题加几条 `<ul><li>`，一页不超过 5 条。
- `two-col`：左右两栏对比，`<h2>` 横跨两栏，下面两个 `<div>`。
- `quote`：一句话撑满一页，`<blockquote>` 加 `<cite>`。

用用户的语言写幻灯片，也用用户的语言回答。
