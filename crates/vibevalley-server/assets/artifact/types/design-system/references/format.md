# `"project/tokens.json"` 语法规范（design-system / format）

```json
{
  "themes": ["light", "dark"],
  "defaultTheme": "light",
  "color": [
    { "id": "surface", "group": "surface", "value": { "light": "#fcfcfb", "dark": "#151413" }, "note": "页面主背景" },
    { "id": "ink", "group": "text", "value": { "light": "#1c1917", "dark": "#ecebe8" }, "note": "主正文" },
    { "id": "accent", "group": "brand", "value": { "light": "#4d7a2a", "dark": "#7fae4f" }, "note": "主强调色" }
  ],
  "type": {
    "families": [{ "id": "sans", "value": "system-ui, sans-serif" }],
    "scale": [{ "id": "md", "value": "15px" }, { "id": "xl", "value": "28px" }],
    "styles": [{ "id": "heading", "family": "{sans}", "size": "{xl}", "weight": 700, "lineHeight": 1.2 }]
  },
  "space": [{ "id": "4", "value": "16px" }],
  "radius": [{ "id": "md", "value": "8px" }]
}
```
编译产物：`--color-surface`（同时输出 `--surface`）、`--font-sans`、`--text-xl`、`.type-heading`、`--space-4`、`--radius-md`。
