# 幻灯片文件契约（slides / format）

## `"project/deck.json"` 字段

- `title`: 讲稿总标题。
- `aspectRatio`: `"16:9"`（1920×1080，默认）或 `"4:3"`（1440×1080）。
- `slides`: 有序数组，每项含：
  - `id`: 稳定短标识（如 `"s01-cover"`），聊天 `<artifact-view-context>` 用它报告用户正在看哪一页。
  - `file`: `project/slides/` 下的文件名（如 `"s01-cover.html"`）。
  - `title`: 大纲与缩略图标题。
  - `notes`: 演讲者提词备注（也可用页内 `<aside class="notes">`）。
  - `skip`: `true` 时放映跳过该页。

## 局部改页示例

调用 `artifact_entry_batch` 只更新单页：
- `writes: [{ op: "set", path: "project/slides/s02-kpi.html", kind: "text", value: "<div class=\"slide\">...</div>", ifRev: 2 }]`
- 新增一页时，在同一批 `writes` 里同时 `set` 新 HTML 条目并更新 `"project/deck.json"` 的 `slides` 数组。
