# design-system：常驻设计体系与令牌契约

`design-system`（`body = "store"`，`artifactType: "design-system"`）定义一套跨作品复用的色彩、字阶、间距、圆角与组件预览。设为农场默认（`isDefault: true`）后，新建或渲染的 `slides`、`dashboard`、`design` 都会自动注入它编译出的明暗双主题 CSS 变量！

## 条目结构

- `"project/design-system.json"`（JSON）：体系名称、版本与组件预览注册表：
  ```json
  { "name": "Fieldcraft DS", "version": "1.0.0", "components": [{ "id": "Button", "title": "按钮", "preview": "project/components/Button/preview.html" }] }
  ```
- `"project/tokens.json"`（JSON）：双主题令牌源，自动编译为 `:root`、`[data-theme="light"]`、`[data-theme="dark"]` 的 `--color-*`、`--font-*`、`--text-*`、`--space-*`、`--radius-*` 及 `.type-*` 排版类。
- `project/README.md`（text）：设计原则、用色比例与禁用事项说明。
- `project/components/<Name>/preview.html`（text）：使用 `var(--color-*)`、`var(--radius-*)` 编写的真实组件状态预览。

## 令牌品质铁律

- 正文色 `ink` 与主背景 `surface` 在浅色与深色两套主题下的 WCAG 对比度均须 ≥ 4.5:1（工作台色板页会实时计算并标出对比度徽章）。
- 支持 `{alias}` 别名引用（如 `"family": "{sans}"`），避免硬编码重复字号与色值。

按需延伸阅读：`artifact_type_read({ type: "design-system", reference: "format" | "tokens-craft" })`。
