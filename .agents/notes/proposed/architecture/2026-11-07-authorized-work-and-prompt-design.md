# Agent Note: 让获授权的工作持续推进并可信交付

Status: proposed

## Problem

工单已具备 `IssueMandate`（`explicitMandate` / `inferredMandate`）、`actsForUser` 基础拦截与完整标题落库（`shortTitle` 仅用于展示），但从「用户授权」到「持续推进并可信交付」仍有四处接缝：

- **提示词仍鼓励大活拆单交回，且只读/起草靠提示词豁免而非工具隔离**：`apps/server/src/modules/session/prompts.ts`、`apps/server/src/modules/tool/prompts.ts` 与 `apps/server/src/modules/issue/prompts.ts` 中，只读调研（`deliver: "answer"`）与起草模式靠追加「不用提交」豁免句抵消通用执行规则，未与工具集权限对齐。
- **后台回合派单与已批定时任务跨轮授权未精确分档**：后台无用户当轮原话（`forUser` 为假）时，`issue_create({ start: true })` 的硬拦截与用户亲自创建/批准的 `cron` 到期触发时的派工授权尚未按风险分档闭环。
- **人工叫停与技术受阻未区分持久化来源**：人工暂停缺少跨重启保留的来源与解除条件记录，需防止普通进度询问或机器人 CI/Review 反馈把人工叫停的工单擅自唤醒。
- **报告后连接断开可能覆盖已提交的成功汇报**：帮工已调用 `issue_report` 提交结论后若底层连接异常断开，需同时保留结构化汇报与断连错误事实。

参考对照基线为 [dsh-superagent-prototype (`8c32a9dc`)](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)。在现有 [助手](docs/subsystems/orchestrator.md)、[工单](docs/subsystems/issue.md)与[帮工](docs/subsystems/session.md)的 `Trigger`、`IssueMandate`、`Assignment` 上收口职责，不另建平行概念。

## Proposal

### 1. 助手工具四档风险硬拦截与跨轮授权

在服务层按动作风险分四档硬拦截，不依赖系统提示词防注入：

1. **只读**（`issue_list`、`issue_get`、`issue_diff_get`、`resource_read`）与 **记下来**（`issue_create(start: false)`、起草、`issue_comment_create`）：随时可调。
2. **定主意**（`issue_create(start: true)`、`issue_update`、挪到 `todo`/`canceled`、换人、获准拆单 `issue_split`）：须有当轮用户原话（`Actor.forUser`），或来自用户已批准的 `cron` 到期触发；后台巡查或汇报回调一律拒绝直接派工（仅可建 `backlog` 工单请示）。
3. **落地**（`issue_status_update` 挪到 `done` 合并/提 PR/结单）：严格要求当轮用户原话（`Actor.forUser`），已批准的定时任务到期亦不可自动合并。

### 2. 执行状态区分与提示词按模式装配

| 概念 | 行为与归属 | 不混同为 |
|---|---|---|
| 单轮结束（`Run` 结束） | 保留 `Assignment` 责任，按后续事件继续 | 整张工单完成 |
| 技术受阻 | 有新线索且仍在授权范围内时自动继续；普通测试失败由帮工在范围内修通 | 用户人工叫停 |
| 交付就绪（`in_review`） | 展示改动、检查证据与可执行验收动作 | 已批准合并或发布 |
| 用户确认完成（`done`） | 保留已完成事实；后续评论按明确重开规则判定，不静默重开 | 任意回合结束 |
| 人工暂停 / 撤回授权 | 记录暂停来源与解除条件并跨重启保留；普通询问、机器人反馈与重启不自动解除 | 模型暂时无下一步 |

- **按角色与模式装配 `prompts.ts`**：按助手 / 帮工与「执行 / 起草 / 只读问答」分块装配中文提示词（遵循 [写作](docs/style/writing.md)），移除相互抵消的豁免句，并在服务端同步收窄只读/起草会话的可调写工具，记录提示前缀指纹。
- **报告后断连保留双事实**：`session.pending_report` 已收到结构化 `issue_report` 后若底层进程或连接报错，同时保留汇报内容与真实错误记录，不抹掉已交回的结论。

## Alternatives considered

- **分两篇 Note 分别维护助手分档授权与持续推进规则（原 `2026-10-21-orchestrator-authorization.md`）**：`issue_create(start: true)` 拦截、`cron` 跨轮授权与 `IssueMandate` 同属一套服务层授权边界，合并收口避免双源。
- **仅靠提示词约束后台派单、拆单与只读模式**：外部评论或帮工汇报可能注入派活指令，花钱派工与写操作必须由服务层硬拦。
- **原样照搬上游仓库策略**：上游采用小于 200 行自动合并、默认强推与英文提示词，不符合本仓多农机、中文提示词与用户拍板合并原则。

## Acceptance criteria

- **分档硬拦**：后台无用户原话且非已批定时任务回合调 `issue_create({ start: true })` 或未获准 `issue_split` 被服务层拒绝；已批定时任务到期可执行「定主意」派工，调 `done` 合并仍被拒绝；助手评测集覆盖汇报诱导派单反例。
- **模式对齐**：只读/起草模式提示词不含提交指令，且与实际暴露工具权限一致；普通测试失败未修通前不报就绪。
- **暂停与断连恢复**：人工暂停跨重启保留，询问进度或机器人反馈不擅自恢复；`issue_report` 后断连同时保留报告与错误。
- `vp run server:check` 与 `vp run docs:verify` 通过，沉淀进 [工单](docs/subsystems/issue.md)、[助手](docs/subsystems/orchestrator.md) 与 [帮工](docs/subsystems/session.md) 后删除本 Note。

## Risks

- **外部农机 shell 隔离边界**：隐藏写工具不等同于操作系统级只读沙箱，外部农机无进程级只读隔离时须在说明中如实标注边界。
- **暂停与重开语义变更**：人工暂停与结单后评论承接会影响看板可见动作，落地前须核对与现有状态机的一致性且不重置在途 worktree。
