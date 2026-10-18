# Agent Note: 帮工沿着路走

Status: implemented

## Problem

帮工从一个位置走到另一个位置是走直线：穿过别的地块、篱笆和花丛，看起来像乱走一气。

## Decision

见 [pixel-village.md](docs/reference/pixel-village.md)「像素村」的寻路：

- `web/src/farm/paths.ts` 照背景描出能走的地方：草地、石板路，扣掉每块地（顶面加看得见的木框前脸）。（像素村换成了 LDtk 地图的 Ground 层，`app/assets/village.ldtk`；地块和道具的底由游戏扣掉，`app/lib/village/world.dart` 的 `walkable`，见 [像素村](.agents/notes/implemented/feature/2026-10-11-pixel-village.md)。）
- `@heybro/engine/nav` 把它铺成 8 像素的格子，A* 找最省的路：石板路比草地便宜，所以从大门进来的帮工先沿石板路走；靠近障碍的格子贵一点，所以走在两块地之间的过道中间；最后把能直走又不更贵的拐角拉直。（现在是它的 Dart 移植 `app/lib/village/nav.dart`；Ground 层只分能走、不能走，石板路不再更便宜。）
- `useWalker` 沿着这条路一段段走，每段有自己的朝向和前后顺序。（现在是 `nav.dart` 的 `Walker`；前后顺序按脚底的 y 排，在 `game.dart`。）

## Alternatives considered

**手摆路点。** 每块地、每个位置都要连线，换布局要全部重摆；格子 A* 只要描轮廓。

**直线走、只绕开地块中心。** 仍会擦着木框和花丛走，过道里贴边。

## Consequences

帮工走在路上、走在过道中间，看起来像在农场里干活。代价是换地图布局时要跟着改能走的地方：现在是 LDtk 的 Ground 层，在 LDtk 里打开就能核对；原来的 `paths.ts` 和画出它的 `hb.paths()` 随旧版删掉了（[只留像素村](.agents/notes/implemented/simplification/2026-10-12-pixel-only.md)）。
