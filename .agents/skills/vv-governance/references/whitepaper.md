# 白皮书逐条对照

《AI 智能体时代的软件维护与工程治理白皮书：五层抗熵金字塔体系》（v3.0，外部文档，不进仓库）的要点在 VibeValley 的处境。入口和用法见 [SKILL.md](.agents/skills/vv-governance/SKILL.md)。白皮书是为通用的多人仓库写的，它举的路径（src/contracts、bun、ast-grep）不是这里的文件。

处境五种：**已有**（本来就这样）、**已做**（吸收白皮书时加的）、**改写**（思路留下，换成这里的做法）、**以后做**（触发条件在[提案](.agents/notes/proposed/process/2026-10-30-whitepaper-checks-that-say-how.md)）、**不做**（为什么写在表里）。

## 六种病

| 病 | 机理 | 处境 | 在哪 |
|---|---|---|---|
| 局部缝合 | 提炼要改没加载的文件，模型只在局部补，同一段控制流抄好几份 | 已有、以后做 | connector 的重试、退避、暂停在 `apps/server/src/gateway/connector/connector.ts`，各聊天软件实现 `adapter.ts` 的 `Adapter`；adapter 各写超时，收拢见提案「扩展点高阶骨架」 |
| 只加不删 | 不确定旧导出还有没有人用，只加新的 | 已有、已做 | 「内部不留兼容」（`AGENTS.md`）；`vp run deadcode`（`knip.ts`、`scripts/audit/deadcode.ts`），CI 零容忍 |
| 绕开约束 | 类型或测试挡路时 `as any`、空 `catch`、改断言 | 已有、已做 | `no-explicit-any`、`no-unsafe-*`；逃生口和吞掉的 `catch` 进 `health:verify` 的棘轮；`regression: ` 测试删改要点名（`scripts/release/regression.ts`）；帮工的验收先红、合入时冻结（[工单](docs/subsystems/issue.md#模型和不变量)） |
| 温室假设 | 默认内存无限、网络秒回，N+1、每个字重写一次盘 | 已有、已做、以后做 | 贵的东西归拥有它的模块；时间归 `Clock`（`@vibevalley/async`），测试传自己的时钟；`dbQueries`（`infra/db.ts`）与 `gitRuns`（`modules/repo/git.ts`）计数并断言 I/O 次数；流按任意切片测见提案 |
| 架构漂移和乱引依赖 | 每个 agent 失忆，按偏好引包、反向依赖 | 已有 | 版本只在 catalog（`scripts/audit/catalog.test.ts`）；方向由 `apps/server/src/modules.test.ts`、`vibevalley/page-layers`、`import/no-cycle`、各包的 `no-restricted-imports` 守住 |
| 认知赤字 | 人读不过来，最后看见 CI 绿就合 | 已有、以后做 | 一批工作一个 PR、正文写行为和证据（[vv-pr](.agents/skills/vv-pr/SKILL.md)）；[vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 的证据；回放（2026-10-30，最近 100 个 PR）：契约约占改动的 1/22，后来修掉的缺陷只有 1.5% 写在契约里，挡缺陷靠测试和验收；契约 diff 进 CI 摘要见提案 |

## 十条铁律

| 铁律 | 处境 | 在哪 |
|---|---|---|
| 1. 机器能拦的错不花 token | 已有 | `AGENTS.md` 四层手段的第 1、2 层；`vp check`、`practice:check`、`paths:check`、结构测试 |
| 2. 报错就是提示词 | 已做、改写 | 检查的话写错在哪、`Fix:`、`See`（`scripts/audit/oxlint-plugin.ts` 的 `says`，测试查 `See` 的文件在不在）；写文件不写行号 |
| 3. 公共控制流焊进高阶函数，AI 只填空 | 已有、以后做 | 帮工经 oar 驱动；核心状态只由 `Core.apply` 改；git 子进程超时杀整个进程组（`modules/repo/git.ts`）；骨架见提案 |
| 4. 契约和验收测试只读 | 改写 | 不锁目录，让改动被看见：`regression: ` 测试点名、生成的文件由 `docs:verify`、`server:check` 查 |
| 5. 功能和抽象拆成两张单，3:1 | 改写 | 重构自成提交，和同一批功能放一个 PR（[vv-pr](.agents/skills/vv-pr/SKILL.md) 第 1 节）；清哪里由 `vp run health` 和 `vp run deadcode` 定，不按比例 |
| 6. 跨 5 个以上文件写 codemod | 改写 | 做法写在 [SKILL.md](.agents/skills/vv-governance/SKILL.md#5-一次改很多文件)；漏改由 `vp check` 和 `scripts/docs/stale-names.ts` 兜底 |
| 7. 测确定的 I/O 次数，不测毫秒 | 已做 | `dbQueries`、`gitRuns` 的断言（[地基](docs/subsystems/foundation.md#测试金字塔)）；分层耗时预算只报不挡 |
| 8. 判别联合加穷尽检查，禁 `default` | 已有、改写 | `switch-exhaustiveness-check`；`default` 允许，要说明其余的有意不管；成员表用 `Record<X, …>` |
| 9. 需求不明先挂起提问 | 改写 | [SKILL.md](.agents/skills/vv-governance/SKILL.md#3-写计划前问清边界) 的四类边界；产品里帮工照工单的「先问清楚」问用户 |
| 10. 修 3 次就删光重生成，模块 300 行内 | 不做（现在） | 行数上限教 agent 切文件凑数；按接口重写的条件见提案 |

## 五层金字塔

| 要点 | 处境 | 在哪，或为什么不做 |
|---|---|---|
| 1.1 沙箱和命令防火墙 | 已有、不做 | 工单在仓库目录或自己的 worktree 干活；帮工没有权限确认是常驻规矩（[帮工](docs/subsystems/session.md#为什么这样)），依赖和配置的变化在 PR 的 diff 里 |
| 1.2 自举的双核隔离 | 已有 | [发布渠道](docs/subsystems/app.md#发布渠道)把干活的农场和正在改的代码分开；`scripts/release/verify-server.ts` 起隔离的服务端 |
| 1.3 联合类型和名义类型 | 已有、以后做 | id 带品牌（`packages/protocol`）；单位写进名字（`…Ms`，[命名](docs/style/naming.md)）；多布尔字段进体检见提案 |
| 1.4 处方式报错 | 已做、改写 | 单文件规则在 oxlint 插件，跨文件在 `scripts/audit/practice-audit.ts`、`service-paths.ts`，不加 ast-grep；子进程由 `vibevalley/child-process-door` 拦；常驻集合清点见提案；`@deprecated` 不做，旧的直接删 |
| 1.5 死代码断头台 | 已做 | `vp run deadcode` |
| 2.1 垂直特性切片 | 已有 | 服务端 `apps/server/src/modules/<概念>`（`modules.ts`、`modules.test.ts`）；页面 `features/<概念>` 经 `index.ts`；`scripts/audit/file-names.test.ts` 拦 `utils` 这类名字；契约在 `packages/protocol`，不另设 contracts/ |
| 2.2 高阶骨架 | 已有、以后做 | oar 起编码 agent；`connector.ts` 的 `Adapter`；骨架见提案 |
| 2.3 单一状态机和事件总线 | 已有 | `session/reaction.ts` 读成事实，`Core.apply` 用 `gateway/projection/reduce.ts` 折；游戏只读事件（[农场的皮](docs/subsystems/farm.md)）；下层经订阅往上报，投递与会话持久化由各深模块自管 |
| 2.4 三级上下文和原语词典 | 已有、已做、不做 | `CLAUDE.md` 只引 `AGENTS.md`；子目录的 `AGENTS.md` 和各包 README；[primitives.md](docs/reference/primitives.md) 从导出生成；不做 `@invariant`、`@primitive` 标记；重复代码 lint 见提案 |
| 3.1 三层只读契约墙 | 已有、改写 | 形状只在 `packages/protocol`（`Codec<T.X>` 对不上就编不过）；表结构只有 `0001_schema.up.sql`；`regression: ` 点名；`refactor/` 禁改契约见提案 |
| 3.2 内存假实现和属性测试 | 已有、以后做 | 假的只在端口上（oar 的 `scriptedRuntime`、照脚本回答的模型），git 和库用真的（[地基](docs/subsystems/foundation.md)）；`reduce` 的属性测试见提案 |
| 3.3 确定性混沌和启动对账 | 已有、以后做 | 开机接回帮工（`modules/runtime`），`src/flows` 覆盖重启；流按任意切片测见提案 |
| 3.4 历史存档的黄金快照 | 不做 | 内部不留兼容，旧库开机时挪开；对外 HTTP 的 v1 例外 |
| 3.5 故障胶囊和自愈飞轮 | 已有、以后做 | `session/journal.ts` 记轨迹，错轮可录成助手评测样例（`orchestrator.eval.create`）；`regression: ` 测试受门禁保护 |
| 4.1 3+1 播种除草 | 改写 | 同铁律 5；jscpd 和跨区一起改进 [体检](.agents/notes/proposed/process/2026-10-29-repo-health-readings.md) |
| 4.2 代数归约的重构指令 | 改写 | [SKILL.md](.agents/skills/vv-governance/SKILL.md#4-做一张纯重构的单)：行数不设门槛，没变少或变简单就不合 |
| 4.3 跨文件重构用 codemod | 改写 | 同铁律 6；脚本出错就把碰过的文件从 `origin/main` 恢复重来 |
| 4.4 合并队列和符号锁 | 已有、以后做、不做 | `main` 只经 PR、squash、CI 全过；merge queue 见提案；不做符号锁 |
| 5.1 需求歧义挂起 | 改写 | 同铁律 9；存量数据的答案固定是不兼容 |
| 5.2 重生成优于打补丁 | 不做（现在） | 同铁律 10 |
| 5.3 三级模型成本路由 | 已有、以后做 | 检查都确定、带缓存；注释初审用另一个模型（`scripts/audit/comment-review.ts`），只报不挡；PR 评审打分见提案 |
| 5.4 盲降演练 | 不做 | 只有一位用户；子系统文档的「为什么这样」和[概念](docs/concepts.md)是日常版本 |

## 北极星指标

| 指标 | 处境 | 为什么 |
|---|---|---|
| 功能代码膨胀比 | 不做 | 分母能刷 |
| 修改爆炸半径 | 以后做 | 体检的「改动放大」，和自己的过去比，不设固定阈值 |
| 静态防线自愈率 | 以后做 | 见提案 |
| 认知审查压缩比 | 以后做 | 回放约 22:1；见提案 |

白皮书的 30、60、90 天路线和附录（根级宪章、合并前 8 项自检）是上面各条的组合，处境同上；行数和复杂度上限、存档快照不做。
