# 像素村、素材和音效

Flutter 客户端里和 VibeValley 本身无关的那一半：像素画怎么放大、角色怎么走、光、特效、合成音效，和生图切图的流水线。像素村用 Flame 画（`app/lib/village/`），外框和首页在 `lib/shell/`。画面只读服务端折好的核心状态，自己只加跟着时钟走的东西：走动、姿势、喘气、狗的一天。

## 首页

`lib/title/`（[理由](docs/subsystems/app.md)），只在这台设备第一次打开时出来，之后直接进农场。背景跟着钟点换早晨、白天、黄昏、夜晚四张图（`--dart-define=VIBEVALLEY_TOD=0.9` 换钟点看），上面叠着会动的云、炊烟、草和萤火虫，管家和你选的宠物画在上面。启动时（`startup.dart`）连农场、读字体和图，都好了才出首页，最多等 20 秒；连不上时横幅带着去「院门」的入口。

左边三项：开始游戏（没有 DeepSeek 的钥匙先进工作台「设置」的 DeepSeek）、继续游戏、设置（进工作台的「设置」页，[farm-ui.md](docs/reference/farm-ui.md) 的「设置」）。

## 像素村

见 [农场的皮](docs/subsystems/farm.md)。

## 素材

[理由](.agents/notes/implemented/process/2026-10-09-image-pipeline-with-codex.md)。原图在单独的仓库 vibevalley-art（放在这个仓库旁边，或用 `VIBEVALLEY_ART` 指给它），先跑一次 `design/art.sh` 把它链接进 `design/`。

1. **生图**：`design/pixel/gen.sh <名字>` 用 codex 画，产出品红底的整张图到 `design/pixel/raw/`。两倍密的版本是 `gen.sh hd-<名字>`。
2. **切图**：`design/pixel/process.py` 写「哪张图、几行几列、每格叫什么」，去品红、切、缩、压到 32 色、算落脚点，写出图和 `sprites.json`。改了图重跑切图，不手改 `sprites.json`。
3. **用图**：客户端按 `sprites.json` 读（`lib/sprites/atlas.dart`），图鉴页能看全部。
4. **应用图标**：`gen.sh app-icon`，放在 `app/macos/Runner/Assets.xcassets/`。
5. **指针**：客户端没有图片鼠标指针，农场里的工具指针画在画面上（`lib/farm/cursors.dart`）。

## 音效

见 [农场的皮](docs/subsystems/farm.md)。

