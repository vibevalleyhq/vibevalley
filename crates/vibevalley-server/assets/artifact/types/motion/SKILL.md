# motion：纯时间函数动态短片

`motion`（`body = "store"`，`artifactType: "motion"`）面向高质感图形动画、产品揭幕、算法演示与动态字幕短片。工作台提供时间轴拖动、逐帧步进（`-1f`/`+1f`）、章节跳转与一键导出 WebM 视频到素材库。

## 条目结构

- `film/meta`（JSON）：画幅尺寸、帧率、总时长（秒，建议 4–30s，录屏导出上限 60s）与章节标记：
  ```json
  { "title": "发布片头", "width": 1280, "height": 720, "fps": 30, "duration": 6, "background": "#151413", "chapters": [{ "at": 0, "label": "开场" }, { "at": 3, "label": "高潮" }] }
  ```
- `"modules/scenes.json"`（可选，JSON）或 `modules/*.js`（text）：分镜配置表或可复用图形绘制模块。
- `film/script`（必填，text）：定义 `window.CUT = { duration, fps, chapters, setup(stage, kit), render(t, stage, kit) }`。

## 铁律：纯时间确定性（Deterministic `render(t)`）

- **同一时刻 `t` 必须永远画出完全相同的一帧**！禁止在帧间累加 `x += vx` 或依赖 `setInterval` / CSS `@keyframes` 自跑动画，否则拖动时间轴与逐帧导出视频会错乱。
- **优先画在 `<canvas>` 或 `<svg>` 上**：确保工作台逐帧光栅化导出 WebM 视频 100% 清晰无损。
- **轻量单页备选**：简单动画页也可用 `artifact_create({ kind: "html", display: "motion" })` 并在页内调用 `vv.timeline(duration, (t) => { ... })`。

按需延伸阅读：`artifact_type_read({ type: "motion", reference: "film-api" | "choreography" })`。
