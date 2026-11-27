# 客户端

VibeValley 的主客户端是原生 macOS 应用 `apps/mac`（二进制 `vibevalley-mac`）：GPUI 的窗口，里面带着服务端；工作台的页面是 nsh 跑的 TSX（`apps/mac/ui`），3D Papertrails 纸雕农场与开场由 Rust 直接画（`apps/mac/src/diorama`）。页面按域只读服务端推来的独立切片（`board`、`sessions`、`collab`、`inbox`、`ops`、`farm`）与查询接口，经进程内的桥发命令，不经 HTTP。另提供独立原生移动端应用 `apps/mobile`（`nsh/mobile`，iOS 优先、Android 就绪），通过 `@vibevalley/protocol/remote` 连接 Mac 上默认关闭的受认证远程 HTTP/SSE 门，实现离开桌面时的收件箱分拣、频道回复、会话观察与任务验收。不维护浏览器应用或 Electron 桌面壳。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 窗口外壳：项目栏、侧栏（文件、源码管理）、分栏和标签页、终端、文件和 diff 查看、命令面板、主题和字号 | 核心状态折叠与切片投影（[核心状态](docs/subsystems/core.md)） |
| 在进程里起服务端，放出本机回环的 HTTP 门，写 `server.json`，挂接 `HostDebugBridge` | 服务端内部的组装（[地基](docs/subsystems/foundation.md)） |
| 页面和服务端之间的桥：调用、按域切片推送、事件、订阅，以及强类型 `Host*` 帧、`HostAction` 与 `HostOp` | 协议形状与接口定义（[地基](docs/subsystems/foundation.md#契约规则和数据库)） |
| 工作台：路由、外框、页面的分层、乐观意图与本机存下的选择、浅色和深色主题，以及 `VIBEVALLEY_DEBUG=1` 下的 DevTools 胶囊、浮层与拆窗 | 全页面清单与状态机（[桌面架构与页面清单](docs/design/06-desktop-architecture-and-topology.md)）、设计系统与令牌（[设计系统全景](docs/design/README.md)） |
| 宿主能力（`host.*`）：通知、主题、语言、打开文件和网址、终端、播放声音 | 3D 纸雕场景画什么（[农场的皮](docs/subsystems/farm.md)） |
|  | 命令行（`crates/cli`，[开发](docs/development.md#只用命令行派一个活)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/mac/src/main.rs`、`shell/` | 开窗口并初始化工作区 `tracing_subscriber`（`VIBEVALLEY_LOG`/`RUST_LOG`，`VIBEVALLEY_DEBUG=1` 默认 `info` 否则 `warn`）；根视图 `Shell` 拆为 9 个职责文件（`mod.rs`、`projects.rs`、`panes.rs`、`render.rs`、`menus.rs`、`palette.rs`、`settings.rs`、`host_bridge.rs`、`devtools.rs`），内部收敛为 3 个高内聚子模型（`WorkspaceProjects`、`HostChrome`、`NativeOverlays`）：通过 `SidebarTopics`（`RAIL`、`FILES`、`ALL`）按主题精确推送侧栏帧并经 `on_fs_changes_batch` 与 `dirs_gen`/`git_gen` 合并去重后台文件/Git 刷新；右侧 `inspector` 仅在工作区展开且宽屏时惰性挂载并在收起时回收，命令面板 `palette` 关闭时立即置 `None` 释放 QuickJS VM；同时承载项目、分栏布局、快捷键（`bind_keys`）、宿主接口与 `VIBEVALLEY_DEBUG=1` 悬浮胶囊／`⇧⌥D` 浮层／独立拆窗 |
| `apps/mac/src/hosted/` | 托管视图：一个视图一个 nsh 引擎，按 `is_workbench_view` 分别缓存与惰性装载双入口包（重型工作台 `App.tsx` → `ui/build`；轻量壳窗格 `ShellApp.tsx` → `ui/build-shell`），并在每个视图启动参数注入当前 `connectionMode`；`BridgeHub`（`mod.rs`，信号量并发上限 `BRIDGE_CONCURRENCY = 16`）与 `Outbox`（`bridge.rs`，按 topic 对相邻相同帧载荷去重避免重复序列化与桥派发）及 `frames.rs` 复用 `vibevalley_protocol` 的 `HostAction`、`HostOp` 与强类型 `Host*` 帧（`HostRailFrame`、`HostFileTreeFrame`、`HostGitPanelFrame`、`HostPaletteFrame`），`ShellDebugHandle` 向 `HostDebugBridge` 提供路由、客户端、包模式、回环地址、启动耗时、缓存统计与有界帧耗时（`>= 16 ms` 标慢）；`late.rs` 的 `LateServer` 暴露 `ready_async()` 与零额外 OS 转发线程的切片/实时流透传，启动失败时回落 `FailedServer` 呈现空静态切片与根因错误；`connection.rs` 与 `remote.rs` 实现桌面 `ClientTransport` 的本地合体（默认）与远程控制面模式切换 |
| `apps/mac/src/host.rs` | 宿主能力的原生一半：系统通知、Finder 里显示、`open`、本地文件选择与另存、读文件 |
| `apps/mac/src/audio.rs`、`audio.m` | AVFoundation 文件播放、跳播与有界 PCM 队列；宿主音频命令按桥的接收顺序执行 |
| `apps/mac/src/command_line.rs`、`tray.rs`、`island.rs` | 命令行符号链接、菜单栏摘要、灵动岛进程与工单摘要 |
| `apps/mac/src/terminal/`、`viewer.rs`、`diff.rs`、`markdown_pane.rs` | 终端（`apps/mac/crates/terminal`，经 `coalesce_term_events` 合并突发 `TermEvent::Dirty` 并在 `ACTIVE_OUTPUT_WINDOW` 内复用 `last_status`）、文件查看（经 `vibevalley-rich` 按 TextMate 作用域高亮）、diff 与纯 GPUI Markdown 预览（`MarkdownView` 通过 `vibevalley_rich::native_markdown_root` 与 `App::Rust` 直接渲染 `VvMarkdown`，零额外 QuickJS VM，支持文件监听热更新与主题/字号同步）；加载均带 150 毫秒防闪烁与骨架条 |
| `apps/mac/src/diorama/` | Papertrails 3D 纸雕农场（引擎在 `apps/mac/crates/diorama`）与开场欢迎画（`OpeningView`）（[农场的皮](docs/subsystems/farm.md)） |
| `apps/mac/crates/` | 桌面端独占支撑 crate：`diorama`、`terminal`、`workspace`（项目、布局含 `PaneKind::Chat` 与 `PaneKind::Diorama`、终端与宿主 `state.db` 持久化） |
| `crates/rich/` | 原生富内容组件集（`VvMarkdown` 含 `Doc` 排版、相对图片解析缓存与供纯 GPUI 窗格直连的 `native_markdown_root`、`VvIcon`（[icon.rs](crates/rich/src/icon.rs)，承载 97 枚工作台 reicon 线性图标并以无锁 `OnceLock<Vec<Path>>` 零拷贝共享解析路径；前端 [icons.ts](apps/mac/ui/design/icons.ts) 只保留纯类型 `IconName`，[icons.ts](scripts/gen/icons.ts) 另单源生成 `iconPaths.gen.ts` 供无原生 `VvIcon` 时经 `<Canvas>` + `Path2D` 矢量回退）、`VvI18n`（`"vibevalley/rich"` 导出 `.translate(...)`，由 `installNativeI18n()` 接管 `@vibevalley/i18n`，使生产 UI 包不含 `packages/i18n` JS 词典）、`VvCodeBlock`、`VvDiagram`、`VvCanvas`、`VvChart`（四者经 `run_offloaded` 将大尺寸未缓存渲染移出 UI 线程并用 `LruCache::get_by` 零拷贝查缓存）、`VvGenUi`（按 `(doc_gen, state_rev)` 缓存解析树）、`VvWhiteboard`（含 Loro Phase A 实时在场光标/占位框/一键跟随视口与 `onCursorMove`/`onViewportChange` 回调）、`VvPinyin`）与内部渲染引擎 `engine/` |
| `apps/mac/src/theme.rs`、`apps/mac/src/theme_tokens.rs` | 外壳的主题、动画幅度（`Settings.motion`）与字号设置；令牌从 `design/tokens.json` 同步生成 |
| `apps/mac/src/debug/` | 不看屏幕检查与远程调试应用的入口：VDP 回环调试门（`vdp.rs`）、统一 35 项 `VdpCommand` / 6 项 `VdpNotification` 执行器（`executor.rs`，协议见 [vdp.rs](crates/protocol/src/vdp.rs)）、可选 UI 探针 [vdpProbe.ts](apps/mac/ui/infra/vdpProbe.ts) 与远端／检查器面板 [DevToolsApp.tsx](apps/mac/ui/features/devtools/DevToolsApp.tsx)（[验收](.agents/skills/vv-acceptance/references/app.md)） |
| `apps/mac/src/applet/`、`apps/shim/` | 作品本地轻应用：`AppletHost` 经 `$VIBEVALLEY_HOME/applet.sock` NDJSON 驱动极薄 Swift AppKit Shim（`apps/shim/`）；11 类原生作品走 Plan B2 `CAContext` / `CALayerHost` 跨进程合成，`prototype` 走独立沙箱 `WKWebView`（`connect-src 'none'`），负责 `~/Applications/VibeValley Apps/<作品名>.app` 安装与卸载 |
| `apps/mac/ui/App.tsx`、`ShellApp.tsx`、`workspace/` | 双入口 TSX 包：`App.tsx` 供全量工作台（`vv` / `vibevalley`）与农场视图（`farm-form` / `farm-phone`），`ShellApp.tsx` 专供轻量工作区壳窗格（`devtools`、`sidebar`、`palette`、`workspace-chat`、`probe`；Markdown 预览已下沉为纯 GPUI `MarkdownView`），两份入口启动时均调 `installNativeI18n()` 走原生 `VvI18n` 并挂载 `DesignHostProvider`，按 `host.params.view` 挑视图 |
| `apps/mac/ui/{app,features,design,infra}/` | 工作台共 6 个顶级目录：入口外壳 `app/`（路由表 `Workbench.tsx`、`WorkbenchDesignHost`、6 项一级导航 `places.ts`、外框 `Shell.tsx`）、领域切片 `features/<概念>/`（含二元统一内容中心壳 `content/`、5 栏设置页、Artifact 引擎含右侧 `HistoryPanel.tsx` 历史面板、`outline` 大纲笔记与 `OutlineImportModal.tsx` `.md` 导入、素材库）、共享原语与表面 `design/`（经 `DesignHostContext`（[host.tsx](apps/mac/ui/design/host.tsx)）与 `infra/` 解耦，含动效出口 `motion.ts`、防闪烁骨架原语 `Skeleton.tsx` 与 `Markdown.tsx` / `code/GenUi.tsx` 的 `onGenUiAction` 闭环）、底层运行时与状态 `infra/`（`bridge.ts`、`attachmentFile.ts`、`solid.ts`、`polyfill.ts`、`state/`），另加 `workspace/` 与 `farm/` |
| `apps/mac/ui/design/theme.json`、`apps/mac/ui/nsh.json` | 工作台的令牌：颜色（浅色、深色各一套）、字号、圆角、缓动、阴影（[哲学与令牌](docs/design/01-philosophy-and-tokens.md)），与 `apps/mobile` 令牌一同由 [tokens.ts](scripts/gen/tokens.ts) 从 [tokens.json](design/tokens.json) 生成 |
| `apps/mac/ui/features/setting/RemoteAccessPage.tsx` | Mac 设置页 `/settings/remote`（兼容旧路径 `/settings/connections/remote`）：桌面控制面连接模式（本地内置 / 远程控制面切换与重置）、远程访问开关、局域网直连（同一 Wi-Fi）与可选 Tailscale 跨网地址展示及模式切换、二维码配对（`host.qr`）与已配对设备撤销 |
| `apps/mobile/` | 独立原生移动应用（`nsh/mobile`，iOS + Android 折叠屏／iPhone Duo 自适应）：基于 `@vibevalley/protocol/remote`（[transport.ts](packages/protocol/src/remote/transport.ts)）连接 Mac 远程门，含配对页、4 个一级标签（收件箱、频道、会话、任务；会话与任务行在指定机器时展示轻量机器徽标）、[layout.ts](apps/mobile/src/design/layout.ts) 自适应单／双栏布局与 `<Canvas>` + `Path2D` 97 枚 reicons 渲染 |
| `crates/server/src/gateway/bridge/` | 桥的 Rust 一半：`Hub` 把一个 `Server` 分给多个视图；`fake::FakeServer` 用样例状态和写好的回答顶替服务端 |
| `packages/protocol/src/host.ts` | `Host` 接口：页面能向宿主要的东西 |
| `apps/island/` | 刘海上的灵动岛（Swift）：一个单独的小程序，stdin 收工单摘要，stdout 说点了哪一行（[apps/island/README.md](apps/island/README.md)）；`apps/mac` 从包内带起它，退出时关闭 |

## 模型和不变量

### 进程、内置服务端与远程控制面

- **默认本地合体，支持零代码切换远程控制面**：[connection.rs](apps/mac/src/hosted/connection.rs) 从 `$VIBEVALLEY_HOME/desktop-connection.json`（Unix `0o600` 权限，令牌以 `Secret` 包装并在 `Debug`/`Display` 中脱敏）解析桌面连接模式，并允许环境变量 `VIBEVALLEY_CONTROL_PLANE_URL` 与 `VIBEVALLEY_CONTROL_PLANE_TOKEN`（可选 `VIBEVALLEY_CONTROL_PLANE_LABEL`）优先覆盖供无头或 CI 测试使用：
  - **`Mode::Embedded`（默认，零配置）**：`BridgeHub::install` 在后台线程调 `vibevalley_server::start`，家目录按当前发布通道解析（`VIBEVALLEY_HOME` 覆盖，默认 `~/.vibevalley{,-beta,-alpha,-dev}`，见[设置和配置](docs/subsystems/setting.md#发布通道默认端口与数据目录)），工作目录是 `$VIBEVALLEY_WORK_ROOT`，默认 `~/vibevalley-dev`；起来之前的调用由 `LateServer` 接住（通过 `ready_async()` 与 `subscribe_slice`/`subscribe_live` 透传走 Tokio 异步快速路径，不额外起转发线程），启动失败时以 `FailedServer` 挂接空静态切片并在所有调用返回 `BizCode::ServiceUnavailable` 诊断根因。开场等待服务端、HTTP 地址公告和项目加载都成功；退出应用经 `cx.background_executor()` 异步排空落盘与关机，不阻塞 GPUI 主线程。`apps/mac/src` 中任务统一经 `rt::current_or_global_handle()` 派发，等待使用 `flume` / `Notify` 而非 `std::thread::sleep`。
  - **`Mode::Remote`**：启动时不拉起本机内置 `vibevalley-server`，直接将 [remote.rs](apps/mac/src/hosted/remote.rs) 的 `RemoteServer`（实现 `vibevalley_server::transport::api::Server`）挂到 `BridgeHub` 上。`RemoteServer` 携带 `Authorization: Bearer <token>` 与 `X-VibeValley-Client: remote`，通过 `POST /api/v1/{op}`、`GET /api/v1/slice/{name}`（SSE + `Last-Event-ID` 自动重连，快照走 `?once=1`）、`GET /api/v1/live` 与 `GET /api/v1/subscribe/{name}` 与远程控制面对接，页面、桥与切片消费层零感知切换。
- **桌面控制面连接设置**：[hosted/mod.rs](apps/mac/src/hosted/mod.rs) 拦截 `host.connectionState`、`host.connectionSave` 与 `host.connectionReset` 三个桌面宿主操作，支持在 `/settings/connections/remote`（[RemoteAccessPage.tsx](apps/mac/ui/features/setting/RemoteAccessPage.tsx)）查看当前运行态与持久化配置、通过 6 位配对码（经 `POST /api/v1/remote/pair/exchange` 换领令牌）或 Bearer 令牌保存远程目标，或一键切回本地内置模式并提示重启生效；该分区独立于远端 `remote.status` 渲染，即使当前配置的远程控制面不可达也可随时修改或重置。
- **内置模式另开一道本机的 HTTP 门**：`vibevalley_server::transport::http::serve` 默认按当前发布通道绑定 `127.0.0.1:<默认端口>`（`release` `8787`、`beta` `8788`、`alpha` `8789`、`dev` `8790`）；未显式设置 `VIBEVALLEY_PORT` 且首选端口已被占用（`AddrInUse`）时，应用向 stderr 打印告警并自动回落到空闲端口（`127.0.0.1:0`），显式设置非零 `VIBEVALLEY_PORT` 冲突时直接失败；实际监听地址写进家目录的 `server.json`，命令行据此找到它，帮工的 `/mcp` 也在这道门上。
- **一个服务端只有一个本机用户，远程设备按需配对**：主回环门只听 `127.0.0.1`，本机来的请求直接为 `Caller::User`；远程监听门默认关闭，仅当用户在本机 `/settings/connections/remote` 显式开启并完成一次性配对后，才接受已配对设备的 Bearer 令牌（`Caller::Remote` + `CallerPrincipal::RemoteDevice`，见[受控远程访问](docs/subsystems/core.md#受控远程访问)）。
- **外壳自己的数据按发布通道另存一个库**：项目、布局、外壳的设置按当前发布通道存于 `~/Library/Application Support/VibeValley{,-beta,-alpha,-dev}/state.db`（`VIBEVALLEY_STORE` 覆盖）。宿主库名为 `state.db` 时，nsh 页面在同目录的 `nsh/` 读写。其他库名各用同目录的 `<库名>.nsh/`。服务端使用自己的家目录。已有项目可直接激活。用户按目录打开新项目或关联终端时，宿主在后台读取项目。终端桥在标签创建或复用后返回其标识。

### 工单里的子任务

工单详情和档案的会话轨迹读取服务端的子任务摘要。每行显示任务、最近确认的状态、活动和时间。看板和工单列表也显示等待对象。等待对象与任务创建者分别显示。Codex 等待协作消息时，面板显示等待消息。若任务描述缺失，面板显示厂商提供的名称或线程标识。展开一行可看该线程报告的计划，以及该轮该线程的近期工作日志。日志只保留最近 240 步。较早的步骤移出后，页面仍保留服务端给出的任务摘要。进度连接中断时，面板显示中断时间与最后确认的状态。打开工单的轮次记录可查看以前各轮的子任务。[子任务面板](apps/mac/ui/features/session/SubagentProgress.tsx)

工单的最近轮次带有工作目录核对标记时，看板、列表与详情从会话摘要显示核对提示。新轮执行期间，页面收起上一轮的提示。轮次记录保留历史提示。查看改动会打开该工单当前的 Git 差异。[工单详情](apps/mac/ui/features/issue/views/IssueDetail.tsx)

从看板或列表打开工单后，按 Escape 可回到原卡片。窄窗还会恢复原卡片所在的列。

### 从工单进入终端

右击仓库岛在仓库目录打开终端；右击有帮工的地块和从工单详情进入，都使用会话的 worktree，并以工单号标识标签。再次打开同一命名入口时，若 shell 仍在该目录或子目录，工作区会聚焦原进程。明确带启动命令的入口每次开一个新标签。已经移除的目录在当前窗口显示路径和原因，用户可关闭提示，当前终端不会收到这条启动命令。

在终端中新建标签、向右或向下分屏时，宿主从 PTY 前台进程取得当前本地目录，必要时采用 shell 上报的目录。PTY 启动期间收到的键盘输入、输入法提交和粘贴按原顺序交给新 shell。切换项目保留运行中的进程；重启应用恢复原标签、目录和历史输出，启动新 shell。命名入口的工单号和目标路径存进布局，在子目录退出也能从同一张田找回原标签。[原生终端](apps/mac/src/terminal/mod.rs) · [PTY 会话](apps/mac/crates/terminal/src/lib.rs)

终端标签内运行编码 agent（Claude Code、Codex、Cursor、OpenCode、Kimi、Pi、Antigravity、Grok）时，`AgentTurnTracker` 忽略 300 毫秒内的本地按键回显，并在响铃、3 秒输出静默（`Working → Ready`）或命令退出时发出一次 `TerminalEvent::AgentTurnFinished`（普通命令不触发）。该标签不在当前视图时标记 `attention`；若应用处于后台（`!host::is_app_active()`），外壳以项目目录名为标题通过 `host::notify` 发送 macOS 系统通知。[分栏与通知](apps/mac/src/shell/panes.rs)

### 工作区直连对话、Markdown 预览与统一顶栏交互

- **工作区直连对话（`PaneKind::Chat`）与 Swarm 观测**：与 `Terminal`、`File`、`Diff` 同级存入项目 `Layout` JSON（[layout.rs](apps/mac/crates/workspace/src/layout.rs)），不新增独立数据库表；重启后按需惰性挂载 `HostedView("workspace-chat")` 并续接原 `session_id`。标签栏收敛为单个 `+` 下拉菜单（新建终端及 Antigravity / Claude / Codex 直连对话，保留 `⌘T` 与 `⇧⌘T`，支持点击外部与 `Esc` 关闭）；[ChatPane.tsx](apps/mac/ui/workspace/ChatPane.tsx) 经 `session.watch` 呈现流式 Markdown、思考折叠块、工具卡片、永不自动批准的 `interaction_*` 确认卡片、轮中引导（Steer）与按需展开的内联遥测胶囊，输入区收敛为三行单卡 Composer（顶部按需展示经 `host.pickFile` 挂载的文件标签、中间无边框两行输入、底部单行集成引擎/模型/思考深度/遥测/发送）。会话触发 Antigravity Swarm 时，顶栏展示 `Swarm · N/M` 胶囊并可展开三标签抽屉 [SwarmPanel.tsx](apps/mac/ui/workspace/SwarmPanel.tsx)（总览、成员与 `session.childTranscript` 下钻、黑板 `@mention` 与成员筛选）；点击工具卡片经 `OpenFileAdjacent` / `OpenDiffAdjacent` 在相邻分栏打开对应文件行或 diff（单栏时自动向右分屏）。
- **真实会话标题与工作区侧栏状态**：直连对话将真实运行时标题（优先 `ev.title`，其次 Swarm 标题，最后截断首条用户输入）经 `update_chat_tab` 同步到标签栏与侧栏；[ChatPane.tsx](apps/mac/ui/workspace/ChatPane.tsx) 顶栏收敛为清爽单行 `h-8` 上下文动作条，移除与上方 `36px` 原生标签栏重复的引擎图标和会话标题，`chat-cwd-chip` 锁定 `h-5` 与状态/Swarm 胶囊严格等高，权限选择器 `chat-permission-mode` 采用紧凑自适应 `<Menu>` 触发器消除固定宽留白。终端标签在 [panes.rs](apps/mac/src/panes.rs) 经 `resolve_terminal_name` 与 `clean_osc_session_title` 清洗旋转指示符与冗余前缀后显示真实标题或编码引擎名。工作区侧栏（[Sidebar.tsx](apps/mac/ui/workspace/Sidebar.tsx)）标签行悬停时显示 `⋯` 菜单（新建对话/终端、在 Finder 中显示、复制路径、关闭标签）替代裸 `×` 按钮，运行中状态收拢到左侧图标下方跑马灯条与角标点。
- **全工作台统一 `36px`（`h-9`）顶栏、交互精简与原生标题栏拖拽**：工作台各模块顶栏（`<Desk>`、频道、工单、笔记、队友、设置、Markdown 预览与工作区标签栏/侧栏）统一对齐到 `36px`（`h-9`）基线。[Shell.tsx](apps/mac/ui/app/Shell.tsx) 仅在没有独立顶栏的页面渲染 `<Desk>`（`/issues` 与 `/chat`、`/library` / `/artifacts`、`/runtimes` 同样省略 `<Desk>`，由自身工具栏与详情顶栏承担 `desktop={{ windowDrag: true }}`），`<Desk>` 与内层左侧行移除 `flex-wrap`/`py-0.5`，改为严格单行定高 `h-9 items-center`（标题 `min-w-0 truncate`）消除 Yoga 多行对齐贴顶；[Tabs.tsx](apps/mac/ui/design/Tabs.tsx) 的 `pills` 移除 `flex-wrap` 并收紧至 `h-6 text-xs`，`队友` 标题与 4 个子标签间以 `h-4 w-px bg-line` 细线分隔。[ChatPage.tsx](apps/mac/ui/features/channel/views/ChatPage.tsx) 在宽屏（视口 `>= 960px` 且主栏宽充足）将二级标签（对话 / 工单 / 定时任务）以 `pills` 样式折叠进 `h-11` `channel-head` 中，窄屏（`< 960px` 或打开侧栏导致主栏较窄时）回退到二级行，确保 `720–960px` 无截断。`<Desk>` 移除了无增量的常驻 `<Hint>`（`ⓘ`）与静态页错位的右上角 `desk-status`（`● 未启动`），改在左侧全局导航 `Rail` 底部（「设置」上方）放置克制的 `rail-runs-status` 运行态入口（`working > 0` 显示绿点与运行数，空闲态静默无误导文案，悬停 `Bubble` 提示并可点击直达 `/runs`）。其余高频去重包括：[ChannelSidebar.tsx](apps/mac/ui/features/channel/views/ChannelSidebar.tsx) 移除紧贴 `switcher-open`（`跳到… ⌘J`）上方的重复 `farm-search-open` 按钮；[IssuesPage.tsx](apps/mac/ui/features/issue/views/IssuesPage.tsx) 与 [AgentsPage.tsx](apps/mac/ui/features/agent/AgentsPage.tsx) 校准二级工具栏 `px-3.5` 节奏并弱化次级动作以突出唯一主按钮。[main.rs](apps/mac/src/main.rs) 启用 `app_owns_titlebar_drag: true`，GPUI 原生顶栏空白处（`render.rs` / `settings.rs`）与 TSX 托管顶栏（`desktop={{ windowDrag: true }}`）共同支持 macOS 原生窗口拖拽（`start_window_move`）与双击放大（`titlebar_double_click`）。
- **纯 GPUI Markdown 预览与 `genui` / `chart` 闭环**：[markdown_pane.rs](apps/mac/src/markdown_pane.rs) 以原生 GPUI `36px` 顶栏（文件名、截断父路径、「源码」、复制路径、重载、Finder 显示与 `$EDITOR` 打开）加 `vibevalley_rich::native_markdown_root`（纯 Rust `App::Rust` 居中 `820px` `VvMarkdown` 阅读列，零额外 QuickJS VM）直接渲染 `.md` 文件，支持文件监听热重载、150ms 防闪烁骨架与主题/字号同步。`crates/rich/src/markdown.rs` 将相对图片路径解析为规范绝对路径并同步读取本地栅格图尺寸按比例缩放（缺失时展示显式占位徽章），相对文档链接按文档目录经 `OpenFile` 在工作区打开，外链经系统打开；频道消息（[MessageParts.tsx](apps/mac/ui/features/channel/views/MessageParts.tsx) / [MessageList.tsx](apps/mac/ui/features/channel/views/MessageList.tsx)）与工作区窗格（[ChatPane.tsx](apps/mac/ui/workspace/ChatPane.tsx)）已接通 `VvMarkdown` 与 `GenUi.tsx` 的 `onGenUiAction` 回调，并与 `chart` 图表栅栏块配合渲染。
- **150 毫秒防闪烁与统一加载态**：原生 `FileViewer`、`DiffView`、`DioramaView` 与 TSX 侧的 `useDelayedBusy` / `SkeletonBar` / `SkeletonLines`（[Skeleton.tsx](apps/mac/ui/design/Skeleton.tsx)）统一在 150 毫秒内不闪烁加载占位，超时后展示柔和骨架条，覆盖文件树、Git 面板、命令面板、Markdown 预览、笔记与作品冷加载。

### 桥

页面经 nsh 的 `host.post("action", …)` 发动作，Rust 经 `HostChannel` 的事件回（`crates/server/src/gateway/bridge/mod.rs` 开头的表）：

| 页面（`apps/mac/ui/infra/bridge.ts`） | 动作 | 回来的事件 |
|---|---|---|
| `call(op, payload)` | `call` | `reply:<id>`，契约的信封 `{ bizCode, message, data?, error? }` |
| `slice(kind, listener)` | `watch`（`topic: "slice:<kind>"`）、`unwatch` | `frame:slice:<kind>`，6 路独立域切片（`board`、`sessions`、`collab`、`inbox`、`ops`、`farm`）。页面用 `applied` 确认修订号，慢窗口可跳过中间修订。 |
| `frame("live")`、`onLive(fn)` | `watch` | `frame:live`，每个事件一个 `LiveEvent` |
| `subscribe(name, payload, on, ended)` | `subscribe`、`unsubscribe` | `sub:<id>`，每个事件一次，结束一次 |
| `hostApi.<名字>` | `call`，`op` 是 `host.<名字>` | 外壳的 `Shell::host_call` 答 |

- **`call` 不抛**：失败是 `bizCode` 非 0 的信封；没有宿主或超时回 `ServiceUnavailable`。关闭工作区对话标签页直接经 `Server::call("session.closeWorkspace", ...)` 停机回收，不经进程全局静态锁；音频与语音句柄经 `Server::speech_streams()` / `Server::voice() -> Option<SharedLiveVoice>`（`LiveVoicePort`）获取，桌面宿主 `apps/mac/src/` 不导入 `vibevalley_server::<domain>::*`（由 `cargo xtask audit` 守住），`LateServer` 同步转发 `subscribe_with`、`voice` 与 `remote_auth`，启动期经 `Started::set_mcp_url` 注入 `/mcp` 地址。
- **工作台按 6 个一级入口与 5 栏设置组织**：左侧导航主栏（`places.ts`）固定收敛为频道（`/chat`）、工单（`/issues`）、项目（`/repos`）、笔记（`/library`）、队友（`/agents`）与设置（`/settings`）6 项一级位置；环境（`/runtimes`）与运行中心（`/runs`）作为次级/工具入口可达；设置页收拢为「通用 / 模型 / 语音 / 连接 / 关于」5 栏，所有面向用户的菜单与设置沿用日常中文词汇（如模型、成员、设置），避免内部工程缩写或农场隐喻外溢。
- **统一作品中心、上下文模板与工作区预览**：`/library` 与 `/artifacts/*` 共用嵌套布局 `ContentShell`（`apps/mac/ui/features/content/`），提供可折叠统一侧栏 `ContentSidebar`（收敛为「作品（含一等 `outline` 大纲笔记与 `.md` 导入）+ 素材」二元模型，并在宿主支持 `applet` 能力时提供「已安装应用」独立筛选视图与作品卡片一键「安装为桌面应用 / 打开独立应用」入口，`⌘\` 切换，全屏演示 `contentPresenting` 时自动收起）、统一搜索 `ContentSearchModal`、`.md` 大纲导入弹窗 `OutlineImportModal`（经 `hostApi.pickFile()` 选文件、拖放或粘贴调用 `artifact.outline.import`）与 65 套双语模板库 `TemplateModal`（`⌘N` 或 `+ 新建` 打开；位于具体作品类型分区或详情页时自动预选对应类型分页）；[LibraryPage.tsx](apps/mac/ui/features/media/LibraryPage.tsx) 工具栏支持按关联仓库、计划/工单与频道归属联动筛选作品与素材（窄屏收起为筛选浮层），媒体库仅在支持 AI 生成的类别（全部/图片/音频）展示「生成」入口，视频与其它不支持；右侧 `HistoryPanel` 收敛版本快照与历史回放。`ContentShell` 持续记录当前作品路径（剥离 `?make=`/`?nav`/`?understand` 瞬态参数），离开再点左栏「作品」或访问 `/content` 时经 `safeLastContentPath()` 恢复上次视图。工作区文件树点击暂不支持应用内预览的二进制/文档格式（如 `.pdf`、`.zip`、音视频等）时，以锚定浮层询问「用默认方式打开」或「在应用内打开」，原生二进制/超大占位卡同步提供「用默认方式打开」与「在 Finder 中显示」。
- **工作台的请求只经 `Transport`**（`apps/mac/ui/infra/transport.ts`）：`VibeValleyApi.over` 直接在契约信封上收发，不绕合成的 HTTP `Request`/`Response`；应用里是桥（`bridged.ts` 的 `useBridge()`），测试和故事换成基于 `SliceBundle` 的替身（`infra/fixtures.ts`）；页面的代码不直接碰 `host`。

### 页面状态与数据流

- **三层 UI 状态边界与单窗口显式 FSM**：跨视图共享的领域投影（`BoardSummary`、`BoardIssueSummary`、`IssuePromptKind`、`MediaSummary`、`ChannelSummary`）由 `vibevalley-core` 统一折叠随切片下发；单窗口多步瞬态交互收口在纯 TypeScript 判别联合与无副作用 `transition(state, event)` 状态机（[closeFlow.ts](apps/mac/ui/features/issue/model/closeFlow.ts)、[draftSubmit.ts](apps/mac/ui/features/issue/model/draftSubmit.ts)、[libraryView.ts](apps/mac/ui/features/media/libraryView.ts)），TSX 层只做穷尽 `switch` 渲染与事件派发；热点选择器（如 `usePrefs`、`composing.ts` 的 `canSend`/`stoppable`/`here`）以 `computed()` 记忆化避免无关重算。
- **页面按域只读独立切片**：`infra/frame.ts` 为 `board`、`sessions`、`collab`、`inbox`、`ops`、`farm` 维护各自独立的响应式信号（`useBoardSlice`、`useSessionsSlice`、`useCollabSlice`、`useInboxSlice`、`useOpsSlice`、`useFarmFrame`），单域变更不触发其他域消费者重算；外壳（`shell/mod.rs`）与灵动岛（`island.rs`）直接订阅 `SliceKind::Sessions` / `SliceKind::Inbox`；按 id 的列表用 `Each` 保住行。
- **草稿去抖与持久化写入合批**：频道输入框（[composing.ts](apps/mac/ui/features/channel/model/composing.ts)）在内存中保留实时草稿缓冲，并以 `250 ms`（`DRAFT_DEBOUNCE_MS = 250`）防抖写入持久化草稿；Mac 端 [storage.ts](apps/mac/ui/infra/state/storage.ts) 的 `createPersistentStorage` 与移动端 [storage.ts](apps/mobile/src/infra/storage.ts) 的 `createCoalescedStorage` 均通过按键合并队列将连续 `setItem` / `removeItem` 折叠为最新状态并串行落盘，提供 `flush()` 与内存回退，避免逐键击发写盘放大。
- **工作区与移动端即时乐观交互与回滚**：工作区 [ChatPane.tsx](apps/mac/ui/workspace/ChatPane.tsx) 在发送或引导插话时立即插入本地临时 `user/message` 占位（`inFlightOptimistic`），待服务端历史确认到达或发送失败时按原草稿、附件与阶段状态精确清理或回滚；移动端 [session.ts](apps/mobile/src/infra/session.ts) 在 `session.respondPermission` / `session.respondInteraction` 成功后乐观清除对应待批条目，频道发送（[ChannelsTab.tsx](apps/mobile/src/features/ChannelsTab.tsx)）失败时在界面展示显式错误并触觉反馈。
- **UI 目录单向依赖**：`infra` → `design` → `features` → `{app, farm, workspace}`，`app`、`farm` 与 `workspace` 之间互不引用；由 `oxlint` 的 `vibevalley/ui-layer-boundaries` 规则拦截。
- **状态中间层是 `state/`**：跨组件的状态 `defineAtom`（`atom.ts`）、本机存下的选择 `defineStored`（`stored.ts`、`prefs.ts`）、乐观意图 `defineIntent`（`intent.ts`）。
- **乐观意图等切片 `seq` 追上后结算**：`Intent` 是按 `phase` 区分的判别联合；写操作带 `requestKey` 或 `sendKey` 叠在当前切片上，等到对应切片的 `slice.seq >= reply.seq` 或频道出现对应消息才结算。
- **错误是结构化的 `UiFault`**：`infra/api.ts` 的 `faultOf` 从信封里取出六位 `bizCode`、`reason`、`next`、`settings` 和由 `bizCodeMeta` 决定的 `retryable`，只挂在失败或降级的分支上。
- **一次性读取走 `infra/query.ts`**：自有的 Query client 管缓存与失效，结果先经 Schema 解码。会话轨迹经 `features/session/runs.ts` 的 `SessionLogs` 先订直播流、再读快照并按 `seq` 与 `revision` 合并。
- **按概念分 feature**：`features/<概念>/` 的名字和服务端的模块、契约的文件夹一样；路由表、导航和设置的分区以代码为准，这里不抄。

### 宿主

- **宿主接口封闭，缺的能力就是没有**：页面经 `infra/host.ts` 的 `currentHost()` 看能力在不在，不按宿主的名字分支；没有宿主时（无头的测试和故事）是只有名字的那一个。
- **外壳答的能力以 `host.info` 报的为准，并在边界一次解码为 `HostOp`**（[host.rs](crates/protocol/src/contract/host.rs)、[host_bridge.rs](apps/mac/src/shell/host_bridge.rs)）：全部 `host.*` 调用经 `HostOp::from_wire(op, payload)` 一次性解码为封闭枚举后穷尽分发，不留裸 JSON 字段读取。涵盖通知、托盘摘要、语言、Finder 里显示、主题、动画幅度（`motion`）、字体和字号、开场、开终端、打开网址和文件、素材根目录（`host.assetsDir`）、哈希/随机数/二维码、音频播放与跳播、PCM 流、读文件、选择与另存文件、更新与安装命令行。
- **DevTools 门禁与双态挂载**（[devtools.rs](apps/mac/src/shell/devtools.rs)、[DevToolsApp.tsx](apps/mac/ui/features/devtools/DevToolsApp.tsx)）：仅 `VIBEVALLEY_DEBUG=1` 时启用；关闭态不渲染悬浮胶囊、不建 `HostedView("devtools")`、不记录帧耗时且忽略 `ToggleDevtools`。开启后窗口底边显示 5 信号悬浮胶囊（通道与端口、路由、活跃会话与订阅、最新 `seq`、最近帧耗时），点击或按 `⇧⌥D` 展开底部浮层，并可经 `HostAction::{ToggleDevtools, DetachDevtools, CloseDevtools}` 拆出为独立 GPUI 窗口；界面复用 `HostedView("devtools")`（`ClientKind::DevTools`）呈现 Overview（含实时拓扑）、Routes、Timeline、Trajectory、State & Cache 与 Lab & Overrides 六个视图。
- **动画幅度统一收口与测试覆盖**：设备本地设置 `Settings.motion`（`off | on | system`，默认 `system`，存于 `state.db` 的 `app.settings`）由外壳按 `effective_motion()` 解析，并经启动参数 `params.motion`、`host.info` 与 `"motion"` 事件同步到全部托管视图（工作台与工作区）。`VIBEVALLEY_NO_ANIMATION=1`（`1` 或 `true`）覆盖用户设置强制生效为 `off`（`scripts/audit/ui-gallery.ts` 默认注入），不会改写落盘设置；生效为 `off` 时同时跳过 `OpeningView`、暂停终端光标闪烁并停止纸雕场景的持续动画泵。TSX 页面所有过渡、关键帧与弹层动画都经 `apps/mac/ui/design/motion.ts`（`motionOff`、`motionClass`、`motionDuration`、`fadeAnimation`、`popupTransition`）收口，`system` 档自动跟随 `nsh` 的 `reduceMotion()`；`scripts/audit/ui-tokens.ts` 的 `color-transition` 与 `unmanaged-motion` AST 规则在静态检查时拦住绕过 `motion.ts` 的裸过渡、关键帧与未托管弹层动画。
- **命令行安装只管理自己的链接**：把包内 `Contents/MacOS/vibevalley` 链到 `~/.local/bin/vibevalley`，不覆盖已有文件或其他安装的链接；页面显示 PATH 是否包含这个目录。
- **音频有序、有界**：文件经 AVFoundation 播放，跳播的秒数应有限且非负；PCM 是 16-bit little-endian、8–192 kHz 的单声道或双声道。宿主命令按接收顺序执行后回包，PCM 待播放队列最多五秒，满了明确拒绝。Flash 生成由用户明确点开始后，宿主持有服务端的 SpeechClaim，按 format 和 sequence 顺序拉取；播放队列满时可取消地等待容量，done 后等真实播放耗尽再释放引擎。页面只收播放状态，离开或停止时取消尚未结束的本机任务。
- **附件与媒体文件留在本机（零 Base64 直写 CAS）**：本地合体模式（`connectionMode === "embedded"`）下，拖入对话或素材库的本地文件经 `importLocalAttachment`（[attachmentFile.ts](apps/mac/ui/infra/attachmentFile.ts)）调用仅限本机用户（`Caller::User`，严格拒绝 `Caller::Remote`）的 `attachment.importPath`，由服务端流式校验、计算 SHA-256 并落盘至 CAS，避免大文件经 JS Base64 中转；远程控制面模式自动回落到 `host.readFile` + `attachment.create`。音频选择返回路径与元数据，`media.input.uploadFile` 沿媒体输入的大小、容器、内容与额度校验流式写入；`media.input.file` 读回已校验的输入路径。原生文件接口不经 HTTP 暴露。大结果播放和另存直接读取本地路径，不把整份文件搬进页面。
- **默认关闭 CoreGraphics 字体平滑膨胀**：`main.rs` 启动最早期（GPUI 初始化前）调 `host::disable_default_font_smoothing()`，当 `CFPreferencesCopyAppValue("AppleFontSmoothing", kCFPreferencesCurrentApplication)` 未设置时，向内存域 `NSRegistrationDomain` 注册 `AppleFontSmoothing = 0`（不写用户 plist），避免 CoreGraphics 对终端和工作台字形施加 10–22% 笔画膨胀；若用户经命令行参数或 `defaults` 显式设置了 `AppleFontSmoothing` 则保持原值。
- **纸雕场景归外壳画**：`/farm` 与 `/farm/<仓库>` 的页面只发 `openFarm`，外壳在同一个位置换上 `DioramaView`；纸雕视图要去工作台的某一页时发 `DioramaEvent::Route`，要开终端时发 `DioramaEvent::Terminal`。

### 移动端与远程访问

- **Mac 设置入口（`/settings/remote`）与双接入模式（局域网直连 vs Tailscale 跨网）**：[RemoteAccessPage.tsx](apps/mac/ui/features/setting/RemoteAccessPage.tsx) 挂在设置「连接与集成」下，调用 `remote.status`、`remote.enable`、`remote.disable`、`remote.pair.create` 与 `remote.device.revoke`，支持两种移动接入模式，经 `host.qr` 渲染 `vibevalley://pair` 二维码与 6 位一次性配对码、按 6 类 `RemotePlatform`（`ios`、`android`、`cli`、`machine`、`sandbox`、`other`）展示对应 reicons 与双语标签，并支持复制配对链接和即时撤销设备：
  - **局域网直连（同一 Wi-Fi，默认零依赖）**：服务端通过纯 Rust 标准库 UDP 路由探测（[lan.rs](crates/server/src/gateway/remote/lan.rs)）检测本机非回环私网 LAN IPv4（`lanIp`）。未安装或未连接 Tailscale 时不阻塞开启远程访问，自动绑定检测到的局域网 IPv4（无可用局域网接口时回落 `127.0.0.1`）并签发对应局域网配对链接与一次性配对码，供同一 Wi-Fi 下的手机直接扫码或输入地址连接。
  - **Tailscale 跨网（可选增强）**：当检测到本机 `tailscale` 已安装且在线时，`RemoteStatus` 同时暴露 `lanIp` 与 `tailscaleIp` / `tailscaleHost`；面板保留两行地址展示并提供模式切换开关（调用 `remote.enable({ bindAddr })` 在局域网直连与 Tailscale 跨网地址间即时重绑切换），方便用户在同网直连与跨网加密访问间按需选择。
- **独立原生外壳 `apps/mobile/` 与折叠屏／iPhone Duo 自适应布局**：基于 `nsh/mobile` 接入原生 `TabBar`、`Haptics`、`Storage`、`UrlScheme`（截获 `vibevalley://pair?url=...&code=...` 深链自动配对）与 Android `BackHandler`，无桌面工作区和像素农场；[layout.ts](apps/mobile/src/design/layout.ts) 以响应式 `windowSize()` 与四边 `safeArea()` 按 `DUAL_PANE_MIN_WIDTH = 600` 切换两种布局态：
  - `compact`（`< 600`）：单栏列表／详情视图 + 底部原生 `TabBar`（按 `platform.select` 分别传入 iOS SF Symbols 与 Android 系统图标，并在详情态由 Android `BackHandler` 优先返回列表）。
  - `dual_pane`（`>= 600`，适配展开后的 Android 折叠屏如 Pixel Fold `841×701 dp` 与 iPhone Duo `744–840 pt`）：隐藏底部 `TabBar`，改为 `72px` 左侧导航栏（`NAV_RAIL_WIDTH = 72`）+ 4 个标签共享的主从 `<SplitPane>` 双栏视图与居中配对卡片；选中项统一托管在根组件，折展切换时保持详情连续不丢态。无移动端原生宿主时（如无头 `nsh test`）自动退化到同令牌组件。
- **零平台依赖传输层（`@vibevalley/protocol/remote`）**：[transport.ts](packages/protocol/src/remote/transport.ts) 仅用 Web Fetch、`AbortController`、`ReadableStream`、`TextDecoder` 与 Zod 信封校验实现 `HttpRemoteTransport`、`parsePairUrl`、`normalizeServerUrl` 与 `pairWithServer`，按需订阅业务切片并通过 `Last-Event-ID` 合并单条指数退避定时器续读（支持 `AbortSignal` 预取消与在途取消），遇 `401` / `403` 立即停连并上报 `unauthorized`。
- **97 枚 reicons 矢量回退与令牌单源**：[icons.ts](scripts/gen/icons.ts) 从 [icon.rs](crates/rich/src/icon.rs) 提取全部 97 枚图标路径（含填充、描边、线帽、拐角、`evenodd` 与透明度）写出 `iconPaths.gen.ts`；在无原生 `VvIcon` 的载体（`apps/mobile` 及非 GPUI 回退）中由 `<Canvas>` + `Path2D` 按 `size / 24` 缩放绘制（[Icon.tsx](apps/mac/ui/design/Icon.tsx)）。[tokens.ts](scripts/gen/tokens.ts) 同步从 [tokens.json](design/tokens.json) 写出 `apps/mobile/design/theme.json` 与 `apps/mobile/nsh.json` 的 Tailwind 令牌配置。

## 怎么走

**打开**

1. `main.rs` 开窗口，建 `Shell`；`Shell` 先盖上开场欢迎画（`OpeningView`，设了 `VIBEVALLEY_NO_OPENING=1` 或生效动画幅度为 `off` 时跳过），同时在后台读项目和设置、起服务端。
2. 项目读进来后开场说「好了」，约 0.9 秒后让开；读不进来时开场停在失败上，说原因。
3. 工作台的视图以 `route` 和 `globalShell` 两个参数打开，路由变了发 `global_route` 告诉外壳。

**构建 TSX 包**

1. `apps/mac/build.rs` 用 nsh 的命令行（`NSH_BIN`、仓库的 `.tools/bin/nsh` 或 `PATH` 里的）按双入口分别打包：全量工作台与农场视图 `apps/mac/ui/App.tsx`（`ui/build`，承接 `vv`、`vibevalley`、`farm-form`、`farm-phone`）与轻量工作区壳窗格 `apps/mac/ui/ShellApp.tsx`（`ui/build-shell`，仅含 `devtools`、`sidebar`、`palette`、`workspace-chat`、`probe`），运行时由 `hosted/mod.rs` 按 `is_workbench_view` 分别缓存与惰性装载；两份入口均经 `installNativeI18n()` 接入原生 `VvI18n`（`"vibevalley/rich"` `.translate(...)`），生产包不再打入 `packages/i18n` JS 词典目录。
2. 调试构建从磁盘读 `apps/mac/ui/build/` 与 `apps/mac/ui/build-shell/`，改 TSX 不用重新编译 Rust；发布构建（或设了 `VIBEVALLEY_EMBED_UI`）开启 `nsh build --release`，仅单份静态嵌入剥离调试信息的 `bundle.nshc` 字节码（`bundle.js` 置 0 字节 sentinel 避免双嵌）。
3. 没有 nsh 时调试构建仍可通过，应用里的视图报缺包；发布构建直接失败。

### 打包和更新

`scripts/release/package.ts` 与 [package-platform.ts](scripts/release/package-platform.ts) 将应用（`vibevalley-mac`）、命令行（`vibevalley`）和灵动岛放进 `.app/Contents/MacOS`，按发布通道设置独立包标识（`dev.vibevalley.app{,.alpha,.beta,.dev}`），将静态素材（`assets`，经 `scripts/release/package-assets.ts` 的 `shouldPackageAsset` 过滤仅官网使用的 `assets/site/`）、通道图标与经 `xcrun actool` 从全出血通道 PNG（`appicon-{release,alpha,beta,dev}.png`）编译出的 Tahoe `Assets.car` 放进 `Contents/Resources`（两份 `--release` 字节码已直接嵌入 `vibevalley-mac` 二进制，不再向 `Contents/Resources/ui` 复制开发页面包），并产出带 Retina 背景的 DMG 与 ZIP 安装包。应用从自身包定位资源，不依赖构建仓库的位置；`release.json` 记录版本、架构、ZIP 文件名、字节数和 SHA-512。

`apps/mac/src/update` 只在打包版本上按通道包名启动更新检查，启动时和每 30 分钟各检查一次（[fetch.rs](apps/mac/src/update/fetch.rs) 匹配通道包名与归档）。稳定版读最新正式版，alpha、beta 各读同阶段最新版本；仓库运行和 `0.0.0`（`Feed::Off`）初始化为 `disabled` 态，不误报「已是最新版本」。`VIBEVALLEY_UPDATE_FEED=off` 关闭检查，指定清单 URL 可验证本地更新：

- **非阻塞检查与推送优先**：`UpdateOp::Check` 在后台任务启动检查并立即返回（`apps/mac/src/update/updater.rs`）；`Updater` 经 `tokio::sync::watch` 持有最新状态，变化时通过 `HostedView` 推送 `update_state` 事件，页面边界经 `UpdateState.safeParse` 解码，仅保留 `60 秒` 低频兜底拉取。
- **9 态显式状态机与 7 类失败分类**：[host.ts](packages/protocol/src/host.ts) 定义 9 个 `UpdateState` 分支（`disabled`、`idle`、`checking`、`downloading`、`verifying`、`ready`、`installing`、`manual`、`failed`）与 7 种 `FailureKind`（`network`、`rateLimit`、`integrity`、`signature`、`permission`、`install`、`unknown`）；[UpdateRow.tsx](apps/mac/ui/features/setting/UpdateRow.tsx) 穷尽渲染全部分支，[Shell.tsx](apps/mac/ui/app/Shell.tsx) 点击 `rail-update-btn` 始终打开克制的更新预览弹窗（含版本变更、活跃会话提醒、「下次退出时更新」与「立即重启更新」），不静默退出。
- **可续传下载与 ETag 缓存**：下载写入 `$VIBEVALLEY_HOME/updates/<version>/update.zip.part`，支持 HTTP `Range` 断点续传（`206` 追加、`200` 截断重写、`416` 重置）、`backon` 指数退避重试、约 `200 ms` 节流字节速率遥测与 `EtagCache`（`If-None-Match` / `304` 复用，避免 GitHub API 限流）；进入 `ready` 后清理旧版本暂存与残留临时目录。
- **原子替换与下次启动恢复**：更新包的大小、SHA-512、归档路径、通道包名和同团队 Developer ID 签名全部通过后进入 `ready`；DMG、系统转移位置或不可写目录进入 `manual`。`swap(true)` 先推 `installing` 再复制 `.app` 并拉起独立 `swap.sh`；`swap.sh` 将日志写入 `$VIBEVALLEY_HOME/updates/swap.log`，失败回滚时原子写出 `swap-failed.txt`，下次 `Updater::from_env()` 启动核对版本后呈现 `failed(kind = "install")`（已升级成功则静默清除）。普通退出仍由 `on_app_quit` 静默替换，原包保留在 `.VibeValley-previous-<pid>.app`，不迁移用户数据。

### 本地轻应用与 VDP 远程调试

- **Artifact 安装为本地轻应用（Stage 0–2）**：[installer.rs](apps/mac/src/applet/installer.rs) 将作品安装至 `~/Applications/VibeValley Apps/<作品名>.app`（`CFBundleIdentifier: dev.vibevalley.applet.<artifact_id>`、`.icns` 图标、ad-hoc `codesign` 与 `lsregister -f`），运行期零修改包内文件以保签名不失效；极薄 Swift AppKit Shim（`apps/shim/`）经 `$VIBEVALLEY_HOME/applet.sock` NDJSON 协议与宿主 [host.rs](apps/mac/src/applet/host.rs) 通信（宿主未运行时静默拉起）。11 类原生作品通过方案 B2 `CAContext` / `CALayerHost`（[remote_layer.rs](apps/mac/src/applet/remote_layer.rs)）由 WindowServer 跨进程 GPU 合成，`prototype` 由 Shim 内置沙箱 `WKWebView`（`connect-src 'none'`）直接渲染；Stage 3 增强能力（菜单栏常驻、作品 KV、全局快捷键与便携导出）暂延后。
- **VDP 远程实时调试（`apps/mac/src/debug/`、`crates/protocol/src/vdp.rs`）**：默认完全关闭（零端口、无 `debug.json`、无探针开销）；仅传入 `--remote-debugging-port=<port>` 或 `VIBEVALLEY_DEBUG_PORT=<port>` 时在 `127.0.0.1` 启动回环 HTTP/WS 门（[vdp.rs](apps/mac/src/debug/vdp.rs)），以 Unix `0600` 权限原子写出 `$VIBEVALLEY_HOME/debug.json` 与 32 字节随机十六进制令牌（退出或 `Drop` 核对 PID 清理，[home.rs](crates/protocol/src/home.rs) 经 `kill -0` 过滤陈旧进程）。`/json/version`、`/json/list` 与 WS `/devtools` 均强制校验令牌（失败返回 `401`，HTTP 响应体与 `Debug` 输出绝不泄漏 `token`）。[vdp.rs](crates/protocol/src/vdp.rs) 单源定义 35 个封闭 `VdpCommand`（`Target.*`、`Shell.*`、`Page.*`、`Input.*`、`UI.*` 含 Canvas Inspector 的 `UI.inspectAt`/`UI.highlight`/`UI.setInspectorMode`、`Server.*`、`Log.*`）与 6 类 `VdpNotification`，在边界一次解码后统一交 [executor.rs](apps/mac/src/debug/executor.rs) 执行，配合可选 [vdpProbe.ts](apps/mac/ui/infra/vdpProbe.ts)（`vdp_ui_req` / `vdp_ui_res` / `vdp_ui_log`，附带 `source` 位置与树状父子结构）服务三类客户端：DevTools 检查器与远端面板（[DevToolsApp.tsx](apps/mac/ui/features/devtools/DevToolsApp.tsx)、[RemoteVdpPanel.tsx](apps/mac/ui/features/devtools/RemoteVdpPanel.tsx)，经 `HostOp::VdpDiscover` / `VdpCall` 与 Canvas Inspector 点击高亮/源码跳转）、`vibevalley debug` 命令行（[debug.rs](crates/cli/src/domains/debug.rs)）与验收脚本。

## 和谁打交道

- **服务端与运行时（`crates/server`、`crates/runtime`）**：进程内经 `Server` 调接口、读帧和事件；同一个 `Hub` 也挂在 `transport/http` 门上。`crates/runtime`、`crates/server` 与 `crates/cli` 统一经工作区 `reqwest`（`rustls-no-provider` + `rustls-platform-verifier` + `ring`）复用系统根证书，避免额外拉入重复 `webpki-roots`；原生实时语音等异步流共用 `vibevalley_runtime::rt` 共享运行时。
- **命令行（`crates/cli`）**：经 `server.json` 找到应用里的服务端；`crates/core` 的 Loro 内容协同引擎收到可选特性 `collab` 下，纯 HTTP `vibevalley-cli` 关闭该特性从而彻底脱钩 Loro。

## 为什么这样

- **服务端在进程里，页面走桥**：少一个进程和一层序列化之外的网络；HTTP 门只为命令行和帮工的 `/mcp` 留着。
- **工作台用 TSX，3D 纸雕场景用 Rust**：工作台是表单、列表和文字，沿用页面的写法和契约的 TS 类型最省；3D 纸雕农场需要离屏 `wgpu` 渲染、阴影/景深与射线拾取，直接留在 Rust 侧。
- **状态中间层收在 `state/`，意图按帧 `seq` 结算**：消除「请求返回先弹回旧状态、下一帧再跳过去」的闪烁。
- **Mac 是唯一服务端宿主，远程访问收口在 Tailscale + 原生移动壳**：不引入公网中继和 WebView 壳，主回环门保持无认证极简路径；远程监听默认关闭，仅在用户需要时对私有 Tailscale 网络或本地调试回环开放，由独立 4 标签 `apps/mobile` 聚焦离开桌面后的高频分拣与回复。
- **自动更新留纯 Rust 管线，不接 Sparkle / 强弹窗 / 高频轮询**：放弃 Sparkle（避免 ObjC/Swift FFI 与 Appcast XML 割裂现有通道与 `HostOp`）、放弃 `ready` 强弹全屏模态（避免打断阅读与执行心流）、放弃高频前端轮询（改由 `tokio::sync::watch` 实时推送 `update_state`）。
- **轻应用采用极薄 AppKit Shim + Plan B2（`CAContext`/`CALayerHost`）**：放弃方案 A（仅 URL 唤醒主进程，无独立 Dock / `Cmd+Tab` 身份）、方案 C（`clonefile` 多份 GPUI/服务端进程内存叠加）、方案 B1（`IOSurface` 需深改上游 GPUI）与 Pake/Tauri 离线打包（失去 11 类原生渲染与 Loro 实时协同）；`prototype` 直接由 Shim 内置沙箱 `WKWebView` 承载。
- **VDP 借鉴传输习惯而非强套浏览器 CDP**：原生工作台是 GPUI + `nsh` + `wgpu` 而非 Chromium DOM/V8，故只复用 `/json/*` 与 WebSocket JSON-RPC 2.0，放弃浏览器 CDP 域、纯 HTTP 轮询与纯 UDS 传输（脱离标准回环工具链）。

## 还没做的

- 真实音频验收、Developer ID 签名公证与签名包发布主线验收：`#54`。
- 移动端真机分发签名与后台提醒机制：`#60`。
- DevTools V2 画布 `Inspector` 与 Loro 前沿视图：`#57`。
- 看板覆层/拖拽显式状态机：`#56`（会话轨迹摘要下沉已并入 `#37`）。
- 桌面轻应用 Stage 3 增强能力（菜单栏常驻、作品 KV、全局快捷键与便携导出）。

## 怎么验证

- `cargo xtask check`：`apps/mac` 和它用的 crate 的格式、clippy 与测试（涵盖 `apps/mac/src/diorama/` 场景映射与开场资源测试）。
- `vp run mac:check`：`apps/mac/ui` 的 nsh 类型检查、打包、`vp lint --deny-warnings` 与全量 `nsh/test` 单元测试及集成测试（含 `interactions.test.tsx`、`scenarios.test.tsx`）。
- `vp run mobile:check` 与 `vpx scripts/gen/icons.ts --check`：`apps/mobile` 的 nsh 类型检查、打包、无头组件测试、`vp lint --deny-warnings` 与 97 枚 reicons 矢量路径同步检查。
- `apps/mac/ui/{app,workspace}/*.test.{ts,tsx}`、`apps/mac/ui/features/**`: `nsh/test` 写的页面、工作区外壳、主题令牌与领域逻辑测试，用样例的 `Transport`。
- 在真的应用上：一键运行 `vp run ui:gallery`（[画廊脚本](scripts/audit/ui-gallery.ts)）或按 [验收的应用分册](.agents/skills/vv-acceptance/references/app.md)，用 VDP 调试端口（`VIBEVALLEY_DEBUG_PORT=0` + `vibevalley debug`）走一遍并截图。
