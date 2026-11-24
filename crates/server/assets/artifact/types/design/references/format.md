# 画板文件与交互属性契约（design / format）

## 1. 单画板 `structure/frames/<id>.json`

```json
{
  "id": "desktop-checkout",
  "name": "桌面端结账",
  "viewport": { "x": 0, "y": 0, "w": 1280, "h": 800 },
  "theme": "light",
  "props": [
    { "name": "density", "label": "密度", "type": "select", "options": ["comfortable", "compact"], "value": "comfortable" },
    { "name": "showCoupon", "label": "显示优惠码", "type": "boolean", "value": true },
    { "name": "ctaLabel", "label": "主按钮文案", "type": "text", "value": "确认并支付" }
  ],
  "root": {
    "id": "root",
    "kind": "stack",
    "direction": "horizontal",
    "gap": "{space.6}",
    "padding": "{space.8}",
    "fill": "{color.surface}",
    "children": [
      {
        "id": "summary_card",
        "kind": "card",
        "radius": "{radius.md}",
        "fill": "{color.panel}",
        "children": [
          { "id": "hero_img", "kind": "image", "src": "asset/hero-product.png", "w": 320, "h": 180 },
          { "id": "pay_btn", "kind": "button", "variant": "primary", "text": "{props.ctaLabel}" }
        ]
      }
    ]
  }
}
```

## 2. 节点与令牌引用规范

- 常用 `kind`：`stack`（`horizontal`/`vertical`）、`grid`、`card`、`text`、`button`、`input`、`badge`、`image`（`src: "asset/..."`）、`table`、`divider`、`icon`。
- 令牌绑定：以 `{color.<id>}`、`{space.<id>}`、`{radius.<id>}`、`{type.<styleId>}` 引用关联 `design-system` 中的语义令牌，明暗主题切换自动生效。
- 属性控制杆（`props`）：支持 `select`、`boolean`、`number`、`text`、`color` 五类控件；节点内通过 `{props.<name>}` 或条件字段 `visibleWhen: "showCoupon"` 绑定响应。

## 3. 并发画板排布

- 新增对比画板时，将 `viewport.x` 摆放在已有最右画板的 `x + w + 80` 处，避免画板重叠；在同一协作提交中把新文件路径加入 `manifest.json` 的 `frames` 数组。
- 局部调整样式时只修改目标节点 ID 对应的属性，不重排未变动节点的 ID。
