# 客户端

VibeValley 只有一个客户端：Flutter 写的 `app/`，桌面和手机都用它。它读服务端折好的帧（`StateFrame`），经生成的 `VibeValleyApi` 发命令，自己不折事实、不重写服务端的规则；上面是两张皮，工作台（`workbench/`）和农场（`farm/`，像素村 `village/` 替它画）。macOS 版把 Go 服务端带在应用里，作为子进程拉起，另有菜单栏、系统通知和语音快捷键；alpha、beta、release 三个渠道是三个能同时开的应用。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 连哪个农场、状态流和窄事件流、重连、连不上时的横幅 | 帧里有什么、怎么折（[architecture.md](docs/architecture.md)「核心状态」、`protocol.FrameOf`） |
| `lib/` 的分层和 import 的方向（`scripts/app-imports.ts`） | 形状和接口的定义（`server/internal/protocol`，`tool/shapegen` 生成 `lib/gen`） |
| Riverpod 的数据层：一样数据一个 provider、按对象的读取 | 规则本身：能不能派、档案的问题、下回想起什么、冲突怎么交代（各自的子系统，客户端问服务端） |
| 工作台的页面结构和路由、首页和启动画面 | 像素农场的画面、玩法和面板（[farm.md](docs/subsystems/farm.md)；每页的内容见 [farm-ui.md](docs/reference/farm-ui.md)「界面清单」） |
| macOS 宿主：服务端子进程的生命周期和就绪、菜单栏、通知、快捷键、窗口、单实例 | 服务端的监听、家目录租约、`OnReady` 的顺序（`internal/handler`、`internal/base`，见下「和谁打交道」） |
| 发布渠道：应用名、bundle id、家目录、工作目录 | 工作目录里有什么（[项目](docs/subsystems/project.md)）；设置存什么（[设置](docs/subsystems/setting.md)） |
| 手机上的系统通知 | 「连接到本机」的配对和鉴权（[连接到本机](docs/subsystems/gate.md)）；语音通话（[语音](docs/subsystems/voice.md)） |

包的对外约定（目录表、替身、怎么跑和打包）在 [app/README.md](app/README.md)，这里不重复。

## 在哪

- **组合**：`lib/main.dart` 读偏好里的农场选择（`loadFarmChoice`）、拉起本机服务端（`startDesktop`）、开手机通知，再 `runApp(OnChosenFarm)`；`lib/app/app.dart` 的 `OnChosenFarm` 按 `FarmConnection.scopeKey` 建 `ProviderScope`，`lib/app/router.dart` 是全部路由，`lib/app/host_router.dart` 把宿主的命令变成导航。
- **数据层** `lib/data/`：`server.dart` 的 `VibeValleyServer`（两条 SSE 和接口客户端），`providers.dart`（`serverProvider`、`apiProvider`、`stateFrameProvider`、`sideEventsProvider`……），`remote.dart`（`workbenchConfigProvider` 和按对象的读取），`farm_choice.dart`（本机还是「连接到本机」那头的农场），`ui_state.dart`、`overlays.dart`、`prefs.dart`（本机的界面状态和偏好）。
- **工作台** `lib/workbench/`：`places.dart` 的 `Place` 是左栏的地方，`workbench_shell.dart` 是外框，每个地方一个目录；设置页的表单在 `shared/settings_form.dart`（首页也用）。
- **首页** `lib/title/`：`startup.dart` 启动画面，`title_screen.dart` 菜单。
- **宿主** `lib/host/`：`desktop.dart`（方法通道和本机农场的启动）、`launcher.dart`（`ServerLauncher`）、`channel.dart`（渠道表）、`follow.dart`（`HostFollow`）、`notify.dart`（通知和菜单栏的纯函数）、`command.dart`（`HostCommand`）、`mobile_notices.dart`（手机）。Swift 那一半在 `app/macos/Runner/AppDelegate.swift`、`MainFlutterWindow.swift`。
- **打包**：`app/tool/build-macos.sh`（`bun run package:mac`），`app/tool/agora-voice-only.sh`。
- **检查**：`bun run flutter:check`（shapegen 是否最新、`dart format -l 160`、`flutter analyze`、`flutter test`、`app:imports`）。

## 模型和不变量

- **服务端是核心状态唯一的持有者。** 客户端经 `GET /api/v1/state` 收整份 `StateFrame`（`state`、`inbox`、`graphs`、`view`、`effects`），状态变了就再推一份，至多每 200 毫秒一份；经 `GET /api/v1/live` 收 `LiveEvent`（干活过程的一步、提醒、农机变了）。客户端不读事实，`/api/v1/events` 留给命令行和调试。
- **Flutter 不折事实，也不重写服务端的规则。** 给人看的结论由服务端算好：跟着状态走的话在出帧时填（`Session.phaseText`、`Schedule.whenText`、`nextText`、`Progress.multiplier`，`{span}` 由客户端按自己的钟填），跟着草稿走的另开一个接口问（档案的问题 `POST /api/v1/agents/check`、新项目会被拒的第一处 `POST /api/v1/projects/check`、设置会被拒的第一处 `POST /api/v1/settings/check`、记性的预览 `GET /api/v1/memories/{agent}/recall`、交代冲突 `POST /api/v1/issues/{id}/resolve`、播种袋的工单模板 `GET /api/v1/projects/{id}/templates`）；农机为什么不能派、额度剩几成在 `RuntimeInfo.stop`、`RuntimeInfo.quota` 里，农机叫什么、长什么样、接受什么在 `RuntimeInfo.preset`、`RuntimeInfo.facts` 里（[档案和农机](docs/subsystems/agent.md)）；成就的说法是一次性的接口 `game.achievements`，进度在每帧的 `view.achievements`，到一档的特效带着说法（[游戏](docs/subsystems/game.md)）；帮工在做什么、这一轮的每一步在帧里带 `actionText`，干活过程里每个工具调用也带着（[核心状态](docs/subsystems/core.md)）。客户端不带 `seeds.json` 的任何一份，`lib/gen` 里只有形状和接口。
- **`lib/rules/` 只是读帧的纯函数**：哪些频道、未读几条、庄稼熟没熟、能不能收、目录里的农机叫什么这类，只给页面用，服务端不调，所以只在 Dart 有一份；跟着墙上时钟走的画面（走路、动画、小游戏的局面）也只在 Dart。
- **只给真实数据。** 没有模拟服务器：连不上就在顶上一条横幅（`shared/connection_banner.dart`）说「连不上 VibeValley 服务端」（「连接到本机」那头的农场说连不上哪台、去「连接到本机」重新配对），每 4 秒问一次 `GET /api/v1/health`，连上自己消失；页面是空的，不换成假数据。
- **分层**：`lib/` 下每个目录一个 rank，import 只能去 rank 更小的目录，同 rank 的不同目录之间也不行：

  | rank | 目录 |
  |---|---|
  | 0 | `gen`、`sprites`、`audio` |
  | 1 | `rules`、`voice` |
  | 2 | `ui` |
  | 3 | `data` |
  | 4 | `host`、`game` |
  | 5 | `shared` |
  | 6 | `chat` |
  | 7 | `phone`、`debug` |
  | 8 | `village` |
  | 9 | `title`、`workbench`、`farm` |
  | 10 | `shell` |
  | 11 | `app` |

  皮是 `workbench` 和 `farm`，互不 import；两张都用的放 `shared`，和业务无关的放 `ui`，本机状态放 `data`。`village` 是渲染层，`farm` 和 `title` 都用它；`phone` 是农场里的手机，不是第三张皮。Agora 的 SDK 只在 `lib/voice/` 里 import（`VENDOR` 表）。
- **一样数据一个来源**：一个 `apiProvider`；档案和农机只从 `workbenchConfigProvider` 读（`agentsProvider`、`runtimesProvider` 由它派生，服务端推的农机变化让它保持最新，旧的刷新不覆盖新的，首次加载失败是错误、和空列表分开）；工地事件只有一个 `sideEventsProvider`。项目目录、每个档案的记性、每个帮工的干活过程由数据层按对象给（`projectCatalogProvider`、`memoryProvider`、`sessionEventsProvider`），干活过程先取历史再接上推送。
- **一个农场一个 `ProviderScope`**：`FarmConnection`（本机地址，或「连接到本机」那头的 `RemoteFarm`）变了，`scopeKey` 变，整个 scope 重建，旧的连接、通话随之释放。`VibeValleyServer.close` 关掉两条流和接口客户端，不再重连；坏帧报进 `problems`，后面的合法帧照收。
- **农场一直挂着**：工作台的页面盖在农场上面，农场 `Offstage` 且 `TickerMode` 关掉（`router.dart` 的 `_KeepFarm`），帮工的位置不丢。
- **渠道在构建时定死**：`--dart-define=VIBEVALLEY_CHANNEL`，打出来的应用不读环境里的渠道；不认识的名字是构建错误。`channel.dart` 的 `DesktopChannel` 是唯一的表：

  | 渠道 | 应用 | bundle id | 家目录（`~/Library/Application Support/…`） | 工作目录 |
  |---|---|---|---|---|
  | release | `vibevalley.app`（码农场物语） | `dev.vibevalley.app` | `vibevalley` | `~/vibevalley` |
  | beta | `vibevalley Beta.app` | `dev.vibevalley.app.beta` | `vibevalley Beta` | `~/vibevalley-beta` |
  | alpha | `vibevalley Alpha.app` | `dev.vibevalley.app.alpha` | `vibevalley Alpha` | `~/vibevalley-alpha` |

  日志在 `~/Library/Logs/<应用名>/server.log`，dmg 是 `vibevalley-arm64.dmg`、`vibevalley-beta-arm64.dmg`、`vibevalley-alpha-arm64.dmg`。`VIBEVALLEY_HOME`、`VIBEVALLEY_WORK_ROOT` 能改这两个目录。终端里跑的服务端是另一个农场：家目录 `~/.vibevalley`、工作目录 `~/vibevalley-dev`、端口 8787。版本号是 `app/pubspec.yaml` 的，发版时手改；签名是临时签名（`codesign --sign -`），没有公证。
- **一个家目录一个服务端**：服务端在构造服务前拿 `$VIBEVALLEY_HOME/.vibevalley.lock` 的排他锁（[architecture.md](docs/architecture.md)「存了什么」），所以两个渠道、或应用和终端指向同一个家目录时，后开的那个起不来。应用自己由 bundle id 单实例：第二次打开把第一个的窗口叫到前面。

## 怎么走

**开机（macOS）**，在画第一帧之前（`startDesktop`）：

1. 经方法通道 `vibevalley/desktop` 发 `setup`（窗口标题带渠道名）。选的是「连接到本机」那头的农场就到此为止。`--dart-define=VIBEVALLEY_SERVER` 给了地址，或包里没有 `Contents/MacOS/vibevalley-server`（`VIBEVALLEY_SERVER_BIN` 能换），也不拉起，直接连那个地址（默认 `http://127.0.0.1:8787`）。
2. 建家目录；问登录 shell 要 PATH（`loginShellPath`，`$SHELL -ilc`，5 秒，问不到用原来的），因为从 Finder 或登录时打开的应用拿不到 pi、claude、codex 所在的 PATH。
3. `ServerLauncher.start` 以 `--ready-json`、`VIBEVALLEY_PORT=0`、`VIBEVALLEY_HOME`、`VIBEVALLEY_WORK_ROOT` 和这个 PATH 拉起子进程，进程的工作目录是家目录，环境是应用自己的环境加上这几项；其余配置读家目录的 `vibevalley.yaml`。stdout 和 stderr 都追加进日志文件。
4. 等收据：服务端监听和工作区都就绪后在 stdout 写一行 `ServerReady`（`url`、`pid`）。只认 `pid` 等于自己子进程、`http://127.0.0.1:<1–65535>` 的那一行，别的 stdout 当日志。40 秒没有收据、或子进程先退出，就停掉它，弹框（`fatal`）说原因和日志在哪，应用退出。
5. 收到收据：把地址写进 `farmConnection`（`withLocal`），scope 照它建，告诉 Swift 子进程的 pid（`server`）。

几处同时要启动（开机、从「连接到本机」切回本机 `useLocalFarm`）共用同一个启动任务；准备环境时就退出，不再生成进程；等收据时退出、甚至 spawn 还没返回就取消，都由同一个 `ServerLauncher.stop` 收回子进程。

**退出**：Swift 收到退出，注销快捷键，经通道发 `quit`，等 Dart 停农场：先 SIGTERM，让服务端存好状态，8 秒没退就 SIGKILL。Dart 12 秒内没答，Swift 照样退出，退出前子进程还活着就 SIGKILL 它。关窗口不退出，农场照常在菜单栏里跑（Dock 图标收起）；登录时打开的直接待在菜单栏，不弹窗口。

**窗口**（`MainFlutterWindow.swift`）：按游戏画面（384×256）能放下的最大整数倍开，最小 2 倍；拖动时锁住比例，松手吸到最近的整数倍。系统标题栏藏起来（红绿灯留着），28 像素的标题条由游戏画（`lib/shell/desktop_title_bar.dart`），拖它移动窗口。应用不在沙箱里（要起服务端、让帮工干活），权限只要麦克风。

**安装**：`bun run package:mac` 在 `app/build/` 下打出应用和 dmg；第一次（和升级 `agora_rtc_engine` 以后）先跑 `app/tool/agora-voice-only.sh`。临时签名的应用在别的 Mac 上第一次打开要在 Finder 里右键 →「打开」；没有自动更新，新版本重新装。

**启动画面和首页**（`title/`）：启动画面按真实的步骤走进度（连上农场、读钥匙、字体、画首页、像素村），20 秒还没好就不等了，连不上的原因由横幅说。首页只在这台设备第一次打开时出来（偏好 `vibevalley.title.seen`），之后直接进农场，游戏菜单的「回到首页」能回去。三项：开始游戏 = 进农场并开工（`manager.open`）；继续游戏 = 回到农场原样，只在有农场可回时能点；设置 = 去工作台的 `/settings`。管家没有任何 DeepSeek 钥匙时，开始游戏先去设置的 DeepSeek 分区。

**工作台的路由**（`go_router`）：`/` 是农场；其余在 `Workbench` 外框里：`/chat`、`/issues`、`/projects`、`/agents`（`/manager` 也算在「帮工」下）、`/runtimes`、`/catalog`，最下面是 `/settings`。`/settings` 跳到 DeepSeek 分区，设置有自己的外框：服务端的四块（DeepSeek、Agora、记性、GitHub），和连接器、技能、声音、「连接到本机」四页。带 id 的路径打开同一页的详情；不认识的路径回农场。

**宿主的命令**：菜单栏、通知点开、快捷键都变成 `HostCommand`（`voice`、`session`、`chat`、`taskBoard`、`achievements`），Swift 先把窗口叫到前面（语音除外），Dart 的 `hostCommandRouterProvider` 回到农场、关掉首页，再选中帮工、打开田头、计划板或成就；语音只切换通话。不认识的命令丢掉。

**通知和菜单栏**（`HostFollow`，桌面和手机共用一份订阅）：

- 菜单栏标题是在干活的帮工数和等你的事数（`2 · 1!`），菜单列现在的情况、每件等你的事、田头未读，再是打开农场、和管家说话（⌥⇧Space）、登录时打开（macOS 13 起）、退出；摘要从帧的 `state` 和 `inbox` 算（`traySummary`），还没连上时是「正在开门…」。
- 帧里新出现的来电（做完、没做成、冲突、没动静、@主人、计划拆好、计划熟了、计划卡住、管家想定的定时）、成就和服务端的错误提醒弹系统通知；开机时已经在的来电只记下不响，同一个来电只响一次（`CallBell`）。macOS 上农场窗口在前面时不弹（Swift 判断）；手机上应用在前台时不弹，Android 另开一个常驻的前台服务通知保持连接。点开回到那件事。

## 和谁打交道

- **服务端的生命周期（`handler.Listen`、`base`）**：主接口只听 `127.0.0.1`（`Config.ServerAddress`，没有 Host 这个配置）；`handler.Listen` 先拿到监听地址、组装农场，全部 `OnStart` 之后由 `base.BeforeReady` 开始答 HTTP，再跑各模块的 `OnReady`，所以 `OnReady` 里派出的帮工拿到的是实际地址（端口 0 也对）。`cmd/server --ready-json` 在这之后写收据。启动失败释放监听和数据库；取消时先停请求、关 HTTP，再关农场。家目录租约持有到全部服务停机写完、数据库关掉，延迟写入的 `FileWriter.Finish` 之后迟到的计时器不再落盘。客户端只依赖收据和 SIGTERM 会存盘这两条。
- **「连接到本机」（`gate`）**：用别的电脑的农场时，在「连接到本机」页粘贴或扫配对链接，那边点头后存进 `farm_choice.dart`，之后不再拉起自己的服务端；请求和两条流都带 `Bearer` 钥匙，401 时横幅说要重新配对。
- **设置（`setting`）**：首页和设置页读写 `GET`/`POST` 设置，保存前问 `settings/check`；钥匙从不经过客户端，页面只看到来源和末四位。
- **语音（`voice`）**：通话归当前农场的 scope，按钮和 ⌥⇧Space 发同一个动作；Swift 第一次按快捷键时要麦克风权限。
- **验证脚本**：`scripts/verify-server.ts` 用同一个收据协议起一个隔离的服务端，再交给 `verify-app` 画截图。

## 为什么这样

- **一个客户端，用 Flutter。** 一套 Dart 出 macOS、iOS、Android 的原生应用，Agora 有官方的 Flutter SDK。放弃了 Tauri 或 Capacitor 包网页（手感和 WebView 里的语音正是要换掉的）、React Native（像素村要套 WebView，桌面端弱）、留着 Electron 或 MyGo（三个 macOS 应用把菜单栏、通知、快捷键、渠道各写一遍，家目录还不同）。网页也删了：它冻结以后只为对照留着一份 TypeScript 规则，每改一条规则写两遍；对照的参照已经落后，模拟服务器只服务它。代价是没有不起服务端就能看的画面。
- **推折好的整份状态，客户端不折。** 客户端再写一份 `Reduce` 就是第二份核心状态，两边改规则靠自觉对齐。推整份的代价是带宽：一份真实状态几十 KB，管家逐字说话时每 200 毫秒一份，本机和局域网没问题，手机走蜂窝网偏重；要换增量时，增量格式又是一份两端都要遵守的约定。
- **种子数据挂在服务端已经给的东西上，客户端不带副本。** 原来 `shapegen` 把 `seeds.json` 里客户端要的五样压成一行约 35KB 的字符串写进 `lib/gen`：「连接到本机」的手机和那台电脑的服务端版本不一样时，农机的名字和能力、成就的门槛就对不上，成就进度和农机能做什么在 Dart 里也成了一份规则的输入；改一个成就整行都变，难审。现在每样挂在页面本来就在等的东西上：农机随 `runtime.list`，成就的说法随一次性的 `game.achievements`、进度随帧，动作的说法随帧和事件。放弃了 `shapegen` 改写资源文件（客户端照样带副本，二十来处改成等异步读）和一个整份的 `GET /api/v1/seeds`（客户端拿到还要自己拼进度、名字，规则回到 Dart）。
- **客户端问服务端，不移植规则。** 移植一份再用 Go 写样本、Dart 读样本守着两边一致，守得住，但每条规则两份实现、两套测试，页面要的只是结论。没把这些结论都塞进核心状态：档案的问题依赖没存的草稿，记性的预览依赖主人正在打的字，都不是农场的状态。代价是这几句要等服务端回答，第一次打开晚一下出现。反过来，只给页面读帧的小函数（未读、熟没熟）不留在 Go：开着的服务端不调它们，留着只是为了对照。
- **两张皮在上，共用的在下，次序由脚本查。** 共用的东西放在先有的那张皮里，后来的那张就反过来借，依赖成了双向的。没放进一个 `common/`：田头是一整块功能（状态、规则、控件），和几张脸、几个小控件不是一回事。没拆成多个 Dart package：一个包加 `app:imports` 已经挡得住，真要编译器挡再拆。
- **只给真实数据。** 服务端没开时换成模拟农场，提示再大也会被当成真的；没有服务端就说没有。
- **子进程自己发布就绪地址。** 宿主先绑端口 0、读出端口、关掉再交给服务端，关掉到重绑之间端口可能被抢，还得写换端口重试；从人读的日志里用正则找地址，日志措辞就成了协议。绑定结果只有子进程知道，所以由它用一个有形状的收据（`ServerReady`，Go 定义、生成 Dart）说出来，并带上 pid，宿主只认自己启动的那个。
- **传输在 `OnReady` 之前开始服务，地址只有一个来源。** 只提前 `net.Listen` 不够：`OnReady` 发来的请求可能等不到处理。只校验 Host 会留下一个不支持的选择和两个拼地址的地方；直接删掉。
- **家目录用文件锁，不靠端口、单实例或 SQLite。** 它们分别只约束网络地址、bundle id 和数据库写事务；家目录里还有档案、核心状态、花费的 JSON 快照，第二个进程会覆盖第一个已确认的修改。改端口或从终端启动都能绕过前三样，只有内核持有的锁跟着目录走（先解析符号链接，别名争同一把锁）。
- **三个渠道是三个应用，不是一个应用的三种设置。** 一个应用里切渠道，同一时间只能开一个，新版本的代码也会跑在旧数据上，正是要避免的。家目录不共用：一个渠道的迁移会把库改成另一个渠道读不了的样子；工作目录也不共用：拿 Beta 开发 VibeValley、Alpha 试新包时，两个农场的帮工不能在同一份项目和 worktree 里干活。端口不按渠道分：固定端口可能被别的程序占，每个应用让服务端自己挑。版本号不用日期或提交数：日期一天打几次会重，提交数要有地方记。
- **首页只给第一次来的人。** 天天用的人每次都要先点「继续游戏」，点开一条通知也被首页挡住要多点一次。不做「新游戏」清档：农场里是主人的田头、账本和帮工的分支，一个按钮清掉代价太大。进度条只在启动画面，首页一出来就是菜单。
- **设置是工作台的一页。** 首页的设置窗口和扳手各开一处，打开设置整个版面就换了；合成 `/settings` 一页，首页、扳手和缺钥匙的开始游戏都进它。

- **加号直接建工单，备选工单的详情是草稿。** 原来加号弹一张表单，主人自己填标题、说明、项目、帮工；主人想说的只是一句话。现在看板的「＋ 写一张」、地图的「写一张工单」、岛上的「派一件活」都马上 `issue.create`，带着话就 `issue.draft`，再打开 `/issues/<id>`；没有 `/issues/new` 这条路由了。详情第一层是一句现在怎样、它问的、一个输入框和「起草 / 再起草」「开工」，下面是草稿各栏，草稿交回来以前主人没改过的栏跟着服务端的新值变。「谁在起草」读服务端给的 `Issue.drafting`，客户端不从帮工里认。
- **工单详情是居中的弹窗，第一层只有状态。** 主人打开一张工单想知道的是到哪一步、要不要我做点什么、它还在不在干；原来的详情是右侧侧栏，从上到下十五块，给查问题的人看的，「这一轮做了什么」「碰过的文件」「跑过的命令」和干活过程讲的是一件事。现在第一层是进度轨、一句状态、草、一个输入框和按状态的按钮，其余折起来。工作台的弹窗由路由画在页面上（`PxModalLayer`），不推进导航栈：地址照旧是 `/issues/<id>`，直接打开也是它。没过验收的意见就写在同一个输入框里，不另开弹窗。

## 还没做的

- 手机竖屏版面：[手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)。
- 状态流改成增量；Windows 版；Developer ID 签名、公证和自动更新。

## 怎么验证

- 分层：`bun run app:imports`（`flutter:check` 也跑），反向、同层跨目录和在 `lib/voice/` 以外 import Agora 都报出文件和行。
- 读服务端的形状：`test/farm/panels_test.dart`（任务与成就页、工单详情状态框里的「正在…」、干活过程的每个工具调用都用服务端给的说法）、`test/workbench/runtimes_test.dart`（农具页照目录列）、`test/workbench/agents_test.dart`（捏帮工的农机列表照目录列和叫）、`test/game/fx_test.dart`、`test/host/notify_test.dart`（特效带的说法）。
- 数据层：`test/data/server_test.dart`（关闭时两条流和 `problems` 都停；坏帧之后下一帧照收）、`test/data/remote_test.dart`（农机推送胜过旧的列表、乱序的刷新新的赢、首次失败是错误）、`test/data/deep_owners_test.dart`（按对象的读取、干活过程先历史再增量、两个可见的视图共用一次已读）、`test/data/api_test.dart`；`test/app/widget_test.dart` 解码 Go 写的示例帧（`server/internal/protocol/golden_test.go` 的 `TestStateFrameSample`）。
- 宿主：`test/host/launcher_test.dart`（子进程分配的端口和收据、日志噪声不算收据、没有收据或 pid 不符超时并停掉、提前退出、等收据时退出、spawn 没完成就取消、不理 SIGTERM 的被杀、登录 shell 超时）、`desktop_start_test.dart`、`desktop_prepare_cancel_test.dart`（并发启动共用一个、准备中退出不再生成进程）、`folders_test.dart`（家目录和工作目录、切回本机保留配对）、`follow_test.dart`、`notify_test.dart`（开机的来电不响、通知的说法、菜单栏摘要、命令的 JSON 来回）、`mobile_notices_test.dart`、`phone_lifecycle_test.dart`；`test/app/host_router_test.dart`。
- 工单的加号和草稿：`test/workbench/drafts_test.dart`（加号带着话建好、起草、打开详情，起草时不能开工；没话的加号建「新工单」、框里写一句再起草；草稿的各栏和问题、回答走 `issue.draft`、开工带着改过的验收标准）、`test/workbench/issues_test.dart`（看板的加号建工单并起草、卡片上的「草稿」和「<帮工>在起草」、run 的触发写「起草」）、`test/shared/issue_view_test.dart`（验收时逐条勾验收标准）、`test/farm/seed_form_test.dart`（播种袋的「先起草」）。
- 首页：`test/title/title_test.dart`（第一次之后直接进农场、没钥匙的开始游戏去设置、继续游戏要有农场、启动进度）。
- 服务端那一半：`internal/handler/server_test.go` 的 `TestServerIsReachableBeforeReadyWork`、`TestFailedReadyReleasesTransportAndFarm`；`internal/base/ready_test.go` 的 `TestTransportPreparationPrecedesServiceReadyRequests`；`internal/base/home_lease_test.go`（`TestHomeLeaseRejectsAnotherAppBeforeConstructingServices`、`TestHomeLeaseLastsThroughStopWritesAndReleasesOnce`、`TestHomeLeaseReleasesOnConstructionFailure`、`TestHomeLeaseRejectsSymlinkAlias`）；`internal/base/files_test.go` 的 `TestFileWriterFinishExcludesLateCallbacks`。
- 服务端替客户端算的结论：`TestTheFrameSaysTheWordsOnACopy`、`TestTheFrameSaysWhatEachActionIs`、`TestTheViewSaysHowFarEachAchievementIs`、`TestAchievementsInWords`（protocol）、`TestTheListCarriesEveryRuntimesPresetAndFacts`（runtime）、`TestPreviewPicksWithoutCountingAndTheLongestUnusedFade`（memory）、`TestQuotaWords`（runtime）、`TestCheckSaysWhatCreateWouldRefuse`（project）、`TestConflictingBranchStaysUntilResolved`（workspace）、`TestTheOwnersReviewAndCallAreCounted`（game）。
- 真程序：`verify-app`（`app/tool/screens/live_screens_test.dart` 对着 `scripts/verify-server.ts` 起的服务端画每一页）；渠道：`app/tool/build-macos.sh --channel alpha|beta|release` 后 `Info.plist` 的 `CFBundleIdentifier`、`CFBundleName` 和 dmg 名跟着变，两个渠道同时开各自答 `GET /api/v1/health`。
