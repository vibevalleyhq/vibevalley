# Agent Note: 管家的授权：按动作分档，跨轮的同意记下来

Status: proposed

## Problem

管家工具目前依赖当轮 `Actor.forOwner`（`apps/server/src/base/actor.ts` 的 `actsForOwner`）拦截工单修改、状态流转与未授权周期任务（[管家](docs/subsystems/orchestrator.md)），但仍有两处边界缺口：
- **`issue_create(start: true)` 未受 `forOwner` 拦截**：在没有用户当轮原话的后台回合中，管家虽然不能调 `issue_status_update` 启动已有工单，却仍能通过 `issue_create({ start: true })` 直接新建并派出帮工，仅靠提示词防止帮工汇报注入指令。
- **已批准定时任务到期时无跨轮授权标记**：用户亲自创建或点击「同意」放行的定时任务到期触发管家回合时，当轮输入来源为 `cron`（`forOwner` 为假），导致管家无法执行用户已在定时任务里授权过的派活或改单动作。

## Proposal

将管家工具按风险分为四档，在服务层对「定主意」与「落地」两档实施区分校验：

| 分档 | 覆盖工具动作 | 授权规则 |
|---|---|---|
| 1. 只读 | `issue_list`、`issue_get`、`issue_diff_get`、`resource_read` | 随时可调 |
| 2. 记下来 | `issue_create`（`start: false`）、起草 `draft: true`、带话 `issue_comment_create` | 随时可调（只记备选或传话，不花钱派新会话、不改状态） |
| 3. 定主意 | `issue_create`（`start: true`）、`issue_update`、挪到 `todo`/`canceled`、换人 | 须有当轮用户原话（`forOwner`），或来自用户已批准的 `cron` 触发 |
| 4. 落地 | `issue_status_update` 挪到 `done`（合并、提 PR、留分支、结单） | 严格要求当轮用户明确原话（`forOwner`），定时任务到期亦不可自动合并 |

## Alternatives considered

- **仅靠系统提示词约束 `issue_create(start: true)`**：帮工汇报或外部文本可能包含「请再派一个帮工做 X」的提示注入，花钱派活必须由代码硬拦截。
- **定时任务到期也禁止「定主意」档动作**：会导致用户设定的「每天早上派帮工检查 X」到期后无法自动派工，失去定时任务意义。

## Acceptance criteria

- 后台回合（无用户原话且非已批定时任务）中管家调用 `issue_create({ start: true })` 被服务层拒绝，提示先记入 `backlog` 并请示用户。
- 用户创建或批准的定时任务到期触发管家时，管家可执行派工（第 3 档），但调用合并完成（第 4 档）仍被拒绝。
- 管家评测集新增「帮工汇报诱导再派新工单」反例并通过验证。

## Risks

- 收紧 `issue_create({ start: true })` 后，后台巡查发现的问题将先建为 `backlog` 工单请示用户，不会自动开工。
