# 地基

Go 服务端与客户端共用的工程骨架：Go module（`cmd/*`、`internal/*`、`pkg/*`）配 SQLite 与 `sqlc`，pnpm 工作区中的共享 TypeScript 包（`@vibevalley/*`）、Zod 契约与静态门禁体系。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| Go 包边界、SQLite + `sqlc` 代码生成，以及 pnpm 工作区、依赖 catalog 与类型检查 | 各包的对外约定（各包 `README.md`） |
| `internal/domain/*` 领域划分与 `arch_test.go` 单向依赖守卫 | 各领域的业务行为（对应子系统文档） |
| `packages/protocol` 与 `pkg/contract` 的契约定义、双端生成器及客户端生成 | 核心状态折叠与接口路由（[核心状态](docs/subsystems/core.md)） |
| 持久化表结构、SQL 查询生成与迁移测试 | 业务表含义（各子系统）与家目录文件（[架构](docs/architecture.md#存了什么)） |
| 页面分层、无睡眠等待、浏览器测试金字塔与 Vite+ 门禁 | 像素皮渲染与宿主窗口容器（[客户端](docs/subsystems/app.md)） |
| 词典（`packages/i18n`）与模型提示（`internal/domain/stack/prompts.go`）分工 | 界面用词标准（[用语表](docs/README.md#用语)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `pnpm-workspace.yaml`、`vite.config.ts` | 工作区包列表、依赖版本 catalog、oxfmt、oxlint 与任务编排配置 |
| `go.mod`、`sqlc.yaml`、`arch_test.go`、`sqlc_migrate_test.go` | Go 依赖、SQL 生成配置、领域包依赖拓扑断言与平台 SQL 迁移校验 |
| `scripts/{gen,audit,docs,release}/` | 工程脚本：`gen/`（TS 客户端、`pkg/contract`、`sqlc`、词典生成）、`audit/`（AST / lint / 类型 / 边界门禁）、`docs/`（笔记、链接、术语与旧名检查）、`release/`（Go 沙箱验证与发版） |
| `tsconfig.base.json`、`scripts/audit/oxlint-plugin.ts` | TypeScript 严格选项与仓库自定义 lint 规则 |
| `packages/async/` | 打断、后台任务、队列、广播、锁、重试与超时：TypeScript 包与页面共用的异步原语 |
| `scripts/audit/practice-audit.ts`、`protocol-surface.ts`、`schema-audit.ts` | 语法树实践棘轮、根协议导出面棘轮、品牌主键 / `Secret` / `BizCode` 注册表边界审计 |
| `internal/config/`、`internal/vault/`、`internal/durable/`、`internal/machine/`、`internal/provider/` | Go 配置解析、密钥信封与代理、持久代理运行引擎、机器沙箱与模型路由 |
| `internal/domain/<概念>/` | Go 领域模块与入口服务（装配汇总在 `internal/domain/stack/stack.go`） |
| `pkg/{db,oar,chord,contract,migrate}/` | Go 独立核心包：统一平台 SQLite WAL 池与 11 模块迁移/生成绑定、农机驱动（仅标准库）、状态增量同步与双向多路复用链路、跨端视图契约与作用域迁移器 |
| `packages/protocol/src/<概念>/` | 按概念划分的 `shapes.ts`、`schema.ts`（Zod）、`api.ts` |
| `packages/protocol/src/rules/` | 服务端与页面共用的纯函数规则 |
| `packages/protocol/src/client.ts` | 由 `scripts/gen/api-client.ts` 生成的 HTTP 客户端 `VibeValleyApi` |
| `packages/testkit/`、`packages/i18n/`、`scripts/gen/i18n.ts` | 测试断言与金字塔分级原语；中英双语词典 JSON、生成的 `src/catalogs.ts` 与检查工具 |

共用原语清单见生成的 [primitives.md](docs/reference/primitives.md)。

## 模型和不变量

### 仓库和包

- **Go 后端 + TypeScript 工作区协同**：服务端、命令行、机器守护进程与桌面端采用纯 Go（`CGO_ENABLED=0`），共享库与前端页面采用 TypeScript 并统一由 Vite+（`vp` / `vpx`）运行与检查。
- **依赖版本集中**：前端应用（含 `apps/site`、`apps/mobile`、`apps/web`）与 15 个共享包使用根 workspace 和同一份锁文件。版本集中在 `pnpm-workspace.yaml` 的 catalog 中，由 `scripts/audit/catalog.test.ts` 检查。
- **开启全局虚拟存储**：`enableGlobalVirtualStore` 让新 worktree 直接硬链全局包，几秒内完成安装。
- **TypeScript 二级目录约定**：页面（`apps/web`）与共享库遵循标准目录分层：`base/`（零 I/O 纯函数，`vibevalley/subpackage-layers` 静态守住纯度）、`infra/`（外部通信）、`state/`（Atom 状态中间层）、`ui/`（通用组件；跨模块展示件放 `ui/domain/`）、`features/<概念>/` 以及 `testing/`。
- **跨包走包名，包内跨目录走 `#/`**：跨包导入应写 `@vibevalley/*`，`apps/web` 内部跨目录导入写 `#/`（由 `no-cross-package-path` 与 `parent-import` 规则检查）。
- **包导出分离类型与源码**：`packages/*` 的代码导出将 `types` 指向 `dist/*.d.ts`（`vp run packages:build` 生成，`scripts/audit/built-types.ts` 检查），`default` 指向源码；`.css` 导出直接指向 `src/` 下存在的样式表。
- **严格可选属性**：TypeScript 开启 `exactOptionalPropertyTypes`，对外对象用 `omitUndefined` 清理未定义键（[代码风格](docs/style/code.md#没有值)）。

### 模块与包边界

架构、边界与测试如何共同设计，见[模块设计](docs/style/module-design.md)；本节记录现行结构与门禁。

- **Go 五层 DAG 与 `arch_test.go` 四道编译期红线**：
  - 依赖层级严格单向：`pkg/chord`（第 0 层）← `pkg/{contract,oar,migrate,db}`（第 1 层）← `internal/{config,durable,vault,machine,provider}`（第 2 层）← `internal/domain/*`（第 3 层）← `cmd/*`（第 4 层）；第 3 层以下同层不同子系统之间禁止互引，包路径禁用 `brain`、`hands`、`common`、`utils`、`manager`。
  - `cmd/vibe-machine` 纯净性：传递依赖禁止出现数据库驱动（`modernc.org/sqlite`、`pgx`）、模型 SDK（`anthropic`、`openai`、`genai`）、`internal/durable`、`internal/vault` 与 `github.com/egoist/mygo`。
  - `pkg/oar` 完全自治：仅允许依赖 Go 标准库，确保离线回放测试套件零外部依赖独立运行。
  - `github.com/egoist/mygo` 隔离：仅允许在 `cmd/vibe-desktop` 中引用，保证服务端与执行节点构建零图形库依赖。
- **组装与启动**：`internal/domain/stack/stack.go` 按序初始化配置、`vault`、各 `internal/domain/*` 服务与持久引擎并在关闭时释放。
- **单数概念名与协议命名空间**：目录、表名和领域包均用单数概念词，TypeScript 引用同名的协议类型写为 `T.Issue`（由 `singular-service` 与 `protocol-namespace` 规则检查）。
- **Go 契约与 SQL 代码生成保持同步**：`vpx scripts/gen/go-contract.ts --check` 校验 `packages/protocol` 与 `pkg/contract` 一致性，`vpx scripts/gen/go-sqlc.ts --check`、`sqlc diff -f sqlc.yaml` 与 `sqlc compile -f sqlc.yaml` 校验表结构与查询编译最新。

### Chord 增量同步与多路复用链路（`pkg/chord`）

- **严格 JSON 增量折叠（`pkg/chord/delta`）**：同步快照限定为严格 JSON 值（拒绝 `NaN` 与 `±Inf`），写路径产生 `r`（替换）、`d`（删除）、`a`（字符串追加）与 `s`（数组切片）四类操作码。`PendingOps` 在消费或传输拥塞时执行四条在线折叠规则（同路径连续追加拼合、子树替换覆盖消除、新建接追加原地合并），一旦挂起数超过 `10,000` 条（`DefaultMaxPendingOps`）立即熔断并退化为单条全量根替换 `[["r", latestRoot]]`。
- **单飞订阅句柄（`pkg/chord/watch`）**：`WatchHandle[T]` 串行投递变更，在上一次消费回调返回前绝不并发重入，期间提交在 `PendingOps` 合并；文档回收时发送 `retired: true` 而不断开句柄，重建后自动以根替换恢复，并支持携带 `WithFromRev` 游标续传。
- **双向多路复用 `Link`（`pkg/chord/link`）**：在单一 `FrameTransport` 上复用双向 RPC（`rpc_req`/`rpc_res`/`rpc_cancel`）与视图订阅（`watch_open`/`watch_push`/`watch_stop`/`watch_end`），握手绑定 `Principal`，默认 15 秒心跳探测与 45 秒超时自动取消在途 RPC 上下文；超过 `64 KiB`（`MaxFrameBytes`）的负载自动拆分为交错分块帧传输以避免队头阻塞（重组上限 `32 MiB`），统一提供 WebSocket 与进程内内存管道（`link.NewMemoryPipe`）两种传输实现。

### 异步、资源与错误

TypeScript 包的写法细节在 [vv-typescript](.agents/skills/vv-typescript/SKILL.md)；本节记录通用约束。

- **异步原语只有一套**：TypeScript 包里的 `@vibevalley/async` 提供 `TaskGroup`、`Queue`、`Hub`、`Semaphore`、`retry`、`withTimeout` 和 `AsyncIterable` 组合子。长操作收 `signal?: AbortSignal`，不 `void` 一个 Promise 放着不管（`typescript/no-floating-promises` 检查）。
- **时间经 `Clock`**：禁止在受控业务包内直接调 `Date.now()` 或 `setTimeout`（`vibevalley/no-wall-clock` 检查），使用 `Clock` 注入以便确定性测试。
- **三种失败明确区分**：接口边界拒绝返回携带六位 `BizCode` 的标准信封与 `ApiError`；模块特有失败写明类型或 `Error` 子类并保留错误上下文；绝不用空 `catch` 吞掉异常（`health:verify` 棘轮守住）。

### 契约、规则和数据库

- **按概念组织契约，根桶只导出跨端契约**：`packages/protocol/src/<概念>/` 包含 `shapes.ts`、`schema.ts`（`Codec<T.X>`）和 `api.ts`，由 `schema.test.ts` 校验。根入口 `packages/protocol/src/{shapes,schema}.ts` 禁止 `export *`，仅显式重导出跨端引用契约，由 `scripts/audit/protocol-surface.ts`（`docs:verify`）棘轮守住导出上限。
- **生成文件不手改**：`pkg/db/generated/`、`pkg/contract/tsgen`、`packages/protocol/src/client.ts`、[capabilities.md](docs/reference/capabilities.md)、[primitives.md](docs/reference/primitives.md) 与 `packages/i18n/src/catalogs.ts` 均由脚本写出，由 `server:check` 与 `docs:verify` 校验最新。
- **统一平台 SQLite WAL + `pkg/db` + `sqlc` + `pkg/migrate`**：11 个持久化模块按序收口在 `pkg/db/migrations/`（`0001_durable`–`0011_gateway` `{up,down}.sql`，嵌入为 `db.MigrationsFS` 并另提供 `db.ScopeFS` 单模块视图）与 `pkg/db/queries/`（`{durable,vault,agent,repo,game,issue,channel,watch,memory,pkm,gateway}.sql`），单块根目录 `sqlc.yaml` 生成 `pkg/db/generated/`（`package generated`）。运行时（`stack.New`）所有 11 个持久域共享同一份 SQLite WAL 数据库（`vibevalley.db` / `platform.db`，迁移追踪作用域 `platform`，无分库文件），由 `pkg/db.OpenPool` 统一配置单写连接（`WriteDB`，`MaxOpenConns(1)`）与并发 WAL 读连接池（`ReadDB`，`MaxOpenConns(4)`，内存 DSN 复用写连接）并全局启用 `sqlite-vec` 向量函数，各域在装配时接收共享连接且不独自关库；`pkg/migrate` 与 `internal/domain/stack/migrate.go` 负责版本化 `up`/`down`/`status`，全仓 `sqlc_migrate_test.go` 校验迁移幂等与可建表，内部演进直接修改对应模块基线，不留兼容补丁。

### 边界审计

- **传输层解析，契约层直接 Fail-Fast 验证**：`JSON.parse` 把报文读成 `unknown` 后立即交给契约 `Schema` 解码；`VibeValleyApi` 经 `apiSuccessEnvelope`、`ApiVoidEnvelope` 与 `ApiErrorEnvelope` 解码，SSE 经 `stream.ts`，宿主桥经 `packages/bridge/src/index.ts` 解码入参与回包。
- **文本扫描只提供审计提示**：`vpx scripts/audit/schema-audit.ts` 的 `[review]` 提示帮助人工沿着调用链判断未验证解析，不作为阻断门槛。
- **协议品牌主键、`Secret` 与 `BizCode` 注册表有硬检查**：`schema-audit.ts` 阻断非 `*Request`/`*Input` 协议形状把已品牌化实体主键退化为裸 `string`（`unbranded-id`）、禁止在协议中泄露或调用 `.reveal()` 暴露 `Secret`（`secret-exposure`），以及验证 `endpoint.ts` 中 `BizCode` 六位编码、`BizErrorCodeValues` 与 `bizCodeMeta` 完全对应（`bizcode-registry`）。
- **检查自身有正反例**：`scripts/audit/schema-audit.test.ts` 覆盖边界审计正反例；错误消息写明原因、`Fix:` 与文档位置。

### 测试金字塔

一个行为在能发现它出错的最低层充分测试；高一层只验证新增的接线风险，不重演下层的全部分支。`@vibevalley/testkit/pyramid` 与 Go 分包测试配合，浏览器项目区分组件、真实集成与无障碍审计：

| 层 | 入口 | 真实部分 | 替身端口 | 位置 |
|---|---|---|---|---|
| 规则 / 领域单测 | 纯函数与领域包接口 | 被测 Go 包、内存库或临时 SQLite / git | `pkg/oar/replaytest` 等端口替身 | `internal/**/*_test.go`、`pkg/**/*_test.go`、`*.test.ts` |
| 集成 / 端到端 | `cmd/*`、`acceptance_test.go` | 完整 Go 服务栈与 CLI | 测试 runtime 与内存/临时目录 | 根测试、`cmd/**/*_test.go`、`scripts/release/verify-server.test.ts` |
| 浏览器组件 | 组件 DOM 与 owner | Chromium、Solid、真实组件 | 故事数据，无服务端 | `apps/web/test/stories.spec.ts` |
| 页面 | HTTP 与 SSE | `cmd/vibe-server` 真实进程 + Chromium | `--scripted-helper` / 测试 runtime、无外部密钥 | `apps/web/test/projects.ts` 的 integration 项目 |
| 桌面 / 移动宿主 | 桌面无头 / 移动端模拟器 | Go 桌面壳、`apps/mobile` 原生容器 | `thin_desktop` / 模拟器本地沙箱 | `cmd/vibe-desktop/*_test.go`、`apps/mobile` |

- **不靠睡眠等待**：禁止在前端与脚本测试中写死 `setTimeout` 或 `waitForTimeout`（`vibevalley/no-test-sleep` 检查）；等待状态用 `until`、`waitFor`，时间窗口用测试时钟。
- **页面测试按 `data-testid` 定位**：禁止用界面中文文案或 CSS 类名做选择器（`vibevalley/no-copy-selector` 检查）；每页在浅色与深色主题下通过 `apps/web/test/a11y.spec.ts` 检查。
- **分开行为、无障碍和视觉验收**：故事与页面的双主题扫描归 audit；纯截图归 visual。用例的前提各自隔离到独立仓库/工作台实例。

### 话放在哪

- **对用户的话进词典，对模型的话进 `prompts.ts`**：
  - 界面与错误引导文案写在 `packages/i18n/locales/{zh,en}/<命名空间>.json`，代码调 `t("key")`（`vibevalley/no-cjk-literal` 拦截 TS 硬编码中文）。
  - 模型提示写在 `internal/domain/stack/prompts.go`（中文编写，要求模型按 `usersLanguage` 回答）。
- **语言按进程生效**：语言存于 `settings.json` 的 `locale`，页面从 `index.html` 的 `data-locale` 读取。

## 怎么走

**新增或修改表结构**

1. 修改 `pkg/db/migrations/` 下对应模块的 `{up,down}.sql` 与 `pkg/db/queries/*.sql`。
2. 运行 `vp run go:sqlc`（或 `vpx scripts/gen/go-sqlc.ts --write`）重写 `pkg/db/generated/`。
3. 运行 `env -u GOROOT CGO_ENABLED=0 go test -count=1 ./...`（包含 `sqlc_migrate_test.go`）验证。

**新增或修改协议接口**

1. 修改 `packages/protocol/src/<概念>/` 下的 `shapes.ts`、`schema.ts` 和 `api.ts`。
2. 运行 `vp run api:client`、`vp run capabilities` 与 `vpx scripts/gen/go-contract.ts --write` 更新生成的客户端、能力表与 Go 视图定义。
3. 在 `internal/domain/gateway/` 中实现对应处理并补充 `gateway` 与 `contract_parity` 测试。

**修改纯函数规则**

1. 修改所属 Go 包或 `packages/protocol/src/rules/` 中的纯函数。
2. 在同包的测试文件中以明确用例覆盖改动的行为。

## 和谁打交道

- **Go 领域服务**：遵循 `arch_test.go` 边界与 `internal/domain/stack/stack.go` 装配顺序。
- **客户端**：`apps/web` 与 `apps/mobile` 导入 `@vibevalley/protocol` 的类型、规则与 `VibeValleyApi`（[客户端](docs/subsystems/app.md)）；`cmd/vibe` 调用后端 `/api/v1/*` JSON 接口。
- **工程门禁**：`scripts/` 通过 `vp check`、`vp run server:check`、`vp run web:check` 与 `vp run docs:verify` 执行全栈检查（[工程流程](docs/subsystems/process.md)）。

## 为什么这样

- **后端、CLI 与桌面壳全面迁移到 Go，共用包与页面保留 TypeScript**：服务端持久运行、SQLite 单文件嵌入式分发、跨平台 CLI 与原生桌面壳（`cmd/vibe-desktop`）需要零 Node 运行时依赖的单二进制交付；界面（Solid 2 + Vite）、PWA/桌面 Web 资源和跨端 Schema 契约（`packages/protocol`）留在 TypeScript 中直接由 Tailwind v4 与 Vite+ 构建。
- **TypeScript 侧不用 Effect，坚持普通 TS + `@vibevalley/async` + Zod**：共享包和脚本保持最浅抽象，只用 `AbortSignal`、`await using` 与 `TaskGroup` 就能解决资源与并发，Zod 一次解码并生成 `VibeValleyApi`。
- **统一 `pkg/db` 单库 SQLite WAL + 分模块 SQL**：表迁移与查询按模块拆文件集中于 `pkg/db/`，单块 `sqlc.yaml` 生成同一个 `pkg/db/generated` 包，既保证跨模块共享同一 WAL 连接池、消除多库写锁碎片与循环嵌入，又由编译器确保 SQL 参数与返回字段精确到列，无需手写映射或重型 WASM Postgres。
- **规则用手写的例子测，不录庞大黄金数据**：最小场景单元测试和 `pkg/oar/replaytest` 清晰可审，不靠几十 MB 黑盒归档掩盖规则回归。
- **话进 JSON 词典并生成类型，提示词保持中文**：由 `scripts/gen/i18n.ts` 统一查漏翻与死键；提示词集中维护，避免双份提示调优漂移。

## 怎么验证

- `vp run server:check`：构建 `packages/*`、`vp check`、验证 `go-sqlc` 与 `go-contract` 同步，并跑完 `go vet` 与 `go test ./...`（含 `arch_test.go`、`sqlc_migrate_test.go`）。
- `vp run practice:check`、`vp run health:verify`、`vp run deadcode`：检查全仓语法树实践棘轮、逃生口棘轮与死代码。
- `vp run docs:verify`：验证生成物、协议导出面、词典、旧名字、技能结构与全部文档链接。
