# 文档

文档（`Document`）是主人和帮工一起写的一篇文字，在工作台的「文档」页（`/docs`）里写：一组块（段落、标题、列表、待办、引用、代码……），每次改动是按块 id 描述的一个 op，服务端是唯一的权威。合并以块为单位，不用 CRDT。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 文档和块的模型、块的类型和 marks、顺序键 | 一篇文章怎么分给几个帮工写（[计划](docs/subsystems/task.md)，还没接上） |
| op 管线：一批 op 一个事务、批号去重、文档的 seq、每个 op 的结果 | 帮工怎么拿到工具、是谁在调（[频道](docs/subsystems/channel.md) 的 `/mcp`，`mcp`） |
| 块的修订（每一版的字、没被采用的冲突版本） | 工单和记性本身：`issue_ref`、`memory_item` 块只存它们的 id |
| Markdown 导入和导出 | |

## 在哪

- 服务端 `apps/server/src/doc`（`Docs`）：`doc.ts` 存取和提交，`demo.ts` 是演示（脚本 `demoScript`），`ops.ts` 是 op 的规则（纯函数，在内存里的一篇文档上按顺序施加），`text.ts` 按码点切和接文字，`markdown.ts` 导入导出。顺序键在 `packages/protocol/src/rules/order.ts`（`keyBetween`），服务端和页面用同一份。
- 形状在 `packages/protocol/src/shapes.ts`：`Document`、`BlockInput`（作者给的新块）、`Block`（服务端保存后的块）、`BlockAttrs`、`DocSpan`、`DocMarks`，op 是封闭的联合 `DocOp`（按 `op` 区分），`DocSubmit`、`DocAck`、`DocOpResult`；块的类型是普通字符串，取值是常量（`blockParagraph`……），页面 import 同名常量。
- 表：`doc`（一篇一行，`seq`）、`doc_block`（每一块，含墓碑；`attrs`、`spans` 存 JSON 文本）、`doc_block_revision`（每一块每一版的字，`kind` 是 `normal` 或 `conflict`）、`doc_change`（每一批：`seq`、`batch_id`、谁、改了哪些块、每个 op 的结果）。
- 页面：`apps/web/src/features/doc/`：`DocsPage.tsx` 是「文档」页（左边列表和新建，右边打开的那篇；窄屏只放一边）和块的画法、按键，`editor.ts` 的 `DocEditor` 管本地的块、待发的 op、防抖和问别人写的；不在 `apps/web/src/features/doc/blocks.ts` 以外重写规则：那里只有码点偏移、编辑时保留 marks、编号和行首的 Markdown。
- 帮工的工具：`doc_get`、`doc_block_create`、`doc_block_update`（`apps/server/src/tool/tool.ts`，经 `/mcp` 只给 Session）。
- 接口：`doc.list`、`doc.create`、`doc.import`、`doc.get`、`doc.submit`、`doc.block.create`、`doc.block.update`、`doc.markdown.get`（[capabilities.md](docs/reference/capabilities.md)），主人和「连接到本机」能调，写的人记成 `owner`（`docOwner`）；`doc.demo`（`POST /api/v1/doc/demo`）只有本机的主人能调。

## 模型和不变量

- **一篇文档是一组扁平的块**：`parentId` 表示嵌套，`orderKey` 表示同级的顺序；同级按 `(orderKey, id)` 排，两端在同一处插入、生成了同一个键时顺序仍然确定。
- **块 id 由插入它的一方生成**（uuid），之后不变，在所有文档里唯一。
- **新块命令只带作者决定的内容和位置**：`insert_block.block`、`split_block.newBlock` 都是 `BlockInput`，只含 id、父块、顺序键、类型、属性和文字。文档 id、修订号、墓碑、作者和更新时间由 `Docs` 生成；页面、导入和演示不补假的存盘字段。编辑器待保存块的 rev 0 只是本地占位，后续改字仍等插入回执后才用服务端给的 rev。
- **顺序键**是 base62 的分数索引：两键之间取中点，在两头插入时首位加一或减一；键不以 `0` 结尾，所以前面总有位置。服务端只校验格式（只有 base62、不以 `0` 结尾、不超过 256 位），自己只在导入 Markdown 和帮工追加时生成；页面用同一个 `keyBetween` 生成。
- **块的类型**：`paragraph`、`heading`（`level` 1–3）、`bulleted`、`numbered`、`todo`（`checked`）、`quote`、`code`（`language`，字不带 marks）、`divider`、`image`（`src`、`width`、`height`、`alt`）、`issue_ref`（`issueId`）、`memory_item`（`memoryId`，带字）。`divider`、`image`、`issue_ref` 没有字。服务端只收这些；比客户端新的服务端给出它不认识的类型时，客户端画只读的占位块。
- **marks** 只有 `bold`、`italic`、`code`、`strike`、`link`。字存成 span 的列表，相邻的同样 marks 的 span 合成一个、空的去掉，同一段字只有一种写法。
- **算得出来的不存**：有序列表的编号由页面按同级连续的 `numbered` 数。
- **rev**：每个改到这一块的 op 让它加 1；新块从 1 开始。每一版的字存进 `doc_block_revision`。
- **seq**：文档每收下一批加 1；同一批重发（同一个 `batchId`）不加，回答第一次的结果。
- **墓碑**：删除只置 `deleted`，子块一起；`doc.get` 不返回墓碑。
- **偏移按 Unicode 码点数**，不按 UTF-16。仓库里给人看的字数（`apps/server/src/base/text.ts`）按 UTF-16 码元，两套单位只在这里分开：`split_block` 的 `offset` 是码点，页面把光标的 UTF-16 位置换成码点再发（`codePointOffset`）。

## 怎么走

**提交一批**（`submit`，主人经 `doc.submit`，帮工经工具）。`doc.block.create`、`doc.block.update` 是一块一批的写法（`appendBlock`、`updateBlock`）：块的类型只能是 agent 写的那几种（段落、标题、列表、待办、引用、代码），标题级别 1–3；改一块对着读到时的版本，版本更新了回 `conflict`，不覆盖；帮工的 `doc_block_create`、`doc_block_update` 就是它们。一批这样提交：

1. 一把锁让所有文档的批一个一个来（库只有一个连接，同一文档的 seq 按顺序涨）。开一个事务。
2. 文档不在是 `missing`；`batchId` 见过：同一篇就回答当时的结果和这些块现在的样子，另一篇的就拒绝。
3. 把这篇的全部块（含墓碑）读进内存，按顺序施加每个 op（`page.apply`）。一个 op 的结果不影响同一批里的别的 op。
4. 写回改过的块、新的修订、`doc_change`（`seq` 加 1），提交事务。
5. 回答 `DocAck`：`seq`、每个 op 的结果、改过的块的完整样子。页面用它替换本地的块。

**每个 op 的结果**：`applied`；`conflict`（块保留现在的字，`yours` 是发来的，存成 `conflict` 的修订）；`noop`（删已删的、恢复没删的、并进来的块已删）；`rejected`（不在的块、不认识的类型、坏的顺序键、重复的 id、拆分位置不在字里，`reason` 说明）。`merged` 留给三方合并。

**带 `baseRev` 的 op**（`update_text`、`split_block`）：`baseRev` 等于当前 rev，直接施加；落后时，如果这一块的字从那一版到现在没变过（中间只改了勾选、类型这类），照样施加；字变过就是冲突。同一批里先改属性、再按批次开始时的版本改字，也按这条规则判断。`update_text` 冲突时不改这一块；`split_block` 冲突时在现在的字的末尾拆开（原块的字不动，新块是空的）。

**拆分和合并**都是一个 op：`split_block` 把 `offset` 以后的字挪进页面给好 id、父块和顺序键的新块；`merge_blocks` 拿两块现在的字接起来，来源的子块挪到目标下面（排在目标已有的子块后面），来源置墓碑。

**帮工写**：和主人走同一条 op 管线，写的人记成它的档案 id（Session 不在地里时是它的 id）。`doc_get` 列出每一块的 id、第几版、类型和字；`doc_block_create` 在顶层末尾插一块（服务端生成 id 和顺序键，字按行内 Markdown 读，代码块照原样），回答新块的 id 和版本；`doc_block_update` 带 `baseRev` 整段换字，冲突时不改，回答现在的版本和字，让它看过再决定。没有整篇覆盖的工具。

**编辑器**（工作台的「文档」页）：每一块是一个 `<textarea>`，编辑直接产出 op，中间没有别的编辑器模型。

- 画法：标题按级别三种字号，代码用等宽字和底色，引用左边一条线，无序列表一个圆点，有序列表的编号按同级连续的有序项现算，待办是一个画出来的勾选框（勾上划掉字，发 `set_attrs`），分隔线是一条线；图片、工单引用画成只读的一行；不认识的类型画成只读的占位块。已有的 marks 照样画出来，编辑时两头没改的字保留 marks，打进去的字跟前一个字的 marks（链接除外）。没有 marks 的工具条。
- 每一块左边有一条细的归属条：主人写的是固定的颜色（`ownerColor`），帮工写的是它档案外形的 trim 颜色（档案不在了按 id 取一个），连续同一个帮工写的块第一块旁边画它的头像（`ui/Face.tsx` 的 `AgentFace`），悬停说是谁写的。
- 按键：在一块中间回车（输入框里的换行）是 `split_block`，偏移换成码点；空的列表项回车是变回段落；段首退格：不是段落的先变回段落，段落并进上一块（`merge_blocks`），上一块没有字（分隔线）就删掉它；上、下键在第一行、最后一行时跳到上一块、下一块。粘进来的多行一行拆成一块。段落行首打 `# `、`## `、`### `、`- `、`1. `、`[] `、`[x] `、`> ` 或三个反引号，换成对应的类型（`set_type`），行首的标记去掉。
- 发送：改字先只改本地，停 500 毫秒发一次，一直在打字时最长 2 秒发一次，离开这一块、回车时立刻发；同一块攒着的字合成一个 `update_text`。op 排成队，一次只有一批在路上；一个带 `baseRev` 的 op 改的块已经被同一批前面的 op 改过时，它进下一批，拿服务端回给的新 rev。发不出去的那批留着原来的 `batchId` 重发。
- 收到回答：改过的块整块换成服务端的，只有还有没发的字、还在路上的、正在用输入法拼字的块保留本地的字。冲突的块换成服务端的字，下面一行红字说你写的没存上、留在修订里了。
- **输入法拼字时不发、不换**：拼音还没上屏时不发这一块的字，也不用服务端的字替换它；上屏以后照常发。
- 别人（帮工）写的：还没有广播，页面开着时问 `doc.get`，自己没有待发的东西、文档的 seq 变了，才整篇换上。平时每 4 秒问一次；最近 4 次里问到过别人（不是 `owner`）写的改动，或刚点了演示，就每秒问一次，安静下来再回到 4 秒。
- 在写的块：问来的改动里别人改过的块（新块，或 rev 变了），之后 3 次问之内算「在写」：旁边挂写它的帮工的头像，归属条加粗、一明一暗地呼吸，悬停说「在写」；页面上方的状态多一句「帮工在写」。只按页面问到的时候算，不比两边的钟。
- 主人光标所在的块，问来的改动不换上：这一块整块留着本地的样子（rev 也不动），离开以后下一次问再换上；离开之前打字，按旧的 rev 发出去，照冲突的规则处理。

**演示**（`doc.demo`，页面上的「演示：几个帮工一起写」）：不花模型的钱，让主人看几个帮工同时写一篇是什么样子。

1. 接口立刻回答，演示在后台跑；农场里同时只跑一场，正在跑时再点被拒绝（「演示正在写，写完再点」）。没有开着的帮工的档案也被拒绝。
2. 从帮工的档案（不含管家）里按顺序取开着的前三个，每个一节：先在文档末尾按顺序插三个二级标题（「背景 · 演示」「做法 · 演示」「下一步 · 演示」），写的人是各自的档案 id。
3. 三个帮工同时写自己那一节：在这一节的末尾（上一块和下一节的标题之间取顺序键，在提交的锁里取，两个帮工不会抢到同一处）插一个空段落，再每一拍（约 1 秒，前后浮动三成，几个帮工错开）用 `update_text` 带上一版的 rev 把这一段换成更长的字，六拍写完一段，一节三段。第一段以「（演示）」开头。整场 20 多秒。
4. 全部走 `submit`：rev、seq、修订、`doc_change` 都是真的，归属条照常画。主人在帮工正长着的那一段里改了字，帮工下一拍是冲突，不再碰这一段，接着写下一段。
5. 脚本是 `demo.ts` 里的 `demoScript`，不是帮工写的。服务端停下时演示跟着停。

**其他**：`set_attrs` 按字段写（`unset` 列出要删的键），后到的生效；`set_type` 换类型和整套属性，新类型没有字就丢掉字，换成 `code` 去掉 marks；`move_block` 挪到自己下面被拒绝，挪到已删的父块下面就挂到那个父块所在的层级；`restore_block` 连子块一起恢复。

**Markdown**：导出按文档顺序写，嵌套每层缩进两个空格，列表项之间空一行以外都空两行；`issue_ref`、`memory_item` 写成 HTML 注释（`<!-- issue:ID -->`、`<!-- memory:ID --> 字`），图片的尺寸写在标题里（`"640x480"`）；字里的 `\ * _ ` + "`" + ` ~ [ ]`加反斜杠，像别的块开头的段落行前加反斜杠；斜体写`_斜_`，挨着字母或数字时写 `_斜_`。导入读回同样的块：`**粗**`、`_斜_`或`_斜_`、`` `码` ``、`~~删~~`，链接是方括号里的字加圆括号里的地址；词中间的下划线（`doc_block_create`）是字，不是斜体。导入是一个新文档，块作为一批 `insert_block` 提交。

## 和谁打交道

- **地基（`base`）**：只用数据库和 `newId`；不依赖别的服务，也不进核心状态：文档不在 `StateFrame` 里，页面用 `doc.get` 取。
- **档案（`agent`）**：不 import 它；`doc.demo` 的处理函数把帮工的档案（`Agent.Agents()`）交给 `demo`，挑哪几个由 `doc` 定。
- **工具（`tool`）和 `/mcp`**：帮工的三个工具调 `get`、`append`、`updateText`；`mcp` 认出是哪个 Session，`tool` 取它的档案当写的人。

## 为什么这样

- **按块存、按 op 改、服务端说了算。** 放弃了保存整篇：两个人改不同段落时后存的会盖掉先存的，帮工写一段也会盖掉人正在改的。放弃了现在就上 CRDT：同一段里逐字协同和长时间离线编辑还不需要；所有修改只走 op、所有位置都用块 id 描述，以后要换时上层不用改（[提案](.agents/notes/proposed/feature/2026-10-20-block-editor-collab.md)）。
- **回答里带改后的块，不带 op。** 页面直接替换本地的块，不用在本地重放一遍规则；以后的广播也发块的样子。
- **规则在内存里的一篇文档上跑。** 一批 op 读一次、写一次，`ops.ts` 是纯函数，测试不用数据库；一篇文档的块数量不大，整篇读进来比按 op 查省事。
- **落后但字没变的 `baseRev` 照样收。** rev 每个 op 都加，勾一下待办也加；只比 rev 会让「勾选之后接着打字」变成冲突。比较那一版的字和现在的字，结果和三方合并在这种情况下一样。
- **类型是字符串，不是枚举。** 封闭的联合遇到不认识的值会解码失败，整篇打不开；字符串加常量让旧页面画占位块。
- **顺序键在两头加一减一。** 只取中点时，一直往末尾追加，键每六次长一位；加一减一每 61 次才长一位。同一处反复插入仍然会变长，以后由服务端重排。
- **一把锁管所有文档。** 库只有一个连接，按文档分锁不会更快。
- **编辑器自己写，不用 `appflowy_editor`。** 每块一个 `textField`，编辑直接就是 op，拆分和合并不用从别人的 Transaction 翻译；按键规则照它的行为写（[提案](.agents/notes/proposed/feature/2026-10-20-block-editor-collab.md)）。
- **广播之前先轮询。** WebSocket 是 P2 的事；回答里带改后的块，主人自己的改动不用再问；帮工写的靠每 4 秒一次的 `doc.get`，有待发的改动时不问，免得盖掉还没发的字。

## 还没做的

- 广播和 presence（WebSocket）、三方合并（`merged`）、拆分的偏移映射、断线补交、修订的清理和找回、撤销：[块编辑器协同](.agents/notes/proposed/feature/2026-10-20-block-editor-collab.md)。
- 几个帮工同时写一篇文章、建议、确认：[几个帮工同时写一篇文章](.agents/notes/proposed/feature/2026-10-20-block-editor-ux.md)。

## 怎么验证

- `apps/server/src/doc/rules.test.ts`：拆分时留着 marks、接起来时合并一样的 marks；两键之间的键在两者之间；同键按 id 排；改过的块带着 rev 和写的人；协议里每种 op 都有分支；代码块没有 marks；Markdown → 块 → Markdown、块 → Markdown → 块不丢东西。
- `doc/doc.test.ts`：一个人写的东西重启后还在；同一批发两次只收一次、回答一样；落后的改字盖住别人的改动是冲突、我写的存进修订；同一批勾选后改字不误判冲突；导入导出；演示写三节（跳过关着的档案、每节连续、写的人、正在跑时再开被拒绝）；主人接手正长着的一段，演示不再改它。
- `mcp/mcp.test.ts`：帮工经 `/mcp` 写文档。
- 页面：`apps/web/src/features/doc/blocks.test.ts`（键和服务端生成的一样、偏移是码点、编辑保留 marks、行首 Markdown 和编号）；`apps/web/test/docs.spec.ts`（建一篇、一块一块写、写的留着；段首退格并段）。
- `apps/server/src/http/endpoints.test.ts`：真实 HTTP 接受没有存盘元数据的最小插入和拆分命令，回读的文档、修订、作者和时间由服务端填入。
