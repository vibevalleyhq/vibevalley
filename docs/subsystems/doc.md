# 文档

文档（`Document`）是主人和帮工一起写的一篇文字：一组块（段落、标题、列表、待办、引用、代码……），每次改动是按块 id 描述的一个 op，服务端是唯一的权威。合并以块为单位，不用 CRDT。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 文档和块的模型、块的类型和 marks、顺序键 | 一篇文章怎么分给几个帮工写（[种植计划](docs/subsystems/task.md)，还没接上） |
| op 管线：一批 op 一个事务、批号去重、文档的 seq、每个 op 的结果 | 帮工怎么拿到工具、是谁在调（[田头](docs/subsystems/channel.md) 的 `/mcp`，`internal/mcp`） |
| 块的修订（每一版的字、没被采用的冲突版本） | 工单和记性本身：`issue_ref`、`memory_item` 块只存它们的 id |
| Markdown 导入和导出 | |

## 在哪

- 服务端 `server/internal/doc`（`doc.Service`，`Workspace.Doc`）：`doc.go` 存取和提交，`ops.go` 是 op 的规则（纯函数，在内存里的一篇文档上按顺序施加），`order.go` 顺序键，`text.go` 按码点切和接文字，`markdown.go` 导入导出。这些规则只有它用，都不导出。
- 形状在 `protocol/shapes.go`：`Document`、`Block`、`BlockAttrs`、`DocSpan`、`DocMarks`，op 是封闭的联合 `DocOp`（按 `op` 区分，`DocOpMembers` 是生成的成员表），`DocSubmit`、`DocAck`、`DocOpResult`；块的类型是普通字符串，取值是带 `//vibevalley:const` 的常量（`BlockParagraph`……），Dart 拿到同名常量。
- 表：`doc`（一篇一行，`seq`）、`doc_block`（每一块，含墓碑；`attrs`、`spans` 存 JSON 文本）、`doc_block_revision`（每一块每一版的字，`kind` 是 `normal` 或 `conflict`）、`doc_change`（每一批：`seq`、`batch_id`、谁、改了哪些块、每个 op 的结果）。
- 接口：`doc.list`、`doc.create`、`doc.import`、`doc.get`、`doc.submit`、`doc.markdown`（[capabilities.md](docs/reference/capabilities.md)），主人和「连接到本机」能调，写的人记成 `owner`（`DocOwner`）。

## 模型和不变量

- **一篇文档是一组扁平的块**：`parentId` 表示嵌套，`orderKey` 表示同级的顺序；同级按 `(orderKey, id)` 排，两端在同一处插入、生成了同一个键时顺序仍然确定。
- **块 id 由插入它的一方生成**（uuid），之后不变，在所有文档里唯一。
- **顺序键**是 base62 的分数索引：两键之间取中点，在两头插入时首位加一或减一；键不以 `0` 结尾，所以前面总有位置。服务端只校验格式（只有 base62、不以 `0` 结尾、不超过 256 位），自己只在导入 Markdown 和帮工追加时生成。
- **块的类型**：`paragraph`、`heading`（`level` 1–3）、`bulleted`、`numbered`、`todo`（`checked`）、`quote`、`code`（`language`，字不带 marks）、`divider`、`image`（`src`、`width`、`height`、`alt`）、`issue_ref`（`issueId`）、`memory_item`（`memoryId`，带字）。`divider`、`image`、`issue_ref` 没有字。服务端只收这些；比客户端新的服务端给出它不认识的类型时，客户端画只读的占位块。
- **marks** 只有 `bold`、`italic`、`code`、`strike`、`link`。字存成 span 的列表，相邻的同样 marks 的 span 合成一个、空的去掉，同一段字只有一种写法。
- **算得出来的不存**：有序列表的编号由客户端按同级连续的 `numbered` 数。
- **rev**：每个改到这一块的 op 让它加 1；新块从 1 开始。每一版的字存进 `doc_block_revision`。
- **seq**：文档每收下一批加 1；同一批重发（同一个 `batchId`）不加，回答第一次的结果。
- **墓碑**：删除只置 `deleted`，子块一起；`doc.get` 不返回墓碑。
- **偏移按 Unicode 码点数**（Go 的 rune），不按 UTF-16。仓库里给人看的字数（`pkg/x/str`）按 UTF-16 码元，两套单位只在这里分开：`split_block` 的 `offset` 是码点，Dart 那边把光标的 UTF-16 位置换成码点再发。

## 怎么走

**提交一批**（`Submit`，主人经 `doc.submit`，帮工经工具）：

1. 一把锁让所有文档的批一个一个来（库只有一个连接，同一文档的 seq 按顺序涨）。开一个事务。
2. 文档不在是 `Missing`；`batchId` 见过：同一篇就回答当时的结果和这些块现在的样子，另一篇的就拒绝。
3. 把这篇的全部块（含墓碑）读进内存，按顺序施加每个 op（`page.apply`）。一个 op 的结果不影响同一批里的别的 op。
4. 写回改过的块、新的修订、`doc_change`（`seq` 加 1），提交事务。
5. 回答 `DocAck`：`seq`、每个 op 的结果、改过的块的完整样子。客户端用它替换本地的块。

**每个 op 的结果**：`applied`；`conflict`（块保留现在的字，`yours` 是发来的，存成 `conflict` 的修订）；`noop`（删已删的、恢复没删的、并进来的块已删）；`rejected`（不在的块、不认识的类型、坏的顺序键、重复的 id、拆分位置不在字里，`reason` 说明）。`merged` 留给三方合并。

**带 `baseRev` 的 op**（`update_text`、`split_block`）：`baseRev` 等于当前 rev，直接施加；落后时，如果这一块的字从那一版到现在没变过（中间只改了勾选、类型这类），照样施加；字变过就是冲突。`update_text` 冲突时不改这一块；`split_block` 冲突时在现在的字的末尾拆开（原块的字不动，新块是空的）。

**拆分和合并**都是一个 op：`split_block` 把 `offset` 以后的字挪进客户端给好 id、父块和顺序键的新块；`merge_blocks` 拿两块现在的字接起来，来源的子块挪到目标下面（排在目标已有的子块后面），来源置墓碑。

**其他**：`set_attrs` 按字段写（`unset` 列出要删的键），后到的生效；`set_type` 换类型和整套属性，新类型没有字就丢掉字，换成 `code` 去掉 marks；`move_block` 挪到自己下面被拒绝，挪到已删的父块下面就挂到那个父块所在的层级；`restore_block` 连子块一起恢复。

**Markdown**：导出按文档顺序写，嵌套每层缩进两个空格，列表项之间空一行以外都空两行；`issue_ref`、`memory_item` 写成 HTML 注释（`<!-- issue:ID -->`、`<!-- memory:ID --> 字`），图片的尺寸写在标题里（`"640x480"`）；字里的 `\ * _ ` + "`" + ` ~ [ ]` 加反斜杠，像别的块开头的段落行前加反斜杠。导入读回同样的块：`**粗**`、`_斜_` 或 `*斜*`、`` `码` ``、`~~删~~`，链接是方括号里的字加圆括号里的地址。导入是一个新文档，块作为一批 `insert_block` 提交。

## 和谁打交道

- **地基（`base`）**：只用数据库和 `NewID`；不依赖别的服务，也不进核心状态：文档不在 `StateFrame` 里，客户端用 `doc.get` 取。

## 为什么这样

- **按块存、按 op 改、服务端说了算。** 放弃了保存整篇：两个人改不同段落时后存的会盖掉先存的，帮工写一段也会盖掉人正在改的。放弃了现在就上 CRDT：同一段里逐字协同和长时间离线编辑还不需要；所有修改只走 op、所有位置都用块 id 描述，以后要换时上层不用改（[提案](.agents/notes/proposed/feature/2026-10-20-block-editor-collab.md)）。
- **回答里带改后的块，不带 op。** 客户端直接替换本地的块，不用在本地重放一遍规则；以后的广播也发块的样子。
- **规则在内存里的一篇文档上跑。** 一批 op 读一次、写一次，`ops.go` 是纯函数，测试不用数据库；一篇文档的块数量不大，整篇读进来比按 op 查省事。
- **落后但字没变的 `baseRev` 照样收。** rev 每个 op 都加，勾一下待办也加；只比 rev 会让「勾选之后接着打字」变成冲突。比较那一版的字和现在的字，结果和三方合并在这种情况下一样。
- **类型是字符串，不是枚举。** 生成的 Dart 枚举遇到不认识的值会解码失败，整篇打不开；字符串加常量让旧客户端画占位块。
- **顺序键在两头加一减一。** 只取中点时，一直往末尾追加，键每六次长一位；加一减一每 61 次才长一位。同一处反复插入仍然会变长，以后由服务端重排。
- **一把锁管所有文档。** 库只有一个连接，按文档分锁不会更快。

## 还没做的

- 广播和 presence（WebSocket）、三方合并（`merged`）、拆分的偏移映射、断线补交、修订的清理和找回、撤销：[块编辑器协同](.agents/notes/proposed/feature/2026-10-20-block-editor-collab.md)。
- 几个帮工同时写一篇文章、建议、确认：[几个帮工同时写一篇文章](.agents/notes/proposed/feature/2026-10-20-block-editor-ux.md)。

## 怎么验证

- `doc/ops_test.go`：`TestOps`（插入、改字、落后的改字冲突和照收、拆分、冲突时在末尾拆、合并和挪子块、删除和恢复、挪动、属性和类型）、`TestEveryOpIsHandled`（`DocOpMembers` 里每种 op 都有分支）、`TestChangedBlocksCarryTheirRevAndWriter`、`TestCodeHasNoMarks`。
- `doc/order_test.go`：`TestKeyBetween`、`TestKeysStayInOrder`（往末尾、开头、同一处各插 500 次）、`TestSameKeySortsByID`。
- `doc/text_test.go`：`TestSplitCountsCodePoints`（中文、emoji、肤色、组合字符）。
- `doc/markdown_test.go`：`TestMarkdownRoundTrip`、`TestBlocksRoundTrip`。
- `doc/doc_test.go`：`TestEditsSurviveARestart`（重开库后块、rev、seq 都在）、`TestABatchIsTakenOnce`、`TestStaleUpdateIsAConflict`（冲突版本存进修订）、`TestImportAndExport`。
- `handler/doc_test.go` 的 `TestDocRoutes`：经 HTTP 建、提交、读、导出、导入。
