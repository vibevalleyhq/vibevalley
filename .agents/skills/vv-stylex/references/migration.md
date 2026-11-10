# 批量迁移与重构 StyleX

保留外观、行为、内容和资源，改变样式的表达方式。本篇记录把遗留工具类、组件局部 CSS 或机械转换产物重构为语义化 StyleX 的实施方法；当前常驻样式边界与 lint 门禁见[客户端](docs/subsystems/app.md)与[官网](docs/subsystems/site.md)。

## 1. 划定本轮范围

1. 按语法模式分组：静态字面量、常量／映射、条件组合、组件接口、关系选择器、动画与定位。
2. 区分组件自有样式与外部运行时所有者：Canvas 像素绘制、Motion 滚动／弹簧轨迹、浮层定位器坐标与消毒后富文本 HTML（`Markdown.css`、`PxMarkdown.css`）各自保持单一所有者。
3. 保存本轮改动前的源码与构建产物基准，标出工作区已有的其他改动，避免触碰并发修改文件。

## 2. 先试一种规则，再全仓应用

临时转换脚本放在沙箱或工作区外，不进入生产代码；机械改写按 [治理 skill](.agents/skills/vv-governance/SKILL.md) 执行。

1. 从实际基准 CSS 推导声明、默认值、选择器与顺序，不用旧类名猜样式。
2. 先在一个代表文件上运行，查看 diff、条件分支和生成的样式，再批量应用同一种规则。
3. 收集无法证明安全的表达式及原因，继续本轮其他文件，不被一个例外打断。
4. 全仓批次落下后统一跑类型／lint（`vp check`）与所属宿主生产编译（`build`、`build:stories`、`site:build`）。

转换与重构应守住这些边界：

- 只解析可证明静态的常量、模板片段和映射。应跟踪作用域、导入和重导出；会逃逸、可变或有副作用的值不做快照替换。
- 条件和映射的组合应有枚举上限。属性只依赖一个条件时拆成语义化变体；依赖多个条件时整体保留语义，不保留 `recipeStyles`、`variantStyles` 或 `Variant1Case1` 等机械编号。
- 不把任意函数内联到调用处：闭包作用域、调用次数、短路求值和 Solid 响应式追踪可能改变。
- 核实简写、长属性、逻辑边、继承、伪类优先级和 CSS 变量依赖。
- 颜色统一收敛到宿主 `style.css` / `global.css` 的命名语义令牌；旧浏览器的透明色回退保留完整 8 位 alpha 令牌，`@supports` 分支沿用原条件和 `color-mix` 表达式。`vibevalley/no-hex-color` 同时检查 StyleX 规则与 JSX 内联 `style`。
- 原生 DOM、Base UI、应用组件和自定义 `render` 函数统一通过 `stylex.attrs`、`styleProps` 或 `domAttrs` 挂载样式；`vibevalley/stylex-only` 禁止在 JSX 上直接写 `class`、`className` 或 `classList`。

## 3. 整批改接口与层序

1. 组件样式入口统一为 `styles?: stylex.StyleXStyles`，明确调用方可覆盖的属性与固定不变量。
2. 一次迁移所有调用方，包括多行 JSX、别名、属性展开与 Base UI 包装节点。
3. 动态数值、CSS 自定义属性或外部定位通过动态 StyleX 规则或 `styleProps(styles, nativeStyle)` 传到底层 DOM。
4. 保持 `@layer theme, base, components, stylex` 顺序稳定：不保留空的 `utilities` 层，不在组件内散落导入未分层的 `.css` 文件。

## 4. 验证门禁

| 检查项 | 命令 |
|---|---|
| 格式、类型与 StyleX 门禁规则 | `vp check` |
| lint 插件规则单测 | `vp test run scripts/oxlint-plugin.test.ts` |
| 工作台与故事生产构建 | `vp run --filter @vibevalley/web build && vp run --filter @vibevalley/web build:stories` |
| 官网生产构建与静态验收 | `vp run site:check && vp run site:build` |
| 真程序与宿主端到端验收 | 按 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 执行对应入口 |
