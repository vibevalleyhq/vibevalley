---
name: vv-tailwind
description: 在 VibeValley 的页面（apps/web）和官网（apps/site）里用 Tailwind v4 写、改、评审样式：令牌在 style.css 的 @theme、一段 CSS 写成哪个 class、任意值什么时候可以、动态的值怎么写、变体（hover、focus-visible、data-*、aria-*、@container、主题）、零件怎么收调用方的 class、两条容易踩的优先级、怎么用故事和截图验证。用在：新写或改界面样式；把一段 CSS 或写死的 style 换成 class；lint 报 vibevalley/design-tokens、no-hex-color、style-attrs；用户说「Tailwind 写法」「换成 class」「样式不生效」。
---

# 写 Tailwind

页面的样式是元素上的一串 Tailwind v4 class，令牌只在 `apps/web/src/style.css`（官网的在 `apps/site/src/ui/global.css`，同样是 `@theme`）。

## 先读哪里

1. [界面怎么做](docs/style/design.md)：挑哪一档令牌、原子组件的样子、交之前的自查。
2. `apps/web/src/style.css`：`@theme static`（先用 `--color-*: initial` 这些清掉 Tailwind 自带的，再写其余令牌：字、行高、粗细、圆角、缓动、容器宽度、像素皮的颜色）、紧跟其后的 `@theme inline`（跟着主题换的颜色和两档阴影；必须在清空之后，放在前面会被 `initial` 抹掉，`bg-page` 这些就不生成）、`@theme` 里的 `--animate-*` 和关键帧、`@utility`（`scroll-fade-x/y`、`pixel-*`）。
3. 换过的零件照着抄：[Button](apps/web/src/ui/Button.tsx)（变体表、按下、禁用）、[Tag](apps/web/src/ui/Tag.tsx)（`Dot` 的动态尺寸）、[Icon](apps/web/src/ui/Icon.tsx)（零件的不变量压过调用方）。

## 令牌：class 名就是令牌名

`@theme` 先清掉了 Tailwind 自带的色板、字号、圆角、阴影、缓动（`--color-*: initial` 这些），所以 class 只能叫出这里有名字的值；`bg-red-500`、`text-lg`（Tailwind 的 18px）、`rounded-2xl`、`shadow-md` 都不存在了，写了也不生效。

| 要什么 | class | 说明 |
|---|---|---|
| 表面、字、线、状态色 | `bg-page` `bg-side` `bg-rail` `text-ink` `text-muted` `text-faint` `border-line` `bg-hover` `bg-selected` `outline-focus` `bg-accent` `hover:bg-accent-hover` `text-leaf` `bg-wheat` `text-berry` `text-water` `bg-idle` `bg-ok-soft text-ok-ink` `bg-bad-soft text-berry` `bg-scrim` `bg-code-bg text-code-ink` | `@theme inline`：utility 里直接是 `var(--wb-*)`，在哪个 `data-theme` 下就取哪套 |
| 浅一档的意思色 | `bg-wheat/25`、`bg-ink/10` | 等于 `color-mix(in oklab, … 25%, transparent)`，替代手写的 `color-mix` |
| 字号带行高 | `text-2xs` `text-xs` `text-sm` `text-base` `text-lg` `text-xl` `text-2xl` `text-3xl` | 11/14、12/16、13/20、14/22、16/24、20/28、24/32、30/36；只改行高写 `leading-xs`… `leading-snug` `leading-relaxed` |
| 粗细 | `font-normal` `font-medium` `font-semibold` | 只有这三档 |
| 字体 | `font-sans` `font-mono` `font-pixel` | |
| 圆角 | `rounded-xs`(3) `rounded-sm`(4) `rounded-md`(6) `rounded-lg`(8) `rounded-xl`(12) `rounded-full` | `"9999px"`（`radii.pill`）写 `rounded-full` |
| 阴影 | `shadow-raise` `shadow-float` | 像素皮另有 `pixel-window` `pixel-frame` `pixel-ring` `pixel-drop` `pixel-shade`，和 `shadow-px` `shadow-px-shade` |
| 动效 | `duration-120`（指针）`duration-180`（状态，也是默认）`duration-280`（面板）`ease-out` `ease-in` `ease-in-out` `ease-spring` | `transitionProperty: "background-color, border-color"` 写 `transition-[background-color,border-color]`，只列真要动的 |
| 入场 | `animate-pop-in`（菜单、浮层、对话框、toast）`animate-fade-in`（提示、暗幕） | 减少动效时 style.css 停下它们；别的关键帧写进 style.css 的 `@theme`（`--animate-x` 加 `@keyframes x`），并给 `motion-reduce:animate-none` |
| 层 | `z-10` `z-20` `z-30` `z-40` | 和 design.md 的四档一样 |
| 留白 | `p-1`=4px，`gap-1.5`=6px，`px-2.5`=10px，`py-px`=1px，`p-1.25`=5px | `--spacing` 是 0.25rem，0.25 的倍数都能写，不用 `p-[5px]` |
| 断点 | `sm:`(40rem) `md:`(48rem) `lg:`(64rem) `xl:`(80rem)；`max-sm:` 是 `width < 40rem` | `@media (width >= 40rem)` 写 `sm:` |
| 容器宽度 | `max-w-sm`…`max-w-4xl`（24–56rem），`@container` 加 `@min-[760px]:` | `var(--container-3xl)` 写 `max-w-3xl` |
| 像素皮的字 | `pixel-xs` `pixel-fine` `pixel-sm` `pixel-base` `pixel-lg` `pixel-xl` `pixel-2xl` `pixel-mono` `pixel-read`，焦点 `pixel-focus` | 原来的 `pxStyle.*`，定义在 style.css 的 `@utility` |
| 像素皮的颜色 | `bg-cream-50` `text-bark-900` `border-bark-500` `bg-leaf-500` `bg-px-scrim`… | 名字和 style.css 里 `--color-*` 一样 |

新的用途先在 style.css 起名（两种主题都写，跟主题换的放 `--wb-*` 和 `@theme inline`），再用它的 class。CSS 文件（`Markdown.css`、`reset.css`）和 `style` 里的值还读同名的 `var(--color-*)`、`var(--text-*)`，所以 `@theme static` 里的令牌总会输出成 `:root` 上的变量，别改成不带 `static`。

## 一段 CSS 写成哪个 class

| CSS | class |
|---|---|
| `@media (hover: hover)` 里的 `:hover` | `hover:`（Tailwind 的 `hover:` 自带 `@media (hover: hover)`） |
| `:focus-visible`、`:disabled`、`:active` | `focus-visible:` `disabled:` `active:`；按下禁用时不动：`active:translate-y-px disabled:active:translate-y-0` |
| 禁用时 `opacity: 0.5` | `disabled:opacity-50`，唯一的禁用样子 |
| `[data-state=open]`、`[aria-current=page]`、`[data-selected]` | `data-[state=open]:` `aria-[current=page]:` `data-selected:` |
| 祖先悬停时变（`.row:hover .x`） | 祖先写 `group/名字`，后代写 `group-hover/名字:`、`group-data-selected/名字:`、`group-focus-visible/名字:`；兄弟用 `peer` |
| `::placeholder`、`::backdrop`、`::before` | `placeholder:text-faint` `backdrop:bg-scrim` `before:content-['']` |
| `@container (width >= 760px)` | 容器 `@container`，里面 `@min-[760px]:` |
| `@media (prefers-reduced-motion: reduce)` 停下动画 | `motion-reduce:animate-none`（`animate-pop-in`、`animate-fade-in` 已由 style.css 停） |
| 菜单、浮层进来；提示、暗幕淡入 | `animate-pop-in`、`animate-fade-in`；`::backdrop` 的淡入写 `backdrop:animate-fade-in` |
| 自己的关键帧 | `@keyframes` 写进 style.css，元素上 `[animation-name:x]` 加时长等长写，或在 `@theme` 起 `--animate-x`；都给 `motion-reduce:` 的停法 |
| 单行省略 | `truncate`；多行 `line-clamp-2`；弹性子项 `min-w-0` |
| `border: 1px solid` | `border`（`border-t`…），颜色另写 `border-line`；reset 已给每个元素 `border-style: solid` |
| `box-shadow: 0 0 0 2px var(--color-page)` | `ring-2 ring-page`；`inset 0 0 0 1px var(--color-accent)` 是 `inset-ring inset-ring-accent` |
| `outline` 的焦点圈 | 全页的 `:focus-visible` 已在 style.css；零件自己画焦点时 `outline-none focus-visible:…` |
| `grid-template-columns: minmax(0, 1fr) auto` | `grid-cols-[minmax(0,1fr)_auto]`（几何，任意值可以） |

排 class 的顺序：布局（`flex` `grid` `items-*` `gap-*`）→ 盒子（`w-*` `h-*` `p-*` `m-*` `border` `rounded-*`）→ 字（`text-*` `font-*` `leading-*` `truncate`）→ 颜色（`bg-*` `text-ink`…）→ 动效 → 变体（`hover:` `focus-visible:` `disabled:` `data-*:` `sm:`…）。`vp check --fix` 不排 class，靠手；变体表（`Record<Tone, string>`）把每种变体的 class 放一行。

零件里定下的写法，照着用：

| 要什么 | class |
|---|---|
| base-ui 的状态 `":is([data-popup-open])"`、`[data-highlighted]`、`[data-checked]`、`[data-disabled]` | `data-popup-open:` `data-highlighted:` `data-checked:` `data-disabled:` |
| 浮层的层（`z-index: 30`） | base-ui 的 Positioner 上直接写 `class="z-30 …"`，它把 `class` 传下去、把对象 `style` 和坐标合并 |
| `"@starting-style"` 的入场 | `starting:opacity-0 starting:scale-95` 加 `transition-[opacity,scale] duration-280 ease-out motion-reduce:transition-none` |
| 祖先按下时后代动 | 祖先 `group`，后代 `group-active:translate-px` |
| `":enabled:hover"`、`":enabled:active"` | `enabled:hover:` `enabled:active:` |
| 半透明的意思色（`color-mix` 和它的 `@supports` 回退） | 透明度修饰 `bg-bark-900/30`、`bg-current/13`、`decoration-current/45`；`--color-px-*` 那些预先混好的十六进制回退不再用 |
| 按数据定的行数 | `line-clamp-(--lines)` 加 `style={{ "--lines": n }}`；要压过调用方的 class 时加 `!` |
| `imageRendering: "pixelated"`、`transformOrigin: "50% 100%"` | `[image-rendering:pixelated]`、`origin-bottom` |
| 宽高相等 | `size-7`；`minWidth: "var(--anchor-width)"` 写 `min-w-(--anchor-width)`；视觉上隐藏写 `sr-only` |
| 脚本里建的 DOM 节点（Qr 的 svg、PxMarkdown 的提及和链接） | class 写成模块里的完整字符串常量再 `setAttribute("class", …)`，Tailwind 才扫得到 |

三条容易踩的优先级：

- **状态压过悬停。** Tailwind 把 `data-*:`、`aria-*:` 排在 `hover:` 后面。选中的一行在指针下仍要显示悬停色时，选中写成 `[&:where([aria-current=page])]:bg-selected`（`:where` 让它的优先级低一档），或者写组合的 `data-checked:hover:…`。
- **一侧盖住两侧。** Tailwind 总把单侧（`pr-9`）排在双侧（`px-2.5`）后面，所以零件写 `px-2.5`、调用方补 `pr-9` 能盖住；零件要是写成 `pl-2.5 pr-2.5`，调用方就盖不住了。
- **同一属性的两个值，谁赢看样式表，不看谁写在后面。** `bg-cream-200` 压过 `bg-bark-450`、`w-full` 压过 `w-36`、`text-sm` 压过 `text-lg`，跟 class 串里的先后无关。一个元素上两个条件的样式碰同一属性时，写成互斥的（`on ? "bg-selected" : "hover:bg-hover"`）；零件被调用方改的属性做成变体 prop（`TextInput` 的 `wide`、`text`，`Select` 的 `text`，`Markdown` 的 `size`）。

## 任意值什么时候可以

- **不可以**：颜色（`bg-[#…]`、`[color:#…]`，`no-hex-color`）、字号行高（`text-[13px]`、`leading-[17px]`）、留白（`p-[7px]`、`gap-[0.3rem]`）、圆角、阴影、层、时长、缓动——它们都有令牌，`design-tokens` 拦下，报出该用哪个 class。
- 例外：头像的颜色是数据（`ui/domain/cast.ts`、`Face.tsx`，lint 不查），`OrchestratorFace` 留着 `bg-[#cfe6f5]`。
- **可以**：令牌管不着的几何——宽高（`w-[37px]`、`h-[calc(100%-2px)]`、`max-w-[min(480px,92vw)]`）、定位（`top-[3px]`）、网格的列、`transition-[…]` 的属性表、`@min-[760px]:`；像素皮（`ui/pixel`、`farm`、`tree`）的尺寸是画的一部分，不查。
- 引用变量写 `p-(--gutter)`、`w-(--anchor-width)`（Tailwind v4 的括号写法）。

## 动态的值

按数据算出的值（百分比宽度、坐标、按 props 给的尺寸）写 `style`，或者写一个 CSS 变量再由 class 读它；不拼 class 名（`` `w-${n}` `` Tailwind 扫不到，生成不出 CSS）。

```tsx
<span class="inline-block shrink-0 rounded-full bg-leaf" style={{ width: `${size()}px`, height: `${size()}px` }} />
<div class="w-(--fill) transition-[width]" style={{ "--fill": `${percent()}%` }} />
```

只写死的 `style={{ "margin-left": "12px" }}` 由 `vibevalley/style-attrs` 拦下：它是一串该写成 class 的样式。多个变体用 `Record<Variant, string>`，class 名完整写在源码里，Tailwind 才扫得到。

## 零件收调用方的样式

- 零件收 `class?: JSX.ClassValue | undefined`（Solid 自己的类型，render prop 展开的 `{...p}` 才对得上），接在自己的 class 后面：`class={["inline-flex h-7 …", tones[props.tone], props.class]}`（Solid 的 `class` 收字符串、数组、`{ "x": on }`）；要一个字符串（交给 base-ui 的 `class`、拼给别的零件）时用 [`cx()`](apps/web/src/ui/cx.ts)。
- `cx` 只拼接，不判冲突：同一个属性的两个 utility（`px-2` 和 `px-4`）谁赢看 Tailwind 的样式表顺序，不看谁在后面。所以调用方的 `class` 只补零件没设的（位置、宽度、外边距、`grow`）；要改零件已经设了的（颜色、高度、内边距），给零件加一个变体 prop。
- 零件的不变量要压过调用方时（`Icon` 的对号永远是绿的）用重要修饰 `text-leaf!`，只在这里用。

## 验证

1. `vp check`：格式、`vibevalley/design-tokens`、`no-hex-color`、`style-attrs` 和类型。
2. 改了的零件开它的故事（`vp run --filter @vibevalley/web stories`），两种主题、几种宽度看一遍；故事要能构建（`web:check` 里的 `build:stories`）。
3. 截图对比：改之前截一份基准到 `apps/web/.screens-baseline/`（不进仓库），改完照 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 的页面分册用同一组页面和宽度截到 `apps/web/.screens/`，逐张比：

```bash
python3 - <<'EOF'
from PIL import Image, ImageChops
import os
a, b = "apps/web/.screens-baseline", "apps/web/.screens"
for name in sorted(os.listdir(a)):
    if os.path.exists(os.path.join(b, name)):
        box = ImageChops.difference(Image.open(os.path.join(a, name)).convert("RGB"), Image.open(os.path.join(b, name)).convert("RGB")).getbbox()
        print(name, "same" if box is None else box)
EOF
```

农场是动画，两次截图本来就不同；别的页有差别就打开两张图看，说清楚为什么或者改掉。

## 出错时先查什么

| 现象 | 先查 |
|---|---|
| 写了 class 不生效 | 令牌名是不是 style.css 里有的（Tailwind 自带的已经清掉）；class 名是不是拼出来的 |
| 调用方的 class 没盖住零件的 | 同一个属性两个 utility：给零件加变体，别指望 `cx` 的顺序 |
| 两个条件的 class 叠在一起时样子不对 | 它们碰了同一属性：一个只设了 `hover:`，另一个设了常态，两个都在；写成互斥的三元 |
| 深色主题里颜色不对 | 是不是写了 `bg-[var(--color-x)]` 或新颜色没进 `@theme inline`；跟主题换的颜色要读 `--wb-*` |
| 动画在减少动效时还在动 | 新的 `animate-*` 补 `motion-reduce:animate-none` |
