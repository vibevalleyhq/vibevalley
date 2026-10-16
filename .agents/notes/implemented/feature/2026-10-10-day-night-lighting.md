# Agent Note: 昼夜用重新打光的背景和颜色矩阵

Status: implemented

> 已被取代：农场换成像素村以后，昼夜不再画三张背景、也不用颜色矩阵，而是每个像素按法线贴图打光、天光跟着钟点变（[像素村](2026-10-11-pixel-village.md)）；现在在 Flutter 客户端里，法线贴图由 `app/lib/village/normals.dart` 从画里生成，天光在 `sky.dart`，打光是着色器 `app/shaders/light.frag`（[framework.md](../../../../docs/framework.md)「像素村」）。`DayBackdrop`、`DayLit`、`Lamps` 随 `packages/engine` 删掉了。下面是当时的决策。

## Problem

农场有时钟，十分钟一天。主人觉得晚间的样式不好，要重新生图；夜里的贴图也要跟着变暗变蓝。给贴图上色的第一版用的是「贴图当遮罩、上面盖一层颜色」，帮工走路换帧时会闪一下白。

## Decision

见 [framework.md](../../../../docs/framework.md)「像素村」的「光」：

- 背景画三遍：白天、黄昏、夜里。用 codex 以白天的背景为参考只改光线，物件位置的偏差在 1 像素内，所以可以叠着按时钟淡入淡出（`DayBackdrop`）。
- 贴图的光是一个 SVG 颜色矩阵，作为 `filter` 加在贴图自己的 `<img>` 上（`DayLit`）：只染贴图本身，不会把已经画好的夜景再压暗一遍。气泡和牌子（`Pinned`）不染，保持好认；`Lamps` 是天黑后窗户和门灯的暖光。

## Alternatives considered

**在整张画上盖一层颜色。** 画好的夜景被压暗两遍，灯光和阴影都对不上。

### Why not 贴图当遮罩、上面盖一层颜色?

遮罩图是异步加载的：走路换帧时那一两帧还没有遮罩，颜色层盖不上，动物闪一下白。颜色矩阵跟着 `<img>` 本身，换帧不会丢。

## Consequences

夜里是画出来的夜景，动物也跟着变暗变蓝，不闪。代价是加一个时刻就要再生一张背景图；换背景布局时三张都要重画。
