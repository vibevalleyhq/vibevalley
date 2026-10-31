# Agent Note: 模块边界：先减少无关事实触发的工单重算

Status: proposed

## Problem

本轮按主人指定的 `0e8bb950` 基线核查与收敛；`f527d936` 只用于核对原提案的出处，不将它新增的接口移植到本轮。验证结果见本篇的核查结论。

`projection/reduce.ts` 对所有有效变化调用 `withIssueStatuses`，即使变化只涉及聊天或花费。收益需要按工单数、会话数和事实分布测量。

## Proposal

本轮核查：`attentionOf` 读取 `phase.quietSince`，`quiet` 使工单进入 stuck，`doing` 重建 working phase 时清除 quietSince；两者均影响工单关注状态，原提案将它们排除的白名单会产生回归。

第一阶段只限制工单状态重算的触发范围：

1. 从状态、关注项、可用动作和细化会话的全部读取依赖推导重算条件。当前依赖工单与会话；优先比较不可变集合引用，保留所有会话变化的重算，不新增一份需要与 Fact 同步的白名单。
2. 保留现有 reducer 作为测试参考，对黄金轨迹与各类 Fact 比较完整结果，包括 `changed`、工单状态、关注项和动作。
3. 测代表性聊天、工具动作与生命周期混合负载的重算次数和耗时。

后续的引用解析和固定调用顺序收口归 [深模块](.agents/notes/proposed/architecture/2026-10-31-deep-module-consolidation.md)。常驻集合只有在明确创建、销毁和增长路径后才新增回收。启动恢复移到 Start 层前，应列出每个订阅者需要快照还是增量，避免把初始化事实重播成业务动作。

实施顺序见[治理范围](.agents/notes/proposed/process/2026-10-30-code-quality-ratchets-and-boundaries.md)。

## Alternatives considered

**按文件行数拆服务。** 不能证明减少耦合，可能只增加调用链。

**直接使用提案中的 Fact 白名单。** 旧白名单可能漏掉关注项与动作的间接依赖，需要重新推导并穷尽校验。

## Acceptance criteria

- 所有工单或会话集合变化都触发重算；新增 Fact 沿用不可变状态约定。
- 差分测试结果一致，相关状态变化仍立即反映到工单。
- 报告代表负载与重算次数；没有实测不声称降低固定百分比。

## Risks

只测黄金数据可能漏掉未录制的事实组合；应补依赖字段变化的定向测试。
