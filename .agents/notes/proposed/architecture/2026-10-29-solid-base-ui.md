# Agent Note: 自己的无样式组件库 @vibevalley/base-ui

Status: proposed

## Problem

页面里会动的部件各写各的：
- 32 处手写 `aria-expanded`，29 处 `aria-pressed`，10 处手写点外面关掉（`useClickAway`）。
- 4 个手写的菜单，5 个列表框，4 处标签页，8 个不是 `<dialog>` 的浮层。
- 提示（`Tip`）靠 CSS 悬停，没有延迟，碰到页面边会被切掉。

每个都要自己管键盘、焦点、ARIA 和开关状态，axe 和页面测试一处处兜。Base UI（MUI 团队的无样式组件）把这些收进一套部件，样式留给用它的一方。Solid 这边做这类组件的现成库（Kobalte、Ark UI、Corvu）都要 Solid 1，我们在 Solid 2（rc），装不上。

## Proposal

新包 `packages/base-ui`（`@vibevalley/base-ui`），照 Base UI 的样子写 Solid 2 版：

- **只管行为**：键盘、焦点、ARIA、开关和选中的状态、浮层的定位和点外面关掉。不带样式、不带话、不带图标，两张皮（工作台、像素皮）都能用。
- **部件拼成组件**：`Dialog.Root`、`Dialog.Trigger`、`Dialog.Popup`、`Dialog.Title`……每个部件出一个元素，多给的属性（`class`、`data-testid`、事件）原样落到元素上。
- **状态写成 data 属性**，和 Base UI 同名：
  - 开合：`data-open`、`data-closed`、触发它的那个上面的 `data-popup-open`。
  - 选中和按下：`data-checked`、`data-unchecked`、`data-pressed`、`data-selected`、`data-highlighted`。
  - 禁用和朝向：`data-disabled`、`data-orientation`。
  - 浮层的位置：`data-side`、`data-align`。

  样式按它们写，页面测试也按它们断言（docs/subsystems/foundation.md 的页面测试规矩）。
- **受控和不受控都行**：`open`/`defaultOpen`/`onOpenChange`，`value`/`defaultValue`/`onValueChange`，照 Base UI。
- **第一批组件**：
  - Collapsible、Switch、Checkbox、Toggle、ToggleGroup、Tabs。
  - Dialog：用原生 `<dialog>`，顶层、焦点关在里面、后面不可点，和现在的 `createModal` 一样。
  - Popover、Tooltip、Menu、Select。
- **共用的内部件**：
  - `createControllable`：受控和不受控的值。
  - `createDismiss`：点外面和 Esc 关，按层叠，套着的浮层只关最上面的。
  - `createComposite`：方向键、Home、End，可循环、可按朝向；用打字跳到某一项（typeahead）。
  - `createAnchored`：浮层贴着触发它的那个，碰边翻面、挤回来，用 `@floating-ui/dom`，它不依赖框架。
- **测试**：每个组件在 jsdom 里渲染、点、按键，断言 ARIA、焦点和 data 属性（`vp test`，包自己的 `test/`）。

迁移：`apps/web/src/ui` 里现有的组件改成这一层加上田间工作台的样式，接口尽量不变，页面不用跟着改：
- `Segmented` 改用 ToggleGroup，`layout.tsx` 的 `Toggle` 改用 Switch。
- `Dialog` 改用 Dialog，`Tip`、`Hint` 改用 Tooltip。
- 工单的「显示」菜单改用 Popover。
- 聊天、档案、图鉴、管家的标签页改用 Tabs。
- 消息工具条的「更多」改用 Menu。

改完一处，跑 e2e 和 axe 确认没退。

## Alternatives considered

- **等 Kobalte 或 Ark UI 出 Solid 2 版**：时间不由我们定。Solid 2 改了 effect 和资源的写法，它们要大改。
- **照搬 Base UI 的 React 源码**：React 的渲染、ref 和 effect 模型和 Solid 2 差得远，逐行翻译反而难读。照它的部件划分、属性名和 data 属性，用 Solid 2 的写法重写。
- **继续在 `ui/` 里各写各的**：就是现在的问题。

## Acceptance criteria

- `@vibevalley/base-ui` 有上面的组件，每个有 jsdom 测试，覆盖键盘、焦点、ARIA、data 属性、受控和不受控。
- `apps/web` 的 `Segmented`、`Toggle`、`Dialog`、`Tip`、`Hint`、显示菜单、几处标签页和消息的「更多」菜单用上它。
- `vp check`、`server:check`、`web:check`、e2e（含 axe 两套主题）、`desktop:test` 全过。
- 包的 README 写清每个组件的部件、属性和 data 属性。

## Risks

- Solid 2 还是 rc，响应式的细节可能变；组件只用 `createSignal`、`createMemo`、`createEffect`、`onCleanup`、`createContext` 这些核心的写法，变了也好改。
- 退场动画这一版不做：浮层关了就卸载，进场靠 CSS（`animate-pop-in`）。Base UI 的 `data-ending-style` 以后要时再加。
- 像素皮的组件（`ui/pixel`）这一轮不迁，先在工作台上把这层用稳。
