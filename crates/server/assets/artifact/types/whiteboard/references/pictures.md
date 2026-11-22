# 白板贴纸与矢量插图（whiteboard / pictures）

画布提供两类视觉插图能力，均同时支持亮/暗双主题渲染与 SVG 导出：

## 1. 内置手绘编辑风贴纸库（25 款，6 个分类，推荐优先复用）

在 `shape: "card" | "sticky"` 的 `sticker` 字段或 `type: "sticker"` 元素中使用以下内置 ID（也可直接填 emoji）：

- **发布与里程碑（Launch）**：`berry-lock`（锁定范围）、`rocket`（发布上线）、`flag`（里程碑）、`sparkles`（亮点/完成）、`storefront`（主站/上线门店）。
- **商业与计划（Business）**：`price-tag`（预算/定价）、`chart-board`（预测/看板）、`calendar`（排期）、`target`（目标对齐）、`trophy`（交付达成）。
- **工程与架构（Engineering）**：`database`（存储引擎）、`cloud`（云/网络边界）、`cpu`（内核计算）、`gear`（工作流配置）、`terminal`（命令行/运行时）。
- **状态与标记（Status）**：`check`（通过/已完成）、`warning`（阻塞/告警）、`lightbulb`（方案灵感）、`clock`（耗时/在途）、`fire`（高优重点）。
- **团队与协作（People）**：`mascot`（主助手形象）、`agent-bot`（协作帮工）。
- **交付与物资（Transport）**：`truck`（配送运输）、`crate`（批产清单）、`bowl`（验收测试）。

浮在卡片上沿时无需手动算坐标，只需在卡片 JSON 上写 `"sticker": "storefront"` 即可自动居中骑跨在卡片顶部边缘。

## 2. 自定义矢量插图（`type: "svg"` 或 `stickerSvg`）

- 支持 `sketch: "marker"`（圆润手绘笔触）与 `sketch: "clean"`（几何矢量图标），也可为卡片传 `stickerSvg` 字段挂载专属定制小插画。
- 安全约束：服务端在写入 `elements/*` 时会对 `svg` 与 `stickerSvg` 调用白名单清洗器，自动剥离 `<script>`、`on*` 事件与外链，仅保留纯矢量标签。
