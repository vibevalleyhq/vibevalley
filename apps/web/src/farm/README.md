# src/farm

The pixel farm at `/`. It is full-bleed, outside the workbench's shell; its 工作台 link goes to `/issues`, and the
shell's 农场 link comes back. The farm is the server's (`useFrames()`, `useCore()` in `src/data/frame.ts`); this folder
only draws it and keeps the page's own state. Its Solid side reads the framework-free modules here through `state.ts`
(`useFarm`, `timeOfDay`, `rawFrame`, `commands`) and `support.ts` (the village, the keys, the phone's calls, the sounds,
the pad).

## Its parts

`FarmPage.tsx` mounts each part's one entry without props (`VillageCanvas`, `Hud`, `Panels`, `ChatWindow`, `IssueView`,
`Phone`, `TitleScreen`, `DebugPanel`): what they need comes from the store, the frame and the commands, so keep them
prop-less.

| Part | Folder | Draws |
|---|---|---|
| The canvas | `canvas/` | the village on Pixi: the map, plots, walking helpers, the dog, light and life, bed effects |
| The HUD and the panels | `hud/`, `panels/` | the bars, quota bottle, island cards, the effects layer; harvest, seed forms, achievements, warehouse, task board, menu |
| The chat and the plot | `chat/`, `issue/` | 田头 (with the call and dictation buttons, `src/voice`), a plot's issue and its work log |
| The phone and the title | `phone/`, `title/` | the farm's phone and its games, the title screen |
| The debug console | `debug/` | ` opens it: the farm's calls, the clock, local effects, the frames seen |

Shared: `world/`, `kit/`, `store.ts`, `commands.ts`, `tools.ts`, `sound.ts`, `effects.ts` (effects made on the page),
`packages/engine`.

Which part draws which overlay (`FarmUi.overlays`):

| Overlay | Drawn by |
|---|---|
| `inspect` (a plot's issue) | `IssueView` |
| `review` (harvest), `sow`, `water`, `panel`, `menu` | `Panels` |
| the chat window (`chatOpen`, `chatLarge`, `chatShown`) | `ChatWindow` (FarmPage puts it at the bottom right) |
| `phoneOpen` | `Phone` (its button sits in the HUD, which calls `farm.phoneOpen(true)`) |
| `titleOpen` | `TitleScreen` (FarmPage mounts it only while open) |
| `bedFx`, `rewards`, hover, names | the canvas draws bed FX over the plots and sets hover; the HUD's FX layer shows rewards |
| the farm's toasts (`kit` `toasts`, `ToastViewport`) | the HUD's FX layer (it passes the medal `leading` and `kicker`) |

## The store (`store.ts`)

`useFarm(select)` (`state.ts`) reads a slice, an accessor that changes only when the slice does; `farmState()` reads it
outside a component; `subscribeFarm(fn)` listens. Changes only through `farm.*`:

| Action | Does |
|---|---|
| `select(sessionId \| null)` | opens / closes a plot's issue (`inspect`) |
| `review(id \| null)`, `sow(station \| null)`, `water(id \| null)` | the harvest, the sowing form, the watering form |
| `panel(FarmPanel \| null)` | `shop`, `warehouse`, `graphs`, `log`, `manager`, `taskBoard` |
| `menu(open)`, `closeTop()` | the Esc menu; closing the top layer (false when none) |
| `openTaskBoard(graph?)`, `showGraph(graph \| null)` | the task board, at a graph |
| `hold(tool)` | the tool in hand (`tools.ts`: hand, water, bug, weed, harvest, shovel; keys 1–6) |
| `hover(bed \| null, spot \| null)` | set by the canvas: the bed and the yard place under the pointer |
| `revealNames(on)` | Alt held: every name tag shows |
| `chatOpen(open)`, `chatLarge(large)`, `showChat(conversation \| null)` | the chat window; null is the general channel |
| `phoneOpen(open)`, `friendsOpen(open)` | |
| `closeTitle()`, `showTitle()` | the title screen; closing it marks this machine as seen (`localStorage` `vibevalley.title.seen`) |
| `bedFx(bed, kind, text?)` | a bed's effect for 2.2 s (`water`, `spray`, `harvest`, `shovel`, `note`); the commands call it |
| `reward(effect)` | a reward for 4 s; FarmPage pushes each frame's rewards |
| `setScreen(screen \| null)` | set by the canvas only (below) |

`clock` is the one day clock (`@vibevalley/engine/clock`, a day is 600 s, starts at 0.42): the canvas advances it every
frame; the HUD reads `timeOfDay()` (changes every five minutes of the day); the debug console calls
`clock.setTimeOfDay(tod)` and `clock.setSpeed(n)` (0 stops it, 60 makes a day ten seconds).

## How the DOM finds things on the canvas

The canvas publishes `FarmUi.screen: VillageScreen | null` (null until it has drawn, replaced when the framing
changes). Everything is in the farm page's CSS pixels, its top left at 0, 0:

- `scale` (screen pixels per art pixel, whole), `box` (the whole village, may stick out), `shown` (the part inside the
  page: lay the HUD out in here);
- `toScreen(artPoint)`; `plotRect(bed)`; `helperAt(sessionId)` (a helper's feet now, undefined when not drawn);
- `onFrame(fn)`: called after every drawn frame, for DOM that follows a walker (a name tag, a bubble). Move such DOM
  with a `transform` in the callback; do not set a signal every frame.

The framing (`world/framing.ts`, `frameVillage`): a whole scale, at most 5% cut off the sides and 8% off
the top and bottom, bars filled with the dimmed map.

## Commands (`commands.ts`)

`commands` (`state.ts`, `farmCommands` over the latest frame) is the `FarmCommands`: `water`, `resolve`, `cure`, `harvest`, `shovel`, `stop`,
`stopManager`, `dismiss`, `plant`, `startQueued`, `aim`, `act`, `split`, `editTask`, `removeTask`, `actOnGraph`,
`actOnTask`, `chooseTitle`, `refreshRuntime`, `enterFarm`. Each calls the API and then plays the bed's effect.
`clickBed(commands, bed)` is a plot click as the farm page does it; `openPlace(place, navigate)` a yard place's click
(a panel, or a workbench page the web page has: `webRoutes`). `fire(promise)`: the server's notice tells a refusal.

## Pieces to build with

- `world/`: `loadVillage()`, and `useVillage()` in `support.ts` (the level and the atlas, fetched once); `VillageWorld` (plots, places,
  props, gate, queue, lawn, lights, fx boxes, `nav`, `goalOf`, `poseOf`, `spotsFor`, `Whereabouts`); `plots.ts` (beds, `plotKey`, `cropOfBed`, `sessionAtStation`, `cropLabel`); `places.ts` (the
  yard places and `FarmPanel`); `hits.ts` (`villageHitAt`, the click order); `sprites.ts` (`SpriteAtlas`: sizes and
  anchors in art pixels, `density` 2, `spriteUrl`); `textures.ts` (`loadTextures`, `texture`: Pixi textures at the
  density); `framing.ts`.
- `kit/`: the pixel components for the DOM over the canvas, from `kit/index.ts`.
- `sound.ts`: `playSound(name)`, `isMuted`/`setMuted`, `farmCues`, the sounds' recipes; `muted()` and `farmSounds(...)`
  (FarmPage runs it) in `support.ts`.
- `tools.ts`: `Tool`, `tools`, `aimTool`, `farmKey`, `bugText`, `managerSprite`.
- `@vibevalley/engine`: `/pixi` (`pixelStage` with `frame`, `Walker`, `frameAt`, particles, critters, light, sky),
  `/nav`, `/audio`, `/clock`.

## Assets

Served from `public/`: `/village.ldtk`, `/pixel/<name>.png` and `/pixel/sprites.json`,
`/cursors/`, `/fonts/fusion-pixel-12px-proportional-zh_hans.otf` (the `font-pixel` family; sharp at 12 and 24 px),
`/title/`. The farm's colours are Tailwind tokens in `src/style.css` (`bg-cream-100`, `border-bark-900`, `text-leaf-600`,
`shadow-px`…).

## Tests

`bun test src/farm` (the world parsed from the real `village.ldtk` and `sprites.json`, the framing, the sounds);
`test/farm.spec.ts` (Playwright on a real server: the canvas, the links; a screenshot at `test-results/farm.png`).
Playwright tests on the farm start past the title screen (`localStorage` `vibevalley.title.seen` = `true`).
