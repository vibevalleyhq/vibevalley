# 服务端：管家和帮工

`server` 是 Go 模块 `vibevalley`，只听 127.0.0.1:8787；局域网里的设备经「院门」进来。包怎么分、服务怎么组装、测试见 [server/README.md](../../server/README.md)；存了什么、配置见 [architecture.md](../architecture.md)。核心状态只经 `Core.Apply` 改；纯规则在 `protocol` 包，只有服务端用的在拥有它的包里（`session/facts.go`、`session/rules.go`）。

## 管家

管家是 VibeValley 自己的 agent（`server/internal/agent/brain`；`manager/manager.go`；[理由](../../.agents/notes/implemented/architecture/2026-10-12-own-agent.md)），带管家的提示词和工具，第一句话到了才起来。它没有读写文件、跑命令的工具，自己不写代码。

- **模型**：只接 DeepSeek，在管家的档案里（档案 `manager`，每个农场都有、删不了、只在 VibeValley 自己的 agent 上跑；`vibevalley agent save manager --json …` 改，管家下次开口时用上），没写是 `deepseek-flash`。钥匙先取首页「设置」，再取配置的 `deepseek.api_key`（`DEEPSEEK_API_KEY`）；每次请求前现取。都没有时它在田头说起不来；同一个原因在一个对话里只说一次，管家起来了才会再说。
- **对话**：存在 `manager/manager.jsonl`，太长时把早先的压成摘要，原文归档在 `manager/archive/`。一次请求估出超过 12 万 token 就在请求前压，这一轮停下时存下；一轮停下时超过 9.6 万，10 分钟里没有新的输入、10 分钟内也没有管家自己的定时要到点，就在没人时压（`internal/agent/brain/idle.go`）。摘要用和平常请求一样的开头请求（同一份系统提示和工具，对话之后加一句要摘要，不许调工具），读得到缓存；没要到就退回单独的摘要请求。最近的 12 条和管家最后 3 句带字的话原样留下。摘要请求的用量也记一条 `llm/usage`（「整理对话，…」）。
- **记性**：主人让它记的用 `remember` 记在 `manager/MEMORY.md`，在系统提示的快照里，快照之后的变化写在下一条输入开头（[agents-and-runtimes.md](agents-and-runtimes.md)「管家页」）。
- **系统提示**：说明、工作目录、记性的快照，在管家起来时和每次压缩之后拼一次，其间一字不变，DeepSeek 的前缀缓存才命中得了（[理由](../../.agents/notes/implemented/architecture/2026-10-18-stable-prompt-prefix.md)）。
- **每条输入的开头**（`manager/manager.go` 的 `sendInput`）：`【现在】`（到分钟）；农场现状：项目、能派的档案（额度、花费、派不出去的原因）、各频道地里的帮工、没收完的计划和这条输入回在哪个频道，起来后、压缩后和管家忙着时收到的那条带全文（`【农场现状】`），其余只带和上一条比变了的行（`【农场变了】`，`manager/situation.go`；变了一大半也带全文，没变就不写）；快照之后记下或忘掉的记性（`【记性有更新】`）；这期间田头上的汇报；最后是这次的话。整条和对话一起存下。
- **用量**：每次回答在它的日志里记一条 `llm/usage`，写着缓存命中多少（读缓存 ÷ 读缓存加没命中）。提示的开头（工具和系统提示）在两次压缩之间变了，`internal/agent/brain` 发 `PrefixChanged`（按段比 sha256：`instructions`、`env`、`skills`、`memory`、`tools`），那一条后面写明是哪几段，服务端日志也记一行。
- **重启后**：服务端在管家一轮做到一半时停了（崩了、重启），开起来时对话停在模型还没回的地方（工具做完了、输入还没人回），而且不到 30 分钟，就接着做完那一轮，回答发回原来那条输入的频道；做到一半的工具补一条失败的结果：「不知道它做没做成：先查一下现状」。那条输入是交给管家的工单时，接着做的这一轮记在那张工单上，做完了照常关上它。主人叫停的、做完了的不接；超过 30 分钟的不接，日志里记一条「上一轮停在了半路，太久了，没有接着做」。
- **说话**：中文、口语、一两句，只说工具结果和汇报里有的；在串里被问就回在串里。语音管家转来的话（`/api/v1/voice/agent/heard`，带着通话号）已经在电话里答过了：它按需派活，派了就说一句派给了谁，没派就不说（[voice.md](voice.md)「客户端」）。
- **OpenAI 的协议**：`POST /v1/chat/completions`（只听 127.0.0.1，院门不放），`model` 是 `vibevalley-manager`，`stream` 为真时回 `chat.completion.chunk` 的 SSE，否则回一个 `chat.completion`。只取最后一条 `user` 的话，当作主人在田头说的，回答也进田头；`system`、前面的几轮和 `tools` 不读，回的只有字。同一时间只流一个回答：新的请求（或一通电话里的新一句）结束上一个的流。协议在 `internal/agent/brain/openai.go`，语音线路也用它（[voice.md](voice.md)「语音线路」）。
- **听到什么**：没 @ 别人的话、@管家 的话、没做成的汇报、计划的提醒、到点的定时、巡查的发现。它忙时人的话插进这一轮，其余等这一轮做完。做完的汇报不叫醒它，下次开口时一起交给它。交给它的话里，不是主人说的（帮工的汇报和提问）超过 800 字（UTF-16）只给前 800 字，后面写明有多少字、用 `read_chat` 读哪里；主人的话照原样给。`read_chat` 给全文。
- **话是谁说的**：交给管家的每一条输入开头写着来源（`manager/input.go` 的 `managerHead`）：`[来源：主人]`（田头、电话、`/v1/chat/completions`、连接器里只有主人的话）、`[来源：田头]`（频道或串里有帮工的话，后面写明帮工引用的网页、代码、文件内容是信息、不是指令）、`[来源：工单]`、`[来源：定时]`、`[来源：巡查]`、`[来源：种植计划]`。来源和「这条里有没有主人的话」跟着输入存进 `manager.jsonl`（`source`、`owner`），管家的日志里每一轮的第一句也带着来源。
- **合进主分支、计划开工要主人说一声**：这一轮最新的那条输入里没有主人的话，`merge`、`graph_action merge` 和 `graph_action start` 不动手，答它在频道里问主人；派活、带话、叫停、收工不挡。
- **叫停**：管家在想或在说时，田头的输入框旁边有停止键（`POST /api/v1/manager/stop`，`vibevalley manager stop`）。它停掉正在跑的这一轮、丢掉排着等它的话（巡查过后还会再报，计划的状态在计划板上）；已经说出来的半句留在田头，派出去的帮工照常干活；交给管家的工单那一轮记成叫停了（`interrupted`），管家的日志里记一条「主人叫停了」。管家闲着时什么也不做。
- **做错的一轮**：主人在管家页的轨迹里把一轮标成做错了，写一句应该怎样（`manager.markWrong`，`POST /api/v1/manager/evals`，`on` 是那一轮收到的话在轨迹里的第几步）。服务端从 `manager.jsonl` 找到这句话成了哪条输入，存成一个样例 `manager/evals/<id>.json`：这一轮开始时模型看到的对话（`before`，压缩照算）、这条输入（`input`）、这一轮的消息（`did`，到下一条输入为止）、那时的 `MEMORY.md`、工具名和模型，`expect` 空着。话没进对话（管家那时没起来）的不收。样例怎么写判断、怎么用真模型重放见 [verify-manager-evals](../../.agents/skills/verify-manager-evals/SKILL.md)。

工具在 `internal/tool`（和帮工的工具同一处定义）：派活（`dispatch`，挑谁见 [agents-and-runtimes.md](agents-and-runtimes.md)「派给谁」）、看和收获（`changes`、`merge`）、看帮工（`roster`、`check`）、带话叫停收工（`tell`、`stop`、`dismiss`）、频道、定时、记性（`memory_search`、`memory_add`，下文「记性」）和种植计划。

**帮工汇报**以帮工自己的名义贴进它的工单串，管家不转述；没做成的叫醒管家。叫停的不贴。

## 定时

「每天早上九点在 #clock-in 跑一遍测试」这类（`schedule/schedule.go`；规则是 protocol 的 `schedules.go`；[理由](../../.agents/notes/implemented/feature/2026-10-11-channels-and-schedules.md)）。

- 主人跟管家说，管家用 `schedule` 定；页面上只在频道菜单的「定时」里看、开关、删。
- **谁定的**（`Schedule.by`）：`owner` 是主人经接口、命令行定的，`manager` 是管家用 `schedule` 定的；列表里管家定的写着「管家定的」。
- **等主人同意**（`schedule/rules.go` 的 `needsOK`；[理由](../../.agents/notes/implemented/architecture/2026-10-18-source-is-not-instruction.md)第 5 节）：主人定的、和管家在主人这一轮里（最新那条输入有主人的话）定的，当场生效；管家不是主人叫醒时定的，只有不派帮工的一次性回头看当场生效，会反复来的、直接派帮工的存成关着、`pending`，到点也不跑。主人在定时列表里点「同意」（`schedule.update` 打开，同时清掉 `pending`；管家调不了这个接口）或「不要」（`schedule.delete`）。管家的工具对待批的回「定好了，等主人同意才生效：……」，它照实告诉主人。
- 一次、每隔几分钟、每天几点、每周几几点，或者五段的 cron（分 时 日 月 周几，`schedule_cron.go`），按它的时区。写成 cron 的每天、每周和原来的两种在同样的时刻到点；八年里都不会到点的不收（[理由](../../.agents/notes/implemented/feature/2026-10-18-cron-and-follow-ups.md)）。
- 管家也会自己定一次性的「回头看」：派了活、答应了主人一件事、或在等一个结果时，到点看一眼再说。会反复来的只在主人要的时候定。
- 一个定时一张工单（`issue/dispatch.go` 的 `scheduled`；[理由](../../.agents/notes/implemented/architecture/2026-10-16-a-schedule-is-a-trigger.md)）：写了帮工档案的派给那个档案，没写的派给管家（`agent` 是 `manager`）。每次到点是这张工单的一次 run，触发记着这个定时、是不是补跑。
- 到点先在频道里说一条提示，然后：
  - 第一次到点，写这张工单并开工，地满了就排队；
  - 派给帮工的：帮工还在就给它带话，工单关了（收获、收工）就重开、派一个新帮工；
  - 派给管家的：重开（关着的话），交给管家；管家答完这一轮就关上，关单原因是 `answered`。重启时还开着的记成丢了。
- 一次性的跑过就关。
- 服务端没开着时错过的，开机后只补一次。
- 到点先保存这次运行的时间；保存失败时不发提示、不派活，下一次检查再试。重新开启周期定时，开关和起算时间一次写入。

## Inbox

要主人处理的事（protocol 的 `inbox.go`；[理由](../../.agents/notes/implemented/architecture/2026-10-15-inbox.md)），从核心状态现算、不存，放在 `StateFrame.inbox`。农场手机当来电，桌面的通知和菜单栏也读它。

| 种类 | 什么时候 |
|---|---|
| `merge` | 帮工这一轮做完，等你看 |
| `fix` | 帮工这一轮没做成 |
| `conflict` | 合进主分支会冲突 |
| `quiet` | 干着活好久没动静 |
| `task-draft`、`task-ripe` | 计划拆好了等你看、做完了等你收 |
| `task-failed` | 计划里有一步没做成 |
| `mention` | @主人 的话，你没读也没回 |
| `schedule-ask` | 管家定的定时等你同意（目标是定时所在的频道） |

计划里的帮工由计划报，不单独算；一个帮工一次只算最要紧的一件。

## 巡查

巡查（`manager/patrol.go`，`Manager.Patrol`；规则是 protocol 的 `patrol.go`）每 `patrol.heartbeat_minutes` 分钟不调模型看一遍 Inbox，找放久了没人管的（`mention` 15 分钟、`quiet` 20 分钟、`merge` 和 `conflict` 2 小时、`task-failed` 30 分钟），有的才按频道叫醒管家一次，由它决定提不提醒主人。同一件事 4 小时内不再报。

## 设置

首页的「设置」（`setting/setting.go`；[理由](../../.agents/notes/implemented/feature/2026-10-12-title-screen-and-settings.md)）存 DeepSeek 的钥匙、Agora 的 App ID 和 Certificate，和语音设置（[voice.md](voice.md)「配置」）。存在 `$VIBEVALLEY_HOME/settings.json`（0600）。设置里的优先于配置（[architecture.md](../architecture.md)「配置」）；每次用时现取。页面只看到每样从哪来和最后四个字，钥匙不出服务端、不进日志。设置里还有记性的来源（下文「记性」）。服务端的日志整行过一遍 `base.Redact`（`base/redact.go`）：长得像钥匙的（`sk-…`、`ghp_…`、`xoxb-…`、`AKIA…`、JWT、私钥块、农场自己的会话令牌）和跟在 `api_key=`、`token:`、`password=`、`Bearer` 这类名字后面的值，写成 `[redacted]`。

## GitHub 检测

服务端开机在后台检测 `gh --version`、`gh auth status --hostname github.com --active`；`github.status` 读缓存，`github.refresh` 手动重查并刷新开着的 PR，`setting.check` 的 `github` 返回同一份状态。结果只含安装、版本、登录、账号、检测时间和中文原因，不返回命令原文或 token。

`project list` 的 `pullRequest` 给出能否提 PR 和原因。刷新同时检查各项目的 `origin`（GitHub 的 HTTPS、SSH 地址）及 `gh repo view <owner/repo> --json viewerPermission`，`ADMIN`、`MAINTAIN`、`WRITE` 算有写权限。列表不调用 gh；新建项目或修改远端后用 `github refresh` 更新。检测中的首次读取标为尚未检测；命令失败或超时不能判为可提 PR，检测及 PR 命令限时 15 秒，克隆限时 3 分钟。

## 帮工

每个帮工是 smith（`server/pkg/smith`）的一个子 agent：并发上限 6（`protocol.MaxRunning`），帮工不能再派帮工。没有权限确认，靠工作目录、worktree 和只听本机圈住（[理由](../../.agents/notes/implemented/architecture/2026-10-10-helpers-as-oar-subagents.md)）。档案决定农机、模型、人设、技能和环境变量（[agents-and-runtimes.md](agents-and-runtimes.md)）。

**农场的规矩**（`session/rules.go`）：每次派活附上在哪个分支和 worktree、只改这个目录、不切分支不 push；做完一轮就提交；汇报写提交号和怎么验证的，最后一段以「结论：」开头；学到的写成「记住：」；加上工作目录的 `AGENTS.md`（有的话）。

**会话事件变成事实**在 `session/facts.go`（纯函数）：一轮开始、在做什么（`doing`，气泡）、重试、花费、一轮结束。

**每次干活**（run，`session/runs.go`）：农机开一轮就是一次 run，到这一轮的汇报结束，记在 `session_run` 表。发话的一方先说清这一轮是为什么开的，农机开了这一轮，run 就记下它：派出去（`issue`）、带话（`comment`，带着那条消息的号）、种植计划（`task`）、定时（`schedule`，带着哪个定时、是不是补跑）；没人发话就开的一轮记成农机自己（`runtime`）。干活时插进来的话不开新的 run，记在这一轮读到的话里（`heard`）；排队的话是下一次 run 的触发。叫不醒、被拒的不算 run。服务端重启时还开着的 run 记成叫停了。一张工单的 run 用 `GET /api/v1/issues/{id}/runs` 取，不在核心状态里。

**干活过程**（`session/events.go`）：一个 Session 的日志，一条一个 `SessionEvent`（`seq`、`time`、`type`，照 DeepSeek Harness 的会话事件）：`user/message`、`memory/recalled`、`assistant/thinking`、`assistant/message`、`tool/call`（输入）、`tool/result`（输出和成没成，`call` 指它的调用）、`llm/retry`、`llm/usage`（一次回答的 `tokens`：没命中缓存的输入、读缓存的、输出；只有管家记）、`run/error`，记在 `events/<id>.json`。日志只追加：写下的一条不再改；流式的话和还没拿到输入的调用是一份草稿，带着它将来的 `seq` 实时推给客户端，下一条事件之前写下（`session/events.go`）。每个 Run 由 `run/start` 和 `run/end`（带它的结果）围起来，中间的事件都带着这个 `run`。带话时可以评论某一条（`on` 是它的 `seq`），服务端把那一条写在话前面交给帮工。

**工单的执行历史**：`GET /api/v1/issues/history` 一次返回工单、它关联的真实 Session 和缺失记录的号（`missingSessions`）。查库失败时报错；记录不存在时列出缺失号，客户端显示「记录缺失」，不补造歇着的帮工。

**Session 的记录**（`session/records.go`、`session/trajectories.go`；[理由](../../.agents/notes/implemented/feature/2026-10-13-trajectories.md)、[提案](../../.agents/notes/proposed/architecture/2026-10-17-session-run-step.md)）：每个 Session 派出去时在 `session` 表里写一行：谁、哪个档案、哪张工单、哪个项目、什么时候开始；走的时候记上什么时候、怎么关的，一直留着。`session.list` 和 `session.get` 给的都是 `Session`：在地里的从核心状态来，走了的从这张表来，阶段是 `closed`，轮数、最后一轮的结果和花费从 `session_run` 算。事件日志在走了 `session.trajectory_days` 天后删，`session.events` 读它；管家一条，留最近 1000 条。帮工自己派的子 agent 的事件挂在派它的那一条下面（`under`）。

**工单**（`issue/issue.go`、`issue/dispatch.go`；[理由](../../.agents/notes/implemented/architecture/2026-10-15-issue-is-one-thing.md)）：

- 存在 `issue` 和 `issue_session` 表；开着的和最近关的 50 家在核心状态里。
- 交给帮工的是标题，空一行，再是说明。
- **状态**由 `protocol.IssueStatusOf` 算：`backlog`（写下没派）、`todo`（排队等空地）、`in_progress`、`in_review`（等你看）、`done`（合进主分支、合进计划、管家答完）、`canceled`（收工、丢了、放弃、跳过，或没说怎么关的）。看板按它分列。
- 还没派的能改、能删、能排先后；派出去以后不能。
- **改状态就是派活**（`issue/status.go`；`PUT /api/v1/issues/{id}/status`，`vibevalley issue status <id> --json`；[理由](../../.agents/notes/implemented/architecture/2026-10-18-status-is-the-dispatch.md)）：主人只能挪到 `backlog`、`todo`、`done`、`canceled`，`in_progress`、`in_review` 是帮工干出来的。备选挪到待办就开工，地都占满了就在待办排队，服务端每 5 秒按先后试一遍；待办挪回备选是不排了；等你看挪到待办是带一句话（`text`，必填）再干一轮；挪到已完成是收获，按项目配置提 PR 或本地合进主分支；挪到已取消是叫帮工回家（没派过的直接关上）；关上的挪回待办是带一句话重开；没派过就取消的挪回备选。每张工单的 `moves` 列出它现在能挪到哪，看板照它决定能不能拖；派给管家的和种植计划里的工单 `moves` 是空的。
- 帮工离开时，离开的是最后一次执行，工单就跟着关上。
- **重开**：同一个档案派一个新帮工到同一个项目，带上原来要做什么和上一次怎么关的。
- **子工单**：带 `parent`、`blockedBy`。种植计划用它，计划里的工单跟着计划走，看板不能单独开工、重开。

**汇报的摘要**取「结论：」那一段。失败按 smith 的分类说人话并说怎么办，要你处理的（登录、余额、额度、模型）另发一条提醒。

**没动静**：一轮里超过 `session.stall_seconds`（默认 240 秒）没有任何记录，施加 `quiet`、提醒一次；一有动静就结束（[为什么](../../.agents/notes/implemented/feature/2026-10-10-quiet-turns.md)）。

## 田头

农场的群聊（`channel/`；规则是 protocol 的 `chat.go`、`chat_rules.go`；[理由](../../.agents/notes/implemented/feature/2026-10-11-farm-group-chat.md)）。

**对话**：频道，加上挂在频道消息下面的串。田头是默认频道，主人可以再开（名字 1～24 个字、数字、`_`、`-`），可以带默认项目。派活时管家在那个频道发一条派活消息，下面开工单串。地址写成 `#<频道>`、`#<频道>:<消息号>`；消息号是这条消息在它所在对话里的序号（每个对话从 1 数，主键本身是 uuidv7）。

创建频道的接口返回实际频道号；客户端用它跳转，不从名称猜号或等待状态流确认。聊天消息带着产生它的 `run`，过程面板按这个号取事件；没有号的消息不按时间推测归属。

**@ 名**：`@w3`、`@管家`、`@主人`、`@所有人`（只有主人能用）；代码里的不算。

**给谁、叫不叫醒**（`channel/rules.go` 的 `chatAudience`）：

| 谁说的 | 叫醒谁 | 只让谁知道 |
|---|---|---|
| 主人在频道里 | 被 @ 的；没 @ 时是管家 | 频道里的帮工 |
| 主人在串里 | 被 @ 的、串里的帮工 | — |
| 管家或帮工 | 被 @ 的；在一个帮工的串里说话叫醒它 | — |
| 帮工的汇报 | 没做成时叫醒管家 | 做完时给管家 |

**刹车**：只管 agent 叫醒 agent。从主人上次说话算起，一个对话里最多 4 次（`HopLimit`）；同一个帮工被 agent 叫醒至少隔 60 秒；连着 3 次叫醒都在开口前失败就不再自动叫它，等主人亲自说。

**送达**：每条给帮工的消息走 未交付 → 提示过 → 已交付 → 看到了。歇着的帮工被叫醒时新一轮带着给它的消息；这一轮真的开口了才算看到，没开口就退回、过一会儿再叫。忙着的帮工攒几秒，插一句不带正文的提示（`BusyNotice`）。宁可重复给，不会丢。

**重发不成两条**：主人的话（`POST /api/v1/say`、`/api/v1/manager/hear`、`/api/v1/voice/agent/heard`）带客户端为这一次发送生成的 `sendKey`（至多 64 个字，长了拒绝）。同一个人带同一个键再发，就是已经说过的那一条：不另写、不再送，管家也不再听一遍（`channel_message` 的 `send_key`，唯一索引在发送者和键上）。客户端为一份草稿生成一个键，发成功才换；发送失败时草稿留在输入框里，重发用同一个键。连接器那条路按外部消息 id 去重，不带键。

**帮工的工具**（定义在 `internal/tool`，`internal/mcp` 在 `/mcp` 上交出去；`mcp` 是给编码 agent 的入口，和 HTTP 并排）：`channel_say`、`read_chat`（和管家的是同一个）、`channel_inbox`、`session_list`，和记性的 `memory_search`、`memory_add`（下文「记性」）。每个会话带一个自己的令牌（`session/tokens.go`），只用来分清是谁在说话。`channel_say` 发出前会拦下：目标里有它没看过的新消息、读的是串却发到顶层、60 秒内重复同一句。

## 连接器：微信、飞书、QQ

主人可以在微信、飞书、QQ 里和农场说话，在「连接器」页（`/connectors`）连上（`connector/connector.go`；三家的接口在 `server/pkg/weixin`、`feishu`、`qq`；[理由](../../.agents/notes/implemented/feature/2026-10-11-channels-and-schedules.md)）。微信扫码，飞书扫码建一个个人机器人，QQ 填机器人的 AppID 和 AppSecret。扫码的完整尝试在各自 SDK：微信拿到二维码后最多等 8 分钟，过期或验证码被禁用累计 3 次后结束；飞书按返回的间隔和有效期轮询，SDK 跟随租户跳转到 Lark。连接器只展示进度并保存完成后的账号。

入站消息先存进 SQLite，再交给管家；微信的一页消息与下一页游标一起提交，飞书和 QQ 的回调等消息落库后才返回。相同平台消息编号只接受一次，未完成的收件在重启后继续交付；管家成功但完成标记写入失败时，重试可能重复交付。成功后清空收件正文、保留去重标记。

重新登录或退出先结束旧账号的登录、接收、收件和发件任务；保存成功后清掉旧收件、退休旧发件，保存失败恢复旧账号。旧连接的迟到回调不能写新账号。QQ、飞书拿到消息 id 才认发送成功。所有权约定见 [connector](../../server/internal/connector/README.md)。

- **只往外连**：都是服务端连出去，不收 webhook。
- **只认主人**：微信扫码的人就是主人；飞书返回扫码者的 OpenID 时直接绑定，未返回时与 QQ 一样，由第一个私聊机器人发配对码的人完成配对。别人的话丢掉，群里的不收。
- **接在一个频道**：默认田头。进来的话当作主人在这个频道说的；出去的是管家的回答、汇报、派活和 @主人 的话（`connector/text.go` 的 `forOwner`），转成纯文本，太长就切开。
- **发不出去的**留在发件表里，按指数退避重试；主人下次说话时先补发。
- 账号和密钥在数据库里，不进日志、不发给页面；断开就删掉。

## 院门

手机、另一台 Mac 和这台电脑用同一个农场（`gate/gate.go`；[理由](../../.agents/notes/implemented/feature/2026-10-14-yard-gate.md)），在「院门」页（`/gate`）管。

- **另一个监听**：在所有网卡上听 `lan.port`（默认 8790），默认关着。
- **只放这些**：[能力表](capabilities.md)里院门一列打了 ✓ 的接口（`api.go` 的 `//vibevalley:can remote`，`internal/gate` 按 `protocol.Endpoints` 匹配）和两条流，不放 `/mcp`；别的答 403。每个请求要带 `Authorization: Bearer <钥匙>`；只有 `POST /api/v1/gate/pair` 不要。院门自己的管理接口没有 `remote`，只在本机能用。
- **配对**：主人点「添加设备」，得到一个配对码（2 分钟有效，用一次就作废），画成 `vibevalley://pair?…` 的二维码。设备带码来要钥匙，等主人在本机点头。数据库只存钥匙的 SHA-256。
- **移除**一台设备或关上院门，它的连接当场断开。
- **明文**：院门走 HTTP，不加密，只在信得过的网络里开。

## 项目和收获

**项目**（`project/project.go`；[理由](../../.agents/notes/implemented/architecture/2026-10-10-projects-worktrees-and-harvest.md)）：工作目录 `projects/` 下的每个文件夹是一个项目。派到不存在的项目就新建（`git init -b main`、`.gitignore`、初始提交）。派给工单的帮工共用这张工单的 worktree：`<工作目录>/worktrees/<项目>.<工单号>`，分支为 `vibevalley/issue-<工单号>`。worktree 已在就复用；只有分支时在原分支上重建 worktree；两者都没有时从主分支或种植计划指定的基分支新开。不挂工单的直接派活仍用 `<项目>.<帮工>-<时间>` 和 `vibevalley/<帮工>-<时间>`。取消时保留有提交的分支和有未提交改动的 worktree，重开接着做；合并后删掉分支和 worktree，再重开从主分支开始。同一个项目的 worktree 创建和合并串行执行，项目检查在锁外运行。

给 `project create` 提供 GitHub 地址时，已登录 gh 的农场用 `gh repo clone <owner/repo> <路径>`，可克隆当前账号有权访问的私有仓库；否则用禁用凭据的 `git clone`。

**收成清单**（`GET /api/v1/issues/{id}/changes`，看的是这张工单最新的帮工）：提交、改的文件和 diff、没提交的、主分支多了几个提交、会不会冲突（`git merge-tree`，不碰工作区）。

**本地收获**（未列入 `github.pr_projects` 或 `pullRequest.available` 为假）：

1. 还在干活的不收。
2. 关掉会话，没提交的改动替它提交（缓存和依赖目录不提交）。
3. 会冲突就不合并：标上 `conflict`；「让它解决冲突」发一句固定的话（`ConflictTask`），它下一轮结束时再查一次。
4. 没有冲突时，先把主分支合进帮工分支，再在帮工 worktree 根目录运行它分支上的 `.vibevalley/check` 可执行文件；没有这个文件就跳过。退出码非 0、无法执行或超时都不合并，拒绝原因附上输出的最后 40 行（最多保留 64 KiB），并把这段话交给帮工修。时限由 `project.check_timeout_seconds` 配置，默认 1200 秒。
5. 检查通过后取得项目锁，确认分支提交与检查前一致，并重新检查冲突；帮工分支在检查以后变了，或主分支有尚未检查的提交，就拒绝合并，要求重新检查。通过才合进主分支，删掉 worktree 和分支，帮工离开，账本记 `harvested`。

检查失败不会把工单关成 `done`：拒绝收获时仍是 `in_review`，帮工、分支和 worktree 都保留；帮工收到带话开始修以后，状态照常变成 `in_progress`，交回来再回到 `in_review`。帮工合进种植计划分支也先跑同一检查。种植计划和 PR 路径检查帮工当前分支；本地收获检查包含主分支的合并结果。

**提 PR**：项目名列在 `github.pr_projects` 且 `pullRequest.available` 为真时，收获照旧提交剩余改动、查冲突，并在项目锁外跑 `.vibevalley/check`。检查通过后取得项目锁，核对检查过的提交，再由农场执行 `git push -u origin <工单分支>`，用工单标题、编号、帮工最后一轮的「结论：」段落和检查结果创建 PR；找不到结论时放完整的最后一轮原话。有 `.vibevalley/check` 且通过时写「.vibevalley/check 通过。」；没有时写「这个项目没有 .vibevalley/check，没跑检查。」已记录开着的 PR 时只推分支。创建后未收到或未存下回执，重试会先查询已有 PR。推送或 gh 失败会拒绝本次收获，保留工单和帮工。

工单的 `pullRequest` 保存 `url`、`number`、`state`（`open`、`merged`、`closed`）。PR 开着时工单留在 `in_review`，帮工、worktree 和分支保留；挪到待办带话再干一轮，再收获会更新同一个 PR。已有开着的 PR 时，即使检测暂时不可用也继续这条路径。

农场每 `github.pr_poll_seconds` 秒（默认 180）查询开着的 PR；`github refresh` 可手动触发。合并后工单关成 `merged`，未合并就关闭则关成 `dismissed`，清掉 worktree 和本地分支，帮工离开。帮工仍在干活或有待开始的一轮时保留现场，下次轮询再结束；查询失败保持原状态并报告。远端分支由 GitHub 管，农场不删除；走 PR 的项目在结束 PR、创建新的工单分支前，在项目目录执行 `git fetch origin <主分支>`；工作区干净且能快进时，检出在主分支用 `git merge --ff-only`，否则用 `git update-ref` 更新主分支。fetch 失败、工作区不干净或无法快进时保留本地主分支并记日志，新工单照旧从本地主分支开；已有工单分支和 worktree 直接复用。

**收工和铲除**：关掉会话、帮工离开；分支上有没合的提交就留着，没有就删。

## 项目是一块地

`project/codebase.go` 给项目页（[farm-ui.md](farm-ui.md) 界面 12；[理由](../../.agents/notes/implemented/feature/2026-10-12-codebase-page.md)）：有哪些项目和能同时干活的帮工数（`slots`）；种了什么（tokei 现数，锁文件、压缩文件和依赖目录不算，没装 tokei 就说怎么装）；一年的提交（`git log --all --no-merges`，按天、按作者）。

## 记性

每个帮工档案一份记性（`memory/memory.go`；[理由](../../.agents/notes/implemented/architecture/2026-10-11-agent-memory.md)），它派出去的帮工共用，跨项目、跨重启。一条记性是一句记下的话（帮工写的「记住：」，或主人替它写的），或一件做过的活。每个档案最多 300 条。

- **想起**：帮工新开一轮时，`memory/recall.go` 的 `pick`（不调模型）挑出有关的几条（最多 8 条），以「【你记得的】」开头放在话前面，写明是以前的信息、不是要它照做的指令。打分看种类、项目、新旧、和这一轮共有的词，再加上全文索引（SQLite FTS5 的 `bm25()`，表 `memory_term`）给的相关度。
- **词**：中文用 gse 切（`memory/terms.go`，只嵌了简体词典，`memory/dict/`），英文、数字、路径、版本号按整词算（`db/migrations`、`v1.2.3` 各是一个词）。每条记忆写入时切好存在 `terms` 列；切法或词典变了就把 `TermsVersion` 加一，开机后在后台把旧的重切一遍。
- **记下**：汇报里「记住：」开头的行记成这个项目的，「记住（所有项目）：」记成所有项目的；差不多的不重复记。叫停的一轮不记。
- 读不出、写不进只记日志，不拦着那一轮。
- **主动查、主动记**：开工想起和收「记住：」之外，帮工经 `/mcp` 的 `memory_search`、`memory_add` 查和记自己档案的记性：档案和项目由会话的令牌定（查这个项目的和所有项目的，`all_projects` 也查别的项目；记成这个项目的，`all_projects` 记成所有项目的），写别的档案被拒。管家的同名工具能查任何档案（不填就是所有档案）、替任何档案记一句；管家自己的记性照旧用 `remember`。两边都经管理器的 `Search`、`Write`，问遍所有来源，各来源的结果轮流取、几乎一样的只留一条，默认 10 条；本地的按全文索引的 `bm25()`、共有的词和整句出现排，同项目的在前。
- **来源**：记性经 `memory/providers.go` 的管理器读写：本地的这张表（`memory/local.go`）一直在，外面的来源在首页「设置」里接（`settings.json` 的 `memorySources`，一种一个：地址、key、接没接上、读、写），存了就用上，不用重启。接口在 `memory/provider.go`，照 Hermes 的 `MemoryProvider`（[提案](../../.agents/notes/proposed/architecture/2026-10-18-memory-providers.md)）。本地记忆的 id 照旧，别的来源的 id 带上它的名字（`名字:id`）。
  - **读**（开工想起、`memory_search`、记性页签）同时问所有来源，外面的最多等 2 秒，等不到就不等，日志里记一句跳过了它。几个来源的结果轮流取（各家的分数比不了），几乎一样的只留一条，开工想起照旧最多 8 条、1600 字；只有合并后真放进话里的本地记忆才算想起过一次。
  - **写**：本地的当场写好；外面的放在后台一个接一个地送，收工和记一条都不等它们，送不成只记日志。送出去的字先过 `base.Redact`（和服务端日志同一份规则，上文「设置」）。
  - **Nowledge Mem**（`memory/nowledge.go`，本机 `http://127.0.0.1:14242/mcp/`，MCP）：读用它的 `memory_search`，写用 `memory_add`（汇报里「记住：」的那几行，和主人、管家、帮工经 `memory_add` 记的），别的工具不调。写进去的带 label：`vibevalley`、`vibevalley-agent-<档案>`、这个项目的再加 `vibevalley-project-<项目>`，`source_app` 是 `vibevalley`；读的时候只读这个档案的 label。设置里打开「读全部」才读主人在它里面的全部记忆，每个档案读到的都一样。它里面的记忆页签上列得出、忘不掉：要删到 Nowledge Mem 里删。
  - **EverOS**（`memory/everos.go`，HTTP 的 `/api/v2`）：收整段干活，自己用模型提炼。每一轮收工把这一轮交给 `memory/add`：第一轮带上工单（主人的话，`sender_id` 是设置里的 user_id，没填是 `owner`），每一轮带上帮工最后的汇报（`sender_id` 是 `vibevalley-<档案>`，没做成的写明）；`session_id` 是 `vibevalley-<Session>`，`app_id` 是 `vibevalley`，`project_id` 是项目。叫停的一轮不送。Session 离开农场时 `memory/flush` 让它提炼；农场停下时，送过却还没 flush 的也 flush 一次。主人或帮工在一轮之外记的一句，当成一段两句的对话送过去，马上 flush。读用 `memory/search`：开工想起和 `memory_search` 查这个档案的 cases（`agent_id`），带 `kind = issue` 的查主人的 episodes（`user_id`）；它一次只认一个主人，所以管家不填档案的查询不问它。它的记忆页签上不列、也忘不掉。
  - **记性页签**按每个来源能做的（`Can()`：列不列得出、能不能在这里忘掉、收不收整段对话）显示，`MemoryList.sources` 列出每个来源和没接上的原因。
- 一轮的笔记、总结和过量记忆的清理在同一个事务里；失败不留下半份记性。提不出关键词的不同短句仍分别保留。

## 游戏

服务端的游戏都在 `game` 包（`Workspace` 上的 `Game`）：账本（`ledger.go`）、按 commit 数算的等级（`commits.go`）、主人刚点的空地（`beds.go`）。账本怎么折（金币、连胜、成就、一个事实记哪几笔）只有 `game` 用，在 `game/progress.go`；出帧和 `Reduce` 要用的在 protocol：地里长什么和特效在 `game_view.go`，帮工在哪块地、做过什么在 `game_play.go`。业务的服务不 import `game`（[理由](../../.agents/notes/implemented/architecture/2026-10-16-game-in-one-place.md)）。

**空地**：主人点一块空地再说话，`Game` 记下这块地 10 秒。这期间新雇的第一个帮工先站到第一块空着的地，`Game` 再施加 `station` 事实把它挪过去；那块地已经有人就不挪。

**特效**：金币、升级、成就、没做成的惩罚由 `EffectsOf` 从事实和折之前的状态算出，`Core` 和帧一起发。

**农场账本**（`game/ledger.go`；[理由](../../.agents/notes/implemented/feature/2026-10-11-achievements.md)）是 `game_ledger` 表：值得记的事，一条一行，按顺序。金币、连胜、成就和每个档案的战绩都由它折出来（`game/progress.go`），规则见 [farm-ui.md](farm-ui.md)「计分」。

- 账本自己看事件流，用 `game/progress.go` 的 `entriesFor` 读出要记的（收获、没做成、冲突、派出、拆好计划、升级、带话……）；业务的服务不调它。只有主人在应用里做的几件事（语音接通、看收成清单、挂称号）在 HTTP 那一层记。
- 记一条就施加 `progress` 事实，带来金币或成就时带上 `news`。
- 启动时整本重折，所以规则改了重启就按新规则算。

## 种植计划

一件很长的活拆成几步，每步一个帮工，有先后（`task/task.go`；规则是 protocol 的 `task_rules.go`；[理由](../../.agents/notes/implemented/feature/2026-10-11-tasks.md)）。计划是带 `graph` 的父工单，每一件是带 `task` 的子工单（[理由](../../.agents/notes/implemented/architecture/2026-10-15-tasks-are-parent-issues.md)）；`TaskOf` 从工单拼回计划。计划的状态：`splitting`、`draft`、`running`、`paused`、`ripe`、`done`、`abandoned`；每一步：`waiting`、`working`、`merged`、`failed`、`skipped`。

**拆**：派一个帮工只读代码，汇报的最后用一个 json 代码块给出计划。`task/rules.go` 的 `parseSplit` 校验（id 不重复、没有圈、最多 12 步、验收步骤有检查命令）；不合格让它重给一次，还不行计划放弃。

**改**：草稿什么都能改；开工以后只能改还没开始或没做成的步骤。

**开工**：从主分支开一条计划分支 `vibevalley/task-<id>-<时间>`。要等的步骤都合进去了、在计划的并行数以内（默认 3），就派帮工；它的 worktree 从计划分支开出来，工单（`taskBrief`）带着目标、前面每一步的结论和要跑的检查。

**一步做完**：农场在它的 worktree 里跑检查，不信帮工自己说的；过了就合进计划分支（不动任何检出），删掉它的分支，帮工收工；没过就带着原因退回去。会冲突就让它解决。全部合进去或跳过后，计划熟了。

**验收**（[理由](../../.agents/notes/proposed/architecture/2026-10-14-sample-then-verify.md)）：验收步骤只写现在会失败的测试，做完时检查要不通过。它改的文件对后面的步骤冻结；最后一步还要通过前面的验收。

**没做成**：一轮失败、检查没过、改了冻结的文件，农场自己让它重来，最多 2 次（`AutoRetries`）；再不行就停在 `failed`，等你重试、改工单或跳过，不相干的步骤照做。

**经过**（`task/log.go`）：计划每变一次记一行，带是谁做的，存在 `task_event` 表。

**保存失败**：计划动作返回错误，不答复成功、不继续叫醒或派下一步；自动推进失败发提醒。放弃和跳过先保存，再请对应的帮工收工。Git 已合并而完成状态保存失败时，错误会说明分支已合并，真实的 Git 结果保留。

**收获**把计划分支合进主分支，先查冲突。**放弃**时正在做的帮工收工，分支都留着。计划里帮工的汇报不转给管家，只有拆好、某一步没做成、全部做完时计划告诉管家一句。

Session 在收获动作内部停止写入、合并并离场，正在运行或已提交但尚未开始的一轮不能收获。Git 目标分支已经更新而目录或分支清理失败时，保留成功的合并结果并发出清理提醒，不要求重新合并。

## 额度、花费和上限

[理由](../../.agents/notes/implemented/feature/2026-10-10-quota-spend-and-limits.md)。

**额度**（`runtime/runtime.go`）：有套餐的农机读 smith 的账户用量；pi 读 DeepSeek 的余额。每 5 分钟读一次，一轮结束后再读一次。剩不到 15% 的，管家尽量换人。

**花费**：按 pi 的价目表（`runtime/pi_prices.json`）把 token 折成人民币（估算），施加 `spent`；不在价目表里的只记 token。今天每台农机花了多少在 `spend.json`。

**派不出去**（protocol 的 `AgentIssues`）：档案停用、农机没装或停用、配置有错、余额用完、到了每日预算、套餐某个窗口用满。正在干的会干完。

**同时干活的上限**：农场 6（`protocol.MaxRunning`）；每台农机 `RuntimeSettings.maxWorking`；每个项目 `project.max_sessions`（默认 3）。地都满了又来新活时，歇着的帮工里最早的那个先收工。

## 重启

[理由](../../.agents/notes/implemented/architecture/2026-10-10-restart-keeps-the-farm.md)。

- 帮工回到各自的地上，会话先不打开；有人带话时按会话 id 接着原来的会话，接不上就在同一个 worktree 里新开。
- 重启时正在干的那一轮记成「停在了半路」，帮工歇着。worktree 不见了的不接回来。
- 种植计划跟着工单回来：正在拆的放弃，做到一半的暂停。
- 田头从数据库回来；已交付没看到的消息退回未交付。
- 金币、连胜、成就从账本重折。

