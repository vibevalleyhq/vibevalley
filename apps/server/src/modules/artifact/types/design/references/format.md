# `.dc.html` 与 `DCLogic` 契约（design / format）

- 事件触发：元素加 `data-act="toggleTab" data-arg="billing"`，点击时自动调用 `DCLogic.act(state, { type: "toggleTab", arg: "billing" }, props)`。
- 状态派生：`DCLogic.derive(state, props)` 返回键值对象，自动填充 `[data-bind="key"]` 文本并控制 `[data-if="key"]` 显隐。
- 默认令牌继承：若农场存在默认 `design-system`，所有画板自动注入 `--color-*`、`--font-*`、`--space-*`、`--radius-*` 变量。
