# 共用的原语

由 `scripts/primitives.ts` 从各地基文件夹的导出和它们文档注释的第一行写出，不手改；`vp run docs:verify` 查它是不是最新。写一个帮手之前先在这里找一找：已经有的就用，不再写一份。类型不列。

## `packages/protocol/src/rules`

规则：服务端和页面都跑的纯函数

| 名字 | 文件 | 说的是 |
|---|---|---|
| `sameMarks` | `artifact.ts` | A mark not set and a mark set false are the same. |
| `normalSpans` | `artifact.ts` | Drops empty spans and joins neighbours with the same marks, so one text has one way to be written. |
| `defaultOf` | `channel.ts` | The channel words go to when none is named. |
| `channelOf` | `channel.ts` | A channel by its id; none when no id is given. |
| `mentionLead` | `channel.ts` | What an @name may follow: anything but a Latin letter, a digit, _ or @, so a@b.com names no one while cjk@w3 does (Chinese runs on without spaces). |
| `slice` | `cut.ts` | s.slice(start, end), a surrogate pair cut in half made U+FFFD. |
| `cut` | `cut.ts` | s as it is when it fits in max units; else its first max units and an ellipsis. |
| `oneLine` | `cut.ts` | Runs of white space are one space. |
| `htmlSandbox` | `display.ts` | The <iframe>'s sandbox attribute; the server's CSP sandbox directive is the same tokens. |
| `freshOf` | `inbox.ts` | The items of now that are news to known: undefined known is the first look, which knows them all and has no news. An id is news once. |
| `assignmentOf` | `issues.ts` | The responsibility in force now. |
| `assignedAgentOf` | `issues.ts` |  |
| `executionsOf` | `issues.ts` | Every execution, in assignment and start order. |
| `sessionIdsOf` | `issues.ts` | The external helper contexts that executed it, in order. |
| `latestSessionIdOf` | `issues.ts` |  |
| `shortTitle` | `issues.ts` | One short line for a title: its first line, and of a long one, the first sentence, else up to its last pause that fits. failing those, cut. |
| `closedText` | `issues.ts` | What its close says: done with what it delivered, or canceled and why. |
| `omitUndefined` | `omit.ts` |  |
| `isOneOf` | `oneOf.ts` |  |
| `validKey` | `order.ts` |  |
| `keyBetween` | `order.ts` | A key after a and before b; "" for a is the start, "" for b the end. |
| `spanText` | `phase.ts` | A short span: seconds under a minute (at least one), else minutes. |
| `isBusy` | `phase.ts` |  |
| `roomLeft` | `phase.ts` | How many more may start working now: on the whole farm (space at once), and in the repo (perRepo at once, 0 for no limit of its own). |
| `needOf` | `phase.ts` |  |
| `phaseText` | `phase.ts` | phaseWords as said at now. |
| `phaseWords` | `phase.ts` | What a session is doing in words, how long it has been quiet left as {span}. |
| `slugOf` | `pkm.ts` | A page's name from its title: trimmed, lower case, spaces as dashes, "/" (or "\") as "__". |
| `pkmTag` | `pkm.ts` | Every #tag in a text (read it with matchAll): the name is group 1. The page draws them, the server links them. |
| `pkmTagTyped` | `pkm.ts` | A #tag being typed, ending where the text ends (the caret): its name so far is group 1. |
| `applyBlockOps` | `pkm.ts` | The blocks after the ops in order (a copy: blocks is not changed). an op on a block not on the page changes nothing. |
| `flatBlocks` | `pkm.ts` | The outline as the wire has it: in order, each with its parent and the path of first lines above it. |
| `treeOfBlocks` | `pkm.ts` |  |
| `plainText` | `plain.ts` |  |
| `farmOf` | `play.ts` | The farm a session's bed is on: each repo has its own, and the sessions without one share one. |
| `plotKeyOf` | `play.ts` | The plot a session works, the key of `FarmView.plots`: its issue, so a reopened issue keeps its plot; one with no issue is its own. |
| `githubRepository` | `repo.ts` | Only repository home URLs: never credentials, other git transports or command-line options. |
| `same` | `same.ts` |  |
| `stageWantsUser` | `stage.ts` | Questions the user for something: the page leads with it, the board flags it. |

## `apps/server/src/base`

服务端的纯地基：id、JSON、文字、脱敏

| 名字 | 文件 | 说的是 |
|---|---|---|
| `user` | `actor.ts` |  |
| `system` | `actor.ts` |  |
| `orchestrator` | `actor.ts` | forUser: the user's own words are in the run it acts in. |
| `worker` | `actor.ts` | A helper at work, by its session's id. |
| `actsForUser` | `actor.ts` | On the user's word: the user, or the orchestrator in a run the user's words are in. |
| `serverFiles` | `assets.ts` | What the package script copies beside the bundle: every path serverFile is given lies under one of these. |
| `serverFile` | `assets.ts` |  |
| `clip` | `clip.ts` | s on one line and trimmed, at most max units with the ellipsis. |
| `head` | `clip.ts` | The first n UTF-16 units of s, never half a surrogate pair. |
| `compactCard` | `clip.ts` |  |
| `refused` | `errors.ts` |  |
| `missing` | `errors.ts` | Something asked for by id or name is not there. next is required: where to look for the ones that are (lookIn). |
| `lookIn` | `errors.ts` |  |
| `memoriesOf` | `errors.ts` | Where an agent's memories are listed. |
| `reasonOf` | `errors.ts` | An error's words, whatever its tag. |
| `messageOf` | `errors.ts` | What a thrown or rejected value says: an Error's message, anything else as text. |
| `errnoOf` | `errors.ts` | A failed system call's code (ENOENT, EPERM…), or undefined for anything else. |
| `Inconsistent` | `errors.ts` | A defect, never an expected failure: the farm's own records disagree with each other, or a caller broke a rule it is held to. |
| `orMissing` | `errors.ts` | A lookup's answer, or Missing (what was not found, and where to look) when it found none. |
| `newId` | `ids.ts` |  |
| `code` | `ids.ts` | A short human code, for pairing a device: not an id, and never a key. |
| `jsonOf` | `json.ts` | Read where unreadable JSON is already a defect: a value that does not fit the Schema is one too. |
| `jsonText` | `json.ts` | As JSON.stringify writes it; a cycle or a bigint fails instead of throws. |
| `jsonOrNone` | `json.ts` | Read where unreadable JSON is taken as none: a value that does not fit the Schema is none too. |
| `localizedJson` | `json.ts` | A data file kept in each language (seeds.json and seeds.en.json), read once per language; one that does not fit its |
| `lastJsonBlock` | `json.ts` | The last fenced block of a model's text that decodes with schema and is not refused, or the words for why the last one tried was not. |
| `misfitField` | `json.ts` | The field a decoding first failed on, undefined when the value itself was not an object. |
| `wireOf` | `json.ts` | value with every own key set to undefined dropped, in plain objects and arrays all the way down. |
| `wireJson` | `json.ts` | The JSON text of value as the wire carries it: wireOf, then encoded by schema (which still fails on a missing required |
| `compareText` | `order.ts` | By UTF-8 bytes, which is by code point, not by UTF-16 unit: the order the recorded cases were sorted in. |
| `compare` | `order.ts` |  |
| `or` | `order.ts` |  |
| `numberIn` | `order.ts` |  |
| `usersLanguage` | `prompts.ts` |  |
| `scopedPubSub` | `pubsub.ts` | An unbounded PubSub shut down when the scope that made it (its service's layer) closes, so a subscriber's stream ends |
| `checksFromText` | `questions.ts` | The helper's text checks, one per criterion line; explicit issue_report.checks still win. |
| `questionsFromText` | `questions.ts` |  |
| `redact` | `redact.ts` |  |
| `redactedHead` | `redact.ts` | Its first n UTF-16 units, trimmed: cut after redacting, as a secret cut first may no longer look like one. |
| `redactOutput` | `redact.ts` | Everything the process writes to stream goes through redact first: the server's log, and what a library prints. |

## `apps/server/src/infra`

服务端对外的地基：配置、库、文件、时间、日志

| 名字 | 文件 | 说的是 |
|---|---|---|
| `baselineSql` | `baseline.ts` |  |
| `baselineHash` | `baseline.ts` |  |
| `baselineStatements` | `baseline.ts` | The baseline as single statements, in order: a driver prepares one at a time. A function's body ($$ … $$) and a |
| `ServerConfig` | `config.ts` |  |
| `defaults` | `config.ts` |  |
| `ConfigError` | `config.ts` | Why the configuration cannot be read: the file, or a key's value. |
| `loadConfig` | `config.ts` | file: the YAML to read, which must be there. empty is home/vibevalley.yaml, read if it is there. |
| `pkmDir` | `config.ts` |  |
| `hostName` | `config.ts` | This computer's name as people say it: its host name without .local. |
| `dbDir` | `config.ts` | The database's folder, or "memory". |
| `serverAddress` | `config.ts` | The main API and its MCP endpoint share a fixed local identity; remote devices use the separate lan listener. |
| `reposDir` | `config.ts` | Where the space's repositories are: each folder in it is one. |
| `worktreesDir` | `config.ts` | Where the issues' worktrees are: <repo>.<issue number> under it. |
| `agentHome` | `config.ts` | A profile's folder for conversation logs, archives and evals; memory rows live in the database. |
| `dbQueries` | `db.ts` | Every query run: what a test holds a hot path's budget to, and a reading of the farm's load. |
| `setAsideStale` | `db.ts` | A folder's database made from another baseline is moved aside, whole, to <folder>.<hash>-<time>. The baseline it was made from is in <folder>.schema. |
| `Database` | `db.ts` | The database as an SqlClient, with the schema in place: Postgres at database.url, or else PGlite in the home (in |
| `causeMessage` | `db.ts` | What the database said, from under the SqlError around it. |
| `Db` | `db.ts` | The farm's database as the services use it: a generated query (db/generated) run against it. |
| `fileBlob` | `files.ts` |  |
| `NotWritten` | `files.ts` |  |
| `writeOnce` | `files.ts` |  |
| `readOrSetAside` | `files.ts` | A user's file (config.json, settings.json); one whose read fails is set aside and read as undefined. |
| `keptFile` | `files.ts` | soonMs: how long a soon write waits after the first change, so a burst is one write and a crash loses no more. |
| `HomeTaken` | `lease.ts` |  |
| `HomeUnavailable` | `lease.ts` | The lock file could not be read or written for another reason (permissions, a missing home). |
| `leaseHome` | `lease.ts` | Takes the home, or throws HomeTaken; the function it returns gives it back. |
| `callbackLog` | `log.ts` | Made in a service's make: the lines it writes end with the service and keep its logger. |
| `bestEffort` | `log.ts` | Work the caller goes on without: a failure or a defect is logged at Warn after what (the words say what was being done), and the caller carries on. |
| `publicIpv4` | `publicHttp.ts` |  |
| `publicLookup` | `publicHttp.ts` |  |
| `publicHttps` | `publicHttp.ts` |  |
| `PublicHttp` | `publicHttp.ts` |  |
| `timeHere` | `time.ts` | The Clock of the service that asks, as a Time. |
| `wallTime` | `time.ts` | The wall clock, for code with no service to ask: a class tested on its own, the command line. |
| `withinRealTime` | `time.ts` | A deadline on a real process or network call (a runtime's probe of its CLI): real time, whatever the Clock says, and it keeps nothing alive. |
| `afterRealTime` | `time.ts` | A deadline on a real process (a command's timeout, the grace before SIGKILL): runs f after ms of real time, whatever the Clock says. |
| `localeMinute` | `time.ts` | To the minute, in this machine's zone: what an input says the time is, so that it does not change between two requests a |
| `localParts` | `time.ts` | An instant's calendar and clock in this machine's zone; month counts from 1. |

## `apps/server/src/testing`

服务端测试的农场：世界、git、帮工、时钟

| 名字 | 文件 | 说的是 |
|---|---|---|
| `span` | `artifact.ts` |  |
| `bold` | `artifact.ts` |  |
| `para` | `artifact.ts` |  |
| `sample` | `artifact.ts` | Every kind of block, and inline marks, as the export writes them. |
| `committedDelivery` | `deliveries.ts` | A delivery written and routed as Mailbox commits one, and nothing after: what a stop between commit and hand-off |
| `kinds` | `evals.ts` |  |
| `orchestratorToolNames` | `evals.ts` | The orchestrator's tools by name, as its brain has them: the farm's and its own (no skills, subagents or crons). |
| `problemOf` | `evals.ts` | "" when it is whole: the fields its kind reads are there. |
| `check` | `evals.ts` | The expectations the turn does not meet, each as it is written; none when it passes. |
| `casesIn` | `evals.ts` | The cases in dir (*.json), by file name. |
| `isInput` | `evals.ts` |  |
| `committed` | `evals.ts` |  |
| `stubbed` | `evals.ts` | Every farm tool answers a call with what the case recorded for the same call (the same tool and arguments), each once, and nothing for another. |
| `replayWorld` | `evals.ts` |  |
| `replaySetup` | `evals.ts` |  |
| `farm` | `farm.ts` | The whole farm on a free port: its address. |
| `workingFarm` | `farm.ts` | The same with the test helper as its only runtime (pi, testing/worker.ts), so an issue can be worked from outside as |
| `gitSync` | `git.ts` | Runs git in dir as a test user. its output, trimmed. |
| `gitIn` | `git.ts` | Runs git in dir as dir's own config says (no test user). its output, trimmed. |
| `gitInEnv` | `git.ts` | gitIn with these in its environment (a commit's dates). |
| `reposDir` | `git.ts` |  |
| `repo` | `git.ts` | A repository with `mine` commits by the test user, `others` by someone else. |
| `write` | `git.ts` |  |
| `app` | `http.ts` |  |
| `starter` | `layers.ts` | A built-in template as a farm whose agent.starters names it has it: under the template's own id. |
| `testConfig` | `layers.ts` |  |
| `testDatabase` | `layers.ts` |  |
| `offline` | `layers.ts` | An HTTP client for a test that must not reach the network: every request dies, so one made by mistake is a failure. |
| `offlineNetwork` | `layers.ts` |  |
| `whenState` | `layers.ts` | What pick finds in the core state: in it now, or in the first state the core moves to where it finds something. |
| `network` | `network.ts` |  |
| `realtimeFixture` | `realtime.ts` |  |
| `refuse` | `refuse.ts` | A trigger named name refusing the write on says (before insert on t, before update of c on t), when when holds |
| `allow` | `refuse.ts` | The write refuse stopped goes through again. |
| `heard` | `refuse.ts` | The lines the farm logs from here on, each with its cause; layer is given to what builds the farm. |
| `releaseHeld` | `worker.ts` | Once n turns are held, lets every held turn go on: a turn not yet at its hold would miss a release made before. |
| `helper` | `worker.ts` | The helper every flow hires: what it does is in the words of its brief (the part after the reminders). draft-only drafts. |
| `installedOnly` | `worker.ts` | A probe that finds every runtime given, bundled, and no other. |
| `quietApp` | `world.ts` | For a test that builds the whole app (http/app.ts): nothing of this machine's is asked in the background. |
| `worldBelowIngress` | `world.ts` | Services below Ingress for module tests. |
| `world` | `world.ts` | The farm up to its inbox, with the tools and /mcp: no orchestrator, gateway or game, and no startup (farm.ts adds |
| `testIssues` | `world.ts` | Issues a test adds are ones the user sent, so their mandate is explicit. |
| `Said` | `world.ts` |  |
| `said` | `world.ts` |  |

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
| `api` | `api.ts` | The page is served by the server it talks to: the same origin. |
| `reasonOf` | `api.ts` | What a refusal says, for a toast or an inline line. |
| `faultOf` | `api.ts` | The fault a refusal or connection failure carries. |
| `newSendKey` | `api.ts` | A client's key for one send: a retry with the same key is the same message, said once. |
| `createRequestKey` | `api.ts` | The request key of one thing the user may send again (a form's create, a button's). a new one after. |
| `attachmentData` | `attachment.ts` | A file's bytes as attachment.create takes them: base64. |
| `useForm` | `form.ts` |  |
| `createForm` | `form/form.ts` |  |
| `formIssues` | `form/issues.ts` |  |
| `at` | `form/paths.ts` |  |
| `at` | `form/paths.ts` |  |
| `replace` | `form/paths.ts` |  |
| `replace` | `form/paths.ts` |  |
| `immutable` | `form/paths.ts` |  |
| `frames` | `frame.ts` |  |
| `FramesContext` | `frame.ts` |  |
| `createFrames` | `frame.ts` | The stream above as a store: each frame reconciles in by id, so only what changed updates. |
| `useFrames` | `frame.ts` |  |
| `useCore` | `frame.ts` | The folded state. undefined until the first frame. |
| `orchestratorSession` | `frame.ts` |  |
| `orchestratorMood` | `frame.ts` |  |
| `rawFrame` | `frame.ts` | The frame as the stream sent it: a new object each time, for code that compares the one before with the one after (sounds, the canvas, the host's notices). |
| `subscribeLive` | `frame.ts` | Listens to the live stream (/api/v1/live). returns how to stop. |
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
| `searchParam` | `router/search.ts` |  |
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
| `createRegistry` | `atom.ts` |  |
| `pageRegistry` | `atom.ts` | The page's one registry. |
| `RegistryContext` | `atom.ts` | Every atom's value lives in one registry for the page; the page's own unless a test or a story gives another. |
| `useRegistry` | `atom.ts` |  |
| `useAtom` | `atom.ts` | An atom's value as an accessor: subscribed while the component lives, never suspending. |
| `onPage` | `atom.ts` | The atom held for the page's life, with a signal that only counts its changes. |
| `defineAtom` | `atom.ts` | A value of the page's that lasts until it closes (a dialog the shell and a page both open, the farm's overlays). |
| `framesSource` | `atom.ts` |  |
| `linkIn` | `atom.ts` | Whether the state stream is up now, read from its source: reading framesAtom here would open and close the stream. |
| `framesAtom` | `atom.ts` | The state stream as an atom: subscribed to its source while anything reads it, so the stream stays open meanwhile. |
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
| `waitFor` | `until.ts` | What get answers once ok holds for it. what is said if it never does (a function: read when it is given up on). |
| `untilGot` | `until.ts` | The value get gives once it is something. |
| `until` | `until.ts` | Once ok holds. |
| `whenTrue` | `until.ts` | until for a test written with promises (a fake runtime, a fake model). |
| `within` | `until.ts` | What p settles to, or a rejection naming what took longer than ms (real time): a deadline on something the test |
| `gate` | `until.ts` | A gate a fake waits at until the test opens it: a fake that should be busy is busy until the test says, not for a |
| `nextTurn` | `until.ts` | One turn of the event loop: whatever was set going before it (a publish taken by a forked reader, a promise already resolved) has run. |
| `aTurn` | `until.ts` |  |
