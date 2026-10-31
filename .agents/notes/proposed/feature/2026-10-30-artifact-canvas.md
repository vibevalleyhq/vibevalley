# Agent Note: 产出画布：边聊边改、指块带话、按位置插删块

Status: proposed

## Problem

[产出](docs/subsystems/artifact.md)已经把文档存成扁平的块（`artifact_block`）、改字走 op 管线（`ops.ts`）、网页按版本隔离预览，但主人在工作台里和管家、帮工一起改一篇产出时，还差四件事才算得上顺手的画布（Canvas）：

1. **看产出和聊天不在同一屏。** 在聊天页（`apps/web/src/features/channel/ChatPage.tsx`）点开消息里的 `ArtifactCard` 会跳去 `/artifacts/<id>`，离开正在说的频道或工单串；在产出页（`apps/web/src/features/artifact/ArtifactsPage.tsx`）右侧只有一个孤立的 `Reply` 输入框，看不到上下文消息，发完还得跳回聊天页看帮工怎么回。
2. **不能指着一块让 agent 改。** 主人想让帮工「把这一段改短一点」或「把这段改成代码块」，只能口头描述第几段，帮工还得先调 `artifact_content_get` 把整篇拉下来找块 id。
3. **agent 的块工具只能往末尾追加、不能插在中间或删块，且管家没有块工具。** `ops.ts` 支持全部 9 种 op，但暴露给模型的工具（`apps/server/src/tool/tool.ts`）只有 `artifact_block_create`（固定追加在顶层末尾）和 `artifact_block_update`（只能换字，不能改类型和属性），没有删块和移动，而且这两个工具只在 `session` 表里，管家（`orchestrator`）在私聊或频道里没法直接替主人改一块。
4. **帮工改主人写过的块没有确认步骤。** 帮工拿到最新的 `baseRev` 调 `artifact_block_update` 时会直接换掉主人刚改过的字，主人来不及比对新旧两版。

## Proposal

### 交付阶段

第一阶段交付同屏画布、指块带话、完整块工具与订阅（下文第 1–3 项），保留现有块版本冲突检查。第二阶段才增加建议修订（第 4 项）；第一阶段不承诺自动保护主人写过的块，也不把引用块当作新增的直接修改授权。两阶段分别提交和验收，第二阶段未完成不阻塞第一阶段。


不另起一套「画布」表或模块，直接在 `artifact`、`channel` 和 `tool` 上补齐下面四块。

### 1. 同屏分栏：聊天旁开画布，产出页看对话串

把「对话流」和「产出画布」合成同屏的左右两栏，两端共用同一个画布组件（从 `ArtifactsPage.tsx` 的 `Shown` 抽出 `ArtifactCanvas.tsx`）：

| 所在页面 | 左栏 | 右栏 | 怎么开关 |
|---|---|---|---|
| 聊天页 `/chat/<id>` | 频道、私聊或工单串的消息流与输入框 | 当前打开的产出（`?artifact=<id>&v=<版本>`）：块编辑器或 HTML 预览 | 点消息里的 `ArtifactCard` 在右侧展开（窄屏跳 `/artifacts/<id>`）；右上角关闭清掉 `?artifact` |
| 产出页 `/artifacts/<id>` | 产出列表（可收起）加中间的产出画布 | 产出所属的对话串消息流（`said` 对应的频道或工单串，复用 `MessageList` 和 `createComposer`），网页产出上方保留版本列表 | 默认展开对话串，主人在画布旁直接看上下文并说话 |

- 帮工或管家在当前频道、串里交上来新产出（`artifact_create`）或网页新版（`artifact_version_create`），且主人正开着这个频道或串的画布分栏时，画布自动切到最新交上来的那一版。
- 块产出的同步从轮询切到 `Subscriptions`（[块编辑器协同](.agents/notes/proposed/feature/2026-10-20-block-editor-collab.md)）：`artifact.follow({ id, afterSeq })` 先补 `afterSeq` 之后改过的块，再推每次 `submit` 的 `BlockAck.blocks`；主人看着左侧聊天时，右侧画布里的块随着帮工调工具实时长出来。

### 2. 指块带话：选中块引用进输入框，提示词自动附带块原文

主人在 `BlocksView.tsx` 里点中一块（或悬停点块右侧的「带话」图标按钮）：

1. 页面把这块挂到当前输入框（聊天页右栏打开时挂进聊天输入框，产出页挂进右侧串输入框）的引用栏里，显示块的开头文字和第几版，可挂多块、可点 × 去掉。
2. `channel.message.send` 的请求和 `ChatMessage.meta` 加可选的 `blocks?: readonly { readonly artifactId: string; readonly blockId: string; readonly rev: number }[]`。
3. 服务端在 `apps/server/src/channel/prompts.ts` 给管家和帮工拼消息时，若消息带 `meta.blocks`，从库里读出这些块现在的 `rev`、`type` 和文字，同时保留消息引用时的 `rev`；版本不同时明确标出变化，已删除时标出墓碑，不把旧引用伪装成当前版本，附在那条消息下面：
   ```text
   │ [指着产出「周报」（id=art_1）的块：]
   │ - 〔blk_a · 第 3 版 · paragraph〕这周做完了第一步和第二步
   ```
4. 管家和帮工读到这条消息就已经拿到 `artifactId`、`blockId` 和 `baseRev`，直接调 `artifact_block_update` 或在它后面调 `artifact_block_create`，不必先调 `artifact_content_get` 读整篇。

### 3. 补齐块工具：定点插入、改类型与属性、删块，管家与帮工共用

在 `apps/server/src/artifact/blocks.ts`、`apps/server/src/tool/schemas.ts` 和 `apps/server/src/tool/tool.ts` 中补齐块级工具，并同时放进 `orchestrator` 和 `session` 的工具表：

| 工具名（接口名） | 参数 | 行为 |
|---|---|---|
| `artifact_block_create`（`artifact.block.create`） | `id`、`text`、`type?`、`level?`、`checked?`、`language?`、`afterBlock?`、`parentId?` | 在 `parentId`（默认顶层）下、紧挨着 `afterBlock` 后面插一块；不填 `afterBlock` 照旧插在同级末尾；`afterBlock` 填 `""` 插在同级开头。服务端在提交锁内读相邻块算出 `orderKey` |
| `artifact_block_update`（`artifact.block.update`） | `id`、`block`、`baseRev`、`text?`、`type?`、`level?`、`checked?`、`language?` | 只传 `text` 走 `update_text`；传了 `type` 走 `set_type`；传了 `checked` 等属性走 `set_attrs`；同时传在一个 batch 里按顺序提交 |
| `artifact_block_delete`（`artifact.block.delete`） | `id`、`block` | 走 `delete_block` 置墓碑（连同子块），回答删掉的块 id；已删的回答 `noop` |

- `artifact_content_get` 返回的每一行块信息（`blockLine`）加上缩进层级、待办的 `[x]` / `[ ]` 和代码块的 `language`，让模型看得见结构。
- 管家调块工具时，`actor` 记为管家的档案 id；帮工调时照旧记为帮工的档案 id。

### 4. 建议修订（第二阶段）

消息的 `meta.blocks` 只提供上下文，不表达直接修改授权。第二阶段应先定义明确的修改指令及其可验证范围；未定义前，模型修改主人写过的块均生成建议。授权设计与 [管家的授权](.agents/notes/proposed/feature/2026-10-21-orchestrator-authorization.md) 对齐，不另存一份隐式权限。

建议应记录独立 id、actor、目标块、baseRev、操作种类及候选内容；更新文字、类型、属性和删除应分别保留语义，不能都压成 text。未处理建议、接受和拒绝的结果应能持久化并经订阅恢复。

接受建议应在提交锁内比较当前 rev 与建议 baseRev：相同才应用；不同返回冲突并要求重新生成或由主人明确解决，不把旧建议套在当前 rev 上提交。多个建议保留各自身份，不静默覆盖其他帮工的待处理建议。接受与拒绝应幂等，重复请求不重复应用。

页面展示建议作者、操作及增删差异。第二阶段开始实现前，应补齐建议 Schema、授权边界和并发验收，不预先把原稿的单条 `suggestion` 字段固化为契约。

## Alternatives considered

**像 OpenAI Canvas 那样让模型在聊天流里用特殊标签流式吐整篇全文，前端拦截标签写进画布。** 整篇流式重写适合单人短文，但 VibeValley 的一篇产出允许主人和几个帮工同时按块改（[几个帮工同时写一篇文章](.agents/notes/proposed/feature/2026-10-20-block-editor-ux.md)）；整篇重写会把主人正在改的段落冲掉，还会丢失每块的 id、归属条和修订历史。保留「按块调工具 + 服务端 op 管线 + RPC 推块状态」，既能实时看到块一段段长出来，又不破坏按块协同的不变量。

**单独造一套 `/canvas` 页面和 `canvas` 表，和 `/artifacts` 分开。** 之前已经把「文档」和「产出」合在了一起（[产出](docs/subsystems/artifact.md#为什么这样)），再分出「画布」又会让主人和帮工面临「交到哪一边、去哪一边找」的分叉。画布就是产出的同屏打开方式。

**帮工的所有 `artifact_block_update` 一律走建议，让主人逐条点接受。** 帮工从零写一节或主人刚指着那一块说「把这段改成列表」时，还要再点一次「接受」纯粹是多一步打断。建议适用范围在第二阶段按明确修改授权制定，块引用本身不作为授权。

**给模型开放原始的 `artifact_submit`（9 种 `BlockOp` 任意组合）。** 原始 `BlockOp` 要求调用方自己生成 uuid 和 base62 的 `orderKey`、自己算 UTF-16 到 Unicode 码点的偏移，模型容易算错 `orderKey` 或码点偏移。由 `artifact_block_create`、`artifact_block_update`、`artifact_block_delete` 在服务端锁内代算 `orderKey` 和解析行内 Markdown，接口简单且不会写出坏的顺序键。

## Acceptance criteria

- 在聊天页点开消息上的 `ArtifactCard`，右侧同屏展开画布，左侧消息流和输入框照常可用；在产出页打开一篇交上来的产出，右侧显示它所在串的消息流并可直接发消息。
- 在块编辑器里点一块的「带话」发消息，管家或帮工收到唤醒时提示词里直接带有该块的 `id`、`rev` 和文字，不调 `artifact_content_get` 就能用 `artifact_block_update` 改好这块。
- 管家和帮工都能用 `artifact_block_create` 的 `afterBlock` 在指定块后面插块、用 `artifact_block_update` 改块的文字、类型和待办勾选、用 `artifact_block_delete` 删块；页面经 `artifact.follow` 实时看到改动，不用等 4 秒轮询。
- 第二阶段：建议接受时校验 baseRev；主人后续编辑导致冲突时保留原字并显示冲突；接受、拒绝可重复请求，未处理建议重启后仍在。
- `apps/server/src/artifact/blocks.test.ts` 和 `mcp/mcp.test.ts` 覆盖定点插入、删块、改类型；第二阶段另覆盖建议授权、版本冲突、删除建议、多建议并存和幂等分支；`apps/web/test/artifact.spec.ts` 和 `artifact-blocks.spec.ts` 覆盖第一阶段的聊天页同屏分栏、指块带话；第二阶段另验收接受与拒绝建议。

## Risks

- **聊天页分栏在窄屏下放不下。** 小于 `lg`（1024px）的窗口和手机上不强塞左右两栏：点 `ArtifactCard` 照旧跳去 `/artifacts/<id>`，顶上留一条返回当前对话的横幅。
- **`afterBlock` 指向的块刚被主人删掉或挪走。** 墓碑块在库里仍保留 `orderKey`（[块编辑器协同](.agents/notes/proposed/feature/2026-10-20-block-editor-collab.md)），紧挨着墓碑插入位置依然有效；`afterBlock` 根本不存在时拒绝并告诉模型用 `artifact_content_get` 重读。
- **多个建议叠在同一块上。** 保留各自身份；接受其中一条后，其他建议按版本冲突交代。展示可折叠，持久化不静默覆盖。
