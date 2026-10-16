# 像素村、素材和音效

Flutter 客户端里和 VibeValley 本身无关的那一半：像素画怎么放大、角色怎么走、光、特效、合成音效，和生图切图的流水线。像素村用 Flame 画（`app/lib/village/`），外框和首页在 `lib/shell/`。画面只读服务端折好的核心状态，自己只加跟着时钟走的东西：走动、姿势、喘气、狗的一天。

## 首页

`lib/shell/title/`（[理由](../.agents/notes/implemented/feature/2026-10-12-title-screen-and-settings.md)），只在这台设备第一次打开时出来，之后直接进农场。背景跟着钟点换早晨、白天、黄昏、夜晚四张图（`--dart-define=VIBEVALLEY_TOD=0.9` 换钟点看），上面叠着会动的云、炊烟、草和萤火虫，管家和你选的宠物画在上面。启动时（`startup.dart`）连农场、读字体和图，都好了才出首页，最多等 20 秒；连不上时横幅带着去「院门」的入口。

左边三项：开始游戏（没有 DeepSeek 的钥匙先打开设置）、继续游戏、设置（[server.md](server.md)「设置」）。

## 像素村

世界是 384×256 的格子，按真实像素画、整数倍放大（`lib/village/game.dart`；[决定](../.agents/notes/implemented/feature/2026-10-11-pixel-village.md)）。素材画成两倍密（[理由](../.agents/notes/implemented/architecture/2026-10-12-denser-pixels.md)）。窗口不是 3:2 时取最大的整数倍，四边裁掉的不超过一点，盖不满就留边、垫一张压暗的农场（`lib/village/framing.dart`，[理由](../.agents/notes/implemented/feature/2026-10-15-farm-fills-the-window.md)）。

- **地图在 LDtk 里**（`village.ldtk`，`lib/village/level.dart` 直接读）：Ground 层标能走的地方；Things 层是地块、帮工去的地点、道具、灯、大门、管家和狗。名字和说明在 `world.dart`。
- **帮工去哪**（`world.dart`）：读、搜去书屋，跑命令去工坊，查网页去电台，等着坐长椅，改文件在自己的地边；隔几秒换个位置（`spotsFor`）。
- **寻路**（`nav.dart`；[理由](../.agents/notes/implemented/feature/2026-10-10-walking-on-paths.md)）：能走的地方铺成格子，A* 找路，靠近障碍的格子贵一点，最后拉直拐角。
- **字和 HUD**（`hud.dart`）按屏幕像素画，任何缩放下都清楚；HUD 贴着农场露出来的那一块的边。
- **入口在院子里**：小摊是商店，箱子堆是仓库，告示板是成就，邮筒是日志，图纸桌是计划，工坊是农具，书屋是技能书。
- **效果和院子的动静**（`fx.dart`、`particles.dart`、`life.dart`、`critters.dart`、`dog.dart`）：浇水、收获、金币这些一闪而过的效果，和炊烟、蝴蝶、池塘、狗这些院子自己的动静，都只在客户端。
- **光**（`sky.dart`、`normals.dart`、`pass.dart`）：法线贴图在加载时从画里生成，不另画夜景；天光随钟点变，天黑后窗户、路灯、提灯是点光源。

## 素材

[理由](../.agents/notes/implemented/process/2026-10-09-image-pipeline-with-codex.md)。原图在单独的仓库 vibevalley-art（放在这个仓库旁边，或用 `VIBEVALLEY_ART` 指给它），先跑一次 `design/art.sh` 把它链接进 `design/`。

1. **生图**：`design/pixel/gen.sh <名字>` 用 codex 画，产出品红底的整张图到 `design/pixel/raw/`。两倍密的版本是 `gen.sh hd-<名字>`。
2. **切图**：`design/pixel/process.py` 写「哪张图、几行几列、每格叫什么」，去品红、切、缩、压到 32 色、算落脚点，写出图和 `sprites.json`。改了图重跑切图，不手改 `sprites.json`。
3. **用图**：客户端按 `sprites.json` 读（`lib/sprites/atlas.dart`），图鉴页能看全部。
4. **应用图标**：`gen.sh app-icon`，放在 `app/macos/Runner/Assets.xcassets/`。
5. **指针**：客户端没有图片鼠标指针，农场里的工具指针画在画面上（`lib/farm/cursors.dart`）。

## 音效

音效是现合成的，没有音频文件（[理由](../.agents/notes/implemented/feature/2026-10-10-synthesized-sound-effects.md)）：配方在 `lib/shell/sfx.dart`，合成器在 `lib/shell/synth.dart`。

- **从状态里响**（`lib/shell/farm_sounds.dart`）：不管是谁让状态变的，变了就响。
- **音量分三档**（按人耳加权的响度）：点击约 -28，干活和状态变化约 -24，奖励约 -20。改了配方要重新量。
- 调试台的「音效」页逐个试听；`test/shell_synth_test.dart` 拿 `test/fixtures/sfx.json` 比对合成结果。
