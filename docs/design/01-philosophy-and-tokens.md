# 第一篇：设计哲学与设计令牌体系

工作台视觉风格定名为**田间工作台**：以干净、可读、可长时间注视的工程工具面为骨架，用有限的农庄色调锚定品牌归属；像素场景与品牌落页则使用独立的像素暖色盘与体素光影语言。

## 1.1 设计哲学与双皮视觉调性

工作台设计遵循十条判断准绳：

1. **字先于画**：标题、正文与状态说明先行保证排版层级，图标只作辅助。
2. **静面与动面分离**：侧边栏与背景退成纯色或极淡边框面，工作区和正在运转的节点才携带亮色或高对比度提示。
3. **一条主色与四枚语义色**：只用叶绿（`accent` / `leaf`）表达可点击与正常推进，麦黄（`wheat`）表达等待或提醒，浆果红（`berry` / `bad`）表达故障或不可逆破坏，溪蓝（`water`）表达正在处理；其余界面退回中性米白或深褐墨色。
4. **嵌套圆角逐级减一档**：外框圆角减去内边距大于或等于下一级内框圆角（如 `lg` 8px 框内套 `md` 6px 控件，最小到 `xs` 3px）。
5. **1px 实线与两档阴影**：卡片与分区默认靠 `1px` `border-line` 隔开，只在悬浮与抬起时使用 `shadow-raise` 或 `shadow-float`。
6. **容器不撑开**：列表行与网格项始终携带 `min-w-0` 和截断策略，防止长路径、URL 或中英混排撑破父容器。
7. **线条图标与像素图分工明确**：工作台功能操作使用 `apps/mac/ui/vv/web/ui/icons.ts` 的 `reicon` 线条图标（`<Icon>`），帮工头像、农机图标与场景元素使用 `design/pixel` 与 `design/voxel` 产出的像素图，不使用系统 emoji 字符替代业务图标。
8. **双语同框对齐**：同一界面与同一份状态内可同时出现中英文内容与标识符，标签长度按弹性排布而非硬编码固定宽度。
9. **键盘是一等操作**：页面导航、列表选中、命令面板、关闭弹窗和农具切换全部绑定明确键位并标在快捷键面板中。
10. **工作台像工具，农场像世界**：工作台追求低噪声和信息密度，农场和记忆树追求物理空间、昼夜氛围和动画连续性，两者的配色系统相互隔离。

## 1.2 表面体系与色彩阶梯

### 单源令牌生成与静态护栏（`design/tokens.json`）

`design/tokens.json` 为工作台、原生壳、宿主集成面与官网动效的唯一令牌定义源，包含 `primitives`、`semantic.{light,dark}`、`geometry` 与 `motion` 四段。`scripts/gen/tokens.ts` 从该文件生成并同步六处产物：

| 生成 / 同步目标 | 产出内容 | 校验方式 |
| --- | --- | --- |
| `apps/mac/ui/vv/theme.json` | 工作台 `cssVars.theme` 像素色与 `cssVars.{light,dark}` 语义变量 | `vpx scripts/gen/tokens.ts --check` |
| `apps/mac/ui/nsh.json` | 工作台 `tailwind.{fontSize,radius,ease,fontFamily,shadow}` 静态配置 | `vpx scripts/gen/tokens.ts --check` |
| `apps/mac/ui/tokens.ts` | 宿主集成面浅/深 `Palette`、`type`、`radius`、`cardShadow` 与 `dangerTint` | `vpx scripts/gen/tokens.ts --check` |
| `apps/mac/src/theme_tokens.rs` | 原生壳 `DARK_*`/`LIGHT_*`、终端 16 色与语法 16 色常量 | `vpx scripts/gen/tokens.ts --check` |
| `apps/mac/ui/motion.ts` | 同步 `ease` 减速度曲线（`cubic-bezier(0.2, 0, 0, 1)`） | `vpx scripts/gen/tokens.ts --check` |
| `apps/site/src/ui/global.css` | 同步 `--ease-out` 减速度曲线（`cubic-bezier(0.2, 0, 0, 1)`） | `vpx scripts/gen/tokens.ts --check` |

工作台页面代码由 `scripts/audit/ui-tokens.ts` 通过 AST 扫描校验（`apps/mac/ui/vv/web/{app,features,ui}`），拦截硬编码十六进制/`rgb()` 颜色、任意 Tailwind 值以及绕过 `Toggle`/`Checkbox` 原语的裸控件。

### 工作台双主题令牌（`apps/mac/ui/vv/theme.json`）

工作台的颜色在 `apps/mac/ui/vv/theme.json` 中分为三组：`cssVars.light`、`cssVars.dark`（随系统或设置切换）与 `cssVars.theme`（不随主题切换）。

| 语义分类 | 令牌名 | `light` 浅色 | `dark` 深色 | 用途 |
| --- | --- | --- | --- | --- |
| 三级表面 | `page` | `#fcfcfb` | `#151413` | 主工作区页面、可点击控件浅底 |
| 三级表面 | `side` | `#f6f5f3` | `#1b1a18` | 次级面板、设置卡片、表格与弹窗底 |
| 浮层表面 | `elevated` | `#fcfcfb` | `#21201d` | 抬起弹出卡片与浮层表面 |
| 三级表面 | `rail` / `on-rail` | `#efeeeb` / `#1c1917` | `#121110` / `#ecebe8` | 全局左侧导航 Rail 槽位底与前景色 |
| 交互态面 | `hover` | `#1c19170a` | `#ecebe80c` | 悬停底、轻量徽标底 |
| 交互态面 | `selected` | `#1c191711` | `#ecebe814` | 列表/卡片当前选中底 |
| 边框线条 | `line` / `line-strong` | `#1c191714` / `#1c191724` | `#ecebe81a` / `#ecebe829` | `1px` 主边框与强调分隔线 |
| 边框线条 | `focus` | `#74a046` | `#8dbb5c` | 键盘焦点环边框 |
| 三级字色 | `ink` | `#1c1917` | `#ecebe8` | 标题、正文与高权重值 |
| 三级字色 | `muted` | `#5e5852` | `#a9a49e` | 辅助说明、表头与副文本 |
| 三级字色 | `faint` | `#716a64` | `#8b867f` | 占位符、禁用标签与极淡标识 |
| 主色 | `accent` | `#4d7a2a` | `#7fae4f` | 主按钮底、激活项、正常状态核心绿 |
| 主色 | `accent-hover` | `#426a22` | `#8dbb5c` | 主按钮悬停底 |
| 四态语义 | `leaf` | `#74a046` | `#8dbb5c` | 正常、已就绪、运行正常绿 |
| 四态语义 | `wheat` | `#e5a93c` | `#e5a93c` | 警告、等待用户响应、待审与全局导航选中胶囊 |
| 四态语义 | `berry` | `#a83a2c` | `#e47d6d` | 错误、拒绝、不可逆危险操作 |
| 四态语义 | `water` | `#2c6aa3` | `#6aa6dc` | 正在执行、实时进行中、信息标记 |
| 语义辅助与软底 | `bark` | `#5e5852` | `#a9a49e` | 中性暖褐辅助标签色 |
| 语义深墨与软底 | `ok-ink` / `ok-soft` | `#3b6125` / `#e8f0de` | `#b0d488` / `#26331c` | 通过状态字色与柔和高亮底 |
| 语义深墨与软底 | `warn-ink` / `warn-soft` | `#94531f` / `#fbf0d9` | `#e0a062` / `#332917` | `wheat` 浅底或浅徽标上的高对比文字与软底色 |
| 语义深墨与软底 | `bad-soft` | `#f8e4e0` | `#3e231e` | 失败与危险提示柔和底 |
| 非活跃状态 | `idle` | `#aca59e` | `#6f6a64` | 离线、停止、未激活指示点 |
| 遮罩与代码 | `scrim` | `#1c191740` | `#00000080` | 弹窗与灯箱模态蒙层 |
| 遮罩与代码 | `code-bg` / `code-ink` | `#1c1917` / `#e7e5e2` | `#0e0d0c` / `#e7e5e2` | 行内代码与代码块背景及文字色 |
| 浮层阴影变量 | `float` / `raise` | `#1c191724` / `#1c191714` | `#00000066` / `#00000059` | 动态主题下的阴影基准色 |

### 像素固定色与状态插值（`cssVars.theme` 与 `tone.ts`）

`apps/mac/ui/vv/theme.json` 中的 `cssVars.theme` 定义跨主题固定色：

- **奶白与树皮阶梯**：`cream-50` (`#f7e8c4`)、`cream-100` (`#eedcb2`)、`cream-200` (`#e2c995`)、`cream-300` (`#c8a46e`)、`cream-hover` (`#f1dcab`)、`cream-input` (`#fff4d8`)、`bark-400`..`bark-950` (`#9b7550`..`#1e140b`，其中 `bark-600: #67482d`、`bark-900: #2f1f13`)。
- **像素绿与高亮色**：`leaf-300/500/600/700/hover`（`#b4cb7c` / `#74a046` / `#5a8234` / `#3f6427` / `#84b052`）、`wheat-hover` (`#efb84e`)、`wheat-700` (`#b8682a`)、`berry-500` (`#c84a3a`)、`water-500` (`#4f8fbd`)、`peach` (`#f3b07a`)、`ground` (`#2b3320`)、`rim` (`#fff4d8`)、`paper` (`#fffaf0`)、`hat` (`#f2b53a`)、`ok` (`#6cd38f`)、`bad` (`#ff6a58`)。
- **专项微场景色调**：农机 LCD 绿屏（`lcd-paper: #c9dc9a`, `lcd-ink: #22341a` 等 9 色）、手机壳（`phone-shade: #4a321e`, `phone-lit: #8a6440` 等）、阶段徽标（`agent-stage-center/middle/edge`）、图鉴、补丁（`patch-add-bg` / `patch-del-bg`）与差异填充（`diff-add-fill` / `diff-mod-fill` / `diff-del-fill`）卡片色。
- **动态半透明**：由于 `nsh` 不支持 CSS `color-mix()`，工作台一律调用 `apps/mac/ui/vv/web/ui/tone.ts` 的 `mix(name, weight)` 按给定 `[0, 1]` 透明度生成当前主题对应的 `rgba(...)`，`tone(name)` 直接读取当前主题颜色值。

### 原生外壳与官网等其余四端色系

- **原生 GPUI（`apps/mac/src/theme.rs` 与生成的 `apps/mac/src/theme_tokens.rs`）与宿主集成面（`apps/mac/ui/tokens.ts`）**：
  - `Palette::dark`：`bg: #151413`, `surface: #1b1a18`, `elevated: #21201d`, `border: #2d2b27`, `text: #ecebe8`, `muted: #a9a49e`, `faint: #8b867f`, `accent: #7fae4f`, `danger: #e47d6d`, `warning: #e5a93c`, `success: #7fae4f`, `info: #6aa6dc`, `added_bg: 0x7fae4f@0.14`, `removed_bg: 0xe47d6d@0.14`, `match_bg: 0xe5a93c@0.30`, `selected: 0x7fae4f@0.20`, `hover: 0xecebe8@0.07`。
  - `Palette::light`：`bg: #fcfcfb`, `surface: #f6f5f3`, `elevated: #fcfcfb`, `border: #e6e4e0`, `text: #1c1917`, `muted: #5e5852`, `faint: #716a64`, `accent: #4d7a2a`, `danger: #a83a2c`, `warning: #b45d0e`, `success: #3f7329`, `info: #2c6aa3`, `added_bg: 0x4d7a2a@0.13`, `removed_bg: 0xa83a2c@0.10`, `match_bg: 0xe5a93c@0.34`, `selected: 0x4d7a2a@0.14`, `hover: 0x1c1917@0.055`。
  - 终端与语法：`Palette` 内置 16 色 ANSI 调色板（`ansi[16]`）与 16 色代码语法色（`syntax[16]`）。
  - `tokens.ts` 由 `scripts/gen/tokens.ts` 生成并向 `surfaces/` 和 `components/` 暴露 `tok()`：包含浅/深两套 `surface` (`#fcfcfb`/`#21201d`)、`canvas` (`#f6f5f3`/`#1b1a18`)、`subtle` (`#e7e5e0`/`#312f2b`)、`tile` (`#efeeeb`/`#282623`)、`border` (`#e6e4e0`/`rgba(236,235,232,0.11)`)、`ok` (`#74a046`/`#8dbb5c`)、`alert` (`#94531f`/`#e5a93c`)、`danger` (`#a83a2c`/`#e47d6d`)、`primary` (`#4d7a2a`/`#7fae4f`)、`onPrimary` (`#fcfcfb`/`#151413`) 与代码着色色。
- **官网（`apps/site/src/ui/global.css`）**：通过 Tailwind v4 `@theme static` 清空 Tailwind 默认色板（`--color-*: initial`），显式定义 `cream-*`、`bark-*`、`leaf-*`、`wheat`、`berry`、`water`、`drop`、`shade`、`dusk`、`firefly`、`path*` 以及昼夜时段滤镜变量 `--sky`、`--ground`、`--smoke`、`--farmer`。
- **灵动岛（`apps/island/Sources/VibeValleyIsland/Island.swift`）**：手写同步 `design/tokens.json` 的固定暖棕调色常量，前景色采用 `cream` (`#eedcb2`) 与 `dim` (`#a89a7a`)，状态色采用 `working` (`#74a046`)、`waiting` (`#e5a93c`)、`stuck` (`#c84a3a`)。

## 1.3 控件尺寸与圆角矩阵

### 控件高度三档梯级

| 档位 / 高度 | 对应参数 / 类名 | 适用位置 |
| --- | --- | --- |
| `24px` (`h-6`) | `Button size="compact"`、`Segmented` 选项、窄胶囊 | 表格行内操作、卡片角落按钮、分段选择项、筛选徽标 |
| `28px` (`h-7`) | `Button size="control"`（默认）、`IconButton`（`size-7`）、紧凑输入框 | 常规按钮、工具条、页首操作与紧致表单行 |
| `32px` (`h-8`) | `TextInput` 默认高度、`Select` 触发器 | 独立文本输入栏与选择器触发框（行内紧凑区可按 `h-7` 覆写） |

### 跨端圆角规范表

| 载体 | 令牌 / 结构 | 数值 | 使用约束 |
| --- | --- | --- | --- |
| **工作台 (`apps/mac/ui/nsh.json`)** | `xs` / `sm` / `md` / `lg` / `xl` / `full` | `3px` / `4px` / `6px` / `8px` / `12px` / `9999px` | 遵循嵌套减一档：外框圆角减去内边距 ≥ 内层圆角 |
| **宿主集成面 (`apps/mac/ui/tokens.ts`)** | `sm` / `md` / `lg` / `button` / `card` / `tray` | `4` / `6` / `8` / `6` / `8` / `12` | 与工作台共享 `design/tokens.json` `geometry.radius` 阶梯 |
| **官网 (`apps/site/src/ui/global.css`)** | `--radius-*: initial` | 默认直角 `0px`（局部云朵用 `rounded-[3px]`，光晕用 `rounded-full`） | 保持像素复古锐利直边，配合 `--shadow-hard*` 硬偏置阴影 |
| **灵动岛 (`apps/island/Sources/IslandCore/Geometry.swift`)** | `closed` / `open` | `10` / `16` | 收起为刘海耳翼小圆角，展开面板为 16px 圆角 |

## 1.4 1px 边框、两档阴影与层级体系

### 边框与阴影定义

- **边框**：所有卡片、表单项与区块分界使用 `1px` `border-line`，焦点状态切换 `border-focus`（2px 聚焦轮廓 `outline-focus`）。卡片嵌套只在必要外框画一根闭合边框，内层分割使用浅色 `border-b border-line` 而不是再包一层外框。
- **阴影（`apps/mac/ui/nsh.json`）**：
  - `shadow-raise`：`0 1px 2px #00000018`（浅浮分段器拇指、局部提示胶囊）。
  - `shadow-float`：`0 8px 24px #0000002e`（下拉菜单、气泡提示、模态 `Dialog`）。
  - `shadow-toggle-thumb`：`0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a`。
  - `shadow-px`：`2px 2px 0 #1e140a73`（像素卡硬边阴影）。
  - 官网 `global.css` 另定 `--shadow-hard` 与 `--shadow-hard-lg` 像素硬偏置阴影。
  - 原生工具调用卡 `apps/mac/ui/tokens.ts` 使用 `cardShadow` 配合亮/暗两套 rgba 边框光环与下影。

> 注：`nsh.json` 中 `tailwind.shadow` 的 `float` 与 `raise` 固定为静态 `#rrggbbaa` 值（不支持引用 `theme.json` 随浅/深主题切换的变量），具体边界见 [第九篇](docs/design/09-design-system-audit.md)。

### 叠放层级表（`z-index`）

| 层级 | 应用载体示例 |
| --- | --- |
| `z-10` | 消息流浮动回底按钮、页面局部固定顶栏、命令面板筛选栏 |
| `z-20` | `MoreMenu` 下拉面板、`Select` 选项浮层、内联自动补全菜单 |
| `z-30` | `Dialog` 模态遮罩层与居中弹窗、灯箱（`Lightbox`）图片查看层 |
| `z-40` | `ToastHost` 全局非阻塞通知堆栈、`Tip`/`Bubble` 悬浮提示 |

## 1.5 字体排版、对比度与图标梯级

### 字体栈与字号阶梯

- **工作台字体（`apps/mac/ui/nsh.json`）**：`sans` 为 `"PingFang SC"`、`mono` 为 `"Menlo"`、`pixel` 为 `"FusionPixel"`（实际多字体字符回退链位于原生终端 `apps/mac/src/terminal/element.rs` 与官网 `apps/site/src/ui/global.css`）。
- **原生与终端字体（`apps/mac/src/theme.rs`、`apps/mac/src/terminal/element.rs`）**：界面基准字号 `ui_font_size = 13.0`，等宽字体默认 `"Maple Mono NF CN"`（回退链依次探测 `SF Mono`、`JetBrains Maple Mono`、`JetBrainsMono Nerd Font`、`Menlo`、`Monaco`），并携带 Nerd Font / PingFang SC / Apple Color Emoji 字符级回退列表。
- **像素字体（`assets/fonts/fusion-pixel-12px-proportional-zh_hans.otf`）**：在 GPUI 与 `nsh` 像素视图内显式注册 `Fusion Pixel 12px Prop zh-Hans`。

工作台字号行高阶梯（`apps/mac/ui/nsh.json` `tailwind.fontSize`）：

| 类名 | 字号 / 行高 | 典型用途 |
| --- | --- | --- |
| `text-2xs` | `11px` / `14px` | 微型状态徽标、快捷键键帽文字、左侧栏窄提示标签 |
| `text-xs` | `12px` / `16px` | 表格辅助列、时间戳、设置行说明 (`hint`)、状态标签字号 |
| `text-sm` | `13px` / `20px` | 工作台全局默认正文、列表主行、表单标签与按钮文案 |
| `text-base` | `14px` / `22px` | 强调正文、对话正文、工单标题（卡片/行内） |
| `text-lg` | `16px` / `24px` | 弹窗头部标题、工单侧栏区块头 |
| `text-xl` | `20px` / `28px` | 标准页面主标题（设置、档案详情、子页头） |
| `text-2xl` | `24px` / `32px` | 工单详情大标题、工作区主总览标题 |
| `text-3xl` | `30px` / `36px` | 空状态插画页首级展示标题 |

### 对比度与文本截断约束

- **对比度准绳**：正文与操作入口坚持 WCAG AA；`bg-wheat` 等亮底上配 `text-bark-900`（`#2f1f13`）保证高对比度（左侧全局栏未读角标在 `apps/mac/ui/vv/web/app/Shell.tsx` 中用 `text-bark-900` 压在 `bg-wheat` 上在深浅双主题下均保持高于 `7:1` 对比度）；`ok-ink` / `warn-ink` 专门配合各自柔和高亮底色使用。
- **截断约束**：单行文字行必须放置于带有 `min-w-0` 的弹性父容器内，再附加 `truncate`（必要时辅以 `style={{ numberOfLines: 1 }}`），确保 CJK 句子与长 Hash/URL 不会溢出或撑坏同行控件。

### 图标梯级（`IconSize`）与两套图标系统

`apps/mac/ui/vv/web/ui/Icon.tsx` 限定工作台矢量图标必须使用 `IconSize` 七档之一：

| 尺寸 | 典型场景 |
| --- | --- |
| `10` | 极窄状态计数旁的微标、表格排序箭头 |
| `12` | `sm` 按钮内置图标、标签前缀、复选框勾号 |
| `14` | `md` / `lg` 按钮图标、列表前置操作图标 |
| `16` | 全局/模块导航项图标、设置卡片行标、输入框前后缀图标 |
| `20` | 页面副标题辅助图标、卡片主标题标徽 |
| `24` | 独立工具栏大图标、模态弹窗提示图标 |
| `48` | `Empty` 空状态主视觉图标 |

工作台与外壳中还存在与 `icons.ts` 独立的 Canvas 手绘图形集合（如 `apps/mac/ui/surfaces/shared.tsx` 的 `SurfaceIcon`、`apps/mac/ui/surfaces/Sidebar.tsx` 的 `GLYPHS` 与 `apps/mac/ui/components/ToolCallCard.tsx` 的工具图标），具体边界见 [第九篇](docs/design/09-design-system-audit.md)。

## 1.6 动效时长与缓动曲线全集

工作台与宿主组件禁止为常规交互添加长动画或无节制的弹簧回弹，所有载体统一尊重系统的 `reduceMotion()` 开关。

| 载体与配置源 | 时长阶梯 | 缓动曲线 / 函数 | 用途划分 |
| --- | --- | --- | --- |
| **工作台 (`apps/mac/ui/nsh.json`)** | `120ms` (`duration-120`)<br>`180ms` (`duration-180`)<br>`280ms` (`duration-280`) | `ease-out`: `cubic-bezier(0.2, 0.0, 0.0, 1.0)`<br>`ease-in`: `cubic-bezier(0.4, 0.0, 1.0, 1.0)`<br>`ease-in-out`: `cubic-bezier(0.4, 0.0, 0.2, 1.0)`<br>`ease-spring`: `cubic-bezier(0.34, 1.4, 0.64, 1.0)` | `120ms` 负责按钮按下、悬停、`Segmented` 激活换色；`180ms` 负责 `Toggle` 开关圆点滑移与焦点显现；`280ms` 负责较大区域或折展切换 |
| **宿主集成面 (`apps/mac/ui/motion.ts`)** | `press: 160`、`expandOpacity: 240`、`foldOpacity: 300`、`statusSwap: 360`、`chevron: 360`、`expandHeight: 400`、`foldHeight: 460`、`spinner: 800`、`foldHold: 1100`、`copyConfirm: 1400`、`timerTick: 100` | `ease = "cubic-bezier(0.2, 0, 0, 1)"`（同步自 `design/tokens.json`） | `ms(d)` 在 `reduceMotion()` 开启时强行降为 `0`；展开/收起调用 `LayoutAnimation.configureNext` |
| **官网 (`apps/site/src/ui/global.css`)** | 过渡交互 `0.15s`–`0.25s`；像素场景帧动画 `steps(...)` | `--ease-out: cubic-bezier(0.2, 0, 0, 1)`（同步自 `design/tokens.json`） | 兼顾 `@media (prefers-reduced-motion: reduce)` 与 `[data-off]` 静态降级关闭全部过渡和动画 |
| **灵动岛 (`Island.swift`)** | 展收形变 `0.2s`；鼠标离开防误收宽限 `0.25s` | AppKit `easeOut` | 高频移入移出防闪烁保护 |
