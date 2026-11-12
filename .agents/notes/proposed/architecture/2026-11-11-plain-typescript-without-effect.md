# Agent Note: 普通 TypeScript：不用 Effect、Schema 用 Zod、查询由 SQL 生成 Zod、样式回到 Tailwind v4

Status: proposed

## Problem

主人的判断：Effect 和 StyleX 在这个仓库的收益不高，都拿掉。2026-11-11 的盘点支持这个判断。

### Effect

**它铺得很开。** 405 个源文件和 169 个测试文件引用 Effect；`Effect.gen` / `Effect.fn` 有 2,638 处；35 个 `Context.Service`，67 个 `Schema.TaggedError`；`packages/protocol` 有 269 个 Schema；`apps/server/db/generated` 的 45 个文件由生成器写成 Effect 的 `SqlSchema`。服务端 40,774 行代码、30,689 行测试几乎都在它里面。

**成本落在四处。**

1. **重写了上游库，并因此用不上上游的新能力。** 为了让大脑整个在 Effect 里，2026-10-27 把 pi-ai 和 pi-agent-core 重写成了 `packages/ai`、`packages/agent`（5,704 行代码，3,162 行测试），又在 `mailbox`、`session` 里自己做持久和恢复。上游的 `@earendil-works/pi-durable`（输入、每一轮、工具调用先落盘再显示，进程死掉后从断点接着跑）在 2026-10-01 已经出到 1.0，oar 0.86 把它包成了现成的 runtime（`createPiDurableRuntime`）。我们自己的两个 runtime 至今写着 `queue: { durable: false }`。
2. **检查在消耗而不是保护。** `effect:check` 曾有 22 条规则在棘轮上，其中 `preferEffectArray`、`preferEffectString`、`strictBooleanExpressions` 这类抓不到缺陷，却挡提交；代码挪一个包就要重新还账。
3. **agent 写不对。** Effect v4 的 API 还在变，agent 凭记忆写出 `Scope.extend`、`HttpClient.asEffect()` 这类现在没有的写法；一处多写的 `Clock.Clock` 标注让 350 个测试签名一起报错，真正的问题被淹没。这和[流程](docs/subsystems/process.md)里「让容易的写法就是对的写法」相反。
4. **它没有挡住并发缺陷。** 拆分后子单派不出去、调用方断开后重试写两次，都出在 Effect 的代码里；后一个正是换用 Effect 的 `Cache` 引入的。

**Effect 确实给了的东西**不能丢，改写时要用别的办法守住：拒绝有类型（`ApiError` 加 `bizCode`）、长操作能被打断、资源开了一定关、后台任务有主、测试能控制时间、边界当场解码。

### StyleX

2026-11-08 页面从 Tailwind v4 迁到 StyleX（#235），之后官网 `apps/site` 也照它写。现在 249 个文件、287 个 `stylex.create`。成本：

- **构建期静态求值的限制让人和 agent 都踩坑。** 2026-11-11 页面构建失败过一次，六个文件（`Shell`、`Hud`、`Achievements`、`RepoPanels`、`MergeGame`、`BugSnakeGame`）因为样式里用了局部箭头函数、从非 `.stylex.ts` 文件引的常量、声明在使用之后的变量而求值失败；类型检查和 lint 都不报，只有构建报。修法（「这个函数要写成函数声明」「这个常量不能引」）没法从代码里看出来。
- **构建慢。** 一次页面构建里 StyleX 的转换占了大约 77% 的插件时间。
- **写法离 agent 最熟的远。** 同样一个布局，Tailwind 是元素上的一串 class，StyleX 是文件顶上一个对象加 `{...stylex.attrs(...)}`；迁移后样式名多是 `issueDetailSpan2`、`issueDetailDiv22` 这种按位置起的名字，读不出意思。
- **它要一整套自己的守卫。** `vv-stylex` skill、lint 的 `stylex-only`（禁止 JSX 里写 class）、`design-tokens` 对 StyleX 值的检查，都是为它加的。

迁移前的 Tailwind v4 用 `style.css` 的 `@theme` 放令牌，这个做法没有问题，令牌本身（颜色、圆角、字号、阴影、动效、层）保留。

## Proposal

全仓改成普通 TypeScript：`async`/`await`、`AbortSignal`、`await using`、工厂函数，不引入另一个效果系统。所有运行时校验用 **Zod 4**：契约、查询的结果、落盘的 JSON、配置、工具入参，同一种写法。页面和官网的样式回到 **Tailwind v4**。

### 换成什么

| 现在 | 以后 | 说明 |
|---|---|---|
| Effect `Schema`（契约 269 个、落盘 JSON、配置、工具入参） | Zod 4 | 品牌主键用 `.brand()`，判别联合用 `z.discriminatedUnion`，工具给模型的 JSON Schema 用 `z.toJSONSchema`；`shapes.ts` 的手写类型不变，`schema.ts` 仍由它定类型（`z.ZodType<T.X>`，两边对不上就编不过） |
| `effect/sql`、`@effect/sql-pg`、`@effect/sql-pglite`，生成的 `SqlSchema` | sqlc 的做法：`db/queries/<表>.sql` 照旧写 SQL，生成器写出每条查询的 Zod 参数和结果 Schema，加一个普通的 `async` 函数 | 见下文「查询」 |
| `effect/http`（路由、`HttpClient`） | Hono（Node 适配器）与 `fetch` | 仍只听 127.0.0.1；入参用 Zod 解；SSE 用 Hono 的流，语音线路的 WebSocket 用 `ws` |
| `effect/rpc`（房间的订阅） | 带 Zod 契约的 SSE 流加 POST | 和 `/api/v1/state` 一个写法 |
| `Context.Service` + `Layer` | 工厂函数 `makeIssue(deps)`，`services.ts` 按次序调用 | 模块仍只用排在它前面的；`modules.test.ts` 的边界检查保留 |
| `Schema.TaggedError` + 错误通道 | `ApiError`（带 `bizCode`）用于拒绝；模块里预期的结果写成返回的判别联合 | 意外仍是异常，网关统一答 500 并记日志 |
| `Scope`、`acquireRelease` | `await using` 与 `AsyncDisposableStack` | Node 24 已支持 |
| 纤程、`FiberSet`、`FiberMap`、打断 | 每个服务一个 `TaskGroup`（自己写的小件：登记后台任务，关闭时中止并等它们结束）；长操作收 `AbortSignal` | 会话有自己的 `AbortController` |
| `Stream`、`PubSub`、`Queue`、`Deferred` | 异步迭代器，加一个带类型的 `Channel` 小件 | `Promise.withResolvers` 顶替 `Deferred` |
| `Clock`、`TestClock` | 注入的 `Clock` 接口（`now`、`sleep`），测试用 vitest 的假定时器 | lint 仍禁止直接 `Date.now()` |
| `Semaphore`、`Schedule` | 自己写的小件（信号量、退避） | 各几十行，有测试 |
| `Config`、`Redacted` | Zod 解环境和 `vibevalley.yaml`；密钥包在一个 `toJSON` 抛错的 `Secret` 里 | |
| `effect/cli`（24 个文件） | `commander` | 命令行仍只经 `VibeValleyApi` 调服务端，回答用 Zod 解 |
| `effect/reactivity`、`Atom`（页面 9 处） | Solid 的 signal 和 store | |
| `@effect/vitest`（134 个文件） | `vite-plus/test` | `world.ts` 用同样的工厂搭整农场 |
| `packages/agent`、`packages/ai`（重写的 pi） | 上游的 pi-ai 加 pi-durable，经 oar 的 `createPiDurableRuntime` | 见第 1 步；验证不过就把循环移植成普通 TypeScript，不留在 Effect 里 |
| StyleX（`stylex.create`、`stylex.attrs`、`*.stylex.ts`） | Tailwind v4（`@tailwindcss/vite`，`@theme` 令牌） | 见下文「样式」 |

### 查询：SQL 在前，生成 Zod

保留现在 sqlc 式的输入，只换生成器写出来的东西。

- **输入不变**：表结构在 `db/migrations/0001_schema.up.sql`，查询在 `db/queries/<表>.sql`，每条以 `-- name: <名字> :one|:many|:exec` 开头；现有的类型标注（`::session_run.started_at?` 这种可空的写法）照旧。
- **类型仍由 Postgres 说**：`scripts/pg-generate.ts` 照旧对每条查询做 Parse、Describe，拿到参数和结果列的类型；`CHECK (col IN (...))` 照旧变成字面量联合；主键和外键照[品牌主键](.agents/notes/proposed/architecture/2026-11-11-type-driven-boundaries-and-branded-ids.md)的做法变成品牌类型。
- **输出换成 Zod 和普通函数**：每条查询生成一个参数 Schema、一个结果行 Schema（`z.object`），和一个函数：

  ```ts
  export const GetIssueRow = z.object({ id: IssueId, number: z.number().int(), title: z.string(), /* … */ });
  export type GetIssueRow = z.infer<typeof GetIssueRow>;
  export async function getIssue(sql: Sql, params: GetIssueParams): Promise<GetIssueRow | undefined> { /* … */ }
  ```

  `:one` 返回一行或 `undefined`，`:many` 返回数组，`:exec` 返回影响的行数。每一行出库时用结果 Schema 解，对不上当场失败（带表名和列名）；自有表的 JSON 列在 Schema 里用 `z.string().transform` 加对应的契约 Schema 解，坏了当场失败，不吞。
- **一个 `Sql` 接口，两个驱动**：`pg`（配了 `database.url`）和 PGlite（家目录里），同一种方言；事务是 `sql.tx(async (tx) => …)`，函数收 `Sql` 或 `Tx` 都行。
- `server:check` 照旧查 `db/generated` 是不是最新；代码里只调生成的函数，SQL 只写在 `db/queries`（`schema.test.ts` 的几条照旧）。

### 样式：回到 Tailwind v4

- **令牌**：`apps/web/src/style.css` 回到 `@import "tailwindcss"` 加 `@theme`。现在 `tokens.stylex.ts`、`tabs.stylex.ts` 里的颜色、圆角、字号、阴影、动效、层、断点、容器宽度全部回到 `@theme`；两种主题照旧用 CSS 变量切换。官网 `apps/site` 用同一份令牌。
- **组件**：每个 `stylex.create` 的条目换回元素上的 class；动态的值（宽度百分比、按数据算出的尺寸）用 `style` 属性或 CSS 变量，不拼 class 名。按位置起的样式名（`issueDetailSpan2` 这种）随之消失。
- **零件的样子照旧在 `apps/web/src/ui`**，`packages/base-ui` 仍然无样式；零件旁边的 `X.stories.tsx` 照旧，改完在故事里两种主题、几种宽度看一遍。
- **检查换成 Tailwind 的**：删掉 lint 的 `stylex-only`；`no-hex-color` 和 `design-tokens` 改成查 class 里的任意值（`bg-[#…]`、`p-[13px]` 这种绕过令牌的写法）和 `style` 里的散值；`vv-stylex` skill 换成 `vv-tailwind`（令牌在哪、任意值什么时候可以、动态值怎么写）；[界面怎么做](docs/style/design.md)和[客户端](docs/subsystems/app.md)里讲 StyleX 的部分改写。
- **以截图为准**：迁移前后同一组页面、两种主题、三种宽度（1440×900、1152×768、390×844）各截一张，逐张对比；Playwright 的 `e2e:visual` 跑全套。

### 用什么守住 Effect 给过的东西

- **拒绝有类型**：`ApiError` 是唯一能越过模块边界的预期错误；lint 禁止模块里 `throw new Error`（意外用 `invariant`）。
- **能打断**：lint 规则：模块里做 I/O 的导出函数必须收 `signal`；测试覆盖「打断后不留子进程、不留半截写」。
- **开了一定关**：返回资源的函数返回 `AsyncDisposable`，lint 要求用 `await using` 接。
- **后台任务有主**：带类型的 `no-floating-promises` 已在 oxlint 里；后台任务只能进 `TaskGroup`。
- **边界当场解码**：HTTP 入参、SSE、查询的每一行、落盘的 JSON、配置、工具入参，全部用 Zod 解。[schema-audit.ts](scripts/audit/schema-audit.ts) 改成认 Zod，仍查库里的 CHECK 和契约的枚举一致、密钥不能进 JSON、主键有品牌。
- **回归测试一个不丢**：378 个 `regression:` 测试按名字保留，只改怎么跑。

### 次序

全部在一个分支 `refactor/plain-typescript` 上做，最后合成**一个 PR**。分支上按下面的次序一步一个或几个提交；每个提交都让改过的部分的测试是绿的，所以出了回归能在提交里二分定位。中间态不发版，只在最后整体验收一次。

**Effect 这条线**在分支上改到一半时，没改到的模块和改好的模块之间只有一种接缝：把 Effect 跑成 Promise（改好的调没改的），或者 `Effect.promise` 包一下（没改的调改好的）。接缝只为让中间的提交能跑测试，最后一个不剩；`effect:check` 记着引用 Effect 的文件数（2026-11-11：619），每个提交只减不增。

0. **停下并计数**（已做）。`effect:check` 的风格规则关掉，只留写成 error 的；加文件数的棘轮；`AGENTS.md` 写明方向，新代码不再用 Effect。
1. **大脑换回上游。** 先验证：`createPiDurableRuntime` 接进 runtime 注册表，只给管家用，跑通「说一句话、中途杀掉服务端、重启后接着答」。通过就删掉 `packages/agent`、`packages/ai` 的循环，以及 `session`、`mailbox` 里只为它做的恢复；会话之间的事（谁被触发、派给谁、排队）仍归 `mailbox`。
2. **契约换成 Zod，网关换成 Hono。** `packages/protocol` 的 Schema 换成 Zod，`client.ts` 的生成器跟着换；`gateway/http` 换成 Hono；房间的订阅换成 SSE。服务内部还是 Effect，处理函数经接缝调它们。页面、桌面壳、手机壳在这一步之后不再引用 Effect。
3. **地基。** 查询生成器改成写 Zod 和普通函数，`Sql` 接口和两个驱动落地；配置、日志、时间、家目录的租约改写；`Clock`、`TaskGroup`、`Channel`、信号量、退避这几个小件连测试一起落地。
4. **模块，从下往上。** 照 [architecture.md](docs/architecture.md) 的次序一组一个 PR：Platform、Agents、Source Control、Agent Sessions、Mailbox、Collaboration、Issues、Orchestrator、Inbox、Gamification，最后是网关里剩下的（`lan`、`connector`、`voice`、`mcp`）。每组连它的测试一起改。
5. **收尾。** 命令行换 `commander`；`world.ts` 和测试帮手去掉 Effect；删掉依赖（`effect`、`@effect/*`）、`effect:check`、`vv-effect` 和 `effect-ts` skill、`AGENTS.md` 里 Effect 的部分；`practice:check` 换成新写法的规则；把仍成立的不变量沉淀进[地基](docs/subsystems/foundation.md)。

**样式这条线**和 Effect 那条互不依赖，可以和第 1 到 4 步同时做；它只碰 `apps/web`、`apps/site`、`packages/stories` 和检查脚本。

- **S1 令牌和检查。** `style.css` 回到 `@theme`，接上 `@tailwindcss/vite`；`design-tokens`、`no-hex-color` 改成认 Tailwind；`stylex-only` 先改成只拦新文件；`vv-tailwind` skill 写好。截好迁移前的基准截图。
- **S2 零件。** `apps/web/src/ui`、`ui/domain`、`ui/pixel` 换回 class，每个零件对着它的故事看。
- **S3 页面。** `features`、`farm`、`tree`、`app` 一组一个提交换完；每组对比截图。
- **S4 官网和收尾。** `apps/site` 换完；删掉 `@stylexjs/*` 依赖、`*.stylex.ts`、`stylex-only`、`vv-stylex`；文档改写。

工作量的估计（agent 写、人审）：Effect 这条线第 0 步已做（已合进 `main`），第 1 步 3 到 5 天，第 2 步 4 到 6 天，第 3 步 3 到 4 天，第 4 步 10 到 15 天，第 5 步 2 到 3 天；样式这条线 5 到 8 天，可以并行。合计五到七周。这期间 `main` 上只做小的修补。

[扩展剩余品牌主键](.agents/notes/proposed/architecture/2026-11-11-type-driven-boundaries-and-branded-ids.md)仍然成立，但要等第 2、3 步之后照 Zod 和新的生成器重写它的做法。

## Alternatives considered

**只把 Effect 收缩到服务端内核。** 保留服务端和命令行的 Effect，页面和边缘包不用，砍掉风格规则，大脑换回上游。代价是这篇的一个零头，并发和资源仍由 Effect 管。没选：主人判断它在内核里的收益也抵不上 agent 写不对、API 不稳和双重心智的成本，不想长期养着两种写法的交界。

**每一步一个 PR，逐个合进 `main`。** 每一步都能发版，评审面小。没选：主人要一个 PR（一份计划一个 PR）；分步合进去意味着接缝和两种写法要在 `main` 上并存几周，每一步还要为能单独发版写一层之后会删掉的胶水。分支上逐个提交、每个提交测试是绿的，已经能定位回归；评审按提交看。

**换成另一个效果库（fp-ts、neverthrow、自己写一个小的 Effect）。** 没选：问题是「写法离普通 TypeScript 太远」，换一个库只是换一套 agent 写不对的 API。预期的失败用返回的判别联合就够了。

**Schema 用 Valibot 或 ArkType。** 更小或更快。没选：Zod 是 agent 最熟、生态最全的（Hono 的校验、MCP SDK、JSON Schema 输出都直接支持），而这次改写的首要目标是让默认写法是对的；契约、查询、配置、工具入参用同一种，才只有一套要学。

**查询换成 ORM 或查询构造器（Drizzle、Kysely）。** 没选：现在的 sqlc 式做法让 Postgres 自己说类型，SQL 写在一处、一张表一个文件，评审和检查（`schema.test.ts`）都建立在它上面；换成 ORM 要把 44 个查询文件改写成 TypeScript，类型从库的推断来而不是从数据库来，得不偿失。只换生成器的输出就够了。

**用 sqlc 本身（Go 写的工具）代替自己的生成器。** 没选：sqlc 的 TypeScript 输出插件不写 Zod，PGlite 也不在它的驱动里；我们的生成器已经做了 Parse、Describe、`CHECK` 转联合、可空标注，改输出比接一个外部工具小。

**样式留在 StyleX，只补检查。** 没选：构建期求值的限制是它的工作方式，不是缺一条 lint；补检查只是把「构建才报」挪到「lint 才报」，写法还是离 agent 最熟的远。

**样式换成 CSS Modules 或 vanilla-extract。** 没选：前者回到「样式名起什么」的老问题，后者和 StyleX 一样有构建期求值；迁移前的 Tailwind v4 已经证明在这个仓库能用，令牌的结构也是现成的。

**大脑不换上游，把重写的循环原样移植成普通 TypeScript。** 没选作首选：那样仍然自己养一套 agent 核心和持久化，放着上游现成的不用。它是第 1 步验证不过时的退路。

## Acceptance criteria

- 全仓没有任何文件引用 `effect`、`@effect/*` 或 `@stylexjs/*`；`pnpm-workspace.yaml` 的 catalog 里没有它们；`effect:check`、`scripts/audit/effect.ratchet.json`、`vv-effect`、`effect-ts`、`vv-stylex` skill、lint 的 `stylex-only` 已删除。
- 运行时校验只有 Zod：契约、HTTP 入参、SSE、查询的结果行、落盘的 JSON、配置、工具入参。
- `db/generated` 由 `scripts/pg-generate.ts` 从 `db/queries/*.sql` 写出，每条查询有 Zod 的参数和结果 Schema 和一个普通的 `async` 函数；`server:check` 查它是最新的。
- 页面和官网的样式是 Tailwind v4，令牌只在 `@theme`；lint 拦下绕过令牌的任意值和散值。
- `vp check`、`server:check`、`web:check`、`site:check`、`site:build`、`scripts:test`、`desktop:test`、`docs:verify`、`deadcode` 全过；`e2e` 全过。
- 服务端的测试数不少于改写前（2026-11-11：1,171 个），378 个 `regression:` 测试都在、名字不变（有意改了行为的在各步的 PR 里点名）。
- [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 的服务端和页面分册走通：工单派出去、交回、完成；样式迁移前后的截图逐张对比，没有走样。
- 管家的会话是持久的：说一句话、中途杀掉服务端、重启后接着答，有流程测试守着。
- 打断和收尾有测试：叫停一个在干活的帮工后，没有留下子进程、没有半截的库写入、临时文件被删掉。
- 全部改动在一个 PR 里合进 `main`，PR 正文按次序列出每一步和它的提交。
- 冷启动到 `/api/v1/state` 出第一帧的时间、`vp check` 的时间、页面构建的时间不比改写前慢，数字记在收尾的 PR 里。

## Risks

- **并发和收尾的回归。** 这正是这个系统最难的部分，也是 Effect 原来兜着的。缓解：先落地 `TaskGroup` 等小件和它们的测试（第 3 步），lint 管 `signal` 和 `await using`，每一组模块改完跑全部流程测试和验收沙箱。
- **预期的失败变成静默的 500。** 没有错误通道以后，漏掉一个该拒绝的地方编译器不再提醒。缓解：模块里禁止裸 `throw new Error`；网关把每个 500 记成带模块名的日志，改写期间测试里出现 500 就算失败。
- **pi-durable 还在变。** 它自己标着 Experimental。缓解：只经 oar 的 runtime 接口用它，版本钉死，升级走验收；验证不过就走退路。
- **一个大 PR 难评审，合进去时和 `main` 冲突多。** 缓解：分支上一步一个或几个提交，提交说明写清这一步换了什么，评审按提交看；每周把 `main` 合进分支一次，不攒到最后；改写期间 `main` 上只做小的修补，大的功能等合并以后。
- **改到一半停下来。** 两种写法并存比哪一种都差。缓解：分支上接缝的计数只许减；中间态从不合进 `main`，停下来的代价是丢掉分支，不是留下半截。
- **功能停滞五到七周。** 缓解：样式那条线和服务端那条互不依赖，可以并行做；`main` 上的小修补每周合进分支。
- **Zod 和 Effect Schema 的行为差异。** 可选字段、多余字段、日期和数字的宽严不一样，落盘的 JSON 可能读不回来。缓解：第 2 步给每个契约 Schema 用现有的黄金数据和测试夹具跑两边的解码，结果要一样；内部不留兼容的规矩不变，读不回来的本机旧库照旧作废重建。
- **样式迁移走样。** 2,000 多处样式换回 class，细节（悬停、焦点环、`@supports` 的回退、容器查询）容易丢。缓解：迁移前截好基准图，每组对比；StyleX 里写了 `@supports`、`@container` 的条目单独列出来逐个核对。
