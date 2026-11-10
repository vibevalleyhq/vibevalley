# 帮工

`Session` 是档案（`Agent`）持续工作的执行上下文：
- 处理工单时画成地里的小动物，处理私聊或助手编排时关联频道；外部代理经 [oar](https://www.npmjs.com/package/@botiverse/oar) 驱动，进程内助手经 `AgentHost` 驱动。
- 一次触发到一次汇报是一轮 `Run`；一个 `Session` 可跨越多次 `Run` 与重启。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| `Session` 的创建、恢复、带话、叫停、交接与离场 | 工单状态机、排队、验收与合并决策（[工单](docs/subsystems/issue.md)） |
| `Executor`：oar 实例生命周期、静默检测（`stalls`）与关闭确认 | 农机安装探测、模型列表与档案校验（[档案和农机](docs/subsystems/agent.md)） |
| `Run` 记录（`session_run`）：触发来源、消费输入、结局与花费 | 谁该被唤醒、刹车与投递状态机（[Mailbox](docs/subsystems/mailbox.md)） |
| oar 事件转核心状态事实（`reactionTo`）与轨迹日志（`events/<id>.json`） | git worktree、分支与合并实现（[仓库](docs/subsystems/repo.md)） |
| 并发槽位上限（`noRoom`）、腾位置（`makeRoom`）与每日花费记账 | 记忆的存储与检索算法（[记性](docs/subsystems/memory.md)） |
| 进程内 `AgentHost` 与 `InProcessRun`（供助手运行、记录轨迹与评测） | 助手的编排提示词与工具集（[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/executor/executor.ts`、`stalls.ts` | 管理 oar `Subagents` 实例启停、投递、中断与静默间隔检测 |
| `apps/server/src/session/session.ts`、`registry.ts`、`recording.ts` | 对外 `Session` 服务、在场会话与运行登记表（`Hands`）、数据库持久化与 `/mcp` 令牌 |
| `apps/server/src/session/launch.ts`、`watch.ts` | 并发准入、唤醒/休眠、事件跟踪与 `settling` 后台收尾 |
| `apps/server/src/session/reaction.ts`、`report.ts`、`hiring.ts`、`briefing.ts` | 事件映射、汇报解析、容量检查与任务说明拼装纯函数 |
| `apps/server/src/session/journal.ts`、`host.ts`、`inProcessRun.ts` | 轨迹日志文件读写、进程内 `AgentHost` 与 `InProcessRun` |
| `apps/server/src/runtime/` | 农机注册探测、价格表 `price.ts`、额度 `quota.ts` 与每日花费记账 |
| 表 `session`、`session_run`、`session_run_issue`、`runtime_spend` | 会话主表（含 `pending_report`）、运行轮次、关联工单与按日花费 |
| `apps/web/src/features/session/` | `WorkLog.tsx`、`Trajectory.tsx`、`runs.ts` 瀑布图与 `events.ts` 订阅 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`session.*`、`runtime.*`）。

## 模型和不变量

### 三层概念

| 概念 | 代码与存储 | 含义 |
|---|---|---|
| `Session` | `T.Session`、`session` 表 | 档案的持续工作上下文（工单现场或私聊上下文），编号 `w<n>` 单调递增 |
| `Run` | `T.Run`、`session_run` 表 | 一次触发到一次结束汇报（从 `sessionPhaseChanged(working)` 到 `sessionReported`） |
| oar 会话 | `oarSessionId`、`Subagent` | 底层编码代理的记录流；重启或失联时可在同一 `Session` 下更换 |
| 机器 | `T.Machine`、`machine` 表、`machine/machine.ts` | 帮工干活的那台电脑；今天只有服务端自己这台（开机时没有就记下，主机名为名），雇来的帮工记着它（`Session.machine`），服务端进程里的助手没有。别的机器经命令行加入在后面几步（[一个服务端管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)） |

- **助手与帮工统一在 `sessions` 中**：以 `Session.role`（`orchestrator` 或 `worker`）区分，共用 `phase` 与 `session_run`；仅 `worker` 参与并发槽位、地块分配与目录恢复。
- **助手的会话由帮工模块自己登记**：开机时登记每个助手档案，之后经 `Agent.whenKept` 在档案存下（新建、改、装模板、按模板更新）的那次写返回之前登记或改名；登记失败那次写就失败。工单、频道、Mailbox 用到助手的会话时它已经在了，不再自己补。
- **执行器在机器上，帮工隔着链路找它**：`Session` 经 `Machine.executions(machine)` 拿到一台机器的执行器（`machine/link.ts`），不直接依赖 `Executor`；过界的每个值都复制一份，为执行器搬到别的进程、别的机器做准备。
- **执行器拥有底层资源，`Session` 拥有领域状态**：`Executor` 持有 oar 实例直至确认底层进程关闭才释放占位；关闭失败时继续占槽并拒绝清理该目录。

### 在场阶段与回合结算

| 阶段（`Session.phase`） | 含义 | 用户动作 |
|---|---|---|
| `working` | 正在执行一轮（可带 `quietSince` 静默告警或 `retry`） | 静默过久时查看轨迹或叫停 |
| `done` | 上一轮完成并显式交接（`prSubmit=false`） | 验收、完成或打回 |
| `failed` | 上一轮执行失败 | 让它接着修或取消关单 |
| `resting` | 被叫停、重启恢复、私聊休眠，或 PR 在途等待外部事件 | 带话继续，或等待 CI/Review 唤醒 |
| `closed` | 已离场（从核心状态移除，保留在 `session` 表） | — |

- **后台任务收尾（`settling`）**：主回合结束但仍有未完结后台命令且未调 `issue_report` 时，会话进入 `settling` 保持 `working` 与占槽，等后台任务全部结束后再结算。
- **结构化交接（`issue_report`）**：
  - 报告先同步写入 `session.pending_report`，回合结束时转为 `sessionReported` 并清空。
  - PR 在途或 `prSubmit=true` 时结束后进 `resting` 并释放槽位；仅 `prSubmit=false` 才进 `done`。
- **真实消费回执**：Mailbox 投递在模型真正消费输入时才经 `Session.news` 的 `Consumed` 标为 `consumed`；回合结束或中断时未消费的 `handed` 一律退回 `pending`。
- **触发来源（`RunTrigger`）**：分 `issue`、`comment`、`cron`、`refine` 和 `runtime`；执行中途插入的话记入当前 `Run.heard`，不另开新 `Run`。

### 容量上限、轨迹与花费

- **三级并发上限（`noRoom`）**：
  - 全农场最多 6 个在忙帮工 `maxRunning`，单台农机按 `maxWorking` 限制，单仓库默认最多 3 个 `repo.max_sessions`。
  - 槽位满 6 个又来新活时，`makeRoom` 让最久闲置的工单会话收工或让私聊会话休眠。
- **无沙箱与无逐条权限确认**：帮工在 `$VIBEVALLEY_WORK_ROOT` 下直接执行命令，不弹权限确认；安全边界是服务端只听 `127.0.0.1`。
- **只追加的轨迹日志**：`events/<id>.json` 按序记录每一步事件，流式草稿按 `revision` 递增推送，落盘后不改。帮工留最近 240 条、助手留 1000 条，离场默认 30 天后清理文件。
- **额度与每日花费**：
  - 开机、每 5 分钟及每轮后 20 秒读额度，低于 15%（`quotaLow`）标「快用完了」。
  - 按日花费记入 `runtime_spend` 表；额度或预算耗尽时（`moneyStop`）阻止派新活，在跑回合继续跑完。

## 怎么走

**派出帮工（`Session.hire`）**

1. 在准入锁内检查容量上限，分配 `w<n>` 编号，调用 `Repo.workplace` 准备目录，调用 `Runtime.resolve` 确定农机与模型。
2. 召回档案记忆，拼装规矩、人设、技能与任务说明，通过 `Executor` 启动 oar 会话。
3. 释放准入锁，调用 `hiring` 回调登记工单 `Assignment` 执行关联或私聊投递；若失败则关闭执行器并释放现场。
4. 写 `session` 表并施加 `sessionChanged` 事实，启动事件监听与静默计时器（默认 240 秒无事件报 `quiet`）。

**带话与唤醒（`Session.deliver`）**

1. 会话 `resting` 且执行器仍在时，检查上限、召回新记忆并发送 followup，开启新 `Run`。
2. 执行器已关闭（重启或休眠后）时，按 `oarSessionId` 续接；续接失败则在原目录新建 oar 会话并提示查看 `git log`。
3. 会话正在 `working` 时，支持插话的农机直接 `steer` 进当前 `Run`；不支持的排入下一轮。

**交接与离场（`handOver` / `dismiss`）**

1. 先确认 `Executor` 关闭底层 oar 会话；若关闭失败则拒绝合并或重置，保持现场占位。
2. `handOver` 在会话锁内运行调用方传入的检查与合并函数；失败则保留 `Session` 与分支并返回 `NotTakenIn`。
3. 合并成功或调用 `dismiss` 后，更新 `session` 表为 `closed`、作废 `/mcp` 令牌、通知 `Memory.endSession` 并施加 `sessionLeft`。

**服务端重启恢复（`restore`）**

1. 清理过期轨迹文件，将 `session_run` 中未完结记录标为 `interrupted`。
2. 从 `session` 表读取在场会话：目录丢失的记 `sessionLeft(lost)`，目录仍在的恢复为 `resting` 等待唤醒。

## 和谁打交道

- **工单（`issue`）**：开帮工经 `Mailbox.receive`（`Hire`），调用 `withWorkplace`、`clearWorkplace`、`discardWork`、`dismiss`；订阅 `Session.news`（`Reported`、`Left`、`IssueStarted`、`RunFinished`）。
- **信箱与频道（`mailbox`、`channel`）**：Mailbox 调 `deliver` 并订阅 `news` 的回执和启动动静；Channel 订阅 `news` 的 `Hired`、`Left`、`Reported` 管理工单串与汇报。帮工做的每件事都只在这一条 `news` 上说，各订阅方按 `_tag` 取自己要的。
- **仓库、农机与记性（`repo`、`runtime`、`memory`）**：提供工作目录、农机探测/计费和每轮前后的记忆召回与写入。
- **助手（`orchestrator`）**：通过 `Session.host` 创建进程内 `AgentHost`，共用 `session` 与 `session_run` 表。

## 为什么这样

- **用 `Executor` 隔离进程资源，用纯函数表达领域规则**：防止启动中断或关闭失败时泄漏子进程或重用脏目录；事件映射与汇报解析保持纯函数以便快速单测。
- **区分 `Session`、`Run`、进程连接 `launch` 与 oar 会话**：`Session` 代表跨轮次工作现场，`Run` 记单轮触发与花费，内存 `launch`（`${id}#n`）标识一次底层连接以便重连时退回未确认投递，底层 oar 会话可随时替换而不丢工单归属。
- **一条 `Session.news` 广播全部会话动静**：招人、汇报、离场、消费/退回回执与启动阶段变化统一走单条带 `_tag` 的流，取代多条平行事件流。
- **不做命令级权限确认，靠工作目录与回环监听划边界**：放弃将权限请求做成地里杂草逐条批准（会让帮工停在命令上等人，与无人值守冲突）。
- **显式传递农机 `binPath`，不写进程环境变量**：避免多配置并发时互相覆盖 `process.env`。
- **轨迹单存文件，重启停在 `resting` 不自动重跑**：避免高频工具输出撑大 `SpaceState`，也避免重启后自动重跑外部 shell 命令导致重复副作用。

## 还没做的

- 接入 opencode、grok、kimi、antigravity、cursor 等更多农机：[其他农机提案](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)。

## 怎么验证

- `apps/server/src/session/report.test.ts`、`journal.test.ts`、`inProcessRun.test.ts`：汇报解析、轨迹版本追加与进程内 `Run` 测试。
- `apps/server/src/session/session.test.ts`、`apps/server/src/flows/work.test.ts`：派工、带话、静默告警、容量上限、合并交接与重启恢复测试。
- `apps/server/src/runtime/runtime.test.ts`、`presets.test.ts`：农机探测缓存、额度计算与每日花费测试。

### Worker access observations

`Executor` merges the effective `NO_PROXY` and `no_proxy` entries with `127.0.0.1,localhost,::1` for each child session. Both variables receive the same trimmed, deduplicated list. Inherited and profile values are combined. Null and empty profile values add no entries; they cannot remove inherited bypasses or loopback hosts. Runtimes that declare `refusedSessionOptions.env` receive no added environment values. oar Subagents already refuses these runtimes because it needs a depth variable; this change does not alter that refusal. Other proxy variables and the host environment stay unchanged.

`Session.toolConnections` contains observations for the configured MCP servers. A missing entry or `unknown` means no connection evidence. `starting`, `ready`, `failed`, and `cancelled` are runtime reports, not HTTP health results. These optional MCP observations do not gate a run or establish readiness of the separate required worker CLI. The required CLI gate is described in [worker access](docs/subsystems/session.md#帮工-cli-接入).

The runtime boundary decodes Codex 0.167.0 `mcpServer/startupStatus/updated` parameters with Schema. oar 0.86.0 has no neutral MCP startup event: its inventories are independent workspace queries, and tool-call events describe calls rather than connection readiness. Other runtimes stay `unknown`. Only root-session records for configured servers are accepted. An explicit native `threadId` must match the session. The Codex protocol permits missing or null `threadId` for startup notifications; these are observed on the dedicated session process. Errors are redacted and capped at 2000 characters. The raw notification stays inside the runtime adapter.

The observer replays retained records from `afterSeq: -1`, then reads live records. Detach and close unsubscribe it. A new execution resets the prior connection observations. Session writes failed or cancelled connections to the bounded journal as `run/error` with a structured `connection`. Every observation emits `sessionToolChanged`; projection/reduce replaces only that server’s entry. `sessionToolsReset` clears observations on a new execution or reattachment; resuming a turn on the same execution keeps them. Restarted sessions have no observations until attached. Watch consumers use these shared fields; they do not parse vendor notifications. oar replay covers retained records only, and journal retention remains 240 events.

## 帮工 CLI 接入

帮工 CLI 与 MCP 共用 Session 签发的令牌和同一工具执行路径，交活及 PR 授权仍由领域服务处理。令牌在启动前登记，重新启动时轮换，离场或启动认证失败时撤销；未知身份不回退用户。令牌索引只管凭证，不保存第二份会话状态。

服务端为每个会话写入临时凭证文件：父目录权限 `0700`，文件 `0600`，内容只有回环 MCP 地址和令牌。启动说明只含绝对可执行路径、加载器和凭证文件路径，不含秘密；CLI 自己读文件。离场删除文件，服务作用域结束删除整个目录。文件方案不依赖农机传递秘密环境变量，`ELECTRON_RUN_AS_NODE` 只作用于 CLI 子进程。

派工前先确认 CLI 可执行，再以该会话凭证运行只读 `doctor` 认证请求；任何一步失败都拒绝启动。该探测证明服务端至 CLI 的认证链路，帮工仍须在自己的 shell 中先运行 `doctor`，失败报告阻塞。可选 MCP 的连接状态独立观察，没有证据仍是 unknown。

`session/worker.ts` 是进程、凭证文件与认证探测的外部边界；源码使用绝对 Node、Vite+ 加载器和 `apps/cli/src/worker.ts`，打包后使用同级 CLI 包的 `dist/worker.mjs`。两个入口都应通过同一会话认证门槛；仅源码测试不能证明桌面包可派工。普通模块测试通过 `WorkerAccess` 替换此边界，集成测试运行真实 CLI 与 HTTP。MCP 的异常与错误结果均带 `isError`；CLI 据此非零退出，不匹配本地化文案，服务器拒绝原因脱敏后限制为 8000 字符。命令参数见 [CLI](apps/cli/README.md#帮工会话命令)。
