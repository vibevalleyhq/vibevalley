# Agent Note: 工作台 UI 状态机与 Rust 领域投影收口架构

Status: proposed

## Problem

原生工作台（`apps/mac/ui`）存在两类隐式状态机：一类在前端重复派生服务端领域投影，造成同一份 `StateFrame` 在不同视图显示矛盾数字；另一类在 TSX 组件内用多组散落 `signal` 拼装瞬态交互，允许编译期无法拦截的非法状态组合与异步竞态。

| 问题类型 | 现网位置 | 实测表现与根因 |
|---|---|---|
| 宽窄屏计数漂移 | [Board.tsx](apps/mac/ui/features/issue/views/Board.tsx#L160-L162)、[Board.tsx](apps/mac/ui/features/issue/views/Board.tsx#L207-L210)、[IssueList.tsx](apps/mac/ui/features/issue/views/IssueList.tsx#L130) | 在 `Density::Dense`（65 张工单，含 16 张单任务工单与 1 张父工单 `i40` 处于 `in_progress`）下，宽屏列头只计 `c.kind === "issue"` 并与 `maxRunning`（6）拼出 `16/6`；窄屏标签页与列表分组直接计整列行数，显示 `17`。 |
| 工单派生规则重复 | [cards.ts](apps/mac/ui/features/issue/model/cards.ts#L29-L34)、[cards.ts](apps/mac/ui/features/issue/model/cards.ts#L99-L121)、[issue.ts](apps/mac/ui/features/issue/model/issue.ts#L77-L78)、[overview.ts](apps/mac/ui/features/issue/model/overview.ts#L49-L88) | 泳道归属、卡片分类、子工单完成度、工作目录核对标记及 10 条用户提示分支全部在前端重算，像素农场、灵动岛与命令行无法复用同一口径。 |
| 素材库互斥信号冲突 | [LibraryPage.tsx](apps/mac/ui/features/media/LibraryPage.tsx#L89-L97)、[LibraryPage.tsx](apps/mac/ui/features/media/LibraryPage.tsx#L169-L185) | 9 个独立 `signal`（`where`、`kind`、`artifactKind`、`picked`、`pickedArtifact`、`anchor`、`asking`、`looking`、`dragging`）同时维护互斥筛选与选区；`kind` 与 `artifactKind` 可同时非默认值，`picked`、`pickedArtifact`、`looking` 与 `asking` 依赖多处回调和两个 `effect` 手工清零。 |
| 关单验收 6 处状态联动 | [CloseDialog.tsx](apps/mac/ui/features/issue/views/CloseDialog.tsx#L34-L126) | `CloseIssueDialog` 与 `ChangesReview` 分散持有 `reviewing`、`sinceTree`、`reviewError`、`changes` 查询状态及两个 `createAct` 的忙碌信号；`issue.review` 因文件树变动拒绝后，靠命令式改写 `sinceTree` 或调用 `refetch` 触发增量改动重拉，状态转换散落在异步分支中。 |
| 新建草稿竞态提交 | [NewIssue.tsx](apps/mac/ui/features/issue/views/NewIssue.tsx#L24-L54)、[write.ts](apps/mac/ui/features/issue/model/write.ts#L8-L17) | 5 个信号（`text`、`repo`、`agent`、`saving`、`editing`）叠加 `mounted` 标志与可变 `createWriteKey` 闭包；在途请求期间继续输入时，靠返回后比对文本快照决定关窗或留稿，幂等键复用与轮换逻辑无法脱离组件树单独测试。 |
| 覆层与拖拽多信号拼装 | [IssuesPage.tsx](apps/mac/ui/features/issue/views/IssuesPage.tsx#L67-L68)、[IssuesPage.tsx](apps/mac/ui/features/issue/views/IssuesPage.tsx#L129-L142)、[Board.tsx](apps/mac/ui/features/issue/views/Board.tsx#L70-L138) | 弹窗互斥依赖 `newAt`、`closing`、`reopening` 与路由参数拼出 `dialogUp()`；拖拽依赖 5 个信号与异步 `measure()` 回调手写过期检查。 |
| 其余域前端重复聚合 | [items.ts](apps/mac/ui/features/media/items.ts#L212-L213)、[places.ts](apps/mac/ui/features/channel/model/places.ts#L86-L93)、[runs.ts](apps/mac/ui/features/session/runs.ts#L274-L372) | 媒体进行中任务筛选、频道及串未读数累加、会话轨迹瀑布与 token 汇总均留在前端纯函数中，服务端不产出摘要。 |

## Proposal

将所有状态按「是否属于跨视图 / 跨端共享的确定性领域投影」一刀切为三层：确定性领域投影下沉至 Rust（`vibevalley-protocol` + `vibevalley-core`），单窗口瞬态交互收口为前端显式有限状态机（FSM），TSX 视图层只做穷尽分支展示与事件派发。

### 一、分层边界铁律

| 层 | 归属条件 | 唯一输入与输出 | 不应做的 |
|---|---|---|---|
| Rust 领域投影（`vibevalley-protocol` + `vibevalley-core`） | 仅由 `SpaceState` 确定性推导，且被多个视图（宽屏 / 窄屏 / 列表 / 详情）或多端（工作台 / 像素农场 / 灵动岛 / 命令行）共享 | 输入 `SpaceState`；在 [core.rs](crates/vibevalley-core/src/core.rs#L296-L304) 的 `frame_of`（`with_words`）产出结构化 enum、计数与标识，随 `StateFrame` 下发 | 不应输出拼好的本地化 UI 句子；不应把派生摘要写进 `SpaceState` 或落盘；Rust `match` 不应使用吞掉新变体的 `_` |
| 前端显式 FSM（`apps/mac/ui/features/*/model/` 或同域纯模块） | 仅属于单个工作台窗口的瞬态交互（弹窗步骤、在途提交、筛选作用域、选区与灯箱、拖拽阶段、覆层互斥） | 导出封闭判别联合类型（discriminated union）与纯函数 `transition(state, event)`；每项特有数据只挂在对应的分支变体上 | 不应在组件内用 3 个以上散落布尔或可空 `signal` 拼装同一状态流；不应在 FSM 内直接调用网络、宿主或全局可变闭包 |
| 薄 TSX 视图层（`apps/mac/ui/features/*/views/`） | 布局、令牌样式、无障碍标记、语言与皮肤文案映射 | 读取 `StateFrame` 投影或显式 FSM 状态，经 `t("key", params)` 渲染并派发事件或 `Intent` | 不应重算泳道人数、卡片归类或提示决策树；不应写清理 `effect` 修补互斥信号 |

### 二、下沉 Rust：结构化、无语言依赖的领域投影

所有跨视图共享投影在 [vibevalley-protocol](crates/vibevalley-protocol/src/contract/core.rs) 中定义为封闭结构体与 enum，通过 `vp run protocol:ts` 生成 TS 类型，在 `packages/protocol/src/*/schema.ts` 补齐进门 Zod 校验，并在 [vibevalley-core/src/core.rs](crates/vibevalley-core/src/core.rs#L457-L476) 随 `StateFrame` 计算一次。

| 投影类型 | 挂载位置 | 承载字段与语义 | 替代的前端重复逻辑 |
|---|---|---|---|
| `BoardSummary` | `SpaceView.boardSummary`（`board_summary`） | 四列确定性计数 `laneCounts: BoardLaneCounts`（`todo` / `working` / `waiting` / `closed`，宽屏、窄屏、列表统一口径）、占用空位数 `runningSlots`、并发上限 `maxRunning`，以及按工单 id 索引的 `byIssue` 映射表 | [Board.tsx](apps/mac/ui/features/issue/views/Board.tsx#L160-L162)、[Board.tsx](apps/mac/ui/features/issue/views/Board.tsx#L207-L210) 宽窄屏计数分叉 |
| `BoardIssueSummary` | `BoardSummary.byIssue` 每单条目 | `lane`（`IssueLane`：`todo \| working \| waiting \| closed`）、`cardKind`（`IssueCardKind`：`todo \| issue \| family \| orchestrator`）、父工单进度 `familyDone` / `familyTotal`、`needsWorktreeCheck`、`prompt: Option<IssuePromptKind>` | [cards.ts](apps/mac/ui/features/issue/model/cards.ts#L29-L34)、[cards.ts](apps/mac/ui/features/issue/model/cards.ts#L99-L121)、[cards.ts](apps/mac/ui/features/issue/model/cards.ts#L177)、[issue.ts](apps/mac/ui/features/issue/model/issue.ts#L77-L78) |
| `IssuePromptKind` | `BoardIssueSummary.prompt` | 封闭 enum，穷尽表达 `asking`、`review_after_failed_check`、`reviewed`、`handed_back`、`stuck_conflict`、`stuck_failed`、`stuck_interrupted`、`stuck_quiet`、`stuck_unknown`、`canceled_reopenable` | [overview.ts](apps/mac/ui/features/issue/model/overview.ts#L49-L88) `userQuestion` 的多层条件分支 |
| `MediaSummary` | `SpaceView.mediaSummary`（`media_summary`） | 正在生成或下载的媒体任务数 `activeCount` 与对应 `activeIds`（排除不产文件的 `understanding`） | [items.ts](apps/mac/ui/features/media/items.ts#L212-L213) 的 `making` 筛选 |
| `ChannelSummary` | `SpaceView.channelSummary`（`channel_summary`） | 全局未读总数 `unreadTotal` 与按父频道汇总（含下属串）的未读映射 `unreadUnder` | [places.ts](apps/mac/ui/features/channel/model/places.ts#L86-L93) 的 `unreadTotal` / `unreadUnder` |

**保护双语与双皮肤的铁律**：Rust 领域投影应只传输结构化 enum（附 `pub const ALL` 与 `as_str`）、计数与实体 id，不应拼接任何本地化界面句子。

1. **双语切换即时生效**：工作台支持中英双语即时切换；文案映射留在前端词典（`crates/vibevalley-i18n/locales/{zh,en}`），切语言不必让服务端重算或重发 `StateFrame`。
2. **工作台与像素农场双皮肤隔离**：同一工单状态在工作台叫「待验收 / 等你回答」，在像素农场叫「开花 / 缺肥」（见 [用语表](docs/README.md#用语)）。协议层只传结构化枚举，两张皮肤各自映射到对应词汇，守住「先有概念，再有皮」。
3. **现存文案字段边界**：`SessionView.phaseText`、`DoingView.actionText`、`CronView.whenText` 为已有过渡字段；新增投影不应效仿它们在 `with_words` 中调用 `t()` 拼句，后续再按域逐步收回客户端渲染。

### 三、前端显式 FSM：单窗口瞬态交互收口

单窗口瞬态交互留在 `apps/mac/ui/features/`，命名按领域动作定名（遵循 [命名规范](docs/style/naming.md)，避开 `state.ts`、`utils.ts`），遵循统一形态：

1. 状态类型应为封闭判别联合，以明确标签（如 `kind` 或 `phase`）区分阶段；仅某阶段合法的数据（`sinceTree`、`requestKey`、`anchor`、错误信息）只声明在该分支上。
2. 状态演进应写成无副作用的纯函数 `transition(state, event)`，外部薄适配器负责调度 RPC、定时器和路由。
3. 视图组件应按标签执行穷尽 `switch`（由 `oxlint` 的 `switch-exhaustiveness-check` 与 TypeScript 类型检查守卫）。

| 目标模块 | 显式状态与转换函数 | 消除的非法状态与竞态 |
|---|---|---|
| `features/issue/model/closeFlow.ts` | `CloseFlowState`（`confirming \| loadingDiff \| loadFailed \| reviewing \| submitting \| treeChanged \| done`）+ `closeFlowTransition(state, event)` | 取代 [CloseDialog.tsx](apps/mac/ui/features/issue/views/CloseDialog.tsx#L34-L126) 的 6 处联动状态；将提交锁、错误提示与 `issue.review` 文件树变动后的 `sinceTree` 增量改动重拉收进单一闭环，避免「提交中重复点击」或「加载失败却残留旧改动按钮」。 |
| `features/issue/model/draftSubmit.ts` | `DraftSubmitState`（`editing \| submitting \| rejected \| retainedDirty \| committed`）+ `draftSubmitTransition(state, event, nextKey)` | 取代 [NewIssue.tsx](apps/mac/ui/features/issue/views/NewIssue.tsx#L24-L54) 的 5 信号与 [write.ts](apps/mac/ui/features/issue/model/write.ts#L8-L17) 的可变闭包；同稿重试保证复用原 `requestKey`，改稿或在途提交期间继续编辑自动进入 `retainedDirty` 并轮换新 `requestKey`。 |
| `features/media/libraryView.ts` | `LibraryViewState` 组合两个正交判别联合：`LibraryScope`（`all \| media(fileKind) \| artifact(artifactKind)`）与 `LibrarySelection`（`none \| files(ids, anchor?, asking) \| artifact(id, asking) \| lightbox(index, prior?)`）及 `selectScope` / `pickFile` / `pickArtifact` / `openLightbox` / `reconcileSelection` 等纯转换函数 | 取代 [LibraryPage.tsx](apps/mac/ui/features/media/LibraryPage.tsx#L89-L97) 的散落信号与清理 `effect`；编译期杜绝媒体筛选与 Artifact 筛选同时生效，以及文件选区、Artifact 选区与灯箱三者冲突。 |
| 看板覆层与拖拽（`features/issue/model/`） | 互斥覆层联合 `none \| newDraft(at) \| closing(target) \| reopening(target)` 与拖拽阶段联合 `idle \| measuring \| dragging(ghost, over, before)` | 取代 [IssuesPage.tsx](apps/mac/ui/features/issue/views/IssuesPage.tsx#L67-L68) 的多弹窗信号与 [Board.tsx](apps/mac/ui/features/issue/views/Board.tsx#L70-L138) 的 5 信号拖拽闭包，消除异步 `measure()` 乱序回写。 |

### 四、薄 TSX 视图层约定

重构后的 TSX 页面只保留三类代码：

1. **读投影**：从 `StateFrame` 读 `BoardSummary`、`BoardIssueSummary`、`MediaSummary`、`ChannelSummary`，叠加必要的本地乐观 `Intent`（见 [客户端：页面状态与数据流](docs/subsystems/app.md#页面状态与数据流)）。
2. **穷尽渲染**：对 Rust 枚举（如 `IssuePromptKind`）与前端 FSM 联合（如 `CloseFlowState`、`LibrarySelection`）用穷尽 `switch` 或 `variant()` 映射到文案、图标和按钮，保留既有 `testID`。
3. **派发事件**：用户输入、快捷键与异步返回只向 FSM 派发结构化事件，不在组件回调中直接跨多个 `signal` 手工同步状态。

### 五、与四层验收体系的闭环

分层收口直接接入仓库现有的离线多密度验收流水线，使每一次新增协议变体或交互分支都可自动闭环校验：

| 层级 | 载体与命令 | 校验对象 | 耗时量级 |
|---|---|---|---|
| 1．Rust 契约与场景全覆盖 | [scenario.rs](crates/vibevalley-core/src/scenario.rs) + [export_scenarios.rs](crates/vibevalley-core/examples/export_scenarios.rs)；`cargo test -p vibevalley-core -p vibevalley-protocol` + `vp run protocol:check` | 通过真实 `Core::apply` 与 `reduce` 构建 `Density::ALL`（含新增 `Density::Edge` 边界密度）；单元测试对着 `IssueStatus::ALL`、`Priority::ALL`、`IssueStageKind::ALL`、`StuckReason::ALL`、`Deliverable::ALL`、`PullRequestState::ALL`、`Landing::ALL`、`IssueLane::ALL`、`IssueCardKind::ALL`、`IssuePromptKind::ALL`、`MediaPhase::ALL`、`ConnectorState::ALL`、`CallState::ALL`、`InboxKind::ALL` 断言 100% 覆盖并导出统一 `state.json`。 | 毫秒–秒级 |
| 2．前端 FSM 毫秒级纯单测 | `apps/mac/ui/app/{closeFlow,draftSubmit,libraryView}.test.ts`（`nsh/test`） | 直接驱动纯函数 `closeFlowTransition`、`draftSubmitTransition` 与 `libraryView` 转换函数，穷尽验证非法事件忽略、文件树变动增量复核、幂等键复用与轮换、Shift 范围多选与互斥清选，不挂载视图树。 | < 100 毫秒 / 套件 |
| 3．虚拟时钟无头 BDD 套件 | [mac-tests.ts](scripts/audit/mac-tests.ts) 并发执行 [scenarios.test.tsx](apps/mac/ui/app/scenarios.test.tsx)、[interactions.test.tsx](apps/mac/ui/app/interactions.test.tsx)、[components.test.tsx](apps/mac/ui/app/components.test.tsx) | 消费 Rust 导出的多密度 `StateFrame`，用虚拟时钟快进检验轮询、相对时间、审批流、写路径竞态与窄视口（560×800）深浅主题渲染。 | 约 3 秒全量 |
| 4．GPUI Metal 静态视觉图册 | `--features shot` 构建 `vibevalley-mac` + `VIBEVALLEY_FAKE_SERVER` + [ui-report.ts](scripts/audit/ui-report.ts)（步骤见 [验收应用](.agents/skills/vv-acceptance/references/app.md)） | 对多页面（看板、列表、详情、频道、素材库、Artifact、设置）、中英双语、深浅主题、宽窄窗口及 `Density::Edge` 边界数据（1287 / 999+ 未读、1 父 6 子 `blocked_by` 家族、`¥1,234.56` 大额花费、超长无断行 SHA / URL、开放 PR 伴失败检查输出）截成 PNG 画廊并核对 `dump.json` 零报错。 | 数十秒（合入前 / 视觉改动） |

### 六、分阶段迁移清单

| 阶段 | Rust 契约与核心投影 | 前端显式 FSM 与视图切换 | 阶段产物与退出条件 |
|---|---|---|---|
| Phase 1：工单域 | 在 `vibevalley-protocol` 定义 `IssueLane`、`IssueCardKind`、`IssuePromptKind`、`BoardLaneCounts`、`BoardIssueSummary`、`BoardSummary`；在 `vibevalley-core` 折叠投影；扩充 `scenario.rs` 的 `Density::Edge` 密度与 `::ALL` 覆盖测试；重跑 `vp run protocol:ts` 并导出场景 JSON。 | 落地 `closeFlow.ts` 改造 [CloseDialog.tsx](apps/mac/ui/features/issue/views/CloseDialog.tsx)、`draftSubmit.ts` 改造 [NewIssue.tsx](apps/mac/ui/features/issue/views/NewIssue.tsx) 及纯单测；随后切换 [Board.tsx](apps/mac/ui/features/issue/views/Board.tsx)、[IssueList.tsx](apps/mac/ui/features/issue/views/IssueList.tsx)、[cards.ts](apps/mac/ui/features/issue/model/cards.ts) 与 [overview.ts](apps/mac/ui/features/issue/model/overview.ts) 读取 Rust 投影；收口 [IssuesPage.tsx](apps/mac/ui/features/issue/views/IssuesPage.tsx) 覆层与拖拽状态机。 | `Board.tsx` 宽屏与窄屏 `working` 计数口径一致（宽屏空位与列数语义清晰无漂移）；`CloseDialog` 与 `NewIssue` 零散落联动布尔；`interactions.test.tsx` 与纯 FSM 单测全绿。 |
| Phase 2：素材库与频道域 | 在 `SpaceView` 落地 `MediaSummary` 与 `ChannelSummary`；在 `scenario.rs` 补齐 `MediaPhase::ALL`、`ConnectorState::ALL` 及 999+ 未读边界并刷新导出的场景夹具。 | 落地 `libraryView.ts`（`LibraryScope` + `LibrarySelection`）改造 [LibraryPage.tsx](apps/mac/ui/features/media/LibraryPage.tsx) 及纯单测；将 [items.ts](apps/mac/ui/features/media/items.ts) 活跃任务列表与 [places.ts](apps/mac/ui/features/channel/model/places.ts) 未读汇总切换为消费 Rust 摘要（保留 [marks.ts](apps/mac/ui/features/channel/model/marks.ts) 本地乐观未读覆层）。 | [LibraryPage.tsx](apps/mac/ui/features/media/LibraryPage.tsx) 删除互斥清理 `effect`；素材库与频道未读计数与 `StateFrame` 摘要完全一致。 |
| Phase 3：会话轨迹投影与全图册验收 | 评估将 [runs.ts](apps/mac/ui/features/session/runs.ts#L274-L372) 中跨端复用的 `waterfallOf` 与 `summaryOf`（轮次、步骤、模型 / 工具耗时、token 汇总与缓存命中率）下沉至服务端或 `vibevalley-core`；前端仅保留 240 步实时合并缓冲与折叠展示。 | 将 `edge` 场景与中英双语切换接入 [ui-report.ts](scripts/audit/ui-report.ts) 视觉图册；产出全页面、双语、双主题、宽窄窗口截图与 `dump.json` 报告。 | 全量图册零 `workbenchErrors` / `sidebarErrors`；将长期成立的边界铁律沉淀进 [核心状态](docs/subsystems/core.md) 与 [客户端](docs/subsystems/app.md)，并删除本 Note。 |

## Alternatives considered

**引入第三方状态机框架（如 XState）**。外部运行时会增加打包体积、调试抽象与事件表样板，且与本仓已有规范（Rust 用 enum + `match`，前端用判别联合 + `variant()`，见 [显式状态](docs/style/module-design.md#显式状态)）冲突。原生 TypeScript 封闭判别联合配合 `transition(state, event)` 纯函数与 `switch-exhaustiveness-check`，已能在编译期拒绝非法组合并实现毫秒级单测。

**延续 `phaseText` 模式，由 Rust 直接下发本地化 UI 句子**。在服务端拼句会把自然语言与皮肤词汇硬编码进 `StateFrame`：用户切换中英文时无法纯前端重渲染，像素农场与工作台也无法对同一业务状态使用各自词汇（如「开花」与「待验收」），违背「先有概念，再有皮」。结构化 enum 虽要求前端维护一份穷尽 `switch` 映射表，但能由编译器保障新增状态不遗漏，且完全解耦语言与皮肤。

**把弹窗、选区、拖拽等窗口交互一并放进 Rust `SpaceState`**。单窗口瞬态输入频率高、不落盘，也不应在不同窗口或 CLI 之间同步；写入 `Core::apply` 会制造无意义的 `seq` 递增、抬高桥通信开销，并破坏多窗口各自独立的筛选与草稿状态。

**不改架构，仅靠代码评审和端到端测试兜底**。散落信号的合法组合随字段数指数膨胀，评审和 E2E 只能验证抽样路径，后续 agent 沿既有代码复制时仍会引入新漂移。按 [AGENTS.md](AGENTS.md#怎么让-agent-做对) 的顺序，先用类型与模块边界消掉整类错误，再配合静态检查与验收图册守门。

## Acceptance criteria

| 维度 | 验收标准与证明命令 |
|---|---|
| Rust 投影与契约 | `vp run rust:check` 与 `vp run protocol:check` 通过；新增协议投影结构体零自然语言文案字段；`vibevalley-core` 单元测试证明 `Density::ALL` 100% 覆盖约定核心枚举的 `::ALL` 常量；`vp run --filter @vibevalley/protocol test` 通过。 |
| 前端显式 FSM | `apps/mac/ui/features/issue/model/{closeFlow,draftSubmit}.ts` 与 `apps/mac/ui/features/media/libraryView.ts` 使用封闭判别联合与穷尽 `switch`；`CloseDialog.tsx`、`NewIssue.tsx`、`LibraryPage.tsx` 不再保留被替代的散落布尔信号与互斥清理 `effect`；3 套纯 FSM 单测各自 < 100 毫秒通过。 |
| 无头与静态检查 | `vp run mac:check`、`vpx scripts/audit/mac-tests.ts`（含 `scenarios.test.tsx`、`interactions.test.tsx`、`components.test.tsx` 及全部 FSM 单测）、`vp run scripts:test`（含 `file-names.test.ts`）与 `vp run docs:verify` 全部退出码 0。 |
| 视觉与端到端闭环 | 在 `Board.tsx` 宽屏与窄屏视口下，`Density::Dense` 的 `working` 列语义与数字一致；使用 `--features shot` 与 [ui-report.ts](scripts/audit/ui-report.ts) 生成含 `edge` 与中英双语的静态图册，`dump.json` 中 `load_error`、`sidebarErrors` 与 `workbenchErrors` 均为 0，人工复核无文字截断、重叠或漏翻。 |

## Risks

| 风险 | 触发条件与后果 | 缓解措施 |
|---|---|---|
| 乐观意图与 Rust 摘要短暂不同步 | 工单拖拽（[moves.ts](apps/mac/ui/features/issue/model/moves.ts)）或频道未读标记（[marks.ts](apps/mac/ui/features/channel/model/marks.ts)）在途期间，服务端帧中的 `BoardSummary` / `ChannelSummary` 尚未追上 `reply.seq`，若直接覆盖视图会导致数字回弹闪烁。 | 视图以 Rust 摘要为基线，仅叠加未结算的局部 `Intent` 差量；待 `frame.seq >= reply.seq` 结算后立即撤销覆层，不修改服务端基线对象。 |
| `StateFrame` 体积膨胀拖慢高频推送 | 若 `by_issue` 或轨迹摘要携带长文本、完整步骤列表或冗余字段，会增大每次 `frame_of` 序列化与桥传输开销。 | 投影严格限制为紧凑 enum、整数计数与短 id；轨迹详情仍走 `SessionLogs` 按需读取与直播流；每次新增投影均在 `Density::Dense`（65 工单）下复测 [perf.test.ts](apps/mac/ui/app/perf.test.ts)。 |
| 过渡期新旧派生逻辑并存导致二次漂移 | 同一域迁了一半，部分视图读 `BoardSummary`、另一部分仍调用旧前端派生函数，会制造新的口径分裂。 | 按阶段以整个业务域为单位切换调用方，切完即删除对应旧前端派生函数，不留兼容分支（遵循 [AGENTS.md](AGENTS.md#规矩)「内部不留兼容」）。 |
| 历史文案字段误导后续 agent 效仿 | 后续改动参照 `phaseText` / `whenText` 在新投影里直接调用 `t()` 拼句，破坏双语与双皮肤隔离。 | 在代码评审中以本 Note 为准拒绝新增文案字段；并在 `vibevalley-protocol` 协议单测中检验摘要序列化结果不含本地化句子。 |
