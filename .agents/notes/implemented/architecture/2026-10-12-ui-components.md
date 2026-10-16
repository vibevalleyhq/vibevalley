# Agent Note: 农场的通用 UI 组件

Status: implemented

> 实现已被取代：网页和这些组件随 [网页退役](../simplification/2026-10-14-retire-the-web-page.md) 删掉了；同样的分法现在是 Flutter 的像素控件（`app/lib/ui/kit/`，[README](../../../../app/lib/ui/kit/README.md)）：通用控件集中在一处，只收参数，不读农场的状态、不跑命令，按钮、字段、输入框、对话框、芯片输入和键值编辑都有对应。下面是网页版当时的决策。

## Problem

配置页的 form.tsx、工作台的 styles.ts 和农场弹窗分别维护按钮与输入框样式。频道弹窗自己处理遮罩和 Escape，没有统一的焦点约束与恢复；字段标签与控件的关联也不一致。

## Decision

页面内部的基础组件集中在 `web/src/components/ui/`。Base UI 提供按钮、字段、输入框、弹窗、选择器和开关的交互基础，Tailwind 与农场主题提供外观。组件只接收 props，不读 core，不运行农场命令。

Button 统一主次、危险和强调操作，工作台与配置页、农场面板复用它；链接复用同一份类。Input 和 Textarea 保留原生事件接口，TextInput 和 TextArea 提供配置页使用的字符串回调与建议项。Field 通过 Base UI 关联标签、说明和控件。频道 Dialog 由 Base UI 管理模态焦点、Escape 和关闭后恢复焦点。

芯片输入、键值编辑放在 `components/forms/`。农场专用的固定尺寸弹窗、精力瓶、通知业务接线保留在原业务层；不为未统一的控件预建空包装，也不发布独立 package。

## Alternatives considered

**只搬动 form.tsx。** 按钮仍有多套，频道弹窗的交互问题也还在，因此同时合并重复实现。

**一次包装 Base UI 的所有组件。** 没有实际调用的包装会增加维护面；先覆盖已有重复与明确需要的交互。

## Consequences

公共按钮外观和键盘焦点统一；表单可以通过标签找到控件，频道弹窗不会把 Tab 焦点放到背景。具体频道、项目和帮工的行为仍在业务组件。全局像素皮肤仍在，公共控件的阴影与按下位移显式覆盖它，避免被旧规则改写。
