# Agent Note: 白皮书里还没做的：骨架、重复 lint、流切片、常驻集合和体检，各在什么时候做

Status: proposed

## Problem

《五层抗熵金字塔体系》白皮书中可立即落地的门禁（处方式报错、knip 死代码门禁、逃生口棘轮、回归测试保护、生成的 [primitives.md](docs/reference/primitives.md)、确定性 I/O 次数计数）已上线。剩余几项治理措施当前直接铺开收益低于维护成本，需明确各自的触发条件。

## Proposal

| 治理项 | 做法与收益 | 触发时机 |
|---|---|---|
| 扩展点高阶骨架 | 将超时、重试和清理收进高阶函数，适配器只写纯数据映射 | 与 [工具集和技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md) 一起先做 `tool/`；连接器 adapter 超时在出现故障时收拢 |
| 原样重复代码 lint | 将 `jscpd` 15 行以上克隆块接入体检报告，配合 `primitives.md` 消除复制粘贴 | 与 [仓库体检读数](.agents/notes/proposed/process/2026-10-29-repo-health-readings.md) 第二阶段一起实施 |
| 流分片与状态机属性测试 | 按任意字节切片压测流解析器，在随机事实序列上断言 `reduce` 全局不变量 | 出现首个流分片解析回归或核心状态非法组合回归时 |
| 常驻集合上限清点 | 逐处清点服务端常驻 `Map` / `Set` 的淘汰策略并评估 lint 规则 | 服务端出现首个内存随运行时间持续增长问题时 |
| `refactor/` 禁改契约与按接口重生成 | 重构分支禁止修改 `packages/protocol`，热点模块按只读契约与测试从零重写 | 协议契约进入稳定期且模块测试完全收敛至服务接口后；届时体检加「模块的测试只经接口的比例」，一个模块在热点前列、30 天里被多个 `fix/` PR 修过、测试只经接口时，派重写而不是修补 |
| 契约 diff 与审查压缩比进 CI 摘要 | PR 的 CI 摘要最前列出 `packages/protocol`、`db/`、服务接口的 diff，并算总改动行 ÷ 契约行（2026-10-30 回放 `main` 最近 100 个 PR 约 22:1） | 用户开始只读契约 diff 就合 PR 时 |
| 合并队列 | 开 GitHub 自带的 merge queue，在和最新 `main` 组合后的提交上重跑全部检查；不做符号级的锁 | 并行的 agent 多到 PR 常在合并后互相打破 `main` 时；改仓库设置，由用户定 |
| 多布尔字段的形状 | 两个以上布尔字段的形状进体检的报告，作为「没写出来的状态」的候选 | 与 [仓库体检读数](.agents/notes/proposed/process/2026-10-29-repo-health-readings.md) 第二阶段一起实施 |
| 静态防线自愈率 | 从帮工的轨迹（`session/journal.ts`）算 agent 看了检查的报错一次改对的比例，低的规则重写报错 | 帮工的轨迹能稳定区分「检查报错」和「下一次改动」时 |
| PR 评审打分与合并门槛 | 换一个模型按清单审 PR、打分，低于门槛不合 | 有了评审提案并进仓库时；注释初审（`scripts/audit/comment-review.ts`）只报不挡，不进 CI |

## Alternatives considered

- **照搬白皮书外部工具链（ast-grep、dependency-cruiser、bun）**：与本仓的 `vp`、oxlint 插件和 `apps/server/src/modules.ts` 的 11 个有序模块重复；复用 oxlint 与 oxc AST 即可。
- **对文件行数、函数行数或 3:1 重构比例设硬门槛**：会诱导机械切文件凑数；改由体检热点与逃生口棘轮指导重构。

## Acceptance criteria

- 表中每项在达到触发条件并实施后沉淀进 [地基](docs/subsystems/foundation.md) 或 [工程流程](docs/subsystems/process.md)，全部移空后删除本 Note。

## Risks

- 按事件触发的条目需在修复同类回归时对照本表兑现，避免只修单点而不补机制。
