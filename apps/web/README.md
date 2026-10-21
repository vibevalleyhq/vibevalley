# apps/web

The React page: the workbench every host shows (Electron in `apps/desktop`, a browser, later the phone). The server
serves it at `/` (`npm start -- --web ../web/dist` in `apps/server`), so the page and the API share one origin.

```
src/main.tsx      the providers and the routes
src/app/          the shell: the bar of places, and Follow (the bell, the tray, the voice shortcut)
src/data/         what comes from the server: the state stream (frame.tsx), the API client and REST queries (api.ts, agents.ts, projects.ts)
src/ui/           pieces every page uses: Icon, Face, Button, Field, Dialog, Markdown, Toast, Segmented, Qr, Chips
src/rules/        pure functions the pages share (what a lane holds, how a feed is ordered, a round's waterfall), each with its test
src/pages/<place>/  one folder per place: issues, chat, docs, settings, manager, agents, runtimes, projects, catalog; kit.tsx is their layout
src/voice/        the call to the manager (Agora), its captions, and dictation
src/farm/         the pixel farm at /, outside the shell (its README: who owns which folder, the store, the canvas's screen)
test/             Playwright against a real server per worker (fixtures.ts)
```

## Rules

- **The shapes are the protocol's.** Types, schemas and the endpoint table come from `@vibevalley/protocol`
  (`packages/protocol/src/shapes.ts`, `api.ts`); never write a server shape here. A field the page needs and the frame lacks
  is added there and folded by the server.
- **The page does not fold facts.** It reads the folded `StateFrame` (`useCore()`, `useFrames()`); REST reads go through
  TanStack Query; a rule of the server (may this be dispatched, what a move means) is asked of the server, not rewritten here.
  Presentation rules (lanes, grouping, ordering, feed merging) live in `src/rules/` as pure functions.
- **Words** are the farm's (docs/README.md#用语), in Chinese.
- **Icons are the pixel drawings** (`<Icon name="icon-tasks" />`, from `public/pixel`; the site uses the same files); no line icons,
  no characters standing in for icons.
- **The host** (`@vibevalley/host`, `currentHost()`) is the only way to the machine; a capability that is null is not drawn.
- **Styles** are Tailwind with the tokens in `src/style.css` (`bg-page`, `text-muted`, `border-line`, `bg-selected`,
  `text-accent`…); comments in English, only for what the code cannot say.

## Commands

```bash
bun run check   # types
bun run build   # dist/
bun run test    # bun test for the rules, then Playwright: builds dist, one server per worker with a temporary home and no keys
bunx playwright test test/issues.spec.ts   # one file
```
