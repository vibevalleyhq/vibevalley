# 1920×1080 画布版式配方（slides / layout）

工作台默认给每个 `section.vv-deck-slide` 提供 `padding: 96px 128px`（净内容区 `1664×888`）：

1. **封面 / 分节章标题**：左上眉标（`22px` 大写或字距拉开）+ `84px` 主标题 + `34px` 副标题与日期署名。
2. **三栏指标卡（KPI Grid）**：`display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px`，每张卡大号数字（`72px`）+ 一行同比说明。
3. **双栏对照（45% / 55%）**：左栏问题或现状，右栏新架构或改进方案。
4. **左文右图**：左栏 3 条核心解释，右栏内联 SVG 流程图或 `assets/` 截图。
