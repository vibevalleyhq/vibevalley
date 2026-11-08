# apps/web

The page, in Solid 2 (`solid-js`, `@solidjs/web`, pinned to one RC): the workbench every host shows (Electron in
`apps/desktop`, a browser, the phone's WebView). The server serves it at `/` (`vp run start --web ../web/dist` in
`apps/server`), so the page and the API share one origin.

```
src/main.tsx        sends an unpaired remote browser to /pair, then renders App
src/stories.tsx     the stories' page (stories.html, vite.stories.config.ts): every src/**/*.stories.tsx in packages/stories' viewer
src/app/            the wiring: App (the routes, each place a feature's page), Root (router, state frames, the farm's store,
                    the query cache, <Loading>), the shell, places
src/base/           the pure ground, touching nothing outside: times and money in words (format.ts), ordering and matching
                    (search.ts), typed marks (typedMarks.ts), the shortcut table, small Solid helpers (dom.tsx; external.ts: a framework-free store as
                    a signal)
src/infra/          what talks to the outside: the state stream and live stream (frame.ts: the stream itself, framework-free, opened again
                    when even the server's heartbeat stops coming, and its Solid store), the API client (api.ts, with request keys), rooms (gateway.ts), REST queries (query.ts,
                    agents.ts), saving settings, the host, the app's updates, the router (router/: history, matching and nested layouts), the
                    opening cover (opening.ts), the stories' fake server (storyApi.ts)
src/state/          the middle layer on Effect's Atom: atom.ts (the page's registry, useAtom, the page's values as
                    defineAtom, the frames as an atom, the newest answer of a read asked again as useLatest), stored.ts (a choice
                    kept on this machine: defineStored, the only door to the browser's storage), prefs.ts and
                    appearance.ts (this machine's choices and the look they give), intent.ts (what the owner asked for
                    until the frame shows it), the tests' registry
                    (testing.ts)
src/ui/             the workbench's pieces: Icon, Face, Button, Field, Dialog, Markdown, ToastHost, Segmented, Tabs, Qr, Chips,
                    an owner's act (act.ts), the window strip, the list-and-detail layout (layout.tsx), a
                    helper's look (cast.ts); each with its X.stories.tsx beside it
src/ui/pixel/       the pixel pieces every skin draws with (the farm, the tree, the repo map, the catalog): windows, buttons,
                    fields, toasts, the atlas (atlas.ts), the sounds (sound.ts), a runtime's machine
src/features/<x>/   one folder per concept, named as the server's module: issue, channel, session, agent, memory,
                    orchestrator, repo, runtime, artifact, pkm, voice, lan, connector, inbox, setting, catalog. A feature holds its
                    pages, its reads, its rules (pure, each with its test) and its words; index.ts is what the rest may use
src/farm/           the pixel farm at /farm, inside the shell (its README: who owns which folder, the store, the canvas's screen)
                    and map/, the repos page's map: app/ hands it to features/repo as its ReposSkin
src/tree/           the memory tree at /tree, outside the shell: the tree grown from the memories, its panel and the
                    memory sky, on one canvas; made-up
                    memories (mock.ts) until the server sums them up (.agents/notes/proposed/feature/2026-10-22-memory-tree.md)
test/               Playwright：组件（stories-fixtures.ts）、真实集成（fixtures.ts）、audit、visual；projects.ts 分配入口
```

## Rules

- **The shapes are the protocol's.** Types, schemas and the endpoint table come from `@vibevalley/protocol`
  (`packages/protocol/src/shapes.ts`, `api.ts`); never write a server shape here. A field the page needs and the frame lacks
  is added there and folded by the server.
- **The page does not fold facts.** It reads the folded `StateFrame` (`useCore()`, `useFrames()`); REST reads go through
  the owned, Schema-decoded Query client (`infra/query.ts`); a rule of the server (may this be dispatched, what a move means) is asked of the server,
  not rewritten here. Presentation rules (lanes, grouping, ordering, feed merging) are pure functions in the feature they
  belong to (`features/issue/display.ts`, `features/channel/places.ts`), each with its test.
- **What the owner does goes through the middle layer.** A change the page shows before the server has it is an
  intent (`state/intent.ts`): `defineIntent({ send, confirmed, watch?, whileLost, timeoutMs })`, kept by its request key
  in an atom family, so it outlives the component that made it. It settles when what the owner sees shows the change
  (`bySeq`: a frame whose `seq` is at least the reply's; or the kind's own check, as a line's `sendKey` in its channel),
  never on the reply or a timer; a timeout or a refusal leaves it `failed`, to retry with the same key or let go; while
  the state stream is lost a keyed kind queues and sends once it is back. A feature shows its intents through a pure
  overlay of its own that sets only the field the owner set (`features/issue/moves.ts`'s `movedCards`), with its test.
  A setting changed again before the first showed replaces it (`sendReplacing`). A change with nothing to show before
  the server has it is an Act (`createAct()` in `ui/act.ts`, `createPixelAct()` in `ui/pixel` for the skins): busy until
  it ends however it ends, a refusal in the error tone, and while the state stream is lost it is not sent but refused
  with that reason. A thing the owner may send again (a form's create) keeps one request key until it went through
  (`createRequestKey`, `infra/api.ts`). In a component (a `.tsx` under `features/` or `farm/`) a call of the client that
  changes something is made inside an Act's `run` or through an intent defined in the feature's `.ts` (lint
  `vibevalley/act-door`), and a refusal toast without the error tone is reported (`vibevalley/failure-tone`). A read
  asked again as the owner types or the place changes (a search, a channel's pins) shows only the answer to the newest
  ask, a failure as a failure (`useLatest`, `state/atom.ts`); the REST reads are read again when the state stream comes
  back (`refetchOnRelink`). Only `src/state` imports `effect/reactivity` (lint `vibevalley/atom-door`): its API is
  unstable, so a change in it is fixed there. Why: docs/subsystems/app.md, 为什么这样.
- **What the page keeps, it keeps one way.** A value that outlives a component (a dialog two places open, the farm's
  overlays, a draft, the toasts) is an atom of the page's: `const x = defineAtom(initial)` (`state/atom.ts`), read with
  `x.get()` anywhere (inside Solid it follows), written with `x.set`/`x.update`, heard from plain code with
  `x.subscribe`. A choice kept on this machine is `defineStored(name, schema, fallback)` (`state/stored.ts`, on Atom's
  `kvs`): the key is `vibevalley.<name>`, what does not decode reads as the fallback (`orFallback` per field of a
  struct), a storage that throws keeps it for the page's life, and every reader, in this tab and the others, hears a
  change. A choice worth a link or a reload goes in the address (`useSearchParam` in `infra/router.ts`: the board's
  repo and helper); a passing one (the words in a search box) stays a signal in its component. A `createSignal` or
  `createStore` made outside any function in `features/`, `farm/` or `ui/` is reported (lint `vibevalley/page-store`),
  and so is `localStorage` or `sessionStorage` anywhere but `state/stored.ts` (`vibevalley/stored-door`). What moves on
  its own (the state stream's source, the live stream, the day clock, the textures loading, the phone's calls, the
  call, dictation, the MOSS line, the block editor's queue) stays a framework-free store read through `createExternal`.
- **Layers, one way.** `base` → `infra` → `state` → `ui` → `ui/pixel` → `features` → the skins (`farm`, `tree`) → `app`:
  a file imports from its own folder or a layer before it, never after (lint, `vibevalley/page-layers` in
  `scripts/oxlint-plugin.ts`). A file goes by what it is: pure (no server, host, browser history or storage) in `base`;
  talking to the outside in `infra`; standing on Atom in `state`. A `base` file that needs an `infra` one moves up, or
  what it needs moves down. A
  feature uses another only through its `index.ts`, named exports only, and the features' graph has no cycle
  (`src/layers.test.ts`). A piece two features both need (a word, a format, a query) goes down to the layer under both,
  or each keeps its own copy of a word; it does not make one feature reach into the other. The skins read features; no
  feature or piece knows a skin: a workbench page that shows a piece of a skin takes it as a prop, and `app/` passes
  it in (`ReposSkin`, from `farm/map`). Why: docs/subsystems/app.md, 为什么这样.
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
  one is answered by the open story (`answer` in `infra/storyApi.ts`), and made-up data shared between stories is a
  `*.samples.ts` beside them (`features/issue/issue.samples.ts`); neither is imported by the product. A view tied to a
  device or a global (the microphone, a socket, the call) is split so its look takes props, and the stories draw that:
  `DictationMark`, `MossVerifyView`, `MossLineView`, `OrchestratorLine`. `vp run --filter
  @vibevalley/web stories` serves them; `build:stories` (in `web:check`) builds them to `dist-stories/`, never into
  `dist/`; `test/stories-a11y.spec.ts` 检查每个故事在双主题下的 axe 结果，`test/stories.spec.ts` 只验证组件接线。 A part that reads the page's data to draw itself is
  split so its drawing takes arguments (`Shortcuts` in `ShortcutSheet.tsx`). The format and the viewer are
  `packages/stories`.
- **App icons** are in `public/icons/`: `app-32.png`, `app-64.png` and `app-256.png`. The site build copies these packaged
  files; it does not keep another set.
- **The host** (`@vibevalley/protocol/host`, found by `currentHost()` in `src/infra/host.ts`) is the only way to the machine; a capability that is null is not drawn.
- **Solid 2, not 1.x and not React.** The package ships its own guide (`node_modules/solid-js/CHEATSHEET.md` and
  `skills/`); `vp check` runs `eslint-plugin-solid`'s v2 rules over `src`. What this page adds to it:
  - `infra/query.ts` owns the request cache and binds snapshots to Solid accessors. Every definition requires a result
    Schema; external responses decode before success. Pending reads never suspend state-frame updates. `ready(query,
    fallback)` reads cached data; `keepPrevious` exposes the previous key and value separately through `previous()`.
    The [infra contracts](apps/web/src/infra/README.md) cover Query, Router, Schema forms and Schema-derived table columns.
  - A `<Show>` or `<Match>` function child gets an accessor that throws once the branch closes; a computation still
    settling then (a query in the branch) halts every update on the page. A branch holding queries is keyed by a plain
    value (`<Show when={x()?.id} keyed>`) and looks its object up itself, keeping the last one found.
  - A `ref` callback does not read a `<For>` item's accessor; read the key once (`untrack`) before.
  - A framework-free store (the frames, the call, dictation) comes in through `createExternal`. Code that
    compares one frame with the one before (sounds, the canvas, the phone's calls) reads `rawFrame()`; the UI reads the
    store, reconciled by id, which updates only what changed.
  - A component runs once: what changes on its own (the window's size, the time) needs a signal (`useViewport`, `useNow`).
- **Styles** use StyleX with the existing CSS tokens in `src/style.css`; typed composition and native-style ownership follow
  [vv-stylex](.agents/skills/vv-stylex/SKILL.md). Reset, fonts and owned rich-text descendants remain in CSS imported through
  the host stylesheet. Remaining Tailwind consumers and final acceptance are tracked in the
  [migration Note](.agents/notes/proposed/architecture/2026-11-08-tailwind-to-stylex.md). Comments are in English, only for what the code cannot say.

## Commands

```bash
vp run build    # dist/ (types, lint and format: vp check at the root)
vp run test     # vitest for the rules
vp run e2e:component                         # 组件 DOM / owner 接线，只构建故事，不启动业务服务端
vp run e2e:integration 'test/issues.spec.ts$'  # 真实 HTTP/SSE 接线，只构建应用；文件参数是正则，$ 避免同名后缀匹配
vp run e2e:audit                             # 全故事与全页面双主题无障碍检查
vp run e2e:visual                            # 农场昼夜截图，须看图，不是行为断言
vp run e2e                                   # 组件 + 集成 + audit 的全量自动检查，不含纯截图
VIBEVALLEY_WEB_DEV=1 vp run e2e:component      # 同一入口用 Solid 开发版构建，输出响应式诊断及调用栈
vp run e2e:dev                               # 全量自动检查的 Solid 开发版
```

各入口使用自己的 Playwright 配置，构建到 `.test/run-<pid>/`，结束或构建失败后清理；不读取旧 `dist/`。定点运行选对应入口，再加文件或 `--grep`；在全量入口加筛选仍准备全量入口的产物。组件 fixture 没有 `api` 和 `server`，公共的 `browser.ts` 负责页面异常和开发版诊断。真实集成用临时家目录、去掉密钥的环境和脚本化帮工；空农场等前提用 `test.use({ farm: "文件的名字" })` 隔离。

`test/projects.test.ts` 检查每个 spec 恰好属于一个项目，以及各入口需要的构建。报告按项目列累计耗时，audit 以 `test.step("audit: …")` 记录每个场景；不能把累计值当成墙钟。完整的分层职责与删除条件见 [测试金字塔](docs/subsystems/foundation.md#测试金字塔)。
