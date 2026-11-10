# Agent Note: 用 AST 切片、模型判别与单向棘轮收敛五大存量工程债

Status: proposed

## Problem

截至 2026-11-10，仓库在推进大批量迁移与向发布态过渡时存在 5 处存量工程张力：

- **StyleX 迁移脚手架膨胀与机械样式名残留**：`scripts/` 下维护了 20 余个 `style-migration*.ts` 临时脚本（其中 `scripts/style-migration-reviews.ts` 单文件 56 KB），仓库仍剩约 2,020 个旧类 token（分布在 107 个文件）与 18 个样式接口检出项。自动转换产出的 `recipeStyles2`、`variantStyles2` 与 `messageBodyDivVariant1Case2` 等机械键名掩盖了组件状态语义。
- **跨异步隐式状态机与手工回滚布尔群漏检**：[practice-audit.ts](scripts/practice-audit.ts) 的 `loose-flags` 仅检查单个函数体顶层的 `let x = false` 与 `createSignal(false)`，未覆盖类字段包（如 `VoiceCall`）及跨异步边界的手工回滚标志（如 [session.ts](apps/server/src/session/session.ts) 中的 `committed`、`released`、`registeredRow`）。
- **局部逃生口与静默吞错堆积**：[health.ratchet.json](scripts/health.ratchet.json) 记录 `web: farm` 存有 60 处 `nonNull`（`!`）断言、`web: features/voice` 存有 6 处 `swallowed`；[practice.ratchet.json](scripts/practice.ratchet.json) 记录 `apps/server` 存有 34 处 `swallow-without-record` 与 25 处 `failure-without-reason`。
- **Effect 不稳定 API 散落业务模块**：[effect.ratchet.json](scripts/effect.ratchet.json) 记录 `apiStabilityLeak` 在 `apps/server` 有 116 处、`apps/cli` 有 35 处、`apps/web` 有 26 处、`packages/provider` 有 21 处。升级 `effect` 次版本时，变更会直接穿透至业务层。
- **整库重置策略与桌面端用户数据留存冲突**：[db.ts](apps/server/src/infra/db.ts) 的 `setAsideStale` 在 [0001_schema.up.sql](apps/server/db/migrations/0001_schema.up.sql) 哈希变化时将旧 PGlite 目录移至 `<where>.<hash>-<now>` 并重建空库。进入外部测试与正式分发后，直接丢弃旧库会清空用户的设置、档案、记性、频道发言与工单记录。

## Proposal

按「AST 确定性切片与重写 + 模型结构化语义裁决 + 单向棘轮锁死」分工：AST 负责定位语法节点、提取最小上下文并执行无损代码改写；模型仅接收切片并输出受 Schema 约束的 JSON 裁决，不应直接改写整份源码。

| 问题域 | AST 与静态脚本职责 | 模型判别职责（JSON 裁决） | 守门门禁 |
|---|---|---|---|
| StyleX 语义收尾与脚手架退场 | 提取 `stylex.create` 机械键名、CSS 属性与 JSX 条件表达式；校验无冲突后重写标识符并合并样式对象 | 依据条件表达式与属性语义输出 `{"oldObj.oldKey": "newKey"}` 映射表 | 零像素回归检查 + `oxlint` 禁旧类名规则 |
| 编排层隐式状态与手工回滚 | 检出函数内多布尔异常回滚（`manual-rollback-flags`）与类内共变可变字段（`co-mutated-fields`） | 区分「正交独立维度」与「耦合隐式状态机」，输出判别联合定义草案 | [practice.ratchet.json](scripts/practice.ratchet.json) 单向棘轮 |
| 农场 60 处 `!` 与服务端 34 处吞错 | 将 `TSNonNullExpression` 按父节点分 3 类改写；提取静默 `catch` 与 `orElseSucceed` 上下文 | 将吞错点归类为 `cleanup`、`expected-empty` 或 `bug-hiding` | [health.ratchet.json](scripts/health.ratchet.json) 与 `practice:check` |
| Effect 不稳定 API 门面隔离 | 扫描非门面目录对 `effect` 不稳定导出的直接引用 | 无需模型介入 | `vibevalley/unstable-effect-door` lint 规则 |
| 本机 PGlite 升级资产回灌 | 校验每张表在 SQL 中标注 `@tier durable` 或 `@tier rebuildable` | 无需模型介入 | `schema.test.ts` + 启动旁路回灌测试 |

### 1. StyleX 语义重命名流水线与迁移脚本退场

1. 复用 [comment-review.ts](scripts/comment-review.ts) 的 `parseSync` + `deepseek-flash` JSON 批处理骨架编写一次性语义重命名脚本：扫描匹配 `/^(recipeStyles|variantStyles|viewStyles)\d*$/u` 的 `stylex.create` 声明，收集每个键的样式属性及 `stylex.attrs` / `styleProps` 处的条件表达式。
2. 将每批 20 个样式条目送入模型，仅接收形如 `{"renames":[{"from":"recipeStyles2.messageBodyDivVariant1Case2","to":"foldedBody"}]}` 的 JSON 输出；脚本校验目标标识符为合法 camelCase 且同文件不重名后，按 AST 偏移量合并零散样式表并替换引用。
3. 清空剩余 2,020 个旧类 token 并移除 Tailwind 依赖后，在 [oxlint-plugin.ts](scripts/oxlint-plugin.ts) 新增轻量规则拦截残余工具类名，随即删除 `scripts/style-migration*.ts` 全部阶段性脚本及根目录 `package.json` 中的 `#migration-inputs` / `./style-migration` 导出。

### 2. 扩展 `practice-audit.ts` 捕获手工回滚标志与共变字段包

1. 在 [practice-audit.ts](scripts/practice-audit.ts) 新增两条源码规则并纳入 [practice.ratchet.json](scripts/practice.ratchet.json)：
   - `manual-rollback-flags`：同一 `Effect.gen` 或 `async` 函数体声明至少 2 个 `let flag = false`，且在 `Effect.onExit`、`Effect.onError`、`catch` 或 `finally` 分支中读取这些标志决定清理动作时报错，`Fix:` 指向 `Effect.acquireRelease` 或 `Scope.fork` + 提交时转交。
   - `co-mutated-fields`：同一 `class` 或闭包工厂持有至少 3 个非 `readonly` 可变布尔或可空字段，且在至少 2 个方法中成组赋值时报错，`Fix:` 指向单一 `_tag` 判别联合。
2. 编写按需审查命令（仿 `comment-review.ts`），把 `co-mutated-fields` 命中的字段声明与写入语句切片交给模型判定：正交开关（如通话中的 `muted` 与 `phase`）标明独立维度依据；耦合状态输出判别联合拆分方案，指导重构（如将 [session.ts](apps/server/src/session/session.ts) 启动流程改为 `Scope` 资源链）。

### 3. 分型清理 `web: farm` 非空断言与服务端静默吞错

1. 用 `parseSync` 将 `apps/web/src/farm/` 下的 60 处 `TSNonNullExpression` 按语法父节点分三桶消除：
   - Solid `<Show when={x()}>` 子树内读取 `x()!`：直接改写为回调访问器 `<Show when={x()}>{(v) => … v() …}</Show>`。
   - 紧邻 `.has(k)` 或长度判断后的 `map.get(k)!` / `arr[i]!`：改为局部变量绑定加早退窄化。
   - PixiJS 挂载后才赋值的实例字段（如 `this.container!`）：合并为单一 `mounted?: { app; container }` 引用，入口处一次窄化。
2. 提取 `apps/server` 34 处 `swallow-without-record` 与 `apps/web/src/features/voice` 6 处 `swallowed` 的上下 15 行上下文，经模型批处理分入三档：
   - `cleanup`（幂等释放连接、删除临时目录）：统一替换为 [log.ts](apps/server/src/infra/log.ts) 的 `bestEffort` 或 `Effect.ignore({ log: "Warn" })`。
   - `expected-empty`（缺行、缺文件视为空结果）：收窄为 `Effect.catchTag` 或 `Effect.catchNoSuchElement`。
   - `bug-hiding`（吞掉真实业务或设备故障）：改走错误通道，前端经 [api.ts](apps/web/src/infra/api.ts) 的 `faultOf` 呈现。
3. 每完成一批清理，执行 `vp run health:write` 与 `vp run practice:write` 下调棘轮基线。

### 4. 建立服务端 `unstable-effect-door` 收敛 `apiStabilityLeak`

1. 导出 [effect-check.ts](scripts/effect-check.ts) 统计的 `apiStabilityLeak` 命中符号清单，将服务端、命令行与 `packages/provider` 依赖的 `effect/unstable/*` 能力收口至各自地基门面（如 `apps/server/src/infra/` 下对应模块），参照前端 `vibevalley/atom-door` 将 `effect/reactivity` 限制在 `apps/web/src/state/` 内的做法。
2. 在 [oxlint-plugin.ts](scripts/oxlint-plugin.ts) 新增 `vibevalley/unstable-effect-door`，禁止业务模块直接引用 `effect/unstable/*`，同步将 [effect.ratchet.json](scripts/effect.ratchet.json) 中非门面包的 `apiStabilityLeak` 压至零。

### 5. 基于 `setAsideStale` 的旁路旧库资产回灌（免增量迁移脚本）

保持 [0001_schema.up.sql](apps/server/db/migrations/0001_schema.up.sql) 作为唯一表结构真相源，不引入 `0002..00NN.sql` 历史迁移链，而是在本机 PGlite 重建时从旁路备份回灌核心资产：

1. **表级持久性分层**：在 [0001_schema.up.sql](apps/server/db/migrations/0001_schema.up.sql) 为每张表标注 `-- @tier durable`（`setting`、`user`、`agent`、`memory`、`repo`、`channel`、`issue`、`artifact`、`cron` 等用户资产）或 `-- @tier rebuildable`（运行态锁、临时队列与可重算投影），由 [schema.test.ts](apps/server/src/infra/schema.test.ts) 强制检查全覆盖。
2. **启动时只读回灌**：当 [db.ts](apps/server/src/infra/db.ts) 的 `setAsideStale(where, hash, now)` 将旧库移至 `aside` 并按新基线建好空库后，用只读临时 `PGlite` 打开 `aside`，按外键拓扑序读取 `@tier durable` 表的行，经容错 `Schema.decodeUnknownOption`（新增列补默认值、已删列忽略、损坏行记警告日志跳过）写入新库，并在启动后发送一条 `Core.notice` 告知用户已结转的记录数。外部 Postgres（`database.url`）在 [一个服务端管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md) 落地时单独定义显式版本演进。

## Alternatives considered

- **让大模型直接改写整份 `.tsx` / `.ts` 文件清理 StyleX 命名与吞错**：整文件重写易顺手改动无关业务逻辑、丢失注释或破坏响应式追踪边界，审查成本高。由 AST 锁定精确节点、模型仅返回键值映射或枚举分类、再由 AST 落盘，可将改动严格限制在目标语法节点内。
- **改为维护编号递增的 `0002_*.sql` 迁移文件链**：仓库仍在收敛概念与表结构（见 [收敛概念、契约表面与跨模块链路](.agents/notes/proposed/architecture/2026-11-10-converge-concepts-and-chains.md)），过早冻结增量 SQL 迁移会让每次改表名或拆合列背负历史包袱。利用现有的 `setAsideStale` 备份做 Schema 容错回灌，既保住单一基线 SQL 的演进速度，又避免本机升级清空用户资产。
- **在 CI 中每次提交实时调用大模型跑代码审查门禁**：网络抖动、模型非确定性与密钥依赖会破坏本地与 CI 检查的可重放性。模型判别脚本应与 [comment-review.ts](scripts/comment-review.ts) 一样作为本地按需收敛辅助工具；门禁侧只跑确定性的 AST 规则与单向棘轮。

## Acceptance criteria

- 剩余旧类 token 归零，机械样式名完成语义化重命名，`scripts/style-migration*.ts` 从仓库移除并由 `oxlint` 轻量规则接管。
- [practice-audit.ts](scripts/practice-audit.ts) 上线 `manual-rollback-flags` 与 `co-mutated-fields` 并附单元测试；`apps/server` 的 `swallow-without-record`（34 处）与 `web: farm` 的 `nonNull`（60 处）在各自棘轮文件中清零。
- [oxlint-plugin.ts](scripts/oxlint-plugin.ts) 上线 `vibevalley/unstable-effect-door`，业务目录不再直接导入 `effect/unstable/*`。
- [db.ts](apps/server/src/infra/db.ts) 在 `setAsideStale` 触发时自动从旧 PGlite 备份回灌 `@tier durable` 表并通过跨版本基线回灌测试。
- 将长期成立的门禁与数据库回灌机制沉淀进 [工程流程](docs/subsystems/process.md) 与 [地基](docs/subsystems/foundation.md)，删除本 Note 并运行 `vp run notes:catalog`。

## Risks

- **共变字段规则误报数据载体类**：纯数据形状或配置对象可能同时含多个可选字段。`co-mutated-fields` 应仅统计在方法体内发生二次赋值的可变字段，排除构造期一次性初始化的字段。
- **跨大版本改名导致旁路回灌漏读**：若某张 `@tier durable` 表或核心列直接改名而未登记别名，纯同名映射会漏掉旧列。在回灌解码器中允许为近期改名的表或列声明轻量读取别名映射，并在跨过一个正式版后清理。
