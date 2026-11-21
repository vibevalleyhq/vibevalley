# 第九篇：跨载体设计系统横向差异审计

本篇基于当前代码基线的实证核查，记录五个 UI 渲染载体与两套组件库之间仍客观存在的令牌偏移、双源实现、手绘图标与静态检查缺口。

## 9.1 五载体核心令牌对照与剩余偏移

`design/tokens.json` 经 `scripts/gen/tokens.ts` 统一生成工作台 `theme.json`/`nsh.json`、宿主 `tokens.ts`、原生壳 `theme_tokens.rs`，并同步 `motion.ts` 的 `ease` 与官网 `global.css` 的 `--ease-out`（统一为 `cubic-bezier(0.2, 0, 0, 1)` 与 `4/6/8/12` 圆角阶梯）。各载体间仍保留以下差异：

| 维度 | 工作台 (`apps/mac/ui/vv/theme.json` + `nsh.json`) | 宿主组件 (`apps/mac/ui/tokens.ts`) | 原生壳 (`apps/mac/src/theme.rs` + `theme_tokens.rs`) | 官网 (`apps/site/src/ui/global.css`) | 灵动岛 (`Island.swift` + `Geometry.swift`) |
| --- | --- | --- | --- | --- | --- |
| **深色主表面底** | `page`: `#151413`、`side`: `#1b1a18`、`rail`: `#121110`、`elevated`: `#21201d` | `surface`: `#21201d`、`canvas`: `#1b1a18`、`subtle`: `#312f2b` | `bg`: `#151413`、`surface`: `#1b1a18`、`elevated`: `#21201d` | 固定暖木/深夜绿背景序列 | 深暖黑底（`Color.black`） |
| **浅色主表面底** | `page`: `#fcfcfb`、`side`: `#f6f5f3`、`rail`: `#efeeeb`、`elevated`: `#fcfcfb` | `surface`: `#fcfcfb`、`canvas`: `#f6f5f3`、`subtle`: `#e7e5e0` | `bg`: `#fcfcfb`、`surface`: `#f6f5f3`、`elevated`: `#fcfcfb` | `cream-*` 暖米白系 | 固定深暖色（不跟浅色主题变白） |
| **边框颜色** | `line`: 浅 `#1c191714` / 深 `#ecebe81a` | `border`: 浅 `#e6e4e0` / 深 `rgba(236,235,232,0.11)` | `border`: 浅 `#e6e4e0` / 深 `#2d2b27` | `bark-*` 显式像素边界 | 无边框令牌 |
| **主绿 / 告警色** | `accent`: 浅 `#4d7a2a` / 深 `#7fae4f`；`wheat`: 双主题 `#e5a93c`；`berry`: 浅 `#a83a2c` / 深 `#e47d6d` | `ok`: 浅 `#74a046` / 深 `#8dbb5c`；`alert`: 浅 `#94531f` / 深 `#e5a93c`；`danger`: 浅 `#a83a2c` / 深 `#e47d6d` | `accent`: 浅 `#4d7a2a` / 深 `#7fae4f`；`warning`: 浅 `#b45d0e` / 深 `#e5a93c`；`success`: 浅 `#3f7329` / 深 `#7fae4f`；`danger`: 浅 `#a83a2c` / 深 `#e47d6d` | `leaf-500`: `#74a046` / `wheat`: `#e5a93c` / `berry`: `#c84a3a` | `working`: `#74a046` / `waiting`: `#e5a93c` / `stuck`: `#c84a3a` |
| **圆角梯级** | `xs:3`、`sm:4`、`md:6`、`lg:8`、`xl:12`、`full:9999` | `sm:4`、`md:6`、`lg:8`、`button:6`、`card:8`、`tray:12` | 控件内硬编码像素圆角 | `--radius-*: initial`（默认 `0px`，极少显式 `rounded-[3px]`） | `closed:10`、`open:16` |

具体剩余偏移如下：

- **深色表面命名交叉**：在 `apps/mac/src/theme.rs` 中 `#151413` 是 `bg`、`#1b1a18` 是 `surface`、`#21201d` 是 `elevated`；但在 `apps/mac/ui/tokens.ts` 中将 `#21201d` 命名为 `surface`、将 `#1b1a18` 命名为 `canvas`（`#151413` 仅作为 `dark.onPrimary`）；而工作台 `theme.json` 将 `#151413` 命名为 `page`、`#1b1a18` 命名为 `side`、`#121110` 命名为 `rail`、`#21201d` 命名为 `elevated`。
- **工作台阴影静态化**：`apps/mac/ui/vv/theme.json` 在 `cssVars.light` 与 `cssVars.dark` 下分别定义了 `float`（浅 `#1c191724` / 深 `#00000066`）与 `raise`（浅 `#1c191714` / 深 `#00000059`），但 `apps/mac/ui/nsh.json` 的 `tailwind.shadow` 因运行时限制使用静态 `#rrggbbaa` 值（`"float": "0 8px 24px #0000002e"`、`"raise": "0 1px 2px #00000018"`），不随浅/深主题自动切换阴影颜色。
- **原生壳与宿主局部亮度分叉**：浅色模式下，工作台 `theme.json` 的 `leaf` 为 `#74a046`、`warn-ink` 为 `#94531f`，而 `apps/mac/src/theme_tokens.rs` 额外保留原生终端/状态栏的 `shell.warning`（`#b45d0e`）与 `shell.success`（`#3f7329`）。
- **灵动岛未接入自动生成**：`apps/island/Sources/VibeValleyIsland/Island.swift` 与 `apps/island/Sources/IslandCore/Geometry.swift` 的色值（`#eedcb2`、`#a89a7a`、`#74a046`、`#e5a93c`、`#c84a3a`）和几何圆角（`10` / `16`）由 Swift 常量手工与 `design/tokens.json` 对齐，尚未纳入 `scripts/gen/tokens.ts` 生成范围。

## 9.2 双源并存的组件库

仓库内同一业务语义在两个 TSX 目录中各自维护两套互不复用的视觉组件与样式方案：

| 业务功能 | 工作台标准实现（Tailwind 令牌流） | 宿主扩展实现（`tokens.ts` 内联样式流） | 实质差异 |
| --- | --- | --- | --- |
| **状态胶囊徽标** | `apps/mac/ui/vv/web/ui/Tag.tsx`（`Tag` + `Dot`） | `apps/mac/ui/components/StatusBadge.tsx` | 各自维护配色映射与内边距圆角规则 |
| **思考加载指示** | `ThinkingDots`（`apps/mac/ui/vv/web/features/channel/views/presence.tsx`） | `apps/mac/ui/components/ThinkingLoader.tsx` | 后者额外依赖 `motion.ts` 的 `formatElapsed` 与固定计秒跳变 |
| **工具步骤展示** | `WorkLog.tsx`（`apps/mac/ui/vv/web/features/session/WorkLog.tsx`） | `apps/mac/ui/components/ToolCallCard.tsx` & `ToolCallGroup.tsx` | `ToolCallCard` 自建 Canvas 图标、JSON 着色器、`CAP = 220` 渐隐折叠与 `Retry` 按钮；`WorkLog` 基于工作台令牌平铺折叠 |
| **图片灯箱网格** | `AttachmentTile.tsx` + `Lightbox.tsx` | `apps/mac/ui/components/Gallery.tsx` | 各管一套缩放预览与键盘关闭流 |

## 9.3 令牌层次与命名空间现状

1. **`cssVars.theme` 扁平混合命名**：`apps/mac/ui/vv/theme.json` 将全量 `cssVars.theme` 并列挂在同一平级命名空间下，混装基础色阶（`cream-50..300`、`bark-400..950`）、特定子组件局部色（`lcd-*`、`phone-*`、`catalog-*`、`agent-stage-*`）与临时状态透明值（`px-toast-warn`、`patch-add-bg`），未在输出层面拆分「基础原色 → 语义别名 → 组件专用」层级。
2. **缺失密度与失焦状态令牌**：五套令牌文件均未定义正式的界面紧凑度（`density`）令牌及独立的窗口失焦态（`unfocused`）表面/文字令牌，失焦面板与标准面板呈现相同的对比强度与留白节奏。

## 9.4 外壳手绘图形图标清单

工作台图标收拢于 `apps/mac/ui/vv/web/ui/icons.ts`（经 `<Icon name>` 统一渲染），而宿主外壳与扩展组件目录仍保留三处独立 Canvas 手绘图形实现：

- `apps/mac/ui/surfaces/Sidebar.tsx` 自建 `GLYPHS` 矢量路径对象并通过 `Canvas` 手绘文件树与终端边栏图标；
- `apps/mac/ui/surfaces/shared.tsx` 维护 `drawSurfaceIcon`（15 个 Canvas 路径图标 + `GLYPH_TO_ICON` 字符映射表），供 `Palette.tsx` 与外壳面使用；
- `apps/mac/ui/components/ToolCallCard.tsx` 内部手写 `drawToolIcon`、`ErrorMark` 与 `CopyIcon`（复制成功状态混用一次 `SurfaceIcon name="check"`）。

## 9.5 静态检查覆盖边界

- **工作台与原生宿主 UI（`apps/mac/ui/{vv/web,surfaces,components}/`）**：`scripts/audit/ui-tokens.ts` 对工作台（`vv/web/{app,features,ui}/`）及原生宿主面板与扩展组件（`surfaces/`、`components/`）下的 `.ts`/`.tsx` 执行 AST 扫描，阻断硬编码颜色（十六进制、`rgb()`/`rgba()`、hex-alpha 拼接）、任意 Tailwind 类名、裸 `<Switch` / `role="checkbox"` 以及选择/激活态几何位移（`selection-layout-shift`；`OutlineEditor.tsx` 5 态任务格与 `ConnectorsPage.tsx` 第三方品牌色配置了精确规则豁免）；类型检查与打包通过 `nsh check` / `nsh build`（`vp run mac:check`）执行。
- **根级 `oxlint` 覆盖盲区**：由于 `vite.config.ts` 的 `lint.ignorePatterns` 仍包含 `"apps/mac/ui/**"`，外壳面板与扩展组件尚未接入根目录 `oxlint` 类型规则，仅依赖 `nsh check` 与 `scripts/audit/ui-tokens.ts` 把关。
