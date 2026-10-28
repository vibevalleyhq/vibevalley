# Agent Note: Task：一张按 DAG 推进的活，agent 自己的步骤和种植计划都是它

Status: proposed

## Problem

农场里有两张按先后推进的图，规则只共用了一半：

- **agent 自己的任务**（`packages/agent/src/agentTask.ts`，[VibeValley 自己的 agent](docs/subsystems/brain.md#自己带的东西)）：纯函数的图，状态 `waiting`、`working`、`done`、`failed`、`skipped`，帮手是执行者，存在表 `agent_task`。
- **种植计划**（`apps/server/src/task`，[种植计划](docs/subsystems/task.md)）：每件是一张子工单、一个帮工。图不单独存，每次由 `task/issues.ts` 的 `graphFrom` 从父子工单拼回 `TaskGraph`；调度、状态、重试和跳过写在 `task/task.ts` 和 `task/rules.ts`，和 agent 自己的任务各写一份。

两边共用的只有边的规则（`apps/server/src/base/dag.ts` 的 `dagProblems`、`dagLayers`、`dagIDValid`）。一件活什么时候能做、失败重来几次、叫停时在做的退回哪里，两处各写一遍，改一处另一处不跟。

## Proposal

图里的一件就是一个 Task；规则、推进和存储分开，执行者和存储可换：

- **规则**：`agentTask.ts` 的纯函数（加、改、ready、做完收起来）作为唯一的一份，搬到 agent 和种植计划都能用的位置（`apps/server/src/base`，和 `dag.ts` 并排）。
- **执行者**：agent 自己的任务交给帮手（现在的 `agentTaskTools.ts` 的 `makeTaskRunner`）；种植计划的一件交给一个帮工（开一张子工单、派一个档案）。
- **存储**：agent 的在表 `agent_task`；种植计划的是父子工单本身（`Issue.task`、`blockedBy`）。
- 种植计划的调度和状态改走同一份规则，去掉 `graphFrom` 这层拼回，和 `Session.graph` 这个标记（帮工挂在哪张子工单上，`parent` 就说明了它属于哪张图）。

## Alternatives considered

**两张图各走各的。** 规则重复，一处修了重试或叫停，另一处不跟。

**种植计划也存进 `agent_task`。** 子工单已经是主人在看板上看到、能评论、能换人的东西；再存一份图，两份会对不上。

## Acceptance criteria

- 一件活「能不能做」「失败重来几次」「叫停后退回哪里」只在一处定义，agent 自己的任务和种植计划的测试都经过它。
- `graphFrom` 和 `Session.graph` 不在了；种植计划的面板、`graph.*` 接口和管家的 `graph_*` 工具行为不变（`task/task.test.ts`、`task/lifecycle.test.ts`、黄金数据）。

## Risks

- 种植计划的状态比 agent 自己的任务多（`GraphState` 的 `splitting`、`draft`、`paused`、`ready`）：只合并「一件」的规则，图的状态留在 `task`。
