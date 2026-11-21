# 第二篇：基础原子组件与交互控件

工作台全部基础 UI 原语位于 `apps/mac/ui/vv/web/ui/`，遵循 `nsh` 样式规范（`Text` 单独声明字色字号、禁用 `className` 而是传 `class`、接收调用方 `class?: string` 只补外观未声明的间距与对齐）。宿主外壳另有独立的跨页面对话与工具组件位于 `apps/mac/ui/components/`。

## 2.1 按钮控件梯级

### `Button`（`apps/mac/ui/vv/web/ui/Button.tsx`）

| 维度 | 取值选项 | 视觉与交互定义 |
| --- | --- | --- |
| `tone` | `primary` | `border-accent bg-accent`（悬停 `hover:border-accent-hover hover:bg-accent-hover`），配 `text-page` 字色；一屏最多一个 |
| `tone` | `plain`（默认） | `border-line bg-page`（悬停 `hover:border-faint hover:bg-hover`），通用动作主力 |
| `tone` | `quiet` | `border-transparent bg-transparent`（悬停 `hover:bg-hover`），工具条与低权重动作 |
| `tone` | `danger` | `bg-page` + `text-berry` + `mix("berry", 0.35)` 边框；悬停时边框转为 `tone("berry")`、底色转为 `tone("bad-soft")` |
| `size` | `compact` / `control` | `compact` 为 `24px` (`h-6 px-2 text-xs` 配 `12px` 图标)；`control`（默认）为 `28px` (`h-7 px-2.5 text-sm` 配 `14px` 图标) |
| 状态 | `disabled` | `disabled?: boolean`；开启后呈 `opacity-50`，跳过悬停态与 `active:translate-y-px` 按压微沉 |

### `IconButton`、`OutLink`、`IconLink`（`apps/mac/ui/vv/web/ui/IconButton.tsx`）

- `IconButton`：纯图标按钮，容器外框固定为 `size-7`（`28×28px`、`rounded-md`），`size?: IconSize` 仅控制内部 `<Icon>` 的尺寸（默认 `16`）；强制要求 `label` 提供无障碍名与气泡提示 `Bubble`，支持 `tone?: "danger"` 与 `pressed` 状态。
- `OutLink` / `IconLink`：跳往外部文档/浏览器（`external.ts`）或路由内嵌的轻量图文链接。

### `ConfirmButton`（`apps/mac/ui/vv/web/ui/ConfirmButton.tsx`）

针对不可逆销毁操作（删除档案、放弃修改等）的**就地二次确认控件**，无需再套全屏确认弹窗：

1. 初始显示常规触发按钮（或图标按钮）；
2. 首次按下原地展开「确认文案 + 执行按钮 + 取消退路」，避免用户误触；
3. 支持 `busy` 锁定与异步完成自动复位。

## 2.2 分段选择、标签页与表单控件

### `Segmented`（`apps/mac/ui/vv/web/ui/Segmented.tsx`）

用于在互斥枚举间切换（如角色过滤、视图模式、时间维度）。外层轨道容器采用 `rounded-md bg-hover p-0.5`（无外边框），各选项直接渲染在轨道内；激活项通过**自身的 `border-line bg-page shadow-raise` 与 `transition duration-120 ease-out`** 高亮，而非依赖独立的滑块元素。

### `Tabs`（`apps/mac/ui/vv/web/ui/Tabs.tsx`）

用于详情页或区块页的平级切换（带底边指示线与可选 `Count` 数字计数徽标），支持键盘左右键迁移焦点或由调用方控制 `value` 与 `onChange`。

### 表单输入与选择套件

| 组件 | 源文件 | 核心行为 |
| --- | --- | --- |
| `TextInput` / `TextArea` | `apps/mac/ui/vv/web/ui/Field.tsx` | 统一样式：`bg-page border-line focus:border-focus`；`TextInput` 为 `28px` 或 `32px` 高度，支持前后缀修饰；`TextArea` 支持受控多行与 `Enter` 提交钩子 |
| `Select` | `apps/mac/ui/vv/web/ui/Field.tsx` | 带触发按钮的下拉选择框，弹出菜单贴边锚定并走 `z-20` `shadow-float` |
| `Field` / `Form` | `apps/mac/ui/vv/web/ui/Field.tsx`、`apps/mac/ui/vv/web/ui/Form.tsx` | 自动绑定 label、`hint`、`error` 校验红字与无障碍 `accessibilityLabel` |
| `Checkbox` | `apps/mac/ui/vv/web/ui/Checkbox.tsx` | 带 `16×16` 圆角勾选框 (`rounded-xs`)、整行点击与标签对齐，键盘 `Space` 切换 |
| `Toggle` | `apps/mac/ui/vv/web/ui/layout.tsx` | 胶囊轨道开关（`h-4 w-7` 对应 `16×28`，`duration-180 ease-out` 圆点位移） |
| `SecretInput` | `apps/mac/ui/vv/web/ui/layout.tsx` | 密钥输入框，支持明暗文一键显隐切换并防日志/剪贴板误泄 |
| `Slider` | `apps/mac/ui/vv/web/ui/Slider.tsx` | 连续值拖拽滑块（带轨道进度填充与数值回显） |
| `ChipsInput` / `KeyValueEditor` | `apps/mac/ui/vv/web/ui/Chips.tsx` | 标签多值输入条（支持回车成片、Backspace 退删）与环境变量/键值成对编辑表格 |
| `KeyMark` / `KeyField` / `SaveBar` | `apps/mac/ui/vv/web/ui/KeyField.tsx` | 快捷键组合录入键位栏与「有未保存变更」时底部/顶部浮现的保存撤回条 |

## 2.3 状态指示、通知与空状态套件

| 组件 | 源文件 | 职责与外观 |
| --- | --- | --- |
| `Tag` | `apps/mac/ui/vv/web/ui/Tag.tsx` | `TagTone` 三态语义胶囊标签：`ok`（`bg-ok-soft` + `text-ok-ink`）、`bad`（`bg-bad-soft` + `text-berry`）与 `wait`（`mix("wheat", 0.22)` 底色 + `text-warn-ink`），字体固定为 `text-xs` |
| `Dot` | `apps/mac/ui/vv/web/ui/Tag.tsx` | 实体状态圆点（可自定义直径并用于工作状态点、未读灯、连接态脉冲点） |
| `Count` | `apps/mac/ui/vv/web/features/channel/views/presence.tsx` | 纯数字小徽标，用于标签页与列表计数汇总 |
| `PhaseGlyph` / `ThinkingDots` | `apps/mac/ui/vv/web/features/channel/views/presence.tsx` | 帮工正在思考/运行时的动画点阵与阶段状态小图标 |
| `ToastHost` | `apps/mac/ui/vv/web/ui/ToastHost.tsx` | 全局悬浮反馈堆栈（`z-40`），承载由 `apps/mac/ui/vv/web/ui/toasts.ts` 发出的短时提示与带故障 `UiFault` 详情的报错横幅 |
| `Empty` / `Quiet` | `apps/mac/ui/vv/web/ui/layout.tsx` | `Empty` 用于整页或空数据列表：`48px` 大图标 + 空原因 + 下一步可点击动作；`Quiet` 为轻量无框占位文案 |
| `Card` / `ListCard` / `ListRow` / `Split` | `apps/mac/ui/vv/web/ui/layout.tsx` | 标准化列表容器与单行骨架：带底线分隔 `ListRow`、悬停亮底、统一左右缩进 |
| `Bubble` / `Tip` / `Hint` | `apps/mac/ui/vv/web/ui/Tip.tsx` | `Bubble` 供 `tooltip` 挂载微气泡；`Hint` 为问号图标悬浮解释 |

## 2.4 对话框、菜单、表格与分栏

- **`Dialog`（`apps/mac/ui/vv/web/ui/Dialog.tsx`）**：模态层覆盖 `bg-scrim`（`z-30`），居中容器 `rounded-lg border border-line bg-page shadow-float`，内置标题栏、ESC 监听与背景防穿透锁；常规宽上限 `480`（`min(480, windowWidth * 0.92)`），`wide` 变体宽上限 `1080`（`min(1080, windowWidth * 0.94)`）用于并行呈现差异审查的场景。
- **`MoreMenu`（`apps/mac/ui/vv/web/ui/MoreMenu.tsx`）**：点击「更多」按钮在 `z-20` 弹出的动作清单，支持分隔线、危险条目红字及图标前置。
- **`DataTable`（`apps/mac/ui/vv/web/ui/DataTable.tsx`）**：通用等高行数据表，固定列宽与 `min-w-0` 弹性列配比，支持列头排序、空态回落、行点击整行响应。
- **`Splitter` 与 `usePaneWidth`（`apps/mac/ui/vv/web/ui/Splitter.tsx`）**：`1px` 隐形加宽可拖拽热区线条；按 `side` 枚举（靠左/靠右面板）计算向外扩展像素差，并自动写入持久化偏好。
- **`ShortcutSheet`（`apps/mac/ui/vv/web/ui/ShortcutSheet.tsx`）**：按下 `?` 呼出的快捷键速查弹窗，按 `shortcutPlaces` 作用域分组呈现所有可用按键组合与键帽徽标。

## 2.5 领域原子与附件磁贴

位于 `apps/mac/ui/vv/web/ui/domain/` 与 `apps/mac/ui/vv/web/ui/pixel/`：

| 原语 | 文件 | 用途 |
| --- | --- | --- |
| `AttachmentTile` | `apps/mac/ui/vv/web/ui/domain/AttachmentTile.tsx` | 以固定磁贴形态展示附件：按类型映射图标、文件名、体积，以及图片/媒体内联缩略图或点击放大入口 |
| `AgentFace` / `OrchestratorFace` | `apps/mac/ui/vv/web/ui/domain/Face.tsx` | 按档案与农机特征渲染像素头像（无图片资源或加载中时退回首字母色块兜底）；读取 `apps/mac/ui/vv/web/ui/domain/cast.ts` 的 `castHash` / `castPrefix` 确定小动物物种与服饰前缀 |
| `PoseSprite` | `apps/mac/ui/vv/web/ui/domain/PoseSprite.tsx` | 从像素精灵图集中截取当前姿态帧渲染在工作台档案卡或状态条上 |
| `RuntimeBadge` / `RuntimeIcon` | `apps/mac/ui/vv/web/ui/domain/RuntimeBadge.tsx`、`apps/mac/ui/vv/web/ui/pixel/RuntimeIcon.tsx` | 将农机 ID（Claude Code / Codex / Cursor / OpenCode 等）映射为可辨识图标与标签 |
| `OpenTerminal` | `apps/mac/ui/vv/web/ui/domain/OpenTerminal.tsx` | 一键通知桌面宿主在指定仓库或 worktree 工作目录拉起嵌入式原生终端标签页 |
| `Qr` | `apps/mac/ui/vv/web/ui/Qr.tsx` | 本机/配对服务链接的二维码矢量绘制组件 |
| `SettingsPage` / `SettingsGroup` / `SettingRow` / `KeyRow` | `apps/mac/ui/vv/web/ui/domain/settings.tsx` | 设置二级页共用布局壳，串联 `SettingsSearch` 实现设置项关键词检索与 `mix("wheat", 0.15)` 高亮匹配行 |
| `usePixelDir` / `useSpriteUrl` / `useCursorUrl` | `apps/mac/ui/vv/web/ui/pixel/atlas.ts` | 通过 `host.pixelDir` 向原生壳索取本机图片目录路径并拼接 `file://` URL；缺图目录时静默退回占位 |

## 2.6 外壳组件库对照（`apps/mac/ui/components/`）

`apps/mac/ui/components/` 存放由原生外壳面（以及工作台外的辅助卡片）直接使用的五组独立 TSX 组件。它们不走 `theme.json`/`nsh.json` 的 Tailwind class，而是直接消费 `apps/mac/ui/tokens.ts`（`tok()`、`radius`、`cardShadow`、`dangerTint`）与 `apps/mac/ui/motion.ts`：

| 组件 | 源文件 | 功能范围 | 对应的工作台组件 |
| --- | --- | --- | --- |
| `StatusBadge` | `apps/mac/ui/components/StatusBadge.tsx` | 圆点 + 文本 + 浅底的轻量胶囊状态牌 | 工作台 `Tag` + `Dot` |
| `ThinkingLoader` | `apps/mac/ui/components/ThinkingLoader.tsx` | 思考步骤脉冲指示与实时耗时计秒 | 工作台 `ThinkingDots` / `PhaseGlyph` |
| `ToolCallCard` | `apps/mac/ui/components/ToolCallCard.tsx` | 单条工具调用折叠卡（摘要行、Canvas 小图标、JSON 语法上色展开框、超 `220px` 渐隐截断与「显示全部」、错误红框及 `Retry` 重试） | 工作台 `WorkLog` 步骤明细行 |
| `ToolCallGroup` | `apps/mac/ui/components/ToolCallGroup.tsx` | 连续多条同类/相近工具调用折叠成组卡，提供整体展开与计数 | 工作台 `WorkLog` 分组归并 |
| `Gallery` | `apps/mac/ui/components/Gallery.tsx` | 多图网格缩略条与全屏预览容器 | 工作台 `AttachmentTile` + `Lightbox` |
