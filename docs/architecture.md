# 架构

## 总图

```mermaid
flowchart LR
  subgraph Page[页面 apps/web]
    UI[农场和工作台<br/>Solid 2 + PixiJS]
    RULES[src/rules<br/>帧里没有的摆法]
    RTC[Agora Web SDK<br/>字幕走 data stream]
  end

  subgraph Server[apps/server · Effect · 127.0.0.1:8787]
    API[handlers<br/>VibeValleyApi、三条 SSE]
    SITE[Core<br/>核心状态 CoreState]
    FM[管家<br/>vibevalley 自己的 agent + 派活工具]
    CHAT[田头<br/>群聊 · PGlite]
    MCP[农场的工具<br/>/mcp]
    TK[工单<br/>派活、排队、计划、合并]
    CREW[执行（帮工）<br/>oar 子 agent]
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
  SITE -->|折好的帧：SSE<br/>/api/v1/state| UI
  SITE -->|窄流：SSE<br/>干活过程、提醒、农机| UI
  API --> CHAT & FM & TK & CREW & PRJ & RT
  CHAT <-->|给它的话 / 它说的话| FM
  CHAT -->|叫醒、提示| CREW
  CREW -->|channel_say、read_chat……<br/>带自己的令牌| MCP
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
  CAI -.->|听到的一句话，经页面| API
```

三条线：

- **命令**：页面通过 HTTP 调 `VibeValleyApi`（`packages/protocol` 的客户端，按 `api.ts` 的接口表）：在田头说话、写和派工单、带话、叫停、收工、收获、种植计划、读配置。帮工在田头说话走另一个入口：服务端的 MCP 端点 `/mcp`（[田头](docs/subsystems/channel.md)）。
- **状态**：服务端的核心状态每变一次就是一条事实。页面收折好的帧（`GET /api/v1/state`），自己不折。
- **语音**：页面和 Agora 频道之间是音频和字幕，服务端只签令牌、请语音管家进出频道（[语音](docs/subsystems/voice.md)）。

## 分层

仓库的目录见根目录 [AGENTS.md](AGENTS.md#目录)。

- **形状和规则**：`packages/protocol` 是唯一的来源。形状写在 `src/shapes.ts`，`src/schema.ts` 给每个形状一个由它定类型的 Effect Schema（读写 JSON 时解码），接口写在 `src/api.ts`（路径、参数、请求体、答复、谁能调）；规则是 `src/rules` 里的纯函数，服务端和页面都 import（[理由](docs/subsystems/foundation.md)）。
- **服务**：`apps/server/src/` 下一块业务一个文件夹，名字用单数，从下往上是 `base`（地基）、`core`（核心状态）、`setting`、`agent`、`project`、`memory`、`doc`、`runtime`、`session`、`channel`、`schedule`、`issue`、`task`、`tool`、`mcp`、`manager`、`lan`、`voice`、`connector`、`game`。每个模块导出一个 Effect 服务（`Context.Service`）和它的 `layer`；`services.ts` 按这个次序把 layer 叠起来，一个模块只用排在它前面的，反方向的消息走它们给的流（`Stream`）；开机后才做的（第一次看 GitHub、把帮工请回来、定时开始走、数 commit）是叠在最后的 `start`、`ready` layer（[理由](docs/subsystems/foundation.md)）。执行由 [oar](https://www.npmjs.com/package/@botiverse/oar) 驱动，管家是 VibeValley 自己的 agent（`agent/brain`，[agents-and-runtimes.md](docs/reference/agents-and-runtimes.md)）。
- **HTTP 和 MCP**：`src/http` 在最上面：`api.ts` 照 protocol 的接口表挂路由，`handlers.ts` 答每一个，`streams.ts` 是三条事件流；`/mcp` 是给编码 agent 的另一个入口（`src/mcp`）；`main.ts` 单独跑它，`--web` 时也在 `/` 提供页面（[子系统](docs/subsystems/README.md)）。命令走 HTTP，事件和状态走 server-sent events（[理由](docs/subsystems/core.md)）。
- **存盘**：PGlite（进程里的 Postgres），表在 `apps/server/db/migrations/`，查询在 `db/queries/`、由 effect-sqlc 生成成 `db/generated/`（[理由](docs/subsystems/foundation.md)）；下文「存了什么」。
- **页面**：只连服务端的接口，用 Solid Query 读一次性的数据，帧由一条流给（[理由](docs/subsystems/app.md)）；三个宿主共用：桌面是 Electron 带着服务端起来、打开它的地址，浏览器直接打开（[页面](docs/subsystems/app.md)）。

## 核心状态

农场上的一切（通话、管家、帮工、田头、工单和计划、定时、commit 数、金币和成就）是一个值 `CoreState`（`packages/protocol/src/shapes.ts`；[理由](docs/subsystems/core.md)）。只有服务端持有它，只在 `Core.apply`（`apps/server/src/core/core.ts`）里改：每个事实（雇了一个帮工、开始一轮、这一轮结束、一张工单变了……）由纯函数 `reduce(state, fact)`（`packages/protocol/src/rules/core.ts`）折进去。不改变状态的事实不发。

每个帮工（`Session`）的阶段 `phase` 是它生命周期的唯一状态：

| 阶段 | 含义 | 要你做什么 |
|---|---|---|
| `arriving` | 会话正在打开 | — |
| `working` | 一轮正在进行；可能带 `quietSince`（太久没动静）、`retry` | 没动静：看看过程，不对就叫停 |
| `ripe` | 上一轮完成 | 收获；会冲突时先让它解决 |
| `failed` | 上一轮失败 | 让它接着修，或请它收工 |
| `resting` | 被叫停，或服务端重启后回来 | 带句话就接着干 |

在做什么、要你做什么、能不能收都由阶段推出来（protocol 的纯函数）。`play` 是地里那一层（在哪块地、最近的步骤、碰过的文件），`conflict` 是最近一次 git 检查的结果，不属于阶段。帮工离开就从状态里删掉。

工单（`Issue`）里开着的和最近关的 50 张（`keepClosedIssues`，连同子工单）在核心状态里，全部在数据库；状态由 `issueStatusOf` 算。种植计划是带 `graph` 的父工单，每一件是带 `task` 的子工单，`graphsOf` 读成 `TaskGraph`（[种植计划](docs/subsystems/task.md)）。田头在核心状态里的只是页面马上要画的：频道、最近的串和最近的消息，更早的用 HTTP 取。定时、账本折出来的进度也在里面（[定时](docs/subsystems/schedule.md)、[游戏](docs/subsystems/game.md)）。

给页面的是 `StateFrame`（`GET /api/v1/state`，至多每 200 毫秒一帧）：折好的 `state`，从它推出来的 `inbox`、`graphs`、`view`（地块、等级），和这段时间的效果 `effects`。帧只由纯函数 `frameOf` 拼：给人看的话（帮工在干什么、定时什么时候跑、计划是哪个状态、动作叫什么、现在能做什么）只在这一步填进状态的副本，`reduce` 和 `state.json` 里没有。页面的 `src/rules` 只是读帧，不重写服务端的规则。帮工在院子里走到哪、一闪而过的效果，只在页面。

## 事件流

`GET /api/v1/events`（server-sent events）：连上先发一条 `snapshot`（整份核心状态），之后发事实，以及几样核心状态之外的：轨迹的一步（`step`）、提醒（`notice`）、农机变了（`runtime`）。断线重连又从快照开始。这条流留给命令行（`state`、`events`）和调试。

`GET /api/v1/live`（server-sent events）是页面的窄流：只发 `LiveEvent` 的三种成员（会话的一步、提醒、农机），不发事实、不发快照；状态仍由 `/api/v1/state` 给。事实的种类见 `shapes.ts` 的 `Fact`；帮工的会话事件怎么变成事实见 [帮工](docs/subsystems/session.md)。

三条流每 20 秒发一次心跳；写不出去就结束订阅。核心状态按首个变化起算的 500 毫秒窗口合并落盘，持续收到事实不会推迟这次保存；关闭时再保存最后的状态。

## HTTP 接口

接口的唯一定义是 `packages/protocol/src/api.ts` 的接口表 `endpoints`：每个接口的 `op`（`issue.create`）、方法和路径、路径参数、查询参数、请求体和答复的 Schema、`can`（谁能调）。服务端照它挂路由、解码请求体、编码答复，页面和命令行都照它调。**都在 `/api/v1` 下**：不兼容的改动另起 `/api/v2`，v1 留到设备都升级（[理由](docs/subsystems/core.md)）。不在表里的：`/api/v1/events`、`/api/v1/state`、`/api/v1/live` 三条流，和给帮工的 `/mcp`（每个会话带自己的令牌，[田头](docs/subsystems/channel.md)）、给语音管家的 `/v1/chat/completions`（[语音](docs/subsystems/voice.md)）。「连接到本机」只放 `can` 里有 `remote` 的（[能力表](docs/reference/capabilities.md)、[连接到本机](docs/subsystems/lan.md)）。

## 存了什么

服务端都在 `$VIBEVALLEY_HOME`（默认 `~/.vibevalley`）。存盘的格式只有现在这一种：不认旧名字下的文件，也没有搬旧数据的命令。

| 文件 | 内容 |
|---|---|
| `.vibevalley.lock` | 家目录的租约：里面是在用它的服务端的 pid；同一目录只允许一个服务端，那个进程没了就接过来 |
| `config.json` | 帮工档案、技能书、每台农机的设置。第一次启动时用 protocol 的种子（`packages/protocol/src/rules/seeds.json`） |
| `settings.json` | 「设置」里存的钥匙、语音设置和记性的来源（Nowledge Mem、EverOS 的地址和 key）；只有你能读 |
| `state.json` | 核心状态，田头、进度、定时和工单除外：帮工、commit 数 |
| `db/` | PGlite 的库：田头、工单和它们的帮工、文档、每次干活（`session_run`）、计划的经过、账本、记性、定时、连接器、「连接到本机」的设备；新建的行主键是 uuidv7，工单和每条消息另有自己的顺序号（表名是「模块_概念」、单数，结构在 `apps/server/db/migrations/0001_schema.up.sql`，一个基线，改表直接改它，旧库删掉重建）。查询都在 `db/queries/`，一张表一个文件。启动时把工单、最近的对话、定时放回核心状态，把账本折成进度 |
| `sessions.json` | 只有服务端需要的：每个帮工的项目目录或 worktree、农机自己的会话 id、最后一轮的完整原话 |
| `events/<id>.json` | 每个 Session 的事件日志（走了留 30 天；是谁、为哪张工单、怎么关的在库里的 `session` 表，一直留着）；管家的是 `manager.json` |
| `spend.json` | 今天每台农机花了多少 |
| `manager/` | 管家（VibeValley 自己的 agent）：对话 `manager.jsonl`、记性 `MEMORY.md`、压掉的旧对话 `archive/`、主人标出的做错的一轮 `evals/` |
| `logs/` | 每个帮工会话的原始记录 |
| `vibevalley.yaml` | 可选：配置（见下）；放钥匙时不进仓库 |

页面的偏好（宠物、静音、看板的样子……）存在浏览器里（`localStorage`），只在这台机器上。

## 配置

配置只有两个来源（`base/config.ts` 的 `loadConfig`；[理由](docs/subsystems/setting.md)）：

1. `$VIBEVALLEY_HOME/vibevalley.yaml`，或 `--config` 给的文件；
2. 环境变量，比文件优先：`VIBEVALLEY_` 加上键名，点换成下划线，比如 `session.stall_seconds` 是 `VIBEVALLEY_SESSION_STALL_SECONDS`。三个外家的钥匙用它们自己的名字：`DEEPSEEK_API_KEY`、`AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`。

家目录不在文件里：它由 `VIBEVALLEY_HOME` 定，默认 `~/.vibevalley`。写错的数字、不是端口的端口、`--config` 给了却找不到的文件，服务端都不起来。「设置」里存的钥匙和语音设置比配置优先。

| 键 | 用途 | 默认 |
|---|---|---|
| `work_root` | 工作目录：`projects/` 是项目，`worktrees/` 是 worktree，帮工只在这里面干活（[项目](docs/subsystems/project.md)） | `~/vibevalley-dev` |
| `db` | 库：PGlite 的文件夹；`memory` 是只在内存里 | `$VIBEVALLEY_HOME/db` |
| `port` | 主接口固定听 `127.0.0.1`，只能选端口；0 由系统分配。HTTP 和帮工的 `/mcp` 使用同一实际监听地址 | 8787 |
| `web` | 同时在 `/` 提供的页面（`apps/web/dist`）；也可以用 `--web` 给 | 无 |
| `agent.model` | 命令行里自己的 agent 用的模型；空着是 DeepSeek 的默认 | |
| `deepseek.api_key` | 管家和 VibeValley 农机用的 DeepSeek 钥匙（`DEEPSEEK_API_KEY`） | |
| `agora.app_id`、`agora.app_certificate` | 语音：签 RTC 令牌、请语音管家（`AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`）；都没有时语音不可用，别的照常 | |
| `voice.id` | 语音管家的音色的默认；声音页里改过的优先 | 声音页的默认 |
| `voice.line.port`、`voice.line.url` | 语音线路（「想」选农场的管家时）：只给声网用的那个监听的端口；你自己的隧道的公网地址，没有就用 cloudflared 临时隧道 | 8788、（无） |
| `lan.port` | 「连接到本机」的端口：打开「连接到本机」时在所有网卡上听，只放配对过的设备（[连接到本机](docs/subsystems/lan.md)）；0 是随便一个 | 8790 |
| `git_emails` | 算经验时也算作「你」的 commit 邮箱；环境变量里用逗号分隔 | git 全局和各仓库的 user.email 本来就算 |
| `tokei` | 数项目种了什么用的 tokei 在哪 | PATH 上的 `tokei` |
| `cny_per_usd` | 价目表是美元，折成人民币的汇率 | 7.2 |
| `patrol.heartbeat_minutes` | 巡查的间隔，0 是关掉 | 10 |
| `schedule.tick_ms` | 多久看一遍有没有到点的定时 | 20000 |
| `session.stall_seconds` | 一轮里多久没动静就提醒 | 240 |
| `session.trajectory_days` | Session 走了以后，它的事件日志留几天（`session` 表里的行一直留着）；0 是一直留着 | 30 |
| `project.max_sessions` | 一个项目里最多几个帮工同时干活 | 3 |
| `project.check_timeout_seconds` | 收获前在帮工 worktree 里运行 `.vibevalley/check` 的时限，超时拒绝合并 | 1200 |
| `github.pr_projects` | 收获时提 PR 的项目名列表；还须项目的 `pullRequest.available` 为真，其他项目本地合并 | 空列表 |
| `github.pr_poll_seconds` | 查询开着的 PR 的间隔，单位秒，必须大于 0 | 180 |
| `chat.notice_batch_ms` | 忙着的帮工收到的提示，攒多久合成一条 | 3000 |
| `chat.retry_wake_ms` | 叫醒在开口前就失败了，多久以后再叫一次 | 3000 |

桌面版起服务端时另设 `VIBEVALLEY_PORT=0`（自己挑端口，由 `--ready-json` 报回地址）和页面的位置（[页面](docs/subsystems/app.md)）。

密钥只在服务端；页面只拿 App ID、频道名、uid 和自己的令牌。
