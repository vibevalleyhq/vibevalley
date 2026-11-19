---
name: 幻灯片
description: 用户要一份幻灯片、演示稿、汇报，或要把一段内容讲给别人听时用：正式多文件套稿用 artifactType 为 slides，轻量快稿交 display 为 slides 的网页 Artifact。
---

幻灯片有两种交付方式：

1. **结构化套稿（推荐，`artifactType` 填 `slides`）**：先调 `artifact_type_read`（`type: "slides"`）读规范（需要图表或排版细则再读 `references`），用 `artifact_create` 建 `slides` 类型，把清单写进 `"project/deck.json"`、共用样式写进 `"project/deck.css"`、每页写进 `project/slides/01.html` 等条目。支持 `16:9`（1920×1080）与 `4:3`（1440×1080）、`class="fragment"` 分步揭示、演讲者备注和单页增量更新（`artifact_entry_batch`）。
2. **轻量单页快稿（`kind` 填 `html`，`display` 填 `slides`）**：写一个 HTML 文件交上来，每页一个顶层 `<section>`（支持 `.fragment` 和 `<aside class="notes">`），工作台排成 16:9 并提供翻页、全屏放映、演讲者视图和存成 PDF。

**先定讲什么，再动手。**

1. 弄清给谁看、讲多久、看完要做什么决定。工单没说的，按 6 到 10 页写。
2. 一页只讲一件事：一个结论、一张图、一组对比。数字和事实从仓库、工单或用户材料里来，不编造。
3. 沙箱不连外网：图片用内联 SVG、`data:` 或已上传附件（`assets/*`），脚本和字体只走允许的公共库或系统字栈。
4. 用户回复卡片或带着 `<artifact-view-context>` 指明某页时，对结构化套稿直接用 `artifact_entry_batch` 改那一页并设 `announce: true`；对单文件 HTML 用 `artifact_version_create` 交新版本。

幻灯片用用户的语言写。
