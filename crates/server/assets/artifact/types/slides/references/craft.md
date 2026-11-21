# 演示叙事与视觉克制（slides / craft）

## 标题即结论

- 差标题：「第三季度销售数据」
- 好标题：「华东大客户续费率升至 94%，带动 Q3 净增翻倍」
- 观众只扫每页标题就能读懂完整故事线。

## 拒绝廉价模板感

- 最多使用 1 个主品牌色（`var(--color-accent, var(--vv-accent))`）加 1 个辅助语义色；大面积底色保持干净中性面（`var(--color-surface, var(--vv-page))`）。
- 数字一律开启等宽对齐：`font-variant-numeric: tabular-nums`。
- 图表直接用干净的内联 `<svg>` 绘制，标出关键拐点数值，省去多余网格线。
