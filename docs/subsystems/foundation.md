# 地基

服务端和页面共用的骨架，不是一块业务，农场上也不画出来：一个 pnpm workspace 的 TypeScript 仓库；服务端 `apps/server` 一块业务一个文件夹、一个 Effect 服务，按次序叠成 layer；形状和规则只在 `packages/protocol`，服务端和页面 import 同一份；SQL 只在 effect-sqlc，表结构只有一份；测试共用一套工具，帮工由脚本扮演。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 仓库和目录：`apps/`、`packages/`、`apps/server/db`、`scripts/` | 每个包对外的约定（各包的 README） |
| 模块怎么分、怎么起名、谁能用谁；服务、`make`、`layer`、开机的 `start`/`ready` | 每块业务里面的行为（[工单](docs/subsystems/issue.md)、[帮工](docs/subsystems/session.md)、[项目](docs/subsystems/project.md)、[频道](docs/subsystems/channel.md)、[管家](docs/subsystems/orchestrator.md)、[定时任务](docs/subsystems/cron.md)、[种植计划](docs/subsystems/task.md)、[记性](docs/subsystems/memory.md)） |
| 形状、Schema 和接口表放在哪 | 核心状态折什么、帧里有什么（[architecture.md](docs/architecture.md)「核心状态」） |
| 规则放在哪、黄金数据跟着谁 | 某条规则本身（它的主人的子系统） |
| 存盘的地基：一个 PGlite 库、一份表结构、effect-sqlc、表名、uuidv7 主键、不认旧数据 | 每张表存什么（拥有它的子系统）；家目录里的文件（[architecture.md](docs/architecture.md#存了什么)）和配置键（[设置和配置](docs/subsystems/setting.md#模型和不变量)） |
| 测试的地基：`src/testing`、黄金数据、oar 的 `scriptedRuntime`；旧名字和能力表的检查 | 接口的处理（`handlers.ts`）、页面的分层（[客户端](docs/subsystems/app.md)） |
| 话放在哪：词典（`packages/i18n`）、`prompts.ts`、主人的语言怎么传到每个进程 | 某一句怎么说（说它的模块）；用哪个词（[用语表](docs/README.md#用语)） |

## 在哪

- **仓库**：`pnpm-workspace.yaml` 列出 workspace（`apps/*`、`packages/*`），由 Vite+（`vp`）管：`vp install` 装一次（pnpm 12，设置都在 `pnpm-workspace.yaml`）。依赖的版本只写在 `pnpm-workspace.yaml` 的 catalog 里，各包的 `package.json` 写 `catalog:`（Expo SDK 定的那批写 `catalog:expo`），同一个依赖全仓库只有一个版本；`pnpm add` 照 `catalogMode: strict` 把版本放进 catalog，手写的版本由 `scripts/catalog.test.ts` 拦下；`vite`、`vitest` 再经 `overrides` 指到 Vite+ 带的那一份。依赖的文件只在 pnpm 的全局虚拟仓库里放一份（`enableGlobalVirtualStore`），每个 checkout 和帮工的 worktree 的 `node_modules` 只是链过去：一个新 worktree 几秒装好、只有几十个文件。全局仓库不提升（hoist），所以类型里用了没声明的包的依赖，在 `packageExtensions` 里替它声明（`@solidjs/web` 的 `csstype`、`expo-camera` 的 `@types/react`）。`site/` 不在 workspace 里，有自己的 `pnpm-workspace.yaml` 和版本；桌面版打包时把 `catalog:` 换成 pnpm 装的确切版本再交给 npm（`apps/desktop/scripts/package.ts`）。根目录的 `vite.config.ts` 是格式（oxfmt）和 lint（oxlint，带类型）的设置，`vp check` 一起跑它们和类型；共用的 TypeScript 设置在 `tsconfig.base.json`，根目录的 `tsconfig.json` 管 `scripts/`；全部包的类型由 `vp check` 一并查，各包不另跑 `tsc`。
- **服务端** `apps/server`：`src/main.ts`（服务端）、`src/cli.ts`（命令行）；`src/services.ts`（全部服务的次序）、`src/handlers.ts`（每个接口转给哪个服务）、`src/http/`（`app.ts` 组装、`api.ts` 按接口表路由、`streams.ts` 三条 SSE、`mcp.ts`、`page.ts` 页面）。
- **地基** `src/base`：`config.ts`（`ServerConfig`、`loadConfig`）、`db.ts`（`Database`）、`time.ts`（给 Effect 以外的代码的 `Time`、真实时间的截止）、`log.ts`（回调里的日志 `callbackLog`，没有服务可问时的 `plainLog`）、`ids.ts`（`newId`、`code`）、`lease.ts`（家目录的租约）、`files.ts`、`redact.ts`；`src/errors.ts` 是接口的拒绝。
- **形状和接口**：`packages/protocol/src/shapes.ts`（类型和两边共用的常量）、`schema.ts`（每个形状的 Schema）、`api.ts`（`endpoints` 表、`Handlers`、`errorStatus`）、`client.ts`（`VibeValleyApi`，由 `scripts/api-client.ts` 照 `api.ts` 写出）、`stream.ts`（读 SSE）；能力表 [capabilities.md](docs/reference/capabilities.md) 由 `scripts/capabilities.ts` 从 `endpoints` 写出。
- **规则和黄金数据**：页面和服务端都跑的在 `packages/protocol/src/rules`（`@vibevalley/protocol/rules`），只有服务端跑的在拥有它的模块里（`issue/status.ts`、`channel/audience.ts`……），折法和拼帧在 `projection/`；黄金数据是 `apps/server/src/<模块>/testdata/*.jsonl.gz`（核心状态的折法、拼帧和共用规则的在 `core/testdata`，`core/golden.test.ts` 读），读写工具 `src/testing/golden.ts`。
- **存盘**：`apps/server/db/migrations/0001_schema.up.sql`、`db/queries/<表>.sql`、生成的 `db/generated/`，生成器的设置 `db/effect-sqlc.json`，脚本 `scripts/db-generate.ts`。
- **测试工具**：`src/testing/layers.ts`（`testConfig`、`testDatabase`：临时家目录、内存库）、`world.ts`（`world`：一整座农场，农机和它的额度由测试给）、`git.ts`（真的 git 仓库）、`golden.ts`（按模块找黄金数据，读、比、更新在 `@vibevalley/testkit/golden`）；`src/flows/farm.ts`（流程测试的农场和帮工）；`@vibevalley/ai/testing`（照脚本回答的模型，大脑经 `packages/agent/src/testing.ts` 用它）。
- **话**：对主人说的都在 `packages/i18n`（`@vibevalley/i18n`）：词典是 `locales/<语言>/<命名空间>.json`，命名空间是「宿主.模块」（`web.setting`、`server.issue`、`desktop`、`mobile`，两边都说的是 `shared`）；代码里写 `t("web.setting.keys.saved")`、`t("server.issue.does.merge", { base, commits, helper })`，按一个值取、值可能不对应词条时用 `maybe()`，列表用 `list()`，把两段话接起来（「标签：内容」「内容（旁注）」）用 `shared.join` 的几条；`src/catalogs.ts` 由 `vp run i18n:gen` 从词典写出（词条连同每条的参数类型）；语言是 `currentLocale`、`setLocale`。命令行 `vpx scripts/i18n.ts`：`scan` 列出每个键在哪用，`check`（在 `docs:verify` 里）查用到却没有的、没人用的、英文缺或多的、占位对不上的、英文里有汉字的、中英一字不差的（`same.json` 列出有意一样的，比如「中文」），`find <文字>` 按文字找键，`migrate` 是把旧的词表搬进来用的。对模型说的在模块的 `prompts.ts`（主人的语言是 `src/prompts.ts` 的 `ownersLanguage`）；种子和工单模板是 `agent/seeds.json`、`template_catalog.json` 和各自的 `.en.json`。
- **Effect 的诊断**：`@effect/tsgo` 的 `effect-tsgo diagnostics`（`vp run effect:check`，在 `server:check` 和 CI 里，警告也算失败），规则和级别写在 `tsconfig.base.json` 的 `plugins`；不改 `node_modules`（全局虚拟仓库不让改）。关掉的三条：`unstableApiUsage`（`effect/http`、`effect/sql`、`effect/cli` 在 v4 都标成不稳定，而它们是这里的地基）、`lazyEffect`（接口表 `Handlers` 每个接口都是「输入到 Effect」，没有输入的也一样）、`effectSucceedWithVoid`（`Effect.succeed(undefined)` 在这里都是有意义的「没有」，换成 `Effect.void` 类型就变了）。真要在一行上违反一条规则时写 `// @effect-diagnostics-next-line <规则>:off`，上一行说为什么。
- **可选就是没有**：`tsconfig.base.json` 开着 `exactOptionalPropertyTypes`，`x?: T` 只能不写，不能写成 `undefined`。什么时候必有、什么时候可选、`undefined` 和 `null` 各用在哪，照 [没有值](docs/style/code.md#没有值)；含着 `undefined` 的对象经 `omitUndefined`（`@vibevalley/protocol/rules`）去掉这些键再交出去，不一处处写条件展开；`state.json` 里归库的那几样（工单、定时任务、连接器）存成空的；存盘的只记有的，用自己的形状（任务图事件的 payload），读出来再补成必有的；组件转交上一层的可选属性时写 `x?: T | undefined`（JSX 没法按条件不写一个属性）。MCP SDK 自己的传输类不合它的 `Transport`，只在 `packages/agent/src/mcpTransport.ts` 的 `asTransport` 转一次。
- **`@/` 是 src**：`apps/web`、`apps/server` 里出了自己文件夹的 import 从 src 写起（`@/issue/issue.ts`、`@/features/issue`），同一个文件在哪儿引都是一个写法，挪文件也不改别人的 import；同文件夹和下面的照旧写 `./`。lint 的 `vibevalley/parent-import` 拦 `../`，只放出了 src 的（服务端的 `db/generated`）。它是各自 `tsconfig.json` 的 `paths`：Vite 和 Vitest 经 `resolve.tsconfigPaths` 读，tsx 从工作目录找 tsconfig，所以服务端在 `apps/server` 里起（脚本、桌面版都这样；别处起要带 `--tsconfig`），打包的服务端写进同样的 `paths`。查边界的 `modules.test.ts`、`page-layers` 和测试金字塔都认它。
- **检查**：`src/base/schema.test.ts`（表结构）、`scripts/stale-names.ts`（`vp run names:verify`）、`scripts/capabilities.ts --check`，后两个在 `docs:verify` 里。

## 模型和不变量

**仓库和包**

- **一门语言**：服务端、页面、桌面壳、规则都是 TypeScript。服务端在 Node 24 上用 tsx 直接跑源码，不打包；页面由 Vite 构建；脚本用 `vpx` 直接跑，单元测试用 `vp test`。
- **`packages/protocol` 只有形状和纯函数**：不碰文件、网络和时钟以外的东西，服务端和页面都能 import；`effect` 是它唯一的依赖（Schema）。
- **`@vibevalley/protocol/host` 是页面向宿主要东西的唯一入口**：契约和 protocol 的别处放在一起，桌面壳、手机壳各自实现（[客户端](docs/subsystems/app.md)）。

**模块和服务**

- **一块业务一个文件夹**，都在 `apps/server/src/` 下，名字单数，用[用语表](docs/README.md#用语)和[概念](docs/concepts.md)里的词；哪些文件夹、排成哪几层，以 [`modules.ts`](apps/server/src/modules.ts) 为准（`modules.test.ts` 查每个文件夹都在表里）。子文件夹只有 `packages/agent`（VibeValley 自己的 agent）。
- **一个模块导出一个服务**：照 Effect 给应用的默认写法（`node_modules/effect/AGENTS.md`）：`class Issues extends Context.Service<Issues, { … }>()("vibevalley/Issue") { static readonly layer = … }`，接口写在类型参数里，不另起名；`make`（`Effect.gen` 里 `yield*` 它用到的服务和 `ServerConfig`）用 `Issues.of({ … })` 拼出服务；layer 在 `make` 之后定义，所以静态的 `layer` 经 `Effect.suspend(() => make)` 取它。别处要它的类型写 `Issues["Service"]`，要其中一个方法写 `Issues["Service"]["edit"]`。`Projection` 是例外：接口归 `core`，实现在上层的 `projection`，它的 layer 在那里。没有服务拿整个农场。一块业务里分开写的几部分是模块里不导出的函数，`make` 把它们拼成一个服务。
- **`base` 只放地基**：配置、数据库、id、租约、存文件、日志脱敏、谁在做（`Actor`）。不放业务，不放服务之间传的形状；那些形状放在定义它的模块里，上下两层都用的放在下层。
- **谁在做是一个 `Actor`**（`base/actor.ts`）：主人、管家（带 `forOwner`：这一轮有没有主人的话）、某个帮工（Session）、农场自己。只有入口造它：HTTP 接口是主人（服务端只听本机，手机是主人放进来的设备）；管家的工具是管家；帮工经 `/mcp` 的工具是那个帮工；定时任务和巡查是农场。改东西的服务操作带着它，自己按 `actsForOwner` 判断要不要主人的话（工单的改和挪、计划的开工和合并、定时任务要不要等主人同意），规矩不写在工具层或入口。记下来的只有它的种类（`ActorKind`：计划的修改记录、定时任务是谁定的、记性是谁记的），表里的取值约束跟着它。
- **十个模块，有先后**：文件夹归进十个模块（`src/modules.ts`），从下往上 Platform、Agents、Source Control、Collaboration、Agent Sessions、Issues、Notifications、Orchestrator、Gamification、Gateway。一个模块只 import 排在它前面的，也不读核心状态里别的模块那一块，经那个模块的查询（`Sessions.sessionOf`、`Issues.onBoard`、`Tasks.graphs`、`Channels.now`）；`src/modules.test.ts` 扫 import 和 `core.state()` 查这两条。反方向的消息走带类型的流（`Sessions.news`、`Channels.ownerInThread`、`Notices.news`），订阅的人自己读，发布的人不等；下面的模块要上面的东西时，由上面的在建的时候登记给它（频道的 `Helpers`）。`game` 只听别的服务的事实，业务的服务不调它。
- **组装分两段**：`services.ts` 每个模块一个组装函数（`platform`、`agents`……`gateway`，`on(layer)` 是 `Layer.provideMerge`），先把十个模块都建好（建的时候订阅自己要跟的），再按模块顺序跑各自的开机（`sourceControlStart` 第一次看 GitHub，`agentSessionsStart` 把帮工请回来，`issuesStart` 整理被打断的计划、定时任务开始走，`notificationsStart` 记下 Inbox 里已有的、开始巡查，`gamificationStart` 数 commit）。测试的 `testing/world.ts` 用同一套组装函数。`http/app.ts` 先开始答 HTTP，再把地址告诉 `Sessions`（`/mcp`）和 `Lan`（转发），所以开机就开的执行连得上 `/mcp`。
- **折法和拼帧在组装那一层**：`projection/` 的 `reduce`、`frameOf` 读每个模块的规则，组装时以 `Projection` 交给 Platform 里的 `core`，`core` 不 import 上面的模块。
- **一个家目录一个服务端**：`base/lease.ts` 在家目录写 `.vibevalley.lock`（里面是进程号）；第二个服务端开不起来，锁着它的进程已经不在了就接过来（Node 没有 `flock`）。

**Effect 的写法**

- **服务的方法有名字**：`make` 返回的方法和内部的帮手写成 `Effect.fn("<服务>.<名字>")(function* (...) {...})`，出错的栈和追踪里看得出是哪个；不需要追踪的可复用函数用 `Effect.fnUntraced`，不写只返回 `Effect.gen` 的包装。要锁的把 `lock.withPermits(1)` 作为后续参数，参数的类型由服务的 Shape 定。
- **Promise 只在外面的库的一次调用上**：SDK、`fetch`、oar、MCP 的 SDK、大脑里还是 async 的工具身体。一次调用用 `Effect.tryPromise({ try: (signal) => … })` 包，纤程被打断时 signal 跟着 abort；循环、排队、等待、退避、换代、并发和超时都写在 Effect 里：连接器每个应用的一代工作是一条纤程，命令一个一个来是一把 `Semaphore`，「睡到时候或被叫醒」是 `Effect.sleep` 和一次唤醒赛跑；记性的来源一代一个 `Scope`，读是 `Effect.forEach` 加超时，后台写是一条 `Queue`；农机的探测四个一起是 `Effect.forEach` 的 `concurrency`；管家的工具是 `Effect.fn`，也就是循环（`packages/agent/src/core`）的工具，一轮被叫停就打断它。外面的 HTTP 走 `HttpClient`（`platform` 提供 `FetchHttpClient.layer`，测试换 `FetchHttpClient.Fetch`）。还在 Promise 一侧的只有执行的宿主、oar 的农机、语音的隧道和终端里的对话：构造时接 `Time` 和日志（服务给 `callbackLog`，命令行给 `plainLog`），lint 不许它们用 `console`；它们经 `openBrain`（`packages/agent/src/brain.ts`）用大脑，在那里把大脑的 Effect 跑成 Promise。lint 的 `vibevalley/promise-boundary` 查：服务端里的 `async` 函数只能是 `Effect.tryPromise`、`Effect.promise` 的参数，不写 `new Promise`；接口本来就是 Promise 的（oar 的农机、MCP SDK 的处理、给模型客户端的 fetch）在 `vite.config.ts` 里按文件放开并说为什么，还没搬进 Effect 的另列一张只减不加的单子。
- **Effect 代码里不另起运行时**：在 `Effect.gen` 里施加事实、发提醒是 `yield* core.apply(...)`；`Effect.runSync` 只留给外面的库的回调（oar 的事件、汇报），它们不在纤程里、要照给的次序落下。给外面的库（oar、记性的来源、MCP、node 的 http）的回调起的纤程用 `FiberSet.makeRuntime*`，归服务的作用域。
- **定时任务归作用域**：服务里等一会儿再做的（防抖存盘、合并写、攒一下再提醒、太久没动静）是服务自己的 `FiberMap` 里的纤程：同一个键再来就换掉上一个，`onlyIfMissing` 是已经在等就不再排；超时用 `Effect.timeoutOption`。服务关的时候作用域收掉它们，不手动 `clearTimeout`。同一段逻辑的 `Effect.sleep` 和静默时长用同一个 Clock；同步回调要读时间时用它的 `currentTimeMillisUnsafe`，不另读墙钟。时间只从 `Clock` 来，lint 查（`vibevalley/no-wall-clock`，`scripts/oxlint-plugin.ts`：`apps/server/src` 里不许 `Date.now()`、不带参数的 `new Date()`、`setTimeout`、`setInterval`）：Effect 的生成器里读现在是 `yield* Clock.currentTimeMillis`，回调里要读时间的服务在 `make` 里取一次 `Clock.Clock`，用它的 `currentTimeMillisUnsafe`；Effect 以外的类（轨迹、执行的宿主）构造时接一个 `Time`（`base/time.ts`：`timeHere` 把服务的 Clock 变成 `now`、`sleep`、`after`），不自己读墙钟、开计时器。只有两种时间是真的：真实进程和外部协议的截止与节奏（命令的超时、杀进程前的宽限、农机的探测、QQ 的令牌和心跳、扫码登录的轮询、cloudflared），用 `base/time.ts` 的 `afterRealTime`、`withinRealTime`、`wallTime`，名字说明它是真时间；没有服务可问的命令行用 `wallTime`。id 里的时间只用来排序，`newId` 照旧读墙钟。`it.effect` 的测试用 `TestClock` 拨（从 0 开始，要真实的时间先 `TestClock.setTime`）；搭整座农场跑真钟的测试给 `world` 一个 `clock`（`testing/clock.ts`：每个服务读的「现在」由测试给，睡照真的睡）。服务不另开 `now` 选项，也不为测试开缩短窗口的选项。
- **读写过异步的状态才上锁**：服务里的 `let` 多是句柄、标记、读改写在同一步里的同步状态，不换成 `Ref`；读和写之间隔着 `yield*` 的才要一把锁或 `SynchronizedRef`（连接到本机的开和关）。
- **工单和执行的 id 带品牌**：`IssueId`、`SessionId`（protocol 的 `shapes.ts`），线上和库里仍是字符串。从库的行、外来的字符串、新起的 id 变成它们时用 `@vibevalley/protocol/schema` 的 `issueId`、`sessionId`（`Brand.nominal`，不检查），只在知道是哪一种的地方用；提及、参与者这种几种 id 混着走的地方是 `string`，和品牌比较不用转。
- **定期的后台任务用 `Schedule`**：`x.pipe(Effect.repeat(Schedule.spaced(n)))`，先等一个周期再做的加 `Effect.delay(n)`；不写 `Effect.forever` 加 `Effect.sleep`。等到有事才攒一阵的（核心状态出帧）不是定期，照旧用 `Effect.forever`。
- **文件走 `FileSystem`，表里的 JSON 照 Schema 读**：`platform` 提供 `NodeServices.layer`；服务的 Effect 代码里用 `FileSystem`，失败照旧是缺陷（`Effect.orDie`）。自己写进表的 JSON 列用 protocol 的 Schema 读回来（`base/json.ts` 的 `jsonOf`、`jsonOrNone`），不 `JSON.parse(...) as T`。
- **库经 `Db` 服务用**（`base/db.ts`，`platform` 提供）：`run` 跑生成的查询、失败是缺陷；`attempt` 留着失败给要记日志或说成拒绝的调用方；`one` 取单行，只把 `NoSuchElementError` 折成 `undefined`，`SqlError`、`SchemaError` 照旧是缺陷，不用 `Effect.option` 把它们当成「没有这一行」；`inTx` 包一个事务。模块不各写一份 `provideService(SqlClient)`。
- **错误带 `_tag`**：服务自己的错误是 `Data.TaggedError`（`ProjectError`、`MergeFailure`、`GitError`、`NotTakenIn`、`SettingRefused`、`MemoryRefused`、记性来源的 `SourceError`、工具的 `ToolRefusal`、配置的 `ConfigError`），按 `catchTag` 接、能直接 `yield*`，不用 `instanceof` 分；`MergeFailure` 由 `MergeFailure.conflict(base, files)`、`.check(why)`、`.error(why)` 造。只在同步或 Promise 的代码里抛的照旧是 `Error`。

**形状和规则**

- **形状写一次，Schema 由它定类型**：`shapes.ts` 是类型，`schema.ts` 里每个 Schema 写成 `Codec<T.X>`（`Schema.Codec<T.X, Wire<T.X>>`：线上的一侧是去掉 id 品牌的同一个形状），两边对不上就编不过，`schema.test.ts` 再逐个查 Schema 和 interface 的键；`endpoints` 里的每一行带方法、路径、参数、请求和回答的 Schema、`can`（谁能调），`Handlers` 由它推出，`handlers.ts` 漏了或多了一个接口就编不过。服务端按这张表路由（`http/api.ts`：请求解不开是 400，拒绝按 `errorStatus` 给状态码），页面和命令行用同一张表调（`VibeValleyApi`、`cli.ts`）。
- **生成的不手改**：`db/generated/`、[capabilities.md](docs/reference/capabilities.md) 和 `packages/protocol/src/client.ts`（`vp run api:client`：每个方法的参数、回答和注释照 `Handlers`，方法、路径、查询和请求体照 `endpoints`；生成而不在运行时读 `endpoints`，HTTP 的调用不用带上每个接口的 Schema；页面里的 Effect 只在房间的连接上（`apps/web/src/base/gateway.ts`，[频道](docs/subsystems/channel.md)）；`docs:verify` 查它是不是最新）。生成的 client 对非 2xx 先做不依赖 Schema 的结构校验，真正的 `ApiError` 保留标签和 `next`，纯文本或畸形响应也保留状态和原始 `body`；成功仍走普通 JSON 解析。`seeds.json`、`template_catalog.json`（`packages/protocol/src/rules`）是直接改的数据文件。
- **要每种都处理的地方穷尽**：按 `_tag`、`type` 分支的 `switch` 覆盖每一种，返回值或 `never` 让 `tsc` 查出漏掉的；成员表要每种都处理时写成 `Record<X, …>`。
- **规则在它的主人那里，protocol 只放契约**：只有服务端跑的规则在拥有它的模块里（`session/roster.ts`、`issue/status.ts`、`task/graph.ts`、`game/view.ts`、`notice/inbox.ts`、`setting/saving.ts`、`runtime/quota.ts`……），上面的模块可以 import 下面的；核心状态的折法和拼帧读每个模块的规则，放在组装那一层（`projection/`），交给 `core`。`packages/protocol/src/rules` 只放页面和服务端都跑的（`rules/contract.test.ts` 查）。页面要的结论由服务端算好写进帧或另开接口问；只有跟着页面的时钟走、两边都得算的（帮工在干什么的话）才挪进 protocol，不在页面里重写。
- **黄金数据跟着规则**：每处有规则的地方有 `testdata/*.jsonl.gz`（成千上万条带种子的随机输入和结果），测试逐条比。`VIBEVALLEY_GOLDEN=update`（`vp run golden:update`，后面加 `<模块>` 或 `ai` 只重写那一处，`scripts/golden-update.ts`）用现在的结果重写，看 diff 再留。
- **字符串照 JavaScript 自己的算法**：长度按 UTF-16 码元、空白是 `\s`；切断的代理对换成 U+FFFD（`apps/server/src/base/clip.ts`）。没有另一份。

**存盘**

- **一个 PGlite 库**：`base/db.ts` 在家目录的库文件夹里开 PGlite（编成 WASM 的 Postgres，在服务端进程里），测试用内存库。一条连接，所以行的先后就是提交的先后（消息的编号靠它）。时间存毫秒的 `bigint`。
- **SQL 只在 effect-sqlc**：查询在 `db/queries/<表>.sql`，一张表一个文件，只写这张表（联查别的表可以，写不行）；服务里不手写 SQL，只调 `db/generated` 的函数，再把行读成自己的形状。改完跑 `vp run --filter @vibevalley/server db:generate`，`server:check` 跑 `db:check` 查生成的是不是最新。
- **表名是 `<模块>` 或 `<模块>_<概念>`**，单数，模块是拥有它的 `src` 文件夹（`issue`、`issue_session`、`channel_message`、`session_run`、`game_ledger`、`lan_device`）。索引名以表名开头。
- **一份表结构，不认旧数据**：`0001_schema.up.sql` 是整个库，改表直接改它，不另加迁移；`migrations/` 里只能有这一个文件。开机时 `PgliteMigrator` 在空库上跑它；旧库不升级：库的文件夹旁边 `db.schema` 记着建它的基线的哈希，对不上就把整个文件夹挪到 `db.<旧哈希>-<时间>`（不删）再新建一个，日志里说一句；没有 `db.schema` 的当作今天的。测试的库在内存里，由 `Database` 自己管：每个进程第一个库跑完基线就存一份文件，之后的库从这份文件起；一座农场关的时候它的库不关，关掉外键检查逐表 `DELETE`、序号从 1 重来，清空后留给下一座（同时开着的农场各拿一个；比 `TRUNCATE` 便宜，它要给每张表重建文件）。只有没人改过表结构的才留：第一个库装了一个事件触发器，任何 DDL 都在会话上打个记号（测试为了让写失败加的触发器、删改的表），有记号的库关掉。存盘的格式只有现在这一种：表、家目录里的文件、环境变量、存下的取值都只认今天的名字。
- **运行时新建的行主键是 uuidv7**：`base/ids.ts` 的 `newId()`（带时间，同一毫秒里接着数，同一进程里单调），存成 `text`；协议里的 id 都是 `string`。不用 uuid 的：从文件来的自然键（档案、技能、项目、农机、连接器）、单例、几列组成的主键。工单另有从 1 数的 `number`，消息在对话里有从 1 数的 `number`。`code()` 是给人念的配对码，不是 id。

**测试**

- **测试是一座金字塔，一层一个接缝**：测试从这一层的接缝进系统，接缝以内是真的，外面的世界只在端口上换成假的；层由检查认出来，不靠起名或记得。

  | 层 | 从哪进 | 真的 | 换成假的（端口） | 时间 | 预算 | 在哪、谁认 |
  |---|---|---|---|---|---|---|
  | 规则 | 函数和类的接口，在进程里 | 被测的代码 | 照脚本回答的模型（`@vibevalley/ai/testing`）、脚本帮工、手写的假端口 | 参数或 `TestClock` | 20 毫秒 | 经 import 一路碰不到库、子进程、网络的（`@vibevalley/testkit/pyramid`，跟着 `@vibevalley/*` 的 import 进包里） |
  | 模块 | 一个模块的服务接口 | 它和它下面的层：测试库池、模块自己拥有的 git 和子进程 | 编码 agent、模型、聊天软件、GitHub、声网 | `TestClock`；真时间只用于真进程的期限和等后台 | 300 毫秒 | 碰得到的 |
  | 流程 | 整座农场（`flows/farm.ts`） | 全部模块、真 git | 同上 | 同上 | 2 秒 | `src/flows` |
  | 页面 | HTTP 和 SSE | 一个真的服务端进程 | 环境里没有钥匙，runtime 换成照字眼干活的帮工 | 真时间，随时间走的画面用 `page.clock` | 3 秒 | `apps/web/test` |
  | 整个应用 | 宿主接口（`@vibevalley/protocol/host`） | Electron、模拟器 | — | 真时间 | 不设 | `apps/desktop`、`apps/mobile` |
  | 真模型 | 管家的提示和工具描述 | 真模型 | — | — | 不计；手动跑，先问主人 | 评测样例、`vv-acceptance` skill |

  一个行为在能看见它的最低一层测；模块测试主要在验证一个决定时任务，把决定抽成纯函数、模块测试只留一个接线；流程测试只写跨模块的用户故事。边界由检查守：`testing/pyramid.test.ts`（流程的农场只在 `src/flows`，各模块重放黄金数据的 `recorded.test.ts` 留在进程里）、`apps/web/src/pageTests.test.ts`（页面测试只经浏览器、Playwright 和协议）、lint `vibevalley/no-test-sleep`（不靠时间等）。预算超两倍的由 `@vibevalley/testkit/budgets` 和 `apps/web/test/budgets.ts` 在每次跑完列出来，不算失败。

- **不连网、不花钱**：帮工由 oar 的 `scriptedRuntime`（`@botiverse/oar/testing`）扮演：同样的记录、折叠和控制，没有程序、登录和模型；项目用临时目录里真的 git 仓库；模型用照脚本回答的 `Llm`（`@vibevalley/ai/testing`）；声网和三家聊天软件是本地假服务；测试里不探测本机的农机，`gh` 回答它不在（`noGitHub`）。
- **测试跟着它测的模块走**：`<模块>/*.test.ts` 用 `@effect/vitest`，要整座农场的用 `testing/world.ts` 的 `world`，只要下面几层的用 `worldBelowTasks`；单个函数直接测。一路走过好几个模块的流程（起草、派活、验收、完成、重启、记性跨会话）在 `src/flows`：`flows/farm.ts` 搭一座开机就接回帮工、记账本的农场，帮工照工单里的字眼干活（`写版本A` 提交、`有冲突` 合并、`先问清楚` 问主人、`发呆`、`慢慢` 先挂住，测试做完它在忙时要做的再 `releaseHeld(n)` 放行（页面的测试放不了，1.5 秒后自己接着做）、`必败` 失败）。等会发生的事用 `testing/until.ts`（`until`、`untilGot`、`waitFor`：按真时间每毫秒再问一次，和农场的 Clock 无关，所以拨着 `TestClock` 的测试也能等真的工作；到期限就带着在等什么失败），不用 `sleep` 赌时间：测试里写死时长的 `setTimeout`、`setInterval`、`Effect.sleep` 和 Playwright 的 `waitForTimeout` 由 lint（`vibevalley/no-test-sleep`）拦下。要等什么就等它本身：后台的事用 `until`、`untilGot`、`waitFor`、`whenState`（等核心状态的变化），Promise 写的测试用 `whenTrue`；要一个期限用 `within`；假端口要忙一阵就停在 `gate()` 门口，由测试放行；"什么也没发生"在能让它发生的东西已经启动时等一轮事件循环（`aTurn`、`nextTurn`）；管家一次只接一句话，等一句标记被接下，前面的就都接完了。实在没有可等的（一个"不会再来一次"的否定断言），写一行 `oxlint-disable-next-line vibevalley/no-test-sleep` 并说明为什么。页面测试截图前等 `settled(page)`（字体、图片、两帧画面），随时间走的画面用 `page.clock` 快进，慢的服务端用 `gate()` 拦在路由上（`apps/web/test/fixtures.ts`）；页面的单元测试用 vitest 的假定时任务器。有时间窗口的（冷却、合并写、再提醒、定时任务到点、重试的退避）用 `TestClock` 拨过去断言，不真等、不改常量。看不到等待从哪一刻开始的（藏在 Promise 那边的退避），每问一次拨一下钟（`waitFor(Effect.map(TestClock.adjust(…), …), …)`）。测试分三层，层由 `@vibevalley/testkit/pyramid` 按一个文件经 import 一路碰得到什么算出来：`src/flows` 下的是流程；碰得到库、子进程或网络的是模块；碰不到的是规则。每层有预算（规则 20 毫秒、模块 300 毫秒、流程 2 秒）；`vp test run` 结束时由 `@vibevalley/testkit/budgets` 打出每层几个文件、几个测试、花了多久，再从慢到快列出超过预算两倍的，不算失败（各机器快慢不同），是该看它在等什么、搭了什么的信号。`testing/pyramid.test.ts` 守两条边界：流程的整座农场只在 `src/flows` 里搭；各模块重放黄金数据的 `recorded.test.ts` 碰不到外面；一个测试在哪一层由它 import 什么认，不看文件名。页面这一层（`apps/web/test` 的 Playwright）每个测试的预算是 3 秒，`apps/web/test/budgets.ts` 在跑完时报出这一层几个测试、花了多久和超两倍的；`apps/web/src/pageTests.test.ts` 守它的边界：页面测试只经 fixtures、Playwright 和协议的形状进系统，不碰页面和服务端的代码。测试要的临时文件夹用 `tempDir`（`@vibevalley/testkit/temp`），进程结束时删掉；服务端里直接 `mkdtempSync` 由 lint 拦下。
- **规则在它自己的接口上测**：搭整座农场的测试只断言要跨模块的那条主线；一条规则（重试的策略、窗口、退避）在它所在的函数上单独测，农场级的测试不为它付时间（语音：`retrying` 有自己的测试，停止失败的测试用不会重试的 403）。
- **测试跑得便宜**：服务端的测试不逐文件隔离（`apps/server/vite.config.ts` 的 `isolate: false`），模块每个 worker 只加载一次，内存库的池和快照跨文件留着；成立的前提是没有测试靠别的测试的模块状态，打乱顺序跑（`vp test run --sequence.shuffle`）结果一样。测试用的 git 仓库每种只在每个进程里真建一次（`testing/git.ts` 的模板），之后复制；模板关掉 git 的后台维护（`maintenance.auto false`、`gc.auto 0`），它会在复制的时候改 `.git/objects`。
- **页面测试只测接线和主线，不测文案**：页面这一层（`apps/web/test`）证明的是页面和服务端接得上：页面连得上服务端、点下去的动作真的发出去、状态变了页面跟着变、一条用户故事走得通（派活、提问、交活、合并）。它不断言界面上的话：话对不对是词典的事（`vpx scripts/i18n.ts check` 查漏翻和占位，`english.spec.ts` 扫每页有没有剩下的中文），改一句措辞不该让页面测试挂。规则不在这一层测：服务端的规则在服务端的测试里，页面里的判断（怎么拼一轮的字、线路质量怎么算、设置的搜索怎么匹配、看板怎么排）抽成 `features/<概念>/*.ts` 的纯函数，用 vitest 测（`src/**/*.test.ts`，页面的规则层），页面测试只留一条接线。
- **页面测试按稳定的标记找元素，不按字**：要点、要看的元素带 `data-testid`（说它是什么，小写加连字符：`moss-talk`、`settings-nav`、`issue-card`），状态写成属性（`data-state`、`aria-pressed`、`aria-current`、`data-found`），测试找 `getByTestId`、断言属性。同类里的某一个用 `data-key` 区分：列表项、消息、卡片用它的 id，页签、分段选项、菜单项用它的值（`[role="tab"][data-key="memory"]`）；工单的按钮用 `data-act`，消息的发送者用 `data-from`（id）和 `data-from-kind`。fixtures 里有常用的：`tab()` 找页签，`composerOn()` 等输入框换到那个频道再打字（早打的字会被那个频道的草稿换掉）。一个 worker 的测试共用一个服务端，别的文件留下的频道、消息、轮次都在：按自己造的东西的 id 找，不按第几个。不按界面上的字找（`getByText("开始说话")`、`getByRole(…, { name: "保存" })`），也不按 CSS 类找。测试自己造的数据（工单标题、档案名，和照字眼干活的帮工认的指令词）是数据，写成常量，按它找可以。lint `vibevalley/no-copy-selector` 拦下 `apps/web/test`、`apps/desktop/test` 里写死中文的选择器和文字断言（`getByText`、`getByRole` 的 `name`、`getByLabel`、`getByPlaceholder`、`getByTitle`、`filter` 的 `hasText`、`toHaveText`、`toContainText`）。
- **可访问性单独查**：按名字找元素的时候顺带查过「按钮有没有名字」，按标记找就查不到了；所以每个工作台页面在浅色、深色两套主题下各跑一次 axe（`@axe-core/playwright` 的 WCAG 2 A、AA，`apps/web/test/a11y.spec.ts`）：没有名字的按钮、没有标签的输入框、对比度不到 4.5:1 的字，有就失败。
- **组件在真的浏览器里测**：`packages/base-ui` 的测试是 Vitest 的浏览器模式（Playwright 带的 Chromium），渲染一个组件、真的点和按键，断言 ARIA、焦点、data 属性和浮层的位置，再跑一次 axe；焦点、顶层（`showModal`）和布局在模拟的 DOM 里不可信。CI 的页面那一步先装 Chromium。
- **HTTP 这一层的测试两种写法各管一件事**：路由、解码、编码和状态码的契约用 `HttpRouter.toWebHandler` 加真的 `Request`（`http/api.test.ts`、`streams.test.ts`），不起端口；一个接口的行为一路走到服务用 `it.live` 加生成的客户端，对着真的端口（`http/endpoints.test.ts`、`rpc.test.ts`）。
- **契约测试是页面的 Playwright**：`apps/web/test` 每个 worker 起一个真的服务端（临时家目录、环境里没有钥匙），点真的页面；`apps/desktop/test` 起整个 Electron 应用。

### 话放在哪

- **对主人的话进词典，对模型的话进 `prompts.ts`。** 主人看得到的（界面上的字、写进帧的说法、通知、拒绝的理由、频道里的系统消息、以主人的名义写进串里的话、命令行和连接器的输出）写在 `packages/i18n/locales`，中英各一份；模型读的（系统提示、工具说明、交给帮工的活、巡查和管家的输入）写在模块的 `prompts.ts`，只有中文，另加一句用主人的语言说话。两边都读的照谁先读归：拒绝的理由主人和管家都读，进词典。日志是英文，不进词典。
- **一条词条的样子**：键是概念（`server.issue.does.merge`）；值是一句话，`{名字}` 是填进去的值，数一个数用 `{n, plural, one {…} other {…}}`（`#` 是那个数），第几次用 `{n, selectordinal, …}`，按一个开关选用 `{flag, select, true {…} other {…}}`。中文是源头：`gen` 照中文写出每个键要哪些参数（plural 是数，select 是开关），写错键、少传或多传参数编不过；别的语言少一条运行时用中文兜底，`check` 在 CI 里报。一句话有可选的一截（有就说，没有就不说），写成两条，调用处选；不在词条里写逻辑。用的时候每次调 `t`，不在模块顶上存一份句子。
- **语言是农场的，一个进程一个**：存在设置里（`settings.json` 的 `locale`，默认 `zh`），服务端读出和保存时 `setLocale`；页面从服务端发的 `index.html` 上的 `data-locale` 读，换了语言重新打开；命令行和桌面壳开机读同一个 `settings.json`，桌面壳再听页面经宿主接口说的（`host.locale`），菜单栏和灵动岛跟着变；手机壳说手机自己的语言。存进库的话（频道里的消息、时间线）是写下那时的语言，换了不回头翻。
- **频道的名字不翻**：开机建的默认频道叫 `general`（`firstChannelName`），名字存下来，地址和给模型的话都写它；农场把默认频道画成词典里的「田头」，工作台写它的名字。
- **模型写的记号不翻**：提示要帮工照原样写「结论：」「要问主人：」「标准 N：」「记住：」；读的时候英文的写法（Conclusion、Ask the owner、Criterion N、Remember）也认。
- **lint 卡住**：`vibevalley/no-cjk-literal`（`scripts/oxlint-plugin.ts`）拒绝 `apps/*/src`、`packages/*/src` 里字符串、模板和 JSX 文字中的汉字和中文标点（拿「：」「、」把两段话粘起来，在英文的农场里也是中文）；生成的 `packages/i18n/src/catalogs.ts`、`prompts.ts`、测试和测试数据、记忆树的假数据不查；正则不查。对模型说的话也只在 `prompts.ts`：VibeValley 自己的 agent 在 `packages/agent/src/prompts.ts`，管家和帮工用的工具（说明、参数、回给模型的话）在 `tool/prompts.ts`，模块里的代码只引用它们。

## 怎么走

**加一个模块**

1. 名字用单数、用语表里的词；写服务类、`make`、`layer`，服务之间传的形状放在它里面。
2. 按依赖插进 `services.ts`（和 `testing/world.ts`）；开机要做的写成 `start` 一类的 layer，叠在最后。
3. 要它答接口：在 `api.ts` 的 `endpoints` 加行，`handlers.ts` 编不过的地方就是要接上的。

**加一张表或改表**

1. 在 `0001_schema.up.sql` 里拥有它的那一段直接改：表名 `<模块>_<概念>`，索引以表名开头，主键 `text` 存 uuidv7。
2. 写 `db/queries/<表>.sql`，跑 `vp run --filter @vibevalley/server db:generate`。
3. 服务里调生成的函数，新行的 id 用 `newId()`。
4. 删掉本机的库重建；`schema.test.ts` 查命名、基线和查询文件。

**加一个形状、事实或接口**

1. 改 `shapes.ts`，在 `schema.ts` 写它的 Schema；接口在 `api.ts` 的 `endpoints` 加一行（`can` 写清谁能调）。
2. 编不过的地方就是还没接上的地方：`handlers.ts` 实现新接口，新事实在 `reduce` 里折，要每种都处理的 `switch` 补上。
3. 改了接口跑 `vp run capabilities`；跑 `vp run server:check` 和 `vp run web:check`。

**改一条规则**

1. 改它的主人那里的纯函数；第二个模块也要用，就让它问主人的服务，或挪进 `packages/protocol`。
2. `vp run golden:update` 重写黄金数据，看 diff 是不是只改了该改的。

## 和谁打交道

- **每个服务**：照这里的约定写服务、`make`、`layer`，经 `base` 拿配置、数据库、id。
- **`core`**：核心状态只经 `Core.apply` 改；它最先建、最后关，`state.json` 在每次变化后半秒内写一次，关的时候再写一次。
- **`http/app.ts`、`main.ts`**：建全部服务，开 HTTP，把地址告诉要它的服务；`--ready-json` 让桌面壳读到地址。
- **页面**：直接 import `@vibevalley/protocol` 的类型、规则和 `VibeValleyApi`（[客户端](docs/subsystems/app.md)）。
- **文档**：`scripts/capabilities.ts` 写 [capabilities.md](docs/reference/capabilities.md)；`docs:verify` 跑 `stale-names.ts`，在 `apps/server/src`、`apps/web/src`、`apps/web/test`、`packages/protocol/src` 里查改掉的旧名字。

## 为什么这样

- **按领域切成十个模块，不平铺。** 原来十九个服务一层层叠，只有顺序没有边界：开机的规矩靠层的先后撑着（帮工挂着不存在的工单就是这一类），频道调执行、合并写在执行里、什么要找主人散在四处，管家的工具和接口是两套动作。按限界上下文切（同一个原因改的放一起），依赖只朝下，用一个测试守住。放弃了：维持平铺只加 lint（挡得住新的越界，挡不住放错的）；并成五个大模块（执行同时被工单、频道、管家用，是真 seam，并掉以后使用方又伸进内部）；把核心状态单独当模块（它是投影，单独成模块会继续被当成模块之间互相读数据的通道）。
- **端口只在有两个适配器、或方向必须倒过来时才立。** 频道的 `Helpers` 是因为频道在执行下面；送达的路（通话、手机、系统通知）不立端口，各自订阅。大服务只拆有真 seam 的（工单的起草和合并）；执行和频道的几块共用同一份状态，拆开只是把状态传来传去。
- **代码用行业的词，只在旧词有歧义时才改。** 改过的：Cron（`Schedule` 和 Effect 的撞名）、Refinement（`draft` 同时指表单、计划、消息的草稿）、Review、Question、Attention、WorkspaceState、Orchestrator（管家：收活、派给帮工、盯进度、转告，行业里编排者的位置）；`scripts/stale-names.ts` 拦旧名字。没改的：task graph、project、fact、`SessionEvent`：改名只换说法，牵涉接口路径、表、存盘的值和皮的素材，有的还会和现有的名字撞上。管家的美术素材和地图实体来自美术仓库，名字不跟着改。文件夹也不按模块挪：归属写在 `modules.ts`，挪了只换路径。
- **一门语言到底。** 服务端是 Go、客户端是 Flutter 时，规则写两遍、形状靠生成器在两门语言间搬，驱动编码 agent 的 oar 还得维护一份 Go 的移植。换成 TypeScript 以后，oar 和各家编码 agent 的 SDK 直接用 npm 的，规则在服务端和页面之间共用，agent 只要写好一门。放弃了「服务端留在 Go，只换客户端」：跨语言的成本还在，smith 还要追 oar。
- **Effect v4。** 服务之间的依赖、资源的生命周期、错误类型由它管：`Context.Service` 和 layer 让依赖写在 `make` 上、开停的顺序从叠法里来，Schema 让形状和解码是一份，`effect/http`、`effect/sql` 不用另找。能用 Effect 自己的模块就用（`Cron`、`DateTime`、`Schema`、`HttpRouter`、`PubSub`、`Stream`），不再写一份。
- **照 Effect v4 的写法，但不在交界处硬改。** 服务的方法用 `Effect.fn`、定时任务进作用域、Effect 代码里不另起运行时，是因为名字、中断和收尾由 Effect 管才不会漏（关不干净的定时任务器、跑在纤程外的事实）。交界收窄到外面的库的一次调用：连接器和记性的来源原来整个算 Promise 一侧，停、等、退避、换代各手写一份，每处都要人记得停 `AbortController`、清计时器、等写完再换代，每加一个应用或来源就再写、再测一遍；收进 Effect 以后，中断、超时和收尾由纤程和作用域管，退避用 `TestClock` 拨。大脑也收进来了：pi-agent-core、pi-ai 照接口用 Effect 重写成 `packages/agent/src/core` 和 `ai`（[管家](docs/subsystems/orchestrator.md#为什么这样)），大脑是作用域里的资源，叫停、插话、等一轮完、帮手、定时任务都在纤程上；它也是 oar 的一个 runtime、在终端里单独跑，这两处和执行的宿主经 `openBrain` 一处跑成 Promise。放弃了把服务的状态都换成 `Ref`：大多是同步的读改写，换了要处处 `getUnsafe`，不消掉竞争。放弃了把 `ApiError` 换成 `Schema.TaggedErrorClass`：它是页面和服务端共用的契约，129 处拒绝都要动，收益只是栈和 cause。放弃了把 `project/git.ts` 的子进程换成 `ChildProcess`：它也会杀整个进程组，但超时被打断时会丢掉已经读到的输出（检查超时要说出最后几行），每个 git 的帮手还要多带一个 `ChildProcessSpawner`；现在的 `Effect.callback` 加打断时杀进程组，就是 v4 给这种交界的写法。
- **服务端不打包。** PGlite 的 wasm、分词的词典、表结构、各家 agent 的 SDK 都按包的位置找自己的文件；打成一个文件要逐个改路径。tsx 直接跑源码，桌面版带着 `apps/server` 和它的 `node_modules`（[客户端](docs/subsystems/app.md)）。
- **PGlite，不是 SQLite。** effect-sqlc 读 Postgres 的表结构和查询，类型推得出来；PGlite 在进程里，不要单独装数据库，桌面版带得走。代价是库比 SQLite 大、开机多花一点时间。
- **形状写在 TypeScript，Schema 由类型定。** 只写 Schema 再推类型时，类型的名字和注释在推出来的东西里看不清；只写类型又没有运行时的解码。两样都写、用 `Codec<T.X>` 绑住，编译器保证一致。没有生成这一步，服务端和页面 import 同一份文件。
- **一个模块一个服务，名字单数、用我们的词。** 按「谁调谁」切层切口最少，但那是按代码现状分；按概念分，模块就是产品里的东西（[概念先行](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)）。一块业务一个入口，调用处读得出是谁的事。
- **反方向走流，不让慢订阅者拖住发布者。** 下层要告诉上层的事（事实、执行的动静、给管家的消息）如果直接调，就有环；发布的人不该被慢的订阅者挡住。能从快照恢复的三条 SSE 各经容量 64 的有界 relay，正常顺序不变；到上限的连接明确结束并记错误、释放源订阅，不静默丢帧。必须完整接收的内部事实订阅不在这里断开，也不能用容量上限伪装成可靠交付。
- **规则跟着主人，黄金数据跟着规则。** 规则都堆在一处时，没有哪个名字说得清是谁的。黄金数据跟着规则走，删一条规则就删它的用例；共用的规则在 `packages/protocol`，页面拿到的就是服务端用的那份。
- **查询由 effect-sqlc 生成，一张表一个文件。** 手写在服务里的 SQL 字符串，列和字段靠手对，表改了编译器不知道。按表分文件，改表结构时要看的查询就在同名文件里。没用 ORM：查询不多，SQL 写得更直接。
- **表按模块命名。** 一个库里十几个模块的表共用一个命名空间：频道占了 `message`，`delivery` 会撞。规矩写进 `schema.test.ts`，加一张不合的表测试就失败。
- **一份表结构，不留兼容，不搬数据。** 每次改名都多一段搬旧数据的代码，都在每次启动的路上；项目还没有外部用户，搬数据的代码只让架构成形期的每一步更慢。放弃了「改表写迁移」和「开机看到旧文件顺手导入」。以后有了用户，改存盘要重新写迁移：在 `0001_schema.up.sql` 后面加文件，并改这一条。
- **主键用 uuidv7。** 带时间、同一进程里单调，跨表、跨农场导数据也不会打架。代价是已读位置和投递按 id 比先后：系统时钟往回调时，重启后的新消息可能排在旧消息前面；只有一个人在本机用，接受这个风险。
- **测试用脚本扮演帮工，用真的 git。** 真实的农机要联网、登录、花钱，慢而且结果不固定，留给手动验证。没把 oar 整个换成假的：测不到它的事件折叠和汇报时机，那正是最容易出错的地方。代价是脚本不是模型：模型会不会照规矩写「结论：」、会不会自己解决冲突，只能真跑时看（[vv-acceptance/references/orchestrator-evals.md](.agents/skills/vv-acceptance/references/orchestrator-evals.md)、`vv-acceptance/references/server.md`）。
- **一套工具管格式、lint、构建和测试。** Vite+ 把 Vite、Vitest、oxlint、oxfmt 收在一个 `vp` 里，设置写在一个 `vite.config.ts`；oxlint 的带类型规则（没处理的 promise、数字不带比较函数的 `sort`、没用上的组件）在落地前就报出来。放弃了各装一份 ESLint、Prettier：两份设置、两套插件，慢一个量级。几条规则关掉，因为这里是有意的写法：`[...text]` 按码点切字、改之前先拷一份再遍历、`Effect.gen` 前的 `const self = this`。规则一条一条开、只开成 error：开之前在仓库上量一遍命中，一处不剩的直接开、锁住；几十处以内的同一个改动里改完再开；几百上千处的（非空断言、`strict-boolean-expressions`、没核过的 `as`）多半和这里的写法相冲，不开。整类（pedantic、style、restriction）不开：一开几千到几万处，真问题淹在里面。上线的代码不让 `any` 流过（`no-unsafe-*`，只在 `apps/*/src`、`packages/*/src`）：JSON、库、`getPrototypeOf` 给的在进来的地方定类型；测试和脚本读的是自己写的 JSON，不管。`no-unnecessary-condition` 试过不开（188 处）：死掉的 `?? []`、`?.` 是真的，可四十来处「总是真、总是假」几乎都是 `signal.aborted`、`closed`、`disposed` 这种在 `await` 或回调里被别处改掉的标志，TypeScript 的收窄看不见那一下，照它删就是把竞态的守卫删了。
- **话在一个 i18n 包里，按键取，词典按语言分文件。** 以前是 42 张 TS 对象（`words.ts`，`typeof zh` 查英文）：类型挡住了漏翻，可话和代码绑在一起，按文字找不到一句在哪，没人用的词条、英文里混进的中文没人报，加一种语言要复制 42 份对象。现在词典是 JSON，代码写 `t("key")`，`scripts/i18n.ts` 照 x18n 的路子扫键、查问题、按文字找，词典能单独交给翻译或 agent。类型没丢：`gen` 从中文写出每个键和参数，写错照样编不过。搬的时候查出 70 条早就没人用的词条，删了。`catalogs.ts` 把词典写成数据而不是 import JSON：Metro、esbuild、Vite 和 Node 读 `.ts` 都一样，读 JSON 要的 import 属性各家支持不一。放弃了直接用 x18n（我们只要五个命令，自己写更好控制，CI 不依赖外部；词典格式标准，以后要接随时能接）、i18next 这类库（运行时、按需加载、后端都用不上，`t` 只要取值和替换占位）、一种语言一个大文件（并行的分支几乎每次都冲突）、英文做源头（产品先是中文的，中文写得最准）。
- **服务端写好话再发，页面不拼。** 帮工在干什么、工单等什么、通知怎么说由服务端写进帧，桌面的菜单栏、灵动岛、命令行、连接器也要同一句；放弃了只发结构、各处自己拼，那会每处各拼一遍。代价是语言跟着进程：服务端换了语言，新算的帧才是新语言，所以页面换语言时整页重开。
- **提示词不翻。** 管家的行为和评测绑在中文提示上，写法是调出来的；模型读中文、用主人的语言回答没有问题。放弃了逐句翻译提示：要重调、重跑付费评测，换来的只是提示本身的语言。
- **改名靠编译器和护栏，不靠全局替换。** `turn`、`station`、`harvest` 在 oar、游戏和界面文字里都是对的，盲目 `sed` 要花更多时间找回来。标识符改名用编辑器的重命名和 `tsc`，字符串、SQL、Markdown 用 `rg` 逐处改；改掉的旧名写进 `scripts/stale-names.ts`，回来时 `docs:verify` 失败。

- **测试的层按依赖算，边界写成检查。** 层由一个文件经 import 一路碰得到什么算出来，加一个 import 就换了层，金字塔小结里看得见；放弃了按文件名声明层（`*.rules.test.ts`：要改二三十个名字，名字和内容还会对不上）、按层裁剪 `world`（农场搭起来中位数 10 毫秒，越层由依赖和预算挡住就够）、覆盖率门槛（说不出测在哪层、花多少）、超预算就失败（机器快慢不同，CI 会时好时坏）。按依赖算的第一回就找出一处越层：`session/report.test.ts` 要用 `MergeFailure`，而它定义在会跑 git 的 `project.ts` 里，形状挪到了 `project/shapes.ts`。不靠时间等的 lint 改掉了 72 处写死的等待，顺带找出 `Core.owner` 是开机后才订上的流（开机后主人马上做的会漏），改成返回前就订上；只剩 8 处没有可等事件的否定断言，每处一行理由。
- **测试快一个台阶，靠模块的接口便宜，不靠并行。** 顺序跑服务端的测试原来要 210 s：worker 的 CPU 里 PGlite 占 36%，加载模块、起子进程、读写文件占 30%，空闲 19%，Effect 和业务代码只有 6%；把写死的几个延时调小几乎不省时间，测试主要在干活，不在等。所以先让每个测试本身便宜：库清空复用（新建一个约 110 ms，清空约 13 ms）、模块只加载一次、测试仓库从模板复制、产品代码少起 git（一个 git 命令就是一个进程，约 20 ms；管家每次开口都要列项目，列一次原来每个项目起一个 git）、规则在自己的接口上测；做完是 108 s。没做：前后端共用一个时钟（页面和服务端是两个进程，页面的测试基本不依赖时间，投入换不来收益）；把延时常量在测试里调小（几乎不省时间，测的也不再是上线的数值）；每个测试一个 Postgres schema（每个 schema 要重跑建表，还要改所有查询的 `search_path`）；测试里把 git 换成假的（合并、冲突、工作区正是最容易错的地方）；加并行（不在这一轮：每个测试先便宜，并行的收益跟着放大）。
- **时间只从 Clock 来，靠 lint，不靠记得。** 虚拟时钟只跳过「等」、跳不过「干活」，它的价值是确定性和测得到长的窗口（一小时后到点的定时任务、10 分钟后关的线路）。可一处绕开 Clock 的 `setTimeout` 就让 `TestClock` 卡住，而这些地方集中在 Promise 一侧，所以写成规则，并让那一侧的类在构造时接 `Time`：时间从哪来写在构造参数上，测试换一个 `Time` 就拨得动。外部协议和真实进程的节奏留在真时间，名字上说明（`afterRealTime`、`wallTime`）；外面的库自己在真时间上重试的（声网的 SDK），把重试收回来、关掉它的（`maxRetries: 0`）。
- **贵的东西归拥有它的模块管，测试分层、有预算。** 时间归 `Clock`；库归拥有那几张表的模块，它在内存里记着自己写过的（频道的对话、参与者、主人的已读，[频道](docs/subsystems/channel.md)），不把刚写下的再读回来，一条消息的几次写在一个事务里；外面的世界（git、进程、网络）照旧真的，只让调用少；等后台的事按条件问，挂住的帮工由测试放行，有窗口的拨 `TestClock`。测试按层算预算（流程 2 秒，其余 300 毫秒），`@vibevalley/testkit/budgets` 每次列出超两倍的。这一轮顺序跑从 107 s 到 77 s：盘上的库从一份建好的拷贝开始，`until` 每毫秒问一次、挂住的轮次由测试放行，服务端停下前关掉所有连接（离开的事件流不再把关停拖住 3 秒），频道一句话的查询从 22 条到 10 条，描述分支的三次 diff 合成一次。放弃了：整座农场在虚拟时间上闲下来就自动拨钟（git、库、子进程还没回来就可能拨过超时和停滞的窗口，测试里显式拨更清楚）；`world` 只搭到某一层（170 个农场搭起来一共 20 s，中位数 10 ms，贵的是 19 个盘上的库，已经用拷贝解决）；git 的仓库端口和常驻的 git 进程（git 一共约 20 s，一半是 `worktree add`、`commit` 这类写，读散在各个操作里，一个操作多是一两次，合起来省 3 秒上下，却要动合并和派活的主路）；把检查超时的测试缩到半秒（macOS 第一次执行新写的脚本要先扫一遍，半秒来不及输出）。

## 还没做的

- 概念先行剩下的几步（把代码里按皮起的名字对上概念）：[概念先行，农场是皮](.agents/notes/proposed/architecture/2026-10-15-concepts-first.md)。

## 怎么验证

- `src/base/schema.test.ts`：一份基线，表名、索引名，每个查询文件只写它自己的表。
- `apps/server/src/core/golden.test.ts`（折法、地块、共用规则）和各模块的黄金数据测试；`vp run golden:update` 后 `git diff` 只该动有意改的。
- `vp check`：格式、lint 和全部包的类型。
- `vp run server:check`：`vp check`、protocol 的测试、`db:check`、服务端的 vitest。
- `vp run web:check`、`vp run --filter @vibevalley/web e2e`、`vp run desktop:test`：类型、各包的规则测试、页面能构建，Playwright 对着真的服务端和整个应用。
- `vp run docs:verify`：旧名字、能力表是否最新。
- 话：`vp check` 的 `vibevalley/no-cjk-literal`；`agent/seed.test.ts`（种子和模板的英文版只有字不同）；`session/report.test.ts`、`memory/memory.test.ts`（英文的记号也认）；`apps/web/test/english.spec.ts`（换成 English，工作台和服务端的话都变；每一页都没有不是主人存下的中文）；`runtime/runtime.test.ts`（换了语言，农机探测时说的话重新探测一遍）；`apps/desktop/test/app.spec.ts`（菜单栏跟着语言）。
- **服务端存下的话**：服务端算好又留着的话（农机的探测结果）记着是用哪种语言说的，语言换了就重新算一遍，在新的结果回来之前照旧显示；写进库和文件里的话（田头的系统消息、种子档案）是数据，不回头翻。
