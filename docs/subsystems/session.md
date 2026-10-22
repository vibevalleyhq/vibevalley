# 帮工

一个帮工档案为一张工单接的活是一个 Session（帮工），农场里是地上干活的小动物。它是 [oar](https://www.npmjs.com/package/@botiverse/oar) 的一个子 agent（`@botiverse/oar/agents`），在工单的 worktree 里一次一次干活：一次触发到一次汇报是一次 run（一季庄稼）。Session 跨好几次 run，重启后还是同一个；底下的 oar 会话可以换。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 开、接回、叫停、收工一个 Session；它的 oar 会话和农机连接 | 工单的状态、派给谁、排队、验收、收获的时机（[工单](docs/subsystems/issue.md)） |
| 一次 run：谁触发的、听到了什么、怎么结束、花了多少（`session_run`） | 挑哪个档案（管家，[agents-and-runtimes.md](docs/reference/agents-and-runtimes.md)「派给谁」） |
| oar 事件读成核心状态的事实；干活过程（事件日志） | 农机的发现、模型、设置页（[agents-and-runtimes.md](docs/reference/agents-and-runtimes.md)「在用的农机」「农具」） |
| 农场的规矩、汇报怎么读（结论、失败、缺肥）、没动静 | worktree、分支、合并、PR 的 git 操作（`project`，[项目](docs/subsystems/project.md)） |
| 同时干活的上限；额度、花费和「派不出去」（`runtime`） | 汇报贴进工单串、@ 谁叫醒谁、投递和排队（田头，[田头](docs/subsystems/channel.md)） |
| 进程内的 agent（管家）怎么跑：起大脑、排输入、边说边写、记 run 和日志、重启后接着做、做错的一轮存成评测（`session/host.ts`、`session/execution.ts`） | 管家想什么、说什么（[管家](docs/subsystems/orchestrator.md)）；记性想起和记下什么（[记性](docs/subsystems/memory.md)） |
| | 地上画成什么（`plotOf`、[farm-ui.md](docs/reference/farm-ui.md)）；干活过程的界面（`apps/web/src/pages/chat/WorkLog.tsx`，管家页和帮工档案的轨迹 `apps/web/src/pages/Trajectory.tsx`，按 run 分段、瀑布图的规则在 `apps/web/src/rules/rounds.ts`） |

## 在哪

- 服务端 `apps/server/src/session`（`Sessions`）：`session.ts` 生命周期（`send` 派、`deliver`/`tell` 带话、`stop`、`dismiss`、交出现场 `handOver`、重启后 `restore`、`/mcp` 认人的令牌）；`facts.ts`（纯函数）把一个 oar 事件读成事实和日志；`rules.ts` 的 `readReport`、`noRoom`、`workplaceRules`、`chooseAgent`（纯函数）；`journal.ts` 日志（开、关、删、推给页面）；`host.ts` 进程内 agent 的宿主（`AgentHost`：输入带着它看不懂的路由，话照路由交回）；`execution.ts` 进程内 agent 的 run；`shell.ts` 读汇报里给主人的问题。
- `apps/server/src/runtime`（`Runtimes`）：农机的注册、探测和安装（`resolve`）、额度、价目（`price.ts`：VibeValley 自己的农机和 dsh 按 `ai/models.ts`，pi 按 pi-ai 自带的价目）、今天的花费；`rules.ts` 的 `agentIssues`、`moneyStop` 是「派不出去」的规则；`dsh.ts` 是 DeepSeek Harness 的农机，`pi.ts` 读 pi 自己的设置。
- 表：`session`（每个派出去的 Session 一行，走了也留着）、`session_run`（一次 run 一行）、`session_run_issue`（一次 run 实际消费了哪几张工单，管家用）。`issue_session` 归工单。
- 库里的 `session` 表：每个 Session 一行，在地里的还存着接回它要的东西（`place` 干活的地方、`oar_session`、`last_text` 最后一轮原话、`recalled` 想起过的记性）。家目录：`events/<id>.json`（日志）、`spend.json`（今天每台农机花了多少）、`logs/`（oar 的原始记录）；核心状态里的 `WorkspaceState.sessions` 随 `state.json` 存。
- 接口：`session.list`、`session.get`、`session.events`、`session.stop`、`issue.runs`、`issue.history`、`runtime.*`、`agent.check`（[capabilities.md](docs/reference/capabilities.md)）。
- 页面：干活过程 `apps/web/src/pages/chat/WorkLog.tsx`，轨迹 `pages/Trajectory.tsx`（[轨迹](docs/reference/agents-and-runtimes.md#轨迹)）；按 run 分段、瀑布的三道和合计的规则在 `rules/rounds.ts`。

## 模型和不变量

**三层**（用词规则在 [concepts.md](docs/concepts.md#session-和-oar-会话)）：

| 层 | 代码里 | 是什么 |
|---|---|---|
| Session | `Session`（`shapes.ts`）、`session` 表 | 一个档案为一张工单接的活：worktree、分支，跨好几次 run；编号 `w<n>`，接着已有的最大号往下排，新 Session 不会撞上旧日志 |
| Run | `Run`、`session_run` | 一次触发到一次汇报，包着一个 oar turn；核心状态里是 `run` 到 `report` 两个事实 |
| oar 会话 | oar 的会话、`Subagent` | 农机的一条可续的记录流；重启或接不上时换一个 |

- **核心状态只放在地里的**：`WorkspaceState.sessions` 是在地里的 Session，阶段是 `arriving`、`working`、`ripe`、`failed`、`resting`；`report` 事实按结果折成 `ripe`（做完）、`failed`、`resting`（叫停、重启打断）。走了的从 `session` 表读，阶段是 `closed`（什么时候、怎么关的：`merged`、`merged_into_graph`、`dismissed`、`lost`、`answered`），轮数、最后一轮的结果和花费从 `session_run` 算，不另存。
- **每个 Session 一个 oar 的 `Subagents`**，深度上限 1：帮工不能经 oar 再派帮工；农机自己派的子 agent（claude 的 Task、codex 的子线程）的事件带 oar 的 agent 路径，记在派它的那次调用下面（`under`），工具调用按「哪个 agent 的、哪一个」认，不按调用编号认。
- **没有权限确认、不开沙箱**：边界是 Session 只在 `VIBEVALLEY_WORK_ROOT` 下的项目里、自己的 worktree 里开工，服务端只听 127.0.0.1（例外见根目录 [AGENTS.md](AGENTS.md)「帮工没有权限确认」）。帮工能在这台机器上执行任意命令，服务端不应对外。
- **档案经 `spawn` 的选项进会话**：人设和技能拼成说明，`append` 放进追加的系统提示，`replace` 替换系统提示，`prompt` 写在交给它的活前面（中间隔 `jobBreak`）；档案的 MCP 服务器、禁用的工具、模型、思考强度、环境变量（农机设置的在前，档案的盖过它）一起交给 oar，不改共享的农机注册表。档案没写模型就用农机设置的默认模型；模型列表里没有的退回农机默认并提醒一次。
- **农机的安装是显式的输入**：农机设置的 `binPath` 作为 oar 的安装选项交给探测，不写进进程的环境变量；`Runtimes.resolve` 带回探测时接受的那个安装，`spawn` 直接用它，不再探一次。指定的路径失效不会悄悄换一台。
- **农场的规矩**（`workplaceRules`，每次开会话附上）：在哪个项目、哪个分支和 worktree，只改这个目录，不切分支、不 push；做完一轮 `git add`、`git commit`，提交信息照项目的约定；工单太大、能分成几件各自验证的，先提交再用 `issue_split` 拆成子工单（[种植计划](docs/subsystems/task.md)）；汇报写 commit 号和怎么验证的，最后一段以「结论：」开头；缺信息的写「要问主人：」，学到的写「记住：」（所有项目都成立的写「记住（所有项目）：」）；在田头怎么 @、怎么用 `channel_say`；加上 `VIBEVALLEY_WORK_ROOT/AGENTS.md`（有的话）作为「这台机器上所有项目的约定」。
- **Session 带一把 `/mcp` 的令牌**（`hb_<id>_<随机>`，只在内存里）：农场作为 MCP 服务器 `vibevalley` 交给它，`/mcp` 凭令牌认出是哪个 Session；令牌只用来分人，不是安全边界，收工时作废。
- **一次 run 记着为什么开的**（`RunTrigger`）：`issue`（第一次派出去）、`comment`（带话，带着那条消息的号）、`task`（种植计划）、`recurrence`（带着哪个定时、是不是补跑）、`draft`（起草工单）；没人发话就开的一轮是 `runtime`（农机自己）。发话的一方先把触发放在 Session 上（`expect`），农机开了这一轮，run 取最早的那个。
- **起草的 Session**（`Session.draft`，派活时 `HireOptions.draft`）：为一张备选工单写草稿，不是这张工单的帮工；它带着 `issue`（工单串、run 都记在这张工单上），但不进 `issue_session`。交回来以后由工单服务重置它的 worktree、请它收工（[工单](docs/subsystems/issue.md#怎么走)「起草」）。田头的派活消息写「看代码，起草这张工单」，再起草写「再起草一版」。
- **干活时插进来的话不开新的 run**，记在这一轮的 `heard` 里；不能插话的农机排队，是下一次 run 的触发。叫不醒、被拒的不算 run。
- **一次 run 的花费从这一次算**：`spent` 事实是这个 Session 的累计，按 oar 报的 token 总数和上一次的差算；换了 oar 会话从零算。汇报带上这一轮开始以来的差（`spent`）。
- **日志只追加**：一条 `SessionEvent`（`seq`、`time`、`type`）写下后不再改；类型照 DeepSeek Harness：`run/start`、`user/message`、`memory/recalled`、`orchestrator/thinking`、`orchestrator/message`、`tool/call`（输入，和动作的说法 `actionText`，写下时取 `actionText`，页面不带这份说法）、`tool/result`（输出和成没成，`call` 指它的调用）、`llm/retry`、`llm/usage`（一次回答的 token：没命中缓存的输入、读缓存的、输出；只有管家记）、`run/error`、`run/end`（带结果）。`run/start` 和 `run/end` 之间的事件都带这个 `run`。流式的话和还没拿到输入的调用是一份草稿，带着它将来的 `seq` 实时推给页面（合并到 0.3 秒一次），下一条事件之前写下。
- **日志的大小**：一个 Session 留最近 240 条，管家（id `orchestrator`）留 1000 条；工具输入留 4000 字，输出留开头 2000、结尾 4000 字（按 UTF-16 数）。日志不进核心状态。
- **走了的 Session 一直是 `session` 表的一行**；它的日志在走了 `session.trajectory_days` 天（默认 30，0 是一直留）后、下次开机时删掉。
- **评论对整张工单说**（`issue.comment`），不挂在某一条事件上。

**同时干活的上限**（`noRoom`，派活和叫醒都查；按「在干」的数：`arriving`、`working`，加上已经交出触发、还没开始的那一轮）：

| 上限 | 值 | 拒绝时说 |
|---|---|---|
| 农场 | 6（`maxRunning`） | 已经有 6 个帮工在干活了 |
| 每台农机 | `RuntimeSettings.maxWorking`（不设不限） | 这台农机上有几个、最多几个 |
| 每个项目 | `project.max_sessions`（默认 3） | 人多了容易改到同一个文件 |

开一轮和发布它在同一把锁（`admission`）里，几个同时来的派活不会占到同一个空位。地里满 6 个又来新活时，工单服务先让歇着的帮工里最早派出去的那个收工（`issue/issue.ts`）。

**派不出去**（`runtime/rules.ts` 的 `agentIssues`，派活前查、`agent.check` 给页面）：档案停用、农机没装或停用、农机不接受档案的选项（人设方式、思考强度、环境变量、MCP、禁用工具）或模型没有这一档思考强度；以及钱的一条（`moneyStop`）：套餐的任一窗口用到 100%（写明几点重置）、余额用完、今天花到每日预算。正在干的会干完。

**额度和花费**（`runtime`）：

- 有套餐的农机读 oar 的账户用量；pi 用它自己配置的 DeepSeek 钥匙读 `GET /user/balance`（只读）；VibeValley 自己的农机不报额度。开机读一遍，之后每 5 分钟读一次；一轮结束后 20 秒再读一次（几轮共用一次）。剩不到 15%（`quotaLow`）的，管家的「农场现状」标「快用完了」，管家尽量换人。
- 花费按价目折成人民币（估算，汇率 `cny_per_usd`）：pi 按 pi-ai 自带的价目（不含 pi 配置里自加的模型），VibeValley 自己的农机和 dsh 的 DeepSeek 模型按 `ai/models.ts` 的价格；claude、codex 等按套餐计费的只记 token，没有每日预算。今天每台农机花了多少在 `spend.json`（写盘合并 1 秒，推给页面合并 3 秒）。

## 怎么走

**派出去**（`send`，由工单服务派活时调）：

1. 查上限；分一个编号 `w<n>`；`Projects` 按工单开或复用 worktree。
2. 想起这个档案的记性（「【你记得的】」一段，和活之间隔 `jobBreak`）。
3. `Runtimes.resolve` 定农机、模型、安装；`spawn` 开 oar 会话。开不成就放回 worktree、作废令牌，报「派不出去」。
4. 调 `HireOptions.hiring`（工单服务记下工单和 Session 的关联）；失败就关掉会话、不上地。
5. 写 `session` 表一行，施加 `hired`，接上事件（`Subagent` 的 follow）和没动静的计时，第一次 run 的触发默认是 `issue`。

**一次 run**：农机开一轮时施加 `run`、写 `session_run` 一行、日志写 `run/start`；之后每个 oar 事件经 `facts.ts` 变成事实（`doing` 是头顶的气泡，只在变了时施加；`retry`；`spent`）和日志。汇报（`SubagentReport`）经 `readReport` 读成 `report` 事实，带上 run 的 id、这一轮的花费和缺肥的问题，`session_run` 记上结果、摘要和花费，日志写 `run/end`，交给记性记下这一轮，20 秒后读一次额度。oar 的 follow 在一个消费者上按顺序交来事件和汇报，汇报不越过它那条记录里的事件：claude 在 `turn_ended` 那一帧里才报用量，汇报照样带得上这一轮的花费。农机进程在干活时退出，记成一次失败的汇报并提醒。

**带话**（`deliver`；`tell` 把结果说成一句话）：

| 帮工此刻 | 做的事 | 结果 |
|---|---|---|
| 歇着，oar 会话开着 | 查上限（不算自己）、想起记性、发 followup | `run`：开一轮 |
| 歇着，oar 会话没开（重启后） | 按 `oarSessionId` 接着原来的会话；接不上就清掉想起过的记性、在同一个 worktree 里新开，告诉它「之前的会话接不上了，看 git log」 | `run`（叫醒） |
| 在干，农机能插话 | 插进这一轮，记进 `heard` | `steered` |
| 在干，农机不能插话 | 排到这一轮之后，触发留给下一次 run | `queued` |
| 档案删了、叫不醒、地满了 | 不开 run，撤回放下的触发 | `refused`，原因写回投递结果 |

**汇报怎么读**（`readReport`）：

- 摘要取最后一个「结论：」那一段（可以加粗、在列表里；后面的补充不算），没写就取最后几段（凑够 80 字），最长 160 字；空的说「做完了」或「没做完」。
- 失败按 oar 的失败分类（`@botiverse/oar/observe` 的 `failureAdvice`）说人话：登录或密钥、额度、限流、余额、模型用不了、上下文太长、请求被拒、服务商太忙、服务商出错、进程退出；带 HTTP 状态码和原因（最长 200 字），加上怎么办（再试一次、过一阵再试、要你先处理）。失败的汇报原话以失败原因开头。登录、余额、额度、模型这四类另发一条醒目的提醒。
- 做完的一轮里以「要问主人：」开头的行进 `report` 事实的 `questions`，工单服务记成缺肥。

**没动静**：`session.ts` 的 `watchStalls` 用 oar 的 `reduceStatus`、`stallOf` 从这个会话的第一条记录起折出状态（oar 自己的 `observeStalls` 只听订阅以后的记录），一轮在干、超过 `session.stall_seconds`（默认 240 秒）没有任何记录时报一次。Session 施加 `quiet`（地块干裂、挂「没动静」，管家的「农场现状」和 Inbox 里也会说），日志记一条 `run/error`，农场提醒一次（带最后在做什么）。下一个不是用量的事件结束它。不自动叫停。

**叫停**（`session.stop`）：打断这一轮，Session 留在地里，带句话开下一轮。

**离开**（收获时 `handOver`、收工 `dismiss`）：先关 oar 会话；收获时在干或有待开始的一轮就拒绝；`handOver` 只管让帮工歇下、交出现场（worktree 和它最后说的话）、按给的关法离开，怎么收（本地合、提 PR、结束 PR、合进计划分支）由调它的人给，执行不知道 PR 和计划；收的那一步失败，Session 和分支都留着：冲突施加 `conflict`，失败照种类说成 `NotTakenIn`（`rules.ts` 的 `notTakenIn`：帮工要带回去修的话、给主人的话、农场的通知、计划记的一行）；冲突由谁解决由调用方说（`settle`：工单交给主人决定，计划直接让帮工修），带话的路也由调用方定。腾位置也归执行：`makeRoom` 在农机或项目到了上限时拒绝，整片地满了就请最久没干活的那个收工（`whoMakesRoom`），并说请走了谁。帮工分支的冲突也归执行：`changes` 看一眼分支会带来什么并更新冲突，标着冲突的帮工交回一轮，执行自己再查一次（那一轮可能已经解决了），工单不用叫它。成功或收工才关上日志、`session` 表记上结束和怎么关的、作废令牌、记性收尾、施加 `left`。收工时分支上有提交就留着分支。

**重启**（`restore`，开机时 `session` 的 `ready` 跑它）：

1. 删掉过期的日志；还开着的 run 记成 `interrupted`「VibeValley 重启了，这一轮停在了半路」。
2. 核心状态里的每个 Session 对上库里它那一行：没有这一行（库按新的表结构重建过）或 worktree 不见了的，施加 `left`（`lost`）、提醒「没接回来」和原因。编号从库里和核心状态里见过的最大号接着排。
3. 接回来的回到各自的地上，oar 会话先不打开，日志接着原来的写；重启时正在干的那一轮施加 `interrupted` 的汇报，帮工歇着，提醒一次「给它带句话就能接着干」。收获、收工不需要会话。
4. 平时改了接回要的东西 300 毫秒后写进库；停机时先写一次（库在这一层之后才关），再放开会话，被停机打断的一轮在开机时才报。

**管家的 run**（`execution.ts`）：管家跑在进程内的 agent 上，不占地。一个实际的 agent loop 是一次 run：第一次真正消费输入时开始，agent 结束时终结（成功 `completed`、模型失败 `failed`、停下 `interrupted`）。同一个 loop 消费了几张工单，`session_run.issue` 是第一张，`session_run_issue` 记全部；还在队列里的输入不归进 run。终结写库失败时这次 run 待终结：重试保持原结果，新输入等它终结成功才开新 run；`currentRun` 不把待终结的当成在干。工单只在收到成功终结（`finishedRuns`）后关上。输入带的摘要消息在真正消费时记进 `Run.heard`，再经 `inputsConsumed` 交给频道提交回执。启动失败另记一次 failed 的 run。

## 和谁打交道

- **工单（`issue`）**：经 `send` 派活、经 `deliver` 带话、经 `handOver` 收获（收法由工单给：`projects.merge`、提 PR 并存下回执、结束 PR）、经 `dismiss` 收工；订阅 `news`（`SessionNews`：`hired`、`reported` 带着那一刻的 Session、`left`，按施加的顺序）：交回带来结果和缺肥，走了让工单判断要不要关上；订阅 `finishedRuns` 关上管家答完的工单。别的模块要看地里的帮工经 `sessionOf`、`presentSessions`，不直接读核心状态里的 `sessions`。`issue.history` 一次返回工单、它真实的 Session（在地里的从核心状态，走了的从 `session` 表）和缺失记录的号（`missingSessions`），查库失败报错，页面对缺失的显示「记录缺失」，不补造歇着的帮工。
- **田头（`channel`）**：执行模块在田头下面不能被它 import，所以由执行模块推给它：登记 `Helpers`，把 `news` 交给 `sessionNews`；投递经 `deliver`（触发是 `comment`，带消息号）；订阅 `launches`（一次启动 `<id>#<n>` 的 `spoke`、`ended`、`closed`、`compacting`）判断投递收没收到，订阅 `inputsConsumed` 提交管家的摘要回执；汇报由田头贴进工单串。
- **种植计划（`task`）**：经 `tell` 带话（触发 `task`），经 `handOver`（关成 `merged_into_graph`）用项目的 `mergeInto` 合进计划分支；订阅 `news` 推进计划里的一步。
- **项目（`project`）**：worktree 的开和放、上限、项目的规矩和合并、PR；Session 只决定在哪干。
- **农机（`runtime`）**：定农机和安装、模型的价格、记花费、一轮结束后读额度、查档案能不能派。
- **记性（`memory`）**：开一轮前想起，一轮结束记下，离开时收尾；同一个 Session 想起过的不再提，接不上换新会话时重新想起。
- **核心状态（`core`）**：`apply` 施加 `hired`、`run`、`doing`、`quiet`、`retry`、`spent`、`report`、`conflict`、`left`；日志的事件推给页面；提醒经核心状态的 side event 发。
- **管家（`orchestrator`）**：向 `Sessions.host` 要一个 `AgentHost`，给它提示、工具、路由和「话发到哪」；日志和记 run 的地方由 `Sessions` 配上，管家碰不到：run 和日志经 `execution.ts` 记，和帮工的放在一起（`session.events orchestrator`）。帮工和管家的 run 走同一组写法（开、听到、结束），管家一轮接了几张工单时另外连上每一张。
- **`/mcp`（`mcp`）**：凭 `Sessions.who` 认出调工具的是哪个 Session。

## 为什么这样

- **帮工是 oar 的子 agent，一套代码驱动全部农机。** oar 统一了发现、开会话、事件、插话和汇报；每种农机自己接要重写这些。服务端是 TypeScript，直接用 npm 的 oar，不再维护一份移植。
- **不要权限确认，用工作目录、worktree 和只听本机圈住。** 开着确认，帮工会卡在第一个命令上，界面也没有批准的地方；各农机的沙箱能力不一样（codex 有 `OAR_CODEX_SANDBOX`，其他没有统一的），先用目录圈住。代价是帮工能在本机执行任意命令，VibeValley 按本机单人使用设计。
- **规则写成纯函数，`session.ts` 只管生命周期。** `facts.ts`、`readReport`、`noRoom` 一个值进、一个值出，有不开会话的单元测试；放弃了按功能拆成几个服务（它们读同一个帮工、同一份记账，要么互相依赖、要么各存一份）。`facts.ts` 不在里面跑 `reduce`：一个事件最多产生「结束没动静」加一条事实，前一条不改后一条要看的字段。
- **Run 是一次干活，Session 跨好几次 run。** 只有「轮」不成为记录时，答不了「这条评论让它干了什么、花了多少、做成没有」。叫 run 不叫 turn：turn 是 oar 那一层的词，各家农机的 turn 大小也不一样（Claude Code 的 `num_turns` 数的是一次提问里模型来回的次数）；也不叫 operation（太泛）。插进来的话不另开 run：农机把它和原来的活放在同一轮里做完、一起汇报，分成两次是假的。
- **这一层叫 Session，和 oar 的会话重名，靠用词规则分开。** `Worker` 说不出「一个档案在一张工单上的一次接活」；`Agent` 和档案撞，`Task` 和工单、oar 的 `TaskStarted` 撞，`AgentSession` 太长。代码里 oar 的那一层只经 import 出现，中文文档里 oar 那一层写「oar 会话」。
- **run 归实际消费输入和终结的一方。** 放弃了「每张排队的工单先开一个 run，结束时一起关」：入队和消费之间隔着停止、失败和重启，会留下从没执行的 run、关掉没消费的工单。多张工单进同一个 loop 时只留一个 run、用关系表关联，不复制几份日志；待终结和在干是两种状态，不能共用「run id 非空」。摘要的回执在真正消费时提交，发送成功只说明进了队列。
- **安装身份是显式的输入，不经进程环境变量。** 两份配置共用一个进程时，写 `OAR_<RUNTIME>_BIN` 会互相覆盖；给环境变量加锁只约束参与同一把锁的调用方，塞进 context 是另一套隐含约定，每次重建农机包装又回到每会话的驱动代理。
- **干活过程记成自己的日志，不读农机的原始记录，也不进核心状态。** 原始记录是各家的格式，重启后会话没打开时读不到；放进核心状态，每次工具调用都让整份状态变大、频繁写盘。日志存文件不存库：一次读写一整条，用不上查询；是谁、怎么关的进 `session` 表，走了也能列出来、看板上的历史不消失。子 agent 不另开一条日志：挂在派它的调用下面，读起来是连着的。走了按天删：一天几十个帮工、每个一份工具输出，会一直涨。
- **汇报取「结论：」，失败按 oar 的分类说人话。** 不让管家用模型给每份汇报写摘要：多花钱、多等，帮工自己最清楚结论；不取第一段：开头多半是「我先看看」。代价是依赖帮工照规矩写，不照做时退回最后几段。
- **没动静只提醒，不自动叫停。** 编译、装依赖、跑整套测试可能很久，自动叫停会打断正常的活。计时从会话的第一条记录起折：只在订阅后收到新记录才开始计时的做法，漏掉一开工就卡住的那一轮。
- **额度用完、预算到了，派之前就拒绝，正在干的干完。** 派出去只会以「额度用完」失败，白开一个会话；叫停正在干的会留下做了一半的改动。花费按 token 和价目估算，不用余额的变化算（几个帮工同时干时分不开）；套餐计费的不折成人民币，折出来的是假的，还会触发每日预算。上限每台农机、每个项目各自可调：服务商的并发限制和项目大小都不一样。
- **重启不丢农场，也不自动接着干。** 全部收工会丢掉没合的活和上下文；自动接着干可能重复执行命令、重复花钱，交给主人一句话决定。代价是 `state.json` 和库要对得上：前者有、库里没有的 Session 记成 `lost` 请走。接回要的东西存在库里 Session 自己那一行、不另存文件：分开存时，库按新的表结构重建了，文件还把帮工接回来，挂着已经不在的工单。
- **农机逐台接通。** 同时照顾八种农机，哪种都打磨不好；pi 先打磨，claude、codex 接回来各有一个种子档案，其余停用，多农机的代码（参数限制、插话能力、额度读法）留着。

## 还没做的

- 事件的内容按 `type` 分进 `data`、Step 这一层；Session 不再自己往频道说话（删 `farm_*` 和令牌，进出频道只经服务端两个口子）：[Session、Run、事件](.agents/notes/proposed/architecture/2026-10-17-session-run-step.md)。
- 给 agent 的话什么时候、怎么交给它只在一处定（每个 agent 一个信箱）：[编排层](.agents/notes/proposed/architecture/2026-10-18-one-mailbox-per-agent.md)。
- opencode、grok、kimi、antigravity、cursor 逐台接通：[pi 打磨好之后接回其他 runtime](.agents/notes/proposed/feature/2026-10-10-other-runtimes.md)。

## 怎么验证

- `session/rules.test.ts`（纯函数，不开会话）：一轮从活开始、花费从上一次的累计算、没动静以一句话结束而不是用量、重试和模型失败和进程退出说人话、子 agent 的步骤说是谁的、摘要是结论、做完和失败的一轮怎么读、给主人的问题、工作区的上限、Session 的编号、挑档案。
- `session/journal.test.ts`：日志存下、放开以后从盘上读回、接着原来的写；子 agent 的步骤挂在它的调用下面；长出来的一步只推一次、写下；只追加。
- `session/session.test.ts`（oar 的 `scriptedRuntime` 扮演帮工、真的 git 仓库）：派出去、干一轮、汇报、带一句话、收获；要了的一轮在开始干之前占着位置。
- `src/flows/work.test.ts`（照字眼干活的帮工、真的 git 仓库）：派出去、干活、汇报、回家；被拒的原因；合并后清掉 worktree、记进账本；重启后歇着回来、叫得醒；每一步都在轨迹里；失败说原因；没动静被标出来（开工就不出声也算）；合并前看改动；冲突的分支留到解决；项目和农机的上限；两个同时派到新项目；开口、结束、令牌随它走；每次 run 记着为什么开、重启打断的记成 `interrupted`；到场时工单已经在；走了的是一行。`flows/reach.test.ts`：帮工的 `/mcp` 跟着服务端实际的地址。
- `session/execution.test.ts`：管家的一个 loop 是一次 run、关联它消费的全部工单，失败和叫停怎么说；终结没写成的 run 在下一次开始前先终结。
- `runtime/runtime.test.ts`：接受的探测拥有它读用量的那个安装、慢的不覆盖新的；适配器的拒绝挡住档案；列表带每台农机的预设和事实；两份配置不经环境变量互相影响；昨天的花费不挡今天；存不上的设置被拒；`resolve` 管默认、覆盖和模型的退回；价目分开算缓存、按人民币；dsh 和 pi 的价格和余额。`runtime/rules.test.ts`：黄金数据和额度的说法。`runtime/dsh.test.ts`：DeepSeek Harness 的模型和思考强度。
- 页面：`apps/web/src/rules/rounds.test.ts`（日志怎么按 run 分段、瀑布图）。
