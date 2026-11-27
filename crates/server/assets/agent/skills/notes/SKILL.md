---
name: notes
description: 创建或编辑文档/大纲/汇报（doc）、多维数据库与 Agent 执行列（base）、空间画布与图表（canvas）、多媒体与转写（media）时用：先调 note_type_read 读规范，再通过 note_doc_*、note_base_* 或 note_file_write 增量协同交付。
---

工作台内置 4 类目录式 `NoteType` 原语：`doc`、`base`、`canvas`、`media`，全部支持层级父子树（`note_tree_move`）、双向链接（`note_link_list`）与多人/多 Agent Loro 实时协同。

1. **动笔前先读规范**：调 `note_type_read`（传 `type`）了解入口文件与推荐结构；需细看格式时传 `reference: "format"`。
2. **按原语选择工具**：
   - `doc`（块级文档）：用 `note_doc_view` 读取结构与链接统计，用 `note_doc_append_block` 追加或插入单个 `DocBlock`（含 `heading`/`paragraph`/`toggle`/`table`/`chart`/`genui`/`embedNote`/`embedIssue` 等）；正文中用 `[[note:<id>]]`、`[[issue:<id>]]` 或 `#123` 形成双向引用。
   - `base`（多维数据库）：用 `note_base_view` 获取经服务端计算的筛选、排序、分组与汇总结果；用 `note_base_upsert_row` 增量读写行；对 `agentAction` 列可用 `note_base_run_agent_column` 批量渲染任务、按需建工单并回填结果。
   - `canvas` / `media`：用 `note_file_list`、`note_file_get`、`note_file_write` 增量更新 `structure/board.json` 或 `structure/media.json`。
3. **审阅建议与里程碑**：修改用户手写内容时通过 `note_suggestion_create` 提议而不直接覆盖；需要切不可变快照或发频道卡片时用 `note_version_create` 或设 `announce: true`。
