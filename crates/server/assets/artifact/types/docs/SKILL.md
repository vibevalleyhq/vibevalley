# docs：协作文档

`docs` 面向人与执行会话共同撰写、反复修订的技术方案、PRD、RFC、调研报告与复盘手册。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`），正文按章节拆分为 `structure/*.md`，配图与附件放入 `asset/`，全类型共享统一实时协作引擎。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json          # id、artifactType: "docs"、title、entry、sections 顺序
├── structure/
│   ├── index.md           # 摘要 / 结论先行与目录入口
│   ├── 01-context.md      # 按主题拆分的独立章节 Markdown
│   └── 02-architecture.md
└── asset/
    └── topology.png       # 相对路径引用：![拓扑](asset/topology.png)
```

`manifest.json` 示例：
```json
{
  "id": "art_01",
  "artifactType": "docs",
  "title": "统一协作引擎技术方案",
  "entry": "structure/index.md",
  "sections": ["structure/index.md", "structure/01-context.md", "structure/02-architecture.md"]
}
```

## 多人与多执行会话实时协作规则

1. **统一协作同步（`artifact_collab`）**：所有对 `structure/*.md` 的并发修订通过 `artifact_collab` CRDT 层无冲突合并并落盘到目录文件，**禁止整篇覆盖重写**；先读最新协作状态，再对目标章节/段落做局部编辑。
2. **来源追踪（`artifact_change`）**：每次提交自动记录 `origin`（用户或执行会话轮次），支持时间轴回放、按来源撤销（undo-by-origin）、版本恢复与分叉；重要里程碑通过 `artifact_version` 生成不可变目录快照。
3. **审阅建议流（`artifact_suggestion`）**：当待修改段落由用户亲手撰写或刚被用户编辑过时，通过 `artifact_suggestion` 发起审阅建议（含定位、理由与修改后文本），由用户接受或拒绝，绝不静默覆盖用户文字。
4. **实时在场感知（Presence）**：动笔前检查实时光标与聚焦章节；多人或多执行会话并行写稿时优先分工到不同 `structure/*.md` 章节文件，避免在用户正在键入的同一段落抢写。

## 原生可视化块与写作准则

- **原生图表（```` ```chart ````）与交互声明块（```` ```genui ````）**：在章节 Markdown 中直接用围栏代码块嵌入 JSON，分别渲染原生图表（`bar`/`line`/`area`/`scatter`/`pie`/`donut`/`combo`/`heatmap` 等）或交互试算器（`state` + `nodes` 表达式联动）。
- **资产相对路径**：图片、附件一律存入 `asset/` 并使用 `asset/<name>` 引用，严禁外链防盗图或塞入超大 base64。
- **结论先行**：`structure/index.md` 首段 2–3 句给出核心决定；每 3–5 段设二级/三级标题，行动项用 `- [ ]`，路径与标识符用 `` `code` ``。

按需延伸阅读：`artifact_type_read({ type: "docs", reference: "structure" | "craft" })`。
