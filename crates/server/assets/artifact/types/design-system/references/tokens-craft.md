# 色彩、字阶与组件规范工艺（design-system / tokens-craft）

## 1. 明暗双生而非简单反相

- 深色模式的卡片/面板面（`panel`）应比主底面（`surface`）略亮（通过明度抬升表达层级，而非靠黑阴影）。
- 品牌主色与状态色在深色背景下适当提高明度、微降饱和度，避免高饱和荧光色在暗底上产生视觉光晕。
- 语义分组统一按 `surface`、`text`、`brand`、`status`、`border` 归类，便于色板视图按组审阅。

## 2. 最小完备与反膨胀

- 间距与圆角坚持小而清晰的阶梯（4–6 档），避免同时存在 `13px`、`14px`、`15px` 等肉眼难以分辨的重复档位。
- 组件规范必须写清 `states`（特别是 `focus-visible`、`disabled` 与 `error`）以及具体的 `do`/`dont` 边界。

## 3. 交付前核对清单

- [ ] `ink`/`surface` 与主按钮前背景在 `light` 与 `dark` 两套主题下均通过 WCAG AA（≥ 4.5:1）。
- [ ] `structure/tokens.json` 中所有 `{alias}` 引用均解析到已定义令牌，无悬空别名。
- [ ] 每个 `structure/components/*.json` 均已登记在 `manifest.json`，且仅引用语义令牌、不写死原始色值。
- [ ] 修改既有品牌核心令牌均通过 `artifact_suggestion` 提议并经用户确认。
