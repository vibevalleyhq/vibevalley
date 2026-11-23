# Agent Note: 工作台顶栏、页面交互精简与大纲笔记归属作品

Status: proposed

> [!NOTE]
> **Wave 2 落地状态（已部分沉淀至子系统文档）**
> - **已落地**：全局 `<Desk>` 单行 `h-9 items-center` 居中、`Tabs` `pills` 去换行与 `h-6` 收紧、团队分隔线、移除 `<Hint>`（`ⓘ`）、`desk-status` 迁入全局 `Rail` 底部 `rail-runs-status`、`sidebar` 面板图标、侧栏展开防重复搜索/新建/返回；工作区 `ChatPane` `h-8` 动作条/`h-5` `chat-cwd-chip`/紧凑 `<Menu>` 权限选择器、`ChannelSidebar` 去重、`IssuesPage`/`AgentsPage` 节奏与按钮权重收敛；**Option A（`ArtifactType::Outline`）** 全栈落地（契约、Rust 引擎、服务端 SQLite + Loro `LoroTree`/`LoroText`、`.md` 大纲导入 `artifact.outline.import` + `OutlineImportModal.tsx`、CLI 与工作台「作品 + 素材」二元侧栏，旧 `pkm` 平行栈已彻底退役）。详见 [客户端](docs/subsystems/app.md)、[Artifact](docs/subsystems/artifact.md) 与 [媒体与素材库](docs/subsystems/media.md)。
> - **尚未落地 / 待定余项**：对话页（`ChatPage.tsx`）宽屏次级标签并入 `channel-head` 的评估；素材按项目/规划组织方式待定。

## Problem

Wave 1B 将工作台各主模块的顶栏高度统一到与工作区（`仓库与终端`）一致的 `36px`（`h-9`），但在真实 macOS GPUI 窗口的逐页走查中，暴露出四类影响心智清晰度与视觉整洁度的结构性问题：

1. **`<Desk>` 顶栏内容贴顶与全局噪音元素**：
   - [Shell.tsx](apps/mac/ui/app/Shell.tsx) 的 `<Desk>` 容器同时写了 `min-h-9 ... flex-wrap ... py-0.5`（内层左侧行也套了 `flex-wrap`）。在 `nsh` / Yoga（Taffy）弹性布局引擎下，启用 `flex-wrap` 会使多行对齐属性 `align-content` 默认取 `flex-start`，导致 `任务`、`内容`、`团队`、`设置` 四个模块的顶栏内容整体向上偏移（紧贴顶边 2–3px，下方留空 5–6px），视觉重心失衡。
   - `<Desk>` 标题旁常驻 `<Hint text={place().hint} />`（`ⓘ` 图标），对 `对话`、`任务`、`内容`、`团队`、`设置` 这类自解释的一级导航页并无信息增量；右上角常驻的 `desk-status` 胶囊（`● 未启动` / `● 干活中 N`）出现在 `设置`、`内容`、`团队` 等静态管理页上，与当前页面语境脱节，空闲时甚至制造「系统异常未启动」的误读。
2. **六大模块各自存在重复入口、双顶栏与视觉拥挤**：
   - **工作区**：[panes.rs](apps/mac/src/panes.rs) 的 `36px` 原生标签栏下方紧贴 `ChatPane.tsx` 的另一条 `36px` `chat-header`，形成 `72px` 双顶栏并重复展示引擎图标、会话标题与在线状态点；`chat-cwd-chip` 用 `py-0.5` 而非固定 `h-5`，与紧邻的 `chat-phase-label`（`h-5`）高度错位；权限下拉 `<Select testid="chat-permission-mode">` 固定 `w-28`（112px）且 [Field.tsx](apps/mac/ui/design/Field.tsx) 内部标签带 `flex-1`，把下拉箭头推到最右端，文字与箭头间出现大片空洞。
   - **内容**：`content-sidebar-toggle`（[Shell.tsx](apps/mac/ui/app/Shell.tsx)）使用 `icon="previous"` / `"next"`（`<` / `>` 箭头），心智上易误认为「后退/前进」而非「收起/展开侧栏」；`<Desk>` 右上角（`desk-content-search`、`desk-content-new`）与常驻 [ContentSidebar.tsx](apps/mac/ui/features/content/ContentSidebar.tsx) 顶部（`content-new-btn`、`content-search-btn`）在同屏并存**两套**「+ 新建」与「搜索」；[ArtifactsPage.tsx](apps/mac/ui/features/artifact/ArtifactsPage.tsx) 在常驻侧栏已展开时仍保留多余的 `← 返回`（`artifact-back-library`）。
   - **大纲笔记**：原 `PageView.tsx` 标题正下方常驻 `pkm-notes-hint` 快捷键说明书（`Tab 缩进 · Enter 换行 · / 命令 · [[ 双链`）以及 Logseq 风格的 `<Props>` 杂项属性条（`status`、`deadline`、`area`/`areas`、`tags`、`更多属性`），底部即使没有反向链接也常驻 `0 条反向链接` 折叠区，打断纯净记录体验。
   - **对话 / 任务 / 团队 / 设置**：[ChannelSidebar.tsx](apps/mac/ui/features/channel/views/ChannelSidebar.tsx) 顶栏右侧的 `farm-search-open` 搜索按钮紧贴下方全宽 `跳到… ⌘J`（`switcher-open`）入口上方，功能重叠；[ChatPage.tsx](apps/mac/ui/features/channel/views/ChatPage.tsx) 在宽屏下把 `channel-head`（`h-9`）与 `聊天 / 任务 / 定时任务`（`Tabs look="line"`，`h-8`）拆成两层，压缩消息视口；[Tabs.tsx](apps/mac/ui/design/Tabs.tsx) 的 `pills` 带 `flex-wrap` 且偏高（`h-7`），与 `团队` 标题之间缺少视觉分隔；`任务` 与 `团队` 的二级筛选条间距和动作主次不够收束。
3. **内容区三足鼎立造成概念割裂与双引擎负担**：
   - 内容中心原并列维护「大纲笔记（原 `pkm` 契约）」、「作品（[artifact.rs](crates/protocol/src/contract/artifact.rs)）」和「素材（`media`）」三套平级概念，导致置顶（`note:` vs `artifact:`）、搜索、评论、协作与存储各写一套。大纲笔记无法直接享用作品已有的能力——频道分享、转工单、右侧协作对话、统一模板与 Wave 2 [Loro 协作内容引擎](.agents/notes/proposed/architecture/2026-11-22-loro-collaborative-content-engine.md) 实时共编。

## Proposal

遵循一条贯穿全工作台的核心交互原则：**「交互友好、每一处元素都有清晰心智意义，宁少勿噪」**。本提案先完整梳理全局顶栏根因修复、六大主模块的逐项删改清单，以及「大纲笔记归属作品」的两条可选落地路径，待用户逐项拍板后再分步实施代码改动。

**硬性约束**：

- 本提案阶段只沉淀决策文档，不修改任何 UI、服务端或协议代码。
- 实施阶段**严禁改动上游 `nsh` 与 `gpui-fast`**；所有布局对齐、图标替换与交互收敛完全在 VibeValley 自身 TSX 与 Rust 壳层内完成。
- 遵循 `design/tokens.json`、`apps/mac/ui/design/motion.ts` 与 `vpx scripts/audit/ui-tokens.ts` 零违规约束。

### 全局 `<Desk>` 垂直居中与顶栏 Chrome 收敛

1. **修复 `<Desk>` 贴顶根因（[Shell.tsx](apps/mac/ui/app/Shell.tsx)）**：
   - 移除 `<Desk>` 外层与内层左侧行的 `flex-wrap`、`gap-y-1` 和 `py-0.5`，改为严格单行定高容器：`h-9 shrink-0 flex-row items-center justify-between gap-3 border-b border-line px-3.5`，内层左侧行改为 `min-w-0 flex-1 flex-row items-center gap-2.5 overflow-hidden`。
   - 单行无换行模式下，Yoga 的 `items-center` 将每个子元素精准居中于 `36px` 轨道中线，彻底消除 `任务`、`内容`、`团队`、`设置` 顶栏偏上问题。
2. **收紧 `Tabs` 胶囊高度与标题分隔（[Tabs.tsx](apps/mac/ui/design/Tabs.tsx)、[Shell.tsx](apps/mac/ui/app/Shell.tsx)）**：
   - `Tabs` 的 `pills` 变体移除 `flex-wrap`，高度由 `h-7` 收紧至 `h-6`（`24px`），字号统一为 `text-xs`，在 `36px` `<Desk>` 内上下各留 `6px` 呼吸感。
   - 在 `<Desk>` 的「团队」标题与 4 个子标签（`角色 / 引擎 / 技能 / 记忆`）之间插入 `h-4 w-px bg-line` 细分隔线，明确区分「模块名」与「当前视图切换」。
3. **移除自解释页面的常驻 `ⓘ`（`<Hint>`）**：
   - 从 `<Desk>` 标题旁删除 `<Hint text={place().hint} />`。一级导航名称本身已足够直白，必要说明下沉到空态引导或具体配置表单内部。
4. **重定位右上角 `desk-status`（`● 未启动`）胶囊**：
   - 不再在 `设置`、`内容`、`团队` 等静态管理页的 `<Desk>` 右上角显示 `desk-status`。
   - 改为归置到全局一致且符合运行心智的位置：方案首选放在左侧全局导航栏 `Rail` 底部（「设置」上方）作为一个极简运行态圆点/计数器入口（点击跳转 `/runs`，悬浮显示详情）；同时仅在有活跃执行或处于 `任务` / `运行中心` 视图时强调运行数，空闲态不展示误导性的 `● 未启动` 文案。

## 六大模块顶栏与交互删改清单

下表按 6 个一级主模块列出具体现状问题、精确位置与建议删改动作（供用户逐项确认）：

| 模块 | 涉及文件与位置 | 现状问题 | 建议删改 |
|---|---|---|---|
| **工作区** | [panes.rs](apps/mac/src/panes.rs)、[ChatPane.tsx](apps/mac/ui/workspace/ChatPane.tsx)（`:734–800`）、[Field.tsx](apps/mac/ui/design/Field.tsx)（`:225–241`） | ① 原生 `36px` 标签栏下方紧贴 `36px` `chat-header`，形成 `72px` 双顶栏，重复展示引擎图标、会话标题与绿点；② `chat-cwd-chip` 用 `py-0.5` 未锁 `h-5`，与相邻 `chat-phase-label`（`h-5`）和 `chat-swarm-pill`（`h-5`）错位；③ 权限 `<Select>` 固定 `w-28` + 内部 `flex-1` 把文字和下拉箭头拉出大块空白 | ① 精简 `chat-header`：去掉与上方激活标签重复的标题和状态点（或收敛为轻量 `h-8` 上下文动作条，仅承载工作区目录、`Swarm` 胶囊、权限模式与打开终端），单栏或多栏时均无信息复读；② `chat-cwd-chip` 统一为 `h-5`（去 `py-0.5`），与全部顶栏胶囊严格同高；③ 权限选择器改用紧凑自适应宽度（去掉固定 `w-28` 或在 `ChatPane` 改用同款紧凑 `<Menu>` 触发器，`gap-1` 让箭头紧贴标签） |
| **内容（作品与素材）** | [Shell.tsx](apps/mac/ui/app/Shell.tsx)（`:281–290, 316–323`）、[ContentSidebar.tsx](apps/mac/ui/features/content/ContentSidebar.tsx)（`:142–156`）、[ArtifactsPage.tsx](apps/mac/ui/features/artifact/ArtifactsPage.tsx)（`:319–328`）、[icons.ts](apps/mac/ui/design/icons.ts) | ① `content-sidebar-toggle` 用 `<` / `>`（`previous`/`next`）箭头，心智上像浏览器后退/前进；② 侧栏展开时，`<Desk>` 与 `ContentSidebar` 同屏并存两套 `+ 新建` 和两套 `搜索`；③ `ArtifactsPage.tsx` 顶栏在侧栏已常驻时仍多出一枚 `← 返回`（`artifact-back-library`） | ① 在 `icons.ts` 新增工作区同款侧栏面板图标（`sidebar`），替换 `previous`/`next`；② 确立单一主入口：侧栏展开时以 `ContentSidebar` 顶部为准，`<Desk>` 右上角的 `desk-content-search` 与 `desk-content-new` **仅在 `contentSidebarOpen === false` 时补位显示**；③ 仅当侧栏收起或窄窗无侧栏时显示 `artifact-back-library`，侧栏常驻时直接隐藏 |
| **内容（大纲笔记）** | 原 `PageView.tsx`（已由 `ArtifactType::Outline` 接管） | ① 标题下方常驻 `pkm-notes-hint` 快捷键说明书；② 常驻 Logseq 风格 `<Props>` 属性栏（`status`、`deadline`、`area`/`areas`、`tags`、`更多属性`），与轻量单栏大纲目标相悖；③ 零反向链接时底部仍占一行显示 `0 条反向链接` | ① 彻底移除 `pkm-notes-hint`；② 移除标题区 `<Props>` 杂项标签栏，标题下直接进入纯净大纲编辑区（保留简洁 `pin`、评论计数与 `更多` 菜单）；③ 仅当反向链接总数 `> 0` 时渲染底部 `Backlinks` 分隔线与折叠区 |
| **对话** | [ChannelSidebar.tsx](apps/mac/ui/features/channel/views/ChannelSidebar.tsx)（`:95–116`）、[ChatPage.tsx](apps/mac/ui/features/channel/views/ChatPage.tsx)（`:200–309`） | ① 频道侧栏顶栏右侧的 `farm-search-open` 搜索图标紧贴下方全宽 `跳到… ⌘J`（`switcher-open`）上方，入口重复；② 宽屏下 `channel-head`（`h-9`）下方另起一行 `Tabs look="line"`（`聊天 / 任务 / 定时任务`，`h-8`），常规聊天页被吃掉 `68px` 顶部高度 | ① 删除 `ChannelSidebar` 顶栏重复的 `farm-search-open` 按钮，统一收口到 `跳到… ⌘J` 与全局搜索弹窗；② 宽屏下评估将 `聊天 / 任务 / 定时任务` 收敛为紧凑分段胶囊并入 `channel-head` 中部或右侧（窄窗再折至次行），把垂直空间还给消息流 |
| **任务** | [Shell.tsx](apps/mac/ui/app/Shell.tsx)、[IssuesPage.tsx](apps/mac/ui/features/issue/views/IssuesPage.tsx)（`:347, 393–430`） | `<Desk>` 贴顶；筛选 `Toolbar` 的左右内边距（`px-3 pt-3 pb-2.5`）与 `<Desk>`（`px-3.5`）及看板/列表/新手引导区的上下留白节奏未统一 | 随 `<Desk>` 改为 `h-9` 精确垂直居中；校准 `Toolbar` 为 `px-3.5 py-2` 并收紧与下方看板列头及空态引导卡的垂直间距，使顶栏→筛选→内容三层节奏紧凑克制 |
| **团队** | [Shell.tsx](apps/mac/ui/app/Shell.tsx)（`:299–311`）、[Tabs.tsx](apps/mac/ui/design/Tabs.tsx)、[AgentsPage.tsx](apps/mac/ui/features/agent/AgentsPage.tsx)（`:105–142`） | `<Desk>` 贴顶、`团队` 标题与 4 个子标签缺少分隔、胶囊偏高；`agents-toolbar` 右侧三个按钮（`模板库`、`新建主助手`、`新建角色`）并排较拥挤 | `<Desk>` 居中 + 垂直细分隔线 + `h-6` 紧凑胶囊；`agents-toolbar` 统一内边距与筛选控件密度，把低频辅助入口（如 `模板库`）弱化为 `quiet` 按钮或合并进新建菜单，突出唯一主按钮 |
| **设置** | [Shell.tsx](apps/mac/ui/app/Shell.tsx)、[SettingsPage.tsx](apps/mac/ui/features/setting/SettingsPage.tsx)（`:175–211`） | `<Desk>` 贴顶、多余 `ⓘ` 提示与错位的 `● 未启动` 胶囊破坏设置页的安静感 | 修复 `<Desk>` 居中并移除 `ⓘ` 与 `desk-status`，让设置顶栏只保留简洁的「设置」图标与标题，与下方 5 栏导航（`通用 / 模型 / 语音 / 连接 / 关于`）形成冷静统一的视觉基调 |

## 大纲笔记归属作品的模型与边界

### 从三足鼎立收敛到「作品 + 素材」二元模型

当前内容中心同时存在「大纲笔记（`pkm`）」、「作品（`artifact`）」与「素材（`media`）」三套平级心智。将**大纲笔记归属为作品下的一等类型（`outline`）**后，内容中心收敛为极简清晰的二元结构：

- **作品（Artifacts）**：人类与 Agent 共同创作、编辑与交付的结构化内容（`outline`、`docs`、`whiteboard`、`slides`、`dashboard`、`design`、`design-system`、`motion`）。
- **素材（Media）**：上传、生成或沉淀的二进制与原始参考文件（图片、音频、视频、文档附件）。

归属后，大纲笔记自动获得作品体系的全部平台能力，而不再重复建设：

- 一键分享到频道、与工单互链或从笔记内容发起工单；
- 复用右侧协作对话抽屉（与主助手直接围绕当前大纲共编）；
- 统一置顶（单一 `artifact:` 命名空间）、统一搜索、统一 19 套双语模板库与统一导出；
- 直接纳入 Wave 2 [Loro 协作内容引擎](.agents/notes/proposed/architecture/2026-11-22-loro-collaborative-content-engine.md)，用 `LoroTree` + `LoroText` 原生承载树状块缩进、无环移动、实时光标与时间旅行回放，避免为 `pkm` 单独维护第二套协同存储引擎。

### `outline`（大纲笔记）与 `docs`（文档作品）的清晰边界

| 维度 | `outline`（大纲笔记） | `docs`（文档作品） |
|---|---|---|
| **定位与心智** | 轻量单栏树状大纲：随手记、会议纪要、日常工作记录、想法拆解 | 结构化长文与正式交付物：方案说明、复盘报告、设计说明、知识沉淀 |
| **编辑形态** | 树状列表块（缩进/反缩进、折叠子树、`[[双链]]`、极速回车新建），零重型文档头部与属性表 | 章节标题层级、段落、表格、代码块、Mermaid 图谱、审阅评论与正式版本 |
| **底层协同容器（Wave 2）** | `LoroTree`（层级与折叠顺序）+ 节点 `LoroText` | `LoroText` / 块序列 + 持久化 `Cursor` 建议保护 |
| **日记心智** | 取消系统强制的「每日日记 / PARA 抽屉」；「每日工作记录」退化为模板库中的普通 `outline` 模板，按需创建 | 不适用 |

### 待拍板的两条实施路径

| 维度 | **Option A（推荐）：彻底归属 `ArtifactType::Outline`** | **Option B：前端先统一，底层留到 Wave 2 Loro 迁移** |
|---|---|---|
| **协议与服务端** | 在 [artifact.rs](crates/protocol/src/contract/artifact.rs) 新增 `ArtifactType::Outline`（归入 `ArtifactBody::Blocks` 或专用大纲块结构），新大纲统一走 `artifact.*` 接口与 `server.db`；在 Wave 2 接 Loro 前后一并退役独立 `pkm` 的 `<Props>` / `PkmTier`（PARA）/ Vault 目录与强制日记逻辑（遵循仓库「内部不留兼容」原则，直接切净） | 暂不改 `crates/protocol/src/contract/{artifact,pkm}.rs` 与服务端表结构；继续调用现有 `api.pkm.*` 接口 |
| **前端与交互** | 侧栏取消独立「笔记」顶级大类，合并进「作品」分类（含 `大纲` 筛选与模板）；彻底净化大纲标题区；笔记立即获得分享到频道、关联工单、右侧协作抽屉与统一置顶 | 侧栏视觉归入「作品」大类并净化原 `PageView.tsx` 标题区（删 `pkm-notes-hint`、`<Props>`、零反向链接）；分享/右侧协作仍需等 Wave 2 合并后才可用 |
| **工程收益与代价** | 一次性消除 `pkm` 与 `artifact` 双套代码、双套搜索和双套评论，Wave 2 Loro 接入面减半；需要一次有计划的 `pkm`→`outline` 模块清理与测试迁移 | 当期改动极小、风险最低，可与六大模块顶栏精简同批快速上线；但过渡期内仍需维护两套前端查询/置顶逻辑，无法立刻给笔记加上频道分享与右侧协作 |

**推荐组合节奏**：先完成「全局 `<Desk>` 居中 + 六大模块顶栏/交互精简 + 大纲标题区净化」，若用户批准 **Option A**，紧接推进 `ArtifactType::Outline` 收口并直接对齐 Wave 2 Loro 内容引擎；若希望本批变更最轻最快落地，可先按 **Option B** 收拢前端心智并在 Wave 2 彻底合并底层。

## Alternatives considered

- **维持「大纲笔记 / 作品 / 素材」三足鼎立现状**：短期不动任何 `pkm` 代码，但用户每次打开内容中心都要在「建一篇笔记」还是「建一篇文档作品」间犹豫，且笔记长期缺失分享到频道、关联工单与右侧协作能力，Wave 2 接入 Loro 时还必须重复适配两套块模型，维护成本高且产品心智割裂。
- **把大纲笔记直接并入现有 `ArtifactType::Docs`，不新增 `outline` 类型**：`docs` 面向章节式长文交付，编辑节奏偏重；强行合并会让随手记与树状缩进大纲丢失轻快体验。保留独立的 `outline` 作品类型既统一了平台底座，又保住了轻量大纲的交互定位。
- **保留 `<Desk>` 的 `flex-wrap`，通过手动加 `pt-1.5` 或修改上游 `nsh` 补偿贴顶**：手工凑 padding 会在窗口缩放或字号变化时重新错位，修改上游 `nsh` 违反禁止改动上游运行时的约束。直接改为单行 `h-9` + `items-center` + `overflow-hidden` 是最干净的根治方案。
- **不写提案直接大范围删改六大模块与 `pkm`**：顶栏去重、状态胶囊搬家以及大纲笔记归属涉及产品心智与存储边界决策，未经拍板直接改代码容易造成返工；先形成可逐项勾选的提案，拍板后可一次性干净落地。

## Acceptance criteria

待用户拍板具体选项并实施后，满足以下验收标准：

1. **顶栏精确居中与 Chrome 净化**：
   - 在 macOS GPUI 真实窗口（浅色与深色两套主题、标准宽度与窄分栏宽度）下，`对话`、`任务`、`工作区`、`内容`、`团队`、`设置` 全部顶栏严格对齐 `36px`（`h-9`），文字与图标精确垂直居中，无贴顶偏移、无纵向裁切。
   - `<Desk>` 标题旁无常驻 `ⓘ`；`设置`、`内容`、`团队` 顶栏右上角不再出现 `● 未启动` 胶囊；`desk-status` 归位后状态表达清晰且可一键跳转运行中心。
2. **六大模块去重与交互整洁**：
   - 工作区对话无 `72px` 双顶栏复读，`chat-cwd-chip` 与状态/Swarm 胶囊严格等高（`h-5`），权限选择器文字与下拉箭头间距紧凑自然。
   - 内容区侧栏切换使用清晰的面板图标（非 `<`/`>`）；同屏永不同时出现两套 `+ 新建` 与两套 `搜索`；侧栏展开时作品页不出现多余 `← 返回`。
   - 大纲笔记标题区无 `pkm-notes-hint` 与 `<Props>` 属性噪音，零反向链接时底部干净收起。
   - 对话侧栏无重复搜索图标；团队子标签有清晰分隔线与紧凑胶囊；任务与团队二级工具栏对齐节奏统一。
3. **大纲笔记归属落地（按拍板路径）**：
   - 若选 **Option A**：`ArtifactType::Outline` 端到端打通契约、服务端、模板、侧栏筛选、分享与右侧协作，相关 `pkm` 遗留复杂属性与强制日记退场，与 [Loro 协作内容引擎](.agents/notes/proposed/architecture/2026-11-22-loro-collaborative-content-engine.md) 容器边界一致。
   - 若选 **Option B**：前端统一归属与标题区净化上线，且保留清晰的 Wave 2 合并接口，不新增额外兼容层。
4. **自动化与视觉门禁全绿**：
   - `vp run mac:check`、`vpx scripts/audit/ui-tokens.ts`、`vp run deadcode`、`vp run docs:verify` 与（若涉及 Rust）`vp run rust:check`、`vp run protocol:check` 全绿；
   - 按 [验收的应用分册](.agents/skills/vv-acceptance/references/app.md) 截取六大模块浅色与深色对比截图，逐张目视确认无回归且 `dump.json` 零错误。

## Risks

- **单行 `<Desk>` 在极窄窗口下的溢出风险**：移除 `flex-wrap` 后，团队页（标题 + 4 个子标签）或内容页（侧栏收起时的搜索与新建按钮）在 `< 640px` 极窄宽度下可能挤压。缓解：标题设置 `min-w-0 truncate`，子标签收紧为 `h-6 px-2 text-xs` 并允许横向容错，并在窄窗尺寸下跑截图验证。
- **`desk-status` 移出 `<Desk>` 后的可发现性变化**：习惯在任意页面右上角看活跃会话数的用户需要适应新位置。缓解：在左侧全局 `Rail` 底部保留常驻、高对比的运行中圆点与数字徽标（悬停提示详情，点击直达 `/runs`），并在有活跃任务时用柔和绿点脉动（受 `motion.ts` 管控）保持全局可见。
- **Option A 迁移存量用户本地 `pkm` 笔记数据的平滑度**：仓库原则规定内部不写复杂历史兼容层，但已在本机写入 Markdown 大纲笔记的用户升级时不应静默丢稿。缓解：保持单次导入或显式 Markdown 导出可读性，并在实施前确认是否需要一次性的本地文件导入命令。
- **工作区 `chat-header` 精简后多标签/单标签的上下文识别**：去掉重复标题与图标后，在多窗格或切换标签时仍需让用户一眼确认当前目录、Swarm 与权限模式。缓解：原生 `panes.rs` 标签栏始终承担当前标签的引擎图标、真实会话标题与活跃态，下方精简条专注呈现目录、Swarm 胶囊、权限策略与终端快捷入口，职责零重叠。
