# Agent Note: 助手给用户报告：早报、仓库健康度、工单之间的关系和分拣建议

Status: proposed

## Problem

助手目前已支持按等待时长查询待用户处理的工单（`issue_list` 的 `wantsUser`），但还缺四项汇报与分拣能力：确定性的仓库健康度规则、固定结构的每日早报、非阻塞的工单关联（`duplicate` / `related`），以及新 `backlog` 工单的分拣建议。

## Proposal

1. **纯函数仓库健康度（`packages/protocol/src/rules/health.ts`）**：按开着的工单与当日花费确定性算出三档健康度及原因工单列表，前后端与助手共用：
   - **顺利（`on_track`）**：无 `stuck` 工单，且等用户的工单均未超过 24 小时。
   - **有风险（`at_risk`）**：存在 `stuck` 工单、等用户超 24 小时的工单，或当日花费超预算 80%。
   - **卡住了（`off_track`）**：`stuck` 工单超过在办半数，或存在等用户超 72 小时的工单。
2. **三段式早报**：定时早报固定按「昨日完成交付 → 当前受阻与风险仓库 → 今日等用户拍板事项」汇报。
3. **非阻塞关联与分拣建议**：`Issue` 增加 `relations: { kind: "duplicate" | "related"; issue: IssueId }[]`（双向展示，不阻塞 `blockedBy` 调度）；助手对未分派工单提交优先级、仓库与档案建议，经用户点击接受后才写入字段。

## Alternatives considered

- **由大模型自由判断仓库健康度**：口径不一且无法与仓库页 UI 对齐。
- **照搬周期（Cycle）、估点与工单标签体系**：并发槽位、每日花费与 `stage.since` 已覆盖真实约束，档案 `tags` 与仓库已够筛选。

## Acceptance criteria

- 助手回答的仓库健康度及原因工单与工作台仓库页一致。
- `issue_link` 可标记 `duplicate` 或 `related` 且不影响调度；分拣建议在用户接受前不覆盖原字段。

## Risks

- 健康度时间与预算阈值需在实机使用后微调，统一收敛在 `rules/health.ts` 维护。
