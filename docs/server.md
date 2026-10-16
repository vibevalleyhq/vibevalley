# 服务端：管家和帮工

`server` 是 Go 模块 `vibevalley`，只听 127.0.0.1:8787；局域网里的设备经「院门」进来。包怎么分、服务怎么组装、测试见 [server/README.md](../server/README.md)；存了什么、环境变量见 [architecture.md](architecture.md)。核心状态只经 `Site.Apply` 改；纯规则在 `protocol` 包，只有服务端用的在拥有它的包里（`runs/facts.go`、`runs/rules.go`）。

## 管家

管家是 VibeValley 自己的 agent（`server/pkg/agent`；`manager/foreman.go`；[理由](../.agents/notes/implemented/architecture/2026-10-12-own-agent-on-effect.md)），带管家的提示词和工具，第一句话到了才起来。它没有读写文件、跑命令的工具，自己不写代码。

- **模型**：只接 DeepSeek（`VIBEVALLEY_FOREMAN_MODEL`，默认 `deepseek-flash`）。钥匙依次取首页「设置」、`DEEPSEEK_API_KEY`、本机 pi 配好的 DeepSeek；每次请求前现取。都没有时它在田头说起不来。
- **对话**：存在 `foreman/manager.jsonl`，太长时把早先的压成摘要，原文归档在 `foreman/archive/`。
- **记性**：主人让它记的用 `remember` 记在 `foreman/MEMORY.md`，每一句都带着（[agents-and-runtimes.md](agents-and-runtimes.md)「管家页」）。
- **农场现状**：每次请求的系统提示里带着项目、能派的档案（额度、花费、派不出去的原因）、地里的帮工和没收完的计划，不存进对话。
- **说话**：中文、口语、一两句，只说工具结果和汇报里有的；在串里被问就回在串里。语音管家转来的话（`/api/dispatch`）它只派活不回话。
- **听到什么**：没 @ 别人的话、@管家 的话、没做成的汇报、计划的提醒、到点的定时、巡查的发现。它忙时人的话插进这一轮，其余等这一轮做完。做完的汇报不叫醒它，下次开口时一起交给它。

工具在 `manager/tools.go`：派活（`dispatch`，挑谁见 [agents-and-runtimes.md](agents-and-runtimes.md)「派给谁」）、看和收获（`changes`、`harvest`）、看帮工（`roster`、`check`）、带话叫停收工（`tell`、`stop`、`dismiss`）、频道、定时、记性和种植计划。

**帮工汇报**以帮工自己的名义贴进它的工单串，管家不转述；没做成的叫醒管家。叫停的不贴。

## 定时

「每天早上九点在 #clock-in 跑一遍测试」这类（`tickets/schedules.go`；规则是 protocol 的 `schedules.go`；[理由](../.agents/notes/implemented/feature/2026-10-11-channels-and-schedules.md)）。

- 主人跟管家说，管家用 `schedule` 定；页面上只在频道菜单的「定时」里看、开关、删。
- 一次、每隔几分钟、每天几点、每周几几点，按它的时区。不用 cron。
- 到点先在频道里说一条提示，然后：没写帮工档案的交给管家；写了的是周期工单，`Dispatch` 写一张新工单开工，地满了就排队。一次性的跑过就关。
- 服务端没开着时错过的，开机后只补一次。

## Inbox

要主人处理的事（protocol 的 `inbox.go`；[理由](../.agents/notes/implemented/architecture/2026-10-15-inbox.md)），从核心状态现算、不存，放在 `SiteFrame.inbox`。农场手机当来电，桌面的通知和菜单栏也读它。

| 种类 | 什么时候 |
|---|---|
| `harvest` | 帮工这一轮做完，等你看 |
| `fix` | 帮工这一轮没做成 |
| `conflict` | 合进主分支会冲突 |
| `quiet` | 干着活好久没动静 |
| `plan-draft`、`plan-ripe` | 计划拆好了等你看、做完了等你收 |
| `plan-failed` | 计划里有一步没做成 |
| `mention` | @主人 的话，你没读也没回 |

计划里的帮工由计划报，不单独算；一个帮工一次只算最要紧的一件。

## 巡查

`Heartbeat`（规则是 protocol 的 `patrol.go`）每 `VIBEVALLEY_HEARTBEAT_MINUTES` 分钟不调模型看一遍 Inbox，找放久了没人管的（`mention` 15 分钟、`quiet` 20 分钟、`harvest` 和 `conflict` 2 小时、`plan-failed` 30 分钟），有的才按频道叫醒管家一次，由它决定提不提醒主人。同一件事 4 小时内不再报。

## 设置

首页的「设置」（`base/settings.go`；[理由](../.agents/notes/implemented/feature/2026-10-12-title-screen-and-settings.md)）存 DeepSeek 的钥匙、Agora 的 App ID 和 Certificate，和语音设置（[voice.md](voice.md)「配置」）。存在 `$VIBEVALLEY_HOME/settings.json`（0600）。设置里的优先于环境变量，环境变量优先于 pi 的配置；每次用时现取。页面只看到每样从哪来和最后四个字，钥匙不出服务端、不进日志。

## 帮工

每个帮工是 smith（`server/pkg/smith`）的一个子 agent：并发上限 6（`protocol.MaxRunning`），帮工不能再派帮工。没有权限确认，靠工作目录、worktree 和只听本机圈住（[理由](../.agents/notes/implemented/architecture/2026-10-10-helpers-as-oar-subagents.md)）。档案决定农机、模型、人设、技能和环境变量（[agents-and-runtimes.md](agents-and-runtimes.md)）。

**农场的规矩**（`runs/rules.go`）：每次派活附上在哪个分支和 worktree、只改这个目录、不切分支不 push；做完一轮就提交；汇报写提交号和怎么验证的，最后一段以「结论：」开头；学到的写成「记住：」；加上工作目录的 `AGENTS.md`（有的话）。

**会话事件变成事实**在 `runs/facts.go`（纯函数）：一轮开始、在做什么（`doing`，气泡）、重试、花费、一轮结束。

**干活过程**（`runs/steps.go`）：每一步（收到的话、想、说、工具调用的输入和输出）记在 `steps/<id>.json`。带话时可以评论某一步（`on`），服务端把那一步写在话前面交给帮工。

**轨迹**（`runs/trajectories.go`；[理由](../.agents/notes/implemented/feature/2026-10-13-trajectories.md)）：每个帮工一条，派出去时开始，头文件（`steps/<id>.head.json`）记着是谁、为哪张工单、怎么关的，一直留着；步骤在帮工走了 `VIBEVALLEY_TRAJECTORY_DAYS` 天后删。管家一条，留最近 1000 步。帮工自己派的子 agent 的步骤挂在派它的那一步下面。

**工单**（`tickets/issues.go`、`tickets/dispatch.go`；[理由](../.agents/notes/implemented/architecture/2026-10-15-issue-is-one-thing.md)）：

- 存在 `issue` 和 `issue_run` 表；开着的和最近关的 50 家在核心状态里。
- 交给帮工的是标题，空一行，再是说明。
- **状态**由 `protocol.IssueStatusOf` 算：`todo`、`queued`、`working`、`waiting`、`closed`。
- 还没派的能改、能删、能排先后；派出去以后不能。
- **开工**时地都占满了就排队；服务端每 5 秒按先后试一遍。
- 帮工离开时，离开的是最后一次执行，工单就跟着关上。
- **重开**：同一个档案派一个新帮工到同一个项目，带上原来要做什么和上一次怎么关的。
- **子工单**：带 `parent`、`blockedBy`。种植计划用它，计划里的工单跟着计划走，看板不能单独开工、重开。

**汇报的摘要**取「结论：」那一段。失败按 smith 的分类说人话并说怎么办，要你处理的（登录、余额、额度、模型）另发一条提醒。

**没动静**：一轮里超过 `VIBEVALLEY_STALL_SECONDS`（默认 240 秒）没有任何记录，施加 `quiet`、提醒一次；一有动静就结束（[为什么](../.agents/notes/implemented/feature/2026-10-10-quiet-turns.md)）。

## 田头

农场的群聊（`chat/`；规则是 protocol 的 `chat.go`、`chat_rules.go`；[理由](../.agents/notes/implemented/feature/2026-10-11-farm-group-chat.md)）。

**对话**：频道，加上挂在频道消息下面的串。田头是默认频道，主人可以再开（名字 1～24 个字、数字、`_`、`-`），可以带默认项目。派活时管家在那个频道发一条派活消息，下面开工单串。地址写成 `#<频道>`、`#<频道>:<消息号>`。

**@ 名**：`@w3`、`@管家`、`@主人`、`@所有人`（只有主人能用）；代码里的不算。

**给谁、叫不叫醒**（`AudienceOf`）：

| 谁说的 | 叫醒谁 | 只让谁知道 |
|---|---|---|
| 主人在频道里 | 被 @ 的；没 @ 时是管家 | 频道里的帮工 |
| 主人在串里 | 被 @ 的、串里的帮工 | — |
| 管家或帮工 | 被 @ 的；在一个帮工的串里说话叫醒它 | — |
| 帮工的汇报 | 没做成时叫醒管家 | 做完时给管家 |

**刹车**：只管 agent 叫醒 agent。从主人上次说话算起，一个对话里最多 4 次（`HopLimit`）；同一个帮工被 agent 叫醒至少隔 60 秒；连着 3 次叫醒都在开口前失败就不再自动叫它，等主人亲自说。

**送达**：每条给帮工的消息走 未交付 → 提示过 → 已交付 → 看到了。歇着的帮工被叫醒时新一轮带着给它的消息；这一轮真的开口了才算看到，没开口就退回、过一会儿再叫。忙着的帮工攒几秒，插一句不带正文的提示（`BusyNotice`）。宁可重复给，不会丢。

**帮工的工具**（`chat/farmtools.go`，在 `/mcp` 上）：`farm_say`、`farm_read`、`farm_inbox`、`farm_who`。每个会话带一个自己的令牌（`runs/tokens.go`），只用来分清是谁在说话。`farm_say` 发出前会拦下：目标里有它没看过的新消息、读的是串却发到顶层、60 秒内重复同一句。

## 连接器：微信、飞书、QQ

主人可以在微信、飞书、QQ 里和农场说话，在「连接器」页（`/connectors`）连上（`channels/connectors.go`；三家的接口在 `server/pkg/weixin`、`feishu`、`qq`；[理由](../.agents/notes/implemented/feature/2026-10-11-channels-and-schedules.md)）。微信扫码，飞书扫码建一个个人机器人，QQ 填机器人的 AppID 和 AppSecret。

- **只往外连**：都是服务端连出去，不收 webhook。
- **只认主人**：微信扫码的人就是主人；飞书、QQ 连上后第一个私聊机器人发配对码的人是主人。别人的话丢掉，群里的不收。
- **接在一个频道**：默认田头。进来的话当作主人在这个频道说的；出去的是管家的回答、汇报、派活和 @主人 的话（protocol 的 `ForOwner`），转成纯文本，太长就切开。
- **发不出去的**留在发件表里，按指数退避重试；主人下次说话时先补发。
- 账号和密钥在数据库里，不进日志、不发给页面；断开就删掉。

## 院门

手机、另一台 Mac 和这台电脑用同一个农场（`channels/lan.go`；[理由](../.agents/notes/implemented/feature/2026-10-14-yard-gate.md)），在「院门」页（`/gate`）管。

- **另一个监听**：在所有网卡上听 `VIBEVALLEY_LAN_PORT`（默认 8790），默认关着。
- **只放这些**：`VibeValleyApi` 和两条流，不放 `/mcp`。每个请求要带 `Authorization: Bearer <钥匙>`；只有 `POST /api/lan/pair` 不要。院门自己的管理接口只在本机能用。
- **配对**：主人点「添加设备」，得到一个配对码（2 分钟有效，用一次就作废），画成 `vibevalley://pair?…` 的二维码。设备带码来要钥匙，等主人在本机点头。数据库只存钥匙的 SHA-256。
- **移除**一台设备或关上院门，它的连接当场断开。
- **明文**：院门走 HTTP，不加密，只在信得过的网络里开。

## 项目和收获

**项目**（`projects/projects.go`；[理由](../.agents/notes/implemented/architecture/2026-10-10-projects-worktrees-and-harvest.md)）：工作目录下的每个文件夹是一个项目。派到不存在的项目就新建（`git init -b main`、`.gitignore`、初始提交）。每个帮工在 `<工作目录>/.worktrees/` 下有自己的 worktree，分支 `vibevalley/<帮工>-<时间>`。同一个项目里改仓库的操作一个一个来。

**收成清单**（`GET /api/workers/{id}/changes`）：提交、改的文件和 diff、没提交的、主分支多了几个提交、会不会冲突（`git merge-tree`，不碰工作区）。

**收获**：

1. 还在干活的不收。
2. 关掉会话，没提交的改动替它提交（缓存和依赖目录不提交）。
3. 会冲突就不合并：标上 `conflict`；「让它解决冲突」发一句固定的话（`ConflictTask`），它下一轮结束时再查一次。
4. 合进主分支，删掉 worktree 和分支，帮工离开，账本记 `harvested`。

**收工和铲除**：关掉会话、帮工离开；分支上有没合的提交就留着，没有就删。

## 项目是一块地

`projects/codebase.go` 给项目页（[game-ui.md](game-ui.md) 界面 12；[理由](../.agents/notes/implemented/feature/2026-10-12-codebase-page.md)）：有哪些项目和能同时干活的帮工数（`slots`）；种了什么（tokei 现数，锁文件、压缩文件和依赖目录不算，没装 tokei 就说怎么装）；一年的提交（`git log --all --no-merges`，按天、按作者）。

## 记性

每个帮工档案一份记性（`memory/memory.go`；[理由](../.agents/notes/implemented/architecture/2026-10-11-agent-memory.md)），它派出去的帮工共用，跨项目、跨重启。一条记性是一句记下的话（帮工写的「记住：」，或主人替它写的），或一件做过的活。每个档案最多 300 条。

- **想起**：帮工新开一轮时，protocol 的 `Pick`（不调模型）挑出有关的几条（最多 8 条），以「【你记得的】」开头放在话前面。
- **记下**：汇报里「记住：」开头的行记成这个项目的，「记住（所有项目）：」记成所有项目的；差不多的不重复记。叫停的一轮不记。
- 读不出、写不进只记日志，不拦着那一轮。

## 账本

**农场账本**（`game/ledger.go`；[理由](../.agents/notes/implemented/feature/2026-10-11-achievements.md)）是 `ledger` 表：值得记的事，一条一行，按顺序。金币、连胜、成就和每个档案的战绩都由它折出来（protocol 的 `progress.go`），规则见 [game-ui.md](game-ui.md)「计分」。

- 账本自己看工地事件，用 protocol 的 `EntriesFor` 读出要记的（收获、没做成、冲突、派出、拆好计划、升级、带话……）；业务的服务不调它。只有主人在应用里做的几件事（语音接通、看收成清单、挂称号）在 HTTP 那一层记。
- 记一条就施加 `progress` 事实，带来金币或成就时带上 `news`。
- 启动时整本重折，所以规则改了重启就按新规则算。

## 种植计划

一件很长的活拆成几步，每步一个帮工，有先后（`tickets/playbooks.go`；规则是 protocol 的 `playbook.go`；[理由](../.agents/notes/implemented/feature/2026-10-11-playbooks.md)）。计划是带 `plan` 的父工单，每一步是带 `step` 的子工单（[理由](../.agents/notes/implemented/architecture/2026-10-15-plans-are-parent-issues.md)）；`PlaybookOf` 从工单拼回计划。计划的状态：`planning`、`draft`、`running`、`paused`、`ripe`、`done`、`abandoned`；每一步：`waiting`、`working`、`merged`、`failed`、`skipped`。

**拆**：派一个帮工只读代码，汇报的最后用一个 json 代码块给出计划。`ParsePlan` 校验（id 不重复、没有圈、最多 12 步、验收步骤有检查命令）；不合格让它重给一次，还不行计划放弃。

**改**：草稿什么都能改；开工以后只能改还没开始或没做成的步骤。

**开工**：从主分支开一条计划分支 `vibevalley/pb-<id>-<时间>`。要等的步骤都合进去了、在计划的并行数以内（默认 3），就派帮工；它的 worktree 从计划分支开出来，工单（`NodeTask`）带着目标、前面每一步的结论和要跑的检查。

**一步做完**：农场在它的 worktree 里跑检查，不信帮工自己说的；过了就合进计划分支（不动任何检出），删掉它的分支，帮工收工；没过就带着原因退回去。会冲突就让它解决。全部合进去或跳过后，计划熟了。

**验收**（[理由](../.agents/notes/proposed/architecture/2026-10-14-sample-then-verify.md)）：验收步骤只写现在会失败的测试，做完时检查要不通过。它改的文件对后面的步骤冻结；最后一步还要通过前面的验收。

**没做成**：一轮失败、检查没过、改了冻结的文件，农场自己让它重来，最多 2 次（`AutoRetries`）；再不行就停在 `failed`，等你重试、改工单或跳过，不相干的步骤照做。

**经过**（`tickets/playbook_log.go`）：计划每变一次记一行，带是谁做的，存在 `playbook_events` 表。

**收获**把计划分支合进主分支，先查冲突。**放弃**时正在做的帮工收工，分支都留着。计划里帮工的汇报不转给管家，只有拆好、某一步没做成、全部做完时计划告诉管家一句。

## 额度、花费和上限

[理由](../.agents/notes/implemented/feature/2026-10-10-quota-spend-and-limits.md)。

**额度**（`runs/runtimes.go`）：有套餐的农机读 smith 的账户用量；pi 读 DeepSeek 的余额。每 5 分钟读一次，一轮结束后再读一次。剩不到 15% 的，管家尽量换人。

**花费**：按 pi 的价目表（`runs/pi_prices.json`）把 token 折成人民币（估算），施加 `spent`；不在价目表里的只记 token。今天每台农机花了多少在 `spend.json`。

**派不出去**（protocol 的 `AgentIssues`）：档案停用、农机没装或停用、配置有错、余额用完、到了每日预算、套餐某个窗口用满。正在干的会干完。

**同时干活的上限**：农场 6（`protocol.MaxRunning`）；每台农机 `RuntimeSettings.maxWorking`；每个项目 `VIBEVALLEY_MAX_PER_PROJECT`（默认 3）。地都满了又来新活时，歇着的帮工里最早的那个先收工。

## 重启

[理由](../.agents/notes/implemented/architecture/2026-10-10-restart-keeps-the-farm.md)。

- 帮工回到各自的地上，会话先不打开；有人带话时按会话 id 接着原来的会话，接不上就在同一个 worktree 里新开。
- 重启时正在干的那一轮记成「停在了半路」，帮工歇着。worktree 不见了的不接回来。
- 种植计划跟着工单回来：正在拆的放弃，做到一半的暂停。
- 田头从数据库回来；已交付没看到的消息退回未交付。
- 金币、连胜、成就从账本重折。

## 搬家

- `vibevalley migrate`（`farm/oldnames.go`；[理由](../.agents/notes/implemented/process/2026-10-15-rename-to-vibevalley.md)）：把 heybro、vibefarm 这些旧名字下的家目录、日志、工作目录、分支名、环境变量和应用偏好搬到 vibevalley 下。先备份到 `~/vibevalley-migration-<时间>/`；`--dry-run` 只说会做什么；服务端开着时不做。
- `vibevalley import`（`farm/import.go`）：导入 TypeScript 服务端留下的家。它的 PGlite 数据库先用 `server/tool/dump-pglite.ts` 倒成 JSON，再导进 `farm.db`，id 和 seq 不变；目标已有农场时要 `--force`。倒出来的 JSON 里有密钥，用完删掉。
