# 游戏

服务端的游戏是 `game` 包（`Workspace` 上的 `Game`）加 protocol 里带 `game_` 的三个文件：一本只增不减的账本（`game_ledger` 表）折出金币、连胜、成就、称号和每个档案的战绩；工作目录里你名下的 commit 数折出等级；主人刚点的空地决定下一个帮工站哪块地；每个事实带出要放的特效。游戏只读事实、算画面和账本，业务的服务不 import `game`，也不因为它改变怎么干活。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 账本：哪些事实记一笔、一笔怎么折成金币、连胜、成就、称号、战绩 | 工单的状态、验收、收获本身（[工单](docs/subsystems/issue.md)）；计划怎么推进（[种植计划](docs/subsystems/task.md)） |
| 等级：commit 数怎么换成等级、什么时候放升级横幅 | 怎么数 commit（`project.Contributions`，[项目](docs/subsystems/project.md)「数 commit」） |
| 主人点的空地：下一个帮工挪过去 | 雇谁、派给谁（[管家](docs/subsystems/manager.md)、[帮工](docs/subsystems/session.md)） |
| 特效：金币、升级、成就、没做成的惩罚 | 特效、庄稼、奖章怎么画，横幅和提示怎么放（[farm-ui.md](docs/reference/farm-ui.md)、[pixel-village.md](docs/reference/pixel-village.md)） |
| 地块的样子（`FarmView`）和帮工在哪块地、做过什么（`SessionPlay`）的规则 | 地里长什么对应工单的哪一段（[工单](docs/subsystems/issue.md)「三段和状态」） |
| | 精力瓶：农机的额度（[帮工](docs/subsystems/session.md)，`protocol.QuotaLow`）；手机里的小游戏（客户端 `lib/phone/`，[farm-ui.md](docs/reference/farm-ui.md)「农场手机」） |

## 在哪

- 服务端 `server/internal/game`（`game.Service`，嵌入三个零件）：`ledger.go` 账本的存取、订阅和 `ChooseTitle`；`progress.go` 账本的折法（`progressStep`、`progressFold`）和哪些事实记账（`entriesFor`、`catchUp`），只有 `game` 读，不导出；`commits.go` 什么时候数 commit；`beds.go` 主人点的空地。
- 规则在 protocol：`game_view.go` 等级（`XPToNext`、`LevelForCommits`、`FarmLevelOf`、`LevelUps`）、地块（`PlotOfSession`、`PlotOf`、`PlotKey`、`ViewOf`）、特效（`EffectsOf`）；`game_play.go` 帮工的 `SessionPlay`（地块号、最近 30 步动作、工具次数、最近的文件和命令）、空地（`FreeStation`、`WithStations`）、`FactStation` 的折法；`game_achievement.go` 成就的说法（`AchievementsInWords`：每档叫什么、到了叫什么、给多少金币、能不能当称号）和进度（`ViewOf` 里每个成就到了第几档、计数、下一档要多少）。成就单在 `seeds.json` 的 `achievements`（`protocol.Achievements`），客户端不带它的副本。
- 核心状态里的游戏字段：`CoreState.Progress`、`Commits`、`Session.Play`；帧里的 `view`（地块、等级、每个成就的进度 `achievements`）和 `effects`。`Progress` 只在账本里有，`state.json` 不存它。
- 表：`game_ledger`（`id` 是 UUIDv7，`kind`、`at`、其余字段放进 `payload` 的 JSON），查询在 `pkg/db/queries/game_ledger.sql`。
- 接口：`game.achievements`（成就的说法，页面的顺序）、`game.chooseTitle`（[capabilities.md](docs/reference/capabilities.md)）；点空地是 `channel.say` 带的 `station`。
- 客户端：`data/remote.dart` 的 `achievementsProvider`（连上一个服务端读一次 `game.achievements`）、`rules/warehouse.dart`（仓库）、`game/effects.dart`（把特效变成飘字、横幅、提示）、`farm/achievements.dart`（任务与成就页、奖章，只显示说法和帧里的进度）。

## 模型和不变量

- **奖结果，不奖消耗。** 金币、连胜和收成类的成就只认「收进主分支的活」：帮工离开（`FactLeft`）时工单关成 `merged` 且合进去的提交数 `Merged > 0`，记一条 `harvested`。一轮做完、命令数、读写次数、花的 token 不进任何规则。回报只有金币和称号，地块和派活的规则不看它们。
- **账本是唯一的家。** 一条一行、按 `id` 的顺序折；`Progress` 每次都是整本折出来的结果，不另存计数。开机整本重折，规则改了重启就按新规则算；折不回来的行（`kind` 不认识、解不开）跳过。一次记一条（`ledger.mu`），表里的顺序就是折的顺序。
- **记不下来不挡农场。** 写库失败只记日志，那一条少了，农场照常。
- **记一条就施加一个 `progress` 事实**；这一条带来金币或到了某一档时带上 `news`（多少金币、给哪个帮工、到了哪几档）。账本自己施加的 `progress` 不再回到账本。
- **金币**：
  - 收进一件活：`round((30 + min(提交数 × 5, 30)) × 连胜倍率)`，倍率 `min(2, 1 + 0.1 × (连胜 − 1))`；取整照 JavaScript 的 `Math.round`，倍率的乘法避开 arm64 的 FMA，让 `1 + 0.1 × 7` 和 JavaScript 一样是 `1.7000000000000002`。
  - 收获一个种植计划（`graph` 条目）：`30 + 10 × 合进去的件数`。
  - 到一档成就：`seeds.json` 里每档的 `coins`（新手任务 20，计数的铜、银、金 10、30、60，彩蛋 50）；每档只给一次。
- **连胜**：每收进一件 +1，`bestStreak` 记最长；有帮工一轮没做成（`failed`）清零。`Progress.Multiplier` 是现在的倍率。
- **成就**：计数在 `Progress.Counts`，每档到了记一个 `Unlock`（成就、档、日期），按顺序各一次。各计数从哪来：

  | 计数 | 怎么涨 |
  |---|---|
  | `harvests` | 每收进一件 |
  | `first_try` | 收进的这件只跑了一轮（`Runs ≤ 1`），没被带过话、没失败过 |
  | `untangle`、`comeback` | 收进的这件冲突过、失败过 |
  | `thrifty` | 收进的这件知道花费且不到 ¥0.05（只报 token 的农机不算） |
  | `every_machine` | 收进过活的农机种数 |
  | `steady` | 最长连胜 |
  | `big_graph`、`parallel_graph` | 收获的计划里合进去的件数取最大；计划里同一层有两件以上合进去，算一次「同时做」 |
  | `handoff` | 帮工回了别的帮工点它的话 |
  | `farm_level` | 农场等级 |
  | `night_owl`、`weekend` | 收进的时间在服务端时区的 0–5 点、周六日 |
  | `full_house` | 在干活的帮工从不到 6 个变成 6 个，每填满一次一条 |
  | 新手任务 `s_open`、`s_hire`、`s_tell`、`s_review`、`s_voice`、`s_split`、`s_call` | 开工（`call` 变成 `live`）、派出帮工、给帮工带话、看过收成清单再收获、语音接通、拆好一张计划、在田头 @ 一个帮工 |

- **称号**：只能挂拿到的档，新手任务的不能挂；别的取值（空的、没拿到的）都是摘掉称号。
- **战绩**：`hired`、`harvested`、`failed` 三种条目带档案，折成 `Progress.Agents`（雇过、收成、没做成）。
- **等级**：从 Lv.n 升到 Lv.n+1 要 `10n` 个 commit（`XPToNext`）；`FarmLevel` 给出等级、这一级的经验和要多少。commit 数一样时 `FactCommits` 不改状态。
- **升级横幅只给数出来的增长**：`LevelUps` 每跨一级放一个 `levelUp`；农场第一次数出 commit 数（之前 `Commits` 是空的）只定下等级，不放横幅，但账本照样记 `level`。开机时 `catchUp` 比较 commit 的等级和账本里的 `farm_level`，落下的补记一条。
- **仓库是关成 `merged` 的工单**，一张一格（整个计划也是一格），最近收的在前；不另存，客户端从 `CoreState.Issues` 读。
- **地块号**：`SessionPlay.Station` 是 0–5（`MaxRunning` 6），`-1` 是不在地里。新雇的帮工站第一块空着的地；已经有 `Play` 的帮工再雇不换地；读回的 `state.json` 里没有地块的帮工由 `WithStations` 补上。`FactStation` 只挪到空着的地：帮工不在、已经在那块地、那块地有人、超出范围都不改状态。
- **特效是纯函数** `EffectsOf(折之前的状态, 事实)`：`commits` 给 `levelUp`；`progress` 的 `news` 给 `reward`（金币、帮工、连胜）和每档一个 `achievement`（带着这一档的说法：叫什么、到了叫什么、成就的介绍、金币、是不是一次性的）；一个已知帮工的 `report` 是 `failed` 给 `penalty`。
- **成就的说法**（`AchievementsInWords`）：每档的称号是 `tierTitles` 里的，没有就是成就名，第二、三档前面加「银牌」「金牌」；到了一档叫「新手任务做完了」（新手任务）、「发现一个彩蛋」（彩蛋）、「升到金牌」「升到银牌」「解锁成就」；新手任务以外的都能当称号（`wearable`）。说法不进帧，客户端读一次 `game.achievements`；每帧的 `view.achievements` 只有进度（成就、档、计数、下一档要多少，全到了就没有下一档），和说法一样按页面的顺序。

## 怎么走

**记账**（`ledger.OnStart`）：

1. 订阅 `core.Transitions()`，先对当时的状态跑 `catchUp`。
2. 每个事实连同折之前、折之后的状态交给 `entriesFor`，读出要记的条目：`report` 失败 → `failed`；`conflict` 有冲突 → `conflicted`；`call` 变成 `live` → `opened`；`hired` → `hired`；`issue` 的计划从 `splitting` 到 `draft` → `split`，到 `done` → `graph`；`left` 关成 `merged` 且有提交 → `harvested`；田头的新消息：主人在工单串里说的 → `told`，主人 @ 的帮工 → `called`，帮工回别人的 → `handoff`（流式更新的同一条消息只算一次）；`commits` 跨了级 → `level`；6 块地填满 → `busy6`。
3. 主人在应用里做的、不改状态的事由经手的服务说给 `core.Did`，账本订阅 `core.OwnerDids` 记：主人看收成清单（`issue` 的 `changesFor`，管家看的不算）→ `reviewed`；语音接通（`voice.Start`）→ `voice`。挑称号由 HTTP 调 `Game.ChooseTitle` 记 `titled`。
4. 每条写进 `game_ledger`，`progressStep` 折一步，施加 `progress` 事实；`Core.Apply` 同时用 `EffectsOf` 算出特效，和帧一起发。

**数 commit**（`commits`）：开机就绪后数一次，之后每 2 分钟一次；每个 `report` 事实（一轮结束）后 15 秒再数一次，几轮共用一次。数和写回由 `counting` 锁成一次一个，旧的数不会盖掉新的；停机以后数完的不写。结果经 `Core.SetCommits` 施加 `commits` 事实。

**点空地**（`stations.go`）：主人点一块空地再说话，`channel.say` 带上这块地的 `station`，`Game.Want` 记下这块地 10 秒。这期间雇的第一个帮工先由 `FactHired` 站到第一块空地，`stations` 听到 `hired` 再施加 `FactStation` 把它挪过去；地已有人就不挪。记下的地用一次就清掉，不管挪没挪成。两个事实相隔不到 200 毫秒，通常在同一帧里。

## 和谁打交道

- **核心状态（`core`）**：游戏只经 `core.Facts()`、`core.Transitions()`、`core.OwnerDids()` 听，经 `Core.Apply` 施加 `progress`、`station`、`commits`。
- **项目（`project`）**：`commits` 调 `project.Contributions`，带上配置的 `git_emails`。
- **工单（`issue`）、语音（`voice`）**：只经 `core.Did` 说主人做了什么，不 import `game`。
- **HTTP（`handler`）**：只为游戏自己的事调 `Game`：`game.achievements`、`game.chooseTitle`、`channel.say` 的 `station`。
- **客户端**：读 `game.achievements`、`progress`、`view`、`effects`，不折、不另存，也不照成就单算档和进度；调试台只能放一遍横幅和提示（说法取自 `game.achievements`），改不了金币、等级和成就。

## 为什么这样

- **奖结果，不奖消耗。** 按命令数、读写次数、token 给奖等于奖励多花钱，和「管住花费」相反；按「一轮做完」给，活最后有没有收进主分支都一样。经验同理：按完成的工单算奖的是忙，失败重试也能刷。
- **一本账本，在服务端，折出结果。** 在页面里算，页面关着时的事漏掉，几个客户端各算一份互相覆盖。直接存计数最简单，但规则一改旧数就对不上，也说不清某一档是哪天、因为哪件活拿到的；账本按顺序折，结果总能重算，还带着每档的日期。
- **哪些事实记账是一个纯函数 `entriesFor`，游戏只听事实。** 写在各个业务里记，业务就认识了游戏；收获、带话、点名、交接都从帮工离开和田头消息的事实里读出来。只有主人做的、不改状态的事从 `core.Did` 来，经手的服务说一声，不管从哪个入口进来都记得到。
- **服务收在 `game` 一个包。** 名字只叫 `ledger` 时，它装的其实是全部游戏；`game` 也是主人和概念里的词。规则留在 protocol、文件名带 `game_`，没拆成 `protocol/game` 子包：shapegen、黄金数据和 Flutter 的生成都按 `protocol` 一个包来，游戏的形状和事实、帧在同一个联合里，拆开要倒转依赖。账本的折法只有 `game` 读，所以在 `game/progress.go` 不导出。
- **核心状态不替游戏做决定。** 主人点的地要经过管家（模型）才雇到帮工，中间隔着一句话和 10 秒；把地块一路带过管家和派活（`FactHired` 带地块），业务就认识了游戏。所以 `stations` 听到 `hired` 再施加 `station`，代价是分在两帧时客户端看到帮工挪一下。
- **特效在 `Core.Apply` 里算，不搬进 `game`。** `EffectsOf` 要折之前的状态：`game` 要么自己存一份，违反核心状态只有一份；要么等事件发出再算，特效晚一帧。`Core` 只跑一个纯函数，不做游戏的决定。
- **经验只算工作目录里你名下的 commit。** 算这台机器上所有仓库会把和 VibeValley 无关的工作算进来，算所有作者会把别人的提交算成你的；代价是要定期扫目录、跑 git。
- **仓库装收获了的工单，不装每一轮的汇报。** 汇报在看板、干活过程、工单串里都有；收获需要一个看得见的去处，看板的「已关」里还有没收就收工的。读工单，不另存。
- **称号不挂新手任务**：「开门」「派活」挂在农场卡上没有意思。奖章是框加图案叠起来，不为每档画一张（21 个成就 × 3 档）。
- **成就的说法和进度由服务端给，客户端不带成就单。** 原来 `shapegen` 把成就单写进 `lib/gen`，进度在客户端的规则里照它现算：「连接到本机」的手机和那台电脑的服务端版本不一样时，门槛和服务端的账本对不上，算档的规则也在 Dart 里多了一份。说法（约 5KB）每帧都带太浪费，帧每个事实都出，所以拆成两半：说法是一次性的接口 `game.achievements`，进度（约 1KB）跟着 `view` 每帧走，特效自己带着说法，通知和提示不用等接口。放弃了整份种子给一个 `GET /api/v1/seeds`：客户端拿到还要自己拼进度和称号，规则又回到 Dart。

## 还没做的

- 商店和每日任务，让金币有用处：[提案](.agents/notes/proposed/feature/2026-10-09-shop-and-daily-tasks.md)。
- 每个动作至少播完一小段，不让气泡和姿势闪：[提案](.agents/notes/proposed/feature/2026-10-09-action-queue.md)。

## 怎么验证

- `game/progress_test.go`：`TestLevels`、`TestHarvestPays`（金币和连胜加成）、`TestFailedEndsStreak`、`TestFirstTry`、`TestConflictsCheapRuntimes`（解铃人、浴火重生、一分钱一分货、物尽其用）、`TestStarterTasks`、`TestTaskHarvested`、`TestTiersInOrder`、`TestSecrets`、`TestTitles`、`TestAgentRecords`；`entriesFor` 的 `TestEntriesForFacts`、`TestEntriesFromLeavingAndMessages`、`TestEntriesWithAgent`、`TestEntriesTasksLevelsBeds`（计划只记一次、跨级、六块地填满）；`TestCatchUp`；`TestStreakIsJavaScriptsNumber`。
- `game/rules_golden_test.go` 的 `TestRulesGolden`：账本逐步折和整本折一致，`entriesFor`、`catchUp` 对 `testdata/rules.jsonl.gz` 逐条比。
- `game/ledger_test.go`：`TestLedger`（记一笔收获带着金币的 `news`；派出、没做成、升级由事实记下；重启后折回同样的进度、不重复补记等级）、`TestTheOwnersReviewAndCallAreCounted`。
- `game/stations_test.go` 的 `TestTheNextSessionTakesThePlantedStation`；`game/commits_test.go` 的 `TestSessionsCommitsCountedOncePerRepository`。
- protocol：`game_achievement_test.go` 的 `TestAchievementsInWords`（称号、到了叫什么、金币、能不能挂）、`TestTheViewSaysHowFarEachAchievementIs`（档、计数、下一档，全到了没有下一档）、`TestAnAchievementsEffectSaysIt`；`game_play_rules_test.go` 的 `TestStationOnlyToAFreeBed`、`TestPlotsAreKeyedByTheirIssue`、`TestAPlotShowsItsIssuesAcceptance`；`play_golden_test.go` 的 `TestPlayRulesGolden`；`reduce_golden_test.go` 的 `TestReduceGolden`（特效和升级逐条比）。
- `workspace/work_test.go` 的 `TestMergeGoesInTheLedger`：扮演的帮工收获后账本里有这一笔。
- `handler/api_test.go` 的 `TestAchievementsComeInWordsAndTheFrameSaysHowFar`。
- 客户端：`test/host/notify_test.dart`（到一档弹通知，用特效带的说法）、`test/game/fx_test.dart`（提示的称号、介绍、金币、到了叫什么）、`test/farm/panels_test.dart`（仓库是收获了的工单；任务与成就页用 `game.achievements` 的说法和帧里的进度，挑称号）。
