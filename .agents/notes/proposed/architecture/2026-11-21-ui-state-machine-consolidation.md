# Agent Note: 工作台剩余交互 FSM 与会话轨迹投影收口

Status: proposed

## Problem

工单与媒体/频道的核心领域投影（`BoardSummary`、`BoardIssueSummary`、`IssuePromptKind`、`MediaSummary`、`ChannelSummary`）以及关键单窗口状态机（`closeFlow.ts`、`draftSubmit.ts`、`libraryView.ts`）已收口（见 [核心状态](docs/subsystems/core.md) 与 [客户端](docs/subsystems/app.md)），工作台仍余两处隐式状态与前端聚合：

| 剩余位置 | 现网表现 |
|---|---|
| 看板覆层与拖拽（[IssuesPage.tsx](apps/mac/ui/features/issue/views/IssuesPage.tsx)、[Board.tsx](apps/mac/ui/features/issue/views/Board.tsx)） | `IssuesPage.tsx` 仍以独立的 `closing`、`reopening` 与路由参数拼装弹窗互斥；`Board.tsx` 仍以分散信号与异步 `measure()` 回调维护拖拽中状态。 |
| 会话轨迹瀑布与汇总（[runs.ts](apps/mac/ui/features/session/runs.ts)） | `waterfallOf` 与 `summaryOf`（轮次、步骤、模型/工具耗时、token 汇总与缓存命中率）仍在前端纯函数中计算，若多端复用会产生口径分叉。 |

## Proposal

1. **看板覆层与拖拽显式 FSM**：在 `apps/mac/ui/features/issue/model/` 将看板覆层收敛为互斥判别联合（`none | newDraft(at) | closing(target) | reopening(target)`），将拖拽收敛为显式阶段联合（`idle | measuring | dragging(ghost, over, before)`）并消除 `measure()` 过期回写，补齐毫秒级 `nsh/test` 纯单测。
2. **评估会话轨迹摘要下沉**：评估将 [runs.ts](apps/mac/ui/features/session/runs.ts) 中跨端复用的 `waterfallOf` 与 `summaryOf` 收拢至服务端或 `vibevalley-core`，前端只保留 240 步实时合并缓冲与折叠展示。

## Alternatives considered

**维持散落信号并用代码评审兜底**：异步 `measure()` 与多弹窗布尔组合仍可能引入覆盖或互斥漏检，用封闭判别联合配合 `switch-exhaustiveness-check` 在编译期消除非法组合成本更低。

**在前端继续独占轨迹汇总**：若后续移动端或 CLI 需要展示同口径耗时与缓存命中率，会迫使多端各自重算一遍。

## Acceptance criteria

- [IssuesPage.tsx](apps/mac/ui/features/issue/views/IssuesPage.tsx) 与 [Board.tsx](apps/mac/ui/features/issue/views/Board.tsx) 切换为显式覆层与拖拽判别联合，新增纯 FSM 单测在 < 100 毫秒内通过且 `vp run mac:check` 全绿。
- 明确 `waterfallOf` / `summaryOf` 是否下沉 Rust（若下沉则同步更新 `crates/protocol` 与工作台消费方并删去前端重复计算）。
- 全部完成后将结论沉淀进 [客户端](docs/subsystems/app.md) 与 [核心状态](docs/subsystems/core.md) 并删除本 Note。

## Risks

- 拖拽阶段联合重构期间若未保留原有 `testID` 与键盘/指针行为，可能破坏 `interactions.test.tsx`；切换时同步跑通全部交互测试与截图检查。
