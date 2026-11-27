---
name: doc
description: 结构化块级协作文档（Block Doc）：支持大纲/段落/表格/引用/图表/GenUI 交互块/双向链接与多人多 Agent 实时协同。
tags: [note, writing, doc]
---

# doc：块级协作文档

`doc` 是 VibeValley 的统一块级写作与方案文档原语（原 `docs`/`outline`/`slides`/`dashboard` 写作与汇报能力统一收敛于此）。目录存放在 `<storage>/note/<id>/`，主入口为 `structure/doc.json`。

## 目录结构

```text
<storage>/note/<id>/
├── manifest.json          # id、noteType: "doc"、title、parentId、entry: "structure/doc.json"
├── structure/
│   └── doc.json           # DocDocument { version: 1, blocks: DocBlock[] }
└── asset/
    └── diagram.png        # 相对路径引用：![图](asset/diagram.png)
```

## 工具与协作约定

1. **增量读写块树**：用 `note_doc_view` 读结构化块树与 word/slide/link 统计；用 `note_doc_append_block` 追加或插入单个 `DocBlock`；大范围并发修改经 Loro CRDT 与 `note_file_write` 合并，绝不盲目覆盖。
2. **双向链接与父子树**：正文中可用 `[[note:<id>]]`、`[[issue:<id>]]` 或 `#123` 关联笔记与工单；服务端自动提取并写入 `note_link`，可用 `note_link_list` 查询出链与反向引用。
3. **审阅建议与来源撤销**：遇到用户手写段落，优先通过 `note_suggestion_create` 发起修订建议；所有修改按 `origin` 记录，支持回放与按来源撤销。

延伸参考：`note_type_read({ type: "doc", reference: "format" })`。
