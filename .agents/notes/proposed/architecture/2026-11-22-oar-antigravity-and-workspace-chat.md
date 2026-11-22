# Agent Note: OAR Antigravity ACP 集成（仅 agy 1.5+）与工作区直连对话标签页

Status: proposed

## Problem

当前 `vibevalley-runtime::oar`（[运行时接口](crates/runtime/src/oar/mod.rs)）将 Antigravity 视为一条通用 ACP 配置 `AcpAgentSpec::new("antigravity", "Antigravity CLI", "agy", ["acp"])`（[acp.rs](crates/runtime/src/oar/acp.rs)），在对接本机 `agy`（1.5.14）时存在八处协议与数据缺口，同时原生工作区缺少脱离任务板直连编码引擎的富对话界面：

1. **用量与外部引擎注册遗漏**：`SessionCore::external()`（[core.rs](crates/runtime/src/oar/core.rs)）漏掉 `"antigravity"`，导致根轮 `TurnFinished.usage` 恒为空；`TokenTotals::parse`（[accounting.rs](crates/runtime/src/oar/accounting.rs)）未识别 ACP 的 `cachedReadTokens`、`cachedWriteTokens`、`thoughtTokens`，且 `Meter::acp` 在恢复会话时无条件丢弃每轮用量。
2. **协议握手与选项拒绝**：`acp.rs` 固定发送 `ProtocolVersion::V1`，跳过主动 `authenticate`，拒绝无标准 `sessionCapabilities.systemPrompt` 的 `append_system_prompt`（而 `agy 1.5+` 使用 `_meta.antigravity.systemPrompt.append`），且缺少按模型动态探测 `thought_level` 的流程。
3. **标准输出污染**：未登录时 `agy acp` 会在 stdout 输出非 JSON-RPC 认证提示行（`Open the following link to authenticate the ACP server: ...`），直接破坏 `Lines` 帧解析。
4. **权限模式与交互式提问混用**：`agy acp` 拒绝 `session/set_mode("yolo" | "auto_edit")`；且 `agy` 通过 `session/request_permission` 发送 `toolCallId` 以 `interaction_` 开头的多选题，当前在 `PermissionMode::Bypass` 下会被误当作工具审批自动放行。
5. **流式控制与后台延续缺失**：`Capabilities.steer` 对 `antigravity` 为 `false`，且通用 `Command::Steer` 发送 `session/steer` 通知而非 `agy >= 1.5.0` 支持的轮中 `session/prompt` 引导；后台命令或定时唤醒在 `session/prompt` 返回后经 `usage_update` 收尾的脱离流未跟踪。
6. **静默上游错误漏报**：`agy` 常将 429、配额耗尽（`QUOTA_EXHAUSTED`）、5xx 或 `INVALID_THINKING_SIGNATURE` 作为普通回复与 `stopReason: "end_turn"` 返回，真实错误仅写入本机 `conversations/<sessionId>.db` 的 `step_type = 17` 记录。
7. **工具字段与体量未归一化**：`agy` 工具载荷混用 `CommandLine` / `Cwd` / `combinedOutput` / `exitCode` 大小写并可能夹带内联 `data:image/`，且 `oar::tool_action` 未识别 ACP `kind`，导致 `Doing` 与轨迹动作落入 `other`。
8. **工作区仅有终端标签**：`apps/mac` 的工作区分栏（[layout.rs](apps/mac/crates/workspace/src/layout.rs)）只提供 PTY 终端、文件与 diff 查看，用户要在仓库或 worktree 内直接和 `Antigravity` / `Claude` / `Codex` 开展富内容多轮对话时，只能切回命令行终端或新建任务。

## Proposal

按两阶段推进：先在 `crates/runtime/src/oar/` 内收拢 **仅支持 `agy >= 1.5.0`** 的 Antigravity ACP 适配与 OAR 交互/用量能力（Phase 1），再基于同一套 `oar::Session` 与服务端 `Sessions` / `Trajectories` 管道在工作区增加直连对话标签页 `PaneKind::Chat`（Phase 2）。两阶段复用同一会话核心，不新增第二套引擎编排或独立工作区对话库表。

### Phase 1：OAR Antigravity ACP（仅 `agy >= 1.5.0`）

#### 1. 目录边界与版本门槛

将 `crates/runtime/src/oar/acp.rs` 拆为目录模块 `crates/runtime/src/oar/acp/`（与 `crates/runtime/src/oar/codex/` 一致），用封闭枚举 `AcpFlavor`（`Generic | Antigravity`）取代散落的字符串分支，不携带任何 `agy 1.1–1.4` 遗留逻辑（不含 PyInstaller 临时解包清理、`zed` 客户端白名单、`disabledTools: ["run_workflow"]` 与 `client_view_file` 状态修补）：

| 文件 | 职责 |
|---|---|
| `crates/runtime/src/oar/acp/mod.rs` | 通用 ACP 传输、`AcpAgentSpec`、`AcpRuntime`、`Projector`、`OptionSet`、握手与事件循环，按 `AcpFlavor` 分派差异点 |
| `crates/runtime/src/oar/acp/antigravity.rs` | `agy >= 1.5.0` 版本校验、启动环境与参数、stdout 认证链接前置过滤、握手/配置扩展、权限与 `interaction_*` 分流、工具载荷归一化与截断、轮中引导与后台延续状态 |
| `crates/runtime/src/oar/acp/antigravity_db.rs` | 复用工作区已有 `sqlx`（`SqliteConnectOptions::read_only(true)` + 100 ms `busy_timeout`）经 `pollster::block_on` 只读查询 `conversations/<sessionId>.db` 的 `step_type = 17` 静默错误（零新增 crate 依赖） |

- **版本门槛**：`installation()` 解析 `agy --version`，低于 `1.5.0` 时返回 `Installation::Unusable` 并提示升级。
- **拒绝项显式声明**：在 [mod.rs](crates/runtime/src/oar/mod.rs) 的 `refused_options("antigravity")` 拒绝 `SystemPrompt`（整段替换）、`AllowedTools`、`DisallowedTools`、`OutputSchema`、`Name`、`ServiceTier`、`LaunchArgs`；允许 `AppendSystemPrompt`、`Effort` 与 `AdditionalDirectories`（映射为可重复的 `--add-dir`）。

#### 2. 进程启动、协议握手与模型配置

- **启动参数与环境**：默认执行 `agy acp`（附加 `--add-dir <dir>`），沿用用户默认 `~/.gemini` 与 `antigravity-cli` 登录态（仅当显式配置时透传 `--gemini-dir` / `--app-data-dir`）；注入 `AGY_CLI_DISABLE_AUTO_UPDATE=1` 与 `PYTHONUNBUFFERED=1`。
- **stdout 认证行前置过滤**：在 `AcpRuntime::connect` 的 `on_line` 回调（`Lines` 解析前）拦截以 `Open the following link to authenticate the ACP server: ` 开头的行，直接丢弃不送入 JSON-RPC 流，并以 `AgentError::NotAvailable` 提示执行 `agy acp --login`。
- **v1+v2 兼容握手**：依托 `agent-client-protocol 5.2.0` 的 `UntypedMessage` 发送 `initialize`：声明 `protocolVersion: 2`、`clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }`（关闭 `writeTextFile` 保住 diff 编辑，关闭 `readTextFile` 使用原生按行读取器）、`clientInfo: { name: "vibevalley", title: "VibeValley", version }`，同时兼容服务端返回 `protocolVersion: 1 | 2`。
- **主动认证**：配置或宣告了非交互认证方式时，在 `session/new` / `session/resume` 前主动调用 `authenticate({ methodId })`；将 `-32000` 或 `-32603`（`No browser is available here`）映射为 `Installation::LoginRequired` / `NotAvailable`。
- **系统提示与配置顺序**：当 `initialize.agentCapabilities._meta.antigravity.systemPrompt.append == true` 时，在 **`session/new` 与 `session/resume` 两者**的 `_meta` 中均携带 `{ "antigravity": { "systemPrompt": { "append": text } } }`（`agy` 不持久化附加提示，恢复时应重发）。配置选项先调用 `session/set_config_option("model", wanted)` 并读取返回的最新 `configOptions`，再按 `category == "thought_level"` 设置 `opts.effort`；`list_models()` 在临时会话内遍历一次模型以采集各模型的 `effort_levels` 与 `default_effort`。

#### 3. 客户端权限策略与 `interaction_*` 提问分流

- **永不发送 `yolo` / `auto_edit`**：`AcpFlavor::Antigravity` 保持在 `default`（或仅在显式请求且 `availableModes` 宣告时切换 `auto`；未宣告 `plan` 时拒绝 `PermissionMode::Plan`），由客户端在 `session/request_permission` 回调内按 `PermissionMode` 裁决（`Bypass` 全放行；`AcceptEdits` 放行 `read|search|think|edit|delete|move`、询问 `execute|fetch|other`；`Ask` 仅放行只读类）。
- **独立交互提问通道**：在 [mod.rs](crates/runtime/src/oar/mod.rs) 与 [core.rs](crates/runtime/src/oar/core.rs) 新增类型化事件 `EventKind::InteractionRequested { request_id, question, options, allow_custom }`、`EventKind::InteractionResolved { request_id, decision }` 及 `Session::respond_interaction(...)`，`StatusFold` 跟踪未决提问并进入 `SessionStatus::WaitingReply`。`Shared::on_permission` 应先检查 `toolCall.toolCallId.starts_with("interaction_")`：命中则解析题目与选项（保留 `option._meta["agy.security.warning"]`），写入独立的 `pending_interactions` 并派发 `InteractionRequested`，**即使在 `PermissionMode::Bypass` 下也绝不自动批准**。

#### 4. 流式归一化、轮中引导、后台延续、用量与静默错误

- **工具载荷归一化与裁剪**：在 `Projector` 中将 `CommandLine|command_line|commandLine|command` 归一为 `command`、`Cwd|WorkingDirectory|working_dir|workingDir` 归一为 `cwd`、`combinedOutput|combined_output` 归一为 `output`、`exitCode|exit_code` 归一为 `exitCode`；剥离内联 `data:image/` 与重复的 `formatted_output`；单字段文本上限 `8 KiB`（命令输出保留尾部），整包上限 `64 KiB` / 512 节点。同时扩展 `oar::tool_action` 识别 ACP `kind`（`execute`、`read`、`edit`、`delete`、`move`、`search`、`fetch`）。
- **轮中引导（Steering）**：对 `antigravity` 置 `Capabilities.steer = true`。`Command::Steer` 在当前轮运行期间直接发送 `session/prompt` 请求（不发 `session/steer` 通知，也不先发会杀死子代理的 `session/cancel`），通过并发请求计数在最新 prompt 结算后结束当轮。
- **后台命令与定时唤醒延续**：追踪未结束的非守护 `execute`（`rawInput.IsDaemon != true`）与 `schedule`（`Run schedule` / `Running schedule`）工具调用；当 `session/prompt` 返回但仍有后台工作在跑时，继续接收脱离 `session/update` 并在 `usage_update` 到达时收口，且在后续新消息到来时不发送 `session/cancel` 以免中止后台命令。
- **Gemini 加法用量核算**：修复 `SessionCore::external()` 加入 `"antigravity"`；扩展 `oar::Usage` 与 `TokenTotals` 支持 `cachedReadTokens`、`cachedWriteTokens`、`thoughtTokens` 及上下文窗口 `used` / `size`。对 `antigravity` 采用加法语义 `total_input = inputTokens + cachedReadTokens`、`total_output = outputTokens + thoughtTokens`（钳制子集不超过总量），并将 `Meter::acp` 标记为按轮上报模式，使恢复会话同样输出准确每轮用量与缓存命中率。
- **静默错误检测（`antigravity_db.rs`）**：每次 `session/prompt` 发送前读取 `<gemini_dir>/<app_data_dir>/conversations/<sessionId>.db` 的 `SELECT coalesce(max(idx), -1) FROM steps`（校验路径无符号链接且同 inode）；当 `session/prompt` 返回 `end_turn` 或 `refusal` 后，查询 `idx > start_idx` 的末条记录。若 `step_type == 17`（`CORTEX_STEP_TYPE_ERROR_MESSAGE`），扫描前 `16 KiB` 提取 `Error <code>, Message: ..., Status: ...`、`STATUS (code NNN): ...`、`reason:QUOTA_EXHAUSTED`、`quotaResetTimeStamp` / `quotaResetDelay` / `retryDelay` 及 `INVALID_THINKING_SIGNATURE`，将 `StopReason::Completed` 升级为 `StopReason::Error` 并附结构化 `EventKind::Error`（`INVALID_THINKING_SIGNATURE` 标记会话不可续接，下一轮自动新开会话）。

### Phase 2：工作区直连对话标签页（复用统一 OAR 会话层）

#### 1. 统一服务端会话抽象（零重复编排）

服务端 `crates/server/src/modules/work/session/` 已通过 `Session.issue: Option<IssueId>` 支持无任务会话（见 [talk.rs](crates/server/src/modules/work/session/talk.rs)）。在 [sessions.rs](crates/server/src/modules/work/session/sessions.rs) 新增工作区直连入口 `Sessions::open_workspace`，创建 `Session { issue: None, channel: None, repo: Some(repo), worktree: Some(cwd), .. }`，与任务执行会话共用同一 `Arc<dyn oar::Session>`、`Sessions::go_live` / `pump()`、[Trajectories](crates/server/src/modules/work/session/journal.rs) 轨迹落盘与 `voyage` 记录流：

| 维度 | 任务执行会话（`Sessions::hire`） | 工作区直连对话（`Sessions::open_workspace`） |
|---|---|---|
| 归属 | `issue: Some(id)`、独立 worktree | `issue: None`、`channel: None`、指向当前仓库或 worktree `cwd` |
| 权限与提问 | `PermissionMode::Bypass`；`InteractionRequested` 转为任务 `Question` | 标签内可选 `Ask` / `AcceptEdits` / `Bypass`；`PermissionRequested` 与 `InteractionRequested` 实时推送到标签卡片 |
| 实时流与控制 | `issue.watch`（[session/mod.rs](crates/server/src/modules/work/session/mod.rs)） | `session.watch`（同源读取 `Hub::live()` + `Trajectories`），配 `session.openWorkspace`、`session.send`（空闲启轮 / 运行中引导）、`session.stop`、`session.respondPermission`、`session.respondInteraction`、`session.setConfig`（会话内切换 `model` / `thought_level` / `permissionMode`） |
| 用量字段 | 结算为 `Session.spent` | 同源扩展 `EventTokens`（新增 `cacheWrite`、`reasoning`、`contextUsed`、`contextWindow`）驱动底部克制遥测条 |

#### 2. 原生外壳布局与工作区 UI 承载

- **布局枚举持久化**：在 [layout.rs](apps/mac/crates/workspace/src/layout.rs) 的 `PaneKind` 新增 `Chat { session_id: String, runtime: String, cwd: PathBuf, title: Option<String> }`，随现有项目 `Layout` JSON 序列化进 `state.db`，**不新增独立工作区 SQLite 表**；重启应用后按需惰性挂载 `HostedView` 并续接服务端持久化的 `session_id`（与 `Terminal` 恢复一致）。
- **外壳挂载与分栏联动**：[panes.rs](apps/mac/src/shell/panes.rs) 的 `make_pane` 为 `PaneKind::Chat` 创建 `HostedView::new("workspace-chat", params, ...)`（[hosted/mod.rs](apps/mac/src/hosted/mod.rs) 已接入 `BridgeHub` 与 `vibevalley-rich` 渲染注册表），继承焦点、`⌘W`、`⌘D`、`⌃Tab` 与拖拽分栏。标签栏 `+` 升级为 `+ 新对话 ▾` / `+ 新终端` 分裂按钮（保留 `⌘T` 开终端，新增 `⇧⌘T` 开直连对话）；新增外壳动作 `NewChatAt`、`OpenFileAdjacent` 与 `OpenDiffAdjacent`，点击工具调用卡片时在相邻分栏打开目标文件行或 diff（单栏时自动向右分屏），不顶掉当前对话标签。侧栏 `RailTab` 显示 `kind = "chat"`、运行中状态点及等待 `interaction_*` 回复的 `attention` 提醒。
- **富内容页面组件**：在 [App.tsx](apps/mac/ui/App.tsx) 注册 `"workspace-chat": WorkspaceChatPane`（`apps/mac/ui/workspace/ChatPane.tsx`），经 [bridge.ts](apps/mac/ui/infra/bridge.ts) 订阅 `session.watch`；正文复用 `vibevalley-rich` 的 `VvMarkdown`（流式 Markdown、代码高亮与图谱），思考折叠块与工具卡片复用并提炼自 [WorkLog.tsx](apps/mac/ui/features/session/WorkLog.tsx)；`interaction_*` 渲染为带选项、自定义输入与「不会自动批准」标识的交互卡片；输入框支持运行中切换为轮中引导（Steer）与中断、以及引擎 / 模型 / `thought_level` 选择；底部 28 px 单行遥测条默认克制展示上下文占比（缓存 vs 非缓存）、缓存命中率、轮次与可选配额，点击展开详情抽屉。

## Alternatives considered

- **在 `oar` 之外单独写一个独立 `agy` 包装器**：实现初期虽快，但会导致权限分流、轨迹落盘、`voyage` 记录、模型刷新与未来任务派活全部重复维护一套进程与状态机；收进 `crates/runtime/src/oar/acp/` 后，任务执行会话、私聊与工作区直连对话一次受益。
- **兼容旧版 `agy 1.1–1.4` PyInstaller 独立服务（`agy_acp_server.par` + `localharness_external`）**：旧版每次启动需解包约 1 GB 临时目录并依赖 `zed` 客户端白名单、`run_workflow` 禁用补丁及 `client_view_file` 状态修补，复杂度高且官方 T3 Code 已要求 `>= 1.5.0`。直接将门槛定在 `agy >= 1.5.0` 可消去全部历史包袱。
- **为工作区直连对话另建独立服务端编排与独立 SQLite 表**：另写一套子进程管理器和聊天消息表会造成与 `Sessions` / `Trajectories` 的双源漂移，无法复用 `oar` 的恢复、记录、子代理和统计逻辑；通过 `Session { issue: None }` 与 `PaneKind::Chat` 序列化进现有 `Layout` 树即可零额外表复用整条链路。
- **将直连编码对话放到左侧一级导航的新 Tab 而非工作区 `PaneKind`**：脱离工作区后，用户无法把对话与同仓库的终端、文件查看和 Git diff 并排分屏联动，也违背工作台 6 项一级导航收敛原则（[客户端](docs/subsystems/app.md)）；做成与 `Terminal` 同级的 `PaneKind::Chat` 能自然支持多仓库/多 worktree 并排开发。

## Acceptance criteria

### Phase 1（OAR Antigravity ACP）

- `cargo test -p vibevalley-runtime` 全量离线通过，覆盖：
  - `antigravity.rs` 单元测试：`< 1.5.0` 版本拒绝、工具字段大小写归一化与 `8 KiB` / `64 KiB` 裁剪及 `data:image/` 剥离、`tool_action` ACP `kind` 映射、`interaction_*` 解析与警告透传、Gemini 加法 `TokenTotals`（含恢复会话）及 `StatusFold` 进入 `WaitingReply`。
  - `antigravity_db.rs` SQLite 夹具测试：`step_type = 17` 下的 `429 QUOTA_EXHAUSTED`（含 `quotaResetDelay`）、`STATUS (code 503): ...`、`INVALID_THINKING_SIGNATURE` 升级为 `StopReason::Error`，正常回复步骤不误判。
  - 模拟 stdio ACP 子进程集成测试（经 `SessionOptions.bin_path`）：验证 stdout 认证链接前置过滤不破坏 JSON-RPC、v2 `initialize`（`fs.writeTextFile = false`、`fs.readTextFile = false`、`terminal = false`）、主动 `authenticate`、`session/new` 与 `session/resume` 均带 `_meta.antigravity.systemPrompt.append`、`model` → `thought_level` 顺序设置、绝不发送 `yolo`/`auto_edit`、`PermissionMode::Bypass` 下绝不自动批准 `interaction_*`、轮中 `steer()` 发送 `session/prompt`、脱离后台 `usage_update` 延续，以及根轮 `TurnFinished.usage` 经 `SessionCore::external()` 非空结算。
- 本机 `#[ignore]` 实机冒烟测试（指向 `/Users/lucasay/.local/bin/agy` `1.5.14`）通过：`installation()` 识别版本号、`list_models()` 采回真实模型与各自 `effort_levels`、新建与 `resume` 会话单轮问答返回非空 `input_tokens`/`cache_read_tokens`/`output_tokens` 且定位到真实 `conversations/<sessionId>.db`、轮中引导与 `abort()` 后 `dispose()` 无残留进程。

### Phase 2（工作区直连对话标签页）

- `PaneKind::Chat` 随工作区 `Layout` 持久化并可与 `Terminal`、`File`、`Diff` 同组混排或左右分屏；重启应用后惰性重连原 `session_id` 并保留历史轨迹。
- 在工作区新建 `Antigravity` / `Claude` / `Codex` 直连标签页可完成流式输出、思考块折叠、工具卡片点击在相邻分栏打开文件行或 diff、`interaction_*` 卡片选择回复、运行中轮中引导（Steer）、会话内切换 `model` / `thought_level`，以及底部克制遥测条展开查看缓存与上下文占比。
- `vp run rust:check`、`vp run protocol:check`、`vp run mac:check` 与 `vp run docs:verify` 全绿，且实机按 [验收的应用分册](.agents/skills/vv-acceptance/references/app.md) 截图确认浅色与深色两套田间工作台外观。

## Risks

- **`agy` SQLite trajectory schema 漂移**：`conversations/<sessionId>.db` 属于 `agy` 内部存储（`step_type = 17` 与 `steps` 表结构未列入公开 ACP 契约），升级 CLI 后可能变更。缓解：`antigravity_db.rs` 仅以只读容错模式查询，表缺失、加锁超时或无法解析时静默回退为仅依赖 ACP `stopReason`（不中断正常对话），并在实机冒烟测试里持续校对路径与表结构。
- **轮中 `session/prompt` 并发与脱离后台流的状态竞态**：`agy >= 1.5.0` 允许在已有 prompt 未返回时再发引导 prompt，且后台命令结束后会发无对应 prompt 的脱离更新。缓解：在 `AcpDriver` 内以单调计数区分主轮、引导轮与脱离尾流，仅在所有在途 prompt 结算后发根 `TurnFinished`，并补齐模拟子进程时序测试覆盖竞态路径。
- **工作区标签页同时开启多个长驻 OAR 子进程的资源占用**：若用户打开大量 `PaneKind::Chat` 标签，每个标签对应一个常驻引擎进程。缓解：标签恢复采用惰性挂载（未激活不拉起子进程），空闲超时的直连会话可自动 `dispose()` 进程并在下次发消息时经 `resume` 无感续接，且工作区直连会话不占任务板的 `repo.max_sessions` 并发上限。
