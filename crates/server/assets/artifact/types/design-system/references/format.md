# 令牌与组件文件规范（design-system / format）

## 1. `structure/tokens.json`

```json
{
  "themes": ["light", "dark"],
  "defaultTheme": "light",
  "color": [
    { "id": "surface", "group": "surface", "value": { "light": "#fcfcfb", "dark": "#151413" }, "note": "页面主底色" },
    { "id": "panel", "group": "surface", "value": { "light": "#f4f3ef", "dark": "#1f1d1b" }, "note": "卡片与侧栏底色" },
    { "id": "ink", "group": "text", "value": { "light": "#1c1917", "dark": "#ecebe8" }, "note": "主正文" },
    { "id": "muted", "group": "text", "value": { "light": "#6b655e", "dark": "#a69f95" }, "note": "次级说明" },
    { "id": "accent", "group": "brand", "value": { "light": "#4d7a2a", "dark": "#7fae4f" }, "note": "主品牌强调色" },
    { "id": "danger", "group": "status", "value": { "light": "#b83a2d", "dark": "#e06c5f" }, "note": "错误与危险态" }
  ],
  "type": {
    "families": [
      { "id": "sans", "value": "system-ui, -apple-system, sans-serif" },
      { "id": "mono", "value": "ui-monospace, SFMono-Regular, monospace" }
    ],
    "scale": [
      { "id": "sm", "value": "13px" },
      { "id": "md", "value": "15px" },
      { "id": "xl", "value": "28px" }
    ],
    "styles": [
      { "id": "heading", "family": "{sans}", "size": "{xl}", "weight": 700, "lineHeight": 1.2 },
      { "id": "body", "family": "{sans}", "size": "{md}", "weight": 400, "lineHeight": 1.55 }
    ]
  },
  "space": [
    { "id": "2", "value": "8px" },
    { "id": "4", "value": "16px" },
    { "id": "6", "value": "24px" }
  ],
  "radius": [
    { "id": "sm", "value": "4px" },
    { "id": "md", "value": "8px" },
    { "id": "full", "value": "9999px" }
  ],
  "shadow": [
    { "id": "sm", "value": { "light": "0 1px 2px rgba(28,25,23,0.06)", "dark": "0 1px 3px rgba(0,0,0,0.45)" } }
  ]
}
```

## 2. 单组件规范 `structure/components/<name>.json`

```json
{
  "id": "button",
  "title": "按钮 Button",
  "summary": "用于触发明确动作；每个视图仅保留 1 个 primary 主操作。",
  "variants": [
    { "id": "primary", "bg": "{color.accent}", "fg": "{color.surface}", "radius": "{radius.md}", "paddingX": "{space.4}" },
    { "id": "ghost", "bg": "transparent", "fg": "{color.ink}", "radius": "{radius.md}", "paddingX": "{space.2}" }
  ],
  "states": ["default", "hover", "active", "focus-visible", "disabled", "loading"],
  "guidelines": {
    "do": ["动词开头写明结果（如「保存更改」）"],
    "dont": ["在同一操作栏并列两个 primary 按钮"]
  }
}
```

## 3. 同步约定

- 新增组件时，创建 `structure/components/<id>.json` 并同步将路径写入 `manifest.json` 的 `components` 列表。
- 修改令牌值时保持令牌 `id` 稳定，避免破坏引用它的 `design` / `slides` / `prototype` 作品。
