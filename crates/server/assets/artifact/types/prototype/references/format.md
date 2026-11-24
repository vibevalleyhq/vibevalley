# 交互原型文件契约与沙箱规范（prototype / format）

## 1. 入口骨架 `structure/index.html`

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>快捷审批流程原型</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main id="app" aria-live="polite"></main>
    <script type="module" src="./app.js"></script>
  </body>
</html>
```

## 2. 样式契约 `structure/styles.css`

- 顶层定义语义 CSS 变量并优先消费关联 `design-system` 注入的 `--color-*` / `--radius-*` / `--space-*`（同时写明回退值，保证无外部体系时同样美观）：
  ```css
  :root {
    --bg: var(--color-surface, #fcfcfb);
    --panel: var(--color-panel, #f4f3ef);
    --ink: var(--color-ink, #1c1917);
    --accent: var(--color-accent, #4d7a2a);
    --radius: var(--radius-md, 8px);
  }
  ```
- 同时支持明暗双主题与响应式窄屏布局（`@media (max-width: 768px)`）。

## 3. 状态驱动交互 `structure/app.js`

- 使用**单一状态对象 + 纯渲染函数**组织代码，避免零散的全局 DOM 变更难以协作与调试：
  ```js
  const state = {
    tab: "pending",
    items: [
      { id: "req-1", title: "扩容日志集群", status: "pending", owner: "林舟" }
    ],
    selectedId: "req-1"
  };

  function setState(patch) {
    Object.assign(state, patch);
    render();
  }

  function render() {
    // 基于 state 渲染视图，事件用委托绑定
  }

  render();
  ```
- 资产路径：在 HTML 或 JS 中引用图片/图标统一写 `asset/<name>`（相对于作品根目录）或通过 `manifest.json` 声明的资源表解析；严禁内联数 MB 的 base64 污染 `app.js`。

## 4. 沙箱禁用项

- 禁止未白名单外链脚本、样式与字体；禁止向外部 API 发起真实写请求（模拟异步请用受控本地状态切换）；禁止 `<base href>`、`<meta http-equiv="refresh">`、嵌套 `<iframe>` 与无拦截的原生 `<form action="...">`。
