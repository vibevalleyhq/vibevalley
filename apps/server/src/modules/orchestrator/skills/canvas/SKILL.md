---
name: canvas
description: 用户要一份海报、大字报、宣传横幅、架构图或可分层微调的视觉画板时用。交一份网页 Artifact，display 填 canvas，用 <vv-board>、<vv-layer> 和 <vv-assets> 排好图层，工作台负责缩放、图层微调、主题切换和排版检查。
---

# 画板

画板是一份网页 Artifact（`artifact_create`，`kind` 填 `html`，`display` 填 `canvas`）。工作台读你写的声明式图层：缩放适配、图层列表与属性微调、4 套主题切换和两级排版检查都是工作台的事，你不用写缩放或拖拽脚本。

1. **先定画板和主题。** 顶层放一个 `<vv-board>`：
   - `<vv-board width="1600" height="1000" palette="workbench" grain="0">`
   - `width` 和 `height` 填正整数像素尺寸（例如横版海报 `1600` × `1000`，竖版海报 `1000` × `1400`，宣传横幅 `1800` × `600`）。
   - `palette` 选 4 套内置主题之一：`workbench`（默认工作台）、`brutalist-red`（粗野红黑）、`newsprint`（报纸铅印）、`blueprint`（工程蓝图）；`grain` 设颗粒强度（默认 `0`）。
2. **用图层和分组排结构。** 所有可见元素放在 `<vv-board>` 内的 `<vv-layer>`（或 `<vv-group>`）里：
   - `<vv-group id="..." name="..." x="..." y="..." w="..." h="..." z="...">`：把一组关联元素编进同一个分组边界与叠放次序。
   - `<vv-layer id="..." name="..." x="..." y="..." w="..." h="..." z="..." rotate="0" opacity="1" flip="none|x|y|xy" filter="none|sticker-cutout|torn-paper|halftone|shadow|grain" bleed allow-overlap asset="...">`
   - 每个图层都要有画板内唯一的 `id`、可读的 `name`、数值包围盒 `x` / `y` / `w` / `h` 和层序 `z`。`rotate`、`opacity`、`flip`（`none` / `x` / `y` / `xy`）和 `filter`（`none` / `sticker-cutout` / `torn-paper` / `halftone` / `shadow` / `grain`）在工作台里可继续微调。
3. **把素材放进 `<vv-assets>`。** `<vv-assets><img id="..." src="data:..." /></vv-assets>` 必须写在 `<vv-board>` 外部下方（也可放 `<svg id="...">` 内联矢量图），`<vv-layer>` 只用 `asset="<id>"` 引用。绝不把超过 2 KB 的 `data:` URI 直接内联写进 `<vv-board>` 内部，也不要连外网加载图片（沙箱禁网，只能内联 `data:` 或 `<svg>`）。
4. **守住零遮挡与边距规则。**
   - **图文间距 ≥ 24px**：带 `asset="..."` 的前景人物或贴纸 `<vv-layer>` 包围盒，与任何文字 `<vv-layer>` 包围盒之间四周至少留出 `24px` 间距，避免触发 Stage 1 AST 遮挡检查或 Stage 2 字符级 DOM 遮挡检查。
   - **铺满背景加标记**：全画板背景图层必须写 `bleed` 且 `z="-1"`（或 `< 0`）；没有 `bleed` 的图层不得越出画板 `0..width`、`0..height` 边界；确实需要叠压的纯角标装饰才加 `allow-overlap`。
   - **文字留出 20% 余量**：不同系统字体宽窄不同，每个文字 `<vv-layer>` 的 `w` 和 `h` 至少多留 `20%` 富余空间，防止文字裁切或溢出。
5. **样子交给 CSS 变量。** 颜色和边框用 `--vv-canvas-bg`、`--vv-canvas-surface`、`--vv-canvas-ink`、`--vv-canvas-muted`、`--vv-canvas-accent`、`--vv-canvas-border`，字体用 `--vv-font-sans`、`--vv-font-mono`，切换 4 套主题时会自动跟着变。别给 `<vv-board>`、`<vv-group>`、`<vv-layer>` 写 `position`、`transform`、`width`、`height` 覆盖位置和尺寸，那是工作台排版与属性写回用的。
6. **交上来。** 调 `artifact_create` 时 `kind` 填 `html`、`display` 填 `canvas`，`note` 写一句这份画板讲什么（内容较长时可先写进工作目录文件再用 `file` 传入）。用户评论或微调后要接着改，用 `artifact_version_create` 交新的一稿（第 N 稿），每次都是整份。

模板（三栏工作台海报）：

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>工作台三栏简报海报</title>
<style>
  * { box-sizing: border-box; }
  .bg-fill {
    width: 100%;
    height: 100%;
    background: var(--vv-canvas-bg);
    border: 2px solid var(--vv-canvas-border);
  }
  .masthead {
    width: 100%;
    height: 100%;
    padding: 16px 24px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 8px;
    color: var(--vv-canvas-ink);
    font-family: var(--vv-font-sans, system-ui, sans-serif);
  }
  .kicker {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--vv-canvas-accent);
  }
  .masthead h1 {
    margin: 0;
    font-size: 46px;
    line-height: 1.15;
    color: var(--vv-canvas-ink);
  }
  .lead {
    margin: 0;
    font-size: 19px;
    line-height: 1.4;
    color: var(--vv-canvas-muted);
  }
  .card {
    width: 100%;
    height: 100%;
    padding: 28px 30px;
    background: var(--vv-canvas-surface);
    border: 1px solid var(--vv-canvas-border);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    color: var(--vv-canvas-ink);
    font-family: var(--vv-font-sans, system-ui, sans-serif);
  }
  .card h2 {
    margin: 0;
    font-size: 26px;
    line-height: 1.25;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--vv-canvas-border);
  }
  .card ul {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: 18px;
    line-height: 1.5;
    color: var(--vv-canvas-ink);
  }
  .card li::marker { color: var(--vv-canvas-accent); }
  .footer-bar {
    width: 100%;
    height: 100%;
    padding: 12px 24px;
    background: var(--vv-canvas-surface);
    border: 1px solid var(--vv-canvas-border);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 16px;
    line-height: 1.4;
    color: var(--vv-canvas-muted);
    font-family: var(--vv-font-sans, system-ui, sans-serif);
  }
</style>
</head>
<body>
<vv-board width="1600" height="1000" palette="workbench" grain="0">
  <vv-layer id="bg" name="背景底板" x="0" y="0" w="1600" h="1000" z="-1" bleed>
    <div class="bg-fill"></div>
  </vv-layer>

  <vv-layer id="masthead" name="主标题区" x="64" y="44" w="1088" h="200" z="2">
    <header class="masthead">
      <p class="kicker">VIBEVALLEY · WORKBENCH BROADSHEET</p>
      <h1>从对话到交付：本周工程速览</h1>
      <p class="lead">三栏声明式画板模板 · 支持工作台图层微调与主题切换</p>
    </header>
  </vv-layer>

  <vv-layer id="hero-emblem" name="主视觉徽章" x="1192" y="44" w="344" h="200" z="3" rotate="0" opacity="1" flip="none" filter="sticker-cutout" asset="emblem"></vv-layer>

  <vv-layer id="col-1" name="第一栏：目标与进展" x="64" y="284" w="464" h="580" z="2">
    <article class="card">
      <h2>01 · 目标与进展</h2>
      <ul>
        <li>工单拆解清晰，每个帮工专注单一分支</li>
        <li>接口与契约先通过静态校验再进评审</li>
        <li>关键状态只保留一份，减少页面兜底逻辑</li>
      </ul>
    </article>
  </vv-layer>

  <vv-layer id="col-2" name="第二栏：系统结构" x="568" y="284" w="464" h="580" z="2">
    <article class="card">
      <h2>02 · 系统结构</h2>
      <ul>
        <li>服务端按单数概念划分模块并单向依赖</li>
        <li>所有外部输入在边界一次性解码校验</li>
        <li>画板坐标与大体积内联素材解耦存放</li>
      </ul>
    </article>
  </vv-layer>

  <vv-layer id="col-3" name="第三栏：验收清单" x="1072" y="284" w="464" h="580" z="2">
    <article class="card">
      <h2>03 · 验收清单</h2>
      <ul>
        <li>文字图层四周留足 24px 安全边距</li>
        <li>跨系统字体高度预留 20% 富余空间</li>
        <li>切换 4 套主题均保持清晰对比度</li>
      </ul>
    </article>
  </vv-layer>

  <vv-layer id="footer" name="页脚信息栏" x="64" y="896" w="1472" h="64" z="2">
    <footer class="footer-bar">
      <span>VibeValley 工作台 · 第 1 稿</span>
      <span>支持导出与工作台图层属性写回</span>
    </footer>
  </vv-layer>
</vv-board>

<vv-assets>
  <img id="emblem" alt="工作台徽章" src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20344%20200%22%20fill%3D%22none%22%3E%3Crect%20x%3D%2212%22%20y%3D%2212%22%20width%3D%22320%22%20height%3D%22176%22%20rx%3D%2216%22%20fill%3D%22%23f6f5f3%22%20stroke%3D%22%234d7a2a%22%20stroke-width%3D%224%22%2F%3E%3Ccircle%20cx%3D%2296%22%20cy%3D%22100%22%20r%3D%2242%22%20fill%3D%22%234d7a2a%22%2F%3E%3Cpath%20d%3D%22M78%20100l12%2012%2024-26%22%20stroke%3D%22%23fcfcfb%22%20stroke-width%3D%228%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3Crect%20x%3D%22158%22%20y%3D%2268%22%20width%3D%22136%22%20height%3D%2218%22%20rx%3D%226%22%20fill%3D%22%231c1917%22%2F%3E%3Crect%20x%3D%22158%22%20y%3D%22102%22%20width%3D%2296%22%20height%3D%2214%22%20rx%3D%226%22%20fill%3D%22%2374a046%22%2F%3E%3C%2Fsvg%3E" />
</vv-assets>
</body>
</html>
```

用用户的语言写画板内容，也用用户的语言回答。
