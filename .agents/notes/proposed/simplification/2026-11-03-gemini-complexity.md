# Agent Note: Gemini 复杂度审查后的主线简化

Status: proposed

## Problem

Gemini 桌面端的[原始报告](.agents/reviews/2026-11-03-gemini-complexity-original.txt)列出 G01–G14。当前工作区包含上一轮已验收、尚未提交的网关收口；本轮保留其行为，逐项验证报告而非按风险标签照改。G14 的外层事务前提已被当前 Session.send 的调用顺序反证。

## Proposal

- 删除恒空 received、未使用 kinds 和死方法/SQL、wake 重导出；信箱契约从 base 归回 Mailbox。
- 泵专用方法从 Mailbox 公开接口收回；统一未读摘要查询与元数据解码，删除 payload 的重复上下文。
- 核对并统一即时与排队首轮输入登记，保留全部未消费输入和真正入模回执。
- 核对角色词与测试专用参数，有行为证据的再修改。
- G01/G02/G03/G08 的结构方案逐项裁决，不新增平行状态、绕过检查或删除必要恢复路径。
- 在[处理报告](.agents/reviews/2026-11-03-gemini-complexity-actions.md)记录每项的证据、裁决、修改与验证。

## Alternatives considered

不按“零风险”直接批量重构；不合并双层信箱或 Assignment、Session、Executor；不因行数目标机械拆文件。

## Acceptance criteria

- 每项有采纳、部分采纳或不采纳的结论和代码证据。
- 工单、聊天、PR、恢复行为不变，修复缺陷有 regression 用例。
- 最窄测试通过后运行 server:check、web:check、deadcode、health:verify、docs:verify 与隔离程序验收。

## Risks

首轮输入与投递的事务、事件先后可能造成重复消费；保留入模回执与失败回滚。持久 Trigger 的原文与来源身份不可变，重试不能用新载荷覆盖它。
