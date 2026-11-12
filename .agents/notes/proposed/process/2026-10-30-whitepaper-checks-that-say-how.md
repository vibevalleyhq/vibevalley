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
| `refactor/` 禁改契约与按接口重生成 | 重构分支禁止修改 `packages/protocol`，热点模块按只读契约与测试从零重写 | 协议契约进入稳定期且模块测试完全收敛至服务接口后 |

## Alternatives considered

- **照搬白皮书外部工具链（ast-grep、dependency-cruiser、bun）**：与本仓的 `vp`、oxlint 插件和 `apps/server/src/modules.ts` 的 11 个有序模块重复；复用 oxlint 与 oxc AST 即可。
- **对文件行数、函数行数或 3:1 重构比例设硬门槛**：会诱导机械切文件凑数；改由体检热点与逃生口棘轮指导重构。

## Acceptance criteria

- 表中每项在达到触发条件并实施后沉淀进 [地基](docs/subsystems/foundation.md) 或 [工程流程](docs/subsystems/process.md)，全部移空后删除本 Note。

## Risks

- 按事件触发的条目需在修复同类回归时对照本表兑现，避免只修单点而不补机制。
