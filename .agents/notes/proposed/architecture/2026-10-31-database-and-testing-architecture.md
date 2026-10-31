# Agent Note: 数据库与测试：验证事务、回收隔离与查询成本

Status: proposed

## Problem

本轮按主人指定的 `0e8bb950` 基线核查与收敛；`f527d936` 只用于核对原提案的出处，不将它新增的接口移植到本轮。验证结果见本篇的核查结论。

## Proposal

### 候选与证据

| 项目 | 核查结论 | 下一步 |
|---|---|---|
| `Db.run/attempt` 覆盖事务 | 原根因不成立：本地 Effect 4.0.5 `SqlClient.makeWithTransaction` 用独立 `transactionService` 保存连接与深度；提供 `SqlClient` 不等于覆盖该服务 | 补外层回滚、内层 savepoint 回滚后外层继续、提交失败的行为测试，再判断是否改 Db |
| DB 与 Core 发布顺序 | 需要逐条查业务事务、锁和中断窗口 | 选择一个可复现的写入失败或乱序场景；设计归 [提交后副作用](.agents/notes/proposed/architecture/2026-10-22-commit-then-effects.md) |
| 任务图历史 | `Task.record` 明确 best-effort：记录失败不阻止任务推进 | 保留现有语义；改成强一致应单独提出行为变化 |
| 内存库首次初始化 | baseline Promise 在异步初始化完成后赋值，存在重复初始化候选 | 并发首次取库测迁移次数；先解决单次初始化所有权 |
| 池归还隔离 | 当前依赖 DDL 标记决定丢弃 | 覆盖异常事务、会话设置、清理失败；失败实例关闭，不回池 |
| 外键索引 | 依据实际过滤条件、级联操作和数据规模判断 | 用目录查询核对索引，针对代表查询测计划；不要求空库禁止顺序扫描 |
| JSON 列 | 逐列区分缺省、损坏和有效空值 | 对关键持久化列绑定读写 codec，损坏应可诊断 |
| 时钟与轮询 | 真 I/O 与业务计时应分别验证 | 先迁一个只依赖业务计时的测试；等待状态优先订阅，兜底轮询按实测调整 |
| 追加表保留期 | 删除会改变历史与重试语义 | 先界定去重、审计和恢复所需窗口，再定清理策略 |

实施顺序见[治理范围](.agents/notes/proposed/process/2026-10-30-code-quality-ratchets-and-boundaries.md)。

## 本轮验证

基线 `0e8bb950` 的池归还确实遗留会话设置：连续取还同一个内存库的测试中，第二次读到前次设置的 `application_name = left-behind`。在检查 DDL 标记后执行 `RESET ALL`，同一测试通过；清空表、重置 identity、结构污染实例销毁的断言均保留。只增加现有清理批次的一条命令，不引入新池或新服务。

初始化重复和异常归还在后续独立探针中复现并修复；结论与各自证据见下表，不由会话设置测试代替。

## 核查结论

| 候选 | 最终处置与证据 |
|---|---|
| 事务上下文覆盖 | 不改 Db 包装。独立 PGlite 探针验证嵌套部分回滚、外层继续提交、整体回滚与延迟唯一约束在 COMMIT 失败后的回滚；事务服务身份与 SqlClient 身份独立 |
| DB/Core 发布 | 不新增通用事务服务。Chat 保存失败回滚测试、Task 的 pause/resume/abandon/retry/skip/edit 保存失败测试已有；本轮修复 Cron 的提示写入阻断已提交派发及后续 tick |
| 历史 | 保留 Task.record 的 best-effort，不让历史写入故障改变任务推进 |
| 冷初始化 | 首次快照生成由 Semaphore 串行化；快照已有后直接建库。两个独立农场的探针由迁移两次降为一次 |
| 池回收 | DDL 标记先检查；正常库重置会话设置。清理失败时关闭该实例，不再归还。连续取还测试覆盖设置污染、失败事务和之后的可用性 |
| 外键索引 | pg_catalog 找到 11 个没有首列索引的外键，不等于 11 个全表扫描。10,000 行 delivery 的实际 WaitingOn 谓词使用 channel_delivery_open 的 Index Only Scan，执行 0.323ms；实验新增索引为 0.026ms。当前负载没有足以承担额外写索引和基线变更的证据，本轮不批量加索引 |
| JSON 列 | Issue/Session/Chat 已用 Schema 和显式缺省；Artifact 块/批次严格解码。execution.test、task.test、connector.test 已覆盖损坏值；未发现合法写入口产生损坏 JSON，不统一改成启动失败 |
| 测试时钟 | 保留真实 I/O 与业务时钟分界；Session stall、Journal 保存、Cron tick 已有确定性验证。不按 it.live 数量迁移测试 |
| 等待 | 修复 whenState 竞争获胜后残留超时：Effect.callback finalizer 清理定时器；真实 Core 测试验证成功后 timer 数为零。1ms 轮询是串行谓词，未测得数据库压力，不统一改退避 |
| 保留期 | 不加统一 TTL。connector 外部 ID、发送键、artifact 批次记录承担跨重启去重/幂等；connector.test 验证超过 301 条及重启后仍引用旧线程。轨迹文件已有 trajectoryDays，run 行承担历史 |

探针和原始输出：`/tmp/vv-db-concurrency.mts`、`/tmp/vv-tx-probe.mts`、`/tmp/vv-index-audit.json`、`/tmp/vv-index-bench.json`。索引测量是隔离库的合成负载，不推算整个应用的耗时。

## Alternatives considered

**直接加入 `activeSql` 修复。** 未证实原实现破坏事务，新增上下文选择会增加行为分支。

**归还时先 `DISCARD ALL/RESET ALL`。** 可能清掉用于识别 DDL 污染的会话标记；应先保留污染判定，不能按固定 SQL 清单重置。

**全量 EXPLAIN 禁止顺序扫描。** 查询参数、数据分布和表规模决定计划，空库计划不能代表生产成本。

## Acceptance criteria

- 事务测试验证写入结果，而非匹配源码写法。
- 归还隔离测试证明后续使用者拿不到前一实例的数据、设置或结构污染。
- 每个索引或轮询改动附代表负载的前后测量，不承诺固定毫秒值。

## Risks

提交成功后发布 Core 仍有中断与乱序窗口；事务外发布应同时说明锁范围、中断语义及重启恢复，不能宣称一个通用帮手带来跨存储原子性。
