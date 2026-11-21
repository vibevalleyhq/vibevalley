# 白板贴纸与矢量插图（whiteboard / pictures）

画布提供两类视觉插图能力，均同时支持亮/暗双主题渲染与 SVG 导出：

## 1. 内置手绘编辑风贴纸库（推荐优先复用）

在 `shape: "card" | "sticky"` 的 `sticker` 字段或 `type: "sticker"` 元素中使用以下内置 ID（也可直接填 emoji）：

- 叙事与交付：`berry-lock`（锁定核心）、`price-tag`（预算/定价）、`chart-board`（预测/看板）、`crate`（批产/清单）、`storefront`（主站/上线门店）、`bowl`（验收/测试）、`truck`（交付运输）、`mascot`（协作伙伴）。
- 通用标注：`warning`、`lightbulb`、`rocket`、`flag`、`calendar`、`clock`、`check`、`sparkles`。

浮在卡片上沿时无需手动算坐标，只需在卡片 JSON 上写 `"sticker": "storefront"` 即可自动居中骑跨在卡片顶部边缘。

## 2. 自定义矢量插图（`type: "svg"` 或 `stickerSvg`）

- 支持 `sketch: "marker"`（圆润手绘笔触）与 `sketch: "clean"`（几何矢量图标），也可为卡片传 `stickerSvg` 字段挂载专属定制小插画。
- 安全约束：服务端在写入 `elements/*` 时会对 `svg` 与 `stickerSvg` 调用白名单清洗器，自动剥离 `<script>`、`on*` 事件与外链，仅保留纯矢量标签。
