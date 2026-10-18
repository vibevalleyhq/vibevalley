# Agent Note: 画成一座农场，不是工地

Status: implemented

## Problem

第一版界面是一个伪 3D 工地（three.js）：工头站在指挥台上，工人是机器人，砌砖、打桩、焊接。场面热闹，但机器人之间不好区分，三维场景重、难改，工地的隐喻也装不下「做完了等你收」「出问题了要你处理」这类和主人有关的状态。

## Decision

主界面是一座 QQ 农场那样的 2.5D 卡通农场（[farm-ui.md](docs/reference/farm-ui.md)）：

- 请 codex 按同一套内容出了四个型号（经典农场、温室花园、夜间科技温室、竖屏掌上），选定 B「温室花园」：柔和的奶油色、圆角卡片、抬高的花坛当田。
- 主场景是 2D：一张画好的背景，田地、帮工、管家和狗都是贴上去的精灵，DOM 里摆位置，CSS 做动画，不用 three.js。
- 人只有一个：管家。帮工都是小动物，一个帮工档案一种动物，换衣服、六个动作。
- 农场的东西对上 VibeValley 的状态：生长是进度，成熟是做完等你收，虫子是失败，干裂是没动静，杂草是等你批准，收获是合进项目（[concepts.md](docs/concepts.md)「农场是皮」）。

（画法后来被 [像素村](.agents/notes/implemented/feature/2026-10-11-pixel-village.md) 取代：农场重画成像素的小院，现在是 Flutter 客户端里用 Flame 画的（`app/lib/village/`），不再在 DOM 里摆精灵、用 CSS 做动画。农场的隐喻、管家和小动物帮工照旧。）

工地版的代码挪到 `archive/site-v0/`，不参与编译；后来删掉了（[删掉工地版的代码](.agents/notes/implemented/simplification/2026-10-09-delete-site-v0.md)）。

## Alternatives considered

**留在工地。** 隐喻只有「干活」，没有「等你收」「要你处理」；三维场景改一个动作要动模型和动画。

**型号 A（经典农场）。** 最像 QQ 农场，但颜色和按钮更吵，和长时间开着的工作工具不搭。

**型号 C（夜间科技温室）。** 好看但暗，字和状态不好认；夜里的样子后来改成昼夜变化（现在的打光见 [pixel-village.md](docs/reference/pixel-village.md)）。

**型号 D（竖屏掌上）。** 留作手机版（[mobile-layout](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)）。

**主场景继续用 three.js。** 生图的画风在 2D 精灵上能直接用，三维要另建模型；2D 的遮挡、点击和动画用 DOM 和 CSS 就够。

## Consequences

一眼能看出谁在干什么、哪块地要你处理；素材靠生图流水线（[image-pipeline-with-codex](.agents/notes/implemented/process/2026-10-09-image-pipeline-with-codex.md)）。代价是画面绑在一张背景图上：换布局要重画背景、重描能走的路；手机上整张图缩得很小。
