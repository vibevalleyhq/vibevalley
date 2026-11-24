# slides：结构化演示文稿

`slides` 面向可逐页协同编辑、渐进揭示、双窗演讲与导出矢量 PDF 的演示文稿。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`），讲稿索引在 `structure/deck.json`，每页独立存放在 `structure/slides/*.json`，配图与字体存放在 `asset/`。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json             # id、artifactType: "slides"、title、entry: "structure/deck.json"
├── structure/
│   ├── deck.json             # 画幅比例、主题/设计体系链接、有序幻灯片清单
│   └── slides/
│       ├── s01-cover.json    # 单页结构化内容、版式、渐进揭示与演讲备注
│       └── s02-kpi.json
└── asset/
    └── hero-arch.png         # 相对路径引用：asset/hero-arch.png
```

`structure/deck.json` 示例：
```json
{
  "title": "季度产品发布",
  "aspectRatio": "16:9",
  "designSystemId": null,
  "slides": [
    { "id": "s01-cover", "file": "structure/slides/s01-cover.json", "title": "封面" },
    { "id": "s02-kpi", "file": "structure/slides/s02-kpi.json", "title": "核心指标" }
  ]
}
```

## 多人与多执行会话实时协作规则

1. **按页解耦与实时同步（`artifact_collab`）**：每页独立存于 `structure/slides/<id>.json`，多人或多执行会话可同时编辑不同页、调序或改单页元素，由 `artifact_collab` 无冲突合并并写回目录文件；改某一页时严禁重写其他页。
2. **来源追踪（`artifact_change`）**：每页修订与调序均记录 `origin`，支持回放单页演进、按来源撤销某轮排版改动、分叉不同受众版本；评审定稿用 `artifact_version` 留存不可变快照。
3. **文案与结构审阅（`artifact_suggestion`）**：对用户手写的标题、论点或演讲备注做改写时，通过 `artifact_suggestion` 提议并说明理由，等待用户接受或拒绝。
4. **实时在场感知（Presence）**：编辑前先看实时在场列表谁停留在哪一页（active slide），优先避开用户正在精修的页面，并行补齐其他页面或演讲备注。

## 核心设计规则

- **标题即结论**：每页标题是一句完整观点，观众只扫标题就能读完故事线。
- **一页一事，版式交替**：连续两页不重复同一种列表版式；封面、大字论断、三栏指标卡、双栏对比、图示与收尾交替出现。
- **零溢出与渐进揭示**：严格控制在 `1920×1080`（`16:9`）或 `1440×1080`（`4:3`）安全区内；每页正文 ≤ 5 条要点，按步登场的元素标记 `fragment: true`。
- **资产与令牌**：图片存 `asset/` 用相对路径引用；若关联 `design-system`，优先复用其颜色与字阶令牌。

按需延伸阅读：`artifact_type_read({ type: "slides", reference: "format" | "craft" | "layout" })`。
