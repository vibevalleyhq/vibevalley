# Agent Note: 助手的授权：按动作分档，跨轮的同意记下来

Status: proposed

## Problem

助手工具依赖当轮 `Actor.forUser`（`apps/server/src/base/actor.ts` 的 `actsForUser`）拦截工单修改、状态流转与未授权周期任务（[助手](docs/subsystems/orchestrator.md)），仍有两处缺口：
- **后台回合可调 `issue_create(start: true)` 直接派工**：无用户当轮原话时，助手虽不能调 `issue_status_update` 启动工单，却仍能新建并直接派出帮工。
- **已批准定时任务到期无跨轮授权**：用户亲自创建或批准的 `cron` 到期触发助手时，`forUser` 为假，导致无法执行已获准的派工或改单动作。

## Proposal

按风险将助手工具分为四档并在服务层硬拦截：
1. **只读**（`issue_list`、`issue_get`、`issue_diff_get`、`resource_read`）与 **记下来**（`issue_create(start: false)`、起草、`issue_comment_create`）：随时可调。
2. **定主意**（`issue_create(start: true)`、`issue_update`、挪到 `todo`/`canceled`、换人）：须有当轮用户原话（`forUser`），或来自用户已批准的 `cron` 触发。
3. **落地**（`issue_status_update` 挪到 `done` 合并/提 PR/结单）：严格要求当轮用户原话（`forUser`），定时任务到期亦不可自动合并。

## Alternatives considered

- **仅靠系统提示词约束 `issue_create(start: true)`**：帮工汇报或外部文本可能注入「再派一个帮工」指令，花钱派活必须由代码硬拦。
- **定时任务到期也禁止「定主意」档**：会使「每天早上派帮工检查 X」到期后无法自动派工。

## Acceptance criteria

- 后台无用户原话且非已批定时任务回合调 `issue_create({ start: true })` 被服务层拒绝；助手评测集覆盖汇报诱导派单反例。
- 已批定时任务到期可执行第 3 档派工，调第 4 档合并完成仍被拒绝。

## Risks

- 收紧后，后台巡查发现的问题一律先建为 `backlog` 工单请示用户，不再直接开工。
