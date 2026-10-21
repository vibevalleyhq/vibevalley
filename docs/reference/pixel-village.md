# 像素村、素材和音效

页面里和 VibeValley 本身无关的那一半：像素画怎么放大、角色怎么走、光、特效、合成音效，和生图切图的流水线。像素村用 PixiJS 画（`apps/web/src/farm/canvas`，引擎在 `packages/engine`），首页在 `apps/web/src/farm/title`。画面只读服务端折好的核心状态，自己只加跟着时钟走的东西：走动、姿势、喘气、狗的一天。

## 首页

`apps/web/src/farm/title/`（[理由](docs/subsystems/app.md)），只在这台设备第一次打开时出来，之后直接进农场。背景跟着钟点换早晨、白天、黄昏、夜晚四张图（地址后面加 `?tod=0.9` 换钟点看），上面叠着会动的云、炊烟、草和萤火虫，管家和你选的宠物画在上面。

左边三项：开始游戏（没有 DeepSeek 的钥匙先进工作台「设置」的 DeepSeek）、继续游戏、设置（进工作台的「设置」页，[farm-ui.md](docs/reference/farm-ui.md) 的「设置」）。

## 像素村

见 [农场的皮](docs/subsystems/farm.md)。

## 素材

[理由](docs/subsystems/process.md)。原图在单独的仓库 vibevalley-art（放在这个仓库旁边，或用 `VIBEVALLEY_ART` 指给它），先跑一次 `design/art.sh` 把它链接进 `design/`。

1. **生图**：`design/pixel/gen.sh <名字>` 用 codex 画，产出品红底的整张图到 `design/pixel/raw/`。两倍密的版本是 `gen.sh hd-<名字>`。
2. **切图**：`design/pixel/process.py` 写「哪张图、几行几列、每格叫什么」，去品红、切、缩、压到 32 色、算落脚点，写出 `apps/web/public/pixel/` 的图和 `sprites.json`。改了图重跑切图，不手改 `sprites.json`。
3. **用图**：页面按 `sprites.json` 读（`apps/web/src/farm/world/sprites.ts`），图鉴页（`/catalog`）能看全部；官网直接用同一批文件。
4. **应用图标**：`gen.sh app-icon`；几个尺寸放在 `apps/web/public/icons/`（页面的标签图标，官网构建时也拿去），桌面版用 `apps/desktop/resources/icon.icns`（从 1024 的图用 `sips` 和 `iconutil` 做出来）。
5. **指针**：`apps/web/public/cursors/` 的图和 `cursors.json` 的落脚点，农场的画布按手上的农具换 CSS 指针（`farm/canvas/VillageCanvas.tsx`）。

## 音效

见 [农场的皮](docs/subsystems/farm.md)。
