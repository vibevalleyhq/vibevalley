# 服务端：管家和帮工

`server`：Go 模块 `vibevalley`，不用 cgo，只听 127.0.0.1:8787；局域网里的设备经「院门」进来（下面「院门」）。macOS 应用把它打进去、开机拉起（[desktop.md](desktop.md)）；开发时单独跑。目录、形状从哪来、和 TypeScript 版的差别见 [它的 README](../server/README.md)。

```bash
cd server
go run ./cmd/vibevalley                       # 服务端；--env-file 另读一个 .env，--log 把日志也追加到文件
go vet ./... && go test ./...             # 测试：smith 的 oartest 扮演帮工，用真的 git 仓库，不连网、不花钱
go run ./cmd/vibevalley import …              # 把 TypeScript 服务端留下的家搬过来（下面「搬家」）
```

**服务**：每个服务是一个结构体，构造函数的参数是它用到的服务；服务按概念分包（`server/internal/` 下的 base、projects、memory、runs、chat、tickets、manager、channels，最后是游戏 game；只 import 前面的包，往上发消息），`farm` 用 fx 把它们组装起来。一个服务在它用到的服务之后开、之前停；全都开了以后，再调有 `OnReady(ctx)` 的（开机就要发布的活）。分包、生命周期和怎么加一个服务见 [server/README.md](../server/README.md#服务)。服务之间的发布订阅用 `base.Hub[T]`（`base/hub.go`）：只送给当时在订阅的人，慢的排长队，不丢。拒绝是普通的 `error`，文字给主人看，`handler/api.go` 把它变成 `FarmRefused`。核心状态只经 `Site.Apply(…)` 改。纯规则在 Go 的 `protocol` 包（黄金数据守住，`go test ./internal/protocol -update` 重写）；只有服务端用的纯规则在拥有它的包里（`runs/facts.go`、`runs/rules.go`）。

| 文件（`server/internal/`） | 服务或内容 |
|---|---|
| `farm/farm.go` | `Farm`：带全部包的 `base.App`（`layers`） |
| `base/app.go`、`base/lifecycle.go` | `App`：把各包的服务用 fx 建起来、开、停；`Run`：服务的生命周期 |
| `base/config.go` | `DefaultConfig` 读 `VIBEVALLEY_HOME`、`VIBEVALLEY_WORK_ROOT`、`VIBEVALLEY_DB` |
| `<包>/module.go` | 每个包的 `Module`：它的服务交给 fx |
| `handler/api.go`、`handler/http.go` | `VibeValleyApi` 的实现（每个处理只转给拥有它的服务）；工地事件流、折好的状态流、`/mcp` |
| `base/site.go` | `Site`：核心状态，`Apply` 用 `protocol.Reduce` 改它、发事实，存 `farm.json`（[architecture.md](architecture.md)「核心状态」） |
| `base/db.go`、`server/migrations/` | 数据库（SQLite，`farm.db`，一个连接，所以 seq 的顺序就是提交的顺序）和迁移；时间存毫秒 |
| `base/files.go` | 存文件：每次写到自己的临时文件再改名，同一个文件的写一个接一个 |
| `base/store.go` | `Store`：帮工档案、技能书、农机设置（`config.json`） |
| `base/settings.go` | `Settings`：农场的钥匙和语音设置（`settings.json`，见「设置」） |
| `manager/foreman.go` | `Foreman`：管家 |
| `manager/tools.go` | 管家的工具；管家的工具调用怎么记成一步 |
| `chat/farmtools.go` | `FarmTools`：农场的工具（`farm_say`、`farm_read`、`farm_inbox`、`farm_who`），在 `/mcp` 上给帮工用 |
| `memory/memory.go` | `Memories`：每个 agent 的记性；`ManagerMemory`：管家的 `MEMORY.md` 和压掉的旧对话 |
| `chat/chat.go`、`chat/deliver.go`、`chat/db.go` | `Chat`：田头：写消息、算给谁、叫醒和提示帮工、管家听到什么、帮工的汇报贴进工单串、重启后补交；查询 |
| `runs/crew.go` | `Crew`：帮工的执行：开会话和关会话、照 `runs/facts.go` 的结果施加事实、带话和叫醒、同时干活的上限、没动静、重启后接回 |
| `tickets/dispatch.go` | `Dispatch`：派活：档案能不能派、在哪个项目、有没有空位、满了先请走最久没干活的，再让 `Crew` 开会话；开工、排队的有空地就开、重开工单；周期工单到点写一张开工 |
| `tickets/issues.go` | `Issues`：工单：写下、改、排先后、排队、记下每次执行、随最后一次执行关上；开机时把老的轨迹头收成工单 |
| `tickets/merges.go` | `Merges`：收成清单、收获（合进主分支）、合进计划分支；帮工一轮做完、身上有冲突时再查一次 |
| `runs/facts.go` | 一个会话事件对农场意味着什么：要施加的事实、干活过程的步骤、花了多少钱、要查价的模型（纯函数） |
| `runs/rules.go` | 读一轮的汇报（怎么结束的、结论、失败的原因、要不要你处理）、同时干活的上限、帮工的名字、帮工开工时被告知的（人设和技能、农场的规矩、工作目录的 AGENTS.md）（纯函数） |
| `runs/tokens.go` | `Tokens`：每个帮工会话的令牌，分清 `/mcp` 上是谁在说话 |
| `runs/steps.go`、`runs/trajectories.go` | 一条轨迹的干活过程：一步一步记、推给客户端、写进文件；`Trajectories`：每个帮工从派出去起一条、走了以后步骤留 30 天、头一直留着，管家一条 |
| `projects/projects.go` | `Projects`：项目、worktree、收成清单、收获、冲突检查 |
| `projects/codebase.go` | `Codebase`：把项目当代码库看：有哪些项目、种了什么（tokei）、一年的提交（git） |
| `runs/runtimes.go` | `Runtimes`：农机：探测、模型、额度、价格（`runs/pi_prices.json`）、今天的花费 |
| `game/commits.go` | `Commits`：数你的 commit（农场经验） |
| `tickets/playbooks.go`、`tickets/playbook_log.go` | `Playbooks`：种植计划：派人拆、按先后派帮工、做完合进计划分支、收获整个计划；`PlaybookLog`：计划的经过 |
| `game/ledger.go` | `Ledger`：农场账本：记下值得记的事，折成金币、连胜和成就 |
| `tickets/schedules.go` | `Schedules`：定时；`Heartbeat`：巡查（看一遍 Inbox） |
| `channels/voice_agora.go` | `Voice`：语音令牌和语音管家：农场的语音设置拼成声网的 agent（[voice.md](voice.md)） |
| `server/pkg/agora/` | 声网本身：签令牌、拼 agent（听法、字幕走 RTM 还是 data stream、会说话的大模型）、进出频道；不认识农场 |
| `channels/voice_line.go` | `VoiceLine`：语音线路：只对声网开的 OpenAI 兼容接口，每通电话一把钥匙，cloudflared 隧道；管家本人接电话 |
| `channels/connectors.go`、`channels/weixin.go`、`channels/feishu.go`、`channels/qq.go` | `Connectors`：微信、飞书、QQ（见「连接器」）：桥和三家的适配器 |
| `server/pkg/weixin/`、`server/pkg/feishu/`、`server/pkg/qq/` | 三家自己的接口：登录、收、发、从消息里读出字；不认识农场 |
| `base/env.go` | 读 `.env` 文件：已经设了的变量优先 |
| `farm/import.go` | 把 TypeScript 服务端留下的家搬过来（见「搬家」） |

## 管家

管家是 VibeValley 自己的 agent（`server/pkg/agent`，建在 `agentcore`、`ai` 上；`foreman.go`；[理由](../.agents/notes/implemented/architecture/2026-10-12-own-agent-on-effect.md)），带管家的提示词和工具；第一句话到了才起来。`VIBEVALLEY_FOREMAN_RUNTIME=pi` 会被拒绝：管家在田头上说它不能在 pi 上跑。

- **模型**：只接 DeepSeek：`VIBEVALLEY_FOREMAN_MODEL`（`deepseek-flash` 或 `deepseek/deepseek-flash` 都行），默认 `deepseek-flash`（DeepSeek V4.1 Flash）。密钥先看首页「设置」里存的（`$VIBEVALLEY_HOME/settings.json`），再看 `DEEPSEEK_API_KEY`，再用本机 pi 配好的 DeepSeek（`~/.pi/agent/models.json`；写成 `$DEEPSEEK_API_KEY` 这样的，读那个环境变量）；都没有，管家在田头上说它起不来，下一句话再试。每次请求前都重新取一次，设置里换了钥匙不用重启。
- **只带 VibeValley 的东西**：自己的提示词和工具，没有读写文件、跑命令、派帮手的工具，不加载技能。管家自己不写代码。
- **记得对话**：存在 `$VIBEVALLEY_HOME/foreman/manager.jsonl`（一行一条消息，说完一条存一条），对话太长时把早先的压成摘要（也是一行），原文归档在 `foreman/archive/`；启动时接着上次。
- **记性**：主人让它记住的事，它用 `remember` 记在 `foreman/MEMORY.md`，以后每一句都带着。管家页能看、替它记、让它忘，也能翻压掉的旧对话（`memory/memory.go` 的 `ManagerMemory`；[agents-and-runtimes.md](agents-and-runtimes.md)「管家页」）。定时是农场的（「定时」）。
- **农场现状**：工作目录下有哪些项目；能派的帮工档案（适合干什么、农机还剩多少额度、今天花了多少、派不出去的原因）；地里的帮工（在哪个项目哪个分支、工单、阶段的描述 `PhaseText`、上一轮的结论、花了多少）；没收完的种植计划。管家不用先查也知道现场。它在每次请求的系统提示里，只给模型看、不存进对话。
- **说话**：中文，口语，一两句；只说工具结果和汇报里有的东西，不编造。它的话是田头上的消息，字流式长出来；在串里被问到，就回在那个串里。语音管家转来的话（`/api/dispatch`）它只派活，不出声回话，回话由语音管家来。
- **听到什么**：主人在频道里没 @ 别人的话、任何 @管家 的话、帮工没做成的汇报、种植计划的提醒、到点的定时任务（「定时」）、巡查的发现（「巡查」），都会给它开一轮。它正忙时，人说的话插进这一轮（steer），汇报、提醒、定时和巡查等这一轮做完再处理（followUp）。别的帮工汇报不叫醒它，下次开口时一起交给它（记成一条 `farmNews` 消息，存进对话），它不用逐条转述（「田头」）。

工具（`manager/tools.go`，在服务端进程里执行）：种植计划的工具（`plan`、`playbooks`、`plan_edit`、`plan_action`、`node_action`）见「种植计划」；另有记性的 `remember`、`rewrite_memory`、`search_archive`。

| 工具 | 做什么 |
|---|---|
| `dispatch` | 派一个帮工：工单（目标、做到什么程度算完）、项目（不存在就新建；不填用频道的默认项目）、在哪个频道（不填是正在回话的频道）、帮工档案或农机（不填就按规则挑，见 [agents-and-runtimes.md](agents-and-runtimes.md)「派给谁」） |
| `projects` | 列出工作目录下的项目，是不是 git 仓库 |
| `changes` | 收获会合进什么：提交、改了的文件、没提交的、会不会冲突。主人问「改了什么」时用 |
| `harvest` | 收获：合进项目主分支，帮工收工。会冲突就不合并，结果里带一段让帮工去解决冲突的话 |
| `roster` | 地里的全部帮工 |
| `check` | 一个帮工的详细情况和上一轮的完整汇报 |
| `tell` | 给帮工带话：以管家的名义说在它的工单串里，叫醒它 |
| `read_chat` | 读一个频道（不填是正在回话的）或一个串最近说的话 |
| `channels` | 列出频道：说明、默认项目、在里面干活的帮工 |
| `open_channel` | 开一个频道 |
| `channel_settings` | 改一个频道的说明、默认项目 |
| `schedule` | 定一个定时：名字、到点说什么、什么时候（一次、每隔几分钟、每天、每周几，带时区）、在哪个频道；填了帮工档案就是周期工单，到点写一张工单派它 |
| `list_schedules` | 列出定时：编号、频道、什么时候、下次什么时候 |
| `cancel_schedule` | 删掉一个定时 |
| `stop` | 叫停这一轮 |
| `dismiss` | 请它收工（分支有提交就留着） |

**帮工汇报**：一个帮工这一轮结束，它的结论以它自己的名义贴进它的工单串，主人直接看得到，管家不转述。没做成的汇报叫醒管家，它说卡在哪、问下一步；做完的只附在它下次开口的「农场现状」后面。叫停的不贴。

## 定时

「每天早上九点在 #clock-in 跑一遍测试」这类（`tickets/schedules.go` 的 `Schedules`；规则是 protocol 的 `schedules.go`；[理由](../.agents/notes/implemented/feature/2026-10-11-channels-and-schedules.md)）：

- **谁来定**：主人跟管家说，管家用 `schedule` 定；页面上不新建，只在频道菜单的「定时」里看、开关、删（`PUT`、`DELETE /api/schedules/:id`）。`POST /api/schedules` 也能建。
- **什么时候**：一次（某个时刻）、每隔几分钟（至少 1 分钟）、每天几点、每周几几点；每天和每周按它的时区（默认这台电脑的）算。不用 cron，人和管家都不容易写错。下次什么时候不存，每次从上次跑的时间（没跑过就是建的时间）算。
- **到点**：服务端每 20 秒（`VIBEVALLEY_SCHEDULE_TICK_MS`）看一遍。到点的先在它的频道里说一条农场的提示「⏰ 定时「每日测试」到点了：……」，谁也不叫；然后没写帮工的交给管家（`【定时任务「…」到点了】`，等它闲下来，回答说在那个频道），写了帮工档案的是周期工单，不经过管家：`Dispatch` 每次写一张新工单（标题是定时的名字，说明是那句话，项目是定时写的或频道的默认项目，派给写的档案，记着它来自哪条定时 `schedule`）然后开工，地满了就排队；开不了的留在待办里，在频道里说一声。一次性的跑过就关上。
- **错过的**：服务端没开着时到点的，开机后只补一次，提示里写明是补的；循环的从现在往后排，中间错过的几次不一个个补。关掉再打开的也从打开时算。
- **存在哪**：数据库的 `schedules` 表（`migrations/`）；核心状态里有一份（`schedule`、`unschedule` 事实），页面从那里读，`farm.json` 不存。

## Inbox

要主人处理的事（protocol 的 `inbox.go`；[理由](../.agents/notes/implemented/architecture/2026-10-15-inbox.md)），从核心状态现算，不存；每一帧放在 `SiteFrame.inbox` 里，新的在前。农场手机把它当来电，桌面版的通知和菜单栏也读它。

| 种类（`kind`） | 什么时候算 | id |
|---|---|---|
| `harvest` | 帮工这一轮做完了，等你看 | `<帮工>:harvest:<轮>` |
| `fix` | 帮工这一轮没做成 | `<帮工>:fix:<轮>` |
| `conflict` | 帮工的活合进主分支会冲突 | `<帮工>:conflict:<轮>` |
| `quiet` | 干着活的帮工好久没动静（`quietSince`），计划里的帮工也算 | `<帮工>:quiet:<从什么时候>` |
| `plan-draft`、`plan-ripe` | 种植计划拆好了等你看、都做完了等你收 | `<计划>:draft`、`<计划>:ripe` |
| `plan-failed` | 开着的计划里有一步没做成；重试后又没做成算新的 | `<计划>:failed:<步骤>[:<第几次>]` |
| `mention` | 帮工或管家 @主人 的话，你没读、在那个对话里也没回 | `m<消息号>` |

计划里的帮工做完、没做成、冲突，由计划报（`plan-*`），不单独算。一个帮工一次只算最要紧的一件。

## 巡查

管家平时只在有人叫、有汇报、有定时时才醒。巡查（`tickets/schedules.go` 的 `Heartbeat`；规则是 protocol 的 `patrol.go`）每 `VIBEVALLEY_HEARTBEAT_MINUTES` 分钟（默认 10，0 是关掉；开机后先等一个间隔）不调模型看一遍 Inbox，找放着没人管的：

| 种类 | 放多久才算 |
|---|---|
| `mention` | 15 分钟 |
| `quiet` | 20 分钟 |
| `harvest`、`conflict` | 2 小时 |
| `plan-failed` | 巡查第一次看到后 30 分钟 |

别的种类巡查不报：没做成的一轮当时就告诉管家了，计划拆好、做完是主人自己要看的。

有的才按频道各叫醒管家一次（`【巡查】#频道 里有几件事放着没人管：……`，等它闲下来），它看着办：值得就在那个频道提醒主人一两句，不值得就不说话。同一件事报过一次，4 小时内不再报；处理掉了就忘掉，以后再出现算新的。巡查本身不花钱，叫醒管家是一轮。

## 设置

首页的「设置」（`base/settings.go` 的 `Settings`；[理由](../.agents/notes/implemented/feature/2026-10-12-title-screen-and-settings.md)）存三样钥匙：DeepSeek 的 API Key（管家，和用 VibeValley 自己的 agent 的帮工），Agora 的 App ID 和 App Certificate（语音）；还有声音页（`/voice`）和管家页（`/manager/voice`）存的语音设置（只存和默认不一样的）和语音服务自己的 key（`asrKey`、`llmKey`、`ttsKey`，只从设置里来，页面只看到最后四个字）（[voice.md](voice.md)「配置」）。

- **存在哪**：`$VIBEVALLEY_HOME/settings.json`（macOS 应用的正式版、Alpha、Beta 各在自己的家目录，[desktop.md](desktop.md)），只有你能读（0600）。`GET /api/settings`、`PUT /api/settings`：给值就存，给空字符串就从文件里删掉，不给就不动；`voice` 给了就整个替换（`{}` 回到默认）；明显不对的（Agora 的不是 32 位十六进制，DeepSeek 的带空格）不存。
- **谁优先**：设置里的 > 环境变量（含 `$VIBEVALLEY_HOME/.env`、`--env-file` 给的）> pi 的配置（只有 DeepSeek）。管家、帮工、语音每次用时现取，存了马上生效。
- **页面看到什么**：每样从哪来、最后四个字（`…778c`）；App ID 不算秘密，整个给。钥匙本身不出服务端、不进日志。

## 帮工

每个帮工是 smith（`server/pkg/smith`，oar 的 Go 移植）`agents.New` 的一个子 agent：并发上限 6（`protocol.MaxRunning`，对应 6 块地），深度上限 1（帮工不能再派帮工）。不要权限确认，靠工作目录、worktree 和只听本机圈住（[理由](../.agents/notes/implemented/architecture/2026-10-10-helpers-as-oar-subagents.md)）。

**开会话**：帮工档案决定农机、模型、思考强度、环境变量和工作目录；人设、技能、MCP 服务器、禁用的工具通过一个只给这次派活用的 runtime 包装传进会话（smith 的 spawn 只收模型、思考强度、环境变量和目录）。档案配的模型不在农机的模型列表里时，用农机默认的模型，并提醒一句。人设怎么交给农机见 [agents-and-runtimes.md](agents-and-runtimes.md)「人设」。

**农场的规矩**：每次派活，帮工的说明里都附上：

- 在哪个项目的哪个分支、worktree 在哪；只改这个目录，不切分支，不 push。
- 做完一轮就 `git add`、`git commit`，提交信息一句中文。
- 汇报写上 commit 号和怎么验证的（跑了什么、结果如何）；最后一段以「结论：」开头，一两句话说清做成了什么，或卡在哪、需要主人定什么。
- 它有记性：每一轮开头「【你记得的】」那段是以前记下的，和眼前的代码、主人这次说的对不上时以眼前的为准；学到下次还用得上的，在结论前写「记住：」开头的几行（见下「记性」）。
- 工作目录的 `AGENTS.md`：所有项目的约定（现在规定新代码用 TypeScript + Effect v4）。这样不管哪个农机都拿得到，不靠各家自己去找。

**会话事件变成事实**（`runs/facts.go`）：

| smith 事件（名字照 oar） | 事实 |
|---|---|
| `turn_started` | `turn` |
| `reasoning` | `doing thinking` |
| `tool_call_started` | `doing`：`action` 用 smith 的 `observe.ClassifyTool` 分类，`label` 取命令、路径或描述；开头的 `cd <worktree> &&` 和 worktree 前缀去掉，只留它真正在做的 |
| `tool_call_input`（完整参数后到） | `doing`，换成更准的 `label` |
| `tool_call_ended` | `doing thinking`，直到下一个调用 |
| `text_delta` | `doing speaking_text` |
| `retry` | `retry` |
| `usage` | `spent`（见「花费」） |
| 一轮结束（`turn_ended`，smith 的 report） | `report` |
| `exited`（一轮进行中） | `report failed` |

没变化的 `doing` 不发。

**干活过程**（`runs/steps.go`）：每一步（接到的工单和带话、想起了什么、说的话、每次工具调用的输入和输出、重试、问题）记在 `$VIBEVALLEY_HOME/steps/<id>.json`，留最近 240 步。地块详情打开时 `GET /api/workers/:id/steps` 拿全部，之后靠 `step` 工地事件更新；还在长的一步（字还在出、工具还没返回）用同一个 `n` 再发一次。工具输出保留开头和结尾（测试的结论在最后）。

**评论一步**：带话时给 `on`（第几步），服务端把那一步是什么写在话的前面再交给帮工（`CommentText`：「【评论第 N 步】」、这一步的操作或说的话、工具的输入和输出的结尾，再是「我的评论：」和评论本身）。记这句话的那一步从标记里读出 `on`，客户端据此把评论挂在被评论的那一步下面。

**轨迹**（`runs/trajectories.go`；[理由](../.agents/notes/implemented/feature/2026-10-13-trajectories.md)）：干活过程连同它是谁的、为什么干，就是一条轨迹。
- **每个帮工一条**，派出去时就开始（`steps/<id>.head.json` 记名字、帮工档案、农机、项目、工单、什么时候接的活）。收工、收获、重启后接不回来时，标上什么时候走的，文件留着；走了超过 `VIBEVALLEY_TRAJECTORY_DAYS` 天（默认 30，0 是一直留着）的，服务端启动时删掉步骤文件；头文件很小，一直留着，所以看板上的工单不会消失，只是打开时没有干活过程了。工具的输入留 4000 字，输出留开头 2000 字和结尾 4000 字。
- **管家一条**（id `foreman`），不会结束，留最近 1000 步。每句交给它的话记成一步「收到」，它调的每个工具（`manager/tools.go`：标签加上参数里的帮工、项目这类名字，输入是参数，输出是工具返回的字）和它说的话各记一步。
- **思考**：农机交出来的思考（`reasoning` 事件，有字的）记成「想了想」一步，接着来的思考接在同一步里；管家把每条回答里的思考（没被遮掉的）记一步。
- **帮手**：帮工自己派出去的子 agent（Claude 的 Task、Codex 的子线程）的事件带着 smith 的 `agentPath`。它们的步骤记下 `under`：派它出去的那次工具调用的步号（那一步已经不在了就是 -1）。工具调用按「哪个 agent 的、哪一个」认，帮手和帮工的调用编号相同也不会串，帮手说的话也不会接进帮工的话里。VibeValley 自己的 agent 用 `spawn_agent` 派的帮手不把事件交出来，只留下那一次调用和交回来的结果。
- **轨迹头记着工单**：帮工离开时，头上记下这次执行怎么关的（`closed`：收获了 `harvested`、合进计划分支 `merged`、没收就收工 `dismissed`、目录丢了 `lost`）和它最后一轮（`outcome`、`summary`、`turns`、`cny`），还有它做的是哪张工单（`issue`）。
- **收获前补交**：帮工没提交的改动，收获或合进计划分支前替它提交（`crewCommitLeft`），但缓存和装好的包（`__pycache__`、`*.pyc`、`.pytest_cache`、`node_modules`、`.DS_Store`）不管项目的 `.gitignore` 写没写都不提交；新建项目的 `.gitignore` 也带上这些。
- `GET /api/trajectories`（`?agent=` 只看一个帮工档案派出去的）列出谁有轨迹，新的在前；`GET /api/trajectories/:id` 拿一条的全部步骤，帮工走了也拿得到。还在进行的轨迹照样用 `step` 工地事件推新的步骤。

**工单**（`issues.go`、`dispatch.go`；[理由](../.agents/notes/implemented/architecture/2026-10-15-issue-is-one-thing.md)）：一件活从写下到关上是一张工单，id 不变（新的是 `t` 加 8 位，老的沿用它第一次执行的帮工 id）。
- **存在哪**：数据库的 `issue` 表（标题、说明、项目、帮工档案、优先级、排的先后 `rank`、什么时候写的、什么时候排上队、什么时候怎么关的、父工单、等哪些子工单、计划或步骤）和 `issue_run` 表（每次执行：帮工 id、什么时候开的）。开着的和最近关上的 50 张（`protocol.KeepClosedIssues`）在核心状态的 `issues` 里，按看板的顺序：每改一次就施加一条 `issue` 事实（删掉是 `issueGone`），开机时从数据库放回去，`farm.json` 不存。状态在折叠时跟着帮工重算。更早关上的问 `GET /api/issues`。
- **子工单和计划**：一张工单可以有父工单（`parent`），等同一个父工单下的别的子工单（`blockedBy`）。现在只有种植计划用它：父工单带 `plan`，子工单带 `step`（「种植计划」）。它们的状态跟着计划走：父工单在拆、在做是 `working`，等你看、暂停、做完等收获是 `waiting`，收了或放弃了关上；子工单没轮到是 `todo`，在做看它的帮工，没做成是 `waiting`，合进计划分支关成 `merged`，跳过或计划放弃了关成 `dismissed`。帮工离开不关它们，看板也不能改、开工、重开它们。核心状态只留最近关的 50 张时，只数没有父工单的，子工单跟着父工单留和走。
- **标题和说明**：标题是一行，说明可以空；交给帮工的是标题，空一行，再是说明。管家和计划直接派的活，第一行当标题，其余当说明。
- **状态**由服务端算（`protocol.IssueStatusOf`）：关了是 `closed`；派出去过的看最后一次执行的帮工：在干活是 `working`，其余是 `waiting`，帮工不在了算 `closed`；没派过的，排上队是 `queued`，否则是 `todo`。
- **还没派的**：按主人排的先后（新写的排最后，挪动时整列重新编号），能改、能删；派出去以后就不能了。
- **开工**（`POST /api/issues/:id/start`）就像管家派活一样派出这个档案的帮工、发在田头，执行记在这张工单下。管家和计划派的活也各开一张工单。开工时这台农机、这个项目或整个农场的地都占满了（`Crew.NoRoom`），就记下排队的时间，回答里说为什么等；服务端每 5 秒按排的先后试一遍排队的，有空地就开工、在田头说一声，开不了的（档案没了、被拒）退出队列并提醒。`PUT /api/issues/:id/queue` 手动排上或拿出来。
- **关上**：帮工离开的事实（`FactLeft`）带着怎么关的；离开的是工单最后一次执行，工单就跟着关上。
- **重开**（`POST /api/issues/:id/reopen`）：同一张工单再开一次执行：同一个帮工档案派一个新帮工到同一个项目（发在田头），交给它的第一行是这次要做的，后面是这张工单原来要做什么、上一次怎么关的、最后一轮说了什么。能重开几次都行；合进了计划分支的跟着计划走，不能单独重开。
- **老的农场**：开机时把还没记在工单下的轨迹头收成工单（`adopt`）：头上记着工单的进那张，从前重开出来的（`reopenedFrom`）进原来那张，其余各自一张、id 用帮工 id；关没关、怎么关的照头上的。跑几遍都一样。

**汇报的摘要**：取「结论：」那一段；没写就取最后几段。失败的一轮按 smith 的失败分类（`observe.FailureAdviceOf`）说人话（登录有问题、额度用完、被限流、余额不够、模型用不了、上下文太长、服务商出错、进程退出……），并说怎么办（再试一次、过一阵再试、要你先处理）；要你处理的（登录、余额、额度、模型）另外发一条醒目的提醒。

**没动静**：每隔一会儿看一次会话状态（smith 的 `observe.StallOf`），一轮里超过 `VIBEVALLEY_STALL_SECONDS`（默认 240 秒）没有任何记录，就施加 `quiet` 事实、在农场上提醒一次、记进干活过程；它一有动静就结束。可能只是在跑很久的命令，由主人决定要不要叫停。不用 oar 的 `observeStalls` 那种做法（[为什么](../.agents/notes/implemented/feature/2026-10-10-quiet-turns.md)）。

## 田头

田头是农场的群聊：主人、管家和地里的帮工在里面说话（`chat.go`；规则是 protocol 的 `chat.go`、`chat_rules.go`；[理由](../.agents/notes/implemented/feature/2026-10-11-farm-group-chat.md)）。

**对话**：频道，加上挂在频道消息下面的串。田头是默认的频道；主人可以再开频道（`#clock-in`），按项目、按事情分开说话，每个频道有名字、说明，可以带一个默认项目。派一个帮工时，管家在它被叫的那个频道里发一条派活消息，下面开它的工单串；帮工属于这个频道，跟着自己的串。消息的号（`seq`）全农场一个顺序，频道的地址是 `#<频道名>`，串的地址是 `#<频道名>:<消息号>`（`#田头:<消息号>` 照旧能用）。

**频道**（[理由](../.agents/notes/implemented/feature/2026-10-11-channels-and-schedules.md)）：名字是 1～24 个字、数字、`_` 或 `-`，不能重名。在田头窗口标题的频道菜单里切换、开新频道、改说明和默认项目（`POST /api/channels`、`PUT /api/channels/:id`），管家也有工具 `open_channel`、`channel_settings`。在一个频道里叫管家，它就回在这个频道、派活派在这个频道；没说项目时用频道的默认项目。

**@ 名**：帮工用 id（`@w3`），还有 `@管家`、`@主人`、`@所有人`（只有主人能用）。代码里（反引号、代码块）的不算。@ 了不在地里的人，消息照发，发的人会被告知没送到。

**给谁、叫不叫醒**（`AudienceOf`）：

| 谁说的 | 叫醒谁 | 只让谁知道（不叫醒） |
|---|---|---|
| 主人在频道里 | 被 @ 的；没 @ 别人时是管家 | 这个频道里的每个帮工 |
| 主人在串里 | 被 @ 的、这个工单串的帮工、跟着这个串的帮工 | — |
| 管家或帮工 | 被 @ 的；在一个帮工的工单串里说话，叫醒那个帮工 | — |
| 帮工的汇报 | 没做成时叫醒管家 | 做完时给管家 |
| 派活消息、农场的提示 | 谁也不叫 | — |

在一个串里说过话、或者在串里被 @ 过，就跟着那个串。

**刹车**：只管 agent 叫醒 agent，主人的话不受限。一个对话里从主人上次说话算起，agent 叫醒 agent 最多 4 次（`HopLimit`），到了串里贴一句提示；同一个帮工被 agent 叫醒，间隔至少 60 秒；一个帮工连着 3 次被叫醒都在开口前失败（比如登录失效），就不再自动叫醒它，它的工单串里贴一句提醒，直到主人亲自对它说话。被拦下的照样记着、照样显示，只是不叫醒。

**送达**：每条给帮工或管家的消息有一行投递记录，走 未交付 → 提示过 → 已交付 → 看到了（或不给了）：

- 歇着的帮工被叫醒：新一轮的输入里是给它的消息（最多 3 条全文，`WakeInput`），以及别处没读的摘要，写明只读不回、除非直接问到它。这些记为「已交付」。
- 这一轮真的开口了（模型出了第一个事件），已交付的才算「看到了」。没开口就结束或进程没了，退回未交付，过一会儿（`VIBEVALLEY_RETRY_WAKE_MS`）再叫；服务端重启时也全部退回。宁可重复给，不会丢。
- 忙着的帮工：攒一下（`VIBEVALLEY_NOTICE_BATCH_MS`，默认 3 秒），插进这一轮一句不带正文的提示（`BusyNotice`）：哪里有几条、有没有 @ 它；同一会话里同一条只提示一次。它在压缩上下文时先不插。
- 管家在服务端进程里，给它的话直接交给它，当即算看到了。

**帮工的工具**（`chat/farmtools.go`，官方 Go SDK 的 Streamable HTTP）：派帮工时，它的会话通过 smith 的 `mcpServers` 带上农场的 MCP 端点（`http://<HOST>:<PORT>/mcp`）和一个只属于这次会话的令牌（`runs/tokens.go`；收工、换会话就作废）。令牌只用来分清是谁在说话，不防人：帮工本来就在这台机器上、没有沙箱。

| 工具 | 做什么 |
|---|---|
| `farm_say` | 发一条消息。`target` 不填是自己的工单串；`#<频道名>`；`#<频道名>:<消息号>` |
| `farm_read` | 读一个对话；`unread` 只读没读过的，`before` 往前翻。读过的算它看过了 |
| `farm_inbox` | 哪些对话有它没读的：几条、有没有 @ 它、最后谁说的 |
| `farm_who` | 地里有谁：@ 名、名字、农机、项目、在做什么 |

`farm_say` 发出前先拦三种情况，都把原因和下一步写在回答里：目标里有它没看过的新消息（给它看最多 3 条，`anyway: true` 照发）；它刚读的是一个串，却要发到频道顶层（`confirm: true` 照发）；60 秒内在同一处说一模一样的话（当作重试，返回原来那条）。

帮工被告知的礼节在 `runs/rules.go` 的 `crewFarmRules`：收到点名先回一句、回在原来的串里、只说有内容的话、旧消息只读不回、交接时 @ 对方、停下前看看有没有欠别人的回复。

## 连接器：微信、飞书、QQ

主人可以在微信、飞书、QQ 里和农场说话（[理由](../.agents/notes/implemented/feature/2026-10-11-channels-and-schedules.md)）。在「连接器」页（`/connectors`）连上：

| | 怎么连 | 收消息 | 谁是主人 |
|---|---|---|---|
| 微信 | 手机微信扫码、确认（微信要求时输入手机上的数字） | 腾讯 iLink 接口长轮询（`server/pkg/weixin`，照官方 `@tencent-weixin/openclaw-weixin` 写） | 扫码的那个微信 |
| 飞书 | 手机飞书扫码：飞书替主人建一个个人机器人应用，交回 app id 和 secret（`accounts.feishu.cn` 的扫码建应用流程，nanobot 也用它） | 官方 Go SDK 的长连接（`server/pkg/feishu`） | 私聊机器人发配对码的人 |
| QQ | 填 QQ 开放平台（q.qq.com）上机器人的 AppID 和 AppSecret（QQ 没有扫码建机器人） | 官方 WebSocket 网关，只收单聊（`server/pkg/qq`，照官方 botpy 写） | 私聊机器人发配对码的人 |

三家共用一个桥（`channels/connectors.go`；哪些话发出去是 protocol 的 `connectors.go`），适配器只管登录、收、发：

- **只往外连**：长轮询、长连接、WebSocket 都是服务端连出去，照旧只听 127.0.0.1，不收 webhook。
- **只认主人**：帮工没有权限确认，所以每个连接器只听一个人。微信扫码时就知道是谁；飞书、QQ 连上后页面显示一个 6 位配对码，第一个私聊机器人发这个码（可以带「配对」两个字）的人成为主人，别人的话丢掉，日志里记一句。只收私聊，群里的不收。
- **接在哪个频道**：默认接在田头；连上后在连接器页的「接在」里选一个频道（`PUT /api/connectors/:id/channel`）。进来的话说在这个频道里，出去的只发这个频道和它下面的串里的话。
- **进来的话**：当作主人在它接的频道里说的（没开工就先开工），引用了一条农场发出去的消息，就说在那条消息所在的串里。文字照收，微信的语音用它转好的文字，图片、文件这类只记成「[图片]」这样的一个词。
- **出去的话**（`forOwner`）：管家的回答、汇报（做完了、没做成）、派活、帮工 @主人 的话；不发主人自己的话、农场的提示和帮工之间说的。前面写明谁说的、是什么（「【后端老周 · 做完了】」），Markdown 变成纯文本，太长按段落切开（微信 1800 字、QQ 2000、飞书 4000）。连着几个连接器时，每个主人都收到。
- **马上发，发不出去的先攒着**：每条都马上发；微信带上主人最近一句话的 `context_token`，QQ 跟着主人最近一句话回复（QQ 只给一段时间）。应用不收的（拒收、出错）留在发件表里：30 秒后再试，每失败一次等的时间翻一倍，最多半小时，发出去一条就从 30 秒重新算（`voiceRetryAfter`）；主人下次说话时也先补发，超过 3 条合成一条摘要，再回这一句。飞书没有回复窗口。
- **登录过期**：微信说令牌失效（-14），停一小时再试，和官方插件一样；也可以断开重新连。
- **存在哪**：账号（含机器人的密钥、接在哪个频道）、收过的消息、发件表都在数据库里（`migrations/`），每个连接器一份账号。密钥不进日志、不发给页面；页面只看到主人 id 的头尾几位。断开就删掉账号，没发的不再发。

## 院门

手机、另一台 Mac 和这台电脑用同一个农场（`internal/channels/lan.go`，[理由](../.agents/notes/implemented/feature/2026-10-14-yard-gate.md)）。在「院门」页（`/gate`）管。

- **另一个监听**：院门在所有网卡上听 `VIBEVALLEY_LAN_PORT`（默认 8790），和本机的 8787 分开。默认关着，主人打开或关上以后，重启照旧。端口被占时状态里说原因，农场照常。
- **只放这些**：`VibeValleyApi` 和 `/api/site/events`、`/api/site/state`，不放 `/mcp`（404）。每个请求都要带 `Authorization: Bearer <钥匙>`，不带或不认识的钥匙 401；只有 `POST /api/lan/pair` 不要钥匙。院门自己的接口（开关、配对、设备）经院门来一律 403，只在本机能用；`GET /api/lan/me` 例外，设备用它确认自己的钥匙还能用。
- **配对**：主人点「添加设备」，服务端给一个配对码（10 位，2 分钟有效，用一次就作废，错 5 次也作废），放在 `vibevalley://pair?u=<院门地址>&c=<码>` 里，页面画成二维码。地址是这台电脑首选网卡（`en*`、`eth*`、`wlan*` 优先）的私有 IPv4；找不到时状态里说原因，不能添加设备。设备带着码和自己的名字请求 `POST /api/lan/pair`，一直等到主人在本机点「让它进来」或「不让」，或者 2 分钟过去。同一时间只能有一台设备在等。同意以后设备拿到自己的钥匙；数据库（`lan_devices`）只存钥匙的 SHA-256。
- **设备**：设备列表里有名字、配对的时间、上次来的时间（最多每分钟写一次）。移除一台设备，它的钥匙马上失效，它正连着的请求（包括状态流）当场断开。关上院门，所有经院门的连接都断开，正在进行的配对也作废。
- **明文**：院门走 HTTP，不加密。同一个网络里的人能看到传的内容、抓到钥匙；页面上提示只在信得过的网络里开。

## 项目和收获

**项目**（`projects/projects.go`；[理由](../.agents/notes/implemented/architecture/2026-10-10-projects-worktrees-and-harvest.md)）：工作目录（`VIBEVALLEY_WORK_ROOT`，默认 `~/vibevalley-work`）下的每个文件夹是一个项目，名字只能是一个简单的英文文件夹名。派活必须指定项目；项目不存在就新建文件夹、`git init -b main`、写 `.gitignore`、做一次初始提交。每个帮工在 `<工作目录>/.worktrees/` 下有自己的 worktree，分支 `vibevalley/<帮工>-<时间>`。同一个项目里改仓库的操作（建项目、开 worktree、收获、清 worktree）排队一个一个来，两个帮工同时派到一个新项目也不会一起 `git init`。

**收成清单**（`GET /api/workers/:id/changes`）：它的提交、改了的文件（加减行数和 diff，每个文件最多 400 行）、没提交的改动、这期间主分支多了几个提交，以及会不会冲突。冲突用 `git merge-tree --write-tree` 算，不碰任何工作区。看清单的同时更新帮工的 `conflict`。

**收获**（农具「收获」、管家的 `harvest`、`POST /api/workers/:id/harvest`）：

1. 还在干活的不收。
2. 关掉它的会话（帮工留在状态里，带话时接着原来的会话）。
3. 没提交的改动替它提交。
4. 预检冲突。会冲突就不合并：施加 `conflict` 事实，帮工留在地里，地牌挂红色「冲突」；「让它解决冲突」发一句固定的话（`ConflictTask`）：在自己的分支上把主分支合进来、解决、跑测试、提交，结论里说怎么取舍。它下一轮结束时再检查一次，干净了就去掉标记。
5. 合进项目当前的主分支，删掉 worktree 和分支，帮工离开；离开的事实带着工单怎么关的和合进去几个提交，账本从它记下 `harvested`（见下「账本」）。

**收工和铲除**：关掉会话、帮工离开；worktree 没有改动就清掉；分支上有没合的提交就留着（提醒一句），没有就删掉。帮工做过的东西不会丢。

## 项目是一块地

`projects/codebase.go` 把项目当代码库看，给项目页（`/projects`，[game-ui.md](game-ui.md) 界面 12；[理由](../.agents/notes/implemented/feature/2026-10-12-codebase-page.md)）。名字只能是工作目录里有的文件夹，不会被当成路径，别的名字一律 404。

- **有哪些项目**（`GET /api/projects`）：工作目录下的每个文件夹、是不是 git 仓库、最近一次提交（所有分支）的时间，和同时能有几个帮工在里面干活（`slots`：项目的上限，没设或比农场的地多时是农场的 6 块地；地图页按它画空位）。
- **种了什么**（`GET /api/projects/:name/languages`）：问一次数一次，用 tokei（`tokei --output json`，它读 .gitignore），每种语言的文件数、代码、注释、空行。锁文件（pnpm-lock.yaml、package-lock.json、Cargo.lock、go.sum……）、压缩过的 js 和 css、source map、依赖和构建目录（node_modules、vendor、dist、build、target、.venv……）不算：它们不是这个项目写成的样子，一个锁文件就能比代码还长。嵌在别的文件里的代码（Markdown 里的代码块）跟着那个文件算，和 tokei 自己的汇总一样。没装 tokei 就拒绝，说怎么装（`brew install tokei`）；装在别处用 `VIBEVALLEY_TOKEI` 指过去。macOS 应用起服务端时带着登录 shell 的 PATH，所以 Homebrew 装的找得到。
- **一年的提交**（`GET /api/projects/:name/activity`）：`git log --all --no-merges` 过去 53 周的，按本机的日子数、按作者（`%aN`）数；还有提交总数、第一个提交和最近一个提交的时间。所有分支都算，所以帮工还没收的活也在里面；合并不算，收获那一下不多算一天。

## 记性

每个帮工档案（agent）有一份**记性**（`memory/memory.go` 的 `Memories`；[理由](../.agents/notes/implemented/architecture/2026-10-11-agent-memory.md)），从它派出去的帮工共用，跨项目、跨重启。一条记性是一句**记下的话**（`note`：帮工在汇报里写的，或主人在帮工页上替它写的），或一件**做过的活**（`job`：一个帮工的工单和它最后一轮的结论，每轮做完改写一次）。存在数据库的 `memories` 表，每个 agent 最多 300 条，多了先丢最久没用的。

- **一轮开始时想起**：帮工新开一轮（刚派出去、歇着被叫醒、做完一轮又被带话）时，`crew.go` 问记性要和这一轮有关的几条，放在它收到的话前面，用「【你记得的】」开头，和话之间隔一条分隔线。干着活被插话不算新的一轮，不想起。干活过程里这一步显示成「想起了」。
- **挑哪几条**（protocol 的 `recall.go` 的 `Pick`，不调模型；帮工页的「下回开工会想起」用的是同一套）：这个项目的记下的话、对所有项目都成立的话，别的项目的话只有和这一轮的话明显说的是一回事（共有三个以上的词）才算；做过的活只算这个项目的，最多三件。按「记下的话先于做过的活、这个项目先于所有项目、和这一轮的话共有的词、最近写过或用过」排，最多 8 条、1600 字。这个帮工自己留下的、这次会话里已经想起过的不再给。每给出一条记一次「想起过」。
- **一轮结束时记下**：汇报里「记住：」开头的行（最多 5 条，每条最多 300 字）记成这个项目的话，「记住（所有项目）：」记成所有项目的话；和已有的几乎一样（同一个项目、八成的词一样）就不再记。这个帮工的那件活改写成最新的样子。叫停的一轮什么也不记。
- **记不住不拦着**：读不出、写不进时只记日志，那一轮照常开始、照常结束。
- **换一种记法**：`crew.go` 只用 `Memories` 的 `Recall` 和 `Keep`。别的存法（向量检索、外面的记忆服务）换掉这两个方法背后的实现、在 `farm.go` 里建它就行；它拿到的是整轮（工单、结局、原话、结论），自己决定记什么。

## 账本

**农场账本**（`game/ledger.go`；[理由](../.agents/notes/implemented/feature/2026-10-11-achievements.md)）是数据库里的一张表（`ledger`）：值得记的事，按发生的顺序，一条一行。金币、连胜、成就都由它折出来（protocol 的 `progress.go`），放进核心状态的 `progress`，规则见 [game-ui.md](game-ui.md)「计分」。

- **启动时**：把整本折成进度，施加一个 `progress` 事实。commit 数早就到了某一级、账本里还没有，补记一条 `level`。
- **记一条**：写进表，再用 `step` 折进去，施加 `progress` 事实；这一条带来了金币或到了某一档，事实带上 `news`（客户端拿它飘金币、弹提示，macOS 应用弹通知）。一条接一条地记，表里的顺序就是折的顺序。记不下来只记日志，农场照常。
- **谁来记**：账本自己看工地事件，用 protocol 的 `EntriesFor` 从事实里读出来：一轮没做成（`failed`）、会冲突（`conflicted`）、开工（`opened`）、派出帮工（`hired`）、拆好计划（`planned`）、收获计划（`playbook`，带合进去的步数、有没有同时做的一批）、升级（`level`）、六块地都在干活（`busy6`）、收获（`harvested`：帮工离开的事实说它的工单是收获关的、合进去几个提交，项目、农机、干了几轮、花了多少从离开前的状态里读）、主人给帮工带话（`told`：主人的消息进了它的工单串，消息的事实带着是谁的串）、主人 @ 地里的帮工（`called`）、帮工回了点名它的另一个帮工（`handoff`：消息的事实带着它回的是谁）。业务的服务不调账本；只有主人在应用里做的事在 HTTP 那一层记：语音接通（`voice`）、看收成清单（`reviewed`）、称号（`titled`）、旧金币（`carried`，只一次）。
- **每个档案的战绩**：派出帮工（`hired`）、活收进主分支（`harvested`）、一轮没做成（`failed`）这三种记下帮工的档案（`agent`），折成 `progress.agents`：每个档案雇过几次、收成几次、没做成几次。帮工名册和帮工栏照它显示，换客户端、关着客户端时发生的事都算。加这个之前记的条目没有档案，不算进去。
- 规则改了，重启后整本按新规则重折。

## 种植计划

一件很长的活拆成几步，每步交给一个帮工，有先后（`tickets/playbooks.go`；规则是 protocol 的 `playbook.go`；[理由](../.agents/notes/implemented/feature/2026-10-11-playbooks.md)）。计划是一张带子工单的父工单（「工单」；[理由](../.agents/notes/implemented/architecture/2026-10-15-plans-are-parent-issues.md)）：父工单的 id 是计划的 id（`p1`），带着 `plan`；每一步是一张子工单 `<计划>.<步骤>`，带着 `step`，`blockedBy` 是它要等的步骤。拆计划的帮工是父工单的执行，做某一步的帮工是那张子工单的执行。`Playbooks` 每改一次计划，`Issues.PutPlaybook` 在一个事务里写整家工单，先发子工单的事实、最后发父工单的；`protocol.PlaybookOf` 从核心状态里的工单把计划拼回来，帧上的 `plans` 是拼好的全部计划。计划的状态：`planning`（在拆）、`draft`（等你看）、`running`、`paused`、`ripe`（都做完了，等收获）、`done`、`abandoned`；每一步：`waiting`、`working`、`merged`（合进计划分支了）、`failed`、`skipped`。

**拆**（管家的 `plan`，`POST /api/playbooks`）：派一个帮工到项目里（谁去按「派给谁」挑，也可以点名），工单是 `runs/rules.go` 的 `PlanningTask`：只读代码、不改文件，汇报的最后用一个 json 代码块给出计划（`PlanDraft`：每步的 id、标题、工单、要等的步骤、谁来做、检查命令、该改的地方、是不是验收）。交回来后 protocol 的 `ParsePlan` 读最后一个 json 代码块并校验：id 是简短的英文且不重复、要等的步骤存在、不等自己、没有圈、最多 12 步、每步有工单、验收步骤有检查命令。不合格就把问题告诉它，让它重给一次；第二次还不行，或者它失败、被叫停、被请走，计划放弃。合格就成为草稿，规划的帮工收工。

**看和改**（`plan_edit`；`PUT`、`DELETE /api/playbooks/:id/nodes/:node`）：草稿什么都能改，也能加步骤、删步骤；开工以后只能改还没开始或没做成的步骤。每次改完，整张图重新校验。

**开工**（`start`）：从主分支当前的提交开一条计划分支 `vibevalley/pb-<id>-<时间>`。之后每当有帮工汇报、有帮工离开、计划有变化，就看一遍哪些步骤能开工（`Startable`）：要等的步骤都合进去了或跳过了，并且在计划自己的并行数以内（默认 3）。能开工的按步骤指定的档案派帮工，没指定就按规则挑。帮工的 worktree 从计划分支当时的提交开出来，所以看得到前面步骤的代码。工单（`NodeTask`）带上计划的目标、这是第几步、该改哪里、前面每一步的结论和提交号、做完要跑的检查。农场的上限照常算，派不出去就等着，计划上写一行原因。

**一步做完**：

1. 农场在它的 worktree 里验它（最长 10 分钟一条命令），不信帮工自己说的，见下面「验收」：验收步骤的检查要不通过；别的步骤不能改冻结的文件，自己的检查要通过，最后一步还要通过它前面的验收。没过就带着原因（命令输出的结尾、改了哪些冻结的文件）退回去让它改。
2. 把它的分支合进计划分支，不动任何检出：能快进就快进，否则 `merge-tree` 算出合并后的树，`commit-tree` 做合并提交，`update-ref` 移动计划分支。然后删掉它的 worktree 和分支，帮工收工，这一步记下结论、提交号和花费。
3. 合进去会冲突：让它把计划分支合进自己的分支、解决冲突（`ConflictTask`），做完再合一次。
4. 每一步都合进去或跳过之后，计划熟了（`ripe`），发一条提醒，管家转告。

**验收**（`acceptance`；[理由](../.agents/notes/proposed/architecture/2026-10-14-sample-then-verify.md)）：一步可以是验收，规划的帮工在修 bug、或要做的事能用测试说清时把它放在第一步，别的步骤都等它。

- 验收步骤只写现在会失败的测试，它的检查命令就是验收。做完时检查要**不通过**；通过了说明它没抓住问题，退回去重写。
- 合进计划分支时，记下它改了哪些文件（`frozen`：从计划分支分出来以后改的，提交没提交的、新加的都算，`Projects.ChangedFiles`）。这些文件对在它后面的步骤是冻结的：哪一步改了它们，就退回去，让它恢复原样、从代码上修。
- 没有步骤等着的步骤（最后一步）做完时，除了自己的检查，还要跑在它前面的每个验收的检查（`AcceptanceChecks`），都通过才合。
- 工单（`NodeTask`）把这些告诉帮工：验收步骤知道要写失败的测试、不修；后面的步骤知道哪些文件冻结了；最后一步知道要跑哪些验收。计划板上验收步骤带一个「验收」的牌子，悬停看冻结的文件。

**没做成**：一轮失败、检查没过、验收没抓住问题、改了冻结的文件、合并冲突，都算一次；农场自己让它重来，最多 2 次（`AutoRetries`）。再不行这一步就是 `failed`：等它的步骤停着，别的步骤照做。你可以重试（帮工还在就接着原来的会话，带上可能改过的工单；不在就重新派人）、改工单，或者跳过（等它的步骤照常开工，后果你自己负责）。帮工被叫停，计划暂停；帮工被请走，这一步算没做成。

**暂停和继续**：暂停后不开新的步骤，正在做的做完。继续时，正在做的步骤分三种：帮工已经做完的，去跑检查、合并；歇着的，接着做；不在了的，重新排队。

**经过**（`tickets/playbook_log.go`）：计划每写一次，就和写之前比一比（protocol 的 `PlaybookChanges`），变了什么记一行，存在田头的数据库里（`playbook_events`），带是谁做的：客户端上的是主人，管家工具里的是管家，调度、检查、合并、帮工的一轮结束是农场。记的是：要拆、拆好了、开工、暂停、继续、熟了、收获、放弃、计划的说明变了；每一步的开工、退回去重做（带为什么）、合进去（带结论和提交号）、没做成、重试、重新排队、跳过、改工单（带改前改后）、加步骤、删步骤。计划板从 `GET /api/playbooks/:id/events` 读。

**收获和放弃**：收获（`harvest`）把计划分支合进项目的主分支。和收获帮工一样先预检冲突，会冲突就不合，计划留着。合进去以后删掉计划分支，计划变成 `done`。收获前看的清单来自 `GET /api/playbooks/:id/changes`。放弃时，正在做的帮工收工，计划分支和有提交的步骤分支都留着。

**管家**：
- 工具：`plan`、`playbooks`、`plan_edit`、`plan_action`（开工、暂停、继续、放弃、收获）、`node_action`（重试、跳过）。
- 「农场现状」里列着没收完的计划。
- 计划里帮工的汇报不转给管家；只有拆好了、某一步没做成、全部做完时，计划自己告诉管家一句，以「【种植计划】」开头。
- 收获帮工的工具和接口不收计划里的帮工：它们的活进计划分支。

## 额度、花费和上限

额度、花费和上限的理由见 [quota-spend-and-limits](../.agents/notes/implemented/feature/2026-10-10-quota-spend-and-limits.md)。

**额度**（`runs/runtimes.go`）：有套餐的农机（claude、codex、grok……）用 smith 的账户用量，按窗口给出用了多少；pi 按量付费，读它当前服务商的账户余额（现在只有 DeepSeek：用 pi 自己解析出的密钥调 `GET /user/balance`，只读）。每 5 分钟读一次，帮工干完一轮 20 秒后再读一次它的农机，有变化就发 `runtime` 事件；停用的农机不读。剩不到 15%（`protocol.QuotaLow`）的，管家尽量换人并告诉主人。

**花费**：`usage` 事件给出会话累计的 token；按 pi 价目表（`runs/pi_prices.json`，pi-ai 内置的那份，不含 pi 配置里自加的模型）里这个模型的价格（美元每百万 token，缓存读另算）折成人民币（`VIBEVALLEY_CNY_PER_USD`，默认 7.2，所以是估算），施加 `spent` 事实。claude、codex 不在 pi 的价目表里，只记 token。每轮汇报带这一轮花的：claude 只在一轮结束的那一帧里报用量，排在这一轮结束之后，所以汇报等这一帧的事件处理完再施加。今天每台农机花了多少记在 `spend.json`，跟着 `RuntimeInfo.spentToday` 发给客户端。

**谁也派不出去的时候**（protocol 的 `AgentIssues`；客户端的 `lib/rules/` 有它的 Dart 移植，提前在帮工页上显示）：档案停用、农机没装或停用、配置有错（农机不接受的参数）、DeepSeek 余额用完、今天的花费到了每日预算（`RuntimeSettings.dailyBudget`，在农具房设）、有套餐的农机（claude、codex）某个额度窗口用到了 100%（写明哪天几点重置）。正在干的会干完。

**同时干活的上限**：派活和叫醒歇着的帮工都要有空位，没有就说是哪个上限，管家转告主人：

| 上限 | 多少 | 为什么 |
|---|---|---|
| 农场 | 6（`protocol.MaxRunning`） | 6 块地 |
| 每台农机 | `RuntimeSettings.maxWorking`，在农具房设，默认不另设 | 服务商限并发 |
| 每个项目 | `VIBEVALLEY_MAX_PER_PROJECT`，默认 3 | 人多了容易改到同一个文件 |

6 块地都有人、新活又来时，最早闲下来的那个先收工，腾出地。

## 重启

核心状态（帮工）在 `farm.json`，田头、账本、记性、定时和工单（连同种植计划）在 `farm.db`，帮工的会话 id、worktree 目录、最后一轮原话和这个会话已经想起过的记性在 `crew.json`，管家的对话在 `foreman/`。重启后（[理由](../.agents/notes/implemented/architecture/2026-10-10-restart-keeps-the-farm.md)）：

- 帮工回到各自的地上，会话先不打开。有人给它带话时，smith 按会话 id 接着原来的会话开新一轮；接不上就在同一个 worktree 里新开会话，并告诉它看 git log。收获、收工不需要会话，直接做。
- 重启时正在干的那一轮记成「VibeValley 重启了，这一轮停在了半路」，帮工歇着，发一条提醒。
- worktree 不见了的帮工不接回来，提醒一句。
- 帮工编号接着以前的往下排，不会撞上旧的干活过程。
- 种植计划跟着工单回来。正在拆的计划放弃；有步骤做到一半的计划暂停，点继续就接着做。`farm.json` 里还有计划的老农场，开机时把它们变成工单（`Issues.adoptPlaybooks`），`farm.json` 当时的样子另存为 `farm.json.playbooks`。
- 田头从数据库回来：最近 100 个对话、300 条消息放回核心状态。没说完的话就停在那里；已交付、没看到的消息退回未交付，帮工下次醒来再给。
- 金币、连胜、成就从账本重新折出来（不在 `farm.json` 里）。

## 搬家

**从旧名字迁移**（`vibevalley migrate`，`cmd/vibevalley/migrate.go`、`internal/farm/oldnames.go`）：这个项目以前叫 heybro，又短暂地叫过 vibefarm；那时的农场放在旧名字下，服务端不会去找。迁移一次：

- 搬走旧文件夹：`~/Library/Application Support/heybro`（各渠道同理）、`~/.heybro`、`~/.vibefarm` 里这个服务端的农场（有 `farm.db`）搬到 `vibevalley` 的位置；日志 `~/Library/Logs/heybro` 同样；工作目录 `~/heybro-work`（或 `~/vibefarm-work`）搬到 `~/vibevalley-work`。旧 TypeScript 服务端的家（有 PGlite 的 `db/`）和更早的应用留下的文件夹不动。新位置已经有东西的不搬。
- 改写旧的路径和名字：农场的 JSON 文件和 `farm.db` 里指向旧文件夹的路径换成新的，农机 id 和语音 vendor 从 `heybro` 换成 `vibevalley`，`.env` 里 `HEYBRO_`、`VIBEFARM_` 开头的变量改名 `VIBEVALLEY_`。
- 项目里：帮工的 worktree 用 `git worktree repair` 重新连上项目，`heybro/…`、`vibefarm/…` 分支改名 `vibevalley/…`，农场的数据也跟着改。
- 应用的偏好（`dev.heybro.flutter`）复制到 `dev.vibevalley.app`。
- 先把要动的全部复制一份到 `~/vibevalley-migration-<时间>/`；`--dry-run` 只说会做什么；农场的服务端开着时不做（`--force` 硬做）。

TypeScript 服务端（已删）留下的家（默认 `~/.heybro`，那时这个项目还叫 heybro）可以搬进 Go 服务端的家：`db/` 以外的文件照拷，PGlite 数据库先用 `server/tool/dump-pglite.ts` 倒成 JSON，再由 `vibevalley import`（`cmd/vibevalley/import.go`、`internal/farm/import.go`）按原来的 id 和 seq 写进 `farm.db`。两步都不改原来的家；导的时候 Go 服务端要停着；目标已经有农场就不导，除非加 `--force`。命令和细节见 [server 的 README](../server/README.md#从-typescript-服务端搬家)。
