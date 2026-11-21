# 第九篇：跨载体设计系统横向差异审计

本篇基于当前代码基线的实证核查，记录四个 UI 渲染载体之间仍客观存在的令牌偏移、双源实现与静态检查边界。

## 9.1 跨载体核心令牌对照与剩余偏移

`design/tokens.json` 经 `scripts/gen/tokens.ts` 统一生成工作台与工作区外壳共用的 `theme.json`/`nsh.json`、原生壳 `theme_tokens.rs`，并同步官网 `global.css` 的 `--ease-out`（统一为 `cubic-bezier(0.2, 0, 0, 1)` 与 `4/6/8/12` 圆角阶梯）。各载体间仍保留以下差异：

| 维度 | 工作台与工作区外壳 (`apps/mac/ui/design/theme.json` + `nsh.json`) | 原生壳 (`apps/mac/src/theme.rs` + `theme_tokens.rs`) | 官网 (`apps/site/src/ui/global.css`) | 灵动岛 (`Island.swift` + `Geometry.swift`) |
| --- | --- | --- | --- | --- |
| **深色主表面底** | `page`: `#151413`、`side`: `#1b1a18`、`rail`: `#121110`、`elevated`: `#21201d` | `bg`: `#151413`、`surface`: `#1b1a18`、`elevated`: `#21201d` | 固定暖木/深夜绿背景序列 | 深暖黑底（`Color.black`） |
| **浅色主表面底** | `page`: `#fcfcfb`、`side`: `#f6f5f3`、`rail`: `#efeeeb`、`elevated`: `#fcfcfb` | `bg`: `#fcfcfb`、`surface`: `#f6f5f3`、`elevated`: `#fcfcfb` | `cream-*` 暖米白系 | 固定深暖色（不跟浅色主题变白） |
| **边框颜色** | `line`: 浅 `#1c191714` / 深 `#ecebe81a` | `border`: 浅 `#e6e4e0` / 深 `#2d2b27` | `bark-*` 显式像素边界 | 无边框令牌 |
| **主绿 / 告警色** | `accent`: 浅 `#4d7a2a` / 深 `#7fae4f`；`wheat`: 双主题 `#e5a93c`；`berry`: 浅 `#a83a2c` / 深 `#e47d6d` | `accent`: 浅 `#4d7a2a` / 深 `#7fae4f`；`warning`: 浅 `#b45d0e` / 深 `#e5a93c`；`success`: 浅 `#3f7329` / 深 `#7fae4f`；`danger`: 浅 `#a83a2c` / 深 `#e47d6d` | `leaf-500`: `#74a046` / `wheat`: `#e5a93c` / `berry`: `#c84a3a` | `working`: `#74a046` / `waiting`: `#e5a93c` / `stuck`: `#c84a3a` |
| **圆角梯级** | `xs:3`、`sm:4`、`md:6`、`lg:8`、`xl:12`、`full:9999` | 控件内硬编码像素圆角 | `--radius-*: initial`（默认 `0px`，极少显式 `rounded-[3px]`） | `closed:10`、`open:16` |

具体剩余偏移如下：

- **工作台阴影静态化**：`apps/mac/ui/design/theme.json` 在 `cssVars.light` 与 `cssVars.dark` 下分别定义了 `float`（浅 `#1c191724` / 深 `#00000066`）与 `raise`（浅 `#1c191714` / 深 `#00000059`），但 `apps/mac/ui/nsh.json` 的 `tailwind.shadow` 因运行时限制使用静态 `#rrggbbaa` 值（`"float": "0 8px 24px #0000002e"`、`"raise": "0 1px 2px #00000018"`），不随浅/深主题自动切换阴影颜色。
- **原生壳与工作台局部亮度分叉**：浅色模式下，工作台 `theme.json` 的 `leaf` 为 `#74a046`、`warn-ink` 为 `#94531f`，而 `apps/mac/src/theme_tokens.rs` 额外保留原生终端/状态栏的 `shell.warning`（`#b45d0e`）与 `shell.success`（`#3f7329`）。
- **灵动岛未接入自动生成**：`apps/island/Sources/VibeValleyIsland/Island.swift` 与 `apps/island/Sources/IslandCore/Geometry.swift` 的色值（`#eedcb2`、`#a89a7a`、`#74a046`、`#e5a93c`、`#c84a3a`）和几何圆角（`10` / `16`）由 Swift 常量手工与 `design/tokens.json` 对齐，尚未纳入 `scripts/gen/tokens.ts` 生成范围。

## 9.2 工作区外壳与工作台原语收口现状

原工作区外壳独立双轨模块与 `apps/mac/ui/workspace/Sidebar.tsx` 自建矢量图标表已全部清除并收口：`apps/mac/ui/workspace/` 现与工作台统一使用 `theme.json` / `nsh.json` 的 Tailwind 令牌类与 `apps/mac/ui/design/` 原语（`Icon`、`ActiveBar`、`Button`、`Bubble`、`mix()`）；跨页共享的外壳节头 `SectionHead`、紧凑图标按钮 `ShellIconButton` 与右键菜单样式类集中于 `apps/mac/ui/workspace/chrome.tsx`。

## 9.3 令牌层次与命名空间现状

1. **`cssVars.theme` 扁平混合命名**：`apps/mac/ui/design/theme.json` 将全量 `cssVars.theme` 并列挂在同一平级命名空间下，混装基础色阶（`cream-50..300`、`bark-400..950`）、特定子组件局部色（`lcd-*`、`phone-*`、`catalog-*`、`agent-stage-*`）与临时状态透明值（`px-toast-warn`、`patch-add-bg`），未在输出层面拆分「基础原色 → 语义别名 → 组件专用」层级。
2. **缺失密度与失焦状态令牌**：所有令牌文件均未定义正式的界面紧凑度（`density`）令牌及独立的窗口失焦态（`unfocused`）表面/文字令牌，失焦面板与标准面板呈现相同的对比强度与留白节奏。

## 9.4 矢量图标收口清单

工作台与工作区外壳全部矢量图标均已收口至 `apps/mac/ui/design/icons.ts`（经 `<Icon name>` 统一渲染，工作区所需的 `minus`、`branch`、`diff`、`collapseAll`、`expandAll`、`lock` 也已合并入主表），不再存在独立的 Canvas 手绘图标集。

## 9.5 静态检查覆盖边界

- **工作台与工作区外壳（`apps/mac/ui/`）**：`scripts/audit/ui-tokens.ts` 对工作台（`apps/mac/ui/{app,design,features,infra}/`）及工作区外壳（`apps/mac/ui/workspace/`）下的 `.ts`/`.tsx` 执行 AST 扫描，阻断硬编码颜色（十六进制、`rgb()`/`rgba()`、hex-alpha 拼接）、任意 Tailwind 类名、裸 `<Switch` / `role="checkbox"` 以及选择/激活态几何位移（`selection-layout-shift`；`OutlineEditor.tsx` 5 态任务格、`ConnectorsPage.tsx` 第三方品牌色与 `features/artifact/shell.ts` 注入脚本配色配置了精确规则豁免）；类型检查与打包通过 `nsh check` / `nsh build`（`vp run mac:check`）执行。
- **根级 `oxlint` 覆盖条件**：在 macOS 本机运行 `nsh check` 生成 `.nsh/tsconfig.json` 后，`apps/mac/ui/**`（含 `workspace/`、`design/`、`features/`、`app/`、`farm/`、`infra/`）会一并接入 `vp lint --deny-warnings apps/mac/ui`（Linux CI 因无 `nsh` 跳过该目录，见 `vite.config.ts`）。
