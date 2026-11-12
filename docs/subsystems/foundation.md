# 地基

服务端、客户端和脚本共用的工程骨架：pnpm 工作区、工厂函数的服务分层与 `@vibevalley/async`、概念分目录的 Zod 契约、Postgres 查询生成与测试金字塔。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 工作区、依赖 catalog、构建与类型检查 | 各包的对外约定（各包 `README.md`） |
| 服务端 11 个模块的划分、依赖方向与两阶段启动 | 各模块的业务行为（对应子系统文档） |
| `packages/protocol` 的概念目录、Schema 与客户端生成 | 核心状态折叠与接口路由（[核心状态](docs/subsystems/core.md)） |
| Postgres 基线表结构、SQL 代码生成、主键与命名规范 | 业务表含义（各子系统）与家目录文件（[架构](docs/architecture.md#存了什么)） |
| 测试金字塔、虚拟时钟与脚本化帮工 | 页面分层与宿主打包（[客户端](docs/subsystems/app.md)） |
| 词典（`packages/i18n`）与模型提示（`prompts.ts`）分工 | 界面用词标准（[用语表](docs/README.md#用语)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `pnpm-workspace.yaml`、`vite.config.ts` | 工作区包列表、依赖版本 catalog、oxfmt 与 oxlint 配置 |
| `scripts/{gen,audit,docs,release}/` | 按生命周期切分的工程脚本：`gen/`（生成物写出）、`audit/`（AST / lint / 类型 / 边界门禁）、`docs/`（笔记、链接、术语与旧名检查）、`release/`（打包与发版验证） |
| `tsconfig.base.json`、`scripts/audit/oxlint-plugin.ts` | TypeScript 严格选项与仓库自定义 lint 规则 |
| `packages/async/` | 打断、后台任务、队列、广播、锁、重试与超时：服务端和各个包共用的异步原语 |
| `scripts/audit/practice-audit.ts`、`service-paths.ts`、`protocol-surface.ts`、`schema-audit.ts` | 全仓语法树实践棘轮、服务调用矩阵与扇入检查、根协议导出面棘轮、SQL 枚举 / 品牌主键 / `Secret` / `BizCode` 注册表边界审计 |
| `apps/server/src/{base,infra,core}/` | 服务端纯地基、外部系统适配与核心状态投影底座 |
| `apps/server/src/modules/<概念>/`、`gateway/`、`modules.ts`、`services.ts` | 22 个纵向领域模块、6 个对外协议与出帧网关、11 层归属表与两阶段服务组装 |
| `packages/protocol/src/<概念>/` | 按概念划分的 `shapes.ts`、`schema.ts`（Zod）、`api.ts` |
| `packages/protocol/src/rules/` | 服务端与页面共用的纯函数规则 |
| `packages/protocol/src/client.ts` | 由 `scripts/gen/api-client.ts` 生成的 HTTP 客户端 `VibeValleyApi` |
| `apps/server/db/migrations/0001_schema.up.sql` | 唯一的 Postgres 表结构基线 |
| `apps/server/db/queries/<表>.sql`、`db/generated/` | 按表拆分的 SQL 查询与 `scripts/pg-generate.ts` 生成代码 |
| `apps/server/src/testing/`、`packages/testkit/` | 测试农场组装、虚拟时钟等待与测试金字塔分级 |
| `packages/i18n/`、`scripts/gen/i18n.ts` | 中英双语词典 JSON、生成的 `src/catalogs.ts` 与词条检查工具 |

共用原语清单见生成的 [primitives.md](docs/reference/primitives.md)。

## 模型和不变量

### 仓库和包

- **单一语言与运行器**：全仓使用 TypeScript，开发与测试用 `vpx` 直接运行源码，桌面版服务端用 `vp pack` 打包为 `dist/main.mjs`。
- **依赖版本集中**：所有应用（含 `apps/site`）与共享包使用根 workspace 和同一份锁文件。版本集中在 `pnpm-workspace.yaml` 的 catalog 中，各包写 `catalog:` 或具名 catalog，由 `scripts/audit/catalog.test.ts` 检查。Expo 的版本放在 `expo`；不保留应用自己的 workspace 或锁文件。
- **开启全局虚拟存储**：`enableGlobalVirtualStore` 让新 worktree 直接硬链全局包，几秒内完成安装。
- **跨包统一的二级目录语法**：超过 8 个生产文件的子包，`src/` 根目录仅放包入口与装配清单（`index.ts`、`main.ts`、`worker.ts`、`App.tsx`、`services.ts`、`modules.ts`），实现统一归入标准二级目录：`base/`（零 I/O 纯函数与数据结构，由 `vibevalley/subpackage-layers` 静态守住纯度）、`infra/`（外部系统与 SDK 适配）、`state/`（客户端状态中间层）、`ui/`（通用组件与样式令牌；跨模块业务展示件放 `ui/domain/`）、纵向能力域目录（`server` 的 `modules/<概念>/` 与 `gateway/`、`web` 的 `features/<概念>/`、`cli` 的 `commands/`、库包的能力子目录）以及 `testing/`。Electron 沙箱桥独立放入 `apps/desktop/src/preload/`，禁止导入主进程或 Node I/O 模块；`≤ 8` 个文件的微型单职责包保持 `src/` 扁平。
- **跨包走包名，包内跨目录走 `#/`**：跨包导入应写 `@vibevalley/*`，`apps/server`、`apps/web` 与 `apps/cli` 跨目录导入写 `#/` 和 `#db/`（由 `no-cross-package-path` 与 `parent-import` 规则检查）。
- **包导出分离类型与源码**：`packages/*` 的代码导出将 `types` 指向 `dist/*.d.ts`（`vp run packages:build` 生成，`scripts/audit/built-types.ts` 检查），`default` 指向源码；`.css` 导出直接指向 `src/` 下存在的样式表，不伪造类型声明。
- **严格可选属性**：开启 `exactOptionalPropertyTypes`，对外对象用 `omitUndefined` 清理未定义键（[代码风格](docs/style/code.md#没有值)）。

### 模块和服务

架构、边界与测试如何共同设计，见[模块设计](docs/style/module-design.md)；本节记录现行结构与门禁。

- **11 个有序模块单向依赖**：模块顺序定义在 `apps/server/src/modules.ts`。下层不得 import 上层，不得直接读 `core.state()` 中其他模块的数据（`apps/server/src/modules.test.ts` 检查）。
- **门禁共享一次源码分析**：`modules.test.ts` 在第一次检查内读取生产文件并用 `@vibevalley/testkit/source` 的 `analyzeSource` 各解析一次，依赖方向、表所有权与状态读取复用结果；同路径不同源码不共用缓存。读取和解析时间计入测试，提速按完整运行耗时与解析次数验证。
- **单数概念名，拒绝单调用方顶层服务**：目录、表名和服务名均用单数概念词，协议同名类型统一写为 `T.Issue`（由 `singular-service` 与 `protocol-namespace` 规则检查）；仅有一个模块调用的内部设施留在调用方模块内（由 `scripts/audit/service-paths.ts` 扇入检查守住）。
- **组装与启动分两阶段**：`services.ts` 照模块次序一个个 `await makeX(deps)` 拼成 `Farm` 并完成订阅，再按次序调各模块的 `start()`；`Farm` 是 `AsyncDisposable`，关的时候倒着调各服务的 `close()`，一个失败不挡别的。HTTP 监听就绪后才将地址注入 `Session` 和 `Lan`。
- **操作与发言主体统一用协议 `Actor`**：HTTP 与连接器入口构造 `user`（`base/actor.ts`），助手运行构造 `agent`（带 `role: "orchestrator"` 与 `forUser`），`/mcp` 构造 `agent`（带 `role: "worker"` 与会话 id），定时、巡查与 GitHub 轮询构造 `system`。协议消息、服务端 `Trigger` 与信箱共用同一个 `T.Actor`；落库列统一存 `ActorKind`（`user`、`agent`、`system`）与可选 `AgentRole`。
- **模块之间的路径与服务扇入记成表**：`scripts/audit/service-paths.ts` 按语法树、照名字声明的类型（`deps.agent.list()`、从 `deps` 解构出来的 `agent`）读出哪个模块用了别的模块服务的哪个成员（存在 `scripts/audit/service-paths.json`）并校验顶层服务扇入；`vp run paths:check` 与 `docs:verify` 一并检查，多一条路或新增单调用方顶层服务即失败。一件事一条路：往频道写话只有 `Channel.post`（[频道](docs/subsystems/channel.md#模型和不变量)），到帮工只有 Mailbox。
- **单实例家目录租约**：`infra/lease.ts` 在 `$VIBEVALLEY_HOME/.vibevalley.lock` 写入进程 pid；若旧进程仍在运行则拒绝启动，已退出则接管。

### 异步、资源与错误

写法的细节和从 Effect 改过来的对照在 [vv-typescript](.agents/skills/vv-typescript/SKILL.md)；本节记录现行结构与门禁。

- **服务是工厂加接口，依赖从参数进来**：每个模块导出接口 `X` 和 `makeX(deps: XDeps)`，`deps` 只放它用到的、排在它前面的服务，键是服务名的小驼峰（`deps.issue`）。没有全局单例：时钟、库、配置、`fetch` 都从 `deps` 进来，测试只换参数。
- **异步原语只有一套**：`@vibevalley/async` 给出 `TaskGroup`（后台任务归服务，`close()` 中止并等它们结束；同键只许一个在跑的 `keyed`）、`Queue`、`Hub`（先订后返的广播）、`Semaphore`、`retry`、`withTimeout` 和 `AsyncIterable` 的组合子。长操作收最后一个参数 `signal?: AbortSignal`，往下传给 `fetch`、子进程和 `clock.sleep`；资源返回 `AsyncDisposable`，调用方 `await using`。不 `void` 一个 Promise 放着不管（`typescript/no-floating-promises` 检查）。
- **服务缓存按实例隔离**：`makeProjection()` 每个农场一份投影缓存，并发测试农场互不串用；`Core` 是同步的，`core.apply` 折完即返回，订阅返回 `Subscription`，慢读者经 `bounded` 限量。
- **读接口错误边界**：附件与 Artifact 路由只将缺文件或 `ApiError`（`status === 404`）转为 `404`，其余故障记日志回 `500`。
- **时间经 `Clock`**：禁止在 `apps/server/src`、`apps/cli/src`、`packages/ai/src` 与 `packages/agent/src` 直接调 `Date.now()` 或 `setTimeout`（`vibevalley/no-wall-clock` 检查），读时间用 `deps.clock.now()`、等用 `deps.clock.sleep(ms, signal)`；墙上的钟只在 `infra/time.ts` 与 `packages/agent/src/infra/realTime.ts`。延迟和周期任务是 `TaskGroup` 里的循环。
- **三种失败三种写法**：对调用方的拒绝抛协议的 `ApiError`（带 `bizCode`，由 `base/errors.ts` 的 `bizError`、`refuseIn(BizCode.<模块>Refused)` 与 `missing` 构造），网关写成 `{ bizCode, message }`；模块自己的、调用方要分辨的失败是 `Error` 子类，`name` 与类名同名且全仓唯一（`practice:check` 检查），用 `instanceof` 接；预期的结果（合进去或冲突）返回判别联合，不抛。内部数据自相矛盾抛 `Inconsistent`，不伪装成拒绝。
- **库只经 `Db`**：`pg` 与 `@electric-sql/pglite` 只在 `infra/db.ts` 里用（`vibevalley/db-door` 检查）；每条语句计入 `dbQueries`（事务自己的 begin、commit 与保存点不计），超过 500 ms 的事务记一行日志。失败抛 `SqlError`，默认让它抛；接住它的地方和理由列在 `infra/db.test.ts` 的 `catching` 表里。
- **文件原子写入**：`infra/files.ts` 的 `keptFile` 先写临时文件再原子改名，`close()` 时写出最后一份。

### 契约、规则和数据库

- **按概念组织契约，根桶只导出跨端契约**：`packages/protocol/src/<概念>/` 包含 `shapes.ts`、`schema.ts`（`Codec<T.X>`）和 `api.ts`，由 `schema.test.ts` 校验字段一致。根入口 `packages/protocol/src/{shapes,schema}.ts` 禁止 `export *`，仅显式重导出跨端真实引用的根契约与枚举；单点子字段用根契约索引类型（如 `T.AgentProblem["level"]`）表达，服务端私有持久化形状留在 `apps/server/src/` 内，由 `scripts/audit/protocol-surface.ts`（`docs:verify`）棘轮守住导出上限。
- **生成文件不手改**：`db/generated/`、`packages/protocol/src/client.ts`、[capabilities.md](docs/reference/capabilities.md) 和 [primitives.md](docs/reference/primitives.md) 由脚本生成并由 `docs:verify` 校验。
- **一种 SQL，两种驱动，单连接**：`infra/db.ts` 在配了 `database.url` 时连那个 Postgres（`pg`），否则在 `db` 目录里跑 PGlite（同一种方言，跑在进程里；`memory` 时从每个进程建一次的带表结构的模板拷一份，约 0.1 秒）。两种都只开一条连接：服务按一次一写写成。时间存毫秒 `double precision`，没有 `bigint` 列（Postgres 的驱动把它当字符串交回来），布尔是 `boolean`，枚举存 `text check (列 in (...))`，JSON 存成文本、查询里 `::jsonb` 了再看里面，新建行主键用 `base/ids.ts` 的 UUIDv7（`newId()`）。全文搜索经表结构里的 `term_vector`、`term_query` 两个函数和 GIN 索引：词由 `gse` 切好、只按空格分，词原样保留。
- **SQL 按表隔离**：`db/queries/<表>.sql` 只写所属表，跨模块只读查询受 `modules.test.ts` 的 `foreignReads` 约束。服务把 `db.sql` 交给生成的函数（`getIssue(db.sql, params)`），出库的每一行经生成的 Zod 结果 Schema 解，对不上当场失败。
- **单一表结构基线，内部不留兼容**：`0001_schema.up.sql` 是唯一迁移文件。PGlite 的库在启动时若 `db.schema` 哈希不匹配，自动将旧库移至 `db.<旧哈希>-<时间>` 并建新库；`database.url` 的库是用户的，不挪不清：空库建表并记下哈希（`vibevalley_baseline`），哈希不同或已有别的表就拒绝启动。

### 边界审计

- **传输层解析，契约层直接 Fail-Fast 验证**：`JSON.parse` 把报文读成 `unknown` 后立即交给契约 `Schema` 解码；验证通过的值才进入业务层（HTTP 服务端经 `wireJson` 编码全信封，生成的 `VibeValleyApi` 客户端经 `apiSuccessEnvelope`、`ApiVoidEnvelope` 与 `ApiErrorEnvelope` 解码，SSE 经 `stream.ts`，服务端自有表可空 JSON 列经 `storedJsonOrUndefined(schema, "table.column")` 区分 `null` 空值与损坏数据）。桥接的 socket 只拆包，`packages/bridge/src/index.ts` 验证调用入参、返回值与推送载荷，不在两层重复验证同一契约。
- **按值对象复用 Schema**：数据库 JSON 列与线上字段代表同一个值对象时可共用 Schema；两者模型不同时才分开定义。是否直接调用解码器、是否先保存为变量，不改变这项判断。
- **文本扫描只提供审计提示**：`vpx scripts/audit/schema-audit.ts` 的 `[review]` 提示依赖命名和源码写法，不证明存在缺陷，也不证明验证覆盖完整。可选值、枚举转换与重复形状需要沿调用链判断，不设零命中门槛，不按文件名豁免 JSON 解析提示。
- **已映射的 SQL 枚举、协议品牌主键、`Secret` 与 `BizCode` 注册表有硬检查**：脚本的 `storedEnums` 指定「表.列 ↔ 协议枚举」，直接读取该协议枚举，按集合比较 SQL 的字面量 `IN CHECK`；丢失表、列或约束以及成员增删均产生 `db-enum-mismatch` `[error]`（取值顺序不影响结果，不读 SQL 生成物，存储专用枚举不必进协议，新增共享枚举应补映射）。协议非 `*Request` / `*Input` 形状（含 `interface` 与联合 `type`）中若将已品牌化的核心实体主键退化为裸 `string` 均产生 `unbranded-id` `[error]`；协议（`packages/protocol`）里调用 `.reveal()`，或 `Secret` 类不再有抛错的 `toJSON`、打成 `[secret]` 的 `toString` 和 inspect、私有的 `#value`，均产生 `secret-exposure` `[error]`，阻断密钥经 JSON、日志或线上外泄；`endpoint.ts` 中的 `BizCode` 若出现非六位编码、重复数值或与 `BizErrorCodeValues`、`bizCodeMeta` 成员失配，均产生 `bizcode-registry` `[error]`。
- **检查自身有正反例**：`scripts/audit/schema-audit.test.ts` 测最小源码和 SQL 样例，包括换行、提取解码器、注释、缺失约束与错误归属；仓库检查只阻断已确认的契约不一致。错误给出列、协议枚举、`Fix:` 与本节链接，审计提示给出 `Review:`。

### 测试金字塔

一个行为在能发现它出错的最低层充分测试；高一层只验证新增的接线风险，不重演下层的全部分支。类型推导、Encoded/Type 与受控状态互斥先由静态检查验证。`@vibevalley/testkit/pyramid` 沿 import 链区分规则、模块和流程；浏览器项目按入口区分组件、真实集成和扫描，不把所有 Chromium 测试都算成页面集成。

| 层 | 入口 | 真实部分 | 替身端口 | 预算 | 位置 |
|---|---|---|---|---|---|
| 规则 | 纯函数 | 被测代码 | 无 | 20ms | 不碰库、进程、网络的 `*.test.ts` |
| 模块 | 模块服务接口 | 当前及下层模块、内存库、真 git | `scriptedRuntime`、照脚本回答的 DeepSeek、假聊天/声网 | 300ms | `apps/server/src/<模块>/*.test.ts` |
| 流程 | `flows/farm.ts` | 全部服务端模块与真 git | 同上 | 2s | `apps/server/src/flows/*.test.ts` |
| 浏览器组件 | 组件 DOM 与 owner | Chromium、Solid、真实组件 | 故事数据，无服务端 | 3s | `apps/web/test/stories.spec.ts` |
| 页面 | HTTP 与 SSE | 真服务端进程 + Chromium | 脚本化帮工、无外部密钥 | 3s | `apps/web/test/projects.ts` 的 integration 项目 |
| 宿主 | `host.ts` | Electron、移动模拟器 | — | — | `apps/desktop/test`、`apps/mobile` |
| 真模型 | 模型请求与工具循环 | 指定的真实模型 | 隔离农场 | — | 助手 evals，花钱前先问用户 |

- **不靠睡眠等待**：禁止在测试中写死 `setTimeout` 或 `waitForTimeout`（`vibevalley/no-test-sleep` 检查）；等待状态用 `until`、`waitFor`、`whenState`，时间窗口用测试时钟（`deps.clock`）或 `vi.useFakeTimers()` 拨进。
- **页面测试按 `data-testid` 定位**：禁止用界面中文文案或 CSS 类名做选择器（`vibevalley/no-copy-selector` 检查）；每页在浅色与深色主题下通过 `apps/web/test/a11y.spec.ts` 检查。
- **分开行为、无障碍和视觉验收**：故事与页面的双主题扫描归 audit；主题不影响的提交、重试和排序流程只执行一次。纯截图归 visual，出图不证明图里的行为正确。故事扫描每个场景完整导航，等查看器本轮 axe 结果，不再重复注入；动态错误态另行扫描。故事窄屏使用查看器支持的 400px 并断言实际宽度，真实页面另测 390px。
- **运行入口决定准备什么**：组件只构建故事，集成与视觉只构建应用，audit 构建两者；每轮产物和家目录隔离。`e2e` 保留全量自动检查，`e2e:visual` 单独出图；命令见 [页面 README](apps/web/README.md#commands)。改一层先跑这一层，公共基础设施改动收尾再跑广域确认。CI 没有完整页面 E2E，不把未执行的全量当成通过。
- **用例的前提也要隔离**：要求空农场、唯一记录或初始配置的文件声明独立 farm；共享农场里的记录使用独立名字。不能靠重试避开其他用例留下的数据。
- **报告不代替覆盖判断**：浏览器按项目报告累计耗时和尝试数，不冒充墙钟时间；批量 audit 按场景计预算，不把几十页合起来算一页。预算不因慢而放宽，测试数和覆盖率不设减量目标；删改 regression 要点名说明由谁接替。分类器有类型导入、别名、动态导入、包导出与循环的正反例，文件分组有三类不构成分类正确的证据。
- **确定性 I/O 预算**：`Db` 与 git 入口记录查询、事务与命令次数，拦截高频路径的 N+1 退化。

### 话放在哪

- **对用户的话进词典，对模型的话进 `prompts.ts`**：
  - 界面与通知文案写在 `packages/i18n/locales/{zh,en}/<命名空间>.json`，代码调 `t("key")`（`vibevalley/no-cjk-literal` 拦截硬编码中文）。
  - 模型提示写在各模块 `prompts.ts`（中文编写，要求模型按 `usersLanguage` 回答）。
- **语言按进程生效**：语言存于 `settings.json` 的 `locale`，服务端启动和保存时调 `setLocale`；页面从 `index.html` 的 `data-locale` 读取并通过 `host.locale` 同步给桌面壳。

## 怎么走

**新增或修改表结构**

1. 修改 `apps/server/db/migrations/0001_schema.up.sql`。
2. 编辑 `apps/server/db/queries/<表>.sql`，运行 `vp run --filter @vibevalley/server db:generate`。
3. 运行 `vp test run apps/server/src/infra/schema.test.ts` 验证命名、外键与查询编译。

**新增或修改协议接口**

1. 修改 `packages/protocol/src/<概念>/` 下的 `shapes.ts`、`schema.ts` 和 `api.ts`。
2. 在 `apps/server/src/gateway/http/handlers/<概念>.ts` 实现接口。
3. 运行 `vp run api:client` 和 `vp run capabilities` 更新生成的客户端与能力表。

**修改纯函数规则**

1. 修改模块内或 `packages/protocol/src/rules/` 中的纯函数。
2. 在它旁边的 `*.test.ts` 里用手写的例子写出改了的行为。

## 和谁打交道

- **全部服务端模块**：遵循 `modules.ts` 的顺序，使用 `base` 与 `infra` 原语。
- **客户端**：`apps/web`、`apps/cli`、`apps/desktop` 导入 `@vibevalley/protocol` 的类型、规则与 `VibeValleyApi`（[客户端](docs/subsystems/app.md)）。
- **工程门禁**：`scripts/` 通过 `vp check` 与 `vp run docs:verify` 执行静态检查（[工程流程](docs/subsystems/process.md)）。

## 为什么这样

- **按限界上下文切成 11 个单向模块**：消除平铺服务的隐式启动耦合与跨模块状态直读，用 `modules.test.ts` 守住边界；放弃平铺加 lint 或粗粒度并成 5 个大模块。
- **契约按概念分目录，不拆多包**：消除单大文件合并冲突，同时避免拆成十几个子包的构建开销。
- **Postgres，不再是 `node:sqlite`**：一个服务端要管多台机器（[一个服务端管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)），库要能放在服务器上、被多台机器的活同时写；只在一台电脑上用时仍开箱即用，靠同一种方言的 PGlite。生成器 `scripts/pg-generate.ts` 让 Postgres 自己说每个参数和结果列的类型（Parse、Describe），不再从文本里猜。代价：PGlite 是数十 MB 的 WASM，新起一个要近一秒（测试从模板拷贝，约 0.1 秒），也比 `node:sqlite` 吃 CPU，服务端测试只开一半的核。
- **单一表结构基线，内部不留兼容**：启动时按 `db.schema` 哈希自动归档旧库并重建，省去演进期的多步迁移负担。
- **规则用手写的例子测，不录黄金数据**：录下的 `*.jsonl.gz` 有几十 MB，改了只看得到二进制，规则一改就整份重写，说不出哪里变对了、哪里变错了；拿不出它抓到过真问题的证据，就去掉了。
- **不用 Effect，写普通 TypeScript**：Effect 的服务、错误通道和 fiber 让每个模块多一层要学的写法，agent 照抄时最常错在它身上（错误变成缺陷、fiber 不归作用域、`yield*` 漏写），而仓库要的打断、收尾和并发用 `AbortSignal`、`await using` 和一个小的 `@vibevalley/async` 就够；运行时校验换成 Zod，SQL 的结果行也由生成器写成 Zod。代价：错误不再写在类型里，靠 `ApiError` 的 `bizCode`、`instanceof` 和 `catching` 表守住。没选只把 Effect 收缩到服务端内核：两种写法的交界要长期养着；也没选换另一个效果库（fp-ts、neverthrow）：问题是写法离普通 TypeScript 太远，换一个库只是换一套写不对的 API。
- **运行时校验只用 Zod**：agent 最熟、生态最全（Hono、MCP SDK、JSON Schema 输出都直接支持）；契约、查询的行、配置、工具入参用同一种，只有一套要学。没选 Valibot、ArkType（更小更快，但少有人熟）。
- **查询仍由 SQL 生成，只换输出**：`scripts/pg-generate.ts` 让 Postgres 自己说参数和结果列的类型（Parse、Describe），写出 Zod 的行 Schema 和普通的 `async` 函数。没选 ORM 或查询构造器（Drizzle、Kysely）：类型会从库的推断来而不是从数据库来，44 个查询文件要改写成 TypeScript；也没选 sqlc 本身：它的 TypeScript 插件不写 Zod，驱动里没有 PGlite。
- **话进 JSON 词典并生成类型，提示词保持中文**：由 `scripts/gen/i18n.ts` 统一查漏翻与死键；提示词不翻，避免双份提示调优与评测漂移。

## 怎么验证

- `vp check`、`vp run practice:check`、`vp run paths:check`：检查格式、带类型的 lint、全仓语法树实践棘轮与服务调用路径。
- `vpx scripts/audit/schema-audit.ts`、`vp test run apps/server/src/modules.test.ts apps/server/src/infra/schema.test.ts packages/protocol/src/schema.test.ts`：验证模块边界、表结构、SQL 枚举与 `Secret` 契约一致性。
- `vp run docs:verify`：验证生成物、协议导出面、服务路径、词典、旧名字与文档链接。
