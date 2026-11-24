# 幻灯片目录与结构契约（slides / format）

## 1. `structure/deck.json`

```json
{
  "title": "季度产品发布",
  "aspectRatio": "16:9",
  "designSystemId": "art_ds_default",
  "theme": {
    "accent": "#4d7a2a",
    "surface": "#fcfcfb",
    "ink": "#1c1917"
  },
  "slides": [
    { "id": "s01-cover", "file": "structure/slides/s01-cover.json", "title": "封面", "skip": false },
    { "id": "s02-kpi", "file": "structure/slides/s02-kpi.json", "title": "核心指标", "skip": false }
  ]
}
```

- `aspectRatio`：`"16:9"`（1920×1080，默认）或 `"4:3"`（1440×1080）。
- `designSystemId`：可选，关联站内默认或指定的 `design-system` 作品；留空时使用 `theme` 回退色值。
- `slides[].id`：稳定短标识（如 `s01-cover`），用于实时在场光标定位、建议锚点与演讲者视图同步。

## 2. 单页 `structure/slides/<id>.json`

```json
{
  "id": "s02-kpi",
  "layout": "kpi-grid",
  "eyebrow": "Q3 增长复盘",
  "title": "华东大客户续费率升至 94%，带动净增翻倍",
  "notes": "先停顿 2 秒，按方向键依次揭示三张指标卡。",
  "elements": [
    { "id": "k1", "kind": "metric", "label": "大客户续费率", "value": "94%", "delta": "+8.2pp", "fragment": 1 },
    { "id": "k2", "kind": "metric", "label": "季度净增 ARR", "value": "$1.8M", "delta": "2.1× YoY", "fragment": 2 },
    { "id": "k3", "kind": "metric", "label": "平均交付周期", "value": "6.4 天", "delta": "-35%", "fragment": 3 }
  ],
  "assets": ["asset/q3-trend.svg"]
}
```

支持的 `elements[].kind`：
- `text`（段落/金句）、`list`（要点列表）、`metric`（指标卡）、`image`（`src: "asset/..."` + `alt`）、`chart`（内嵌图表 spec）、`table`（紧凑对比表）、`code`（语法高亮代码块）、`callout`（高亮提示）。
- `fragment`：可选整数（`1, 2, 3...`）或布尔值，控制放映时逐步揭示顺序，导出 PDF 时自动全部展开。

## 3. 并发更新规程

- **新增页面**：在同一协作提交中创建 `structure/slides/<newId>.json` 并将引用项插入 `structure/deck.json` 的 `slides` 数组。
- **修改单页**：只更新目标 `structure/slides/<id>.json` 的变更字段，保持元素 `id` 不变，避免破坏同页协作者的选区或建议锚点。
- **删除页面**：先从 `structure/deck.json` 移除索引并删除对应单页文件；若该页近期由用户编辑过，先发起 `artifact_suggestion` 确认。
