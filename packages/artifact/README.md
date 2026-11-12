# `@vibevalley/artifact`

Artifact（结构化块文档与 HTML 交互页）纯领域引擎包，供 `apps/server` 与 `apps/web` 消费，与库里的快照存储解耦：

- `./ops`：块级文档状态机 `Page`（支持 `insert_block`、`update_text`、`set_attrs`、`set_type`、`move_block`、`delete_block`、`restore_block`、`split_block`、`merge_blocks` 并发版本对账与冲突保留）、顺序遍历 `ordered` 与富文本 Span 码点切分 `splitAt`。
- `./markdown`：块文档与 CommonMark Markdown 双向无损互转（`markdownOf`、`blocksOfMarkdown`、`inlineSpans`）。
- `./html`：HTML Artifact CSP 沙箱策略（`htmlPolicy`、`artifactHeaders`）、parse5 AST 静态外链与内嵌安全检查（`htmlCheck`、`htmlProblem`）、基于前后文锚点的源码文本精确替换（`htmlEdit`）。
- `./shell`：工作台看网页 Artifact 的外壳：主题变量、划词脚本与 `vv` 运行时（`withShell`、`shellPath`），和页面之间消息的认法（`shellMessageOf`、`selectionOf`）。
- `./blocks`：前端块编辑器 UTF-16 与码点偏移换算（`codePointOffset`）、增量 Span 标记保留（`editSpans`）、行首 Markdown 快捷转换（`markdownShortcut`）与有序列表连续编号（`listNumbers`）。
- `./editor`：前端协同块文档编辑器状态机（`BlockEditor`、`EditBlock`），管理乐观本地变更、防抖合批、修订冲突回滚与实时他人输入高亮。
