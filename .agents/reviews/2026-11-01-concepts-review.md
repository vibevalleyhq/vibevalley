# OpenCode：概念消除与命名审计

用户要求在[上次实现](.agents/reviews/2026-11-01-argon-execution.md)的基础上，让 OpenCode 分析哪些概念多余、哪些命名可以让代码更清楚。本轮只分析，不修改产品代码；不以凑齐 1/3 删行数作为裁决依据。

模型为 `opencode-go/gemini-4-argon`，会话 `ses_e69d7fcd7ffei46xqVUD5nDmzg`。[完整模型原文](.agents/reviews/2026-11-01-argon-concepts.txt)包含各项路径、机制、边界、反例和验收。

## Gemini 的候选清单

| 编号 | 候选 | 模型建议的方向 |
|---|---|---|
| E1 | TaskWork / TaskGit / TaskOptions 与 FakeWork / FakeGit | 让 Task 直接使用正式服务；测试从脚本农机、真实 git 或服务 Layer 接缝进入，删除平行执行框架 |
| E2 | Runtime 的 Object.assign 后门 | 删除 refreshUsage、cached、spent、setSpent 的未声明暴露；经公开接口、TestClock 和真实存盘验证 |
| E3 | graphView() / taskView() 的空值占位 | 把 Task / TaskGraph 的领域态与出帧展示字段分开，消除为了满足大类型而填空字符串、空数组的构造逻辑；保留 View 边界 |
| E4 | Issue.start 与 setStatus(todo) 的平行公开入口 | 研究统一开工入口与返回形状；保留内部调度能力 |
| E5 | openBrain / BrainHandle 的 Promise 镜像接口 | 收窄到 oar 适配器实际需要的方法，把 Promise 适配留在边界；不能仅搬文件来宣称删掉复杂度 |
| N1 | 英文界面的 ticket / manager / machine / plan 与代码用语 | 评估是否统一为 issue / orchestrator / runtime / task graph；这会改变英文用户文案，需单独决定，不属于严格的用户行为与表达不变项 |
| N2 | Task 内部 cron | 改为 advance 或 dispatchReady，明确它是依赖满足后的 DAG 推进，不是按时间触发的 Cron |
| N3 | stage.state 的 draft 与文档中的 refining | 先修正文档和代码不一致；区分「未派发阶段」与「正在起草」。是否改协议值另作决定 |
| N4 | Session.onIssue | 名字明确返回会话 ID、查询的是当前在场会话，与 Assignment 历史中的 latestSessionIdOf 区分 |
| N5 | 两处 bits.tsx | 根据内容确定领域名字或拆分；避免只把 bits 换成同样模糊的 Parts / Primitives |

## 读取建议时的限制

- 本表是 Gemini 的候选清单，不是已经决定的改动。E4 仍须核对 Actor 权限、创建即开工的错误与排队答复；E5 须保留 Scope、监听器释放、并发 close 等适配职责。
- Gemini 的 N4 原文把 `sessionOnIssue` 描述为排除 refining；[当前实现](apps/server/src/session/roster.ts)实际按 issue 匹配并取 hiredAt 最新者，没有该过滤条件。重命名不能顺手改变选择规则。
- 原文将 Schema/类型分离与客户端包体积直接绑定，不能据此断言类型推导必然增加运行时依赖；仓库当前保留双写的明确理由还包括命名、注释可读性和类型/键集合校验。本轮没有重开这条约定。
- 模型在同一会话的首答曾把 View 边界、Task 编辑审计和两种运行状态机当作可整体删除的重复；经补充约束后已在本次原文第一节撤回。首答的行数口径和估算不作为本报告结论。

## 保持的语义

Assignment 管责任，Session 管持续上下文，Executor 管运行资源；IssueStage 保留服务端统一计算的阶段与动作。展示文案不落入核心状态；Task 的人工编辑审计不能被运行时间线替代；进程内一次 loop 的多工单消费与回执不能直接套用外部帮工的一次 turn。

进入实施前，宜先核验 E1、E2、E3 和 N2：它们分别针对平行测试框架、内部状态暴露、空值占位和明确的同名异义。其余候选保留在原文中逐项选择。
