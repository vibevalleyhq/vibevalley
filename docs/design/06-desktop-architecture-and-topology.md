# 第六篇：系统级桌面架构、全页面清单与状态机拓扑

VibeValley 作为 macOS 全原生桌面应用，将 GPUI 窗口外壳、`nsh` 托管工作台页面、`wgpu` 3D 纸雕场景、菜单栏托盘与刘海灵动岛集成在同一进程树及轻量随行进程中。

## 6.1 macOS 多载体宿主拓扑

| 宿主模块 | 职责与实现位置 | 通信 / 渲染方式 |
| --- | --- | --- |
| **主窗口外壳（`Shell`）** | 管理窗口根视图、菜单栏、热键上下文、原生分屏工作区、纸雕场景栈与 `OpeningView` 遮罩（`apps/mac/src/shell/`） | GPUI 根实体；同时托管最多 3 个 `HostedView`（`workbench` 主路由、`sidebar` contextual 边栏、`inspector` 右侧检查器）及弹出的 `Palette` 命令面板 |
| **进程内通信桥（`BridgeHub`）** | 衔接宿主视图 `call`、`frame:state` 帧广播、`live` 增量事件与流式 `subscribe`（`apps/mac/src/hosted/` 与 `crates/server/src/gateway/bridge/`） | 线程安全通道直连进程内 `vibevalley-server`（无需绕回本地 loopback HTTP） |
| **刘海灵动岛（`apps/island`）** | 悬停在 Mac 刘海位置的常驻态浮窗，实时速览正在运行与等待回应的工单（`Island.swift`、`Geometry.swift`、`apps/mac/src/island.rs`） | `Shell` 启动子进程并通过管道推送 `glance(&frame)`（最多 `12` 条精简行）；窗口配置为无边框 `NSPanel`（`.nonactivatingPanel` + `canJoinAllSpaces` + `mainMenuWindow + 3` 层级），几何参数：`wing: 72`、`tabWidth: 200`、`openWidth: 420`、`rowHeight: 28`、`maxRows = 6`；环境变量 `VIBEVALLEY_NO_ISLAND` 可禁用；点击直接发回工单 ID 唤醒主窗切至 `/issues/:id` |
| **系统菜单栏托盘（`tray.rs`）** | 在系统状态栏驻留 Papertrails 通道托盘图标（`assets/brand/tray-{release,alpha,beta,dev}.png`），显示即时活动摘要并提供「打开主窗 / 退出」（`apps/mac/src/tray.rs`） | AppKit `NSStatusBar` + `flume` 通道通知 GPUI 主线程激活窗口 |

## 6.2 窗口外框、纸雕场景与工作台全页面清单

### 全局导航栏（`Shell.tsx` Rail）与三大角色

全局左侧导航 Rail（宽窗 `76px`、农场模式 `72px`，窄窗 `< 640px` 收窄至 `68px` / `56px` 且隐去按钮文字）负责跨空间导航：顶部锚定通往 `/farm` 的农庄主角头像槽位（右下角带 `frames.link` 连接状态灯）；`globalShell` 下挂载工作区与 6 项一级导航入口（加上底部固定的设置与运行态提示槽位）。未读数字徽标以 `text-bark-900` 深棕墨色落在 `bg-wheat` 麦黄圆丸上，在深浅双主题均保持大于 `7:1` 对比度。

系统围绕三类角色划分可见界面：

| 角色 | 业务定位 | 在工作台中的面貌 | 在纸雕农场中的面貌 |
| --- | --- | --- | --- |
| **用户（`Owner`）** | 提出需求、回答询问、审查变更并合入主分支 | 群聊发言人、工单发起者与批准者 | 农场主（在农庄外框切换视角、用手机呼唤与点按地块/建筑） |
| **助手（`Orchestrator`）** | 唯一的全局协调与派单者，理解对话并维护工单生命周期 | 置顶于 `/agents`、`/orchestrator` 与频道消息流中 | 院内行走的主助手纸雕偶人（6 套江南工坊造型），点击打开助手面板 |
| **帮工（`Worker`）** | 按档案配置在仓库或独立 worktree 中一轮一轮执行代码的编码 agent | `/agents` 中的帮工组卡片、工单负责人、`/runs` 轨迹主体 | 纸雕小动物偶人（熊/兔/狐/猫/柴犬/猫头鹰/刺猬/浣熊），穿梭于地块、书屋、工坊与信号塔 |

### 原生 Papertrails 场景（`apps/mac/src/diorama/`）

| 场景组件 | 对应入口 / 触发 | 交互内容与能力 |
| --- | --- | --- |
| `DioramaView`（`/farm`、`/farm/:repo`） | 主农庄实时 3D 视图（`apps/mac/src/diorama/view.rs`） | 9 块农田地块、可聚焦掀顶的江南院落建筑、4 档昼夜光影循环（`1..4`）、左下农庄手机与内嵌小游戏 |
| `OpeningView` | 应用启动与加载遮罩（`apps/mac/src/diorama/opening.rs`） | 当服务端或工作台尚未就绪时叠盖全窗；展示随本机时段切换的 `assets/brand/opening-{morning,day,night}.webp` 欢迎画与进度条（可通过 `VIBEVALLEY_NO_OPENING=1` 跳过） |

### 工作台全量路由与页面表（`App.tsx` 与 `places.ts`）

| 路由 | 所属空间（`place`） | 页面组件 / 功能说明 |
| --- | --- | --- |
| `/` | 自动跳转 | 读 `prefsNow().start`：`"farm"` 跳 `/farm`，否则跳工作区首项（`/chat`） |
| `/chat`、`/chat/:id` | `chat` | 田头群聊频道列表与无气泡单行实时消息流、斜杠指令 Composer、@ 提及 |
| `/issues`、`/issues/:id` | `issues` | 四列状态看板、搜索与过滤（`issueSearch`）以及独立全页工单详情、差异审查、关闭交付与快捷终端入口 |
| `/runs` | `runs` | 运行中心：查询参数 `?session=&scope=&agent=&issue=` 定位与过滤、7 态运行徽标、助手待批栏 `PendingApprovals`、`WaterfallView` 瀑布图、240 步工作日志与子线程协作进度 |
| `/library` | `content` | 内容中心：笔记（`doc`/`base`/`canvas`/`media`）与媒体素材统一浏览、多选删除与灯箱 |
| `/notes`、`/notes/*` | `content` | Note 3+1 原语工作台（`PageTree` 侧栏、24 块 `doc`、`Base` 四视图、`Canvas` 白板、`Media` 工作台、目录视图与右侧频道侧栏） |
| `/present` | 独立演示全屏 | `doc` 笔记演讲者模式（按 `pageBreak` 分页），独立于常规窗口 Rail 与侧边栏 |
| `/agents`、`/agents/:id` | `agents` | 助手置顶 + 队友列表；点击进入 `AgentConfig` 修改环境、模型、思考深度、技能勾选、MCP 与动物外观（助手的职责/模型/人设/造型由 `OrchestratorProfile.tsx` 承载） |
| `/orchestrator`、`/orchestrator/*` | `agents` | 助手的 `memory`（记性）与 `voice`（语音）配置标签页、跳往 `/runs` 的运行轨迹链接以及 `/orchestrator[/id]/trajectory` 兼容重定向（`OrchestratorPage.tsx`） |
| `/runtimes` | `runtimes` | 环境安装检测、CLI 可用性与额度精力瓶水位仪（`RuntimesPage.tsx`） |
| `/repos` | `repos` | 已接入代码仓库管理、并发槽位上限（`maxSessions`）与项目检验命令配置 |
| `/farm`、`/farm/:repo` | `skin: "farm"` | 农庄主页或指定仓库视角；通过宿主事件在 GPUI 层叠载入 `DioramaView` |
| `/tree` | 重定向 | 重定向至 `/settings/memory` 记忆管理页 |
| `/workspace` | `workspace` | 触发外壳呈现原生代码文件树、Git 变更面板、DiffView、FileViewer 与 GPU 终端分屏区域 |
| `/settings`、`/settings/*` | `settings` | 多分区设置页（外观、密钥、快捷键、MCP、技能库、语音、更新等），支持即时高亮检索 |

未匹配路径与非法参数统一交由 `MissingPage` 兜底展示并给出回首页链接。

## 6.3 核心状态单向流与显式前端状态机

1. **核心状态按域单向输入**：`infra/frame.ts` 按域分别订阅桥接层推送的独立切片（`board`、`sessions`、`collab`、`inbox`、`ops`、`farm`），各切片信号相互隔离并建立按 ID/工单索引供页面 `O(1)` 读取。页面不维护本地工单或帮工状态镜像。
2. **乐观意图四态机制（`state/intent.ts`）**：
   - `useIntents` 管理写请求从发出到核心状态确认的全周期：`queued`（离线/断连排队）→ `sending`（携带幂等键尝试发送）→ `confirming`（已收到服务端回执 `seq`，等待对应切片推进至 `slice.seq >= reply.seq`）→ `failed`（附带可区分是否可重试的 `UiFault`）。
   - `sendReplacing` 支持同类后续操作（如连续开关切换）自动替换未完成的前置意图。
3. **关键显式状态机（模型独立于视图）**：
   - **工单草稿提交（`draftSubmit.ts`）**：管理 `NewIssueDraft` 的表单内容、锁防重放、提交中禁用判定（`isSubmittingDraft` / `canSubmitDraft`）与幂等请求键刷新。
   - **工单交付关闭（`closeFlow.ts`）**：统一协调普通关闭与「差异审查 + 核对后合并」流程，派生弹窗是否展开为双栏宽框（`isCloseDialogWide`）、何时拉取候选 Diff（`isCloseDiffEnabled` / `shouldSyncCloseDiff`）以及目标基准树标识（`sinceTreeOf`）。
   - **运行过滤与选定（`runsView.ts`）**：规范化查询参数读写、作用域划分与会话合并回退选中（`resolveSelectedRun`）。
   - **素材库选择与灯箱（`libraryView.ts`）**：以带标签联合体显式约束 `LibraryScope` 与 `LibrarySelection`，消除「既选中又正在删又开着灯箱」的非法组合状态。

## 6.4 响应式容器与窄窗降级

| 断点 / 阈值 | 作用对象 | 降级行为 |
| --- | --- | --- |
| `< 640px` (`40rem` / `sm`) | 全局 Rail（`Shell.tsx`）与农庄手机（`FarmPhone.tsx`） | Rail 从 `76px` 收缩至 `68px` 且按钮隐去底部文字仅保留居中图标；农庄展开手机宽度不足 `640px` 时收起左侧菜单进入纯聊天布局（`chat_only`） |
| `< 680px` | 队友列表（`AgentsPage.tsx`） | `AgentsPage` 隐藏行内右侧摘要/标签/环境列 |
| `< 768px` (`48rem` / `md`) | 工作台多栏详情页面（`/runs`、`/issues`、`/chat` 等） | 左右分栏退化为单栏列表/详情切换，选中条目后切换详情并呈现「返回」按钮（`issues` 保留面包屑返回栈） |
| `< 1040px` | 原生工作区检查器（`shell/render.rs`） | 右侧文件/Git 检查器栏及拖拽分隔线自动隐去，优先把水平像素留给代码/Diff/终端主视口 |

## 6.5 全键盘操作与快捷键系统

- **工作台快捷键注册表（`apps/mac/ui/design/shortcuts.ts`）**：涵盖 8 大作用域（`everywhere`、`composer`、`lists`、`issues`、`pictures`、`library`、`farm`、`desktop`），包含 `Cmd/Mod+J` 快速切换、`?` 打开 `ShortcutSheet`、`Esc` 逐层关闭弹窗/退出编辑/回到看板、`C` 在工单页快速新建、`Up`/`Down`/`Enter` 列表漫游与回车进入、`Space`/`Delete` 素材库快速预览与删除、农场 `1…6` 切农具、按住 `Alt` 临时透显全员姓名、`Alt+Shift+Space` 全局语音热键。
- **GPUI 原生作用域严格隔离（`apps/mac/src/shell/menus.rs` `bind_keys`）**：
  - 全局级别保留 `Cmd+,`、`Cmd+K` / `Cmd+Shift+P` 调起命令面板、`Cmd+±/0` 缩放字号等；
  - `Cmd+1..9`（切项目）、`Cmd+B`（侧栏开关）、`Cmd+P`（速开文件）、`Cmd+Shift+F`（全库检索）、`Cmd+T`（新终端）、`Cmd+W`（关标签页）、`Cmd+D` / `Cmd+Shift+D`（左右/上下分屏）**全部限定于 `"Workspace"` 键位上下文**，在工作台输入框或表单聚焦时绝不劫持键位；
  - `Cmd+C`/`V`/`K` 等终端按键限定于 `"Terminal"` 上下文；`Escape` 优先级遵循由内向外（输入弹层 → 命令面板 → 灯箱 → 对话框 → 详情页返回列表 / 农场菜单）。

## 6.6 异常容灾、断连降级与结构化错因

- **异步启服与零白屏等待（`LateServer` & `OpeningView`）**：`Shell` 启动时通过 `apps/mac/src/hosted/late.rs` 在后台线程并行拉起 `vibevalley-server`（探针检查、数据库与配置初始化）。服务未完全就绪前，工作台请求与帧订阅在 `LateServer` 的 `OnceLock` 上安全挂起而不报错退出，前台由 `OpeningView` 实时展示启动阶段与进度；若服务端启动彻底失败，`load_error` 与 `OpeningView` 立刻转为明确失败说明。
- **五源结构化故障（`apps/mac/ui/infra/api.ts` `UiFault`）**：所有桥接响应、语音调用错误、客户端异常与网络连接断落统一归一为 `UiFault`（携带 `tag`、`bizCode`、`reason`、`next` 修复指引与服务端定义 `bizCodeMeta[bizCode].retryable` 标志），阻止静默吞错或将原始 JSON 栈抛给用户。
- **断线排队、重放去重与局部补读**：
  - `infra/frame.ts` 监控连接 `Link` 三态（`connecting` / `open` / `lost`）；发送消息与建单流使用 `createRequestKey()` / `newSendKey()` 绑定唯一随机 16 字节十六进制发送键，保证断线重传不产生重复消息或工单。
  - 子线程运行期间发生前端断开时，重连后依靠工作日志最近 `240` 步及服务端摘要字段按 `seq`/`revision` 缝合恢复进度；环境额度即将耗尽时在农场精灵瓶、工作台徽标及托盘同步告警。
