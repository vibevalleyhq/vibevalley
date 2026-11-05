# 地基

服务端、客户端和脚本共用的工程骨架：pnpm 工作区、Effect 服务分层、概念分目录的协议契约、SQLite 代码生成与测试金字塔。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 工作区、依赖 catalog、构建与类型检查 | 各包的对外约定（各包 `README.md`） |
| 服务端 13 个模块的划分、依赖方向与两阶段启动 | 各模块的业务行为（对应子系统文档） |
| `packages/protocol` 的概念目录、Schema 与客户端生成 | 核心状态折叠与接口路由（[核心状态](docs/subsystems/core.md)） |
| SQLite 基线表结构、SQL 代码生成、主键与命名规范 | 业务表含义（各子系统）与家目录文件（[架构](docs/architecture.md#存了什么)） |
| 测试金字塔、虚拟时钟、黄金数据与脚本化帮工 | 页面分层与宿主打包（[客户端](docs/subsystems/app.md)） |
| 词典（`packages/i18n`）与模型提示（`prompts.ts`）分工 | 界面用词标准（[用语表](docs/README.md#用语)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `pnpm-workspace.yaml`、`vite.config.ts` | 工作区包列表、依赖版本 catalog、oxfmt 与 oxlint 配置 |
| `tsconfig.base.json`、`scripts/oxlint-plugin.ts` | TypeScript 严格选项、`@effect/tsgo` 插件与仓库自定义 lint 规则 |
| `apps/server/src/base/` | 纯工具函数（`ids.ts`、`json.ts`、`redact.ts`、`actor.ts`、`clip.ts`、`order.ts`） |
| `apps/server/src/infra/` | 系统适配（`config.ts`、`db.ts`、`baseline.ts`、`time.ts`、`log.ts`、`lease.ts`、`files.ts`） |
| `apps/server/src/modules.ts`、`services.ts` | 13 个模块的归属表与两阶段服务组装 |
| `packages/protocol/src/<概念>/` | 按概念划分的 `shapes.ts`、`schema.ts`、`api.ts` |
| `packages/protocol/src/rules/` | 服务端与页面共用的纯函数规则 |
| `packages/protocol/src/client.ts` | 由 `scripts/api-client.ts` 生成的 HTTP 客户端 `VibeValleyApi` |
| `apps/server/db/migrations/0001_schema.up.sql` | 唯一 SQLite 表结构基线 |
| `apps/server/db/queries/<表>.sql`、`db/generated/` | 按表拆分的 SQL 查询与 `scripts/sqlite-generate.ts` 生成代码 |
| `apps/server/src/testing/`、`packages/testkit/` | 测试农场组装、虚拟时钟等待、黄金数据与测试金字塔分级 |
| `packages/i18n/`、`scripts/i18n.ts` | 中英双语词典 JSON、生成的 `src/catalogs.ts` 与词条检查工具 |

共用原语清单见生成的 [primitives.md](docs/reference/primitives.md)。

## 模型和不变量

### 仓库和包

- **单一语言与运行器**：全仓使用 TypeScript，开发与测试用 `vpx` 直接运行源码，桌面版服务端用 `vp pack` 打包为 `dist/main.mjs`。
- **依赖版本唯一**：所有版本集中在 `pnpm-workspace.yaml` 的 `catalog` 中，各包写 `catalog:`，由 `scripts/catalog.test.ts` 检查。
- **开启全局虚拟存储**：`enableGlobalVirtualStore` 让新 worktree 直接硬链全局包，几秒内完成安装。
- **跨包走包名，包内跨目录走 `#/`**：跨包导入必须写 `@vibevalley/*`，`apps/server` 与 `apps/web` 跨目录导入写 `#/` 和 `#db/`（由 `no-cross-package-path` 与 `parent-import` 规则检查）。
- **包导出分离类型与源码**：`packages/*` 的 `exports` 将 `types` 指向 `dist/*.d.ts`（`vp run packages:build` 生成，`scripts/built-types.ts` 检查），`default` 指向源码。
- **严格可选属性**：开启 `exactOptionalPropertyTypes`，对外对象用 `omitUndefined` 清理未定义键（[代码风格](docs/style/code.md#没有值)）。

### 模块和服务

- **13 个有序模块单向依赖**：模块顺序定义在 `apps/server/src/modules.ts`。下层不得 import 上层，不得直接读 `core.state()` 中其他模块的数据（`apps/server/src/modules.test.ts` 检查）。
- **单数概念名，一模块一服务**：目录、表名和服务名均用单数概念词，协议同名类型统一写为 `T.Issue`（由 `singular-service` 与 `protocol-namespace` 规则检查）。
- **组装与启动分两阶段**：`services.ts` 先构建全部模块 layer 并完成流订阅，再按顺序执行各模块的 `start`/`ready` layer。HTTP 监听就绪后才将地址注入 `Session` 和 `Lan`。
- **操作主体 `Actor` 由入口构造**：HTTP 为 `owner`，管家工具为 `orchestrator`（带 `forOwner`），`/mcp` 为对应 `session`，定时与巡查为 `system`。落库枚举统一用 `actor_kind`。
- **单实例家目录租约**：`infra/lease.ts` 在 `$VIBEVALLEY_HOME/.vibevalley.lock` 写入进程 pid；若旧进程仍在运行则拒绝启动，已退出则接管。

### Effect 与错误处理

- **服务方法具名追踪**：写成 `Effect.fn("<服务>.<方法>")`（`vibevalley/service-method-names` 检查）；高频热点用 `Effect.fnUntraced`。
- **Promise 止步于外部库边界**：外部异步调用必须用 `Effect.tryPromise({ try, catch })` 包装并绑定 `AbortSignal`（`vibevalley/promise-boundary` 检查）。出站请求统一走 Effect `HttpClient`。
- **时间与定时归属作用域**：
  - 禁止在 `apps/server/src` 直接调 `Date.now()` 或 `setTimeout`（`vibevalley/no-wall-clock` 检查）。
  - 延迟任务放入服务作用域的 `FiberMap`，周期任务用 `Schedule.spaced`；仅外部进程超时用 `infra/time.ts` 的 `afterRealTime`、`withinRealTime`、`wallTime`。
- **错误使用 `Schema.TaggedError`**：包装外部异常时保留 `cause: Schema.Defect()`。禁止对 TaggedError 用 `instanceof`（`vibevalley/no-instanceof-tagged` 检查），统一用 `catchTag` 或 `Predicate.isTagged`。
- **文件原子写入**：`infra/files.ts` 的 `keptFile` 先写临时文件再原子改名，作用域关闭时自动 flush。

### 契约、规则和数据库

- **按概念组织契约**：`packages/protocol/src/<概念>/` 包含 `shapes.ts`、`schema.ts`（`Codec<T.X>`）和 `api.ts`，由 `schema.test.ts` 校验字段一致。
- **生成文件不手改**：`db/generated/`、`packages/protocol/src/client.ts`、[capabilities.md](docs/reference/capabilities.md) 和 [primitives.md](docs/reference/primitives.md) 由脚本生成并由 `docs:verify` 校验。
- **单连接进程内 SQLite**：`infra/db.ts` 用 `node:sqlite` 打开 `vibevalley.db`。时间存毫秒 `real`，布尔存 `0`/`1`，枚举存 `text check (列 in (...))`，新建行主键用 `base/ids.ts` 的 UUIDv7（`newId()`）。
- **SQL 按表隔离**：`db/queries/<表>.sql` 只写所属表，跨模块只读查询受 `modules.test.ts` 的 `foreignReads` 约束。服务通过 `Db` 服务调用生成函数（`vibevalley/db-door` 检查）。
- **单一表结构基线，内部不留兼容**：`0001_schema.up.sql` 是唯一迁移文件。启动时若 `db.schema` 哈希不匹配，自动将旧库移至 `db.<旧哈希>-<时间>` 并建新库。

### 测试金字塔

测试按 import 依赖自动分入五层（`@vibevalley/testkit/pyramid`），在能验证行为的最低层编写：

| 层 | 入口 | 真实部分 | 替身端口 | 预算 | 位置 |
|---|---|---|---|---|---|
| 规则 | 纯函数 | 被测代码 | 无 | 20ms | 不碰库、进程、网络的 `*.test.ts` |
| 模块 | 模块服务接口 | 当前及下层模块、内存库、真 git | `scriptedRuntime`、假 `Llm`、假聊天/声网 | 300ms | `apps/server/src/<模块>/*.test.ts` |
| 流程 | `flows/farm.ts` | 全部服务端模块与真 git | 同上 | 2s | `apps/server/src/flows/*.test.ts` |
| 页面 | HTTP 与 SSE | 真服务端进程 + Chromium | 脚本化帮工、无外部密钥 | 3s | `apps/web/test/*.spec.ts` |
| 宿主 | `host.ts` | Electron、移动模拟器 | — | — | `apps/desktop/test`、`apps/mobile` |

- **不靠睡眠等待**：禁止在测试中写死 `setTimeout`、`Effect.sleep` 或 `waitForTimeout`（`vibevalley/no-test-sleep` 检查）；等待状态用 `until`、`waitFor`、`whenState`，时间窗口用 `TestClock` 拨进。
- **页面测试按 `data-testid` 定位**：禁止用界面中文文案或 CSS 类名做选择器（`vibevalley/no-copy-selector` 检查）；每页在浅色与深色主题下通过 `apps/web/test/a11y.spec.ts` 检查。
- **确定性 I/O 预算**：`Db` 与 git 入口记录查询、事务与命令次数，拦截高频路径的 N+1 退化。

### 话放在哪

- **对主人的话进词典，对模型的话进 `prompts.ts`**：
  - 界面与通知文案写在 `packages/i18n/locales/{zh,en}/<命名空间>.json`，代码调 `t("key")`（`vibevalley/no-cjk-literal` 拦截硬编码中文）。
  - 模型提示写在各模块 `prompts.ts`（中文编写，要求模型按 `ownersLanguage` 回答）。
- **语言按进程生效**：语言存于 `settings.json` 的 `locale`，服务端启动和保存时调 `setLocale`；页面从 `index.html` 的 `data-locale` 读取并通过 `host.locale` 同步给桌面壳。

## 怎么走

**新增或修改表结构**

1. 修改 `apps/server/db/migrations/0001_schema.up.sql`。
2. 编辑 `apps/server/db/queries/<表>.sql`，运行 `vp run --filter @vibevalley/server db:generate`。
3. 运行 `vp test run apps/server/src/infra/schema.test.ts` 验证命名、外键与查询编译。

**新增或修改协议接口**

1. 修改 `packages/protocol/src/<概念>/` 下的 `shapes.ts`、`schema.ts` 和 `api.ts`。
2. 在 `apps/server/src/http/handlers/<概念>.ts` 实现接口。
3. 运行 `vp run api:client` 和 `vp run capabilities` 更新生成的客户端与能力表。

**修改纯函数规则与黄金数据**

1. 修改模块内或 `packages/protocol/src/rules/` 中的纯函数。
2. 运行 `vp run golden:update <模块>` 更新 `testdata/*.jsonl.gz`，检查 `git diff`。

## 和谁打交道

- **全部服务端模块**：遵循 `modules.ts` 的顺序，使用 `base` 与 `infra` 原语。
- **客户端**：`apps/web`、`apps/cli`、`apps/desktop` 导入 `@vibevalley/protocol` 的类型、规则与 `VibeValleyApi`（[客户端](docs/subsystems/app.md)）。
- **工程门禁**：`scripts/` 通过 `vp check`、`vp run effect:check` 与 `vp run docs:verify` 执行静态检查（[工程流程](docs/subsystems/process.md)）。

## 为什么这样

- **按限界上下文切成 13 个单向模块**：消除平铺服务的隐式启动耦合与跨模块状态直读，用 `modules.test.ts` 守住边界；放弃平铺加 lint 或粗粒度并成 5 个大模块。
- **契约按概念分目录，不拆多包**：消除单大文件合并冲突，同时避免拆成十几个子包的构建开销。
- **用内置 `node:sqlite` 替代 PGlite**：零外部二进制、建库仅需几毫秒且自带 FTS5，由 `scripts/sqlite-generate.ts` 生成类型化查询；放弃需加载数十 MB WASM 的 PGlite。
- **单一表结构基线，内部不留兼容**：启动时按 `db.schema` 哈希自动归档旧库并重建，省去演进期的多步迁移负担。
- **话进 JSON 词典并生成类型，提示词保持中文**：由 `scripts/i18n.ts` 统一查漏翻与死键；提示词不翻，避免双份提示调优与评测漂移。

## 怎么验证

- `vp check`、`vp run effect:check`：检查格式、lint、类型与 Effect 诊断。
- `vp test run apps/server/src/modules.test.ts apps/server/src/infra/schema.test.ts packages/protocol/src/schema.test.ts`：验证模块边界、表结构与 Schema 一致性。
- `vp run docs:verify`：验证生成物、词典、旧名字与文档链接。
