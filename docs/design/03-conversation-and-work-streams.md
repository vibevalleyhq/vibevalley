# 第三篇：会话核心流、工单板与运行轨迹引擎

工作台最核心的三条动态业务线分别为**田头群聊流**（`features/channel/`）、**运行中心与轨迹引擎**（`features/session/` 与 `features/orchestrator/`）和**工单看板与档案面板**（`features/issue/` 与 `features/agent/`）。

## 3.1 频道与消息流排版

频道视图分布在 `apps/mac/ui/vv/web/features/channel/`（核心视图文件：`ChannelSidebar.tsx`、`MessageList.tsx`、`MessageParts.tsx`、`presence.tsx`）：

- **无气泡单行排布**：聊天流采用类似 Slack/Linear 评论的垂直全宽列表，不使用左右气泡。用户、助手与帮工均左对齐排布，依靠左侧 `28px`（或折叠时缩进对齐）头像、名字徽标与角色标签区分来源。
- **头像折叠与未读分割**：同人连续消息紧凑衔接排布；跨发言者、跨日分隔或未读分界线（`DayLine`）处恢复完整消息头。
- **长消息 `360px` 高度折叠**：单条长回复高度超过 `foldPx = 360`（`MessageParts.tsx`）时自动截断并附加展开/折叠切换按钮，避免超长文本把上方讨论推离视口。
- **富文本与专业块内嵌**：正文经 `Markdown.tsx` 渲染，嵌入 `CodeBlock.tsx`（超过 16 行的代码块默认收起并给出全量展开切换）、`Diagram.tsx`（Mermaid 架构图）、`AttachmentTile` 附件格和引用回复条。
- **实时在场与回底策略**：顶部和频道列表通过 `presence.tsx` 实时呈现正在输入或在线的助手/帮工（`ThinkingDots` 呼吸点）；`MessageList.tsx` 监测滚动离底偏移（`awayPx = 240`），当用户向上翻阅历史时锁定滚动不抢焦，并在底栏上方亮起浮动「回到底部」（`to-latest`）按钮。

## 3.2 富文本输入与斜杠指令引擎

底部消息输入框实现于 `apps/mac/ui/vv/web/features/channel/views/Composer.tsx` 及其模型文件 `commands.ts`、`composing.ts`、`mentions.ts`：

- **斜杠命令（`/`）**：输入行首键入 `/` 即刻展开结构化指令浮层（`z-20`），支持上下方向键与 `Enter` 选中插入或执行本地快捷工作流。
- **精确 `@` 提及引擎**：使用共享规则 `packages/protocol/src/rules/channel.ts` 导出的 `mentionLead` 正则（`(?<![\p{Script=Latin}\p{N}_@])`）。邮箱写法（如 `a@b.com`）中的 `@` 不会误触发提及浮窗，而中文词尾紧接 `@` 仍可正常激活候选帮工/档案弹窗，使中文输入无需强迫前置空格。
- **拖拽与粘贴附件去重**：支持文件/截图直接拖放进输入栏和系统剪贴板图像粘贴，上传后基于 SHA-256 去重并以 `AttachmentTile` 挂接在草稿栏上方。
- **键盘发送与引用退出**：`Enter` 发送、`Shift+Enter` 换行；处于空输入栏按方向上键（`up`）直接进入「编辑上一条消息」；按 `Esc` 退出引用回复态。

## 3.3 思考态、运行中心（`/runs`）与瀑布轨迹引擎

运行观察视图由 `apps/mac/ui/vv/web/features/session/` 与 `apps/mac/ui/vv/web/features/orchestrator/` 驱动：

- **运行中心（`RunsPage.tsx` 与 `runsView.ts`）**：路由 `/runs`，通过查询参数 `?session=&scope=&agent=&issue=` 过滤与定位（搜索框输入保留为页面本地状态）。左侧列表顶部内置搜索框与 `runs-scope` 单选切换组（`all` 全部 / `active` 运行中 / `orchestrator` 助手 / `worker` 帮工）；每条运行呈现 `RunStatusBadge` 七态（`working`、`listening`、`resting`、`done`、`failed`、`interrupted`、`closed`）和活动时间 `runActivityAt`。
- **助手代批栏（`PendingApprovals.tsx`）**：处于等待批准/确认的阻塞请求以醒目条带浮于顶部/详情区，用户可直接完成同意或驳回流转。
- **瀑布时间线（`Trajectory.tsx` 内的 `WaterfallView`）**：
  - 按每轮次拆分横排，清除轮间空闲空白（轮次间以 `4px` 固定间距衔接），纵向按 `asked`（询问）/ `model`（模型）/ `tool`（工具）顺序划分为三道固定泳道（`lane = 12px`、`gap = 3px`，定义在 `apps/mac/ui/vv/web/features/session/runs.ts`）。
  - 用颜色区分通道：`asked` 使用 `tone("wheat")`，`model` 使用 `tone("leaf")`，工具步骤按步骤颜色映射；单击任意色块（最小兜底 `2px` 宽）立即滚动定位到下方详情流对应步骤。
- **结构化工作日志与重连补读（`WorkLog.tsx` 与 `runs.ts`）**：
  - 服务端按会话保留最近 `240` 步日志；工作台断线或延迟打开时，通过 `runs.ts` 按步骤序号 `seq` 与修订号 `revision` 合并重连前后的历史轨迹与实时增量事件。
  - 连续 3 个及以上的同类高频工具步骤自动折叠为单行摘要，避免刷屏；每步右侧可下钻查看输入参数、终端输出或关联 Diff/截图。
- **子线程协作进度（`SubagentProgress.tsx` 与 `subagents.ts`）**：当主轮次通过协作原语派出子线程时，单独渲染每个子线程的执行来源、最近可观察动作、等待对象与终态，互不覆盖。

## 3.4 工单看板与独立详情页

工单流分布在 `apps/mac/ui/vv/web/features/issue/`（`IssuesPage.tsx`、`Board.tsx`、`IssueDetail.tsx`、`NewIssue.tsx`、`CloseDialog.tsx`、`TodoDetail.tsx` 及纯逻辑模型 `overview.ts`、`cards.ts`、`closeFlow.ts`、`draftSubmit.ts`）：

- **总览与四列看板（`IssuesPage.tsx` / `Board.tsx` / `overview.ts` / `cards.ts`）**：
  - 顶部筛选与分组条按四段核心列展示工单：`Todo`（含排队序号与起草入口）、`Doing`（当前正在运转与等待指示）、`Review`（需用户检视产物）、`Done`。
  - 每张卡片严格展示服务端派发的 `StateFrame` 投影结果（阶段文案 `phaseText`、动作提示、负责档案小头像、优先级与目标分支），页面不重算业务状态机。
- **独立工单详情页（`IssueDetail.tsx`）**：
  - 选中任意工单时整页切换至 `/issues/:id`（而非局部抽屉或弹框覆盖看板），保留左侧或顶部「Issues」返回面包屑栈与 `Escape` 返回路径。
  - 详情页并置展示目标描述、实时工作流/运行日志跳链、当前修改文件列表与 Git 验证检查状态（`verified_merge` 候选文件树与检查命令结果）、快捷终端按钮（`OpenTerminal`）以及交付关闭操作。
- **新建与关闭流**：`NewIssue.tsx` 由 `draftSubmit.ts` 管理幂等请求键（`sendKey`）防止连按建出重复工单；`CloseDialog.tsx` 由 `closeFlow.ts` 管理常规关闭与带候选差异审阅（自动扩展 `wide` 宽度与按需拉取增量 Diff）的交互转换。

## 3.5 档案分组列表与农机额度仪

- **档案列表（`AgentsPage.tsx`）**：将全局唯一或置顶的「助手」排在首组（`OrchestratorRow`），下方按已启用与未启用排列「帮工」（`WorkerRow`）。支持直接行内切换启用开关、查看错误告警条（`max-w-60 bg-bad-soft`）以及点击头像进入详情。
- **档案与助手配置（`AgentConfig.tsx`、`AgentPage.tsx`、`OrchestratorPage.tsx`、`OrchestratorProfile.tsx`）**：配置页编辑模型、思考深度（`effort`）、农机驱动类型、技能库挂载（`SkillPicker`）、MCP 服务列表（`mcpTarget`）、以及档案的物种与服装外观（实时驱动农场与左侧头像预览）。
- **农机与精力瓶额度仪（`RuntimesPage.tsx` 与 `quota.ts`）**：读取本机探针返回的各家农机（Claude Code / Codex 等）安装可用性、登录凭证来源与实时用量配额；在农场像素 HUD 与工作台将剩余用量映射为 `bottleSprite` 9 档精力瓶图元（`energy-plenty-100` / `75` / `50`、`energy-low-40` / `25`、`energy-empty-10` / `0`、`energy-unknown`，以及余额计费农机专用 `energy-gold`），低电量时转为警告琥珀色或危险红色提示。
