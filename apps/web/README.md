# apps/web

The page, in Solid 2 (`solid-js`, `@solidjs/web`, pinned to one RC): the workbench every host shows (Electron in
`apps/desktop`, a browser, the phone's WebView). The server serves it at `/` (`vp run start --web ../web/dist` in
`apps/server`), so the page and the API share one origin.

```
src/main.tsx      sends an unpaired remote browser to /pair, then renders App
src/app/          App (the routes), Root (router, state frames, the farm's store, the query cache, <Loading>), the router,
                  A (a link), the shell, Follow (the bell, the tray, the voice shortcut), util (Keyed, aria, useNow, …)
src/data/         what comes from the server: the state stream (frames.ts, framework-free; frame.ts, its Solid store), the
                  API client (api.ts), the live stream (live.ts), REST queries (query.ts, agents.ts, issues.ts), external.ts
src/ui/           pieces every page uses: Icon, Face, Button, Field, Dialog, Markdown, ToastHost, Segmented, Qr, Chips
src/rules/        pure functions the pages share (what a lane holds, how a feed is ordered, a round's waterfall), each with its test
src/pages/<place>/  one folder per place: issues, chat, docs, settings, orchestrator, agents, runtimes, projects, catalog; kit.tsx is their layout
src/voice/        the call to the orchestrator (Agora), its captions, and dictation
src/farm/         the pixel farm at /, outside the shell (its README: who owns which folder, the store, the canvas's screen)
src/tree/         the memory tree at /tree, outside the shell like the farm: the tree grown from the memories, its panel and the
                  memory sky, on one canvas; made-up
                  memories (mock.ts) until the server sums them up (.agents/notes/proposed/feature/2026-10-22-memory-tree.md)
test/             Playwright against a real server per worker (fixtures.ts)
```

## Rules

- **The shapes are the protocol's.** Types, schemas and the endpoint table come from `@vibevalley/protocol`
  (`packages/protocol/src/shapes.ts`, `api.ts`); never write a server shape here. A field the page needs and the frame lacks
  is added there and folded by the server.
- **The page does not fold facts.** It reads the folded `StateFrame` (`useCore()`, `useFrames()`); REST reads go through
  Solid Query (`data/query.ts`); a rule of the server (may this be dispatched, what a move means) is asked of the server,
  not rewritten here. Presentation rules (lanes, grouping, ordering, feed merging) live in `src/rules/` as pure functions.
- **Words** are the farm's (docs/README.md#用语), in Chinese.
- **Icons are the pixel drawings** (`<Icon name="icon-tasks" />`, from `public/pixel`; the site uses the same files); no line icons,
  no characters standing in for icons.
- **App icons** are in `public/icons/`: `app-32.png`, `app-64.png` and `app-256.png`. The site build copies these packaged
  files; it does not keep another set.
- **The host** (`@vibevalley/protocol/host`, found by `currentHost()` in `src/host.ts`) is the only way to the machine; a capability that is null is not drawn.
- **Solid 2, not 1.x and not React.** The package ships its own guide (`node_modules/solid-js/CHEATSHEET.md` and
  `skills/`); `vp check` runs `eslint-plugin-solid`'s v2 rules over `src`. What this page adds to it:
  - `data/query.ts` adapts TanStack's `QueryObserver` snapshots to Solid signals. Pending reads never suspend state-frame
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
