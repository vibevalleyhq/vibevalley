# 白板内置贴纸库与矢量插图（whiteboard / pictures）

画布提供内置编辑风贴纸与 `asset/` 矢量插图两类视觉装饰，均自动适配亮/暗双主题与 SVG/PNG 导出：

## 1. 内置手绘编辑风贴纸库（25 款，6 分类，优先复用）

在 `shape: "card" | "sticky"` 的 `sticker` 字段或 `type: "sticker"` 元素中填入内置 ID（也可填 emoji）：

- **发布与里程碑（Launch）**：`berry-lock`（锁定范围）、`rocket`（发布上线）、`flag`（里程碑）、`sparkles`（亮点/完成）、`storefront`（主站/上线）。
- **商业与计划（Business）**：`price-tag`（预算/定价）、`chart-board`（预测/看板）、`calendar`（排期）、`target`（目标对齐）、`trophy`（交付达成）。
- **工程与架构（Engineering）**：`database`（存储引擎）、`cloud`（云/网络边界）、`cpu`（内核计算）、`gear`（工作流配置）、`terminal`（命令行/运行时）。
- **状态与标记（Status）**：`check`（通过/已完成）、`warning`（阻塞/告警）、`lightbulb`（方案灵感）、`clock`（耗时/在途）、`fire`（高优重点）。
- **团队与协作（People）**：`mascot`（主助手形象）、`agent-bot`（执行角色）。
- **交付与物资（Transport）**：`truck`（配送运输）、`crate`（批产清单）、`bowl`（验收测试）。

在卡片 JSON 中写 `"sticker": "storefront"` 即可自动居中骑跨在卡片上沿，无需手动计算偏移坐标。

## 2. 自定义插图与 `asset/` 资源

- 大型或复用插画优先存为 `asset/<name>.svg` / `asset/<name>.png`，在元素中以 `src: "asset/<name>"` 引用，保持 `structure/board.json` 轻量。
- 轻量内联 `type: "svg"` 支持 `sketch: "marker"`（圆润手绘笔触）与 `sketch: "clean"`（几何矢量）；服务端清洗器会自动剥离 `<script>`、`on*` 事件与外链，仅保留纯矢量标签。
