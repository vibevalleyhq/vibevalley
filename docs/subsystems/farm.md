# 农场的皮

农场是 Flutter 客户端从服务端折好的 `StateFrame` 画出来的一座像素小院：工单是地，帮工是地上的小动物，照手上的事走去书屋、工坊、电台，庄稼按这一轮的进度长；项目是地图上的岛，要你处理的事是左下角手机的来电。皮只读核心状态，自己只加跟着时钟走的东西（走动、姿势、光、院子的动静、音效），不存帮工的任何状态，也不决定能不能做一件事。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 像素村：384×256 的格子、放大和裁边、LDtk 地图、寻路、光、院子的动静 | 地的样子（庄稼和牌子）怎么算：服务端的 `protocol.PlotOf`，[工单](docs/subsystems/issue.md)；金币、连胜、成就和账本（[游戏](docs/subsystems/game.md)） |
| 帮工走去哪、什么姿势、在哪块地上 | 帮工的阶段和在做什么（[帮工](docs/subsystems/session.md)） |
| 快捷栏的农具：点一块地做什么、用不上时说为什么 | 农具调的接口背后的规则（`issue.status`、`issue.comment`，[工单](docs/subsystems/issue.md)） |
| 地图：每个项目一座岛，地是它的 worktree 和空位 | 项目的上限、worktree（[项目](docs/subsystems/project.md)） |
| 农场手机：来电响铃、接听去哪、通话记录、小游戏 | 哪些事算来电（Inbox，[田头](docs/subsystems/channel.md)） |
| 本机和手机的系统通知怎么弹 | 通知送到 App 关着的手机上（连接器，[田头](docs/subsystems/channel.md)） |
| 合成音效、图鉴 | 首页（[pixel-village.md](docs/reference/pixel-village.md)「首页」） |
| 素材怎么读进客户端（`sprites.json`、密度） | 生图和切图的流水线：`design/`（[pixel-village.md](docs/reference/pixel-village.md)「素材」） |
| | 客户端的分层、谁能 import 谁（[客户端](docs/subsystems/app.md)）；每个界面的清单（[farm-ui.md](docs/reference/farm-ui.md)「界面清单」） |

## 在哪

- **像素村** `app/lib/village/`（Flame）：`game.dart` 每帧把核心状态画成画面、按脚底的 y 排前后；`world.dart` 给 LDtk 里的位置起名、算帮工去哪（`goalOf`、`Whereabouts`、`spotsFor`、`poseOf`、`placeOfAction`）和能走的地方（`walkable`）；`level.dart` 读 `app/assets/village.ldtk`；`nav.dart` 寻路（`NavMap`、`Walker`）；`framing.dart` 放大和裁边（`frameVillage`）；`hud.dart` 按屏幕像素画的字和 HUD；`hits.dart` 点到了什么；`sky.dart`、`normals.dart`、`pass.dart` 光；`life.dart`、`critters.dart`、`dog.dart`、`particles.dart`、`bursts.dart` 院子的动静和一闪而过的效果。
- **农场页** `app/lib/farm/`：`farm_page.dart` 摆像素村和 HUD，`cursors.dart` 画在画面上的工具指针，`panels.dart` 院子里的东西打开的面板。
- **农具和去处** `app/lib/game/`：`tools.dart` 的 `Tool`、`aimTool`（指着一块地时说点下去做什么）、`toolForKey`；`commands.dart` 把点击变成接口调用；`destinations.dart` 的 `YardPlace` 是院子里每样东西打开哪个面板或页面。地有哪几块在 `app/lib/rules/beds.dart` 的 `beds`。
- **素材** `app/lib/sprites/atlas.dart` 读 `app/assets/pixel/sprites.json`；指针在 `app/assets/cursors/`，字体 Fusion Pixel 12px 在 `app/assets/fonts/`。
- **音效** `app/lib/audio/`：`sfx.dart` 的配方和分组（`soundGroups`），`synth.dart` 合成器；`app/lib/shared/farm_sounds.dart` 从状态里响。
- **手机** `app/lib/phone/`：`phone.dart` 机身，`calls.dart` 来电和记录（`phoneProvider`），`screens.dart` 主屏；小游戏的规则是纯函数（`blocks.dart`、`dino.dart`、`sokoban.dart`、`bug_snake.dart`、`merge.dart`），画面是 `*_game.dart`。
- **通知** `app/lib/host/notify.dart`（规则：`noticeForCall`、`noticeForEffect`、`noticeForEvent`、`CallBell`），`app/lib/host/mobile_notices.dart`（iOS、Android 的本地通知）。
- **地图** `app/lib/workbench/map/`：`map_rules.dart`（纯函数，`islandsOf`、`islandLooks`），`map_page.dart`；挂在工作台「项目」页（`/projects` 的「全部」，选一个项目是它的岛）。
- **图鉴** `app/lib/workbench/catalog/`（`/catalog`）：`catalog_data.dart` 的 `shelves`、`framesOf`、`remakeOf`。

服务端这边只有两样给皮的东西：`StateFrame.view`（`FarmView`，`protocol.ViewOf`）和 `StateFrame.inbox`（`protocol.Inbox`）；地图另读项目列表里的 `ProjectSummary.maxSessions`。

## 模型和不变量

- **皮里没有第二份状态。** 地、帮工、来电都从这一帧的 `StateFrame` 读；客户端自己记的只有画面和这次打开的东西：小动物走到哪、`Whereabouts`、接过哪个来电、小游戏的棋盘。重开应用这些都从头来。
- **一块地是一张工单。** 帮工的地按 `PlotKey` 查 `FarmView.Plots`：挂了工单的按工单号，没挂的按帮工自己。它画在哪块地上看帮工的 `play.station`（0–5）；`beds` 有 9 块：6 块是同时在做的 6 张工单（`MaxRunning`），另 3 块在 Lv.5、8、12 开垦成花坛，只是外观。没开垦的画成锁住的地。
- **庄稼和牌子是服务端算好的**（`PlotOfSession`，交回来以后再看工单，`PlotOf`）。在干活的帮工：

  | 帮工 | 庄稼（`Crop`） | 牌子 |
  |---|---|---|
  | 到场 | 刚播种 `seeded` | |
  | 干活，这一轮还没改文件 | 发芽 `sprout` | |
  | 这一轮改过文件 | 长叶 `leafy` | |
  | 改过文件后跑了命令 | 开花 `flowering` | |
  | 很久没动静 | 干裂 `dry` | 没动静 |
  | 模型调用在重试 | 照常长 | 重试中 |
  | 做完 | 麦子或胡萝卜（按帮工 id 固定一种） | 可收获，或有冲突 |
  | 失败 | 枯萎 `withered` | 有虫 |
  | 歇着 | 停在当时的样子 | 歇着，或有冲突 |

  交回来（做完或歇着）以后按先后看工单：帮工问了你还没回答是干裂、「缺肥」；验收过了是麦子或胡萝卜、「可收获」；没过验收、草还在是杂草、「N 棵草」（帮工修的时候是「除草中 N」）；交回来还没验收是开花、「等验收」。有冲突时一律照帮工那一张。帮工离开后，那块地在客户端画 3.6 秒麦茬（`harvested`），然后是空地；这是画面，不在 `FarmView` 里。
- **帮工去哪是一条规则**（`world.dart`），画面只管坐标：
  - 手上的事决定去处（`placeOfAction`）：读、搜去书屋，跑命令和 MCP 去工坊，查网页去电台，等着坐长椅，改文件和别的在自己的地边。
  - 换去处要节流（`Whereabouts`）：想去新地方够 1.2 秒、在原地待够 2 秒才动身；地熟了、枯萎、干裂（`plotCalls`）时马上回到地前面、面朝外。
  - 在地边时隔一阵换个位置（`spotsFor`、`Stroll`）：干活时每 5–11 秒，别的时候 7–15 秒；改文件、跑命令时进地里，歇着时可能去草坪；同一个地点人多了往两边排开。
  - 姿势（`poseOf`）：熟了「欢呼」，枯萎或干裂「发愁」，改文件、跑命令、MCP 是「干活」，读、搜这些是「琢磨」，没在做事是站着。
  - 地都占满时（`station` 为 -1）帮工在院门外排队；不在场的从大门进来。
- **世界坐标只有一套：384×256 个像素格。** 素材画成两倍密，`atlas.dart` 用地图图片的宽除以 384 得出密度，把 `sprites.json` 里的宽高和落脚点都除以它；关卡、点击区、HUD 的坐标都按格子写，不随密度改。
- **放大只用整数倍**（`frameVillage`）：从能盖满窗口的倍数往下找，第一个满足「左右每边裁掉不超过村子宽度的 5%（`villageCutAcross`），上下每边不超过高度的 8%（`villageCutDown`）」的就用。1152×768 正好放下；1440×900 放大 4 倍、左右各裁 48、上下各裁 62 屏幕像素；1920×1080 放大 5 倍、只裁上下；竖着的手机放大 1 倍。盖不满的地方留边，边上垫一张放大、压暗的农场。最外一圈至多左右各 19 格、上下各 20 格可能看不到，能点的东西应放在这圈里面。
- **HUD 和字按屏幕像素画**（`hud.dart`），任何缩放下都清楚，贴着农场在窗口里露出来的那一块的边；字号只用 12 和 24。
- **地图数据在 LDtk**：Ground 层标能走的地方；Things 层是地块、帮工去的地点（`Place`）、道具、灯、大门、排队处、管家和狗。地块和道具的底由游戏从 Ground 里扣掉（`walkable`），因为它们会动。
- **寻路**（`NavMap`）：能走的地方铺成格子（像素村用 2 格一个），靠近障碍的格子贵一点，所以帮工走在过道中间；不从两个挡住的格子之间斜着挤过去；找到的路把能直走、不更贵的拐角拉直。到不了就直走过去。
- **光是客户端算的**：法线贴图在加载时从画里生成，不另画夜景；天光随钟点变（约 06:00 日出、19:00 日落），天黑后窗户、路灯、提灯是点光源；镜头前的一层植物往鼠标那边偏几个像素，院子本身不动。
- **院子的动静和效果只在客户端**：炊烟、蝴蝶、池塘、狗（拍它会醒、会玩把戏）、浇水和收获的闪光、金币，都从状态画出来，不进核心状态。
- **院子里的东西是入口**（`YardPlace`）：小摊是商店，箱子堆是仓库，告示板是任务与成就，邮筒是日志，图纸桌是种植计划，帮工名册、工坊（农具）、书屋（技能书）去工作台对应的页，点管家换它的样子。
- **音效现合成，没有音频文件**：每个是 `sfx.dart` 里的一个配方，`synth.dart` 算成样本、写成 WAV 再播。按人耳加权的响度（K 计权，取最响的 100 毫秒）分三档：点击约 -28，干活和状态变化约 -24，奖励约 -20，都压在说话声以下；改了配方要重新量（调试台的「音效」页）。
- **音效从状态里响，不从点击里响**（`FarmSounds`）：换工具、地上的效果、面板开关、语音接通和挂断、帮工到场、长虫、服务端推来的 `GameEffect`，不管是谁让它变的都响。
- **来电号稳定**：来电是服务端的 Inbox，号带帮工的轮次（同一轮同一个号，下一轮又熟了是新号）；客户端按号记接过、挂过的，只响一次。
- **来电的规矩**（`calls.dart`）：农场画面打开时已有的来电算未接、不响；新来电弹出手机、响铃（合成的 `ring`），20 秒（`ringFor`）没理算未接；接听去处理（帮工的打开它的地，计划的打开计划板，@ 你的打开那个对话），挂断是先放着；那件事在别处处理掉、从 Inbox 里消失，来电自己停。接没接过、通话记录只在这次打开里。
- **小游戏的规则是纯函数**：一局是一个值，每一步是值到值，带种子的随机，能重放；画面只跑 `Ticker`、接十字键和 A、B、用 `CustomPaint` 画。最好成绩只在这次打开里；推箱子的棋盘放在 `warehouseProvider`，收起手机、来电都不丢，5 个固定关卡，能逐步撤销、重开本关。小游戏不进账本、不给金币。
- **通知和手机用同一套规则**（`notify.dart`）：都从帧里的 `inbox` 和 `GameEffect` 读。手机上只在 App 不在屏幕前时弹本地通知，点一条经 `hostProvider` 的 `commands` 交给画面，和 Mac 上点通知走同一条路；点通知启动 App 时命令先存着，等画面开始听再交出去。Android 进后台时开一个前台服务（类型 `remoteMessaging`，通知栏一条低优先级的「连着农场」）让状态流不断，回前台就关；iOS 不常驻，离开屏幕后基本收不到。
- **地图上的地 = worktree + 空位**（`map_rules.dart`）：项目里的每个帮工一块（不管在干、熟了还是歇着，它的 worktree 都在），按来的先后排；后面是空位，个数是项目的上限减去在干活的，也不超过农场还空着的地；被农场的地挡住的画成锁住的地。一座岛最多 6 块。上限来自 `ProjectSummary.maxSessions`（`project.max_sessions`，默认 3；没设或超过 6 时是 6），这条和服务端的 `noRoom` 要一致。排上队的待办（`queuedAt`）按先后是院门外的种子袋。不在项目列表里的项目只画它的帮工、不再给空位。岛下面的名牌写着「进岛」并带箭头，点它或岛进这个项目的岛视图。
- **每块地写着项目**：几个项目的地混在一个农场里，有帮工的地在牌子那一栏写它的项目名；有牌子（等验收、缺肥……）时项目名在牌子下面一行（`village/hud.dart` 的 `_plotWords`）。
- **岛是整张的画**：六种样子（`islandLooks`），项目用哪座由名字定；每座中间留一块空院子，`process.py` 找出院子、把岛缩到院子 150 格宽，院子的位置写进 `sprites.json` 的 `yard`，客户端按它摆地。
- **图鉴只读已打包的东西**：图来自 `sprites.json`，指针来自 `cursors.json`，音效来自 `sfx.dart` 的配方；没有自己的清单，切了新图就出现。分类按名字前缀（`shelves`），帧按编号认（`framesOf`），重画和重切的命令按清单里的 `sheet`（切自哪张原图）给出（`remakeOf`）；改了命名前缀要同时改 `shelves`，否则新图落进「其他」。

## 怎么走

**一帧**：服务端经 SSE 推来 `StateFrame` → 每块 `bed` 找 `station` 对上的帮工，按 `PlotKey` 查 `view.plots` 换成 `plot-<庄稼>` 的图 → 每个帮工算庄稼、姿势、去处（`Whereabouts` 每 0.3 秒、换位置每 0.6 秒推一次），`goalOf` 给出目标点，`Walker` 沿 `NavMap.route` 一段段走 → 按脚底的 y 排前后，打光，画 HUD 和牌子。帮工从帧里消失后，它的小动物从大门走掉。

**一次点击**（`hits.dart` 定点到了什么：帮工压过狗，狗压过道具，道具压过地）：

| 农具（数字键 1–6） | 点一块地 |
|---|---|
| 手 | 空地播种（见下「播种袋」）；有帮工的看详情 |
| 浇水 | 给帮工带句话（`issue.comment`） |
| 杀虫 | 枯萎的地：带一句「接着修」 |
| 除草 | 只有提示，点下去不做事 |
| 收获 | 先开收成清单，确认后 `issue.status` 挪到 `done`；种植计划里的一步不在这里收 |
| 铲除 | 在干活的叫停（`session.stop`），否则 `issue.status` 挪到 `canceled` |

**播种袋**（`shared/seed_bag.dart` 的 `SeedForm`，两张皮共用：农场点空地在 `FarmLayer` 里打开，地图点一座岛的空位在工作台的对话框里打开）：

1. **先定项目**：写着「种在 <项目>」和它的栈（Go、Node（bun）……）。从岛上打开的就种在这座岛的项目，不再问。农场的空地不属于哪个项目：先用上次种过的项目（`Prefs.lastProject`，每台设备各记各的，不在项目列表里了就不用），没有的话只有一个项目时直接用它，有几个时才先问「种在哪个项目？」；有几个项目时都可以「换个项目」。
2. **挑种子**：问服务端 `project.templates`，客户端不带种子的副本，只画它给的。从上到下是「最近」（这个项目里派出去过的工单标题，新的在前、不重复、最多 5 条），「常见的活」（按类分：修问题、测试、新功能、整理、依赖、文档、检查、发版，每类一个庄稼图标），一个筛选框，「自己写」的文本框，和「谁来种」。选一颗常见的活，文本框里是它的标题和一行「做到什么程度算完」，光标选中第一个〔…〕空，填上就能种；那一行里的命令照项目的栈写好（`go test ./...`、`bun run test`……），认不出栈就写「测试」「构建」这类泛称。
3. **开工待办**：另一页列出这个项目排着队的待办（`queuedIn`，就是院门外的种子袋），按排上的先后；点「开工」调 `issue.dispatch`，农场的带上地号、岛上的不带，开的是那张工单本身、不另写一张。项目或农场还满着时服务端说为什么，袋子不关，工单留在队里原来的位置。

播种是经田头发一条消息（`channel.say`）：选的或写的那段话原样发，带档案和项目，农场的还带地号（岛上没有农场的地，不带，服务端照常挑一块），管家照着派活。「先起草」不播种：这段话成为这个项目的一张备选工单（`writeIssue`：`issue.create` 再 `issue.draft`，选了谁来种就是它的帮工），袋子关上，打开它的详情（[工单](docs/subsystems/issue.md#怎么走)「起草」）。种下、起草或开工后记下这个项目。

指着一块地时 `aimTool` 写出点下去做什么，用不上就写原因、什么都不发；点下去用的是同一次判断（`PlotAim`），中途换了工具也不变。Esc 放下工具，手上已经是手时打开菜单。

**来电**：Inbox 里出现新号 → `CallBell` 判断要响 → 手机弹出、响铃，系统通知同时按 `noticeForCall` 发（不在屏幕前时）→ 接听经 `InboxTarget` 打开地、计划板或对话；20 秒没理进未接。

## 和谁打交道

- **核心状态（`protocol`）**：读 `StateFrame` 的 `state`、`view`、`inbox`、`effects`；地的样子是 `PlotOf`，来电是 `Inbox`，皮不重写这两条规则。
- **工单、帮工**：农具直接调 `issue.status`、`issue.comment`、`session.stop`，不经帮工找工单；播种是经田头发一条带档案和项目（农场的还带地号）的消息，开工待办调 `issue.dispatch`。
- **种子**：播种袋读 `project.templates`（`issue` 服务从工单里读出「最近」，`project` 服务看项目根目录认栈，工单模板的目录在 `server/internal/protocol/template_catalog.json`），客户端不带副本（[理由](.agents/notes/implemented/feature/2026-10-18-seed-catalog-from-the-server.md)）。
- **项目**：地图读项目列表里的 `maxSessions`，项目页每 30 秒问一次；工单和帮工跟着核心状态来。
- **游戏**：金币、升级、成就到了一档是服务端推来的 `GameEffect`，皮只画效果、响声音、弹通知。
- **素材流水线（`design/`）**：生图 `design/pixel/gen.sh`，切图 `design/pixel/process.py` 写出 `app/assets/pixel/` 和 `sprites.json`（不手改）；原图在 vibevalley-art，`design/art.sh` 链接进来。步骤见 [pixel-village.md](docs/reference/pixel-village.md)「素材」。

## 为什么这样

- **画成农场，不是工地。** 第一版是 three.js 的伪 3D 工地，机器人不好区分，隐喻只有「干活」，装不下「做完了等你收」「出问题了要你处理」；农场有成熟、虫子、干裂、杂草、收获，正好对上这些状态。画风选了型号 B「温室花园」：型号 A（经典农场）颜色和按钮太吵，不适合长时间开着；型号 C（夜间科技温室）暗、字和状态不好认，夜里的样子改成了昼夜变化；型号 D（竖屏）留作手机版。工地版的代码删了，不留存档：没人构建的代码在哪都会悄悄坏掉，git 历史就是存档。
- **像素村，不是贴在背景上的高清精灵。** 风来之国那样的像素画里，小人在有细节、有光影的地图上走，走路本身就说明在干什么；高清精灵缩放后像素对不齐，场景也只有种菜。院子扩成书屋、工坊、电台、长椅，帮工照手上的事走过去，入口放进院子里，院子才不只是种菜的地。
- **渲染层只管画，状态在服务端。** 选 Flame 这样只管画、点击和循环的层；放弃了自带场景和状态管理的完整游戏框架（Phaser 这类），和 Godot、Bevy 这类引擎：它们会在框架里再养一份帮工的状态，违背「核心状态只有一份」，而我们重度依赖的文字界面、中文输入是引擎的弱项。每秒 60 次的东西（走到哪、动画帧、灯光闪烁）是渲染层的普通对象，不进核心状态。
- **镜头不晃，只有前景偏一点。** 让整个镜头跟着鼠标晃视差最足，但画面是用来看帮工干活的，底下的地在晃让人不踏实。
- **地图放在 LDtk，不在代码里描矩形。** LDtk 的实体带字段（这个道具开哪个面板），IntGrid 正好是「能不能走」，比 Tiled 更合适；换布局在 LDtk 里改，打开就能核对能走的地方。
- **格子 A* 而不是手摆路点。** 手摆路点每换一次布局要全部重连；直线走只绕开地块中心，仍会擦着木框和花丛走。
- **素材密一倍，逻辑坐标不动。** 坐标全部乘 2（768×512）要改关卡、路径、点击区、HUD 和动画偏移，改一处漏一处；按密度加载让逻辑一行不动。密度不设开关，由图本身算出来，游戏里不会新旧密度混着。只密 1.5 倍在非 Retina 屏上也是整数倍，但细节涨得少；代价是非 Retina 外接屏上一个新像素是 1.5 个物理像素，粗细会有一点不匀。一类图整张交给 codex 重画，不一张张画：同一个角色的帧一次画完才一致。
- **只有一套像素画面，没有皮肤开关。** 手绘的旧版农场留着时，每加一样东西都要想两边，没人维护的那边会悄悄坏掉；只有一个取值的开关只会让人以为还有别的。`design/assets/` 只留重画界面图要用的手绘原图（`gen.sh` 的 `ui-*`、`look-*` 照它们重画）。
- **整数倍放大，裁一点边。** 非整数倍会一行宽一行窄、走动时闪；把地图往外多画一圈最自然，但要重新生图、改关卡；只把边填成压暗的农场，边还是那么宽。上下 8%、左右 5% 是因为那几行只有崖壁、树梢和篱笆，左右 5% 正好保住左边的井和铁塔。
- **音效现合成，从状态里响。** 录音或买音效包要管文件、授权和格式，响度还要逐个调；在点击处理里放声音，帮工自己做完、服务端推来的变化就没有声音，同一件事在不同入口响法不一样。代价是声音偏简单。
- **来电不存，现算。** 服务端推「来电」事件要新的事实、要存，而这些事核心状态里都有；接没接过只属于这台设备的这次打开，不另加一个存储。来电不自动接管画面，在角落弹出、20 秒收起成未接，打扰最小。
- **通知只在 App 活着时弹，规则在客户端。** 系统推送（APNs、FCM）是 App 关着、不在局域网时唯一的路，但 APNs 要苹果开发者账号和证书，FCM 在国内多数安卓手机上收不到、要一家家接厂商推送；App 关着时靠微信、飞书连接器。Android 不开前台服务的话手机一放下就收不到，代价是通知栏常驻一条、多耗一点电。等要做系统推送时，「该通知谁」才搬到服务端。
- **推箱子是固定关卡。** 随机摆箱子容易无解；固定关卡能控制教学顺序，可解性用搜索测。小游戏不给金币：计分只奖真实收进主分支的活。
- **地图的空位照服务端的上限算，上限不进核心状态。** 客户端写死每个项目 3 个空位，改了配置地图就说错、点进去派不出去；上限是启动时读的配置，不随事实变，放进 `FarmView` 要改折法和黄金数据，只换来少读一次项目列表。也没让歇着的帮工按上限占位：歇着的不占上限，那样画空位会比服务端说的少。没画成一整张有路相连的大地图（项目数不定、手机上要缩），也没在农场画面里按项目分区（农场是固定的 9 块地）；岛是整张画留空院子，因为生图拼不出无缝的小块。
- **图鉴读清单，不另写对照表。** 页面里写前缀到原图的表要和切图脚本保持一致；清单里记 `sheet`，切图时顺手写上，不会对不上。原图不打包进应用，只给路径。不放进调试台：那是窄面板，装不下几百张图。

## 还没做的

- 每个动作至少播完一小段，快速的工具调用一个个看得清：[提案](.agents/notes/proposed/feature/2026-10-09-action-queue.md)。
- 手机竖屏布局：[提案](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)。
- 商店能买东西：[提案](.agents/notes/proposed/feature/2026-10-09-shop-and-daily-tasks.md)。
- 除草农具还没接上（现在杂草是没过验收的意见，点下去只有提示）；肥料袋和稻草人的农具也没有（[工单](docs/subsystems/issue.md)「还没做的」）。
- 田头窗口在窗口右下角，没有收进游戏画面。

## 怎么验证

- `test/village/framing_test.dart`：1152×768 正好放下，1440×900 放大 4 倍裁 48 和 62，1920×1080 只裁上下，1280×800 退到 3 倍留窄边，一边裁一边留边，竖着的手机放大 1 倍，`never more is cut than the limits` 扫一片窗口尺寸。
- `test/village/render_test.dart`：白天帮工在地边和建筑旁、指着的地和东西、金币；夜里的灯、提灯、萤火虫；点地、点院子里的东西、点帮工、点院子。`hits_test.dart` 点击的先后，`dog_test.dart` 狗的把戏。
- `test/sprites/atlas_test.dart`：地图是 384 格宽、两倍密，每张图都在清单旁边。
- `test/farm/tools_test.dart`：手、浇水、杀虫、收获先看收成清单、铲除叫停或请走、用不上时说原因且不发请求、一次点击只判断一次、播种带地号和档案。`test/farm/seed_form_test.dart`：播种袋先问项目、「种在 X」、最近在常见的活前面、选一颗把光标放在第一个空上、筛选、自己写、开工待办开的是排队的那张、记住上次种的项目（不在了就照常问）。服务端：`project/stack_test.go`（每种标记文件、锁文件选包管理器），`issue/templates_test.go`（目录完整、空能解析、按栈填命令、最近怎么挑），`issue/queue_test.go` 的 `TestAQueuedTodoStartsFromTheSowingForm`，`handler/api_test.go` 的 `TestProjectTemplatesAreFilledForItsStack`。`test/farm/screen_test.dart` 是 1440×900 的整屏，`overlays_test.dart` 查每个院子里的东西有一个去处。
- `test/audio/synth_test.dart`：每个音效的样本和响度和 `test/fixtures/sfx.json` 一致，每个都有名字和分组。
- `test/phone/widget_test.dart`：打开时已有的来电不响、新来电响铃，挂断，20 秒没接算未接，接听打开地、计划板或对话，别处处理掉自己停；方块、推箱子、小恐龙从主屏打开。`games_test.dart`、`bugsnake_test.dart`、`merge_test.dart` 测小游戏的规则（种子重放、推箱子每关可解）。来电本身的规则在服务端 `server/internal/protocol/inbox_rules_test.go`。
- `test/host/notify_test.dart`（来电变通知、只响一次）、`mobile_notices_test.dart`（点通知等画面开始听再打开）。
- `test/workbench/map_test.dart`：worktree 和空位、锁住的地怎么算，一座岛最多 6 块，三到五块地怎么摆，每座岛都有院子；页面上点空位打开种在这个项目的播种袋（不问项目、不带地号，开工待办也不带）、点帮工去它的工单。服务端 `server/internal/project/project_test.go` 的 `TestMaxSessionsIsTheProjectLimitWithinMaxRunning`。
- `test/workbench/catalog_test.dart`：清单、书架、帧，图的书架和音效书架。
- 改了画面，照 `verify-app` 在真的客户端上截图看一遍。
