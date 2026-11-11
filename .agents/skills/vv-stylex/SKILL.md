---
name: vv-stylex
description: 在 VibeValley 的 Solid 2 页面、官网和故事查看器里写、改、评审原生 StyleX 样式；设计组件 StyleXStyles 接口与 .stylex.ts 常量模块；排查动态变量丢失、样式合并、伪类、主题、marker、关键帧动画和 CSS 层顺序。用在：新增或修改界面样式、组件接收外部样式、StyleX 编译或门禁报错、用户说「StyleX 写法」「整理样式」。
---

# 写 StyleX

样式统一用 `stylex.create()` 定义，共享常量与关系 marker 放在专用 `.stylex.ts` 模块，组件之间传 `StyleXStyles`，DOM 属性由宿主适配器生成。VibeValley 用 Solid 2，不照搬 React 的 `className`、`ReactNode` 或 `ViewTransition` 示例，也不写工具类字符串或编译期残留。

## 先读哪里

1. 读 [界面怎么做](docs/style/design.md)，从宿主令牌与 `tokens.stylex.ts` 取值，不另造色板。
2. 找同一宿主的样式适配器和相邻组件，确认样式、原生属性、定位各归谁管。
3. 需要变量组、主题或高级 API 时读 [API 分册](.agents/skills/vv-stylex/references/api.md)；大批量重构既有样式或收敛历史残留时读 [重构分册](.agents/skills/vv-stylex/references/migration.md)。

| 宿主或边界 | 读哪里 |
|---|---|
| 工作台、农场、记忆树 | [工作台令牌](apps/web/src/ui/tokens.stylex.ts)、[主题样式表](apps/web/src/style.css)、[styleProps / positionerAttrs](apps/web/src/ui/positioner.ts)、[Button](apps/web/src/ui/Button.tsx) |
| 官网 | [官网令牌](apps/site/src/ui/tokens.stylex.ts)、[全局样式表](apps/site/src/ui/global.css)、[domAttrs](apps/site/src/ui/ui.tsx)、[官网约定](apps/site/README.md) |
| 故事查看器 | [包约定](packages/stories/README.md)、[查看器](packages/stories/src/StoriesApp.tsx)；只用宿主公开的 CSS 属性，不引用私有 `--wb-*` 色板 |
| 无样式组件 | [Base UI](packages/base-ui/README.md) 保持无样式；外观放在应用的 UI 层 |

API 以 catalog 中的版本、安装包的类型和生产编译器为准。类型通过不等于 StyleX 提取成功，新增写法应经过所属宿主的生产编译。

## 1. 定义和组合

- 应用长属性或单值简写；需要独立覆盖的一侧单独定义，避免 `padding`、`paddingInline`、`paddingRight` 互相清除。
- 用 `null` 清除参与组合的属性，不用空字符串。它清除 StyleX 的规则，不保证最终计算值为空：浏览器默认值、继承和其他 CSS 仍可能生效。
- 长度用明确的 `rem` 或 `px`，字号、行高、圆角、阴影和动效从 `tokens.stylex.ts` 或宿主 CSS 变量取值；胶囊圆角写 `"9999px"`（`radii.pill`）。不写 `--tw-*`、`0 0 transparent` 空阴影槽、`repeat(1, minmax(0, 1fr))` 或全量过渡属性列表。
- 按「基础 → 变体 → 调用方」组合，冲突属性最后一个样式胜出。组件固定的语义色等不变量可放最后，但应明确接口不允许覆盖什么。
- 条件用 `flag && styles.active` 或三元表达式；映射用 `Record<Variant, stylex.StyleXStyles>`。
- 样式键名按职责起名（如 `card`、`header`、`warningBanner`），不用元素加序号的机械名字。

工作台组件的接线方式：

```tsx
import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";

import { styleProps } from "./positioner";
import { colors, radii } from "./tokens.stylex";

const styles = stylex.create({
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    backgroundColor: colors.page,
    borderRadius: radii.lg,
  },
});

function Card(props: { children: JSX.Element; styles?: stylex.StyleXStyles }) {
  return <section {...styleProps([styles.card, props.styles])}>{props.children}</section>;
}
```

应在 JSX 的响应式求值中读 `props` 并组合样式，不要在组件初始化时算出一个快照，导致变体或尺寸不再更新。

## 2. DOM 属性和动态值

`stylex.props()` 返回 `className` 和对象 `style`。Solid 的接线应把 `className` 映射为 `class`，保留对象样式和其余属性；工作台复用 `styleProps`，官网复用 `domAttrs`，不要每个组件再写一份适配器。

`stylex.attrs()` 返回 `class` 和序列化的样式字符串，可用于不含运行时变量、不需要合并原生对象样式的静态 DOM。以下边界应走 `props()` 的对象样式路径：

- 组件接收外部 `styles`，调用方可能传动态样式。
- 动态样式函数产生 CSS 自定义属性。
- Base UI 浮层同时写入坐标、锚点尺寸或其他定位变量。
- 组件确实需要合并原生 `style` 对象。

```tsx
const styles = stylex.create({
  sized: (width: number) => ({ maxWidth: width }),
});

function Sized(props: { width: number; children: JSX.Element }) {
  return <div {...styleProps(styles.sized(props.width))}>{props.children}</div>;
}
```

不应在样式展开之后再写 `class`、`className`、`classList` 或另一个 `style`（`vibevalley/stylex-only` 直接拦截）。外部定位、宿主几何和协作编辑器确实需要原生样式时，应在一个已定义优先级的边界内合并对象，并保留 StyleX 变量；不要拼接 CSS 字符串，也不要写 `!important`。

`stylex.attrs()` 的字符串序列化可能改变动态变量名的大小写，例如 `--x-marginLeft`，因此不能以「位置暂时看起来对」代替变量保留检查。原生 `style` 字符串与动态 StyleX 样式不应同时进入组合接口；必须保留原生传递能力时，照 Button 的联合类型区分两种模式。

## 3. 状态、查询和伪元素

伪类和 `@media`、`@supports`、`@container` 放在属性值内；每层条件对象应有 `default`，无默认规则时写 `null`。

```tsx
import { colors, media } from "./tokens.stylex";

const styles = stylex.create({
  control: {
    color: {
      default: colors.muted,
      [media.hover]: {
        default: null,
        ":hover": colors.ink,
      },
    },
    opacity: { default: null, ":disabled": 0.5 },
    "::placeholder": { color: colors.faint },
  },
});
```

- `:hover`、`:focus-visible`、`:disabled` 是伪类；不要写成命名空间顶层的选择器块。
- `::placeholder`、`::selection`、`::backdrop` 等伪元素按 StyleX 支持的位置书写；不要把伪类与伪元素的写法混为一谈。
- `:first-child`、`:nth-child` 是结构伪类，不是伪元素。业务已有首项、选中项等信息时，宜用 JS 变体；纯 DOM 结构关系可保留结构选择器。
- 新的可交互、有语义内容宜用真实元素，不用 `::before`、`::after` 承载。
- hover、选中、禁用、焦点同时成立时，应检查真实优先级；不能只分别看每个状态。

## 4. 常量、令牌和主题

| 需要什么 | 选择 |
|---|---|
| 宿主已有的颜色、字、圆角、阴影、动效、断点 | 导入 `tokens.stylex.ts` 的 `defineConsts` 常量或直接引用宿主 `var(--...)` |
| 多文件共享、不会在运行时覆盖的断点或静态值 | `stylex.defineConsts()` |
| 确有独立主题或运行时覆盖需求的新变量组 | `stylex.defineVars()` |
| 覆盖一个已有变量组 | `stylex.createTheme()` |

`defineConsts`、`defineVars` 应放在专用 `.stylex.ts` 文件中，用命名导出；不混放组件、运行时代码或普通业务导出。跨文件传给 `stylex.create()` 的静态值应来自编译器支持的 StyleX 导出，不导入普通常量冒充可静态求值的令牌。

当前浅色/深色主题由宿主 `style.css` 的 `[data-theme]` 管理，不应把整套 CSS 色板复制成另一套 `defineVars`。

## 5. 关系、动画和定位

- 关系样式用 `stylex.when.ancestor`、`descendant`、`anySibling`、`siblingBefore`、`siblingAfter`。观察对象用 marker 标识；跨模块的自定义 marker 用专用 `.stylex.ts` 文件命名导出，见 [频道 marker](apps/web/src/features/channel/views/message.stylex.ts)。
- `ancestor` 不等于直接父元素，兄弟关系也有方向。应核实 marker 覆盖范围、嵌套行、hover 与键盘焦点。
- 组件自有动画统一用 `stylex.keyframes()` 定义，再用 `animationName`、`animationDuration`、`animationTimingFunction`、`animationFillMode` 引用（相同关键帧对象由编译器自动按哈希去重），并显式保留 reduced-motion 停法；不让 CSS 和 Motion、Pixi 或定位器同时写同一个 transform。
- `firstThatWorks()` 用于同一属性的浏览器回退；候选按优先顺序写。保留 `@supports` 条件和默认值，不只留下现代浏览器分支。
- `positionTry()` 是 CSS anchor positioning 的回退规则，不是 Base UI 浮层适配器。采用前应确认目标浏览器支持、滚动定位、键盘焦点和关闭行为。
- `viewTransitionClass()` 定义 View Transition API 的样式，不提供 React 组件。Solid 中不导入 React 的 `ViewTransition`；浏览器 API 的生命周期与不支持时的退路应另行设计。

## 6. 类型与门禁

组件样式接口用 `StyleXStyles`，需要约束时用属性子集或 `StyleXStylesWithout`，不用不接受动态样式的 `StaticStyles` 代替。StyleX 样式参数叫 `styles`；原生内联对象叫 `style`，不要把两者混为一种类型。

`VarGroup` 描述变量组，`Theme` 描述 `createTheme()` 的结果。不要把 `VarGroup<typeof colors>` 当成可传给 `props()` 的主题；具体类型见 API 分册。

1. 跑 `vp check`（涵盖 `vibevalley/stylex-only`、`vibevalley/no-hex-color`、`vibevalley/design-tokens`）与所属宿主生产编译；以实际编译结果确认静态表达式、marker 和查询可用。
2. 组件改动应同步其故事，覆盖相关主题、宽度和组合状态；验证动态变量、DOM identity、键盘和浮层边界，不为每个静态声明新增一套浏览器测试。
3. 真程序验收走 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md)，不在本 skill 另造流程。

## 出错时先查什么

| 现象 | 先查 |
|---|---|
| `Unsupported expression` 或导出无法解析 | 是否导入普通常量、跨文件导入了未包装的 `keyframes`、用了编译器无法求值的表达式，或混合了令牌文件的导出 |
| marker 要求 named export | 是否在专用 `.stylex.ts` 文件命名导出；不要绕过编译器换成全局字符串选择器 |
| 动态宽度、缩进、坐标不生效 | 是否用了序列化 `attrs()`、变量名被改写、原生 `style` 覆盖了变量对象 |
| 覆盖一侧后另一侧消失 | 简写与长属性、逻辑边与物理边是否冲突 |
| 单个状态对、组合状态错 | 条件样式是否整项覆盖了含 hover/focus 的属性；禁用或选中选择器优先级是否改变 |
| 整页字体、边框或背景突变 | 生产 CSS 的首次 `@layer theme, base, components, stylex` 声明顺序 |

来源：[StyleX 官方文档](https://stylexjs.com/docs/learn/)、[API](https://stylexjs.com/docs/api/)、[源码](https://github.com/facebook/stylex)。
