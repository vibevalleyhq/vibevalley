# StyleX API 的选择

只在任务用到对应能力时读本篇。基础写法见 [skill 入口](.agents/skills/vv-stylex/SKILL.md)；属性与 API 是否可用，应核对安装包的 `stylex.d.ts`、`StyleXTypes.d.ts` 和实际生产编译，不以别的版本的示例代替。

## 共享常量

`defineConsts()` 是编译期常量，不产生可切换的主题变量。可共享媒体查询字符串、静态尺寸以及已有 CSS 变量的引用；引用 `var(--color-...)` 并不会冻结该 CSS 变量的运行时值。

官网的实际用法在 [tokens.stylex.ts](apps/site/src/styles/tokens.stylex.ts)。共享断点同样放在专用 `.stylex.ts` 文件中：

```tsx
import * as stylex from "@stylexjs/stylex";

export const queries = stylex.defineConsts({
  split: "@media (min-width: 768px)",
});
```

消费方在属性内写 `[queries.split]`，并提供 `default`。断点应来自要保留的布局契约，不从示例任意挑值。容器查询与视口查询观察的对象不同，不应互换。

## 变量组与主题

只有新模块确实需要独立的可覆盖变量契约时才用 `defineVars()`。专用文件只导出 StyleX 可识别的定义，不夹带业务函数或普通运行时值。

- `const colors = stylex.defineVars(...)` 返回变量组；样式读取 `colors.ink` 这类变量引用。
- `const darkTheme = stylex.createTheme(colors, overrides)` 返回作用于这个变量组的主题类；可在其他文件定义，应用到 DOM 子树。
- 已有 `data-theme` 和宿主 CSS 变量足以表达的主题，不应复制一套 `defineVars` 和 `createTheme`。
- `createTheme` 返回值可传给 `stylex.props()`；宿主适配器若只收窄的 `StyleXStyles`，应先明确主题参数类型，不能用断言强塞。

类型应按用途区分：

| 类型 | 含义 |
|---|---|
| `typeof colors` | 某个具体变量组的类型 |
| `VarGroup<Tokens>` | 变量组的通用契约，泛型描述 token 形状，不描述主题类 |
| `Theme<typeof colors>` | 对具体变量组创建的主题类 |
| `typeof darkTheme` | 某个具体主题结果的类型 |
| `StyleXStyles` | 可组合的静态／动态组件样式 |

不应把 `VarGroup<typeof colors>` 当成 `darkTheme` 的类型，也不把变量组本身传给 `props()` 当作样式。

## 收窄组件接口

`StyleXStyles<{ color?: string; backgroundColor?: string }>` 可表达只接受颜色相关样式的接口。`StyleXStylesWithout<...>` 按属性键排除样式；若要禁止布局覆盖，应同时考虑长属性、逻辑属性和简写，不能只排除 `margin` 就声称所有外边距都不能传入。

宜先用穷尽的语义变体（如 Button 的 `Tone`），确有组合需求时再开放 `styles`。不要公开 class 字符串作为调用方选择主题或状态的接口。

## 关系选择器

| API | 观察对象 |
|---|---|
| `when.ancestor()` | 有 marker 的祖先，不限于直接父元素 |
| `when.descendant()` | 有 marker 的后代 |
| `when.anySibling()` | 有 marker 的兄弟元素 |
| `when.siblingBefore()` | 位于当前元素之前的有 marker 的兄弟 |
| `when.siblingAfter()` | 位于当前元素之后的有 marker 的兄弟 |

无自定义 marker 时，观察对象应施加 `defaultMarker()`。多个关系或嵌套组件宜用各自的 `defineMarker()`，避免不相关的祖先状态相互影响。自定义 marker 应命名导出，并经 `props()` 或静态 `attrs()` 施加到正确的 DOM 元素，不能只定义却不使用。

## 动画和浏览器能力

| API | 使用边界 |
|---|---|
| `keyframes()` | 定义自有关键帧；以 `animationName` 引用，时长、曲线、次数、方向、填充和停法分别明确 |
| `firstThatWorks(a, b, ...)` | 同一属性的候选值回退，优先候选在前；不等价于任意 `@supports` 业务分支 |
| `viewTransitionClass()` | 定义 group、imagePair、old、new 的 View Transition 样式；浏览器生命周期另行接线，不带入 React 组件 |
| `positionTry()` | 定义 CSS anchor positioning 的回退规则，以 `positionTryFallbacks` 引用；不取代已有浮层坐标、碰撞和焦点管理 |

动画迁移应保留 reduced-motion 下的最终可见状态，不能只把持续时间设为零却留下起始透明度或位移。测过静止截图，不等于测过动画顺序、关闭动画和资源清理。

## 查文档

- [定义样式](https://stylexjs.com/docs/learn/styling-ui/defining-styles/)
- [props](https://stylexjs.com/docs/api/javascript/props/)、[attrs](https://stylexjs.com/docs/api/javascript/attrs/)
- [defineConsts](https://stylexjs.com/docs/api/javascript/defineConsts/)、[defineVars](https://stylexjs.com/docs/api/javascript/defineVars/)、[createTheme](https://stylexjs.com/docs/api/javascript/createTheme/)
- [关系选择器](https://stylexjs.com/docs/learn/recipes/context-driven-styles/)
- [API 总表](https://stylexjs.com/docs/api/)
