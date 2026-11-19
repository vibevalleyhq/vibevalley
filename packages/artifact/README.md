# `@vibevalley/artifact`

Artifact（结构化多条目作品、协作块文档与 HTML 交互页）纯领域引擎包，供原生应用的页面（`apps/mac/ui`）消费（服务端的是 Rust 的 `crates/vibevalley-artifact`，两边共用 golden），与库里的快照存储解耦：

- `./ops`：块级文档状态机 `Page`（支持 `insert_block`、`update_text`、`set_attrs`、`set_type`、`move_block`、`delete_block`、`restore_block`、`split_block`、`merge_blocks` 并发版本对账与冲突保留）、顺序遍历 `ordered` 与富文本 Span 码点切分 `splitAt`。
- `./markdown`：块文档与 CommonMark Markdown 双向无损互转（`markdownOf`、`blocksOfMarkdown`、`inlineSpans`）。
- `./html`：HTML Artifact CSP 沙箱策略（`htmlPolicy`、`artifactHeaders`）、`parse5` AST 静态外链与内嵌安全检查（`htmlCheck`、`htmlProblem`）、基于前后文锚点的源码文本精确替换（`htmlEdit`），以及复合后缀与内容推断（`artifactSuffixOf`、`inferDisplayFromContent`、`inferArtifactFromName`）。
- `./shell`：工作台看网页 Artifact 的外壳：主题变量、划词脚本、`vv.timeline` 确定性时间轴与沙箱内 WebM 录屏导出运行时（`withShell`、`shellPath`），和页面之间消息的认法（`shellMessageOf`、`selectionOf`）。
- `./store`：结构化 Store 条目路径与大小校验（`entryPathProblem`、`entryMaxBytes`、`entryMaxCount`、`inlineEventMaxBytes`）、RFC 7396 JSON Merge Patch 与规范化序列化（`applyJsonMergePatch`、`canonicalJson`）、种类与 MIME 推断及文本摘要（`formatStoreSummary`）。
- `./tokens`：`design-system` 的 `"project/tokens.json"` 解析、浅/深双主题 CSS 自定义属性与字阶类编译（`parseTokensSpec`、`compileTokensCss`）及 WCAG 对比度计算（`contrastRatio`）。
- `./viewers`：结构化 Store 各类别（`slides`、`dashboard`、`motion`、`design`、`whiteboard` 内嵌 HTML）的沙箱页面拼装（`renderStoreArtifactHtml`）、CSP 头与视图地址（`storeViewHeaders`、`storeViewUrl`）、白板 SVG 净化（`sanitizeWhiteboardSvg`）与 `.dc.html` `data-props` 回写（`writePropsIntoDcHtml`）。
- `./starters`：新建各 `ArtifactType` 时的开箱初始条目模板（`starterEntriesForType`）。
- `./blocks`：前端块编辑器 UTF-16 与码点偏移换算（`codePointOffset`）、增量 Span 标记保留（`editSpans`）、行首 Markdown 快捷转换（`markdownShortcut`）与有序列表连续编号（`listNumbers`）。
- `./editor`：前端协同块文档编辑器状态机（`BlockEditor`、`EditBlock`），管理乐观本地变更、防抖合批、修订冲突回滚与实时他人输入高亮。
