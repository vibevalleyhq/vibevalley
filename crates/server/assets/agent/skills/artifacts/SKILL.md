---
name: 结构化作品
description: 做数据看板（dashboard）、动态图形短片（motion）、白板图（whiteboard）、多画板界面稿（design）、设计系统（design-system）、树状大纲（outline）或协作文档（docs）时用：先调 artifact_type_read 读规范，再用 artifact_block_* 或 artifact_entry_batch 增量交付。
---

工作台内置 8 种结构化 `ArtifactType`：`docs`、`outline`、`slides`、`dashboard`、`motion`、`whiteboard`、`design`、`design-system`。

1. **动笔前先读规范**：调 `artifact_type_read`（传 `type`）拿该类型的文件结构、运行时全局对象与质量门禁；有需要再传 `reference` 读细分章节。
2. **数据与表现分离**：
   - `dashboard` 把原始数据放进 `datasets/<id>`，页面在 `files/index.html` 用 `window.dash` 计算，并给关键指标标上 `data-source` 与 `data-field`，让工作台自动核验每个数字。
   - `motion` 在 `film/script` 写纯时间函数 `window.CUT.render(t, stage, kit)`，任意拖动进度条或导出 WebM 视频都严格一致。
   - `whiteboard` 在 `elements/<id>` 放结构化图元（`shape`、`container`、`arrow`、`table`、`svg`、`html`），用户可以继续拖拽连线。
   - `design` 在 `project/*.dc.html` 画多画板界面并用 `data-props` 暴露可调属性杆。
   - `design-system` 在 `"project/tokens.json"` 维护浅色与深色令牌，设为默认后自动注入其他视觉作品。
3. **增量更新不重来**：块类作品（`docs`/`outline`）先调 `artifact_block_list` 读当前块树与 `rev`，再用 `artifact_block_batch` 批量增改移删（导入工作区 `.md`/Logseq 文件用 `artifact_outline_import`），并可在代码块中嵌入 `language: "chart"` 或 `"genui"` 呈现原生图表与交互面板；条目类作品用 `artifact_entry_batch` 的 `set`、`patch`、`delete`、`copy`（配合 `ifRev`）只改受影响的条目；一轮修改完成要通知频道时设 `announce: true`。
