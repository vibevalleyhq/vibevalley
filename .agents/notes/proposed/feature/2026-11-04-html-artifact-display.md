# Agent Note: 网页 Artifact 的元素锚点、锚点评论与高度回报

Status: proposed

## Problem

用户在查看网页 Artifact（[Artifact](docs/subsystems/artifact.md)）时，虽然已支持划词替换文字（`artifact.html.edit`），但还缺三项视觉审阅交互：
- 指着图表、按钮或容器让帮工改样式时，无法在画面上直接点选 DOM 元素并将评论钉在该元素上。
- 聊天旁栏（`ArtifactCanvas.tsx`）已经经 `HtmlFrame` 载入 `?shell=1` 外壳，但没接 `PageWords`，旁栏里不能划词改字。
- 聊天流中的网页卡片尚不能按实际内容高度自适应展开。

## Proposal

1. **元素选择器锚点**：`HtmlAnchor` 扩展 `{ kind: "element", css: string }`。用户在预览工具栏开启「点选元素」后点击页面元素，外壳脚本计算唯一定位的 CSS 选择器并经 `postMessage` 传给工作台。
2. **画布内评论角标与定位**：工作台将带锚点的评论列表传给外壳脚本，在对应文字或元素旁绘制编号角标；点击角标高亮评论，点击评论滚动定位至该锚点并闪烁提示。
3. **对话旁栏接入与高度回报**：`ArtifactCanvas.tsx` 接上 `PageWords`，旁栏里也能划词改字与点选元素；外壳（`packages/artifact/src/shell.ts`）监听尺寸变化并经 `postMessage` 回报高度。

## Alternatives considered

- **向 HTML 源码每个元素注入持久化 ID 属性**：会污染存储源码字节且跨版本易失效；使用标准文本锚点与 CSS 选择器无需改动存储源码。

## Acceptance criteria

- 在网页 Artifact 中点选一个 DOM 元素并发表评论，页面对应位置显示编号角标，点击评论可滚动定位到该元素。
- 聊天旁栏 `ArtifactCanvas` 支持与 `/artifacts` 页一致的划词改字与元素锚点点选。

## Risks

- 动态绘制的 `<canvas>` 内部图形无法用 DOM 选择器细分，仅能锚定到 `<canvas>` 容器元素本身。
