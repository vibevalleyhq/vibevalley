# 帮工

帮工是「一个档案（`Agent`）干一件活」：会话（`Session`）和它的每一轮（`Run`）、工作目录、农机的执行和轨迹。Rust 版里这些在工单板（`vibevalley-issues` 的 `Board`）里跑，服务端的 `modules/session` 只给 `session.*` 端点、轨迹和工单观察流。
- 处理工单时画成地里的小动物，处理私聊时关联频道；外部农机经 `vibevalley-oar` 驱动（Claude Code、Codex、ACP 与测试用的 scripted），VibeValley 自己的 agent 是 oar 里的 `vibevalley` 农机。
- 一次触发到一次汇报是一轮 `Run`；一个 `Session` 可跨越多次 `Run` 与重启。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `Session` 的创建、带话（插话或开下一轮）、叫停、交接与离场；worktree 的开、重置、清 | 谁听见一句话、三道刹车（[观察层](docs/subsystems/watch.md)） |
| 每一轮：触发来源、结局、汇报（`issue_report`）、问题；静默检测 | 工单状态机、验收、合并、拆单（[工单](docs/subsystems/issue.md)） |
| 并发上限（全农场、每个仓库）、排队 | 农机安装探测、档案校验（[档案和农机](docs/subsystems/agent.md)） |
| 轨迹（`SessionEvent`）的记录、推送与读回；`/mcp` 帮工门的令牌 | 记忆的存储与检索（[记性](docs/subsystems/memory.md)）；助手的编排（[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/vibevalley-issues/src/lib.rs` | `Board`：开会话、带话（`tell`，在干活的经 oar `steer` 插进这一轮）、叫停（`stop`）、结算一轮、静默检测、重启时把在干活的会话记成打断；并发上限在 `BoardConfig`（`space_limit` 6、`per_repo` 3、`quiet_after` 240 秒） |
| `crates/vibevalley-issues/src/report.rs`、`runs.rs` | 一轮末尾的结构化汇报；每张工单的各轮 |
| `crates/vibevalley-issues/src/talk.rs` | 私聊帮工：没有工单的会话，在自己的目录里一轮一轮答，答的话由观察层贴进私聊 |
| `crates/vibevalley-issues/src/drivers.rs`、`crates/vibevalley-server/src/modules/agent/drive.rs` | 把工单指派的档案变成农机和启动参数（规矩、人设、记性、MCP） |
| `crates/vibevalley-server/src/modules/session/journal.rs` | 轨迹：每个会话的步骤存 `<家目录>/events/<id>.json`，变化时每 300 毫秒推一次、每 1.5 秒落盘 |
| `crates/vibevalley-server/src/modules/session/mod.rs` | `session.*` 端点和 `issue.watch` 订阅流 |
| `crates/vibevalley-server/src/modules/mcp/mod.rs` | 帮工的 `/mcp` 门：JSON-RPC，令牌由工单板开帮工时签发（`Board::who` 认人），工具是农场的帮工工具（[工具](docs/subsystems/orchestrator.md)） |
| `crates/vibevalley-oar/src/` | 驱动各家农机：`claude.rs`、`codex.rs`、`acp.rs`、`vibevalley.rs`、`scripted.rs`；`record.rs` 是 JSONL 记录流 |

## 模型和不变量

- **`Session` 与 `Run` 分开**：`Session` 是档案的持续工作现场（工单的 worktree 或私聊的目录），编号单调递增；`Run` 是一次触发到一次结束汇报；底层 oar 会话可在同一 `Session` 下更换。
- **在场阶段（`Session.phase`）**：`working`（可带 `quiet_since`）、`done`、`failed`、`resting`、`closed`。显式交回且没有待答问题才 `done`。
- **结构化交接（`issue_report`）**：帮工经 `/mcp` 的 `issue_report` 交状态、问题、`checks` 与 `answer`（`Board::report`）；一轮没交汇报就从它说的话里读问题。
- **带话**：会话在干活时插进当前一轮；歇着时开下一轮；对排队工单说的话随它一起交给帮工。没有 TS 版的持久信箱、投递状态机和四档紧急度：观察层排着的投递在内存里，随下一次叫醒带上。
- **并发上限**：全农场最多 6 个在干活的会话，单仓库默认 3 个；满了工单留在 `todo`（`stage: queued`），空出来按看板顺序补派。
- **无沙箱与无逐条权限确认**：帮工在 worktree 里直接执行命令，农机的权限请求一律放行（`PermissionMode::Bypass`）；安全边界是服务端只听 `127.0.0.1`。
- **轨迹单存文件**：按序记录每一步，流式草稿按 `revision` 原地增长，不进 `SpaceState`。
- **重启**：开机时还在干活的会话那一轮记 `interrupted`，会话停在 `resting`，工单进 `stuck: interrupted`，用户点「继续」或再说话时接着做；worktree 丢了的工单取消（`lost`）。

## 和谁打交道

- **工单**：同在 `Board` 里。
- **观察层（`watch`）**：频道的话经 `Board::tell` 交给帮工；会话的动静（开工、汇报、离场）经 hub 的事实和 `Board` 的消息流回观察层，由它开串、贴汇报。
- **档案和农机、记性（`agent`、`memory`）**：开会话前经 `Drivers` 选农机、拼说明、召回记忆。

## 为什么这样

- **用 oar 驱动农机，不自己写各家协议的循环**：Claude Code、Codex、ACP 各有各的协议，oar 收成一个会话接口（事件、插话、关闭）。
- **不做命令级权限确认，靠工作目录与回环监听划边界**：逐条批准会让帮工停在命令上等人，与无人值守冲突。
- **外部农机重启后停在 `resting` 不自动重跑**：避免重跑外部 shell 命令导致重复副作用。

## 还没做的

- 拆 `Board`：工单、会话、工作目录三个模块，状态变化只经带类型的命令（[原生的 VibeValley](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md) 的 R4）。
- TS 版的持久信箱与重投、多台机器、帮工 CLI 接入（`worker` 命令走 `/mcp` 的令牌）、MCP 连接观察：Rust 版没有或从简。
- 接入更多农机：[其他农机提案](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)。

## 怎么验证

- `crates/vibevalley-issues/tests/board.rs`：开工、提问、失败、打断与续上、排队与上限、重启、静默、权限放行。
- `crates/vibevalley-server/tests/session.rs`：轨迹的流式步骤、子 agent 的步骤、落盘读回、工单的观察流。
- `crates/vibevalley-server/tests/mcp.rs`：`/mcp` 帮工门。
- `crates/vibevalley-oar/src/tests.rs`、`crates/vibevalley-oar/tests/live.rs`：各家农机的适配（`live.rs` 要装了的农机）。
