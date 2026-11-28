---
name: notes
description: 创建或编辑文档/大纲/汇报（doc）、多维数据库与 Agent 执行列（base）、空间画布与图表（canvas）、多媒体与转写（media）时用：先调 note_type_read 读规范，再通过 note_doc_*、note_base_* 或 note_file_write 增量协同交付。
---

工作台内置 4 类目录式 `NoteType` 原语：`doc`、`base`、`canvas`、`media`，全部支持层级父子树（`note_tree_move`）、双向链接（`note_link_list`）与多人/多 Agent Loro 实时协同。

1. **动笔前先读契约**：调 `note_type_read({ type })` 了解入口文件，需精确字段样例时调 `note_type_read({ type, reference: "format" })`（MCP 读 `skill://note/<type>/references/format.md`）。
2. **优先用结构化原语替代脆弱纯文本**：
   - `base`（多维台账、分诊队列、实验对比）：用 `note_base_view` 读 Rust 计算投影，用 `note_base_upsert_row` 增量写强类型行（`BaseCellValue` 带 `_tag`），用 `formula` 列算差值、用 `pageNoteId`（Row=Page）挂长证据、用 `agentAction` + `note_base_run_agent_column` 批量派单。
   - `doc`（方案、复盘与验收汇报）：用 `note_doc_view` 读块树，用 `note_doc_append_block` 增量追加强类型 `DocBlock`（24 种 `BlockKind`：`prose`、`heading`、`list`、`todo`、`quote`、`divider`、`toggle`、`callout`、`code`、`table`、`bookmark`、`toc`、`math`、`columns`、`pageBreak`、`kpi`、`chart`、`diagram`、`compare`、`media`、`preview`、`baseEmbed`、`issueCard`、`issueList`）；长日志放 `toggle`（`collapsed: true`），正文中用 `[[note:<id>]]`、`[[issue:<id>]]` 或 `#123` 形成双向引用。
   - `canvas` / `media`：用 `note_file_list`、`note_file_get`、`note_file_write` 增量更新 `structure/board.json` 或 `structure/media.json`。
3. **审阅建议与里程碑**：修改用户手写内容时通过 `note_suggestion_create` 提议而不直接覆盖；需要切不可变快照或发频道卡片时用 `note_version_create` 或设 `announce: true`。
