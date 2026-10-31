# 共用的原语

由 `scripts/primitives.ts` 从各地基文件夹的导出和它们文档注释的第一行写出，不手改；`vp run docs:verify` 查它是不是最新。写一个帮手之前先在这里找一找：已经有的就用，不再写一份。类型不列。

## `packages/protocol/src/rules`

规则：服务端和页面都跑的纯函数

| 名字 | 文件 | 说的是 |
|---|---|---|
| `attentionWantsOwner` | `attention.ts` | Questions the owner for something: the page leads with it, the board flags it. |
| `slice` | `cut.ts` | s.slice(start, end), a surrogate pair cut in half made U+FFFD (what String.prototype.toWellFormed does, which the |
| `cut` | `cut.ts` | s as it is when it fits in max units; else its first max units and an ellipsis. |
| `oneLine` | `cut.ts` | Runs of white space are one space. |
| `freshOf` | `inbox.ts` | The items of now that are news to known: undefined known is the first look, which knows them all and has no news. |
| `shortTitle` | `issues.ts` | One short line for a title: its first line, and of a long one, the first sentence, else up to its last pause that fits; |
| `closedText` | `issues.ts` | What its close says: done with what it delivered, or canceled and why. |
| `omitUndefined` | `omit.ts` |  |
| `isOneOf` | `oneOf.ts` |  |
| `validKey` | `order.ts` |  |
| `keyBetween` | `order.ts` | A key after a and before b; "" for a is the start, "" for b the end. |
| `spanText` | `phase.ts` | A short span: seconds under a minute (at least one), else minutes. |
| `isBusy` | `phase.ts` |  |
| `roomLeft` | `phase.ts` | How many more may start working now: on the whole farm (workspace at once), and in the project (perProject at once, |
| `needOf` | `phase.ts` |  |
| `phaseText` | `phase.ts` | phaseWords as said at now. |
| `phaseWords` | `phase.ts` | What a session is doing in words, how long it has been quiet left as {span}. |
| `plainText` | `plain.ts` |  |
| `farmOf` | `play.ts` | The farm a session's bed is on: each project has its own, and the sessions without one share one. |
| `plotKeyOf` | `play.ts` | The plot a session works, the key of `FarmView.plots`: its issue, so a reopened issue keeps its plot; one with no issue is its own. |
| `same` | `same.ts` |  |

## `apps/server/src/base`

服务端的纯地基：id、JSON、文字、脱敏

| 名字 | 文件 | 说的是 |
|---|---|---|
| `owner` | `actor.ts` |  |
| `system` | `actor.ts` |  |
| `orchestrator` | `actor.ts` | forOwner: the owner's own words are in the run it acts in. |
| `session` | `actor.ts` |  |
| `actsForOwner` | `actor.ts` | On the owner's word: the owner, or the orchestrator in a run the owner's words are in. |
| `clip` | `clip.ts` | s on one line and trimmed, at most max units with the ellipsis. |
| `head` | `clip.ts` | The first n UTF-16 units of s, never half a surrogate pair. |
| `newId` | `ids.ts` |  |
| `code` | `ids.ts` | A short human code, for pairing a device: not an id, and never a key. |
| `jsonOf` | `json.ts` | Read where unreadable JSON is already a defect: a value that does not fit the Schema is one too. |
| `jsonOrNone` | `json.ts` | Read where unreadable JSON is taken as none: a value that does not fit the Schema is none too. |
| `localizedJson` | `json.ts` | A data file kept in each language (seeds.json and seeds.en.json), read once per language; one that does not fit its |
| `lastJsonBlock` | `json.ts` | The last fenced block of a model's text that decodes with schema and is not refused, or the words for why the last |
| `misfitField` | `json.ts` | The field a decoding first failed on, undefined when the value itself was not an object. |
| `numberIn` | `number.ts` |  |
| `compareText` | `order.ts` | By UTF-8 bytes, which is by code point, not by UTF-16 unit: the order the recorded cases were sorted in. |
| `compare` | `order.ts` |  |
| `or` | `order.ts` |  |
| `scopedPubSub` | `pubsub.ts` | An unbounded PubSub shut down when the scope that made it (its service's layer) closes, so a subscriber's stream ends |
| `redact` | `redact.ts` |  |
| `redactedHead` | `redact.ts` | Its first n UTF-16 units, trimmed: cut after redacting, as a secret cut first may no longer look like one. |
| `redactOutput` | `redact.ts` | Everything the process writes to stream goes through redact first: the server's log, and what a library prints. A |
| `wireOf` | `wire.ts` | value with every own key set to undefined dropped, in plain objects and arrays all the way down; other objects as |
| `wireJson` | `wire.ts` | The JSON text of value as the wire carries it: wireOf, then encoded by schema (which still fails on a missing required |

## `apps/server/src/infra`

服务端对外的地基：配置、库、文件、时间、日志

| 名字 | 文件 | 说的是 |
|---|---|---|
| `baselineSql` | `baseline.ts` |  |
| `baselineHash` | `baseline.ts` |  |
| `ServerConfig` | `config.ts` |  |
| `defaults` | `config.ts` |  |
| `ConfigError` | `config.ts` | Why the configuration cannot be read: the file, or a key's value. |
| `loadConfig` | `config.ts` | file: the YAML to read, which must be there; empty is home/vibevalley.yaml, read if it is there. The environment wins |
| `dbDir` | `config.ts` | The database's folder, or "memory". |
| `serverAddress` | `config.ts` | The main API and its MCP endpoint share a fixed local identity; remote devices use the separate lan listener. |
| `projectsDir` | `config.ts` | Where the projects are: each folder in it is one. |
| `agentHome` | `config.ts` | A profile's own folder, an orchestrator's conversation, MEMORY.md, archive and evals among what it keeps there. |
| `dbQueries` | `db.ts` | Every query run: what a test holds a hot path's budget to, and a reading of the farm's load. |
| `setAsideStale` | `db.ts` | A folder's database made from another baseline is moved aside, whole, to <folder>.<hash>-<time>: it is not |
| `Database` | `db.ts` | The database as an SqlClient, with the schema in place. |
| `causeMessage` | `db.ts` | What the database said, from under the SqlError around it. |
| `Db` | `db.ts` | The farm's database as the services use it: a generated query (db/generated) run against it. The database is in this |
| `NotWritten` | `files.ts` |  |
| `writeOnce` | `files.ts` | Writes a file named by its bytes (their hash), making its folder: the same bytes are the same file, so one already |
| `readOrSetAside` | `files.ts` | An owner's file (config.json, settings.json, state.json) read by read. One that does not read (not JSON, or not the |
| `keptFile` | `files.ts` | soonMs: how long a soon write waits after the first change, so a burst is one write and a crash loses no more. |
| `HomeTaken` | `lease.ts` |  |
| `leaseHome` | `lease.ts` | Takes the home, or throws HomeTaken; the function it returns gives it back. |
| `homeOf` | `lease.ts` | The home a server or the command line uses: VIBEVALLEY_HOME, or ~/.vibevalley (as loadConfig reads it). |
| `announce` | `lease.ts` | Says where this server listens, for as long as it does; the function it returns takes it back. |
| `announced` | `lease.ts` | Where the server using this home listens; undefined when none says so or it has stopped. |
| `callbackLog` | `log.ts` | Made in a service's make: the lines it writes end with the service and keep its logger. |
| `bestEffort` | `log.ts` | Work the caller goes on without: a failure or a defect is logged at Warn after what (the words say what was being |
| `timeHere` | `time.ts` | The Clock of the service that asks, as a Time: what it sleeps on runs with the service's own context, on fibers its |
| `wallTime` | `time.ts` | The wall clock, for code with no service to ask: a class tested on its own, the command line. |
| `withinRealTime` | `time.ts` | A deadline on a real process or network call (a runtime's probe of its CLI): real time, whatever the Clock says, and |
| `afterRealTime` | `time.ts` | A deadline on a real process (a command's timeout, the grace before SIGKILL): runs f after ms of real time, whatever |
| `localeMinute` | `time.ts` | To the minute: what an input says the time is, so that it does not change between two requests a few seconds apart. |

## `apps/server/src/testing`

服务端测试的农场：世界、git、帮工、时钟

| 名字 | 文件 | 说的是 |
|---|---|---|
| `sampleAgent` | `agents.ts` |  |
| `farm` | `cli.ts` | The whole farm on a free port; the command line is pointed at it. |
| `cli` | `cli.ts` | One run, with a Stdio of its own and no environment: its exit code, what it put on stdout and on stderr, and the |
| `gitSync` | `git.ts` | Runs git in dir as a test user; its output, trimmed. A failure throws with what git said. |
| `gitIn` | `git.ts` | Runs git in dir as dir's own config says (no test user); its output, trimmed. A failure throws with what git said. |
| `gitInEnv` | `git.ts` | gitIn with these in its environment (a commit's dates). |
| `projectsDir` | `git.ts` | A projects folder of its own, under a work root of its own. |
| `repo` | `git.ts` | A repository with `mine` commits by the test user, `others` by someone else. |
| `write` | `git.ts` |  |
| `goldenCases` | `golden.ts` | The cases of a module's file, by the module's folder under src. |
| `releaseHeld` | `helper.ts` | Once n turns are held, lets every held turn go on: a turn not yet at its hold would miss a release made before. |
| `helper` | `helper.ts` | The helper every flow hires: what it does is in the words of its brief (the part after the reminders). 只起草工单 drafts; |
| `installedOnly` | `helper.ts` | A probe that finds every runtime given, bundled, and no other. |
| `starter` | `layers.ts` | A built-in template as a farm whose agent.starters names it has it: under the template's own id. |
| `testConfig` | `layers.ts` |  |
| `testDatabase` | `layers.ts` |  |
| `offline` | `layers.ts` | An HTTP client for a test that must not reach the network: every request dies, so one made by mistake is a failure. |
| `Said` | `said.ts` |  |
| `said` | `said.ts` |  |
| `whenState` | `until.ts` | What pick finds in the core state: in it now, or in the first state the core moves to where it finds something. It |
| `quietApp` | `world.ts` | For a test that builds the whole app (http/app.ts): nothing of this machine's is asked in the background. No runtime is |
| `worldBelowTasks` | `world.ts` | The farm below the task graphs: for a test that makes its own task service. |
| `world` | `world.ts` | The farm up to its inbox, with the tools and /mcp: no orchestrator, gateway or game, and no startup (farm.ts adds |

## `apps/web/src/base`

页面的纯地基

| 名字 | 文件 | 说的是 |
|---|---|---|
| `createExternal` | `external.ts` | A store outside Solid (subscribe, get) as an accessor; it notifies when `get` returns a different value. `always`: |
| `ago` | `format.ts` |  |
| `tookText` | `format.ts` |  |
| `wallClockText` | `format.ts` |  |
| `numberText` | `format.ts` | A whole number without its .0, as the server writes ids and counts. |
| `momentText` | `format.ts` | A moment as a date and a time of day. |
| `yuan` | `format.ts` |  |
| `big` | `format.ts` | A large count: ten thousands in Chinese (1.2 万), thousands in English (12k). |
| `spentText` | `format.ts` |  |
| `messageOf` | `format.ts` | What a thrown or rejected value says: an Error's message, anything else as text. |
| `spanText` | `format.ts` | How long, in round words: 不到 1 分钟, 3 分钟, 2 小时, 4 天. |
| `SpriteManifest` | `manifests.ts` |  |
| `CursorManifest` | `manifests.ts` |  |
| `TitleManifest` | `manifests.ts` |  |
| `compareText` | `order.ts` |  |
| `or` | `order.ts` |  |
| `matches` | `search.ts` | Every word of the query is somewhere in the texts, ignoring case; an empty query matches everything. |
| `shortcutPlaces` | `shortcuts.ts` |  |
| `shortcuts` | `shortcuts.ts` |  |
| `keyCap` | `shortcuts.ts` | A key's cap on the sheet. |
| `pressed` | `shortcuts.ts` | Whether a keydown is one of the shell's chords (mod+K, ?): the rest are each place's own. |
| `useInterval` | `timer.ts` | fn every ms for as long as the owner lives. |
| `useTimeout` | `timer.ts` | A timeout to set from a handler: setting it again replaces the one waiting, and the owner's end clears it. |
| `autofocus` | `util.tsx` | A ref that focuses its element once it is on the page: what React's autoFocus does on mount. |
| `useNow` | `util.tsx` | The time, a new reading every `ms`: for "3 分钟前" that keeps up without anything else changing. |
| `Keyed` | `util.tsx` | Rebuilds its children whenever `key` changes, as a React key does: their state starts over. |
| `aria` | `util.tsx` | aria-expanded, aria-pressed, aria-selected: "true" or "false", as a boolean false would drop the attribute. |
| `useViewport` | `util.tsx` | The window's size, following it as it is resized. |
| `createSettled` | `util.tsx` | The value once it has stopped changing for `ms`: what is asked of the server while someone types. |
| `useClickAway` | `util.tsx` | Closes a popup when the pointer goes down outside `box` while `open`: a menu folds when you click elsewhere. Returns |
| `variant` | `util.tsx` |  |
| `recordOf` | `util.tsx` | A JSON object's fields, each still to be checked; undefined for anything that is not an object. |

## `apps/web/src/infra`

页面对外的地基：服务端、宿主、浏览器

| 名字 | 文件 | 说的是 |
|---|---|---|
| `useWorkAgents` | `agents.ts` | The profiles work is sent to, the helpers; enabled, only those not switched off. |
| `useOrchestrators` | `agents.ts` | The orchestrators' profiles, the default one first. |
| `orchestratorLookOf` | `agents.ts` | An orchestrator's look (its sprites are manager-<look>); the plain farmer until the profiles are read. |
| `useAgent` | `agents.ts` | A profile by its id, once the profiles are read; undefined for none or one gone. |
| `useAgentProblems` | `agents.ts` | What the server says is wrong with each of these drafts (agent.validate), by id; empty until it answers. |
| `api` | `api.ts` | The page is served by the server it talks to: the same origin. |
| `reasonOf` | `api.ts` | What a refusal says, for a toast or an inline line. |
| `newSendKey` | `api.ts` | A client's key for one send: a retry with the same key is the same message, said once. |
| `createRequestKey` | `api.ts` | The request key of one thing the owner may send again (a form's create, a button's): the same key until a send went |
| `FramesContext` | `frame.ts` |  |
| `createFrames` | `frame.ts` | The state stream (infra/frames.ts) as a store: each frame reconciles in by id, so only what changed updates. |
| `useFrames` | `frame.ts` |  |
| `useCore` | `frame.ts` | The folded state; undefined until the first frame. Read it inside JSX or a memo. |
| `orchestratorMood` | `frame.ts` | An orchestrator's mood; one the state does not list is idle. |
| `rawFrame` | `frame.ts` | The frame as the stream sent it: a new object each time, for code that compares the one before with the one after |
| `frames` | `frames.ts` |  |
| `followChannel` | `gateway.ts` | What is said in a channel after the message numbered after, then from now on. |
| `followReports` | `gateway.ts` | The farm's reports after the one with this id (the newest when absent), then each from now on. |
| `followArtifact` | `gateway.ts` | A blocks artifact's changes after this seq, then each batch from now on. |
| `currentHost` | `host.ts` |  |
| `subscribeLive` | `live.ts` | Listens to the live stream (/api/v1/live); returns how to stop. Framework-free: the Solid side subscribes here too. |
| `reveal` | `opening.ts` | Once the page has mounted: takes the cover away when the page is ready, in one fade. |
| `queries` | `query.ts` | REST reads besides the state stream (history, changes, …); a frame that changes what they show invalidates them. |
| `refetchOnRelink` | `query.ts` | What changed while the state stream was lost reached no REST read either (they are invalidated by frames): each is |
| `useQuery` | `query.ts` | REST reads never hold the state stream's frame: pending and failures are result values, and ready() selects data. |
| `ready` | `query.ts` | A query's successful data once it has arrived, else `fallback` (including disabled and failed queries). |
| `useSprites` | `query.ts` |  |
| `useAgents` | `query.ts` | Every profile, the orchestrator's too. |
| `useAgentTemplates` | `query.ts` | The templates a profile installs from: the built-in ones, then those added on this machine. |
| `useProjects` | `query.ts` |  |
| `useSettings` | `query.ts` |  |
| `useRuntimes` | `query.ts` | The runtimes on this machine; probed again every few minutes on the server. |
| `RouterContext` | `router.ts` |  |
| `useRouter` | `router.ts` |  |
| `createRouter` | `router.ts` |  |
| `useSearch` | `router.ts` | The query string of the path the page is at, read again when it moves. |
| `saveSettings` | `settings.ts` | Saves, and the settings the server answers with are the cached ones from then on. |
| `answer` | `storyApi.ts` | What the server answers while this story is open, by the path after /api/v1/ ("issue/diff/get"). Unanswered calls |
| `fakeFetch` | `storyApi.ts` |  |
| `testFrames` | `testing.ts` |  |
| `frameAt` | `testing.ts` | An empty farm's frame at this seq. |
| `useUpdates` | `updates.ts` |  |

## `apps/web/src/state`

页面的中间层：意图、存下的选择、原子

| 名字 | 文件 | 说的是 |
|---|---|---|
| `followAppearance` | `appearance.ts` | Once, as the page starts: applied now and whenever the choice or the system's theme changes. |
| `createRegistry` | `atom.ts` |  |
| `pageRegistry` | `atom.ts` | The page's one registry. Root gives it, and the page's own values (defineAtom, defineStored) live in it, since plain |
| `RegistryContext` | `atom.ts` | Every atom's value lives in one registry for the page; the page's own unless a test or a story gives another. |
| `useRegistry` | `atom.ts` |  |
| `useAtom` | `atom.ts` | An atom's value as an accessor: subscribed while the component lives, never suspending. |
| `onPage` | `atom.ts` | The atom held for the page's life, with a signal that only counts its changes: a read returns the registry's value |
| `defineAtom` | `atom.ts` | A value of the page's that lasts until it closes (a dialog the shell and a page both open, the farm's overlays). |
| `useSearchParam` | `atom.ts` | A choice held in the address (`?name=value`), so a reload or a link shown to someone opens on it: read while the |
| `framesSource` | `atom.ts` |  |
| `linkIn` | `atom.ts` | Whether the state stream is up now, read from its source: reading framesAtom here would open and close the stream. |
| `framesAtom` | `atom.ts` | The state stream as an atom: subscribed to its source while anything reads it, so the stream stays open meanwhile. |
| `bySeq` | `intent.ts` | A reply that carries the seq of the fold with its change (an issue moved): shown once a frame has caught up. |
| `defineIntent` | `intent.ts` |  |
| `sendOnce` | `intent.ts` | An intent made by a button rather than typed (a suggestion, the project map's sow, an artifact's reply): pressed again |
| `sendReplacing` | `intent.ts` | A setting the owner changes again before the first change showed (a reaction off and on, a level picked twice): the |
| `intentsIn` | `intent.ts` | A type's intents in one registry; the same object for every caller, so its timers and watches are kept once. |
| `useIntents` | `intent.ts` | A type's intents in the page's registry, with the list as an accessor. |
| `latestReader` | `latest.ts` | Framework-free, for the test: `told` hears each state of the newest ask only. |
| `useLatest` | `latest.ts` | The answer to the newest `key()` while the component lives; undefined while there is nothing to ask. |
| `ScaleValues` | `prefs.ts` | The workbench's size, in percent; the farm keeps its own whole-number scaling. |
| `StartValues` | `prefs.ts` | Where / opens. |
| `prefsNow` | `prefs.ts` | The choices now; read in a computation or a component, it follows them. |
| `subscribePrefs` | `prefs.ts` |  |
| `setPick` | `prefs.ts` |  |
| `setPet` | `prefs.ts` |  |
| `setTheme` | `prefs.ts` |  |
| `setScale` | `prefs.ts` |  |
| `setStart` | `prefs.ts` |  |
| `setWidth` | `prefs.ts` | A pane's width; none puts it back to its default. |
| `rememberPick` | `prefs.ts` | Who and where an issue was given to, for the next quick add and the farm's next job: "" for no one is the orchestrator's. |
| `usePrefs` | `prefs.ts` | One of the choices, following it. |
| `storedAtom` | `stored.ts` | A choice's atom, for a registry of the caller's (the tests); the page's are made by defineStored. |
| `defineStored` | `stored.ts` | A choice kept on this machine, read and set as the page's value; `name` is unique across the page. |
| `orFallback` | `stored.ts` | A field of a stored struct that reads as `fallback` when it is missing or does not decode, so one bad field does not |
| `testRegistry` | `testing.ts` |  |
| `deferred` | `testing.ts` | A promise the test settles. |

## `packages/testkit/src`

测试共用：等待、黄金数据、金字塔、语法树

| 名字 | 文件 | 说的是 |
|---|---|---|
| `goldenCasesAt` | `golden.ts` | The cases of one file. |
| `jsonDiff` | `golden.ts` | Where got and want differ, as JSON (a key holding undefined is no key); undefined when they agree. |
| `checkCases` | `golden.ts` | Runs every case through rule and collects the first disagreements. With VIBEVALLEY_GOLDEN=update, a rule changed on |
| `layers` | `pyramid.ts` |  |
| `budgetMs` | `pyramid.ts` | What a test of each layer may take, in ms. |
| `pyramid` | `pyramid.ts` | The layers of the files under root (a package's folder); paths are relative to it, as src/x/y.test.ts, and a |
| `programOf` | `source.ts` | The file's program; path's extension says whether it is TSX. |
| `edgesOf` | `source.ts` | Every import, export … from and dynamic import() of a string. |
| `importsOf` | `source.ts` | What a file imports for its values: imports and re-exports that are not type-only, side-effect and dynamic ones. |
| `exportsOf` | `source.ts` | The names a file exports itself (declarations and `export { … }` without a source), types included. |
| `exportedValuesOf` | `source.ts` | The values a file declares and exports itself (no types), each with where its export statement starts. |
| `readsOf` | `source.ts` | The fields read off what object.method() returns: right off the call (`core.state().issues`, `?.` too), through a |
| `calls` | `source.ts` | Whether the file calls object.method(…) anywhere. |
| `tempDir` | `temp.ts` |  |
| `waitFor` | `until.ts` | What get answers once ok holds for it. what is said if it never does (a function: read when it is given up on). |
| `untilGot` | `until.ts` | The value get gives once it is something. |
| `until` | `until.ts` | Once ok holds. |
| `whenTrue` | `until.ts` | until for a test written with promises (a fake runtime, a fake model): once ok holds, asked again as waitFor does on |
| `within` | `until.ts` | What p settles to, or a rejection naming what took longer than ms (real time): a deadline on something the test |
| `gate` | `until.ts` | A gate a fake waits at until the test opens it: a fake that should be busy is busy until the test says, not for a |
| `nextTurn` | `until.ts` | One turn of the event loop: whatever was set going before it (a publish taken by a forked reader, a promise already |
| `aTurn` | `until.ts` |  |
