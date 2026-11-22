# 帮工

帮工是「一个档案（`Agent`）干一件活」：会话（`Session`）和它的每一轮（`Run`）、工作目录、农机的执行和轨迹。Rust 版里这些在服务端的 `modules/work/session`：`Sessions` 雇帮工、跑每一轮、私聊、带话和叫停，另有 `session.*` 端点、轨迹和工单观察流；它由工单板（`modules/work/issue` 的 `Board`）叫来，一轮的汇报经 `Ledger` 写回工单，起草的一轮和每轮之后的排队交回工单板（`Rounds`）。
- 处理工单时画成地里的小动物，处理私聊时关联频道，工作区直连对话挂在仓库或 worktree 上；外部农机经 `vibevalley-runtime::oar` 驱动（Claude Code、Codex、Antigravity、OpenCode、Grok、Kimi、CodeBuddy、Qwen Code、Qoder 等），VibeValley 自己的 agent 是 oar 里的 `vibevalley` 农机。
- 一次触发到一次汇报是一轮 `Run`；一个 `Session` 可跨越多次 `Run` 与重启。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `Session` 的创建、带话（插话或开下一轮）、叫停、交接与离场；席位与删频道守卫、私聊异步拉起；worktree 的开、重置、清 | 谁听见一句话、两道环路刹车（[频道](docs/subsystems/channel.md)） |
| 每一轮：触发来源、结局、汇报（`issue_report`）、问题；静默检测 | 工单状态机、验收、合并、拆单（[工单](docs/subsystems/issue.md)） |
| 并发上限（全农场、每个仓库）、排队 | 农机安装探测、档案校验（[档案和农机](docs/subsystems/agent.md)） |
| 轨迹（`SessionEvent`）的记录、推送与读回；`/mcp` 帮工门的令牌 | 记忆的存储与检索（[记性](docs/subsystems/memory.md)）；助手的编排（[助手](docs/subsystems/orchestrator.md)） |

## 一次农机执行怎样复核

| 运行时 | 进程协议 | 恢复时怎样算用量 |
| --- | --- | --- |
| Claude Code | 双向 stream-json，工具调用 ID 串起子 agent 路径。MCP 配置放在权限为 `0600` 的临时文件里。 | 开轮前通过 `get_usage` 读取基线，对照模型累计量计算本次增量。读不到基线则记录未知原因。 |
| Codex | app-server 的 `thread/start`、`turn/start`、`turn/steer` 和 `thread/compact/start`；通知标出线程、工具、轮次，并捕获根线程标题（`thread/started`、`thread/name/updated`）。 | 从恢复响应或开轮前的 token 通知取基线；子线程用量独立归属。 |
| Antigravity（`agy >= 1.5.0`） | ACP v1+v2 握手（关闭 `fs.readTextFile` / `fs.writeTextFile` / `terminal`），前置过滤 stdout 认证链接，`session/new` 与 `session/resume` 均透传 `_meta.antigravity.systemPrompt.append`；从 `session/{new,resume,load}` 与 `session_info_update` 捕获真实会话标题；永不发 `yolo`/`auto_edit`，客户端按权限模式裁决并将 `interaction_*` 分流为独立提问；轮中直接发 `session/prompt` 引导，跟踪后台命令/定时脱离尾流；轮末只读查本地 `conversations/<sessionId>.db` 的 `step_type = 17` 升级静默错误，并经 [antigravity_swarm.rs](crates/runtime/src/oar/acp/antigravity_swarm.rs) 只读观测 Swarm 旁路状态（总览/成员/黑板）及 `step_type = 127` 子代理的有界 `session.childTranscript` 下钻。 | 按轮上报，采用 Gemini 加法语义（`input + cachedRead`、`output + thought`）并上报 `cacheRead`/`cacheWrite`/`reasoning` 及上下文窗口占用；恢复会话同样保留每轮用量。 |
| OpenCode、Grok、Kimi、CodeBuddy | ACP 协商会话、模型、推理强度和工具。OpenCode、Grok 支持中途插话；Kimi 和 CodeBuddy 的工作规则随首条输入发送。 | 新会话累计已报告用量；恢复会话缺少可查的历史基线，标记未知。 |
| Qwen Code、Qoder | SDK stream-json。Qwen 首个输入帧是 `initialize`，Qoder 的提示和 MCP 配置经私有文件传入。厂商 ID 到达后写回业务会话，供下一轮续接。 | 平面用量按轮累加；Qoder 缺少用量字段时保留未知。 |

工单只按根轮已报告的输入与输出 token 之和结算。轮次、最后一次汇报和工单时间线共用该结果。输入或输出缺失时省略 `spent`。子线程单独归属，USD 成本留在驱动记录。累计数缺少上一轮边界时，服务等到下一对完整读数再算增量。[用量归约](crates/runtime/src/oar/accounting.rs) · [工单结算](crates/server/src/modules/work/session/sessions.rs)

每个 `oar-voyage/3` JSONL 文件先写头，再写带序号、厂商会话 ID、轮次跨度和子 agent 路径的记录。原生进程帧、控制回执和生命周期标记分开存放。消费者可从已有序号订阅后续记录；同一路径重开时续写文件序号。[运行时接口](crates/runtime/src/oar/mod.rs) · [记录格式](crates/runtime/src/oar/voyage.rs)

`cargo test -p vibevalley-runtime` 使用真实子进程离线回放三类协议。样本中的响应和有序事件由 Go 基线 `a2c1851ab` 的 `pkg/oar/replaytest` 与实际驱动生成。验收逐条核对八种农机的帧类型、子 agent 路径和事件内容，另测恢复缺少用量基线、压缩期间排队、撤回、子会话限额和记录读回。[跨实现对照](crates/runtime/tests/oar/go_drivers.rs) · [生命周期](crates/runtime/tests/oar/lifecycle.rs)

## Codex 子线程的进度

服务端按业务轮次和厂商线程保存摘要。`session.get` 和核心帧返回当前摘要，`issue.run.list` 返回各轮的摘要。工作日志保留最近 240 步。用户重开工单后仍可查看已移出日志的子任务。[服务端归约](crates/server/src/modules/work/session/subagents.rs) · [重启回归](crates/server/tests/session/subagent_progress.rs)

创建者取自派出事件或线程元数据。等待记录以等待者和调用标识区分。Codex 等待协作邮箱时可以省略目标。此时工作台显示「等待协作消息」。厂商只提供路径时，工作台显示路径。计划步骤和终态取自厂商事件。[真实 CLI 通知样本](crates/runtime/tests/fixtures/codex-0.170.0-collaboration.json)

服务意外退出后，摘要保留最后观测时间和服务发现连接中断的时间。续接同一厂商根线程后，服务按子线程标识和原轮次标识补读。未匹配的子轮继续显示原记录。补读的终态不会补出缺失的中间活动。

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/server/src/modules/work/session/sessions.rs`、`mailbox.rs`、`db.rs` | `Sessions`：领域无关 `AgentSession` 核心，管创建/雇佣（`hire`）、下一轮（`next_round`）、插话（`steer`）、叫停（`stop`）、放走（`dismiss`，worktree 交给 `Workplace` 收拾）、把农机事件读成事实、结算一轮、静默检测、帮工 `/mcp` 钥匙与持久 SQLite 信箱 `session_mailbox`（`mailbox.rs`，按 `idempotency_key` 去重并支持消费前撤回）；重启时把在干活的会话记成打断；并发上限在 `BoardConfig`（`ledger.rs`：`space_limit` 6、`per_repo` 3、`quiet_after` 240 秒），仅对工单受控会话计槽位 |
| `crates/server/src/modules/work/session/report.rs`、`runs.rs` | 一轮末尾的结构化汇报；每张工单的各轮 |
| `crates/server/src/modules/work/session/talk.rs` | 私聊会话：绑定频道的 `AgentSession`，在独立目录里一轮一轮答，答的话经 `SessionChat` 贴进私聊 |
| `crates/server/src/modules/work/session/workspace.rs` | 工作区直连对话会话（`open_workspace`、`close_workspace`、`send_workspace`、`respond_permission`、`respond_interaction`、`set_workspace_config`、`swarm_snapshot`、`read_child_transcript`、`session_title`）：作为 `controller: User` 的 `AgentSession` 统一落盘 `server.db` 的 `session` / `session_mailbox` / `session_event` 表，不占工单板并发上限、不进收件箱与像素农场 |
| `crates/server/src/modules/work/session/drivers.rs`、`crates/server/src/modules/team/agent/drive.rs` | 把工单指派的档案变成农机和启动参数（规矩、人设、记性、MCP） |
| `crates/server/src/modules/work/session/journal.rs` | 游标分页轨迹：每个会话的步骤落盘 SQLite `session_event` 表（按 `(session_id, seq)` 索引，经 `crates/server/src/db/{queries,generated}/work_session.*` 访问），变化时每 300 毫秒推一次、每 1.5 秒刷盘；权限、交互提问与用量步骤立即刷盘 |
| `crates/server/src/modules/work/session/mod.rs` | `session.*` 端点（含 `openWorkspace`、`closeWorkspace`、`send`、`respondPermission`、`respondInteraction`、`setConfig`、`childTranscript`、`binding.attach`）和 `issue.watch` / `session.watch` 订阅流（按 `SessionsSlice` 与事件驱动同步 `title` 与 `swarm` 增量） |
| `crates/server/src/modules/team/mcp/mod.rs` | 帮工的 `/mcp` 门：JSON-RPC，令牌由工单板开帮工时签发（`Board::who` 认人），工具是农场的帮工工具（[工具](docs/subsystems/orchestrator.md)） |
| `crates/runtime/src/oar/` | 驱动各家农机：`claude.rs`、`codex.rs`、`acp/`（`mod.rs`、`antigravity.rs`、`antigravity_db.rs`、`antigravity_swarm.rs`）、`sdk.rs`、`scripted.rs`；`record.rs`、`voyage.rs` 是 `oar-voyage/3` JSONL 记录流（内置农机在 `crates/runtime/src/agent/runtime/mod.rs`），`core.rs` 预留关闭态零开销的全局 `OarObserver` 钩子并支持 `TurnOptions { trace_id }` 透传 |

## 模型和不变量

- **领域无关的 `AgentSession` 执行核**：所有受管会话（工单执行、私聊对话、工作区直连对话）统一建模为领域无关的 `Session`（`controller: SessionController`、`role: Option<AgentRole>`、`profile: Option<String>`、`cwd: Option<String>`、`policy: ExecutionPolicy`、`bindings: Vec<ContextRef>`）。执行核不要求必须绑定工单或频道，可 0 绑定自由启动，也可在运行中经 `session.binding.attach` 动态挂载上下文；只有工单受控会话进入并发槽位、收件箱、像素农场与进度统计。
- **`Session` 与 `Run` 分开**：`Session` 是档案或工作区的持续执行现场，编号单调递增；`Run` 是一次触发到一次结束汇报；底层 oar 会话可在同一 `Session` 下更换。
- **在场阶段（`Session.phase`）**：`working`（可带 `quiet_since`）、`done`、`failed`、`resting`、`closed`。显式交回且没有待答问题才 `done`。
- **结构化交接（`issue_report`）**：帮工经 `/mcp` 的 `issue_report` 交状态、问题、`checks` 与 `answer`（`Board::report`）；一轮没交汇报就从它说的话里读问题。
- **统一持久信箱 `session_mailbox` 与带话**：工作区输入、私聊消息与工单评论均经 `session_mailbox`（按 `idempotency_key` 幂等去重，`pending` / `claimed` / `done` / `failed` / `withdrawn`）入队，支持消费前撤回与重启恢复；会话在干活时插进当前一轮，歇着时开下一轮，排队工单的话随派工一并交给帮工。
- **并发上限**：全农场最多 6 个在干活的工单受控会话，单仓库默认 3 个；满了工单留在 `todo`（`stage: queued`），空出来按看板顺序补派；工作区直连会话（`controller: User`）不占工单并发槽位。
- **无沙箱与无逐条权限确认（工单帮工）**：工单帮工在 worktree 里直接执行命令，农机的权限请求一律放行（`PermissionMode::Bypass`）；安全边界是服务端只听 `127.0.0.1`。
- **工作区直连对话、Swarm 旁路与独立交互提问通道**：工作区直连会话（`controller: User`、`policy: DirectCwd`、0 绑定启动）复用同一套 `AgentSession`、`oar::Session`、`session_mailbox`、`session_event` 与 `oar-voyage/3` 记录流，不占工单板 `space_limit` / `per_repo` 并发配额，也不进收件箱与像素农场；关闭标签页时由原生壳直接调 `session.closeWorkspace` 确定性停机回收；会话内可切换模型、思考深度与权限模式（`Ask` / `AcceptEdits` / `Bypass` / `ReadOnly`），真实会话标题经 `Session.title` 与 `SessionsSlice` 实时同步，Antigravity Swarm 与子代理通过只读旁路（mtime 缓存 + `256 KiB` 尾部裁剪 + 防符号链接/路径穿越）按需暴露 `swarm` 状态与 `session.childTranscript`；其中 `InteractionRequested`（如 Antigravity 的 `interaction_*` 提问）进入 `WaitingReply`，**即使在 `Bypass` 模式下也绝不自动放行**。
- **会话向外发消息**：`Sessions::on_news` 订阅步骤与汇报中的记性；启动时在恢复中断轮之前挂上订阅，轨迹写入与记性落盘各自接收，会话不调用轨迹或记性服务。订阅同步完成，保持同一会话的步骤顺序。
- **会话、信箱与轨迹统一落 SQLite**：`session`、`session_extra`、`session_run`、`session_run_subagents`、`session_counter`、`session_mailbox` 与 `session_event` 全部存于 `server.db`（命名查询集中在 `crates/server/src/db/queries/work_session.sql`，sqlc 生成至 `crates/server/src/db/generated/work_session.rs`）；枚举和嵌套字段在读库边界解码，坏值使读取失败。流式草稿按 `(session_id, seq)` 与 `revision` 原地增长，不进 `SpaceState`。
- **重启**：开机时还在干活的会话那一轮记 `interrupted`，会话停在 `resting`，工单进 `stuck: interrupted`，用户点「继续」或再说话时接着做；worktree 丢了的工单取消（`lost`）。

## 和谁打交道

- **工单**：同在 `Board` 里。
- **频道与事件总线（`channel`、`EventBus`）**：频道纯路由产出 `channel_delivery` 并经 `Chat::dispatches()` 异步投递给 `IssueChat`（`Board::tell_message`）与 `SessionChat`（私聊拉起与席位清理）；会话动静经 `Hub` 的异步 `EventBus` 通知下游模块开串、贴汇报。
- **档案和农机、记性（`agent`、`memory`）**：开会话前经 `Drivers` 选农机、拼说明、召回记忆。

## 为什么这样

- **用 oar 驱动农机，不自己写各家协议的循环**：Claude Code、Codex、ACP 各有各的协议，oar 收成一个会话接口（事件、插话、关闭）。Antigravity 仅支持 `agy >= 1.5.0` 并收在 `oar/acp/` 枚举分支里，避免旧版 PyInstaller 与客户端白名单包袱，任务会话、私聊与工作区直连共享同一实现。
- **工作区直连对话、私聊与工单统一复用领域无关 `AgentSession`**：不按场景拆平行进程管理器，也不用 `AgentRole::Worker` 伪装直连会话；所有会话共享 `Sessions`、`session_mailbox`、`session_event` 与 `session.watch`，通过 `controller`、`policy` 与 `bindings` 严格隔离上层消费者。
- **不做命令级权限确认，靠工作目录与回环监听划边界**：逐条批准会让帮工停在命令上等人，与无人值守冲突。
- **外部执行中断**。服务重启时，未结算的外部帮工轮次记为 `interrupted`。账本在同一笔事务中写入轮次的工作目录核对标记和会话的 `lastRun.needsReconciliation`。总览读取会话摘要。历史记录从 `issue.run.list` 读取该轮的 `needsReconciliation`。用户可核对工作目录和 Git 提交。重送同一条回复沿用原轮次。用户主动叫停的轮次保留普通中断状态。
- **工单串汇报**。服务在同一笔事务中结算输入、保存轮次和登记待发汇报。启动时 `IssueChat` 补投待发汇报。工单串按帮工标识和轮次标识去重。

## 还没做的

- 多台机器、MCP 连接观察：Rust 版从简，当前不在计划内。
- `opencode`、`grok`、`kimi`、`codebuddy`、`qwen`、`qoder` 的真实厂商 CLI 实机验证：[持久执行与驱动验收](.agents/notes/proposed/architecture/2026-11-18-native-durable-execution.md)。

## 怎么验证

- `crates/server/tests/issue_board.rs`：开工、提问、失败、打断与续上、排队与上限、重启、静默、权限放行。
- `crates/server/tests/session.rs`、`crates/server/tests/session/workspace.rs`：轨迹的流式步骤、子 agent 的步骤、落盘读回、`issue.watch` / `session.watch` 与工作区直连会话全链路（权限、交互提问、在线改配、重启续接、与工单板并发隔离）。
- `crates/server/tests/mcp.rs`：`/mcp` 帮工门。
- `crates/runtime/src/oar/tests.rs`、`crates/runtime/tests/antigravity_acp.rs`、`crates/runtime/tests/antigravity_swarm.rs`、`crates/runtime/tests/live.rs`：各家农机、Antigravity ACP 与 Swarm 旁路（离线单元、模拟 stdio 协议测试、只读旁路边界测试及 `#[ignore]` 实机冒烟）。
