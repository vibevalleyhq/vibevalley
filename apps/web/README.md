# apps/web

The page, in Solid 2 (`solid-js`, `@solidjs/web`, pinned to one RC): the workbench every host shows (Electron in
`apps/desktop`, a browser, the phone's WebView). The server serves it at `/` (`vp run start --web ../web/dist` in
`apps/server`), so the page and the API share one origin.

```
src/main.tsx        sends an unpaired remote browser to /pair, then renders App
src/stories.tsx     the stories' page (stories.html, vite.stories.config.ts): every src/**/*.stories.tsx in packages/stories' viewer
src/app/            the wiring: App (the routes, each place a feature's page), Root (router, state frames, the farm's store,
                    the query cache, <Loading>), the shell, places
src/base/           what every layer stands on: the state stream (frames.ts, framework-free; frame.ts, its Solid store), the
                    API client (api.ts), rooms (gateway.ts), the live stream, REST queries (query.ts, agents.ts), external.ts,
                    the router, prefs, the host, saving settings, times and money in words (format.ts), the shared words
src/ui/             the workbench's pieces: Icon, Face, Button, Field, Dialog, Markdown, ToastHost, Segmented, Tabs, Qr, Chips, A
                    (a link), the window strip, the list-and-detail layout (layout.tsx), a helper's look (cast.ts); each with its
                    X.stories.tsx beside it
src/ui/pixel/       the pixel pieces every skin draws with (the farm, the tree, the project map, the catalog): windows, buttons,
                    fields, toasts, the atlas (atlas.ts), the sounds (sound.ts), a runtime's machine
src/features/<x>/   one folder per concept, named as the server's module: issue, task, channel, session, agent, memory,
                    orchestrator, project, runtime, doc, voice, lan, connector, notice, setting, catalog. A feature holds its
                    pages, its reads, its rules (pure, each with its test) and its words; index.ts is what the rest may use
src/farm/           the pixel farm at /, outside the shell (its README: who owns which folder, the store, the canvas's screen)
src/tree/           the memory tree at /tree, outside the shell like the farm: the tree grown from the memories, its panel and the
                    memory sky, on one canvas; made-up
                    memories (mock.ts) until the server sums them up (.agents/notes/proposed/feature/2026-10-22-memory-tree.md)
test/               Playwright against a real server per worker (fixtures.ts); stories.spec.ts serves the built stories instead
```

## Rules

- **The shapes are the protocol's.** Types, schemas and the endpoint table come from `@vibevalley/protocol`
  (`packages/protocol/src/shapes.ts`, `api.ts`); never write a server shape here. A field the page needs and the frame lacks
  is added there and folded by the server.
- **The page does not fold facts.** It reads the folded `StateFrame` (`useCore()`, `useFrames()`); REST reads go through
  Solid Query (`base/query.ts`); a rule of the server (may this be dispatched, what a move means) is asked of the server,
  not rewritten here. Presentation rules (lanes, grouping, ordering, feed merging) are pure functions in the feature they
  belong to (`features/issue/display.ts`, `features/channel/rules.ts`), each with its test.
- **Layers, one way.** `base` → `ui` → `ui/pixel` → `features` → the skins (`farm`, `tree`) → `app`: a file imports from
  its own folder or a layer before it, never after (lint, `vibevalley/page-layers` in `scripts/oxlint-plugin.ts`). A
  feature uses another only through its `index.ts`, named exports only, and the features' graph has no cycle
  (`src/layers.test.ts`). A piece two features both need (a word, a format, a query) goes down to the layer under both,
  or each keeps its own copy of a word; it does not make one feature reach into the other. The skins read features; no
  feature or piece knows a skin. Why: docs/subsystems/app.md, 为什么这样.
- **Words** are in `packages/i18n/locales/{zh,en}/web.<feature>.json`, read as `t("web.<feature>.…")`, following the glossary (docs/README.md#用语);
  farm words only in the skins and `ui/pixel`.
- **Icons come in two sets.** The workbench's are reicon's line icons, one picture to a meaning in `src/ui/icons.ts`
  (`<Icon name="issues" />` takes only names from that table). The pixel skins (`farm`, `tree`, `ui/pixel`) draw theirs
  from `public/pixel` with `SpriteIcon` (the site uses the same files). Faces, runtime logos and illustrations are pixel
  drawings everywhere. No characters stand in for icons.
- **Design tokens.** The workbench's colours, corners, type sizes, shadows, motion and layers are the tokens in
  `src/style.css` (lint: `vibevalley/no-hex-color`, `vibevalley/design-tokens`); which one to pick, the atoms' looks and
  the checklist before handing a page in are in docs/style/design.md. The pixel skins and faces are drawn and keep theirs.
- **Stories.** Every part in `src/ui` (and `src/ui/pixel`) has an `X.stories.tsx` beside it (`src/stories.test.ts`;
  the few without say why there): its states with made-up data, in both themes, at a few widths. A title's first part
  is its level (`src/storyLevels.ts`): 设计体系, 组件, 交互 (parts working together, in `src/stories/`), 界面 (a
  feature's view from made-up data, beside it in the feature). A part that answers the pointer has a `States` story
  with a `grid` (its variants × rest, hover, focus, pressed). There is no server behind the stories: a view that reads
  one is answered by the open story (`answer` in `base/storyApi.ts`), and made-up data shared between stories is a
  `*.samples.ts` beside them (`features/issue/issue.samples.ts`); neither is imported by the product. `vp run --filter
  @vibevalley/web stories` serves them; `build:stories` (in `web:check`) builds them to `dist-stories/`, never into
  `dist/`; `test/stories.spec.ts` opens each in its themes with axe. A part that reads the page's data to draw itself is
  split so its drawing takes arguments (`Shortcuts` in `ShortcutSheet.tsx`). The format and the viewer are
  `packages/stories`.
- **App icons** are in `public/icons/`: `app-32.png`, `app-64.png` and `app-256.png`. The site build copies these packaged
  files; it does not keep another set.
- **The host** (`@vibevalley/protocol/host`, found by `currentHost()` in `src/base/host.ts`) is the only way to the machine; a capability that is null is not drawn.
- **Solid 2, not 1.x and not React.** The package ships its own guide (`node_modules/solid-js/CHEATSHEET.md` and
  `skills/`); `vp check` runs `eslint-plugin-solid`'s v2 rules over `src`. What this page adds to it:
  - `base/query.ts` adapts TanStack's `QueryObserver` snapshots to Solid signals. Pending reads never suspend state-frame
    updates. Read successful data through `ready(query, fallback)`; `placeholderData` controls a key switch's previous value.
  - A `<Show>` or `<Match>` function child gets an accessor that throws once the branch closes; a computation still
    settling then (a query in the branch) halts every update on the page. A branch holding queries is keyed by a plain
    value (`<Show when={x()?.id} keyed>`) and looks its object up itself, keeping the last one found.
  - A `ref` callback does not read a `<For>` item's accessor; read the key once (`untrack`) before.
  - A framework-free store (the frames, the farm's store, toasts, the call) comes in through `createExternal`. Code that
    compares one frame with the one before (sounds, the canvas, the phone's calls) reads `rawFrame()`; the UI reads the
    store, reconciled by id, which updates only what changed.
  - A component runs once: what changes on its own (the window's size, the time) needs a signal (`useViewport`, `useNow`).
- **Styles** are Tailwind with the tokens in `src/style.css` (`bg-page`, `text-muted`, `border-line`, `bg-selected`,
  `text-accent`…); comments in English, only for what the code cannot say.

## Commands

```bash
vp run build    # dist/ (types, lint and format: vp check at the root)
vp run test     # vitest for the rules
vp run e2e      # builds dist, then Playwright: one server per worker with a temporary home and no keys;
                # an error that escapes the page fails its test
vp run e2e:dev  # the same on Solid's development build: its diagnostics (an untracked read, a primitive made where it
                # may not be, a computation tracking thousands of sources) go to the output, with the stack that made each
vp exec playwright test test/issues.spec.ts   # one file
```
