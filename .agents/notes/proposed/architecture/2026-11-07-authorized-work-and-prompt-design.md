# Agent Note: 让获授权的工作持续推进并可信交付

Status: proposed

## Problem

用户授权后，帮工应在范围内自主完成调查、实现、验证与交付，仅把需用户拍板的决定交回。当前代码仍有三处破坏连续推进的接缝：
- **提示词鼓励递归拆单交回**：`apps/server/src/modules/session/prompts.ts` 与 `apps/server/src/modules/tool/prompts.ts` 引导帮工把较大工作拆成 3–6 张子工单立即派发并结束本轮，子工单也读到同一规则。
- **长标题在冒号处被静默截断**：`apps/server/src/modules/issue/brief.ts` 的 `shortTitle` 与 `apps/server/src/modules/issue/lifecycle.ts` 会将带冒号的长标题截成 `test(issue)` 等前缀存入正式标题，原句退入正文。
- **只读与起草靠提示词豁免而非权限收窄**：`apps/server/src/modules/issue/prompts.ts` 追加「不用提交」与通用执行规则相互抵消，且不等同于工具或文件写权限隔离。

参考对照基线为 [dsh-superagent-prototype (`8c32a9dc`)](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)。[助手](docs/subsystems/orchestrator.md)、[工单](docs/subsystems/issue.md)与[帮工的信箱](docs/subsystems/session.md#触发与投递)已有 `Trigger`、`IssueMandate`、`Assignment` 与结构化 `issue_report`，应在现有模块上对齐职责，不另建平行概念。

## Proposal

### 1. 状态与授权映射

区分五种常被混同的状态，避免一轮结束丢掉责任或误恢复人工叫停的工作：

| 概念 | 行为与归属 | 不混同为 |
|---|---|---|
| 单轮结束（`Run` 结束） | 保留 `Assignment` 责任，按后续事件继续 | 整张工单完成 |
| 技术受阻 | 有新线索且仍在授权范围内时自动继续 | 用户人工叫停 |
| 交付就绪（`in_review`） | 展示改动、检查证据与当前可执行验收动作 | 已批准合并或发布 |
| 用户确认完成（`done`） | 保留已完成事实；后续评论按明确重开规则判定 | 任意回合结束 |
| 人工暂停 / 撤回授权 | 记录来源与解除条件；普通询问、机器人反馈与重启不自动解除 | 模型暂时无下一步 |

### 2. 核心规则取舍（R01–R28 收敛）

与 [助手的授权](.agents/notes/proposed/feature/2026-10-21-orchestrator-authorization.md)、[工具集与技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md) 及 [同工单协作](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md) 保持边界正交：

| 领域 | 采用并落地的规则 | 不采用或暂缓的上游做法 |
|---|---|---|
| 原始要求与路由（R01–R02、R08、R26） | 保留 `Trigger` 原文与来源身份，助手路由不改写范围；起草建议经确认才成执行要求；外部订阅消息仅作上下文不增权限；工单标题完整保存或超长报错拒绝，仅在展示处截短 | 静默截断标题；凭外部评论自动扩权 |
| 范围内执行与拆单（R03–R04、R11–R12） | 文件多或普通测试失败不构成交回理由，帮工在范围内修通并按 `deliver` 完成验证；内部帮手可用，业务拆单（`issue_split`）须经授权且不向子单无限传递派发权；主会话靠事件跟进不轮询 | 无授权递归拆单；主动接活流水线（R13 暂缓） |
| 提问、汇报与恢复（R05–R07、R09–R10、R28） | 问题走结构化 `questions` 一事一问；排队不冒充已送达，同一结果不由帮工、助手、系统重复播报；补充评论优先交在场负责人；人工叫停跨重启保留；报告后连接失败同时保留成功报告与真实错误 | IM 硬限 100 词（R07）；对用户已关成 `done` 的工单静默自动重开 |
| 提示装配与发布边界（R14–R25、R27） | 按模块 `prompts.ts`、角色与模式装配中文提示词（遵循 [写作](docs/style/writing.md)），移除相互抵消的豁免句，记录提示前缀指纹与注入时机；发布走仓库门禁与校验过的 SHA，遵守机器人评审轮次上限与 UI 前后对比证据 | 小于 200 行自动合并（R19）、默认改写历史强推（R20）、见人提 PR 即自动关单（R21）、英文提示词（R25）、完整提示词编辑台（R16 暂缓） |

### 3. 实施次序

1. 修复 `shortTitle` 覆盖正式标题与未授权递归拆单限制，保留现有子工单、分支与未提交现场。
2. 按角色（助手 / 帮工）与模式（执行 / 起草 / 只读问答）重构 `prompts.ts` 装配，消除矛盾指令并对齐实际工具集校验。
3. 补齐评论承接、人工暂停来源记录、中断恢复与报告后断连保留两份事实的闭环，记录提示指纹并在获准后跑真模型评测，沉淀进 [工单](docs/subsystems/issue.md)、[助手](docs/subsystems/orchestrator.md) 与 [帮工](docs/subsystems/session.md) 后删除本 Note。

## Alternatives considered

- **只改标题截取与提示词字面**：拦不住未授权递归拆单、人工暂停被自动反馈误唤醒或报告被断连覆盖。
- **原样照搬上游仓库**：上游面向单仓库、DeepSeek Harness 与小于 200 行自动合并的团队默认策略，不符合本仓多农机与用户拍板合并原则。
- **新建独立提示词平台或第二套工单授权服务**：会与现有 `IssueMandate`、`Mailbox` 和各模块 `prompts.ts` 形成双源。

## Acceptance criteria

- **标题与来源（A01、A11）**：含冒号的长英文与中文标题完整保存（超限明确拒绝）；系统保留原始 `Trigger`，普通讨论与外部评论不误触发派活或扩权。
- **模式、拆分与持续执行（A02、A03、A07）**：只读/起草模式不混入提交指令且与工具权限一致；未获准拆单被服务端拒绝；普通测试失败由帮工自行修通，未过验证不报就绪。
- **承接、暂停与恢复（A04–A06、A08–A10）**：运行中补充交原负责人且不重复播报；人工暂停跨重启保留，询问进度或机器人反馈不擅自恢复；报告后断连同时保留报告与错误；未授权 `push`/合并被门禁拦截。
- `vp run server:check` 与 `vp run docs:verify` 通过，贯通流程在隔离服务端验证通过。

## Risks

- **外部农机 shell 隔离边界**：隐藏写工具不等同于操作系统的只读沙箱，外部农机无进程级只读隔离时须在说明中如实标注边界。
- **暂停与重开语义变更**：人工暂停与用户结单后的评论承接会影响可见行为，落地前须核对与现有看板动作的一致性，且不重置在途 worktree。
