# 白板 SVG 插图双模式（whiteboard / pictures）

`type: "svg"` 元素支持两种视觉笔触：
1. `sketch: "marker"`：适合头脑风暴草图、隐喻示意图，使用圆头描边（`stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"`）。
2. `sketch: "clean"`：适合精确几何拓扑、时序与图标。
安全约束：服务端会清洗 `<script>`、`on*` 事件与外链，只保留纯矢量标签。
