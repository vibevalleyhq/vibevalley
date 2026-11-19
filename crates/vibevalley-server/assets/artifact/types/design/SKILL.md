# design：多画板界面与视觉画布

`design`（`body = "store"`，`artifactType: "design"`）在无限画布上并排摆放多张桌面/移动/海报画板（`.dc.html`），支持纯状态交互（`DCLogic`）与右侧属性调节面板（`data-props`）实时调参回写。

## 条目结构

- `"project/canvas.json"`（JSON）：画板清单与画布排布坐标：
  ```json
  {
    "title": "结账流程多端设计",
    "artboards": [
      { "id": "desktop", "name": "桌面端结账", "file": "project/desktop.dc.html", "x": 0, "y": 0, "w": 1120, "h": 720 },
      { "id": "mobile", "name": "手机端结账", "file": "project/mobile.dc.html", "x": 1180, "y": 0, "w": 390, "h": 844 }
    ]
  }
  ```
- `project/<name>.dc.html`（text）：每张画板以 `<x-dc data-props='[...]'>...</x-dc>` 包裹，内部可放 `<helmet><style>...</style></helmet>` 与 `window.DCLogic = { init, act, derive }`。

## 交互属性调节（`data-props`）

在 `<x-dc>` 上声明 JSON 数组：
```html
<x-dc data-props='[{"name":"density","label":"密度","type":"select","options":["comfortable","compact"],"value":"comfortable"},{"name":"cta","label":"主按钮文案","type":"text","value":"立即开通"}]'>
```
工作台聚焦该画板时会自动生成右侧控制杆：
- 改变属性值会实时写入 `<html data-prop-density="...">`、CSS 变量 `var(--prop-density)`，并更新所有 `data-prop-text="<name>"` 与 `data-prop-show="<name>"` 节点；用户点「保存属性默认值」即可写回 `.dc.html`。

按需延伸阅读：`artifact_type_read({ type: "design", reference: "format" | "craft" })`。
