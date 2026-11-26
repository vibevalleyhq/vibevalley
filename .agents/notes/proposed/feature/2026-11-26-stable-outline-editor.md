# Agent Note: 稳定大纲编辑器：统一几何网格、零抖动编辑与键盘流

Status: proposed

## Problem

当前大纲作品编辑器（`apps/mac/ui/features/artifact/views/OutlineView.tsx`）在点击编辑、悬停和同层混排三种日常场景下存在四类结构性抖动与交互缺口：

| 现象 | 源码位置 | 机制与量化后果 |
|---|---|---|
| 点击编辑整页跳动 `4px` | `OutlineView.tsx:211-259`、`IconButton.tsx:33` | 非编辑行在普通 flex 流内常驻右侧 `<IconButton>`（`size-7` = `28px`），即便 `opacity-0` 仍撑高整行到 `28px` 内容高（总高 `36px`）；进入编辑态后 `<If when={!readOnly() && !isEditing()}>` 卸载该托盘，行高跌回 `<Input class="h-6">`（`24px`，总高 `32px`），下方全部节点垂直跳动 `4px` |
| 阅读态与编辑态盒模型不匹配、多行塌缩 | `OutlineView.tsx:172-207` | 阅读态 `<View class="min-h-5 justify-center rounded-xs px-1">` 无边框、左右 `4px` 内边距、`<Text>` 自动折行；编辑态 `<Input class="h-6 ... border border-focus px-1.5">` 固定单行 `24px`、无 `multiline`、带 `1px` 边框与 `6px` 内边距。点击折行长段落会瞬间塌缩成单行，单行文本也会向右偏移 `3px` |
| 同层前缀槽宽不统一、底栏不对齐 | `OutlineView.tsx:131-166, 268-287` | 同一 `depth` 下（折叠槽 `16px` + `gap-1.5` `6px`），`heading` 无标记槽（文本左偏移 `22px`）、`bullet` 用裸 `size-1.5` 圆点（左偏移 `34px`）、`todo` 用 `size-4` 复选框（左偏移 `44px`），同层文本左边缘相差 `10–22px`；底部快捷新增栏使用 `px-2.5 py-1.5` + `gap-2`，与行内 `paddingLeft: 6 + depth * 18` 不在同一基准线上 |
| 缺少大纲键盘流 | `OutlineView.tsx:197-203` | 编辑态仅绑定 `Enter`（新建兄弟）与 `Escape`（退出），缺少 `Tab` / `Shift+Tab` 缩进反缩进、空行 `Backspace` 删除并回焦、`ArrowUp` / `ArrowDown` 跨行移动焦点与同层上下调序，每次调级都必须退回悬停点按钮 |

## Proposal

按「统一几何网格 + 同构盒模型 + 脱流动作条 + 纯状态机键盘流」四部分重构大纲编辑器，不改持久化结构 `OutlineDocument`（`apps/mac/ui/features/artifact/html.ts`）。

### 1. 统一几何网格与固定前缀槽

所有行缩进与槽宽收敛为单源常量（定义在 `outlineEditor.ts`，供视图与测试共用）：

- 基准左内边距 `OUTLINE_BASE_PADDING_PX = 8`、槽宽 `OUTLINE_SLOT_PX = 20`（`w-5`）、槽间距 `OUTLINE_SLOT_GAP_PX = 4`（`gap-1`）、每层缩进步长 `OUTLINE_INDENT_STEP_PX = 24`（`20 + 4`，使子行折叠槽精确对齐父行标记槽、子行标记槽对齐父行正文左边缘）。
- 行容器使用 `relative group flex-row items-start gap-1 rounded-md py-1 pr-2 hover:bg-hover`，左边距 `paddingLeft = OUTLINE_BASE_PADDING_PX + depth * OUTLINE_INDENT_STEP_PX`。
- 折叠槽固定 `h-6 w-5 shrink-0 items-center justify-center`（`20px × 24px`），垂直居中于首行 `leading-6`（`24px`）；无子节点时渲染同尺寸空 `<View class="h-6 w-5 shrink-0" />`。
- `bullet` 与 `todo` 共用固定标记槽 `h-6 w-5 shrink-0 items-center justify-center`（`20px × 24px`）：`bullet` 圆点（`size-1.5`）与 `todo` 复选框（`size-4`）均在 `20px × 24px` 槽内居中，保证同一层级下 `bullet` 与 `todo` 正文左边缘横坐标差为 `0px`。
- `heading` 不渲染标记槽，文本紧跟折叠槽；使用 `text-base font-semibold leading-6`，非首行附加 `mt-2` 段落顶距以区分章节节奏。
- 底部快捷新增栏对齐首层基准网格：左侧内边距与前缀种类切换槽的总宽匹配 `depth = 0` 的折叠槽与标记槽，使快捷输入文本左边缘与顶层 `bullet` / `todo` 正文对齐。

### 2. 阅读态与编辑态像素同构盒模型

阅读态 `<View>` 与编辑态 `<Input>` 应共享完全一致的盒模型与排版类名，确保切换瞬间宽高与文本起止坐标零位移：

| 属性 | 阅读态（`<View>` + `<Text>`） | 编辑态（`<Input multiline />`） |
|---|---|---|
| 宽度与收缩 | `min-w-0 flex-1` 内 `w-full` | `min-w-0 flex-1` 内 `w-full` |
| 边框 | `rounded-sm border border-transparent` | `rounded-sm border border-focus bg-page` |
| 内边距 | `px-1.5`（上下 `0`，靠 `leading-6` 撑起 `24px` 行高） | `px-1.5`（与阅读态相同） |
| 字体与行高 | `heading`：`text-base font-semibold leading-6`；`bullet` / `todo`：`text-sm leading-6` | 与阅读态同款字号、字重与 `leading-6` |
| 多行折行 | `<Text>` 自动折行 | `<Input multiline submitBehavior="submit" />`，不设固定 `h-6`，随内容行数自然增高 |

边框始终占位 `1px`，符合 `scripts/audit/ui-tokens.ts` 的 `selection-layout-shift` 约束；所有颜色与阴影使用 `apps/mac/ui/design/theme.json` 与 `apps/mac/ui/nsh.json` 的语义令牌。

### 3. 不影响行高的悬浮动作条

- 移除普通 flex 流中的 `size-7` `<IconButton>` 托盘。
- 行动作条改为绝对定位浮层：`absolute right-1.5 top-1 z-10 flex-row items-center gap-0.5 rounded-sm border border-line bg-elevated px-0.5 py-0.5 shadow-raise`，内部按钮统一为 `size-5`（`20px`）配 `Icon size={12}`。
- 动作条仅在非只读且非编辑态、行悬停或焦点落入时显现（`opacity-0 group-hover:opacity-100 focus-within:opacity-100`）；由于脱离文档流，悬停、聚焦、进入与退出编辑态均不改变行高与正文列宽。

### 4. 纯状态机与大纲键盘流

将大纲的焦点移动与键盘结构变更抽离为纯模块 `apps/mac/ui/features/artifact/views/outlineEditor.ts`（复用 `previewModel.ts` 的节点变更函数，`OutlineView.tsx` 只负责派发和绑定焦点）：

| 快捷键 | 触发条件 | 行为与焦点去向 |
|---|---|---|
| `Enter` | 编辑态 | 提交当前文本，在同层后方插入新节点并聚焦新节点（`todo` 延续 `todo`，`heading` 与 `bullet` 后建 `bullet`）；`Shift+Enter` 在 `multiline` 内换行 |
| `Escape` | 编辑态 | 放弃本次未提交输入，清空 `editingId` 退出编辑态（`onBlur` 见 `editingId` 不匹配则跳过保存） |
| `Tab` | 编辑态 | 先合并当前草稿文本，再缩进为前一兄弟的末尾子节点，保持编辑焦点；若新父节点处于折叠态，自动产出展开后的 `collapsed` 集合与 `expandedParentId`，防止当前节点消失 |
| `Shift+Tab` | 编辑态 | 先合并当前草稿文本，再反缩进至父节点之后，保持编辑焦点 |
| `Backspace` | 编辑态且当前编辑文本为空 | 若节点无子节点（叶子），删除节点并将焦点移至前一个可见行（首行则移至后一个可见行）；若含子节点，拒绝删除，避免静默销毁整棵子树 |
| `ArrowUp` / `ArrowDown` | 编辑态 | 提交当前文本，按当前可见扁平行（尊重折叠与 `hideDone` 过滤）将编辑焦点移至上一行 / 下一行 |
| `Alt+ArrowUp` / `Alt+ArrowDown` | 编辑态 | 同层兄弟上下交换位置，保持编辑焦点 |

## 共享约定

`apps/mac/ui/features/artifact/views/outlineEditor.ts` 对 `OutlineView.tsx` 与单测导出固定契约：

- 几何常量与辅助：`OUTLINE_BASE_PADDING_PX`（`8`）、`OUTLINE_SLOT_PX`（`20`）、`OUTLINE_SLOT_GAP_PX`（`4`）、`OUTLINE_INDENT_STEP_PX`（`24`）、`OUTLINE_LINE_HEIGHT_PX`（`24`）、`outlineRowPaddingLeft(depth: number): number`、`outlineRowGeometry(depth: number)`。
- 纯状态函数：
  - `visibleOutlineRows(doc, options?: { collapsed?: ReadonlySet<string>; hideDone?: boolean }): FlatOutlineRow[]`
  - `adjacentOutlineRowId(rows, currentId, direction: "up" | "down"): string | undefined`
  - `insertOutlineSibling(doc, afterId, newId, text?: string): { readonly doc: OutlineDocument; readonly focusId: string }`
  - `deleteEmptyOutlineNode(doc, visibleRows, nodeId, currentText?: string): { readonly doc: OutlineDocument; readonly deleted: boolean; readonly focusId: string | undefined }`
  - `canIndentOutlineNode(doc, nodeId): boolean` / `canOutdentOutlineNode(doc, nodeId): boolean`
  - `indentOutlineWithFocus(doc, nodeId, collapsed?): { readonly doc: OutlineDocument; readonly changed: boolean; readonly focusId: string; readonly collapsed: ReadonlySet<string>; readonly expandedParentId: string | undefined }`
  - `outdentOutlineWithFocus(doc, nodeId, collapsed?): OutlineIndentResult`
  - `moveOutlineNodeVertical(doc, nodeId, direction: "up" | "down"): { readonly doc: OutlineDocument; readonly changed: boolean; readonly focusId: string }`
- `OutlineView.tsx` 保留既有 `testID`（`artifact-outline-view`、`outline-node-<id>`、`outline-collapse-<id>`、`outline-todo-<id>`、`outline-text-<id>`、`outline-node-input-<id>`、`outline-kind-<id>`、`outline-outdent-<id>`、`outline-indent-<id>`、`outline-child-<id>`、`outline-delete-<id>`、`outline-quick-kind`、`outline-quick-add`），供 `OutlineView.test.tsx` 与验收脚本稳定定位。

## Alternatives considered

**每行常驻 `<Input>` 替代点击切换编辑态**：不区分阅读态与编辑态，每行始终挂载原生 `<Input>`，天然消除切换抖动。未选：大纲作品常含上百节点，全量挂载原生文本编辑控件会随节点数线性增加 GPUI / `nsh` 焦点树与排版开销，且完成态 `todo` 的删除线（`line-through`）、点击行内链接与只读版本快照均需要纯 `<Text>` 呈现。同构盒模型 + 单活跃 `<Input>` 兼顾零抖动与低开销。

**改用 WebView `contentEditable` 或富文本编辑器内核**：借浏览器排版获得成熟的块级光标与跨行选区。未选：与 VibeValley 全原生 `nsh` 工作台路线背离，引入 WebView 进程内存、主题双端同步与 `nsh/test` 无法覆盖的测试盲区；当前 `OutlineDocument` 本身是纯文本树，原生 `<Input multiline />` 已足够支撑全部大纲交互。

**保留单行 `<Input>` 并把所有行强行锁死在 `28px` 固定高度**：给阅读态设 `h-7` + `truncate`、编辑态设 `h-7`，省去多行对齐成本。未选：大纲节点常写完整句段或待办说明，单行截断会隐藏正文，破坏大纲作为写作与拆解工具的基本可用性。

## Acceptance criteria

- 零垂直抖动：进入编辑态、退出编辑态、鼠标悬停行与离开行时，该行与下方全部节点的纵向位置变化均为 `0px`；动作条浮层不参与行高计算。
- 零水平漂移：同一深度下 `bullet` 与 `todo` 的正文左边缘横坐标完全一致；单行节点在阅读态与编辑态间切换时文本横坐标变化为 `0px`；底部快捷新增栏输入起止与 `depth = 0` 网格对齐。
- 多行稳定性：包含折行长句的节点点击进入编辑态时，`<Input multiline />` 保持多行展开，不塌缩为单行 `24px`。
- 键盘流完整：`outlineEditor.test.ts` 覆盖 `adjacentOutlineRowId`（含折叠与 `hideDone`）、`insertOutlineSibling`、`deleteEmptyOutlineNode`（叶子删除回焦、首行删后聚焦下移、非叶子拒删）、`indentOutlineWithFocus`（含缩进至折叠兄弟自动展开 `collapsed` 并返回 `expandedParentId`）、`outdentOutlineWithFocus` 与 `moveOutlineNodeVertical`；`OutlineView.test.tsx` 通过 `nsh/test` 覆盖点击编辑、盒模型类不变量与键盘流交互。
- 静态门禁与实机验收：`vp run mac:check`、`vpx scripts/audit/ui-tokens.ts` 零报错；照 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 在真实原生应用中打开大纲作品，对比阅读态、多行编辑态、悬停态在浅色与深色主题下的截图无跳动、无错位。

## Risks

- **`nsh` `<Input multiline />` 与 `<Text>` 的原生行高细微偏差**：GPUI 文本输入框与静态 `<Text>` 在基线或内嵌边距上可能存在 `1–2px` 原生绘制差异。缓解：实施时在真实原生应用里逐像素截图对照单行与多行切换，若原生控件自带内嵌边距，则在 `OutlineView.tsx` 中显式固定单侧补偿并写入实测注释，回退路径是锁定统一 `min-h-6` 与等高行距。
- **多行输入框中 `ArrowUp` / `ArrowDown` 与光标行内移动冲突**：当一个节点折成多行时，直接截获 `ArrowUp` / `ArrowDown` 跨行会阻断节点内上下行移动。缓解：优先结合 `nsh` `Input` 的 `onSelectionChange`（仅在光标位于首行/末行或单行节点时触发跨行跳转）；若当前 `nsh` 版本不暴露视觉折行边界，则在首版约定纯文本首/尾位置或单行节点触发跨行，并在 `OutlineView.test.tsx` 固化该行为。
- **绝对定位动作条遮挡右侧长句末尾**：长句悬停时，右侧浮层会盖住行末约 `120px` 区域的文字。缓解：动作条仅在非编辑态悬停时显示，进入编辑态立即隐藏，且背景使用带边框的 `bg-elevated` 与 `shadow-raise` 保持清晰层次，不阻断编辑。
- **与协同引擎的并发保存**：`Tab`、`Enter`、`Backspace` 连续高频按键会连续触发 `onSaveDoc`。缓解：纯函数每次返回完整 `OutlineDocument`，`OutlineView.tsx` 在执行结构变更前先合并当前 `editingText()` 草稿，避免快速敲击后失焦覆盖最新结构。
