# Agent DAG 能力归属：Gemini 判断与核验

用户指出 Task/DAG 原本意图是「专门给 agent 配置的能力」，要求重新判断是否被当成工单能力。Gemini 判断：能力归属与工单存储确实存在混淆，后续应以 Agent 为能力主体，而不能把父子工单存储当作领域前提。

模型：`opencode-go/gemini-4-argon`；会话：`ses_e69a3d682ffe5TybTA2VrL9uO1`。[完整原文](.agents/reviews/2026-11-01-agent-dag-ownership-argon.txt)。本次只分析，未据此回滚或新增产品代码。

## 当前有两套能力

| 能力 | 配置与执行归属 | 工单关系 |
|---|---|---|
| Agent 内部 DAG，代码称 Todo | BrainOptions 的 todos、maxSubagents、maxNudges；按 runtime/宿主装配，驱动自身或子 agent | 运行不要求每个节点是工单；runtime_todo 按会话 keeper 保存 |
| 服务端协作 DAG，代码称 TaskGraph / Task | Task 服务推进多会话、worktree、检查和合并；工具按当前身份开放 | 状态存父子 Issue；节点经 Issue.hire 派发，拆解入口要求已有工单 |

Agent 档案的[当前协议](packages/protocol/src/shapes.ts)没有独立的 DAG 能力配置。`BrainOptions` 的可选配置存在于代码装配层；[工具集提案](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)描述了档案级 toolsets，但不能当成已经实现。

## 归属与边界

- AgentProfile 决定能否使用 DAG、可用工具和执行策略；运行实例不存进档案本身。
- DAG 定义与运行实例拥有依赖、推进、并发及结果；不能因为借用 issue 表就把能力归给 Issue。
- Issue 承载需求、责任、验收和业务交付，可关联执行图及结果；看板上的子项呈现与 DAG 的执行归属应分别决定。
- Session 与 Executor 分别管持续执行上下文和底层资源。进程内子 agent 与带 worktree 的会话有不同的资源、重试及交付语义，不能仅因都用了 DAG 算法就强行合成同一个状态机。

## 对本轮修改的裁决边界

| 改动 | 当前判断 |
|---|---|
| Runtime 内部后门清理 | 保留，和 DAG 归属无关 |
| Task 测试改走真实服务与 git | 保留验证价值，不把测试里的父子工单存储断言升格为目标领域原则 |
| 删除 TaskWork 后直接调用 Issue.hire | 当前生产语义未改变，但这条依赖是否应该存在需要随能力归属重设计 |
| 去掉空视图占位、分开编辑输入与完整读图 | 可保留；读取数据源应与目标归属一起调整，不应永久绑定 Issue[] |
| 后续 Issue.start 收拢 | 暂不执行。另一轮 Gemini 已撤回机械合并建议：创建派工与挪已有工单状态的权限、排队原因答复不同 |

**校正模型原文的一处归因**：第 2 轮之前，TaskWork 的默认 `hire` 已绑定 `issues.hire`，见该轮基线 `/tmp/vv-six-r2-baseline/task.ts`。删除测试端口使默认依赖显式化，未新引入这一生产耦合。原文把它说成此次新增的方向错误，因果归属过强；真正需要重审的是既有领域模型。算法共用也不能单独证明两套执行引擎必须合一。

## 待定的重构范围

已向用户提出一个范围选择：统一为一个 Agent DAG 能力、保留两种执行方式，或先解耦协作 DAG 与工单、暂保留两套实现。两种方向都先保留现有看板呈现；不把模型原文中的「去子工单化」自动解释为删除用户界面中的子项。

六轮边界清理已单独执行；依赖该归属选择的较大 Task 迁移没有实施。当前没有把任一候选迁移方案当作已经批准的产品模型。
