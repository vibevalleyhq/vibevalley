# Agent Note: 让获授权的工作持续推进并可信交付

Status: proposed

## Problem

工单的标题、提示词和工具应服务于同一件事：用户授权后，帮工在范围内完成工作，系统接住补充、恢复和交付，用户不必反复派发、转述或催促。

代码中存在破坏这条工作流程的接缝：

- `apps/server/src/session/prompts.ts` 鼓励帮工把较大的工作拆成子工单，然后结束本轮；`apps/server/src/tool/prompts.ts` 建议拆成三到六张并立即派发。子工单也读到这套规则。
- `apps/server/src/issue/brief.ts` 用 `shortTitle` 提取标题，`apps/server/src/issue/lifecycle.ts` 将结果存为正式标题。长标题可在冒号处被截成 `test(issue)`，完整内容退入说明。
- `apps/server/src/issue/prompts.ts` 给只读和起草模式追加「不用提交」的例外，抵消通用执行规则。文字豁免不等于工具或文件权限收窄。

[助手](docs/subsystems/orchestrator.md)、[工单](docs/subsystems/issue.md)和[信箱](docs/subsystems/mailbox.md)已经有来源记录、授权、指派、投递与结构化汇报。本提案不再创建一套同名概念，而是检查它们是否共同保证完整工作流程。

参考基线为 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)，固定提交 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`。本提案依据源码和文档比较，未运行上游或进行模型效果对比。上游声明它是研究原型；规则写在提示词中，不表示该规则都由程序保证。

## Proposal

### 道、术、器

**道决定术，术决定器。现有实现不应反过来成为设计正确的依据。**

| 层次 | 要回答的问题 | 本提案采用的标准 |
|---|---|---|
| 道：目的 | 为什么需要这套系统？ | 用户以更少的协调负担获得可信结果，并保有决定权。任务数、消息数和工具调用数不作为成功指标。 |
| 术：方法 | 怎样持续达到目的？ | 保留原始要求，明确授权与责任；帮工完成范围内的交付；系统可靠投递、恢复和反馈，只把需要用户决定的事交给用户。 |
| 器：载体 | 由什么承载这些方法？ | 提示词负责语义判断；类型、工具权限、状态机和持久记录保证可判定的边界；界面展示同一份事实；测试证明工作流程。 |

采用上游规则时，应先说明它承担的职责，再决定本地实现。删除仍有用途的规则前，应指出接替该职责的机制。只有换了文字、目录或运行时，不算完成替代。

### 成套采用的机制

| 机制 | 上游配合方式 | 单独删改会破坏什么 | VibeValley 的承接点 |
|---|---|---|---|
| 原始要求与授权 | Trigger 保留原文，Mandate 记录授权依据，助手只补路由事实 | 标题或助手转述成为唯一依据，建议变成要求 | 工单来源、`IssueMandate`、`Actor` 和范围约束应贯穿创建、评论、改派、恢复；已确认变更与建议应可区分。 |
| 一条补充的承接责任 | 相关帮工先决定是否在范围内；仍有工单承接时，助手不再另建工作；交回后才重新路由 | 同一条补充被执行两次，或所有人都以为别人会执行 | 工单负责人、评论投递和转交应共享身份与回执；信息订阅不改变负责人。 |
| 范围内自主完成 | 帮工负责调查、实现和验证；普通测试失败不触发交回；实质阻碍才问人 | 递归拆单被禁止后，改成频繁报阻碍，用户仍承担调度 | 内部计划不自动变成业务工单；拆分提案、授权和派发应分开，原负责人应承担集成交付责任。 |
| 持续对话与恢复 | Ticket 与 Assignment、Session 分离；投递、读取和承接分开记；恢复前重验授权 | 一轮结束即丢责任，或恢复时误启用户已停止的工作 | 工单、指派与执行记录应区分运行结束、交付就绪、业务完成、暂停和授权撤回。 |
| 交付与注意力 | Report 保存证据，Attention 保存问题，Reply 按用途校验并返回来源 | 少说话变成隐藏问题；完整报告又被多个角色重复播报 | 结构化汇报、问题、频道和收件箱应指向同一结果；排队不等于送达，提交不等于可验收。 |
| 事件与资源 | 助手不阻塞等待；后台任务有完成事件、槽位和生命周期；待执行动作先持久保存 | 助手结束后无人跟进，或子进程留在后台却显示空闲 | 复用 Mailbox、Session 和 Executor；重启、测试仍运行、交接和投递失败都应有明确归属。 |
| 策略与追溯 | Policy 版本约束在途判断，提示词按部件装配并记录版本 | 文本热改后无法解释依据，或者记录了版本却不知何时生效 | 复用提示前缀指纹和运行轨迹，分别验证自有 Brain 与外部农机的注入时机。 |

上游允许多个 Ticket 订阅同一 Thread。VibeValley 不必复制这张关系表，但应保留「有明确承接者时不重复派发」的职责。上下文可流向多人，执行权限不随上下文传播。

### 先映射状态，再决定自动恢复

上游的 `Ticket ended` 不直接等于用户确认工单完成：交付就绪或 PR 结束可使 Ticket 结束，但授权仍可能有效；人的 stop 才撤回授权。后续消息可在重新校验后恢复工作。

| 含义 | 拟采用行为 | 不应混同 |
|---|---|---|
| 运行轮结束 | 保留工作责任，按后续事件继续 | 整张工单完成 |
| 技术受阻 | 有新线索且仍在授权范围内时可继续 | 用户要求停止 |
| 交付就绪 | 展示结果、证据与当前可执行的验收动作 | 已批准合并或发布 |
| 用户确认完成 | 保留已完成事实；后续评论按明确的重开规则判定 | 上游所有 ended 情况 |
| 人工暂停或撤回授权 | 保留来源与解除条件；普通询问、自动反馈和重启不解除 | 模型暂时没有下一步 |

实施前应确定这些含义与现有状态的映射，不应直接新增一套生命周期，也不应静默改变已完成、暂停或合并的授权规则。

### 上游采用与删改表

以下是拟议决策，不是已实施行为。「保留」指保留职责，不要求复制英文或工具名；「适配」应提供等价的本地机制；「暂缓」不应被提示词宣称为现有能力。R 编号用于追踪差异，不是新工单。

| 编号 | 上游规则与职责 | 拟议决策及替代 | 验收组 |
|---|---|---|---|
| R01 | shared、dispatch：原始请求不由路由者改写 | 保留原文与来源；助手不应扩大范围。 | A01 |
| R02 | dispatch：助手不添加实现方案或验收条件 | 区分普通路由与获授权起草；起草建议经确认后才成为执行要求。 | A01、A02 |
| R03 | scope：文件多、测试失败不构成交回理由 | 保留范围内持续执行；已有批准方案不因跨文件再次停工。 | A03 |
| R04 | work：代码默认交付 PR，除非任务另有要求 | 按 `deliver` 适配答案、分支、变更和 PR；保留执行者完成交付的责任。 | A03 |
| R05 | handoff：问题用结构化 Attention 表达 | 复用工单问题与来源关联；一项一个决定，解决后明确清除。 | A04 |
| R06 | replies：排队不证明投递成功 | 保留用途、来源与投递回执；同一结果不由帮工、助手和系统重复发送。 | A04 |
| R07 | replies：IM 一律不超过 100 词 | 不采用全场景数字限制；保留简短通知、完整证据和按需查阅的分工。 | A04 |
| R08 | subscriptions：订阅消息是上下文，不增加权限 | 保留来源身份与授权边界；机器人、引用和外部文档不应授予新权限。 | A01、A05 |
| R09 | subscriptions：人的补充可恢复 ended Ticket | 先按上一节映射结束原因与授权，再确定续跑入口；不直接删除连续协作能力，也不自动重开用户已完成的工单。 | A05、A06 |
| R10 | scope：人工叫停跨重启和执行者保留 | 保留暂停来源与解除条件；技术受阻不等于人工叫停。 | A06 |
| R11 | worker 工具允许内部 subagent，但没有业务拆单入口 | 保留受控内部协作；业务拆分应经过提案与授权，不向后代传播无限派发权。 | A07 |
| R12 | dispatch：空闲不等于完成；主 Session 不阻塞等待 | 使用事件和报告继续工作；保留用户明确要求的定时任务，不靠轮询冒充跟进。 | A03、A08 |
| R13 | admission：主动承接先 observe，再 auto | 本批暂不引入完整主动接活流水线；来源、范围、责任和恢复所需的授权事实不随之删去。 | A01、A07 |
| R14 | environment、policy：从真实配置生成环境与策略 | 适配多仓库、档案和农机；未配置就明确未配置，不注入凭据或虚构权限。 | A09 |
| R15 | prompts：每次模型请求读最新版本 | 保留可追溯和明确生效点；分别验证 Brain、Pi/oar，不承诺未实现的热更新。 | A09 |
| R16 | prompts：覆盖编辑、版本回退和默认升级差异 | 完整编辑台暂缓；命名分层、装配记录和版本来源作为基础要求保留。 | A09 |
| R17 | 来源 skills、cli：读全分页、附件与原始引用 | 按已配置来源加载；不借用其他账户，不把 GitHub 能力宣称成 GitLab 已支持。 | A01、A10 |
| R18 | worker：GitHub 操作统一使用 gh | 发布通路适配为 vv 的授权与检查后 SHA；只替换工具，不削弱完整交付责任。 | A10 |
| R19 | delivery：满足批准等条件且小于 200 行可自动合并 | 不采用这项团队默认授权；保留当前用户授权、仓库门禁和对应提交的批准要求。 | A10 |
| R20 | delivery：为评审者署名重写分支历史 | 不采用默认重写和 force-push 要求；署名遵守仓库约定，改历史应另有授权。 | A10 |
| R21 | delivery：发现人的 PR 包含自己的改动就立即关闭自己的 PR | 改为核实、报告并按既有授权关闭；保留避免重复工作的职责与现有分支。 | A10 |
| R22 | communication：机器人评审每个 PR 最多三轮 | 复用现有评审预算并采用仓库更严格限制；预算耗尽不等于 CI 或批准通过。 | A03、A10 |
| R23 | communication：GitHub 消息统一加英文身份声明 | 保留真实作者身份；固定前缀按仓库和渠道约定适配，不冒充人。 | A04 |
| R24 | delivery：UI 交付有真实的 Before 与 After | 沿用现有验收：相同场景、尺寸、主题和数据，记录版本与限制。 | A03 |
| R25 | prompts 文档：提示词用英文 | 沿用本仓库中文模型提示、用户的语言及英文提交元数据约定；表达按现有 STE 写法。 | A02、A11 |
| R26 | prompts、路由工具：校验长度，不静默截断 | 统一工单标题契约；完整保存或明确拒绝，显示截短不改存储。长度校验不代替语义评审。 | A11 |
| R27 | prompts：按命名部件装配 | 沿用各模块 `prompts.ts`、Brain 与 skills，不新建认识全部业务的提示词包。 | A09 |
| R28 | handoff：空的 final 保留成功报告 | 保留已确认交付与真实执行错误两份事实；后续连接失败不擦除证据，也不被成功报告掩盖。 | A08 |

R19–R21 是不采用上游团队的默认授权，不是取消合并、署名或去重能力。当前任务的「不自行推送、开 PR、合并」约束保持；研究与文档整理本身不授权发布。

### 部件覆盖

上游 15 个内置部件与 3 个团队策略均进入比较；工具说明、通知文本和宿主约束也应在实施时一并核对，不能只替换系统提示。

| 部件组 | 上游名称 | 本地归属 |
|---|---|---|
| 共同边界与角色 | `runtime/shared`、`runtime/orchestrator`、`runtime/worker` | 助手与会话的角色规则，配合实际工具权限 |
| 团队策略 | Communication、Ticket scope、Delivery requirements | 已有仓库约定与用户明确策略，不重复塞进每张工单 |
| 工作指引 | `runtime/subscriptions`、`runtime/replies`、`runtime/dispatch`、`runtime/work` | 频道、信箱、工单与会话边界 |
| 主动承接 | `runtime/admission` | 暂缓产品能力，保留授权原则 |
| 交接 | `runtime/handoff/orchestrator`、`runtime/handoff/worker` | 结构化问题、报告与原处投递；共用 handoff 内容不另算角色 |
| 环境 | `runtime/environment` | 设置、仓库、档案和会话生成的真实环境 |
| 策略 | `runtime/policy`、`runtime/policy/none` | 服务端当前允许的行为；没有策略不推断权限 |
| 来源技能 | `skill/feishu`、`skill/github` | 按来源加载；两者共用的 CLI 指引适配实际账户与工具 |

### 本地实现边界

| 所有者 | 本提案要求它承担的职责 | 不应另建的东西 |
|---|---|---|
| Issue 与协议 | 标题、授权范围、负责人、业务拆分、暂停和交付判断 | 第二份工单生命周期或授权真相 |
| Channel、Ingress、Mailbox | 原始消息、来源、承接目标与持久投递 | 复制的需求库、聊天库或手工消息游标 |
| Session、Executor、runtime | 实际执行、工具能力、后台资源、恢复与注入记录 | 用提示词冒充进程隔离，或让执行 phase 独占业务结论 |
| Orchestrator 与 Tool | 路由、派发边界、结构化提问和结果投递 | 助手反复翻译原始要求，或只隐藏工具却不校验调用 |
| 通用 Brain | 通用提示装配、skills、记忆和轨迹能力 | 在 `packages/agent` 中加入工单、农场或发布规则 |
| 页面与宿主 | 展示真实状态、证据、待决定问题和当前动作 | 为顶部、托盘或灵动岛分别推导一套业务状态 |

现有实现位置见[架构](docs/architecture.md)及[助手](docs/subsystems/orchestrator.md)、[会话](docs/subsystems/session.md)、[大脑](docs/subsystems/brain.md)、[工单](docs/subsystems/issue.md)、[频道](docs/subsystems/channel.md)、[信箱](docs/subsystems/mailbox.md)、[仓库](docs/subsystems/repo.md)。实施应复用这些所有者，不以逐项采用上游为由创建同名服务。

### 工单文字与标题

工单、提示词与文档应沿用[写作](docs/style/writing.md)已有的 STE 写法：一词一义、一义一词，主动句，写明条件、主体、动作和结果。一条要求描述一个可观察行为。标题应写清对象和预期结果，不应只有提交类型和模块名。

完整原文与来源应保留。标题是检索和识别入口，不承担全部执行契约。明确的小请求不必强制填写长模板；需要起草时，正文应区分现状、目标、范围、验收和待定选择。执行者不应把建议写成用户已经批准的要求。

现有写作约定是中文技术写法，不等于完整英文 ASD-STE100 合规认证。语义清楚不能只用长度、禁词或快照测试证明。

### 与已有计划的边界

- [助手的授权](.agents/notes/proposed/feature/2026-10-21-orchestrator-authorization.md)拥有动作分档和跨轮同意的细节。本提案要求这些动作共同服务完整工作流程，不另复制一张权限表。
- [工具集与技能](.agents/notes/proposed/architecture/2026-10-28-toolsets-and-skills.md)拥有档案能力与按需加载的细节。给档案增加工具不应自动扩大某张工单的授权。
- [同工单协作](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)仍是独立提案。其中点名直接启动帮手、自动暂存或提交的建议，不因本提案而获准；实施前应按负责人、写入权限和保留现场的约束重新审查。

本提案只拥有授权工作流程与提示词的共同设计，不取代上述计划全部内容。对它们的冲突项应先形成一致决定，再实施，不应将两份相反规则同时注入模型。

### 实施次序

1. 核对现有入口，画清原始请求、授权、负责人、投递、执行与交付的实际关系；将缺口对应到下表验收组。
2. 修复标题存储与拆分权限等确定性问题，保留现有子单、分支和未提交工作。
3. 按角色与模式装配提示词，移除相互抵消的指令，并校验实际工具权限。
4. 补齐评论、暂停、恢复和交付的缺口，使用同一份状态与来源记录。
5. 记录实际注入的版本和生效时机，验证自有 Brain 与外部农机的差异；模型评测如需付费，应先取得用户同意。
6. 通过下面的完整工作流程后，将已成立的约定分别沉淀进现有子系统文档，并删除本 Note。

这些是同一批工作的次序，不是自动创建子工单的指令。完整提示词编辑台和主动接活功能不作为首批前置条件。

### 上游依据

所有链接固定到同一提交，避免 main 更新后无法核对：

- [目的](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/000-philosophy.md)、[领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md)、[授权](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/002-authorization.md)、[执行与恢复](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md)。
- [提示词部件与优先级](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/004-prompts.md)、[实际装配与版本](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/prompts.ts)、[工具与资源边界](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/007-architecture.md)。
- R01–R04、R12：[共同规则](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/shared.md)、[路由](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/dispatch.md)、[执行](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/work.md)、[范围](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/team/scope.md)。
- R05–R10、R28：[回复](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/replies.md)、[订阅](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/subscriptions.md)、[共用交接](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/handoff.md)、[帮工交接](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/handoff-worker.md)。
- R11、R13、R17–R18：[执行者工具](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/tools/executor.ts)、[会话权限](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/sessions.ts)、[主动承接](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/admission.md)、[CLI 约定](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/cli.md)。
- R19–R24：[团队交付策略](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/team/delivery.md)、[团队沟通策略](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/team/communication.md)。
- 行为校验：[状态分类](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/stage.ts)、[工单恢复](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/tickets.ts)、[汇报](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/assignments.ts)、[回复用途校验](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/replies.ts)。

## Alternatives considered

**只改标题与提示措辞。** 能改善识别，不能阻止递归派发、丢投递或错误恢复。标题缺陷应修，但不代替状态和权限的改动。

**按现有实现逐条裁剪上游。** 容易保留熟悉的句子，删除仍有用途的职责。例如用 vv 替换 gh 是发布适配，不是把剩余交付步骤重新交给用户。

**完整复制上游。** 上游围绕单仓库、DeepSeek Harness 和特定团队策略设计。直接复制会引入不同的结束语义、账户约定和默认副作用，也不能证明 Pi/oar 行为相同。

**先造通用提示词平台或新的授权引擎。** 会复制已有所有者并推迟工作流程验证。命名装配、来源和生效记录应先复用现有服务；完整编辑台可后续评估。

**通过增加工单层级提高自主性。** 更多工单不等于更明确的责任。只有独立交付边界成立且派发获准时，业务拆分才有价值；内部步骤可留在执行者计划中。

## Acceptance criteria

下表是实施的验收要求，不是本轮已通过的测试。应先在最低可观察层验证规则，再在隔离程序上验证接线；模型语义判断另用获准的真实模型评测。

| 编号 | 输入或故障 | 应观察到的结果 |
|---|---|---|
| A01 来源与授权 | 普通讨论、引用旧方案的确认、外部指令、缺失上下文 | 系统保留真实来源；不凭关键词派活；不把建议当授权；缺少必要依据时明确说明。 |
| A02 模式与起草 | 只记下、只调查、只起草，以及待定产品选择 | 系统不擅自执行；建议与确认项分开；模式与工具权限一致，农机限制如实说明。 |
| A03 持续执行与交付 | 普通测试失败、仅有提交或检查点、不同 deliver、缺 UI 前后证据 | 帮工继续解决普通问题；按交付方式验证；未验证的不报就绪；就绪不自动变成用户确认完成。 |
| A04 问题与投递 | 重复报告、问题已解决、用户索要详细说明、来源不可投递 | 系统不重复通知；问题到原处且不被普通保存清除；完整说明可达；失败不谎报已送达。 |
| A05 评论与负责人 | 无负责人、运行中补充、换人、点名其他档案、越界请求 | 系统不兜底选人、不并跑、不追溯派发旧评论；点名不改派；越界请求明确转交。 |
| A06 停止与恢复 | 人工暂停后问进度、发新线索、服务重启、机器人反馈、明确解除 | 系统可回答但不擅自恢复；解除有来源，恢复前核对授权和工作现场。 |
| A07 拆分与协作 | 未批准拆分、后代继续拆分、重复提案、内部帮手 | 服务端拒绝越权派发；提案不启动执行；重试不重复创建；内部协作遵守农机与预算限制。 |
| A08 执行与报告 | 后台检查仍运行、空 final、报告后连接失败、消息落库与投递之间重启 | 状态不伪装空闲或完成；报告和真实错误均保留；补充不遗漏，重复外部副作用有防护和明确限制。 |
| A09 装配与生效 | 角色或模式变化、策略更新、上下文压缩、Pi/oar 与自有 Brain | 实际注入可追溯，生效点明确；不包含矛盾的执行指令、凭据或不存在的能力。 |
| A10 发布与来源 | 未授权 push、merge、force-push、借用账户、评审预算耗尽 | 门禁拒绝越权；正常 vv 发布仍可用；预算不替代 CI 和批准；来源读取不授予写权限。 |
| A11 标题与表达 | 长英文含冒号、中文标题、空壳前缀、超限与合法标题回读 | 正式标题完整保存或明确拒绝；显示截短不改数据；错误可修正；语义质量另经样例评审。 |

贯通验收应覆盖同一件工作：用户提出要求 → 原负责人收到补充 → 普通失败自行修复 → 越界请求转交 → 投递中断后恢复 → 人工暂停与明确解除 → 交付经检查并回到原讨论。每个采用项应附实现位置、被验 HEAD、证据及未验证限制；不以提示词包含某句话判定行为通过。

## Risks

- 上游主 Session 仍有文件与 shell 工具，「不读实现代码」主要是提示规则；自动合并策略也不是宿主内完整的合并门禁。不应将上游所有要求描述成程序保证。
- 隐藏 write/edit 或限制 vv 接口不等于进程只读；无约束 shell 仍可写盘。外部农机没有相应隔离能力时，应说明边界，不宣称安全只读。
- 人工暂停、工单完成和授权撤回的映射会改变用户可见行为。实施前应确认映射，不应借重构静默改变权限。
- 持久队列和本地幂等键不能单独保证外部服务全局恰好执行一次。外部动作不支持去重时，应核查已有结果，保留无法确认的状态。
- 新规则可能影响已有执行。实施应保留现有工作树、分支、未提交改动和待投递输入；不应靠重置、共享 stash 或直接改库来通过验收。
- 规则写得更短仍可能删掉职责。每次删改应回到「目的、承接者、替代机制、验收故事」核对，而不是按字数判断质量。
