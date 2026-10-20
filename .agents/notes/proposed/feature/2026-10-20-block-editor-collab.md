# Agent Note: 块编辑器协同：按块存，按 op 改，服务端是唯一权威

Status: proposed

## Problem

要一个多人（加 agent）能同时编辑的文档：Flutter App 和 Go 服务端共用一份约定，文档按块（段落）存储，所有修改都是按块 ID 描述的 op，服务端是唯一权威。合并以段落为单位，现阶段不用 CRDT。

要做到：

- 多人加 agent 同时编辑一篇文档，改不同段落时互不影响
- 改到同一段时尽量自动合并，合并不了也不丢内容
- 手机短暂断网（电梯、切后台、切网络）后能补交修改

现在不做：

- 长时间离线编辑和离线合并
- 同一段里逐字实时协同（像 Google Docs 那样看到对方逐字打字）
- 点对点同步

以后真需要上面这些，再在 op 层下面接 CRDT（见「Alternatives considered」的 CRDT 一条），上层不用改。

## Proposal

### 文档模型

一篇文档是一组块，存成扁平列表：用 `parentId` 表示嵌套，用 `orderKey` 表示同级顺序。

```jsonc
// Document
{
  "id": "doc_01J...",
  "title": "string",
  "seq": 128            // 文档级变更序号，每接受一批 op 加 1，用来追增量
}

// Block
{
  "id": "blk_01J...",   // 客户端生成（ULID/nanoid），创建后永不改变
  "docId": "doc_01J...",
  "parentId": null,     // 顶层为 null；列表缩进、toggle 子块用它
  "orderKey": "a0V",    // fractional indexing，同级按字典序排
  "type": "paragraph",
  "attrs": {},          // 由 type 决定，见下表
  "text": [             // 富文本，按 span 存
    { "t": "你好，", "marks": {} },
    { "t": "世界", "marks": { "bold": true, "link": "https://..." } }
  ],
  "rev": 7,             // 块级版本号，每次被修改加 1
  "deleted": false,     // 墓碑，删除时不物理删
  "updatedBy": "user_x | agent_y",
  "updatedAt": "RFC3339"
}
```

块类型（第一版）：

| type | attrs | 有 text |
|---|---|---|
| `paragraph` | — | 是 |
| `heading` | `level: 1-3` | 是 |
| `bulleted` / `numbered` | — | 是 |
| `todo` | `checked: bool` | 是 |
| `quote` | — | 是 |
| `code` | `language: string` | 是（不带 marks） |
| `divider` | — | 否 |
| `image` | `src, width, height, alt` | 否 |
| `issue_ref` | `issueId` | 否 |
| `memory_item` | `memoryId` | 是 |

规则：

- **算得出来的东西不存**：有序列表的编号、目录、标题序号都在渲染时计算。
- marks 第一版只有 `bold` `italic` `code` `strike` `link`。
- 新增 type 必须两端同时支持；不认识的 type，客户端按只读占位块显示，不能丢掉。

##### orderKey

- 用 fractional indexing 生成字符串 key（base62），在两个相邻 key 之间生成新 key。
- 由客户端生成，服务端只校验格式。
- 两端同时在同一位置插入、生成了相同的 key 时，按 `(orderKey, id)` 排序，结果仍然确定。
- 不做全量重排。key 变长到一定程度（比如超过 32 字符）再由服务端在后台给该层重新分配。

### Op 列表

所有修改，包括编辑器、agent、服务端内部任务，都只能通过下面这些 op。没有"保存整篇"的接口。

| op | 字段 | 需要 baseRev | 说明 |
|---|---|---|---|
| `insert_block` | `block`（完整块，含 id、parentId、orderKey） | 否 | 新块，`rev` 从 1 开始 |
| `update_text` | `blockId, baseRev, text` | 是 | 整段新文本，冲突时服务端三方合并（见「冲突规则」） |
| `set_attrs` | `blockId, attrs`（patch，`null` 表示删除该键） | 否 | 按字段 LWW |
| `set_type` | `blockId, type, attrs` | 否 | LWW；新 type 没有 text 时丢弃 text 前要求客户端确认 |
| `move_block` | `blockId, parentId, orderKey` | 否 | LWW |
| `delete_block` | `blockId` | 否 | 置墓碑，子块一起置墓碑 |
| `restore_block` | `blockId` | 否 | 撤销删除 |
| `split_block` | `blockId, baseRev, offset, newBlock` | 是 | 在一段中间按回车（见「拆分和合并段落」） |
| `merge_blocks` | `targetId, sourceId` | 否 | 在段首按退格，把 source 接到 target 末尾（见「拆分和合并段落」） |

说明：

- `offset` 按 Unicode code point 计数，不按 UTF-16。Dart 和 Go 默认的字符串长度不一样，必须统一。
- 拆分和合并必须是**一个原子 op**，不能拆成"改文本 + 新建块"或"改文本 + 删块"两步发。
- `set_attrs` 不需要 baseRev，因为按字段 LWW，不同字段互不冲突。例如 A 勾选 todo、B 改文字，两边都生效。

### 同步协议

传输层：一条 WebSocket，承载提交、广播和 presence。断线时客户端排队，重连后补交。

##### 提交

```jsonc
// 客户端 → 服务端
{
  "type": "submit",
  "docId": "doc_01J...",
  "batchId": "bat_01J...",   // 客户端生成，幂等键：重复提交只处理一次
  "lastSeq": 128,            // 客户端已经看到的文档 seq
  "ops": [ /* 「Op 列表」里的 op */ ]
}

// 服务端 → 提交者
{
  "type": "ack",
  "batchId": "bat_01J...",
  "seq": 129,
  "results": [
    { "status": "applied", "blockId": "blk_a", "rev": 8 },
    { "status": "merged",  "blockId": "blk_b", "rev": 5, "text": [ /* 合并后的文本 */ ] },
    { "status": "conflict","blockId": "blk_c", "rev": 9, "yours": [ /* 你的文本 */ ] }
  ]
}

// 服务端 → 其他在线客户端
{
  "type": "change",
  "docId": "doc_01J...",
  "seq": 129,
  "actor": "user_x",
  "blocks": [ /* 本批次改动后的块完整状态 */ ]
}
```

- 一个 batch 里的 op 按顺序应用，整个 batch 在一个事务里。
- 广播发的是**改动后的块状态**，不是 op。客户端直接替换本地块，不需要在本地再执行一遍别人的 op，两端逻辑最简单。
- 每个 op 的结果单独返回。一个 op 冲突，不影响同一 batch 里的其他 op。

##### 客户端本地流程

1. 用户编辑时，先改本地状态，界面立刻响应，同时把 op 放进**待确认队列**。
2. 文本修改做防抖：停止输入 500ms 后发，或者离开这一段、按回车时立刻发；连续打字时最长 2s 发一次。同一块的多次 `update_text` 在队列里合并成一个。
3. 收到别人的 `change`：
   - 块不在我的待确认队列里：直接替换。
   - 块在我的待确认队列里：先用服务端版本更新这个块的 `rev` 和"base 文本"，本地显示的仍然是我的版本，等我的提交回来再以 ack 为准。
4. 收到 ack：`applied` / `merged` 用服务端结果更新本地；`conflict` 进入冲突提示（见「冲突规则」）。

##### 断线和重连

- 断线期间 op 留在待确认队列，持久化到本地（App 被杀掉后也不丢）。
- 重连后先发 `{"type":"sync","docId","lastSeq"}`：
  - 服务端还保留着 `lastSeq` 之后的变更：返回这些变更涉及的块的最新状态。
  - 落后太多（变更日志已经清理，或差距超过 1000 个 seq）：返回整篇快照。
- 拿到最新状态后，再补交队列里的 op。每个 op 带的仍然是**它产生时的 baseRev**，服务端按冲突规则处理。

### 冲突规则

冲突只会发生在 `update_text` 和 `split_block` 上：提交时带的 `baseRev` 小于块的当前 `rev`。

处理分三层：

**第 1 层：避免冲突（presence 软锁）**

- 客户端进入某一段编辑时，发送 presence：`{"type":"presence","docId","blockId","actor"}`，每 5s 心跳一次，10s 收不到就视为离开。
- 其他人看到这一段旁边显示头像或高亮。只提示，不禁止编辑。
- presence 不落库，只在内存里转发。

**第 2 层：服务端三方合并**

- 服务端取三份文本：`base`（`baseRev` 那一版，从 `block_revisions` 读）、`current`（当前版本）、`yours`（这次提交的）。
- 用 diff-match-patch：`patch_make(base, yours)` 得到补丁，`patch_apply` 到 `current` 上。
- 所有补丁都应用成功：接受合并结果，`rev + 1`，返回 `merged`。
- 合并在纯文本上做。marks 合并规则：没有被双方同时改到的范围保留各自的 marks；重叠范围以 `current` 为准。第一版可以先只合并纯文本、marks 以 `current` 为准，再迭代。

**第 3 层：合并失败，不丢内容**

- 服务端保留 `current`，不覆盖别人写的内容。
- 返回 `conflict`，带上 `yours`。同时把 `yours` 存进 `block_revisions`，标记为冲突版本。
- 客户端在这一段显示提示："这段刚被 X 修改，你的版本没有保存"，提供"查看我的版本 / 用我的版本覆盖 / 放弃"。选择覆盖时，用新的 `baseRev` 重新提交。

其他情况：

| 情况 | 处理 |
|---|---|
| 改一个已经被删除的块 | 返回 `conflict`，原因是 `deleted`；客户端提示"这段已被 X 删除"，可选恢复 |
| 在已删除的块后面插入 | 正常插入。墓碑保留 orderKey，新块的位置仍然有效 |
| 移动到已删除的父块下 | 改挂到父块原来所在的层级 |
| 两人同时 `set_attrs` 同一字段 | 后到服务端的生效 |

### 拆分和合并段落

**拆分 `split_block`**

客户端发送：在 `baseRev` 版本的第 `offset` 个字符处拆开；前半段留在原块，后半段放进 `newBlock`（客户端带好 id 和 orderKey）。

- `baseRev` 等于当前 `rev`：直接拆。
- `baseRev` 落后：先用 diff 把 `offset` 从 base 映射到 current 的对应位置。
  - 映射成功（拆分点附近没被别人改过）：在 current 的映射位置拆开。
  - 映射失败（拆分点正好在别人改过的范围里）：在 current 末尾拆，即原块保持 current 不动，新块为空，再返回 `conflict` 让客户端提示。

**合并 `merge_blocks`**

- 永远拿**当前**的 target 文本接上**当前**的 source 文本，然后删除 source。因为用的是两边的最新状态，不会有冲突。
- source 有子块时，子块改挂到 target 下面。
- source 已经被删除时，op 视为无效，返回 `noop`。

这两部分的规则必须写成两端共用的测试用例（见「Acceptance criteria」里的共用用例）。

### Agent

- Agent 在服务端直接走同一条 op 管线，`actor` 记为 agent 的 id。
- 追加内容用 `insert_block`，改内容用带 `baseRev` 的 `update_text`，不允许整篇覆盖。
- Agent 写之前查 presence：有人正在编辑的段落，agent 不改，改为在后面插入新块，或者等待。
- 流式生成时，先插入一个空块，再用 `update_text` 更新这一块。agent 的流式更新节流到 1s 一次，避免广播太频繁。

### 撤销

- 每个客户端只撤销**自己的** op，不撤销别人的。
- 撤销时根据本地记录生成反向 op（插入 ↔ 删除、文本改回旧值、移动回原位置），作为一个新 op 提交，带当前的 `baseRev`，走正常冲突规则。
- 撤销栈只在本地内存里，不同步。

### 服务端存储（Go）

```
docs            (id, title, seq, created_at, updated_at)
blocks          (doc_id, id, parent_id, order_key, type, attrs jsonb, text jsonb,
                 rev, deleted, updated_by, updated_at)
block_revisions (block_id, rev, text jsonb, actor, kind, created_at)
                 -- kind: normal | conflict；三方合并的 base 从这里读，也用于历史和找回
doc_changes     (doc_id, seq, batch_id unique, actor, block_ids, created_at)
                 -- 增量同步用：lastSeq 之后改了哪些块
```

- `block_revisions` 和 `doc_changes` 保留 30 天（暂定），超过的清理。客户端落后超过保留范围时拉快照。
- 同一文档的提交串行处理，比如按 docId 加锁，或者用单协程队列，保证 seq 单调递增。
- Markdown 导入和导出在服务端实现，作为和 agent、`MEMORY.md` 交换内容的格式，不作为存储格式。

落地时按仓库的规矩来：表名是「模块_概念」、单数，比如模块叫 `doc`，表就是 `doc`、`doc_block`、`doc_block_revision`、`doc_change`；库是 SQLite，上面的 `jsonb` 换成存 JSON 文本的 `text` 列；结构写进 `server/migrations/0001_schema.sql`，查询放 `server/pkg/db/queries/<表>.sql`（[AGENTS.md](AGENTS.md)）。传输上，服务端现在给 App 推状态用的是 SSE；协同要一条双向的连接，用 WebSocket 是新加的一种，要和现有的推送说清分工。

### Flutter 端

- 编辑器自己做：一列块，每块一个 Flutter 自带的 `TextField`，数据就是上面的 `Block`，每次编辑直接产出「Op 列表」里的 op（回车在段中间是 `split_block`，段首退格是 `merge_blocks`），中间没有别的编辑器模型要翻译。
- 参考 `appflowy_editor`，不依赖它。借鉴这几样：块的类型和画法分开登记（找不到登记的类型就画只读占位块）；块之间的按键规则（回车拆段、段首退格并段、上下键跨块、空列表项回车退出列表），照它的行为写成用例；行首的 Markdown 快捷输入（`# ` 标题、`- ` 列表、`[] ` 待办、三个反引号代码块，都是 `set_type`）；选中文字时的工具条（第一版的五种 marks）。跨块选中第一版不做，只在一块之内选。
- 早期必须用中文输入法测：拼音组字时按退格、在段首按回车、组字过程中收到别人的 `change`。**组字过程中不要替换当前正在编辑的块**，等组字结束再应用。

### 分阶段

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| P1 | 块模型、op 管线、存储、单人编辑、Markdown 导入导出 | 单人编辑重启后不丢，Markdown 往返用例通过 |
| P2 | WebSocket 广播、块级 rev、presence、三方合并、冲突提示 | 两台设备同时编辑，共用用例里的并发几条通过 |
| P3 | 拆分和合并的冲突映射、断线补交、历史与找回、agent 接入 | 弱网模拟和 agent 流式写入下不丢内容 |

### 进度

P1 的服务端做了（[文档](docs/subsystems/doc.md)）：

- 块模型、全部九种 op、存储（`doc`、`doc_block`、`doc_block_revision`、`doc_change`）、一批一个事务、`batchId` 去重、seq、每个 op 的结果、墓碑、修订、顺序键、码点偏移、Markdown 导入导出和往返用例。
- 落后的 `baseRev`：这一块的字从那一版起没变过就照收，变过就是 `conflict`（`split_block` 在末尾拆）。三方合并（`merged`）留在 P2。
- 还没有 WebSocket：`doc.submit` 的回答里带改后的块；页面开着时每 4 秒问一次 `doc.get`，看帮工写的；最近问到过别人的改动就每秒问一次，别人刚改过的块挂头像、归属条呼吸，主人光标所在的块不被问来的改动换掉。
- 演示（`doc.demo`）：不用模型，三个帮工档案按脚本同时写各自的一节，每秒左右用 `update_text` 把一段换长，走真的 op 管线，用来先看「几个帮工同时写」和 P3「agent 流式写入」的样子（[文档](docs/subsystems/doc.md)）。
- 帮工经 `/mcp` 的 `doc_read`、`doc_append`、`doc_update` 写，走同一条管线，`actor` 是它的档案（P3 的 agent 接入先做了不流式、不查 presence 的这一部分）。
- Flutter：工作台的「文档」页，编辑器是自己的一列 `TextField`：各种块的画法、回车拆段、段首退格并段、上下键跨块、空列表项回车退出列表、行首 Markdown 换类型、防抖和待发队列、按作者的归属条、不认识的类型画占位块、拼字时不替换。marks 只画不改（工具条留到以后）。
- P1 的完成标准两条都有测试：重开库后不丢（`TestEditsSurviveARestart`），Markdown 往返（`TestMarkdownRoundTrip`、`TestBlocksRoundTrip`）。两端共用的 JSON 用例还没写，Go 和 Dart 各自测。

### 待定

- 嵌套最多几层？
- 文档权限：谁能编辑，agent 能改哪些文档？
- 冲突提示的具体交互
- `block_revisions` 保留多久？
- 第一批用在哪类文档上：工单描述、记忆，还是通用文档？
- 单篇文档的块数上限（影响快照大小和首屏加载）

## Alternatives considered

**编辑器用 `appflowy_editor`。** 它是节点树加 Transaction，功能齐全。不用它：它的 Transaction 要翻译成我们的 op，拆分和合并能不能稳定对上是最大的不确定；装进来要改动 36 个依赖、还要给 `xml` 降版本；界面是另一套风格，改成像素风不如自己画。只参考它的做法（见「Flutter 端」）。

**现在就上 CRDT。**

只有出现下面的需求时才考虑：

- 同一段里多人实时逐字协同，而且很常见
- 需要长时间离线编辑

到时的做法：块的文本字段换成 CRDT 文本（比如 yrs 的 `Y.Text`），块列表换成 `Y.Array<Y.Map>`；Go 服务端通过 cgo 调 yrs，或者加一个协同 sidecar。「Op 列表」里的 op 在适配层翻译成 CRDT 操作，编辑器和业务代码不变。

现在为此要守住的只有两条：**所有修改只走 op；所有位置都用块 ID 描述。**

**保存整篇。** 最简单，可两个人改不同段落时后存的会盖掉先存的，agent 写一段也会盖掉人正在改的。所以没有「保存整篇」的接口，所有修改只走 op。

**广播 op，让每个客户端在本地重放。** 省流量，但两端都要实现同一套应用逻辑、还要保证顺序一致。改成广播改动后的块状态，客户端直接替换本地的块，两端都最简单。

## Acceptance criteria

两端共用一份 JSON 用例，Dart 和 Go 各写一个 runner 跑同一份：

两端共用一份 JSON 用例，Dart 和 Go 各写一个 runner 跑同一份：

```jsonc
{
  "name": "两人改同一段的不同位置，自动合并",
  "initial": [ /* 初始块 */ ],
  "submits": [
    { "actor": "A", "ops": [ /* ... */ ] },
    { "actor": "B", "ops": [ /* 基于旧 rev */ ] }
  ],
  "expect": {
    "blocks": [ /* 最终块状态 */ ],
    "results": [ "applied", "merged" ]
  }
}
```

用例至少覆盖：

- 不同块并发修改
- 同一块不同位置（合并成功）、同一位置（冲突）
- 同一位置并发插入（orderKey 相同）
- 拆分时别人改了拆分点之前、之后、正好在拆分点上
- 合并时 source 被删、被改
- 改已删除的块、在已删除块后插入
- 中文、emoji、组合字符下的 offset 计算
- 断线补交、重复提交同一个 batchId
- Markdown 往返不丢内容

按阶段，每一段做到下面的状态算完：

- P1：单人编辑重启后不丢，Markdown 往返用例通过。
- P2：两台设备同时编辑，上面的并发用例通过。
- P3：弱网模拟和 agent 流式写入下不丢内容。

## Risks

- **中文输入法组字。** 拼音组字时按退格、在段首按回车、组字过程中收到别人的 `change`，都可能把正在组的字弄丢；组字过程中不替换当前块，要在早期就用真输入法测。
- **编辑器选型。** `appflowy_editor` 的 Transaction 能不能稳定对应到这里的 op（尤其拆分和合并）还没确认；对不上就要自己写适配，甚至换编辑器。
- **offset 的单位。** Dart 默认按 UTF-16 数，Go 按字节，约定按 Unicode code point；任何一端算错，拆分和合并就会切在错的位置。仓库里另有按 UTF-16 数的约定（`pkg/x/str`），两套单位要在接口上写明。
- **orderKey 越来越长。** 反复在同一处插入会让 key 变长，要靠服务端后台重排兜底。
- **同一段里的冲突仍然会出现。** 三方合并失败时只保证不丢内容，要人来选；同一段逐字实时协同、长时间离线编辑是有意放弃的。
- **修订历史的保留期。** 保留太短，落后的客户端只能拉整篇快照，三方合并也拿不到 base；太长则占空间。暂定 30 天。
