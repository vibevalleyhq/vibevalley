# 架构

## 总图

```mermaid
flowchart LR
  subgraph Client[客户端 app]
    UI[农场画面和面板<br/>Flutter + Flame]
    RULES[lib/rules<br/>帧里没有的规则]
    RTC[Agora RTC<br/>字幕走 data stream]
  end

  subgraph Server[server · Go · 127.0.0.1:8787]
    API[handler<br/>VibeValleyApi、两条 SSE]
    SITE[Site<br/>核心状态 FarmState]
    FM[管家<br/>vibevalley 自己的 agent + 派活工具]
    CHAT[田头<br/>群聊 · SQLite]
    MCP[农场的工具<br/>/mcp]
    TK[工单<br/>派活、排队、计划、合并]
    CREW[执行（帮工）<br/>smith 子 agent]
    PRJ[项目<br/>git worktree]
    RT[农机<br/>探测、额度、花费]
  end

  subgraph Agora[Agora 云]
    CAI[ConvoAI<br/>识别 → 大模型 → 合成]
  end

  AGENTS[(本机的农机<br/>pi、claude、codex……)]
  DS[(DeepSeek)]

  UI --> RULES
  UI -->|命令：HTTP| API
  SITE -->|折好的帧：SSE<br/>/api/site/state| UI
  SITE -->|工地事件：SSE<br/>干活过程、提醒、农机| UI
  API --> CHAT & FM & TK & CREW & PRJ & RT
  CHAT <-->|给它的话 / 它说的话| FM
  CHAT -->|叫醒、提示| CREW
  CREW -->|farm_say、farm_read……<br/>带自己的令牌| MCP
  MCP --> CHAT
  FM -->|写工单、派活、收获、拆计划| TK
  TK -->|开执行、叫走| CREW
  TK -->|worktree、合并| PRJ
  CREW --> AGENTS
  FM --> DS
  CHAT -->|事实：消息、对话| SITE
  TK -->|事实：工单| SITE
  CREW -->|事实：执行| SITE
  FM -->|事实：管家状态| SITE
  RTC <-->|音频、字幕| CAI
  CAI -.->|听到的一句话，经客户端| API
```

三条线：

- **命令**：客户端通过 HTTP 调 `VibeValleyApi`（Flutter 用 `lib/gen/vibevalley.dart` 里生成的客户端）：在田头说话、写和派工单、带话、叫停、收工、收获、种植计划、读配置。帮工在田头说话走另一个入口：服务端的 MCP 端点 `/mcp`（[server.md](server.md)「田头」）。
- **状态**：服务端的核心状态每变一次就是一条事实。Flutter 收折好的帧（`GET /api/site/state`），自己不折。
- **语音**：客户端和 Agora 频道之间是音频和字幕，服务端只签令牌、请语音管家进出频道（[voice.md](voice.md)）。

## 分层

仓库的目录见根目录 [AGENTS.md](../AGENTS.md#目录)，服务端每个包管什么见 [server/README.md](../server/README.md#目录)。

- **形状和规则**：Go 的 `server/internal/protocol` 是唯一的来源。形状写在 `shapes.go`、接口写在 `api.go`，`server/tool/shapegen` 从它们写出 Go 的胶水代码（`internal/protocol/gen.go`）和 Flutter 的类型与接口客户端（`app/lib/gen/vibevalley.dart`）；规则是同一个包里的纯函数（[server](../server/README.md#形状和规则从哪来)、[理由](../.agents/notes/implemented/architecture/2026-10-15-go-owns-the-shapes.md)）。
- **服务**：`server/internal/` 下一个概念一个包，从下往上是 `base`、`projects`、`memory`、`runs`、`chat`、`tickets`、`manager`、`channels`、`game`；一个包只 import 排在它前面的包，反方向的消息走 `base.Hub`。每个服务是包里的一个结构体，由 fx 组装；`farm` 把全部包装在一个生命周期上（[server/README.md](../server/README.md#服务)、[理由](../.agents/notes/implemented/architecture/2026-10-16-a-package-per-concept.md)）。执行由 smith 驱动，管家是 VibeValley 自己的 agent（[agents-and-runtimes.md](agents-and-runtimes.md)）。
- **HTTP**：`server/internal/handler` 在最上面，答 `VibeValleyApi`、两条事件流和 `/mcp`；`cmd/vibevalley` 单独跑它（[server.md](server.md)；[理由](../.agents/notes/implemented/architecture/2026-10-13-go-server-on-smith.md)）。命令走 HTTP，事件和状态走 server-sent events（[理由](../.agents/notes/implemented/architecture/2026-10-10-site-events-over-sse.md)）。
- **存盘**：SQLite，表在 `server/migrations/`，查询在 `server/pkg/db/queries/`、由 sqlc 生成成 `server/pkg/db/generated/`（[理由](../.agents/notes/implemented/architecture/2026-10-15-sqlc-queries.md)）；下文「存了什么」。
- **客户端**：Flutter 只连服务端的接口，用 Riverpod 管状态（[理由](../.agents/notes/implemented/architecture/2026-10-13-flutter-client-over-ts-server.md)）；macOS 版把服务端打进应用（[desktop.md](desktop.md)）。

## 核心状态

农场上的一切（通话、管家、帮工、田头、工单和计划、定时、commit 数、金币和成就）是一个值 `FarmState`（`server/internal/protocol/shapes.go`；[理由](../.agents/notes/implemented/architecture/2026-10-11-farm-core-state.md)）。只有服务端持有它，只在 `Site.Apply`（`server/internal/base/site.go`）里改：每个事实（雇了一个帮工、开始一轮、这一轮结束、一张工单变了……）由纯函数 `Reduce(state, fact)`（`protocol/farm.go`）折进去。不改变状态的事实不发。

每个帮工（`Helper`）的阶段 `phase` 是它生命周期的唯一状态：

| 阶段 | 含义 | 要你做什么（`NeedOf`） |
|---|---|---|
| `arriving` | 会话正在打开 | — |
| `working` | 一轮正在进行；可能带 `quietSince`（太久没动静）、`retry` | 没动静：看看过程，不对就叫停 |
| `ripe` | 上一轮完成 | 收获；会冲突时先让它解决 |
| `failed` | 上一轮失败 | 让它接着修，或请它收工 |
| `resting` | 被叫停，或服务端重启后回来 | 带句话就接着干 |

在做什么、要你做什么、能不能收都由阶段推出来（protocol 的纯函数）。`play` 是地里那一层（在哪块地、最近的步骤、碰过的文件），`conflict` 是最近一次 git 检查的结果，不属于阶段。帮工离开就从状态里删掉。

工单（`Issue`）里开着的和最近关的 50 家（`KeepClosedIssues`，连同子工单）在核心状态里，全部在数据库；状态由 `IssueStatusOf` 算。种植计划是带 `plan` 的父工单，步骤是带 `step` 的子工单，`PlaybooksOf` 读成 `Playbook`（[server.md](server.md)「种植计划」）。田头在核心状态里的只是页面马上要画的：频道、最近的串和最近的消息，更早的用 HTTP 取。定时、账本折出来的进度也在里面（[server.md](server.md)「定时」「账本」）。

给 Flutter 的是 `SiteFrame`（`GET /api/site/state`，至多每 200 毫秒一帧）：折好的 `state`，从它推出来的 `inbox`、`plans`、`view`（地块、等级），和这段时间的效果 `effects`。帧里没有、Flutter 要用的规则移植在 `app/lib/rules/`。帮工在院子里走到哪、一闪而过的效果，只在客户端。

## 工地事件

`GET /api/site/events`（server-sent events）：连上先发一条 `snapshot`（整份核心状态），之后发事实，以及几样核心状态之外的：轨迹的一步（`step`）、提醒（`notice`）、农机变了（`runtime`）。断线重连又从快照开始。Flutter 读帧，只从这条流取核心状态之外的那几样。事实的种类见 `shapes.go` 的 `Fact`；帮工的会话事件怎么变成事实见 [server.md](server.md)「帮工」。

## HTTP 接口

接口的唯一定义是 `server/internal/protocol/api.go` 的 `Handlers`：每个方法一个接口，`//vibevalley:route` 写它的方法和路径，`internal/handler` 实现，Flutter 用同一份生成的 `VibeValleyApi`。不在里面的三个：`/api/site/events`、`/api/site/state` 两条流，和给帮工的 `/mcp`（每个会话带自己的令牌，[server.md](server.md)「田头」）。`/api/lan/*` 里管院门的接口只在本机答（[server.md](server.md)「院门」）。

## 存了什么

服务端都在 `$VIBEVALLEY_HOME`（`cmd/vibevalley` 默认 `~/.vibevalley`；macOS 应用默认 `~/Library/Application Support/vibevalley`，Alpha、Beta 各有自己的，[desktop.md](desktop.md)）。旧名字（heybro、vibefarm）下的农场用 `vibevalley migrate` 搬过来，TypeScript 服务端留下的用 `vibevalley import`（[server.md](server.md)「搬家」）。

| 文件 | 内容 |
|---|---|
| `config.json` | 帮工档案、技能书、每台农机的设置。第一次启动时用 protocol 的种子（`server/internal/protocol/seeds.json`） |
| `settings.json` | 首页「设置」里存的钥匙和语音设置；只有你能读 |
| `farm.json` | 核心状态，田头、进度、定时和工单除外：帮工、commit 数 |
| `farm.db` | SQLite：田头、工单和它们的执行、计划的经过、账本、记性、定时、连接器、院门的设备（表在 `server/migrations/`）。启动时把工单、最近的对话、定时放回核心状态，把账本折成进度 |
| `crew.json` | 只有服务端需要的：每个帮工的项目目录或 worktree、农机自己的会话 id、最后一轮的完整原话 |
| `steps/<id>.json`、`steps/<id>.head.json` | 轨迹：每个帮工的干活过程（帮工走了留 30 天）和它的头：是谁、为哪张工单干、怎么关的（一直留着）；管家的（`foreman`） |
| `spend.json` | 今天每台农机花了多少 |
| `foreman/` | 管家（VibeValley 自己的 agent）：对话 `manager.jsonl`、记性 `MEMORY.md`、压掉的旧对话 `archive/` |
| `logs/` | smith 记的每个帮工会话的原始记录 |
| `.env` | 可选：Agora 的凭据、DeepSeek 的钥匙这类环境变量（见下） |

客户端的偏好（宠物、静音……）存在本机（`lib/shell/prefs.dart`）。

## 环境变量

服务端读（`cmd/vibevalley` 还读 `--env-file` 给的文件和 `$VIBEVALLEY_HOME/.env`，那里放 Agora 的凭据和 DeepSeek 的钥匙，不进仓库；已经设了的变量优先）：

| 变量 | 用途 | 默认 |
|---|---|---|
| `VIBEVALLEY_WORK_ROOT` | 工作目录：每个子文件夹是一个项目，帮工只在这里面干活；也是算经验的范围 | `~/vibevalley-work` |
| `VIBEVALLEY_HOME` | VibeValley 自己的设置和记录 | `~/.vibevalley` |
| `VIBEVALLEY_DB` | 数据库：SQLite 文件，给的是文件夹就用里面的 `farm.db`；`memory` 是只在内存里 | `$VIBEVALLEY_HOME/farm.db` |
| `VIBEVALLEY_FOREMAN_MODEL` | 管家用的 DeepSeek 模型（`deepseek-flash` 或 `deepseek/deepseek-flash`） | `deepseek-flash` |
| `VIBEVALLEY_FOREMAN_RUNTIME` | 管家用什么想事情：只有 `vibevalley`（自己的 agent）；`pi` 会被拒绝，不认识的值用默认 | `vibevalley` |
| `VIBEVALLEY_AGENT_MODEL` | VibeValley 自己的农机没指定模型时用哪个 | `deepseek-flash` |
| `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL` | 管家和 VibeValley 农机用的 DeepSeek 密钥和地址；首页「设置」里存了钥匙就用那个 | 本机 pi 配的 DeepSeek；`https://api.deepseek.com` |
| `VIBEVALLEY_TOKEI` | 数项目种了什么用的 tokei 在哪 | PATH 上的 `tokei` |
| `VIBEVALLEY_GIT_EMAILS` | 算经验时也算作「你」的 commit 邮箱，逗号分隔 | git 全局和各仓库的 user.email 本来就算 |
| `VIBEVALLEY_CNY_PER_USD` | pi 的价目表是美元，折成人民币的汇率 | 7.2 |
| `VIBEVALLEY_STALL_SECONDS` | 一轮里多久没动静就提醒 | 240 |
| `VIBEVALLEY_TRAJECTORY_DAYS` | 帮工走了以后，它的干活过程留几天（轨迹的头一直留着）；0 是一直留着 | 30 |
| `VIBEVALLEY_SCHEDULE_TICK_MS` | 多久看一遍有没有到点的定时 | 20000 |
| `VIBEVALLEY_HEARTBEAT_MINUTES` | 巡查的间隔，0 是关掉 | 10 |
| `VIBEVALLEY_MAX_PER_PROJECT` | 一个项目里最多几个帮工同时干活，0 不限 | 3 |
| `AGORA_APP_ID`、`AGORA_APP_CERTIFICATE` | 语音：签 RTC 和 RTM 令牌、请语音管家；首页「设置」里存了就用那个；都没有语音不可用，别的照常 | |
| `VIBEVALLEY_VOICE_LINE_PORT`、`VIBEVALLEY_VOICE_LINE_URL` | 语音线路（「想」选农场的管家时）：只给声网用的那个监听的端口；你自己的隧道的公网地址，没有就用 cloudflared 临时隧道 | 8788、（无） |
| `VIBEVALLEY_VOICE_MODEL`、`VIBEVALLEY_VOICE_ID` | 语音管家用的托管大模型和音色的默认；声音页里改过的优先 | `gpt-4.1-mini`、`Chinese (Mandarin)_Gentle_Youth` |
| `VIBEVALLEY_NOTICE_BATCH_MS` | 忙着的帮工收到的提示，攒多久合成一条 | 3000 |
| `VIBEVALLEY_RETRY_WAKE_MS` | 叫醒在开口前就失败了，多久以后再叫一次 | 3000 |
| `HOST`、`PORT` | 只听本机：帮工没有权限确认，服务端不能对外。帮工拿到的 `/mcp` 地址也由它们拼出 | `127.0.0.1`、`8787` |
| `VIBEVALLEY_LAN_PORT` | 院门的端口：打开院门时在所有网卡上听，只放配对过的设备（[server.md](server.md)「院门」）；0 是随便一个 | 8790 |

几个写错的值用默认值而不是让服务端起不来（[server](../server/README.md#取舍)）。macOS 应用起服务端时另设 `VIBEVALLEY_HOME`、`VIBEVALLEY_WORK_ROOT`、`PORT` 和登录 shell 的 `PATH`（[desktop.md](desktop.md)）。

密钥只在服务端；客户端只拿 App ID、频道名、uid 和自己的令牌。
