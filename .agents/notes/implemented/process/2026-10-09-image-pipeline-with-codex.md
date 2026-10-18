# Agent Note: 素材用 codex 生图，脚本切图

Status: implemented

## Problem

农场要大量风格一致的素材：背景、田地的十几种状态、7 种动物 × 4 套衣服 × 6 个动作、走路循环、管家、图标、指针。手画不现实；生图工具出的整张图要切成一张张贴图，还要知道每张的落脚点。

## Decision

见 [pixel-village.md](docs/reference/pixel-village.md)「素材」：

- `design/pixel/gen.sh` 用 codex 的生图工具，以先画好的图作参考（地图、角色原图；界面的几张照 `design/assets/raw/` 的手绘原图，按钮图标照 `icons/ref.py` 排好的 Hugeicons 形状），出品红底的整张图到 `design/pixel/raw/`；提示词在 `design/pixel/prompts/`。
- `design/pixel/process.py` 只写「哪张图、几行几列、每格叫什么」，去品红、切格、缩成真正的像素画、算落脚点，存 PNG 到 `app/assets/pixel/`，写 `sprites.json`。最早手绘的一套是 `design/assets/` 的 `gen.sh`、`chars.py`、`process.py` 加 `packages/engine/tools/cut_sheets.py`，存 WebP 到 `web/src/farm/assets/`；手绘画面后来拿掉了，`chars.py`、`process.py`、`cut_sheets.py` 和那些 WebP 都删了，`design/assets/` 只留 `gen.sh`、提示词和界面那几张原图（[只留像素村](.agents/notes/implemented/simplification/2026-10-12-pixel-only.md)）。
- 一张生成图是一只动物穿一套衣服的全部动作，同一个角色在各个动作里长得一样；重新打光（黄昏、夜里）以原图为参考只改光线。

## Alternatives considered

**每个动作单独生成。** 同一只动物在不同动作里长得不一样。

**手切。** 两百多张，换一次图就要重来一遍。

## Consequences

加一套衣服、一个管家样子、一个时刻的背景，都是改清单、跑脚本。代价是生图要 codex 和网络，结果要人看一眼（偶尔要重出）；切好的图进仓库；原图（`design/pixel/raw/`、`design/assets/raw/`）和效果图有四百多 MB，开源前挪到了单独的仓库 vibevalley-art，`design/art.sh` 把它们链接回 `design/`，脚本照常读写。生图不是确定的，原图删了就回不来，所以要留着，只是不让每次克隆都带上。
