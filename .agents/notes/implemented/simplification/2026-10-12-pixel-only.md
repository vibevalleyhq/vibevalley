# Agent Note: 只留像素村，拿掉手绘的旧版农场和它的图

Status: implemented

## Problem

[像素村](.agents/notes/implemented/feature/2026-10-11-pixel-village.md)做好以后，原来手绘的农场（型号 B）留作旧版。为了两边都能用，页面一直背着两套东西：两套贴图、两套指针、一个「皮肤」的概念（配置页跟着上一个农场页穿哪套）、十来处 `skin()` 分支、手绘画面专用的寻路轮廓和字体。每加一样画面上的东西都要想两边，而旧版已经没人用。

## Decision

像素村是唯一的农场，客户端没有第二套画面。

- **客户端只有一套像素素材**：`app/assets/pixel/` 的雪碧图、`app/assets/cursors/` 的指针、`app/assets/fonts/` 的 Fusion Pixel 12px 中文像素字体；`app/lib/sprites/atlas.dart` 读 `sprites.json` 摆帧。没有皮肤这个概念，也没有切换。
- **`design/assets/` 只留重画界面要用的手绘原图**：`design/pixel/gen.sh` 的 `ui-<sheet>`（图标、语言 logo 这些整张界面图）和 `look-<look>`（管家的样子）照 `raw/` 里的原图重画，格子和名字不变；`gen.sh`、`prompts/`、`ref-B.png` 留着。手绘画面独有的切图配置、帮工动作图、中间产物、背景、地块和旧字体都删了。
- **旧版农场删掉**：手绘的农场页、它的贴图、指针和字体都不在仓库里，只在 git 历史。

## Alternatives considered

**保留旧版，只是不再维护。** 两套贴图和皮肤分支还在，新东西照样要想两边，没维护的旧版会悄悄坏掉。

**连 `design/assets/` 一起删光。** 像素版的界面图是照手绘原图重画的，加一个图标、一个管家样子还要先画手绘的那张；删了原图就得改像素的生图流程。这次不动那条流程，只删手绘画面独有的。

**把「皮肤」留成一个开关。** 只有一套画面时，开关的唯一取值就是像素，留着它只会让人以为还有别的。

## Consequences

- 一套素材、一处维护：`app/assets/pixel/` 7.7M，`app/assets/cursors/` 212K，`app/assets/fonts/` 4.7M。
- `design/assets/` 从约 230M 变成约 2.8M，只剩界面原图和它们的提示词。
- 以后加画面上的东西只想一套；要新的界面图标，先在 `design/assets/raw/` 那张手绘原图上加，再跑 `design/pixel/gen.sh`。
- Flutter 里只剩像素控件（`app/lib/ui/kit/`），网页时代的手绘组件和它的图只在 git 历史。

## Verification

- `bun run flutter:check`（`flutter analyze` 和 `flutter test`）。
- 图鉴页和农场的图、指针、字都来自 `app/assets/pixel/`、`app/assets/cursors/`、`app/assets/fonts/`；`design/pixel/gen.sh` 的 `ui-*`、`look-*` 能从 `design/assets/raw/` 找到原图。
