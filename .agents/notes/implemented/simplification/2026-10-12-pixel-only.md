# Agent Note: 只留像素村，拿掉手绘的旧版农场和它的图

Status: implemented

> 页面这一半已被取代：网页随 [网页退役](2026-10-14-retire-the-web-page.md) 删掉了，下面 `web/`、`packages/engine` 里的东西和那几条 `pnpm` 检查只在 git 历史里。像素村仍是唯一的农场：Flutter 客户端只有像素的一套图、指针和字体（`app/assets/`）；`design/assets/` 照旧只留界面那几张手绘原图。下面是当时的决策。

## Problem

[像素村](../feature/2026-10-11-pixel-village.md)做好以后，原来手绘的农场（型号 B）留作旧版，在 `#/legacy`。为了两边都能用，页面一直背着两套东西：两套贴图（手绘的 548 张、14M）、两套指针、一个「皮肤」的概念（`site/skin.ts`，配置页跟着上一个农场页穿哪套，记在浏览器里），十来处 `skin() === 'pixel'` 的分支，图鉴里两套图的对照和「缺像素版」，手绘画面专用的寻路轮廓（`legacy/paths.ts`）和调试命令，手绘皮肤的字体（小赖字体、Fredoka）。每加一样画面上的东西都要想两边，而旧版已经没人用。

## Decision

像素村是唯一的农场，整个页面只穿像素皮肤。

- **页面**：删掉 `web/src/legacy/` 和 `#/legacy` 路由、游戏菜单里的「旧版：手绘的农场」、`hb.paths()`。`#/pixel` 照旧通到农场。
- **皮肤**：没有皮肤的概念了。`web/index.html` 写死 `<html data-skin="pixel">`，`index.css` 里 `:root[data-skin='pixel']` 的规则照旧生效；路由的 `staticData` 只说这一页是不是农场。组件里手绘那一支都拿掉，只留像素的（精力瓶、田头的按钮、项目页的日历、农机的 logo、发送按钮）。手绘皮肤的字体不再加载。
- **图**：删掉 `web/src/farm/assets/`（手绘贴图）、`web/src/farm/cursors/`（手绘指针）、`web/src/site/logos/`（手绘皮肤直接用的 LobeHub 原图）。`web/src/farm/sprites.ts` 只读像素的一套；面板和配置页还在用的几个老名字（`<动物>-<衣服>-idle`、`-think`、`-walk-down-1..4`、`backdrop`）照 `pixelName` 对到像素图上，`SpriteName` 的类型把这些名字列出来，调用处不用改。
- **图鉴**：只有一套图、一套指针。
- **`design/assets/`**：删掉只为手绘画面服务的：切图配置（`process.py`）、帮工动作图的生成（`chars.py`、`refs/`）、切出来的中间产物（`keyed/`、`cursor-parts/`）、背景、地块、帮工、徽章和桌面客户端的手绘原图。**留下**界面那几张原图（图标、在做什么、奖章、成就图案、农机、指针、语言 logo、管家的样子）和画它们的 `gen.sh`、`prompts/`、`ref-B.png`：`design/pixel/gen.sh` 的 `ui-<sheet>`、`look-<样子>` 照这些原图重画，格子和名字不变。

## Alternatives considered

**保留旧版，只是不再维护。** 两套贴图和皮肤分支还在，新东西照样要想两边，没维护的旧版会悄悄坏掉。

**连 `design/assets/` 一起删光。** 像素版的界面图是照手绘原图重画的，加一个图标、一个管家样子还要先画手绘的那张；删了原图就得改像素的生图流程。这次不动那条流程，只删手绘画面独有的。

**把 `index.css` 里 `:root[data-skin='pixel']` 的规则拆开并进基础样式。** 改动大、容易漏，收益只是少一个属性选择器。先在 `<html>` 上写死属性。

## Consequences

- 页面包小了一截（手绘贴图约 14M，指针 0.3M，字体）；`design/assets/` 从约 230M 变成约 30M。
- 以后加画面上的东西只想一套。
- `@heybro/engine/react` 里只有手绘画面用过的部件（`Stage` 的缩放、`Pinned`、`HitArea`、`DayBackdrop`、`DayLit`、`useWalker` 等）现在没人用了，还没删。
- `index.css` 的基础样式里还有手绘皮肤时代的值（圆角、软阴影），都被像素皮肤的规则盖住。

## Verification

- `pnpm lint`、`pnpm typecheck`、`pnpm --filter heybro-web build`、`pnpm test`。
- 在构建好的页面上走一遍各路由（`#/`、`#/pixel`、配置页、`#/assets`），农场和图鉴的图都在。
