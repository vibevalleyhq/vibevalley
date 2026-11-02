# Agent Note: 四层 Agent 网关剩余边界收口

Status: proposed

## Problem

以主人最新确认的[设计稿](.agents/reviews/2026-11-01-four-layer-agent-gateway-design.md)为目标：专业模块分工、状态正交。此前把机器事件塞进 channel_message、取消工单层信箱的解释不再执行。删除重复状态，不删除不同生命周期所需的职责。

Ingress、Mailbox、Resource 已独立，Issue 对 Mailbox 的反向依赖与 TaskGraph 平行状态机已删除。来源入口与管家入口方向已收拢；静态层序和设计稿第 5、6 节的 Fact、持久化、传输收敛仍需完成，完整目标尚未完成。

## Proposal

### 模块所有权

| 模块 | 独占的数据和行为 | 对外接缝 | 移出或删除 |
|---|---|---|---|
| Ingress | 不可变 Trigger、来源幂等键、原始结构化载荷、CompactCard、自发消息过滤；GitHub/连接器/聊天/语音/Cron/Patrol 的归一化 | accept(source input)、读取 Trigger；向 Mailbox 提交标准信封 | Channel.ingest 中的事件拼装，issue/merge 的 GitHub 增量归一化 |
| Mailbox | 线程订阅、工单归属、Tier 1 蓄水、Tier 2 投递、Urgency、三道刹车、恢复重放 | receive(trigger)、订阅/退订、handback/letGo；调用 Session 信号 | 以聊天消息号代替所有事件 ID；Issue 自己管理第二份投递状态 |
| Issue | 唯一工作项、parent/blockedBy DAG、Mandate、PR Follows、派发、子分支汇合、waitsForHuman | 归属/冻结查询、工单命令；工单事实供 Mailbox/Inbox 读取 | Task 服务、GraphState/TaskState、graph_* 工具、计划专属 Inbox 项 |
| Session / Executor | 两种角色的 Session、Run、Journal；Wake/Steer/Preempt/Consumed/Settling/HandedOff；Executor 拥有运行时资源 | 信号方法与会话事件；工具集由上层装配 | 独立 OrchestratorState、管家旁路输入流、Phase.arriving、资源不释放或预览被误杀的路径 |
| Resource | URI 解析、读取权限、分页、会话级 TextCache | read(session, uri, offset, limit)；tool 只做参数与返回值适配 | tool/resource 的业务读取与鉴权，散落的全文拉取逻辑 |
| Inbox | HITL 门禁、未读撤回、已读抑制、巡查宽限 | 合法外推消息流；连接器发送前复核 | inbox_handoff/inbox_owner_action；不增加人类阅读持久状态 |

Channel 只保存人类可见的频道、串、消息、成员和阅读游标。机器 Trigger 独立保存，不因为需要排队就创建聊天消息。需要向主人交代时，Inbox/上层适配器明确生成可读消息。

Project 保留本地 git、worktree、合并、项目检查，以及底层 gh 调用能力；GitHub 事件指纹、游标、自发消息过滤与载荷归一化归 Ingress。Orchestrator 保留管家角色、提示和工具装配，主人发言的入口直接进 Channel/Ingress，不经过 Orchestrator.say。

### 静态依赖与运行时流向

采用设计稿的组装顺序：Platform → Agents → Source Control → Collaboration → Agent Sessions → Issues & Contracts → Mailbox & Gateway → Ingress & Resource / Orchestrator / Tool → Human Loop → Transport Doors。

运行时事件流和静态 import 顺序分开：

- 低层 Channel、Session、Issue、Cron 发布自身事实或提供查询，不 import 上层 Ingress、Mailbox、Inbox。
- 上层 Ingress 订阅来源并补扫持久源记录；Transport 直接调用 Ingress。来源幂等键保证重放不重复，不能只依赖进程内流。
- Mailbox 查询 Issue 的归属、在场 Session 和 waitsForHuman，并向 Session 发送信号；Issue 不调用 Mailbox。handback 的工单授权由 Issue 判断，投递退回由 Mailbox 执行，上层工具装配这一次操作。
- Session 不导入 Resource 或 Tool。上层把工具闭包注入 Session；Resource 只向下查询，不反向调用工具。
- Channel 不依赖 Session 实现。会话登记、汇报写入聊天等接线迁到上层装配，避免 Collaboration 与 Agent Sessions 形成环。
- Trigger 作为资源读取及网关交换的线格式定义在协议；来源适配和业务决策各留在拥有它的模块。

### 持久化与状态

| 所有者 | 记录 | 状态 |
|---|---|---|
| Ingress | ingress_trigger：确定性 ID、来源键、actor、thread keys、card、结构化载荷、发生时间 | 无状态；不可变事实 |
| Mailbox | mailbox_subscription：thread key → issue | 无生命周期枚举 |
| Mailbox | mailbox_issue：trigger → issue，与 Session 生命周期分离 | held / forwarded / returned |
| Mailbox | mailbox_delivery：trigger → session | pending / handed / consumed / dropped |
| Issue | issue、assignment、execution、PR Follows | 六个 IssueStatus；其余读事实推导 |
| Session | session、session_run、Journal | working / resting / done / failed / closed |
| Inbox | 读取 channel_read_cursor、消息和 Issue | 无新增持久状态 |

按仓库表名归属约定，Tier 1 命名 mailbox_issue；不用 issue_input 重建 Issue 所有的第二套队列。Tier 1 的 forwarded 与 Tier 2 的 consumed 不重复：前者证明归属输入已交给某次 Session 投递，后者证明实际入模。

Tier 1 → Tier 2 的新增投递和状态变化同事务提交。换人时，旧 Session 未消费投递退回 pending/工单蓄水，由新 Session 领取；已 consumed 的输入不重放。handback/letGo 以确定性键转交管家。人类追问锁定 followupOwner，恢复冻结输入；自动信号在 asking/stuck/reviewing 下保持 held。

### 实施顺序

本轮 Tier 1 接线的隔离接口证据：`/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-UAX22N`，code=0、stopped=true；未派工单重复评论只保存一条，工单线程出现在 state 帧中。首次验证脚本误用只返回频道与私聊的 channel.list 查工单线程，已改为读取 state 帧后通过。

1. 抽出 Resource 服务、TextCache 和 URI 契约；resource_read 保持薄工具入口。
2. 建立独立 Ingress Trigger 存储与归一化入口，迁移机器事件；删除经 Channel.ingest 伪装聊天的路径。
3. Mailbox 接管订阅与 Tier 1，统一 Tier 2 为 consumed；将 Issue → Mailbox 调用迁到上层装配与持久事实恢复。
4. 完成 Issue 原生拆单、验收命令和冻结文件、依赖调度、父子汇合，再删除 Task 服务及协议、工具、页面和通知中的独立图状态。
5. 补齐 Session 五阶段与 Settling/HandedOff 的资源生命周期，去掉 Orchestrator.say 入口倒置，按目标顺序调整 services/modules。
6. 统一接入 GitHub/连接器/语音/Cron/Patrol/看板，完成 originTriggerId 与建单附言限制；最后集中验收整条路径。

每一步迁完调用方就删除旧实现，不保留兼容层或双写。只运行能验证当前改动的检查，整体接线完成后集中跑全套和隔离程序验收。

### 当前实现证据与待办

- Task 后台硬切已落地：删除 src/task、task_event、issue/session 的图元数据、graph.* HTTP/CLI、StateFrame.graphs、GraphState/TaskState 和相关协议形状；拆单输入改名 IssueChildDraft。频道的图来源/主题、task RunTrigger 及 forTask 特例同时删除。游戏由原生父子工单事实生成 split/family 奖励。原地工作的父会话不允许拆出无关父分支，回归测试覆盖拒绝且不产生子单。
- 本轮验证：server:check 16/16 成功，服务端 731 项通过、1 项真实模型评测跳过；docs:verify 9/9 成功；真实 Playwright 父单→子单→返回→验收合入通过。日志 `/tmp/vv-after-task-server-check-final.log`、`/tmp/vv-after-task-docs-check.log`。删除旧 Task 专属回归（含 task assignments survive reload…）及旧图规则样例，由原生 split/split-session/dependencies/acceptance、通用 assignment 和事务回滚用例承接；提交 PR 时需注明这一删除。CLI 样例更新了已移除图命令与已入库追问的预期；成功回合信号断言改为 handedOff，会话列表明确包含管家。
- PR 收尾已支持无父 Session 的父工单：MERGED/CLOSED 都直接清理父分支与 worktree，并写完成/取消。原生子单的依赖/约束后续编辑、完整重启恢复仍需对照设计验收。其余网关目标未完成，不能把 Task 删除当成整个目标完成。
- PR 在途与 HITL 已用同一 Session.phase 区分：普通成功回合或 prSubmit=true 的提交报告使用 resting，Issue 保持 in_progress，释放槽位且允许 CI/Review 自动唤醒；明确最终报告（prSubmit=false）、问题或未满足验收项才交给主人。报告事实可携带 resting，未增加持久报告状态。提交报告若还有后台任务先 Settling；守候中到达最终报告可立即 HandedOff 并保留预览。11 项真实 git/脚本农机流程覆盖两种提交、CI 入模、最终冻结、后台资源及无 Session 父 PR 两种结局；vp check 通过。真模型未运行。

- 旧 TaskDetail、TaskBoard、features/task 查询已删除，页面不再读取 StateFrame.graphs。普通看板显示原生父子工单，FamilyDetail 使用 Issue 的状态与动作并列出子单，普通子单提供返回父单；农场图纸桌/手机打开 /issues。Playwright 真实服务端流程已通过：拆单→父单待验收→进入子单→返回→无父 Session 验收合入；截图在 `apps/web/test-results/issues-native-parent-issue-610ec-ge-without-a-parent-session/`。一次 e2e 脚本未转发筛选参数启动了全套，已停止；其中旧 chat.spec 的管家休息断言失败，未视为全套通过，最终验收仍需处理。

- 已删除管家的 graph_* 工具、参数与说明、tool/graph 模块，以及 Orchestrator 对 Task 的依赖和图快照；graph.* HTTP 接口也已删除。Inbox 删除 graph-draft/graph-ready/task-failed 三个类别和图目标，原生父工单使用普通 review + issue 目标；成功子工单不重复催验收。工具契约/快照、核心 Schema、拆单父通知、巡查测试通过。黄金变更仅 45 条 core patrol 和 12 条 inbox patrol 去掉旧图通知。Task 服务、GraphState/TaskState、旧图 API 与页面已移除。

- 原生拆单的 HTTP/CLI 隔离验收已通过：创建父单 → issue split → 子单检查并合入父分支 → issue work 读取父单改动，证据 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-PI3KgG`。验收发现并修复无 Session 的父工单读取改动被拒绝的问题；现在直接读取父工单分支，回归断言覆盖父单 commits。

- issue_split 工具与 HTTP issue.split 已迁到 Issue.split，工具实现移入 tool/issue；删除 Task.splitIssue / splitIssueOf 及专属拒绝逻辑。拆单用单事务保存原生子工单、负责人、真实 blockedBy 和队列，继承父单源头契约；按当前执行者授权，未提交父工作拒绝拆分。真实 git 测试覆盖依赖推进、自动汇合、写入失败整批回滚、父 Session/负责人保留。graph.* 的规划入口、旧图 UI/协议/状态已删除。

- 已接入 Settling/HandedOff：Executor 用 oar 结构化 task 事件计算未完成任务；未声明交回的成功回合保持 working/Run/槽位，等待子任务与后台命令全部结束；失败不会转成成功。显式 issue_report 在回合结束释放槽位并保留执行器，停止守候则先确认关闭资源。Mailbox 的回合结束路径已去掉“说过话就不退回”的判断，所有未 Consumed 的 handed 输入回 pending。`flows/settling.test.ts` 覆盖后台守候、显式交回保留预览、停止守候和后台失败；`channel/chat.test.ts` 验证说过话但没有入模回执的输入会重投。

- Session.phase 已删除 arriving，首轮启动使用 working（since=hiredAt，doing=none），协议/Schema/容量/农场/在线指示与黄金输入同步为五态。黄金输出已重算，Schema、会话规则与工单流程 49 项通过；其余 core/game/inbox 38 项通过（首次并行更新时 Schema 读到旧输出，更新完成后单独重跑通过）。隔离服务端派工后得到 in_review，农场与看板截图无页面错误；证据 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-oF9yM3`（code=0、stopped=true）。

- Cron 已迁到 Ingress：到期快照与 last_run 同事务保存，Ingress 准备工单并绑定订阅后投递，成功登记才确认来源。初始输入在模型启动前登记 Tier 1/Tier 2，排队工单开工时读未消费输入；不再生成定时聊天通知。流程测试已覆盖首轮 Trigger 引用、reviewing 保持 held、完成后重开同一工单。Session 启动期间任意崩溃的完整恢复仍待统一生命周期收尾。

- Resource 服务已从 tool/resource 抽出，包含 URI、真实 Session 角色鉴权、原生 parent/blockedBy 权限与 TextCache。工具只调用 Resource.read，读取权限不再依赖 Task 服务。Resource 和 Ingress 已加入实际模块和服务组装；大层序的倒置仍待后续迁移。
- Ingress 的独立 ingress_trigger 表与 record/read 已接入；Trigger/Card 线格式移到 protocol。按 source+key 确定 ID，重复保留第一次载荷，卡片最长 600 UTF-16 单位，自发回声不入库，完整 payload 从 vv://trigger 读取。独立存储不产生 channel_message 的测试通过。Ingress.accept 已接 Mailbox.receive；Ingress.start 按持久化 seq 分页重放尚未出现在两层信箱的 Trigger。
- Issue 对 Mailbox 的反向依赖已删除，实际 services/modules 改为 Issue → Mailbox → Ingress → Resource。issue_handback 工具调用 Mailbox.returnInput；关单未消费输入由 Mailbox 监听工单事实并在启动时补扫，确定性发送键避免重复。4 项线程流程（含关单释放）通过；其余 Channel/MCP/模块测试已跑，普通聊天多查一次 deferred 的问题已改为只在 issue 串回复时释放。
- Mailbox 的 AllOpenDeliveries 已去掉 channel_message inner join。DeliveryRow 只保留投递字段与 DeliveryPayload（Trigger、输入上下文、目的地类型）；payload_json 非空。模型输入按 600 字卡片加资源指针构造，聊天附件/引用/响应端口等上下文保留；InsertDelivery 返回实际插入结果，已消费输入重试不会重新加进内存队列。真实 Worker 接收 message_id=null 的机器 Trigger、恢复和精确消费的流程测试通过，聊天室没有原始机器事件。
- 管家投递已删除单独的立即 see 路径，统一由 pump 先 handed，再等真实 inputsConsumed；Intake 将整批输入 ID 与摘要输入 ID 一起传给宿主。拒绝启动时退回 pending。👀 也移到真实消费回执之后，不再表示仅投递到消费者。对应回归测试及聊天测试通过。
- mailbox_subscription 和 mailbox_issue 已接入。Mailbox/work.ts 按订阅或显式 issue key 锁定归属，无 Session 或 waitsForHuman 时 held；前者有 Session 后转交，后者由新主人输入解除。ForwardIssueInput 与 Tier 2 插入同事务，提交后更新内存。已转交的重复输入不解冻后到的自动输入。换人时未消费输入具备重定向代码，尚未做恢复/竞态验收。Resource 按 Mailbox.ownerOf 授权拉取订阅来源的原始 Trigger。
- Patrol 已切换 Ingress.accept：不写聊天消息，以 digest 留在管家信箱，随下次交互捎带。对应管家流程测试通过。原生输入的“无 Session 等待 → 派工 → 冻结 CI → 新主人回复释放”及订阅资源读取流程通过。
- GitHub 来源已从 Issue/Project 拆入 ingress/github.ts；Project 只提供 gh 传输与远端解析。Issue.refreshPullRequests 只处理合并／关闭，Ingress.refreshGitHub 采集并投递；生产定时器独立组装，测试用显式刷新。删除 issue_follow，CI 观察位置归 ingress_github，评审/评论按不可变事件身份去重。CI 恢复后再失败产生新修订事件；不会被旧指纹 ID 吞掉。raw payload 保留 path/line/diffHunk/threadId，机器事件不进聊天。PR 集成测试覆盖自发过滤、机器人限额、主人释放、重复轮询和 CI 回退。
- issue_pr_submit 已改为真正的在途提交：Session.withWorkplace 保护现场，复用本地检查和 PR 保存，不经过 handOver，不结束 Run；issue_report(prSubmit) 传当前 summary。检查后目录再次变脏会拒绝 push。真实 git / 假 gh 流程在运行中提交并验证 Run 不变，随后完成、重启、PR 合并或关闭；相关 15 项测试通过。
- GitHub 全集合与嵌套线程分页已接入：github-source.ts 用命名 GraphQL 查询和 gh --paginate --slurp 读取检查、评审、评论、线程，线程内溢出从最后 cursor 接续；节点 ID 关联评审，fullDatabaseId 仅作编号查找，移除已弃用的 databaseId 查询。快照任一部分失败即拒绝，不能固化残缺 Trigger。botRoundKey 按评审 ID 归组并从已存事实恢复，迟到的同轮评论仍用原轮次；独立机器人评论单独计数。已存但未路由来源会在轮询重试。Resource 的 thread URI 返回整串。17 项 GitHub/PR/Resource 测试覆盖多页集合、101 条线程评论、读取失败、六条同轮评论、迟到评论、大小写自回声、未路由重试和资源整串读取；类型与 lint 通过。PR 等待外部反馈与最终 HITL 的阶段推导及 Settling/HandedOff 接缝也已验证。

- 新 Trigger 的 handback/letGo 已接：Tier 1 变 returned，与给管家的新投递同事务提交；投递编号与原始 Trigger ID 分开，inputOf 暴露 originTrigger，管家建单继续绑定原始来源。已 consumed 的原回执保留，重试不重复转交；关单只把未消费主人输入交回管家，自动输入收束为 returned。旧聊天来源仍保留旧处理分支，等来源全部迁移后删除。
- 数据库已改 consumed；已删除 readUpTo/工具展示直接消费的通道。忙时插话带整批正文和 IDs，wakeInput 不再只取最后三条却确认全部 IDs。删除 busyNotice 实现及 200 条旧黄金案例；新回归证明整批卡片都进入正文。机器卡片不再标成聊天地址，也不被管家的第二次截断裁掉资源 URI。
- 私聊闲置挂起移回 Session：报告后按绝对截止时间计时，离场撤销；原挂起恢复回归通过。本批输入、退回、私聊、聊天和规则共 44 项测试通过，类型检查通过。
- 信箱顺序与恢复已统一：ingress_trigger 的 routing_position 与 mailbox_delivery.position 共用数据库顺序，按 issue/channel scope 记录主人重置点；hop/cooldown 从独立载荷恢复，不再依赖聊天 join、哈希 ID 或来源时间。写库和缓存更新用同一把锁；并发恢复保留已提交投递。held 卡片随合法运行捎带，queue 不打断当前运行。4 项流程覆盖并发恢复、重复主人不重置、倒序来源时间、冷却恢复与 queue/steer 区别。删除旧 channel budgetHeld 标记，并将原回归改为仅验证 deferred 释放；机器人预算由原生 GitHub 流程覆盖。
- 主人发言 API 已直达 Ingress.say，档案选择、引用快照与开场归入口；删除 Orchestrator.say。连接器、语音字幕与电话回答改走 Ingress.owner，删除 Channel 的外部来源入口。电话主动播报摘要经 Ingress.accept 保存独立 workbench Trigger，不再写系统 notice，responsePort 仍只关联进程内 Caller。Channel 消息归一化已迁到 ingress/channel.ts：提交消息后保存不可变 Trigger，Mailbox.routeChannel 只管路由；私聊首轮复用已存 Trigger。聊天保留原消息 ID 作为源 ID，卡片改为 vv://trigger；编辑及重放不覆盖原载荷。聊天源由 Mailbox 按频道消息恢复，独立来源扫描排除 channel_message 载荷，避免绕过私聊/线程受众。Resource 的聊天 Trigger 提供 parent/around。
- Mandate 字段已统一 originTriggerId（含协议、Schema、SQL、映射与测试）；管家建单附言按 Intl.Segmenter 中英文分词硬限 30 词，超限不建单。Session 初始模型输入带一手源 URI，不改变显示 brief；Resource 按所属工单 Mandate 授权，其他工单不能读。相关 32 项工具/管家/来源测试与类型 lint 通过，分词边界和工单规则测试通过。工具参数快照按实际 Schema 重写；未运行付费真模型评测。
- 追问边界更正：设计稿第 3 节规定关单 letGo 将未回应主人追问交回管家，不要求自动重开已关闭工单；未关单且 Session.done 的追问沿用当前 Session，已有线程流程覆盖。此前“已完成工单新追问自动续接”的待办混淆了 Issue.done 与 Session.done，撤销该推断。
- 第 6 节债务 2 已完成：删除 channel_seen_mark 表/查询/接口；主动读走 read_number，被动投递认 consumed_at。发话前新鲜度提示按最旧到最新分页，逐批推进游标；消费先落库再展示反应。49 项频道/Schema/私聊/来源测试和类型 lint 通过。
- 执行关联与 Actor 存储减法：cron_set_by、memory_author 已合成 actor_kind；含 profile 的频道参与者仍是不同概念。issue_assignment_execution 删除 executor_kind 列和枚举，executor 外键统一引用 session；查询从 Session.role 派生角色，管家派发前先注册 Session。issue.last_run 列、SetLastRun/OpenOf 查询和 T.IssueRun 类型已删除；Issue.lastRun 只读摘要从 session_run + session_run_issue 查询，正式执行关联排除起草会话。Session 发布开始关联和结束事件，Issue 刷新派发/进度；重启中断以统一 Run 为准。待执行管家工单保持 todo，实际模型开始后 in_progress、结束后 in_review，新的流程回归对照 session_run 时间和结局验证。56 项工单/管家/规则/派发测试及类型 lint 通过；单独的真实会话状态回归通过。
- mailbox_route 已删除：原始路由回执并入 ingress_trigger，首次 routed_at/scope/position 不被重试或退回覆盖；退回投递的独立顺序仍在 mailbox_delivery，主人刹车位置由只读 mailbox_owner_route 视图推导。聊天缺口重放、GitHub 幂等、Tier 1 排序均改读源行回执。54 项相关测试通过，加强的6项顺序与退回流程及类型 lint 通过。
- issue_queue 已删除：手动排队/拆单用现有 issue_dispatch 作提交到接入之间的快照，Cron 直接保留已有 Trigger；Ingress 接入后从 Mailbox.queuedInputs 把来源交给 Issue.tryQueued。Issue 只判断依赖、空位并派发，不查信箱也不另存上下文。重复排队保留首频道，退回备选使旧派发退役，重新排队会替代旧来源；定时触发保留 cron/missed/message。32 项依赖/拆单/工单测试通过，新重排回归后工单26项通过。隔离证据 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-C6TvXU`：依赖阻塞排队、切默认频道、解除依赖后自动开工，Session仍在原频道，code=0/stopped=true。
- 管家记忆已统一到 memory 表：Brain/SelfTools 增加宿主 MemoryPort，Session.host 总是注入数据库读写；提示、增量记忆、remember、rewrite_memory 和评测快照共用该入口。Memory 服务删除按角色分流的文件读写，整理只事务替换 Agent 管理的 note，保留 owner 条目；旧文件不读、不迁。独立命令行仍可选择文件适配器，不作为服务端存储。协议删除 MemoryList.file/carried，页面用 author 标记来源。服务端 Memory/Host 16 项、Agent Brain/Tools 46 项测试通过，Web 11/11、文档9/9通过；工具声明快照只改变 rewrite_memory 的存储无关描述，未跑付费真模型。隔离证据 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-8YSOtF` code=0/stopped=true；截图 `apps/web/.screens/orchestrator-memory-1440x900.png` 已查看。
- state.json 已退出运行时：Core 从空投影开始，不读写文件；Session 从自身表恢复身份与阶段、报告、运行次数、花费和工作资源，登记身份/状态/工作目录以及结束Run/状态/清pending_report分别同事务保存。进行中状态合并写库，关机保存一次；工作目录缺失才判lost。Game从账本/项目恢复进度与commit。旧文件恢复/写失败测试已移除或改为“不读不改旧文件”，频道模拟Session也按DB恢复；私聊跨启动保留同Session/oar上下文与指定站位，且没有state.json。65项核心/频道/位置/私聊/PR/Settling/Schema测试、类型lint通过。游戏play仍是Session字段，归属迁移未完成。
- spend.json 已移除：Runtime.spending 按本地日期/农机维护数据库增量，当前日预算立即更新；批次提交与待写集合确认不可中断，失败保留重试，关机写完剩余增量，跨日数据各归其日。runtime_spend 是发生日的预算计数，session_run.spent 是整轮汇总，跨日不能相互代替。28项Runtime测试覆盖恢复、不重复确认、跨日、SQL拒绝后的重试和非法金额；7项Schema测试与类型lint通过。
- 冲突已归 Issue：删除 Session.conflict、session.conflict列、FactConflict 与 Session.changes/recheck；Issue 负责存储、合并失败、改动预览与报告后复查。关闭Session/重启后保留冲突并可复查分支；无Session的父工单冲突进入Inbox，能派父会话解决。UI/Frame/地图从Issue取冲突，游戏解冲突奖励跟随Issue事实。新增真实git流程验证持久化和父工单解决。发现并修复外部Run异步start/end写入竞争：开始/heard/结束串行，报告和离场等待前序提交，worker结束后刷新Issue，晚到结束不重开关单。最终25项工作/父工单/Host流程、类型lint通过，Web11/11通过。
- 黄金数据迁移：删除181个Core、80个Game的无工单Session冲突事件；404个展示/Stage输入把冲突移出Session。规则输出变化0，去掉旧Session.conflict后状态差异0、特效差异0；217个旧孤立冲突的view/inbox输出变化符合归属迁移。31项Core/Game测试通过，备份 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vv-issue-conflict-golden-ntnar0b3`。隔离证据 `vibevalley-verify-cG8heI` code=0/stopped=true；实际冲突页面已查看，截图 `apps/web/.screens/issues-01a19985-c2ca-72cf-94d2-eca61c891785-1440x900.png`。
- Fact首批正名：hired/left/report/call → session/sessionGone/sessionReport/voiceCall，对应类型与Schema一并迁移；聊天Message.kind与游戏Ledger.kind不改。phase → sessionPhase，累计花费并入该完整阶段事实，FactSpent删除。代码按AST标签位置修改，黄金输入按JSON结构迁移；Core所有state/changed/effects/view/inbox和Game输出差异均为0，不重写输出。首批133项、合并花费后83项相关测试与类型检查通过；run/doing/quiet/retry仍待合并。备份 vv-fact-names-em65wbvo、vv-phase-spend-mb0kl880。
- 原范围中的剩余明确要求：第 5 节 Fact 按设计表明细收敛至 15 类（正文“14”是计数笔误：4+2+4+2+2+1）、游戏数据移出 Session；第 6 节单连接多路复用；另有静态模块层序与完整生命周期验收。不能以六模块已接通代替这些要求的完成。

- 工单线程主人输入已接 Tier 1：Trigger 带 issue key 与原聊天上下文，排队首轮由信箱领取；删除 Issue.hire 的聊天上下文拼接和独立 envelopeIds。Mailbox 的旧 letGo/handback 聊天分支、deferred 标记与三条专用查询已删除。`regression: owner replies release deferred channel inputs` 随旧实现删除，其释放冻结输入行为由 flows/ingress 的原生 Tier 1 回归覆盖；thread 的关单释放、重复 handback 改断言真实返回投递，取消工单后的消息归管家而不再唤醒旧帮工。频道/线程/来源/返回/私聊 46 项通过，类型与 lint 通过。最后的 Issue.toOrchestrator 路径也已迁移：派发事务保存 issue_dispatch，Ingress 订阅工单事实并在启动/定时补扫，路由后确认；删除 Channel.ingest 和 AgentIngress。恢复回归覆盖入口装配前已提交派发及确认重试不重复，无系统聊天通知。完整目标仍未完成。

- 来源入口这一批：连接器与语音 48 项、管家 22 项测试通过，播报摘要断言独立 Trigger 存在且没有对应系统聊天消息；类型与 lint 通过。隔离服务端验收目录 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-ezFK3E`，`result.json` 为 code=0、stopped=true：同 sendKey 重发只保存一条主人消息，state 返回 200。没有调用真实模型或外部电话。
- 聊天 Trigger 接线：频道 34 项、管家 22 项、模块依赖 5 项、新来源流程 3 项通过。私聊启动回归发现 Channel 事务跨进 Mailbox 后的锁顺序冲突，成员写入与信箱注册拆开，漏投补送也不再包外层数据库事务，4 项私聊流程通过。类型与 lint 通过。隔离接口证据 `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-7IlI6B`：code=0、stopped=true、重复发送只一条、state=200。工单 Tier 1 与最后一处机器聊天入口已在后续批次收敛。

- OrchestratorState 和核心 orchestrators 映射已删除；管家注册真实 Session。Worker 并发槽、地块和恢复按 role 区分。核心/管家、工单/游戏及聊天显示测试通过；核心黄金数据 2,975 行的 view/inbox/effects 不变。
- IssueReportState 与人类交接状态表已删除；报告保留 questions/checks/answer，Inbox 直接查消息和阅读游标，连接器发送前复查。
- 精确输入回执已代替 spoke 推断；announced 已删除。数据库已统一为 consumed。重启测试在停机前等待了回执持久化，不足以证明任意时刻停机都已落盘。
- 原生 IssueRequest/issue_create 已接 parent/blockedBy；子单继承项目和负责人，从父分支开工。原生子单已接自动汇合和父单 in_review，父单验收后才合 main；真实 git 流程测试通过。
- Project.mergeInto 支持同步父 worktree，拒绝父目录未提交改动或分支变更；Session.withIdleWorkplace 在父会话锁内释放执行资源后汇合。旧 Graph 调用暂时仍用未检出的独立分支。
- IssueConstraints 已接入原生子工单汇合：验收工单先证明检查失败并保存冻结文件；后继工单检查前后验证冻结文件，末端重跑验收祖先命令；约束写入帮工输入。真实 git 流程覆盖通过、篡改冻结文件、未实现需求三条路径，连同父子依赖与合入测试共 6 项通过。TaskGraph 已由原生父子工单取代。
- 已删除的 issue_input 不应按旧实现恢复；新的工单蓄水由 Mailbox 拥有。现有把外部事件写进聊天串的接线需要替换。
- GitHub review thread 不会仅凭 head 变化自动 resolve；该变化不证明具体评论已修复。

## Alternatives considered

把全部机器事件复用成聊天消息，省表却破坏 Channel 边界；不采用。把工单排队和 Session 消费合成单层，会在未派工、换人和等主人期间混淆归属；不采用。为阅读游标再存一份人类状态机，会增加同步义务；不采用。

## Acceptance criteria

- 六个服务拥有各自的数据与规则；modules/services 对应目标依赖，无环、无上层入口倒置。
- 所有来源经过 Ingress 的 Trigger/Card；长日志不注入提示，机器事件不污染频道。
- 两层 Mailbox 在排队、换人、冻结、重启和重复输入下不丢失、不重复消费；handback/letGo 回到管家。
- TaskGraph/GraphState/TaskState 和对应工具、通知特例删除；拆单、依赖、失败处理、冻结测试、合父分支和父单验收走 Issue。
- 管家与帮工共用五阶段、Run 和 Journal；真实入模才 Consumed；Preempt 回滚未消费投递；Settling/HandedOff 按资源是否仍有工作区分，预览可保留。
- Resource 支持设计稿全部 URI、around、固定快照分页和会话鉴权。
- Inbox 只交付合法 HITL 项；已读抑制、未发撤回、新变化增量提醒和 Patrol 宽限有真实行为证据。
- 新契约与现有页面/工具接通，集中检查和隔离程序验收完成后，才能报告整体目标完成。

## Risks

模块顺序变化涉及订阅与启动恢复，不能让先发生的事件丢在服务装配之前。持久触发与可失效的同步 Caller 分开，重启后来源事实仍能路由。父工作目录与子分支汇合必须互斥且保护未提交内容。设计稿称 Tier 2 为“三个状态”但实际列出四个，按明确列出的四个实现；依赖取消按文档中的“取消跳过”处理。
