# 第九篇：跨载体设计系统横向差异审计

本篇基于当前代码基线的实证核查，记录五个 UI 渲染载体、两套组件库及各业务页面之间客观存在的令牌偏移、双源实现与静态检查缺口。

## 9.1 五载体核心令牌对照与偏移事实

### 主题底面、语义色与圆角分歧表

| 维度 | 工作台 (`apps/mac/ui/vv/theme.json` + `nsh.json`) | 宿主组件 (`apps/mac/ui/tokens.ts`) | 原生壳 (`apps/mac/src/theme.rs`) | 官网 (`apps/site/src/ui/global.css`) | 灵动岛 (`Island.swift` + `Geometry.swift`) |
| --- | --- | --- | --- | --- | --- |
| **深色主表面底** | `page`: `#151413`、`side`: `#1b1a18`、`rail`: `#121110` | `surface`: `#21201d`、`canvas`: `#1b1a18`、`subtle`: `#312f2b` | `bg`: `#151413`、`surface`: `#1b1a18`、`elevated`: `#21201d` | 固定暖木/深夜绿背景序列 | 深暖半透明底 |
| **浅色主表面底** | `page`: `#fcfcfb`、`side`: `#f6f5f3`、`rail`: `#efeeeb` | `surface`: `#fcfcfb`、`canvas`: `#f6f5f3`、`subtle`: `#e7e5e0` | `bg`: `#fcfcfb`、`surface`: `#f6f5f3`、`elevated`: `#fcfcfb` | `cream-*` 暖米白系 | 固定深暖色（不跟浅色主题变白） |
| **边框颜色** | `line`: 浅 `#1c191714` / 深 `#ecebe81a` | `border`: 浅 `#e6e4e0` / 深 `rgba(236,235,232,0.11)` | `border`: 浅 `#e6e4e0` / 深 `#2d2b27` | `bark-*` 显式像素边界 | 无统一边框令牌 |
| **主绿 / 告警色** | `accent`: 浅 `#4d7a2a` / 深 `#7fae4f`；`wheat`: 双主题 `#e5a93c`；`berry`: 浅 `#a83a2c` / 深 `#e47d6d` | `ok`: 浅 `#3f7329` / 深 `#7fae4f`；`alert`: 浅 `#b45d0e` / 深 `#e5a93c`；`danger`: 浅 `#a83a2c` / 深 `#e47d6d` | `accent`: 浅 `#4d7a2a` / 深 `#7fae4f`；`warning`: 浅 `#b45d0e` / 深 `#e5a93c`；`danger`: 浅 `#a83a2c` / 深 `#e47d6d` | `leaf-500`: `#74a046` / `wheat`: `#e5a93c` / `berry`: `#c84a3a` | `working`: `#97C467` / `waiting`: `#E5A93C` / `stuck`: `#E3685B` |
| **圆角梯级** | `xs:3`、`sm:4`、`md:6`、`lg:8`、`xl:12`、`full:9999` | `sm:7`、`md:10`、`lg:16`、`button:9`、`card:12`、`tray:22` | 控件内硬编码像素圆角 | `--radius-*: initial`（默认 `0px`，极少显式 `rounded-[3px]`） | `closed:10`、`open:16` |

已观测到的具体偏移：

- **深色表面命名交叉**：在 `apps/mac/src/theme.rs` 中 `#151413` 是 `bg`、`#1b1a18` 是 `surface`、`#21201d` 是 `elevated`；但在 `apps/mac/ui/tokens.ts` 中将 `#21201d` 命名为 `surface`、将 `#1b1a18` 命名为 `canvas`（`tokens.ts` 的 `onPrimary` 在深色下用 `#151413`，无 `#151413` 对应面字段）；而工作台 `theme.json` 将 `#151413` 命名为 `page`、`#1b1a18` 命名为 `side`、`#121110` 命名为 `rail`。同一套深褐黑灰阶在三个文件中拥有错位的语义命名。
- **阴影脱离深浅主题**：`apps/mac/ui/vv/theme.json` 在 `cssVars.light` 与 `cssVars.dark` 下分别定义了 `float`（浅 `#1c191724` / 深 `#00000066`）与 `raise`（浅 `#1c191714` / 深 `#00000059`），但 `apps/mac/ui/nsh.json` 的 `tailwind.shadow` 直接硬编码浅色石色值（`"float": "0 8px 24px #1c191724"`、`"raise": "0 1px 2px #1c191714"`），导致 `shadow-float` 与 `shadow-raise` 在深色模式下未引用 `theme.json` 对应深色阴影。
- **缓动曲线跨载体错位**：`nsh.json` 定义 `ease-out` 为 `cubic-bezier(0.2, 0.0, 0.0, 1.0)`、`ease-in-out` 为 `cubic-bezier(0.4, 0.0, 0.2, 1.0)`；`apps/site/src/ui/global.css` 将 `--ease-out` 定义为 `cubic-bezier(0.4, 0, 0.2, 1)`（数值等同 `nsh.json` 的 `ease-in-out`）；而 `apps/mac/ui/motion.ts` 独立使用 `ease = "cubic-bezier(0.22, 1, 0.36, 1)"`（且内部 `pressTransition()` 却写成 `"ease"`），三个主要 TS 端使用三条互不相同的标准减速度曲线。
- **亮浅警示色与绿标不同源**：工作台 `theme.json` 在浅色下 `wheat` 为 `#e5a93c`、`leaf` 为 `#74a046`、`accent` 为 `#4d7a2a`；而 `tokens.ts` 与 `theme.rs` 的浅色 `warning`/`alert` 直接压暗至 `#b45d0e`，`ok`/`success` 使用 `#3f7329`。

## 9.2 双源并存的组件库

目前仓库内同一功能在两个 TSX 目录中各自维护两套互不复用的视觉组件与样式方案：

| 业务功能 | 工作台标准实现（Tailwind 令牌流） | 宿主扩展实现（`tokens.ts` 内联样式流） | 实质差异 |
| --- | --- | --- | --- |
| **状态胶囊徽标** | `apps/mac/ui/vv/web/ui/Tag.tsx`（`Tag` + `Dot`） | `apps/mac/ui/components/StatusBadge.tsx` | 各自维护配色映射与内边距圆角规则 |
| **思考加载指示** | `ThinkingDots`（`apps/mac/ui/vv/web/features/channel/views/presence.tsx`） | `apps/mac/ui/components/ThinkingLoader.tsx` | 后者额外依赖 `motion.ts` 的 `formatElapsed` 与固定计秒跳变 |
| **工具步骤展示** | `WorkLog.tsx`（`apps/mac/ui/vv/web/features/session/WorkLog.tsx`） | `apps/mac/ui/components/ToolCallCard.tsx` & `ToolCallGroup.tsx` | `ToolCallCard` 自建 Canvas 图标、JSON 着色器、`CAP = 220` 渐隐折叠与 `Retry` 按钮；`WorkLog` 基于工作台令牌平铺折叠 |
| **图片灯箱网格** | `AttachmentTile.tsx` + `Lightbox.tsx` | `apps/mac/ui/components/Gallery.tsx` | 各管一套缩放预览与键盘关闭流 |

## 9.3 令牌层次与命名空间现状

1. **`cssVars.theme` 扁平混合命名**：`apps/mac/ui/vv/theme.json` 将全量 `cssVars.theme`（约百余项）并列挂在同一平级命名空间下，混装基础色阶（`cream-50..300`、`bark-400..950`）、特定子组件局部色（`lcd-*`、`phone-*`、`catalog-*`、`agent-stage-*`）与临时状态透明值（`px-toast-warn`、`patch-add-bg`），未拆分出独立的「基础原色 → 语义别名 → 组件专用」层级。
2. **缺失密度与失焦状态令牌**：五套令牌文件均未定义正式的界面紧凑度（`density`）令牌及独立的窗口失焦态（`unfocused`）表面/文字令牌，失焦面板与标准面板呈现完全相同的对比强度与留白节奏。

## 9.4 手绘图形与手搓控件偏移清单

在具体功能页和宿主视图中存在多处绕过共用原语的自绘图形或局部重造控件：

1. **图标多路手绘重造**：
   - 工作台标准化图标全部收拢于 `apps/mac/ui/vv/web/ui/icons.ts`（经 `<Icon name>` 统一渲染）；
   - 宿主侧 `apps/mac/ui/surfaces/Sidebar.tsx` 自建 `GLYPHS` 矢量对象并通过 `Canvas` 手绘；
   - `apps/mac/ui/surfaces/Palette.tsx` 另写 `ModeIcon` 手绘搜索模式图标；
   - `apps/mac/ui/surfaces/shared.tsx` 维护第三套 `drawSurfaceIcon`（13 个 Canvas 路径图标 + `GLYPH_TO_ICON` 字符映射表）；
   - `apps/mac/ui/components/ToolCallCard.tsx` 内部再手写第四套 `drawToolIcon`、`ErrorMark` 与 `CopyIcon`（其中「复制成功」才混用一次 `SurfaceIcon name="check"`）。
2. **`SkillPicker` 手搓复选框**：
   - `apps/mac/ui/vv/web/features/agent/AgentConfig.tsx` 中的 `SkillPicker` 未复用共用原语 `apps/mac/ui/vv/web/ui/Checkbox.tsx`，而是就地用 `<View role="checkbox">` 拼装 `size-4 rounded-xs border` 勾选框，并用 `mix("ink", 0.25)` / `mix("ink", 0.4)` 手工设定边框。
3. **`WorkerRow` 裸写开关与行内对齐漂移**：
   - `apps/mac/ui/vv/web/features/agent/AgentsPage.tsx` 中的 `WorkerRow` 直接使用基础原语 `<Switch>` 并行内硬写一整串 `trackClass` 与 `thumbClass`，未沿用 `apps/mac/ui/vv/web/ui/layout.tsx` 封装的标准 `Toggle` 组件（并且仅在 `WorkerRow` 头像框硬写了 `${hexColor(props.agent.look.hat)}29` 的 8 位 hex 透明度拼接而非 `mix()`）。
   - 同页中 `WorkerRow` 的错误条带（`max-w-60`）与可变宽 tag 组直接挤压右侧开关与状态区，而上方 `OrchestratorRow` 右侧仅挂载单段摘要文字，两类行组件缺乏统一的最宽列表约束和右列固定对齐骨架。

## 9.5 布局宽度、状态指示与静态检查缺口

- **阅读宽度限制不一致**：`SettingsPage`（`apps/mac/ui/vv/web/ui/domain/settings.tsx`）明确设置 `w-full max-w-3xl` 收束长行；而 `RunsPage.tsx` 详情阅读区与 `AgentsPage.tsx` 列表行未设置统一的页面级 `max-w-*` 约束，在超宽桌面窗体内文字行与横条会无限横向拉伸。
- **瀑布轨迹线性比例失真**：`apps/mac/ui/vv/web/features/session/Trajectory.tsx` 内的 `WaterfallView` 对每个轮次采用纯线性比例 `widths = (room * t) / total` 分配像素宽度（仅设置单步最小 `width: Math.max(2, ...)`）。当同一工单内先出现短轮次、后出现数十倍耗时的超长轮次时，早先短轮次的全部步骤会被压缩成紧密堆叠的 `2px` 细缝，失去可读性与精确点选空间。
- **顶部运行状态胶囊指示口径**：`apps/mac/ui/vv/web/app/Shell.tsx` 中的 `desk-status` 胶囊以 `core()?.call === "live"` 判断亮起绿点与激活文案（`working()` 仅作数字插值参数），即当服务处于 `live` 态而当前无干活帮工（`0` 个）时绿点仍保持常亮。
- **样式静态检查跨端覆盖不均**：官网 `apps/site` 在 `vp check` 中启用 `vibevalley/style-attrs` 规则，严格拦截 `className`、`classList` 与静态死值 `style`；而核心工作台所在的 `apps/mac/ui` 目前仅通过 `vp run mac:check` 执行 `nsh` 类型检查与打包验证，静态 lint 尚未覆盖 `apps/mac/ui` 内的写死 hex 字符串（如 `${hex}...29`）、未命名样式或非法属性写法。
