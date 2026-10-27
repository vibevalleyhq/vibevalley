# 游戏

服务端的游戏是 `game` 模块（`Game`）加它自己的 `view.ts`、`play.ts`，和 `agent` 模块里的 `seed.ts`：一本只增不减的账本（`game_ledger` 表）折出金币、连胜、成就、称号和每个档案的战绩；工作目录里你名下的 commit 数折出等级；主人刚点的空地决定下一个帮工站哪块地；每个事实带出要放的特效。游戏只读事实、算画面和账本，业务的服务不用 `game`，也不因为它改变怎么干活。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 账本：哪些事实记一笔、一笔怎么折成金币、连胜、成就、称号、战绩 | 工单的状态、验收、收获本身（[工单](docs/subsystems/issue.md)）；计划怎么推进（[种植计划](docs/subsystems/task.md)） |
| 等级：commit 数怎么换成等级、什么时候放升级横幅 | 怎么数 commit（`project.Contributions`，[项目](docs/subsystems/project.md)「数 commit」） |
| 主人点的空地：下一个帮工挪过去 | 雇谁、派给谁（[管家](docs/subsystems/orchestrator.md)、[帮工](docs/subsystems/session.md)） |
| 特效：金币、升级、成就、没做成的惩罚 | 特效、庄稼、奖章怎么画，横幅和提示怎么放（[farm-ui.md](docs/reference/farm-ui.md)、[农场的皮](docs/subsystems/farm.md)） |
| 地块的样子（`FarmView`）和帮工在哪块地、做过什么（`SessionPlay`）的规则 | 地里长什么对应工单的哪一段（[工单](docs/subsystems/issue.md)「三段和状态」） |
| | 精力瓶：农机的额度（[帮工](docs/subsystems/session.md)，`quotaLow`）；手机里的小游戏（`apps/web/src/farm/phone`，[farm-ui.md](docs/reference/farm-ui.md)「农场手机」） |

## 在哪

- 服务端 `apps/server/src/game`（`Game`）：`game.ts` 账本的存取、订阅、`chooseTitle`、什么时候数 commit、主人点的空地；`progress.ts` 账本的折法（`progressStep`、`progressFold`）和哪些事实记账（`entriesFor`、`catchUp`），只有 `game` 读。
- 规则在 `apps/server/src/game`：`view.ts` 等级（`xpToNext`、`levelForCommits`、`farmLevelOf`、`levelUps`）、地块（`plotOfSession`、`plotOf`、`viewOf`）、特效（`effectsOf`）、`viewOf` 里每个成就到了第几档、计数、下一档要多少；`play.ts` 帮工的 `SessionPlay`（地块号、最近 30 步动作、工具次数、最近的文件和命令）、空地（`freeStation`、`withStations`）、`station` 事实的折法（`stationed`）；`progress.ts` 成就的说法（`achievementsInWords`：每档叫什么、到了叫什么、给多少金币、能不能当称号）。成就单在 `apps/server/src/agent/seeds.json` 的 `achievements`（`seed.ts` 的 `achievements`），页面不另拿一份。
- 核心状态里的游戏字段：`WorkspaceState.progress`、`commits`、`Session.play`；帧里的 `view`（地块、等级、每个成就的进度 `achievements`）和 `effects`。`progress` 只在账本里有，`state.json` 不存它。
- 表：`game_ledger`（`id` 是 UUIDv7，`kind`、`at`、其余字段放进 `payload` 的 JSON），查询在 `db/queries/game_ledger.sql`。
- 接口：`game.achievements`（成就的说法，页面的顺序）、`game.chooseTitle`（[capabilities.md](docs/reference/capabilities.md)）；点空地是 `channel.say` 带的 `station`。
- 页面：`apps/web/src/farm/panels/Achievements.tsx`（任务与成就页、奖章，读一次 `game.achievements` 的说法和帧里的进度）、`farm/panels/Panels.tsx`（仓库）、`farm/hud/FxLayer.tsx`（把特效画成飘字、横幅、提示上的奖章）、`farm/effects.ts`（页面自己放的特效）。

## 模型和不变量

- **奖结果，不奖消耗。** 金币、连胜和收成类的成就只认「收进主分支的活」：帮工离开（`left` 事实）时工单关成 `merged` 且合进去的提交数大于 0，记一条 `harvested`。一轮做完、命令数、读写次数、花的 token 不进任何规则。回报只有金币和称号，地块和派活的规则不看它们。
- **账本是唯一的家。** 一条一行、按 `id` 的顺序折；`Progress` 每次都是整本折出来的结果，不另存计数。开机整本重折，规则改了重启就按新规则算；`kind` 和 `payload` 合成一条后按 `LedgerEntry` 的 Schema 解码，折不回来的行（`kind` 不认识、解不开、形状不对或数值不是有限数）跳过。一次记一条（`ledger.mu`），表里的顺序就是折的顺序。
- **记不下来不挡农场。** 写库失败只记日志，那一条少了，农场照常。
- **记一条就施加一个 `progress` 事实**；这一条带来金币或到了某一档时带上 `news`（多少金币、给哪个帮工、到了哪几档）。账本自己施加的 `progress` 不再回到账本。
- **金币**：
  - 收进一件活：`round((30 + min(提交数 × 5, 30)) × 连胜倍率)`，倍率 `min(2, 1 + 0.1 × (连胜 − 1))`；取整是 JavaScript 的 `Math.round`，`1 + 0.1 × 7` 是 `1.7000000000000002`。
  - 收获一个种植计划（`graph` 条目）：`30 + 10 × 合进去的件数`。
  - 到一档成就：`seeds.json` 里每档的 `coins`（新手任务 20，计数的铜、银、金 10、30、60，彩蛋 50）；每档只给一次。
- **连胜**：每收进一件 +1，`bestStreak` 记最长；有帮工一轮没做成（`failed`）清零。`Progress.multiplier` 是现在的倍率。
- **成就**：计数在 `Progress.counts`，每档到了记一个 `Unlock`（成就、档、日期），按顺序各一次。各计数从哪来：

| 类 | 成就（计数） | 怎么涨 | 档位 |
|---|---|---|---|
| 新手任务 | 开门、派活、带话、验收、说话、规划、点名（`s_open`、`s_hire`、`s_tell`、`s_review`、`s_voice`、`s_split`、`s_call`） | 开工（`call` 变成 `live`）、派出帮工、给帮工带话、看过收成清单再收获、语音接通、拆好一张计划、在田头 @ 一个帮工 | 一次 |
| 收成 | 开张大吉 → 小有收成 → 粮仓满了（`harvests`） | 每收进一件 | 1 / 20 / 100 |
| | 一气呵成（`first_try`） | 收进的这件只跑了一轮（`Runs ≤ 1`），没被带过话、没失败过 | 1 / 10 / 50 |
| | 五谷丰登（`big_graph`） | 收获的计划里合进去的件数最多的一张 | 3 / 5 / 10 |
| | 小有规模 → 远近闻名 → 一方粮仓（`farm_level`） | 农场等级 | 5 / 10 / 20 |
| 手艺 | 稳如老农（`steady`） | 最长连胜 | 5 / 15 / 40 |
| | 解铃人（`untangle`） | 收进的这件冲突过 | 1 / 5 / 20 |
| | 浴火重生（`comeback`） | 收进的这件失败过 | 1 / 5 / 20 |
| 精打细算 | 一分钱一分货（`thrifty`） | 收进的这件知道花费且不到 ¥0.05（只报 token 的农机不算） | 1 / 10 / 50 |
| | 物尽其用（`every_machine`） | 收进过活的农机种数 | 2 / 3 / 5 |
| 协作 | 交接（`handoff`） | 帮工回了别的帮工点它的话 | 1 / 5 / 20 |
| | 运筹帷幄（`parallel_graph`） | 计划里同一层有两件以上合进去，算一次「同时做」 | 1 / 3 / 10 |
| 彩蛋 | 夜猫子、周末农夫（`night_owl`、`weekend`） | 收进的时间在服务端时区的 0–5 点、周六日 | 一次 |
| | 满园春色（`full_house`） | 在干活的帮工从不到 6 个变成 6 个，每填满一次一条 | 一次 |

- **称号**：只能挂拿到的档，新手任务的不能挂；别的取值（空的、没拿到的）都是摘掉称号。
- **战绩**：`hired`、`harvested`、`failed` 三种条目带档案，折成 `Progress.Agents`（雇过、收成、没做成）。
- **等级**：从 Lv.n 升到 Lv.n+1 要 `10n` 个 commit（`xpToNext`）；`farmLevelOf` 给出等级、这一级的经验和要多少。commit 数一样时 `commits` 事实不改状态。
- **升级横幅只给数出来的增长**：`levelUps` 每跨一级放一个 `levelUp`；农场第一次数出 commit 数（之前 `commits` 是空的）只定下等级，不放横幅，但账本照样记 `level`。开机时 `catchUp` 比较 commit 的等级和账本里的 `farm_level`，落下的补记一条。
- **仓库是交付 `merged` 或 `pull_request` 的工单**，一张一格（整个计划也是一格），最近收的在前；不另存，页面从 `WorkspaceState.issues` 读。
- **地块号**：`SessionPlay.station` 是 0–5（`maxRunning` 6），`-1` 是不在地里。新雇的帮工站第一块空着的地；已经有 `play` 的帮工再雇不换地；读回的 `state.json` 里没有地块的帮工由 `withStations` 补上。`station` 事实只挪到空着的地：帮工不在、已经在那块地、那块地有人、超出范围都不改状态。
- **特效是纯函数** `EffectsOf(折之前的状态, 事实)`：`commits` 给 `levelUp`；`progress` 的 `news` 给 `reward`（金币、帮工、连胜）和每档一个 `achievement`（带着这一档的说法：叫什么、到了叫什么、成就的介绍、金币、是不是一次性的）；一个已知帮工的 `report` 是 `failed` 给 `penalty`。
- **成就的说法**（`achievementsInWords`）：每档的称号是 `tierTitles` 里的，没有就是成就名，第二、三档前面加「银牌」「金牌」；到了一档叫「新手任务做完了」（新手任务）、「发现一个彩蛋」（彩蛋）、「升到金牌」「升到银牌」「解锁成就」；新手任务以外的都能当称号（`wearable`）。说法不进帧，页面读一次 `game.achievements`；每帧的 `view.achievements` 只有进度（成就、档、计数、下一档要多少，全到了就没有下一档），和说法一样按页面的顺序。

## 怎么走

**记账**（`ledger.OnStart`）：

1. 订阅 `core.Transitions()`，先对当时的状态跑 `catchUp`。
2. 每个事实连同折之前、折之后的状态交给 `entriesFor`，读出要记的条目：`report` 失败 → `failed`；`conflict` 有冲突 → `conflicted`；`call` 变成 `live` → `opened`；`hired` → `hired`；`issue` 的计划从 `splitting` 到 `draft` → `split`，到 `done` → `graph`；`left` 关成 `merged` 且有提交 → `harvested`；田头的新消息：主人在工单串里说的 → `told`，主人 @ 的帮工 → `called`，帮工回别人的 → `handoff`；`commits` 跨了级 → `level`；6 块地填满 → `busy6`。
3. 主人在应用里做的、不改状态的事由经手的服务说给 `core.Did`，账本订阅 `core.owner`（返回前就订上：开机后主人马上做的也不漏）记：主人看收成清单（`issue` 的 `changesFor`，管家看的不算）→ `reviewed`；语音接通（`voice.Start`）→ `voice`。挑称号由 HTTP 调 `Game.chooseTitle` 记 `titled`。
4. 每条写进 `game_ledger`，`progressStep` 折一步，施加 `progress` 事实；`Core.apply` 同时用 `effectsOf` 算出特效，和帧一起发。

**数 commit**（`commits`）：开机就绪后数一次，之后每 2 分钟一次；每个 `report` 事实（一轮结束）后 15 秒再数一次，几轮共用一次。数和写回由 `counting` 锁成一次一个，旧的数不会盖掉新的；停机以后数完的不写。结果经 `Core.setCommits` 施加 `commits` 事实。

**点空地**（`game.ts`）：主人点一块空地再说话，`channel.say` 带上这块地的 `station`，`Game.want` 记下这块地 10 秒。这期间雇的第一个帮工先由 `hired` 站到第一块空地，`game` 听到 `hired` 再施加 `station` 把它挪过去；地已有人就不挪。记下的地用一次就清掉，不管挪没挪成。两个事实相隔不到 200 毫秒，通常在同一帧里。

## 和谁打交道

- **核心状态（`core`）**：游戏只经 `core.Facts()`、`core.Transitions()`、`core.owner` 听，经 `Core.apply` 施加 `progress`、`station`、`commits`。
- **项目（`project`）**：`commits` 调 `project.Contributions`，带上配置的 `git_emails`。
- **工单（`issue`）、语音（`voice`）**：只经 `core.Did` 说主人做了什么，不 import `game`。
- **HTTP（`handler`）**：只为游戏自己的事调 `Game`：`game.achievements`、`game.chooseTitle`、`channel.say` 的 `station`。
- **页面**：读 `game.achievements`、`progress`、`view`、`effects`，不折、不另存，也不照成就单算档和进度；调试台只能放一遍横幅和提示（说法取自 `game.achievements`），改不了金币、等级和成就。

## 为什么这样

- **奖结果，不奖消耗。** 按命令数、读写次数、token 给奖等于奖励多花钱，和「管住花费」相反；按「一轮做完」给，活最后有没有收进主分支都一样。经验同理：按完成的工单算奖的是忙，失败重试也能刷。
- **一本账本，在服务端，折出结果。** 在页面里算，页面关着时的事漏掉，几个客户端各算一份互相覆盖。直接存计数最简单，但规则一改旧数就对不上，也说不清某一档是哪天、因为哪件活拿到的；账本按顺序折，结果总能重算，还带着每档的日期。
- **哪些事实记账是一个纯函数 `entriesFor`，游戏只听事实。** 写在各个业务里记，业务就认识了游戏；收获、带话、点名、交接都从帮工离开和田头消息的事实里读出来。只有主人做的、不改状态的事从 `core.Did` 来，经手的服务说一声，不管从哪个入口进来都记得到。
- **服务收在 `game` 一个包。** 名字只叫 `ledger` 时，它装的其实是全部游戏；`game` 也是主人和概念里的词。地块、特效这类拼帧要用的规则放在 `game` 自己的文件里，折法和拼帧那层（`projection`）import 它们；账本的折法只有 `game` 读，所以在 `game/progress.ts`。
- **核心状态不替游戏做决定。** 主人点的地要经过管家（模型）才雇到帮工，中间隔着一句话和 10 秒；把地块一路带过管家和派活（`hired` 带地块），业务就认识了游戏。所以 `game` 听到 `hired` 再施加 `station`，代价是分在两帧时页面上帮工挪一下。
- **特效在 `Core.apply` 里算，不搬进 `game`。** `effectsOf` 要折之前的状态：`game` 要么自己存一份，违反核心状态只有一份；要么等事件发出再算，特效晚一帧。`Core` 只跑一个纯函数，不做游戏的决定。
- **经验只算工作目录里你名下的 commit。** 算这台机器上所有仓库会把和 VibeValley 无关的工作算进来，算所有作者会把别人的提交算成你的；代价是要定期扫目录、跑 git。
- **仓库装收获了的工单，不装每一轮的汇报。** 汇报在看板、干活过程、工单串里都有；收获需要一个看得见的去处，看板的「已关」里还有没收就收工的。读工单，不另存。
- **称号不挂新手任务**：「开门」「派活」挂在农场卡上没有意思。奖章是框加图案叠起来，不为每档画一张（21 个成就 × 3 档）。
- **成就的说法和进度由服务端给，页面不照成就单算。** 说法（约 5KB）每帧都带太浪费，帧每个事实都出，所以拆成两半：说法是一次性的接口 `game.achievements`，进度（约 1KB）跟着 `view` 每帧走，特效自己带着说法，通知和提示不用等接口。页面不照成就单算档和进度：「连接到本机」的设备和那台电脑的服务端版本不一样时，门槛会和服务端的账本对不上。

## 还没做的

- 商店和每日任务，让金币有用处：[提案](.agents/notes/proposed/feature/2026-10-09-shop-and-daily-tasks.md)。
- 每个动作至少播完一小段，不让气泡和姿势闪：[提案](.agents/notes/proposed/feature/2026-10-09-action-queue.md)。

## 怎么验证

- `apps/server/src/game/progress.test.ts`：账本逐步折和整本折照黄金数据（`testdata/rules.jsonl.gz`）付钱、解锁；收获按提交数和连胜付钱。
- `game/game.test.ts`：账本能折回进度（重启后同样、不重复补记等级）；主人看收成和打电话记账；一个帮工的 commit 每个仓库只数一次；启动统计和一轮结束后的统计按两种完成顺序串行写回，旧结果不覆盖新结果；下一个帮工站到主人点的空地。
- `apps/server/src/core/golden.test.ts`：等级、地块、特效、成就的说法和进度、空地（`play.jsonl.gz`、`rules.jsonl.gz`）。
- 页面：`apps/web/test/farm-hud.spec.ts`（任务与成就、仓库）、`voice.spec.ts`（调试台放升级的横幅）。
