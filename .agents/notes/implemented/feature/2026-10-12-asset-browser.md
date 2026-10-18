# Agent Note: 图鉴：一页看全农场的素材

Status: implemented

## Problem

农场的素材已经很多：像素 700 多张、手绘 500 多张，两套指针，二十几个合成的音效。想看一张图长什么样、落脚点对不对、像素版有没有、是从哪张原图切出来的、怎么重画，只能去翻 `web/src/*/assets/` 的文件、`sprites.json` 和两个 `process.py`。主人要一个专门指引看素材的页面。

## Decision

一个配置页 `/assets`（`app/lib/workbench/assets/`），叫「图鉴」，三个书架：图、指针、音效（[farm-ui.md](docs/reference/farm-ui.md)「界面清单」）。

- **只读应用已经打包的东西**：图来自 `app/assets/pixel/sprites.json`，指针来自 `app/assets/cursors/cursors.json`，音效来自 `app/lib/audio/sfx.dart` 的配方。页面没有自己的素材清单，切了新图它就出现。（当时图和指针都是手绘、像素各一份，后来只留像素的一套，见 [只留像素村](.agents/notes/implemented/simplification/2026-10-12-pixel-only.md)。）
- **清单记下每张图切自哪张原图**（`sheet`，从仓库根算的路径），当时两条切图流水线（`cut_sheets.py`、`design/pixel/process.py`）都写，现在只剩 `design/pixel/process.py`（`cut_sheets.py` 已经删了）。页面按它给出重画和重新切的命令（`remakeOf`）。旧清单是用一次性的脚本补上的，没有重新切图。
- **分类按名字的前缀**（`app/lib/workbench/assets/assets_data.dart` 的 `shelves`）：素材的命名本来就按种类（`icon-`、`lang-`、`<动物>-<衣服>-`），帮工的动物和衣服用生成的 `Species`、`Outfit`。会动的图按编号认出帧（`framesOf`；`x-1`、`x-2`；像素的走路是两步夹一帧站）。像素和手绘的对应关系用像素皮肤取图时的同一个函数（`pixelName`），所以「缺像素版」和游戏里实际显示的一致（这一条后来被 [只留像素村](.agents/notes/implemented/simplification/2026-10-12-pixel-only.md) 取代：手绘的图删了，图鉴只有一套图，没有「缺像素版」了）。
- 音效的分组在 `app/lib/audio/sfx.dart`（`soundGroups`），调试台和图鉴共用一份。

## Alternatives considered

**页面里写一张前缀到原图的对照表**：不用改清单和流水线，但它要和两个 `process.py` 里的表格保持一致，加一张原图就得改两处；清单里记一个字段，切图时顺手写上，不会对不上。

**把原图也打包进页面，并排显示切图前后**：原图在 `design/` 下，六十多张、每张一两兆，会让页面的构建大很多；只给路径，要看就去打开那个文件。

**放进调试台**：调试台是给调游戏状态用的深色窄面板，装不下几百张图的网格和大图；图鉴需要一整页。

## Consequences

- 清单里尺寸和落脚点以外的字段按各自的类型读（`sheet` 是字符串，`hx`、`hy` 是数；`assets_data.dart` 的 `Picture`），不再一律当数。
- 不再用的旧图（像素的 `mailbox`）没有 `sheet`，页面上写「没记下来」。
- 改了命名的前缀，要同时看 `assets_data.dart` 的 `shelves`，否则新图会落进「其他」。
