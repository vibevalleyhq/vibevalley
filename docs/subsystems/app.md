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
| 手机上的系统通知 | 「连接到本机」的配对和鉴权（[连接到本机](docs/subsystems/lan.md)）；语音通话（[语音](docs/subsystems/voice.md)） |

包的对外约定（目录表、替身、怎么跑和打包）在 [app/README.md](app/README.md)，这里不重复。

## 在哪

- **组合**：`lib/main.dart` 读偏好里的农场选择（`loadServerChoice`）、拉起本机服务端（`startDesktop`）、开手机通知，再 `runApp(OnChosenFarm)`；`lib/app/app.dart` 的 `OnChosenFarm` 按 `ServerConnection.scopeKey` 建 `ProviderScope`，`lib/app/router.dart` 是全部路由，`lib/app/host_router.dart` 把宿主的命令变成导航。
- **数据层** `lib/data/`：`server.dart` 的 `VibeValleyServer`（两条 SSE 和接口客户端），`providers.dart`（`serverProvider`、`apiProvider`、`stateFrameProvider`、`sideEventsProvider`……），`remote.dart`（`workbenchConfigProvider` 和按对象的读取），`server_choice.dart`（本机还是「连接到本机」那头的农场），`ui_state.dart`、`overlays.dart`、`prefs.dart`（本机的界面状态和偏好）。
- **工作台** `lib/workbench/`：`places.dart` 的 `Place` 是左栏的地方，`workbench_shell.dart` 是外框，每个地方一个目录；设置页的表单在 `workbench/settings/settings_form.dart`。
- **首页** `lib/title/`：`startup.dart` 启动画面，`title_screen.dart` 菜单。
- **宿主** `lib/host/`：`desktop.dart`（方法通道和本机农场的启动）、`launcher.dart`（`ServerLauncher`）、`channel.dart`（渠道表）、`follow.dart`（`HostFollow`）、`notify.dart`（通知和菜单栏的纯函数）、`command.dart`（`HostCommand`）、`mobile_notices.dart`（手机）。Swift 那一半在 `app/macos/Runner/AppDelegate.swift`、`MainFlutterWindow.swift`。
- **打包**：`app/tool/build-macos.sh`（`bun run package:mac`），`app/tool/agora-voice-only.sh`。
- **检查**：`bun run flutter:check`（shapegen 是否最新、`dart format -l 160`、`flutter analyze`、`flutter test`、`app:imports`）。

## 模型和不变量

- **服务端是核心状态唯一的持有者。** 客户端经 `GET /api/v1/state` 收整份 `StateFrame`（`state`、`inbox`、`graphs`、`view`、`effects`），状态变了就再推一份，至多每 200 毫秒一份；经 `GET /api/v1/live` 收 `LiveEvent`（干活过程的一步、提醒、农机变了）。客户端不读事实，`/api/v1/events` 留给命令行和调试。
- **Flutter 不折事实，也不重写服务端的规则。** 给人看的结论由服务端算好：跟着状态走的话在出帧时填（`Session.phaseText`、`Schedule.whenText`、`nextText`、`Progress.multiplier`，`{span}` 由客户端按自己的钟填），跟着草稿走的另开一个接口问（档案的问题 `POST /api/v1/agents/check`、新项目会被拒的第一处 `POST /api/v1/projects/check`、设置会被拒的第一处 `POST /api/v1/settings/check`、记性的预览 `GET /api/v1/memories/{agent}/recall`、交代冲突 `POST /api/v1/issues/{id}/resolve`、播种袋的工单模板 `GET /api/v1/projects/{id}/templates`）；农机为什么不能派、额度剩几成在 `RuntimeInfo.stop`、`RuntimeInfo.quota` 里，农机叫什么、长什么样、接受什么在 `RuntimeInfo.preset`、`RuntimeInfo.facts` 里（[档案和农机](docs/subsystems/agent.md)）；成就的说法是一次性的接口 `game.achievements`，进度在每帧的 `view.achievements`，到一档的特效带着说法（[游戏](docs/subsystems/game.md)）；帮工在做什么、这一轮的每一步在帧里带 `actionText`，干活过程里每个工具调用也带着（[核心状态](docs/subsystems/core.md)）。客户端不带 `seeds.json` 的任何一份，`lib/gen` 里只有形状和接口。
- **`lib/rules/` 只是读帧的纯函数**：哪些频道、未读几条、庄稼熟没熟、能不能收、目录里的农机叫什么这类，只给页面用，服务端不调，所以只在 Dart 有一份；跟着墙上时钟走的画面（走路、动画、小游戏的局面）也只在 Dart。
- **只给真实数据。** 没有模拟服务器：连不上就在顶上一条横幅（`title/connection_banner.dart`）说「连不上 VibeValley 服务端」（「连接到本机」那头的农场说连不上哪台、去「连接到本机」重新配对），每 4 秒问一次 `GET /api/v1/health`，连上自己消失；页面是空的，不换成假数据。
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

  皮是 `workbench` 和 `farm`，互不 import；两张都用的放 `shared`，和业务无关的放 `ui`，本机状态放 `data`。`village` 是渲染层，`farm` 和 `title` 都用它；`phone` 是农场里的手机，不是第三张皮。Agora 的 SDK 只在 `lib/voice/` 里 import（`VENDOR` 表）。组件分两组：`ui/pixel`（像素组，[README](app/lib/ui/pixel/README.md)）给农场、首页、手机、村子，`ui/pro`（专业组，[README](app/lib/ui/pro/README.md)）给工作台，两组共用的在 `ui/` 本身（色板、字体名、贴图、头像、精力瓶、说法、Markdown 的解析和排版、提示的数据，`ui/common.dart`）；`shared`、`chat` 两组都不用（`KITS` 表，`bun run app:imports` 查）。所以两张皮都用的东西在 `shared` 里只放规则和状态（`issue_state.dart`、`work_log_rules.dart`、`harvest_rules.dart`、`seed_bag.dart`、`ComposerDraft`、`Naming`、`DictationControl`、`ManagerStopControl`），画面每张皮一份：农场的在 `farm/`、`village/`，工作台的在 `workbench/`。
- **说一句话只有一份草稿**：主人对谁说一句话的地方（田头、工单详情、浇水、回答起草的问题）都在 `shared/composer.dart` 的 `ComposerDraft` 上：@ 叫人（`Naming`）、回车发送和 Shift+回车换行、输入法拼字时不发、sendKey 和出错那一行；发送只有一种做法：先清空，失败了把字和键放回去（`ComposerDraft.send`），所以重发不会说两遍。画面每张皮一份：农场是 `farm/composer.dart` 的 `Composer`（`bar` 是农场那一条，`inline` 在卡片里），工作台是 `workbench/shared/composer.dart` 的 `WorkbenchComposer`；听写和叫停管家是不画东西的 `DictationControl`、`ManagerStopControl`，两份画面各画按钮。验收、重开这类按钮由调用的地方读同一份 `ComposerDraft`；等验收时框里一行一棵草，回车换行不发送（`enterSends`）。表单的格子（标题、验收标准、快速新建）照旧用各组的文本框。
- **农场里说的是像素，读的是阅读字**：农场的界面、标签、按钮、对话里的话用像素字（`PxText` 的 `xs`…`x2l`，Fusion Pixel 12px，只在 12、24 清楚）；要读的长文用 `PxText.read`（系统的苹方，不打包，14px、行高 1.7，一行至多 40 字）：汇报展开以后、派活展开的整张工单、工单的「要做的」、每次干活的输入和输出。开关在像素组：`PxMarkdown(reading: true)`、`PxReadText`、`PxTextArea(reading: true)`；阅读里的标题仍是像素字（`#` 24，其余 12），代码仍是 Menlo。对话里的长消息（`readsLong`）先用像素字露 6 行，点「展开阅读」换字（`ChatText`）。工作台整张皮都是专业组的苹方，没有这层区分。Markdown 的解析和排版只有一份（`ui/markdown_view.dart` 的 `MarkdownView`），两组各给一张 `MdLook`。
- **一样数据一个来源**：一个 `apiProvider`；档案和农机只从 `workbenchConfigProvider` 读（`agentsProvider`、`runtimesProvider` 由它派生，服务端推的农机变化让它保持最新，旧的刷新不覆盖新的，首次加载失败是错误、和空列表分开）；工地事件只有一个 `sideEventsProvider`。项目目录、每个档案的记性、每个帮工的干活过程由数据层按对象给（`projectCatalogProvider`、`memoryProvider`、`sessionEventsProvider`），干活过程先取历史再接上推送。
- **一个农场一个 `ProviderScope`**：`ServerConnection`（本机地址，或「连接到本机」那头的 `RemoteServer`）变了，`scopeKey` 变，整个 scope 重建，旧的连接、通话随之释放。`VibeValleyServer.close` 关掉两条流和接口客户端，不再重连；坏帧报进 `problems`，后面的合法帧照收。
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
5. 收到收据：把地址写进 `serverConnection`（`withLocal`），scope 照它建，告诉 Swift 子进程的 pid（`server`）。

几处同时要启动（开机、从「连接到本机」切回本机 `useLocalFarm`）共用同一个启动任务；准备环境时就退出，不再生成进程；等收据时退出、甚至 spawn 还没返回就取消，都由同一个 `ServerLauncher.stop` 收回子进程。

**退出**：Swift 收到退出，注销快捷键，经通道发 `quit`，等 Dart 停农场：先 SIGTERM，让服务端存好状态，8 秒没退就 SIGKILL。Dart 12 秒内没答，Swift 照样退出，退出前子进程还活着就 SIGKILL 它。关窗口不退出，农场照常在菜单栏里跑（Dock 图标收起）；登录时打开的直接待在菜单栏，不弹窗口。

**窗口**（`MainFlutterWindow.swift`）：按游戏画面（384×256）能放下的最大整数倍开，最小 2 倍；拖动时锁住比例，松手吸到最近的整数倍。系统标题栏藏起来（红绿灯留着），28 像素的标题条由游戏画（`lib/shell/desktop_title_bar.dart`），拖它移动窗口。应用不在沙箱里（要起服务端、让帮工干活），权限只要麦克风。

**安装**：`bun run package:mac` 在 `app/build/` 下打出应用和 dmg；第一次（和升级 `agora_rtc_engine` 以后）先跑 `app/tool/agora-voice-only.sh`。临时签名的应用在别的 Mac 上第一次打开要在 Finder 里右键 →「打开」；没有自动更新，新版本重新装。

**启动画面和首页**（`title/`）：启动画面按真实的步骤走进度（连上农场、读钥匙、字体、画首页、像素村），20 秒还没好就不等了，连不上的原因由横幅说。首页只在这台设备第一次打开时出来（偏好 `vibevalley.title.seen`），之后直接进农场，游戏菜单的「回到首页」能回去。三项：开始游戏 = 进农场并开工（`manager.open`）；继续游戏 = 回到农场原样，只在有农场可回时能点；设置 = 去工作台的 `/settings`。管家没有任何 DeepSeek 钥匙时，开始游戏先去设置的 DeepSeek 分区。

**工作台的路由**（`go_router`）：`/` 是农场；其余在 `Workbench` 外框里：`/chat`、`/issues`、`/docs`、`/projects`、`/agents`（`/manager` 也算在「帮工」下）、`/runtimes`、`/catalog`，最下面是 `/settings`。`/settings` 跳到 DeepSeek 分区，设置有自己的外框：服务端的四块（DeepSeek、Agora、记性、GitHub），和连接器、技能、声音、「连接到本机」四页。带 id 的路径打开同一页的详情；不认识的路径回农场。

**宿主的命令**：菜单栏、通知点开、快捷键都变成 `HostCommand`（`voice`、`session`、`chat`、`taskBoard`、`achievements`），Swift 先把窗口叫到前面（语音除外），Dart 的 `hostCommandRouterProvider` 回到农场、关掉首页，再选中帮工、打开田头、计划板或成就；语音只切换通话。不认识的命令丢掉。

**通知和菜单栏**（`HostFollow`，桌面和手机共用一份订阅）：

- 菜单栏标题是在干活的帮工数和等你的事数（`2 · 1!`），菜单列现在的情况、每件等你的事、田头未读，再是打开农场、和管家说话（⌥⇧Space）、登录时打开（macOS 13 起）、退出；摘要从帧的 `state` 和 `inbox` 算（`traySummary`），还没连上时是「正在开门…」。
- 帧里新出现的来电（做完、没做成、冲突、没动静、@主人、计划拆好、计划熟了、计划卡住、管家想定的定时）、成就和服务端的错误提醒弹系统通知；开机时已经在的来电只记下不响，同一个来电只响一次（`CallBell`）。macOS 上农场窗口在前面时不弹（Swift 判断）；手机上应用在前台时不弹，Android 另开一个常驻的前台服务通知保持连接。点开回到那件事。

## 和谁打交道

- **服务端的生命周期（`handler.Listen`、`base`）**：主接口只听 `127.0.0.1`（`Config.ServerAddress`，没有 Host 这个配置）；`handler.Listen` 先拿到监听地址、组装农场，全部 `OnStart` 之后由 `base.BeforeReady` 开始答 HTTP，再跑各模块的 `OnReady`，所以 `OnReady` 里派出的帮工拿到的是实际地址（端口 0 也对）。`cmd/server --ready-json` 在这之后写收据。启动失败释放监听和数据库；取消时先停请求、关 HTTP，再关农场。家目录租约持有到全部服务停机写完、数据库关掉，延迟写入的 `FileWriter.Finish` 之后迟到的计时器不再落盘。客户端只依赖收据和 SIGTERM 会存盘这两条。
- **「连接到本机」（`lan`）**：用别的电脑的农场时，在「连接到本机」页粘贴或扫配对链接，那边点头后存进 `server_choice.dart`，之后不再拉起自己的服务端；请求和两条流都带 `Bearer` 钥匙，401 时横幅说要重新配对。
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

- **工单页照 Linear：卡片只放图标，细节放悬停。** 原来每张卡片写着谁在做、第几轮、用时、花费、最后一句，一列放不下几张，扫一眼找不到要处理的。现在卡片是一行「#编号 · 项目」、标题和一排图标（状态、优先级、帮工、计划的进度），只在要主人管的时候加标签（冲突、没做成、丢了、排队、定时、草稿、在起草），其余进桌面的悬停提示；手机上长按是拖卡，没有悬停。另有「列表」视图和「显示」（分组：状态 / 项目 / 帮工 / 不分组；排序：默认 / 优先级 / 最近更新 / 创建时间），分组只给列表，看板总是按状态分列；排序不是默认时，待办里不能拖着排先后，看不见的次序不让改。视图、分组、排序存在本机的偏好（`vibevalley.board.look`），规则是 `rules/board.dart` 的纯函数。
- **加号直接建工单，备选工单的详情是草稿。** 原来加号弹一张表单，主人自己填标题、说明、项目、帮工；主人想说的只是一句话。现在看板的「＋ 写一张」、地图的「写一张工单」、岛上的「派一件活」都马上 `issue.create`，带着话就 `issue.draft`，再打开 `/issues/<id>`；没有 `/issues/new` 这条路由了。详情第一层是一句现在怎样、它问的、一个输入框和「起草 / 再起草」「开工」，下面是草稿各栏，草稿交回来以前主人没改过的栏跟着服务端的新值变。「谁在起草」读服务端给的 `Issue.drafting`，客户端不从帮工里认。
- **工单详情是居中的弹窗，第一层只有状态。** 主人打开一张工单想知道的是到哪一步、要不要我做点什么、它还在不在干；原来的详情是右侧侧栏，从上到下十五块，给查问题的人看的，「这一轮做了什么」「碰过的文件」「跑过的命令」和干活过程讲的是一件事。现在第一层是进度轨、一句状态、草、一个输入框和按状态的按钮，其余折起来。工作台的弹窗由路由画在页面上（`ProModalLayer`），不推进导航栈：地址照旧是 `/issues/<id>`，直接打开也是它。没过验收的意见就写在同一个输入框里，不另开弹窗。
- **说一句话只有一份草稿。** 原来 5 处输入框长了 3 种样子、4 种发送：工作台的等发完才清空，农场的先清空、失败了放回去；带话和浇水没有 @、听写、回车发送和 sendKey，浇水的表单关掉就把字丢了。分叉是抄出来的，抄的是行为，所以把行为收成一份 `ComposerDraft`（还有 `Naming`、`DictationControl`、`ManagerStopControl`），每张皮只画样子。放弃了把所有文字输入都收进来：表单的格子不说给谁听，塞进来只会多一堆开关。
- **两组组件，不是一套组件两种外形。** 工作台是主人真干活的地方，要一屏看得多、扫得快；像素字只有 12、24 两档、没有字重，层级只能靠一层层 2px 的框，中文扫起来累。两张皮差的是结构，不只是参数：像素有窗框、斜面、硬投影，专业要的是列表行、菜单、悬停态、字重。先写过一篇「一套组件，读 `KitSkin` 换外形」的计划，放弃了：一套接口只能取两边的交集，或者每个组件里写两个 build；而且要一次把 500 多处 `KitText` 改成从上下文取，农场也跟着动。两组组件让农场只挪了目录，工作台一页一页迁。也放弃了 `shared` 里的视图写一份、里面按皮分支：那样 `shared` 同时用两组，皮的判断散在每个视图里。代价是两张皮都有的视图（工单详情、干活过程、收成清单、播种袋）加功能要改两处；规则只在 `shared` 的纯函数里，有测试，两份视图只是把它画出来。色板没换成语义色：它是农场的身份，1000 多处直接引用，是另一件事。
- **长文换字，不把像素字放大。** 全客户端原来只有 Fusion Pixel 12px，汇报、工单说明、干活的输出也是，一段几百字的汇报读起来吃力；像素字只在整数倍下清楚，14、16px 会糊，24px 当正文太大。所以分界按「在说话还是在读一篇东西」，不按字数：对话的节奏留像素，长消息先折起来，展开才换字。放弃了打包一份中文字体（多 10 MB 以上）：苹方在 macOS、iOS 上都有，别的平台退到 Noto。

## 还没做的

- 手机竖屏版面：[手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)。
- 状态流改成增量；Windows 版；Developer ID 签名、公证和自动更新。

## 怎么验证

- 分层：`bun run app:imports`（`flutter:check` 也跑），反向、同层跨目录和在 `lib/voice/` 以外 import Agora 都报出文件和行。
- 读服务端的形状：`test/farm/panels_test.dart`（任务与成就页、工单详情状态框里的「正在…」、干活过程的每个工具调用都用服务端给的说法）、`test/workbench/runtimes_test.dart`（农具页照目录列）、`test/workbench/agents_test.dart`（捏帮工的农机列表照目录列和叫）、`test/game/fx_test.dart`、`test/host/notify_test.dart`（特效带的说法）。
- 数据层：`test/data/server_test.dart`（关闭时两条流和 `problems` 都停；坏帧之后下一帧照收）、`test/data/remote_test.dart`（农机推送胜过旧的列表、乱序的刷新新的赢、首次失败是错误）、`test/data/deep_owners_test.dart`（按对象的读取、干活过程先历史再增量、两个可见的视图共用一次已读）、`test/data/api_test.dart`；`test/app/widget_test.dart` 解码 Go 写的示例帧（`server/internal/protocol/golden_test.go` 的 `TestStateFrameSample`）。
- 宿主：`test/host/launcher_test.dart`（子进程分配的端口和收据、日志噪声不算收据、没有收据或 pid 不符超时并停掉、提前退出、等收据时退出、spawn 没完成就取消、不理 SIGTERM 的被杀、登录 shell 超时）、`desktop_start_test.dart`、`desktop_prepare_cancel_test.dart`（并发启动共用一个、准备中退出不再生成进程）、`folders_test.dart`（家目录和工作目录、切回本机保留配对）、`follow_test.dart`、`notify_test.dart`（开机的来电不响、通知的说法、菜单栏摘要、命令的 JSON 来回）、`mobile_notices_test.dart`、`phone_lifecycle_test.dart`；`test/app/host_router_test.dart`。
- 工单的加号和草稿：`test/workbench/drafts_test.dart`（加号带着话建好、起草、打开详情，起草时不能开工；没话的加号建「新工单」、框里写一句再起草；草稿的各栏和问题、回答走 `issue.draft`、开工带着改过的验收标准）、`test/rules/board_test.dart`（分组、排序、存下的视图）、`test/workbench/issue_list_test.dart`（列表、分组折起、显示换分组、组上的加号带着项目建工单）、`test/workbench/issues_test.dart`（看板的加号建工单并起草、卡片上的「草稿」和「<帮工>在起草」、run 的触发写「起草」）、`test/workbench/issue_panel_test.dart`、`test/farm/issue_view_test.dart`（验收时逐条勾验收标准）、`test/farm/seed_form_test.dart`（播种袋的「先起草」）。
- 首页：`test/title/title_test.dart`（第一次之后直接进农场、没钥匙的开始游戏去设置、继续游戏要有农场、启动进度）。
- 服务端那一半：`internal/handler/server_test.go` 的 `TestServerIsReachableBeforeReadyWork`、`TestFailedReadyReleasesTransportAndFarm`；`internal/base/ready_test.go` 的 `TestTransportPreparationPrecedesServiceReadyRequests`；`internal/base/home_lease_test.go`（`TestHomeLeaseRejectsAnotherAppBeforeConstructingServices`、`TestHomeLeaseLastsThroughStopWritesAndReleasesOnce`、`TestHomeLeaseReleasesOnConstructionFailure`、`TestHomeLeaseRejectsSymlinkAlias`）；`internal/base/files_test.go` 的 `TestFileWriterFinishExcludesLateCallbacks`。
- 服务端替客户端算的结论：`TestTheFrameSaysTheWordsOnACopy`、`TestTheFrameSaysWhatEachActionIs`、`TestTheViewSaysHowFarEachAchievementIs`、`TestAchievementsInWords`（protocol）、`TestTheListCarriesEveryRuntimesPresetAndFacts`（runtime）、`TestPreviewPicksWithoutCountingAndTheLongestUnusedFade`（memory）、`TestQuotaWords`（runtime）、`TestCheckSaysWhatCreateWouldRefuse`（project）、`TestConflictingBranchStaysUntilResolved`（workspace）、`TestTheOwnersReviewAndCallAreCounted`（game）。
- 真程序：`verify-app`（`app/tool/screens/live_screens_test.dart` 对着 `scripts/verify-server.ts` 起的服务端画每一页）；渠道：`app/tool/build-macos.sh --channel alpha|beta|release` 后 `Info.plist` 的 `CFBundleIdentifier`、`CFBundleName` 和 dmg 名跟着变，两个渠道同时开各自答 `GET /api/v1/health`。
