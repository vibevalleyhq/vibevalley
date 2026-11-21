---
name: vv-tailwind
description: 在 VibeValley 的工作台（apps/mac/ui/vv/web，nsh 的 Tailwind class）和官网（apps/site，Tailwind v4）里写、改、评审样式：令牌在哪、class 只叫令牌的名字、半透明的颜色和动态的值怎么写、变体、零件怎么收调用方的 class、怎么截图验证。用在：新写或改界面样式；把写死的 style 换成 class；官网的 lint 报 vibevalley/style-attrs；用户说「Tailwind 写法」「换成 class」「样式不生效」。
---

# 写 Tailwind

两处用 Tailwind 的写法，底下不是同一个东西：

| | 工作台 `apps/mac/ui/vv/web` | 官网 `apps/site` |
|---|---|---|
| 谁读 class | nsh（不是浏览器，没有 CSS 文件） | Tailwind v4 的 Vite 插件 |
| 元素 | nsh 的 `View`、`Text` 等，属性是 `class` 和对象 `style` | DOM 元素 |
| 令牌在哪 | 颜色在 `apps/mac/ui/vv/theme.json`，字号、圆角、缓动、字体、阴影在 `apps/mac/ui/nsh.json` 的 `tailwind` | `apps/site/src/ui/global.css` 的 `@theme static` |
| 谁查 | `vp run mac:check` 只查类型；lint 不扫 `apps/mac/ui` | `vp check`：`vibevalley/style-attrs` 拦 `className`、`classList` 和只写死值的 `style` |

外壳的面（`apps/mac/ui/surfaces`、`components`）不用 class：它们用对象 `style` 读 `apps/mac/ui/tokens.ts` 的 `tok()`，值和 `apps/mac/src/theme.rs` 一样。

## 先读哪里

1. [哲学与令牌](docs/design/01-philosophy-and-tokens.md) 与 [Agent UI 指南](docs/design/08-agent-ui-guide.md)：挑哪一档令牌、原子组件的样子、交之前的自查。
2. 令牌的文件（上表）。
3. 照着抄的零件：[Button](apps/mac/ui/vv/web/ui/Button.tsx)（变体表、按下、禁用、字另起一个 `Text`）、[Tag](apps/mac/ui/vv/web/ui/Tag.tsx)（半透明的底、`Dot` 的动态尺寸）、[Icon](apps/mac/ui/vv/web/ui/Icon.tsx)（颜色按令牌名传）。

## 工作台：class 名就是令牌名

| 要什么 | class | 令牌在哪 |
|---|---|---|
| 表面、字、线、状态色 | `bg-page` `bg-side` `bg-rail` `text-ink` `text-muted` `text-faint` `border-line` `bg-hover` `bg-selected` `border-focus` `bg-accent` `hover:bg-accent-hover` `text-leaf` `bg-wheat` `text-berry` `text-water` `bg-idle` `bg-scrim` `bg-code-bg` | `theme.json` 的 `cssVars.light`、`cssVars.dark`：两套同名，跟着主题换 |
| 像素皮的颜色 | `bg-cream-50` `text-bark-900` `bg-leaf-500` … | `theme.json` 的 `cssVars.theme`：不跟主题换 |
| 字号带行高 | `text-2xs` `text-xs` `text-sm` `text-base` `text-lg` `text-xl` `text-2xl` `text-3xl` | `nsh.json` 的 `tailwind.fontSize`（11、12、13、14、16、20、24、30） |
| 字体 | `font-sans` `font-mono` `font-pixel` | `tailwind.fontFamily` |
| 圆角 | `rounded-xs`(3) `rounded-sm`(4) `rounded-md`(6) `rounded-lg`(8) `rounded-xl`(12) `rounded-full` | `tailwind.radius` |
| 阴影 | `shadow-raise` `shadow-float` `shadow-px` | `tailwind.shadow` |
| 缓动 | `ease-out` `ease-in` `ease-in-out` `ease-spring`，时长 `duration-120` 这类 | `tailwind.ease` |
| 留白 | `p-1`=4px，`gap-1.5`=6px，`px-2.5`=10px，`py-px`=1px | 4px 的倍数 |

- **新的用途先起名**：颜色加进 `theme.json`，`light` 和 `dark` 都写；别的加进 `nsh.json`。再用它的 class。
- **字的样式写在 `Text` 上**：nsh 里字的颜色和字号不从外面的 `View` 传下来，所以零件把字另起一个 `Text`，自己带 `text-*`（`Button` 的 `Words`）。
- **半透明的颜色用 `mix`**：nsh 没有 `color-mix`，写 `style={{ backgroundColor: mix("wheat", 0.25) }}`（`apps/mac/ui/vv/web/ui/tone.ts`，令牌名加 0–1 的份量）；按名字取一个令牌的颜色用 `tone("leaf")`。
- **变体**：代码里用到的是 `hover:`、`active:`、`focus:`、`disabled:`、`placeholder:`，祖先写 `group`、后代写 `group-hover:`，断点 `sm:`(40rem)、`md:`(48rem)、`lg:`(64rem)。别的变体先在一个零件上试过再用。
- **按数据算的值写 `style`**：宽高、坐标、按属性给的尺寸写成对象 `style`（驼峰的键、数字是点：`{ width: size(), height: size() }`）。
- **多个变体用 `Record<Variant, string>`**，一种变体的 class 放一行（`Button` 的 `tones`）。

## 官网：Tailwind v4

`global.css` 的 `@theme static` 先清掉 Tailwind 自带的色板、字号、圆角、阴影和缓动（`--color-*: initial` 这些），再写自己的；class 只能叫出这里有名字的值，`bg-red-500`、`rounded-2xl` 写了不生效。

- 任意值只给令牌管不着的几何（宽高、定位、网格的列、`transition-[…]` 的属性表）；颜色、字号、留白、圆角、阴影、时长都用令牌。
- 引用变量写 `p-(--gutter)`；按数据算的值写 `style` 或一个 CSS 变量再由 class 读它，不拼 class 名（Tailwind 扫不到）。
- 只写死值的 `style={{ "margin-left": "12px" }}` 由 `vibevalley/style-attrs` 拦下：它该写成 class。
- 同一属性的两个 utility 谁赢看样式表的顺序，不看 class 串里的先后：一个元素上两个条件的样式碰同一属性时写成互斥的三元。

## 零件收调用方的样式

- 零件收 `class?: string`，接在自己的 class 后面。
- class 拼接不判冲突。调用方的 `class` 只补零件没设的（位置、宽度、外边距、`grow`）；要改零件已经设了的（颜色、高度、内边距），给零件加一个变体属性（`tone`、`size`）。

## 验证

1. 工作台跑 `vp run mac:check`，官网跑 `vp check`。
2. 工作台照 [vv-acceptance 的应用分册](.agents/skills/vv-acceptance/references/app.md)截图：改之前截一份基准，改完用同一份脚本再截，浅色、深色各一张，逐张比：

   ```bash
   python3 - <<'EOF'
   from PIL import Image, ImageChops
   import os
   a, b = "/tmp/vv-app/before", "/tmp/vv-app/after"
   for name in sorted(os.listdir(a)):
       if os.path.exists(os.path.join(b, name)):
           box = ImageChops.difference(Image.open(os.path.join(a, name)).convert("RGB"), Image.open(os.path.join(b, name)).convert("RGB")).getbbox()
           print(name, "same" if box is None else box)
   EOF
   ```

   农场是动画，两次截图本来就不同；别的页有差别就打开两张图看，说清楚为什么或者改掉。
3. 官网照 [apps/site/README.md](apps/site/README.md) 的测试。

## 出错时先查什么

| 现象 | 先查 |
|---|---|
| 写了 class 不生效 | 令牌名是不是令牌文件里有的；工作台里这个 class 或变体 nsh 认不认（找一个已经在用它的零件） |
| 字的颜色、字号没变 | class 是不是写在了 `View` 上：挪到 `Text` |
| 深色主题里颜色不对 | 新颜色是不是只写了 `light`；是不是用了 `cssVars.theme` 里不跟主题换的那一个 |
| 调用方的 class 没盖住零件的 | 同一个属性两个 class：给零件加变体，别指望先后 |
