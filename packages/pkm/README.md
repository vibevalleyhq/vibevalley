# `@vibevalley/pkm`

PKM（个人知识库与双链大纲）纯领域引擎包，供 `apps/server` 与 `apps/web` 共享消费，与 SQLite 存储及农场业务解耦：

- `./para`：PARA 目录映射（`00_Inbox` .. `04_Archives`、`journals`）、检索权重（`tierWeight`）、文件名与日期标题互转（`fileOf`、`journalTitle`、`journalDay`）。
- `./markdown`：Logseq 风格 Markdown 大纲解析与序列化（`parse`、`print`）、块级树操作（`applyOps`）、双向链接 `[[page]]` 与块引用 `((uuid))` 提取（`edgesOf`）、行内批注 `==text==^[remark]`（`spansOf`）及跨编辑器的块 ID 保持（`carryIds`）。
- `./graph`：知识库图谱查询与分析——双向反链聚合（`backlinks`）、块嵌入展开与环检测（`transclusions`）、加权全文检索（`search`）、过期与停滞雷达（`radar`）、全库重命名链更新（`renameLinks`）与纯 Markdown 导出（`exportMarkdown`）。
- `./view`：前端大纲视图投影、折叠过滤（`visibleBlocks`）、行内富文本切片（`piecesOf`）、中英文逐词 Diff（`wordDiff`）与页面补全匹配（`noteTargets`）。
- `./editing`：大纲键盘编辑状态机（`editAction`）、多行缩进粘贴拆块（`pasteAction`）、`[[` / `((` / `#` / `/` 自动补全触发与替换（`completionAt`、`completed`、`commandAction`）。
- `./selection`：多块框选与键盘范围操作（`pickAction`）、拖拽排序落点计算（`dropAt`、`dropOps`）与子树大纲复制（`outlineText`）。
- `./days`：日记与日历网格计算（`dayKey`、`dayTitle`、`daysUntil`、`monthWeeks`）。
- `./writer`：乐观更新与批量块操作串行提交队列（`PageWriter`）。
