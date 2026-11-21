# 运动节奏与编排（motion / choreography）

- **快进慢收**：进场优先用 `kit.ease.outQuart` 或 `kit.ease.outBack`（0.35s–0.55s），镜头平移用 `kit.ease.inOutCubic`。
- **动作重叠（Overlap）**：标题到位 60% 时副标题即开始上浮（`kit.stagger` 步长 0.08s–0.14s），避免机械排队。
- **留定格时间**：每个核心信息完整显现后至少静止 1.0s–1.5s 供人眼阅读，再进入转场。
