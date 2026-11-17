# 共用的原语

由 `scripts/gen/primitives.ts` 从各地基文件夹的导出和它们文档注释的第一行写出，不手改；`vp run docs:verify` 查它是不是最新。写一个帮手之前先在这里找一找：已经有的就用，不再写一份。类型不列。

## `packages/protocol/src/rules`

规则：服务端和页面都跑的纯函数

| 名字 | 文件 | 说的是 |
|---|---|---|
| `defaultOf` | `channel.ts` | The channel words go to when none is named. |
| `channelOf` | `channel.ts` | A channel by its id; none when no id is given. |
| `actorRoleOf` | `channel.ts` | The agent's role when an actor is an agent; undefined for the user or the system. |
| `mentionLead` | `channel.ts` | What an @name may follow: anything but a Latin letter, a digit, _ or @, so a@b.com names no one while cjk@w3 does (Chinese runs on without spaces). |
| `oneLine` | `cut.ts` | Runs of white space are one space. |
| `htmlSandbox` | `display.ts` | The <iframe>'s sandbox attribute; the server's CSP sandbox directive is the same tokens. |
| `freshOf` | `inbox.ts` | The items of now that are news to known: undefined known is the first look, which knows them all and has no news. An id is news once. |
| `issueScopeOf` | `issues.ts` | The issue a session is working on or drafting, if any. |
| `assignedAgentOf` | `issues.ts` | The agent currently responsible for the issue, if any. |
| `executionsOf` | `issues.ts` | Every execution, in assignment and start order. |
| `sessionIdsOf` | `issues.ts` | The external helper contexts that executed it, in order. |
| `latestSessionIdOf` | `issues.ts` | The latest helper context that executed the issue, if any. |
| `shortTitle` | `issues.ts` | One short line for a title: its first line, and of a long one, the first sentence, else up to its last pause that fits. failing those, cut. |
| `closedText` | `issues.ts` | What its close says: done with what it delivered, or canceled and why. |
| `omitUndefined` | `omit.ts` |  |
| `isOneOf` | `oneOf.ts` |  |
| `validKey` | `order.ts` |  |
| `keyBetween` | `order.ts` | A key after a and before b; "" for a is the start, "" for b the end. |
| `isBusy` | `phase.ts` | It takes one of the places for those working at once. |
| `roomLeft` | `phase.ts` | How many more may start working now: on the whole farm (space at once), and in the repo (perRepo at once, 0 for no limit of its own). |
| `phaseText` | `phase.ts` | The server's words for what the session is doing, how long it has been quiet filled in by the clock. |
| `plainText` | `plain.ts` |  |
| `farmOf` | `play.ts` | The farm a session's bed is on: each repo has its own, and the sessions without one share one. |
| `plotKeyOf` | `play.ts` | The plot a session works, the key of `FarmView.plots`: its issue, so a reopened issue keeps its plot; one with no issue is its own. |
| `githubRepository` | `repo.ts` | Only repository home URLs: never credentials, other git transports or command-line options. |
| `same` | `same.ts` |  |
| `stageWantsUser` | `stage.ts` | Questions the user for something: the page leads with it, the board flags it. |

## `apps/web/src/base`

页面的纯地基

| 名字 | 文件 | 说的是 |
|---|---|---|
| `autofocus` | `dom.tsx` | A ref that focuses its element once it is on the page: what React's autoFocus does on mount. |
| `useNow` | `dom.tsx` | The time, a new reading every `ms`: for "3m ago" that keeps up without anything else changing. |
| `Keyed` | `dom.tsx` | Rebuilds its children whenever `key` changes, as a React key does: their state starts over. |
| `aria` | `dom.tsx` | aria-expanded, aria-pressed, aria-selected: "true" or "false", as a boolean false would drop the attribute. |
| `useViewport` | `dom.tsx` | The window's size, following it as it is resized. |
| `createSettled` | `dom.tsx` | The value once it has stopped changing for `ms`: what is asked of the server while someone types. |
| `useClickAway` | `dom.tsx` | Closes a popup when the pointer goes down outside `box` while `open`: a menu folds when you click elsewhere. |
| `variant` | `dom.tsx` |  |
| `createExternal` | `external.ts` | A store outside Solid (subscribe, get) as an accessor. it notifies when `get` returns a different value. |
| `ago` | `format.ts` |  |
| `tookText` | `format.ts` |  |
| `wallClockText` | `format.ts` |  |
| `numberText` | `format.ts` | A whole number without its .0, as the server writes ids and counts. |
| `momentText` | `format.ts` | A moment as a date and a time of day. |
| `yuan` | `format.ts` |  |
| `big` | `format.ts` | A large count: ten thousands in Chinese (10k units), thousands in English (12k). |
| `spentText` | `format.ts` |  |
| `messageOf` | `format.ts` | What a thrown or rejected value says: an Error's message, anything else as text. |
| `spanText` | `format.ts` | How long, in round words: rounded relative duration. |
| `isObject` | `guards.ts` | Not null, not an array: a record to read keys of. |
| `isObjectOrArray` | `guards.ts` | An object or an array. |
| `SpriteManifest` | `manifests.ts` |  |
| `CursorManifest` | `manifests.ts` |  |
| `pinyinLoaded` | `search.ts` | Settles once pinyin matches too (tests wait on it). |
| `spelled` | `search.ts` | The text holds the query, ignoring case, or spells it in pinyin; query is lower case. |
| `matches` | `search.ts` | Every word of the query is somewhere in the texts (spelled), ignoring case; an empty query matches everything. |
| `compareText` | `search.ts` |  |
| `or` | `search.ts` |  |
| `shortcutPlaces` | `shortcuts.ts` |  |
| `shortcuts` | `shortcuts.ts` |  |
| `keyCap` | `shortcuts.ts` | A key's cap on the sheet. |
| `inField` | `shortcuts.ts` |  |
| `pressed` | `shortcuts.ts` | The chords matched here (mod+K, ?, C): the rest are each place's own. |
| `useInterval` | `timer.ts` | fn every ms for as long as the reactive owner lives. |
| `useTimeout` | `timer.ts` | A timeout to set from a handler: setting it again replaces the one waiting, and the reactive owner's end clears it. |
| `typedMarks` | `typedMarks.ts` | The text with the marks just typed before the caret as the syntax they stand for. undefined when there are none. |

## `apps/web/src/infra`

页面对外的地基：服务端、宿主、浏览器

| 名字 | 文件 | 说的是 |
|---|---|---|
| `useWorkAgents` | `agents.ts` | The profiles work is sent to, the helpers; enabled, only those not switched off. |
| `useOrchestrators` | `agents.ts` | The orchestrators' profiles, the default one first. |
| `orchestratorLookOf` | `agents.ts` | An orchestrator's look (its sprites are manager-<look>); the plain farmer until the profiles are read. |
| `useAgent` | `agents.ts` | A profile by its id, once the profiles are read; undefined for none or one gone. |
| `useAgentProblems` | `agents.ts` |  |
| `ApiConnectionError` | `api.ts` | The server could not be reached at all. |
| `api` | `api.ts` | The page is served by the server it talks to: the same origin. |
| `reasonOf` | `api.ts` | What a refusal says, for a toast or an inline line. |
| `faultOf` | `api.ts` | The fault a refusal or connection failure carries. |
| `newSendKey` | `api.ts` | A client's key for one send: a retry with the same key is the same message, said once. |
| `createRequestKey` | `api.ts` | The request key of one thing the user may send again (a form's create, a button's). a new one after. |
| `attachmentData` | `attachment.ts` | A file's bytes as attachment.create takes them: base64. |
| `useForm` | `form.ts` |  |
| `createForm` | `form/form.ts` |  |
| `formIssues` | `form/issues.ts` | Zod's issues as the form tells them; read with `reportInput`, so a missing key is told apart from a wrong type. The |
| `at` | `form/paths.ts` |  |
| `at` | `form/paths.ts` |  |
| `replace` | `form/paths.ts` |  |
| `replace` | `form/paths.ts` |  |
| `immutable` | `form/paths.ts` |  |
| `frames` | `frame.ts` |  |
| `FramesContext` | `frame.ts` |  |
| `createFrames` | `frame.ts` | A frame source as a store: each frame reconciles in by id, so only what changed updates. |
| `useFrames` | `frame.ts` |  |
| `useCore` | `frame.ts` | The folded state. undefined until the first frame. |
| `orchestratorSession` | `frame.ts` |  |
| `orchestratorMood` | `frame.ts` |  |
| `rawFrame` | `frame.ts` | The frame as the stream sent it: a new object each time, for code that compares the one before with the one after (sounds, the canvas, the host's notices). |
| `subscribeLive` | `frame.ts` | Listens to the live stream (/api/v1/live). returns how to stop. |
| `reconnectDelayMs` | `gateway.ts` | The wait before connecting again after a connection could not be opened: 500 ms, growing by half each time, at most 5 s. |
| `subscribe` | `gateway.ts` | Each event of one subscription (its `subscriptionUrl`, each event decoded with its `event` Schema) until stop() is |
| `followChannel` | `gateway.ts` | What is said in a channel after the message numbered after, then from now on. |
| `followReports` | `gateway.ts` | The farm's reports after the one with this id (the newest when absent), then each from now on. |
| `followArtifact` | `gateway.ts` | A blocks artifact's changes after this seq, then each batch from now on. |
| `followSuggestions` | `gateway.ts` | An artifact's suggestions as they now are, then the whole list after each change. |
| `currentHost` | `host.ts` |  |
| `nextLocalMidnight` | `local-day.ts` |  |
| `localDay` | `local-day.ts` |  |
| `uploadMediaInput` | `media.ts` |  |
| `reveal` | `opening.ts` |  |
| `retryRead` | `query.ts` |  |
| `refetchOnRelink` | `query.ts` |  |
| `cursorsQuery` | `query.ts` |  |
| `agentsQuery` | `query.ts` |  |
| `templatesQuery` | `query.ts` |  |
| `reposQuery` | `query.ts` |  |
| `providerQuery` | `query.ts` |  |
| `settingsQuery` | `query.ts` |  |
| `runtimesQuery` | `query.ts` |  |
| `achievementsQuery` | `query.ts` |  |
| `useSprites` | `query.ts` |  |
| `useAgents` | `query.ts` |  |
| `useAgentTemplates` | `query.ts` |  |
| `useRepos` | `query.ts` |  |
| `useSettings` | `query.ts` |  |
| `useRuntimes` | `query.ts` |  |
| `waitForReads` | `query/activity.ts` |  |
| `defineQuery` | `query/cache.ts` |  |
| `createQueryClient` | `query/cache.ts` |  |
| `QueryDecodeError` | `query/schema.ts` | A response that is not in the query's shape. Carries none of the issues: they can contain credentials. |
| `queryDecoder` | `query/schema.ts` |  |
| `useQueryClient` | `query/solid.tsx` |  |
| `QueryProvider` | `query/solid.tsx` |  |
| `useQuery` | `query/solid.tsx` |  |
| `ready` | `query/solid.tsx` |  |
| `fixOf` | `readiness.ts` | What a feature lacks, in words, and the settings page that fixes it (SettingsStatus.readiness says what lacks). |
| `useRouter` | `router/context.tsx` |  |
| `Router` | `router/context.tsx` |  |
| `useLocation` | `router/context.tsx` |  |
| `useParams` | `router/context.tsx` |  |
| `useSearchValues` | `router/context.tsx` |  |
| `useSearch` | `router/context.tsx` |  |
| `useSearchParams` | `router/context.tsx` |  |
| `internalUrl` | `router/history.ts` |  |
| `linkHref` | `router/history.ts` |  |
| `browserHistory` | `router/history.ts` |  |
| `memoryHistory` | `router/history.ts` |  |
| `updateSearch` | `router/history.ts` |  |
| `Link` | `router/link.tsx` |  |
| `NavLink` | `router/link.tsx` |  |
| `Navigate` | `router/link.tsx` |  |
| `pathSegments` | `router/matching.ts` |  |
| `route` | `router/matching.ts` |  |
| `route` | `router/matching.ts` |  |
| `route` | `router/matching.ts` |  |
| `compareRoutes` | `router/matching.ts` |  |
| `ambiguousRoutes` | `router/matching.ts` |  |
| `useMatches` | `router/routes.tsx` |  |
| `Routes` | `router/routes.tsx` |  |
| `Outlet` | `router/routes.tsx` |  |
| `attemptCodec` | `router/search.ts` | A decode or an encode, or undefined when it fails; a Schema that decodes asynchronously never admits a value. |
| `searchParam` | `router/search.ts` | One value of a search key, read with `schema`: a key given twice does not decode. |
| `search` | `router/search.ts` |  |
| `useSaveSettings` | `settings.ts` | Saves, and the settings the server answers with are the cached ones from then on. |
| `useUpdates` | `settings.ts` | The desktop's own update as it is now and as it changes (Host.update); undefined where the host is not updated from |
| `answer` | `storyApi.ts` | What the server answers while this story is open, by the path after /api/v1/ ("issue/diff/get"). Unanswered calls fail as a server that is not there would. |
| `fakeFetch` | `storyApi.ts` |  |
| `useTable` | `table.ts` |  |
| `defineColumns` | `table/model.ts` |  |
| `createTable` | `table/model.ts` |  |
| `testFrames` | `testing.ts` |  |
| `frameAt` | `testing.ts` | An empty farm's frame at this seq. |

## `apps/web/src/state`

页面的中间层：意图、存下的选择、原子

| 名字 | 文件 | 说的是 |
|---|---|---|
| `atom` | `atom.ts` |  |
| `Registry` | `atom.ts` | Where atoms' values live: the page's one, or a test's or a story's own. |
| `createRegistry` | `atom.ts` |  |
| `pageRegistry` | `atom.ts` | The page's one registry. |
| `RegistryContext` | `atom.ts` | Every atom's value lives in one registry for the page; the page's own unless a test or a story gives another. |
| `useRegistry` | `atom.ts` |  |
| `useAtom` | `atom.ts` | An atom's value as an accessor: subscribed while the component lives, never suspending. |
| `onPage` | `atom.ts` | The atom held for the registry's life, built and subscribed lazily on first access rather than at module import. |
| `usePageAtom` | `atom.ts` | Binds a page atom's reads and writes to the active `RegistryContext`, for component callbacks in tests and stories. |
| `defineAtom` | `atom.ts` | A value of the page's that lasts until it closes (a dialog the shell and a page both open, the farm's overlays). |
| `framesSource` | `atom.ts` |  |
| `linkIn` | `atom.ts` | Whether the state stream is up now, read from its source: subscribing would open and close the stream. |
| `framesIn` | `atom.ts` | The registry's frames now. |
| `subscribeFrames` | `atom.ts` | Hears each frame of the registry's source, and follows the source when a test swaps it; the stream stays open meanwhile. |
| `latestReader` | `atom.ts` | The answer to the newest ask only, a failure told as a failure rather than "nothing found". |
| `useLatest` | `atom.ts` | The answer to the newest `key()` while the component lives; undefined while there is nothing to ask. |
| `bySeq` | `intent.ts` | A reply that carries the seq of the fold with its change (an issue moved): shown once a frame has caught up. |
| `defineIntent` | `intent.ts` |  |
| `sendOnce` | `intent.ts` | An intent made by a button rather than typed (a suggestion, the repo map's sow, an artifact's reply). |
| `sendReplacing` | `intent.ts` | A setting the user changes again before the first change showed (a reaction off and on, a level picked twice). |
| `intentsIn` | `intent.ts` | A type's intents in one registry; the same object for every caller, so its timers and watches are kept once. |
| `useIntents` | `intent.ts` | A type's intents in the page's registry, with the list as an accessor. |
| `ScaleValues` | `prefs.ts` | The workbench's size, in percent; the farm keeps its own whole-number scaling. |
| `StartValues` | `prefs.ts` | Where / opens. |
| `prefsNow` | `prefs.ts` | The choices now; read in a computation or a component, it follows them. |
| `setPick` | `prefs.ts` |  |
| `setPet` | `prefs.ts` |  |
| `setTheme` | `prefs.ts` |  |
| `setScale` | `prefs.ts` |  |
| `setStart` | `prefs.ts` |  |
| `setLibraryTile` | `prefs.ts` |  |
| `setWidth` | `prefs.ts` | A pane's width; none puts it back to its default. |
| `rememberPick` | `prefs.ts` | Who and where an issue was given to, for the next quick add and the farm's next job: "" for no one is the orchestrator's. |
| `usePrefs` | `prefs.ts` | One of the choices, following it. |
| `shownTheme` | `prefs.ts` | The theme the workbench shows: "system" worked out from the system's own. Read again when the choice changes. |
| `followAppearance` | `prefs.ts` | Once, as the page starts: applied now and whenever the choice or the system's theme changes. |
| `storedAtom` | `stored.ts` | A choice's atom, for a registry of the caller's (the tests); the page's are made by defineStored. |
| `defineStored` | `stored.ts` | A choice kept on this machine, read and set as the page's value; `name` is unique across the page. |
| `orFallback` | `stored.ts` | A field of a stored struct that reads as `fallback` when it is missing or does not decode, so one bad field does not throw away the others. |
| `testRegistry` | `testing.ts` |  |
| `deferred` | `testing.ts` | A promise the test settles. |

## `packages/testkit/src`

测试共用：等待、金字塔、语法树

| 名字 | 文件 | 说的是 |
|---|---|---|
| `layers` | `pyramid.ts` |  |
| `budgetMs` | `pyramid.ts` | What a test of each layer may take, in ms. |
| `pyramid` | `pyramid.ts` | The layers of the files under root (a package's folder). |
| `programOf` | `source.ts` | The file's program; path's extension says whether it is TSX. |
| `edgesOf` | `source.ts` | Every import, export … from and dynamic import() of a string. |
| `importsOf` | `source.ts` | What a file imports for its values: imports and re-exports that are not type-only, side-effect and dynamic ones. |
| `exportsOf` | `source.ts` | The names a file exports itself (declarations and `export { … }` without a source), types included. |
| `exportedValuesOf` | `source.ts` | The values a file declares and exports itself (no types), each with where its export statement starts. |
| `readsOf` | `source.ts` | The fields read off what object.method() returns: right off the call (`core.state().issues`, `?.` too), through a const it is kept in (`const s = core.state(). |
| `analyzeSource` | `source.ts` |  |
| `calls` | `source.ts` | Whether the file calls object.method(…) anywhere. |
| `tempDir` | `temp.ts` |  |
| `WaitTimedOut` | `until.ts` |  |
| `waitFor` | `until.ts` | What get answers once ok holds for it. what is said if it never does (a function: read when it is given up on). |
| `untilGot` | `until.ts` | The value get gives once it is something. |
| `until` | `until.ts` | Once ok holds. |
