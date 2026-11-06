# Agent Note: 给仓库做体检：跨区共改、模块深度与代码存活率读数

Status: proposed

## Problem

`packages/health` 目前已上线文件热点（改动次数 × 行数）与类型/错误逃生口棘轮（见 [工程流程](docs/subsystems/process.md)），但热点只回答「哪里常改且大」，还回答不了「为什么难改」：
- 两个模块没有显式依赖却总是一起改（隐性耦合）。
- 模块接口过浅或存在大量只转一手的函数（认知负担）。
- 热文件里某个高分支复杂度函数反复被修，或新写代码在 14 天内被大量重写（代码存活率低）。

## Proposal

在 `packages/health` 的 `readings.ts` 与 `report.ts` 中按复杂度的三种症状扩展只报不拦的筛查读数（逃生口仍是唯一 CI 棘轮）：

| 症状 | 新增读数 | 计算方式（基于 `collect.ts` 与 oxc AST） |
|---|---|---|
| 改动放大 | 跨区一起改 | 统计触及 ≤40 个文件的提交中跨区文件对的共现支持度（≥4）与置信度（≥60%），排除 `coChangeByDesign` |
| | 改动放大倍数 | 触及某区的提交平均同时触及的区数，与该区前一个时间窗口对比 |
| | 依赖朝不稳定方向（SDP） | 解析相对路径与 `@vibevalley/*` 建 import 图，计算各区不稳定度 `I = 扇出 / (扇入 + 扇出)`，报出从低 `I` 指向高 `I` 的边 |
| 认知负担 | 模块深度与只转一手函数 | 深度 = 实现行数 ÷ 接口大小（由 `interfaceOf` 配置）；识别函数体仅原样转发参数的导出函数（排除回调与 `thinByDesign`） |
| | 函数级热点 | 对前 10 热文件运行 `git blame`，按函数在窗口内的不同提交数 × oxc 分支数排序 |
| 未知的未知 | 隐性耦合 | 从「跨区一起改」文件对中减去 import 图上存在路径（含穿过纯重导出 `index.ts`）的文件对 |
| 反复返工 | 代码存活率 | 统计 14 天前的 PR 新增行在当前 HEAD `git blame` 中仍归属原提交的比例 |

1. **分步落地与回测**：先落地 import 图、跨区一起改与隐性耦合，再落地模块深度、只转一手与 blame 读数；最后用第 `t` 周读数回测第 `t+1` 周的低存活率与修复热点，删掉无预测力的读数。
2. **结构化输出**：`vp run health --json` 输出带症状分类与目标文件的 JSON，供管家直接按排第一的病灶开重构工单。

## Alternatives considered

- **对文件行数、函数行数或深度设 CI 硬门槛**：会诱导 agent 机械切碎文件或缩减接口凑数，读数变好看但代码未变简单。
- **引入 Martin 抽象度 `A` 与主序列距离 `D`**：TypeScript + Effect 代码以 `Context.Service` 与协议 Schema 表达契约，按 Java 抽象类比例统计失真，仅保留不稳定度 `I`。
- **引入 `dependency-cruiser` 或 `madge` 建图**：多一套外部依赖与别名配置；复用包内已有的 oxc `staticImports` 与 `package.json` `exports` 解析只需数十行。

## Acceptance criteria

- `vp run health` 按复杂度症状分节输出新增读数，且隐性耦合不误报经纯重导出 `index.ts` 相连的文件对。
- 每项新增读数在 `packages/health/src/readings.test.ts` 中有确定性单测覆盖。
- 完成历史窗口回测，保留有预测力的读数写进 [工程流程](docs/subsystems/process.md) 并删除本 Note。

## Risks

- Squash 合并的大功能 PR 单次触及上百个文件会污染共改统计，需过滤超过 40 个文件的提交并随历史增长校准支持度阈值。
