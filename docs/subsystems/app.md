# 客户端

VibeValley 只有一份界面：Solid 2 写的页面 `apps/web`，由服务端在 `/` 提供，桌面壳、浏览器和手机的壳打开的都是它。它读服务端折好的帧（`StateFrame`），经 `@vibevalley/protocol` 的 `VibeValleyApi` 发命令，自己不折事实、不重写服务端的规则；开页落在工作台，`/farm` 是像素农场（`src/farm`）；工作台里每个概念一个 `src/features/<概念>`，里面是它的页。桌面版是 Electron 壳 `apps/desktop`：用自己的 Node 带着服务端起来、打开它的页面，另有菜单栏、系统通知和语音快捷键；手机的壳是 `apps/mobile`（Expo、React Native）：扫码配对，在 WebView 里打开那台电脑经「连接到本机」放出的页面，另有系统通知和锁屏也不断的通话。两个壳都经宿主接口 `@vibevalley/protocol/host` 给页面。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 状态流、重连、连不上时说什么 | 帧里有什么、怎么折（[architecture.md](docs/architecture.md)「核心状态」、`frameOf`） |
| 页面的目录和数据层：一条状态流、Solid Query 的读取、共用的 store | 形状和接口的定义（`packages/protocol`） |
| 工作台的路由和外框、首页 | 规则本身：能不能派、档案的问题、下回想起什么、冲突怎么交代（各自的子系统，页面问服务端） |
| 宿主接口：通知、菜单栏、语音快捷键、宿主自己的通话线路、窗口没有自己的标题栏时让出的地方；没有的是 null | 像素农场的画面、玩法和面板（[farm.md](docs/subsystems/farm.md)；每页的内容见 [farm-ui.md](docs/reference/farm-ui.md)「界面清单」） |
| 桌面壳：服务端子进程的生命周期和就绪、窗口、单实例、打包、刘海上的灵动岛；手机壳：配对、WebView、通知、通话 | 服务端的监听、家目录租约（[地基](docs/subsystems/foundation.md)） |
| 连进来的浏览器：先配对，钥匙存在 cookie | 「连接到本机」的配对和鉴权（[连接到本机](docs/subsystems/lan.md)）；语音通话（[语音](docs/subsystems/voice.md)） |

包的对外约定（目录表、规矩、命令）在 [apps/web/README.md](apps/web/README.md) 和 [农场的 README](apps/web/src/farm/README.md)，这里不重复。

## 在哪

- **组合**：`apps/web/src/main.tsx`：没配对的远端浏览器先去 `/pair`，再画 `app/App.tsx`：`Root`（路由、状态流、农场的 store、查询的缓存、一个 `<Loading>`）里是 `Follow`（`features/notice`：通知、菜单栏、快捷键）、路由和 `ToastHost`。
- **地基** `src/base/`：`frames.ts`（状态流，和框架无关：`subscribe`、`get`）、`frame.ts`（接成 Solid 的 store：`createFrames`、`useFrames`、`useCore`）、`external.ts`（`createExternal`：把框架无关的 store 接成信号）、`api.ts`（`api`、`reasonOf`）、`live.ts`（`/api/v1/live`）、`gateway.ts`（页面的那条 WebSocket：Effect RPC 的 `Subscriptions`，页面里只有这里用 Effect）、`query.ts`（`queries`、`ready` 和按对象的读取）、`agents.ts`（`useAgent`、`useWorkAgents`、`useAgentProblems`）、`router.ts`、`prefs.ts`、`host.ts`、`settings.ts`（`saveSettings`）、`format.ts`（时间和钱的说法）、`words.ts`（通用的话）。一个概念自己的读取在它的 feature 里：`features/channel/follow.ts`（按频道存说的话：最新一页、订阅、往前翻页、串的头一条、全农场的汇报；`useFollowed`、`useMessage`、`useReports`）、`features/session/logs.ts`（每个 Session 的快照、增量与重连补读）、`features/session/data.ts`（页面的日志订阅）、`features/issue/data.ts`。
- **工作台** `src/app/`：`App.tsx` 是路由表，`places.ts` 是左栏的地方，`Shell.tsx` 是外框；路由本身是 `base/router.ts`（浏览器历史上的一个信号，`navigate`），页内的链接是 `ui/A.tsx`。每个概念一个 `src/features/<概念>/`，名字和服务端的模块一样（`issue`、`task`、`channel`、`session`、`agent`、`memory`、`orchestrator`、`project`、`runtime`、`doc`、`voice`、`lan`、`connector`、`notice`、`setting`，和画素材的 `catalog`），里面是它的页、读取、规则和词表，`index.ts` 是别处能用的；共用的版面在 `ui/layout.tsx`，共用的组件在 `src/ui/`（会动的部件：分段、开关、单选、滑块、对话框、提示、标签页、菜单、快速切换，行为来自 `@vibevalley/base-ui`，`ui/` 只给它们田间工作台的样子），几张皮共用的像素部件（窗口、按钮、图集、声音）在 `src/ui/pixel/`。
- **零件的故事**：`packages/stories` 是格式（`stories`、`story`：参数和控件）和查看器（`StoriesApp`：按标题分层的故事树、画布、参数面板，地址带着故事、主题和宽度）；页面的入口是 `apps/web/stories.html` 和 `src/stories.tsx`（收集 `src/**/*.stories.tsx`，套一个哪也不去的路由、空的状态帧和查询缓存），`vite.stories.config.ts` 构建到 `dist-stories/`。故事排成一座金字塔，标题的第一段是它在哪一层（`src/storyLevels.ts`，`src/stories.test.ts` 查）：**设计体系**（令牌、图标）、**组件**（一个零件一份：`组件/工作台/…` 是 `ui/` 的，`组件/像素/…` 是 `ui/pixel/` 的，`组件/工单/…` 这类是一个概念自己的零件）、**交互**（几个零件一起完成一件事：列表和详情、在原地确认、表单和保存、空的加载和出错；写在 `src/stories/`）、**界面**（一个概念的一块界面，用编出来的数据画：看板、改动、答案；写在 feature 里那个零件旁边）。组件的故事写在零件旁边：`ui/Button.tsx` 旁是 `ui/Button.stories.tsx`。一个零件看的是它的状态：故事可以带一张状态表（`grid`：变体排成行，静止、指针下、聚焦、按下排成列），交互状态不用指针、由查看器把样式表里等着 `:hover`、`:focus-visible`、`:active` 的规则抄一份挂到祖先的 `data-pseudo` 上强制出来；界面的故事一个状态一个（「工单页」从草稿到关了十种，按钮照服务端 `attention.ts` 给的），故事背后没有服务端，读接口的界面由故事自己回答（`base/storyApi.ts` 的 `answer`），编出来的数据写成 `*.samples.ts`。查看器还能换语言（地址里的 `lang`，画之前读）、实时跑 axe。
- **页面的规则**在它所属的 feature 里，是只读帧和回答的纯函数，各带 vitest：看板的分栏（`features/issue/display.ts`）、频道的未读（`features/channel/rules.ts`）、一轮的瀑布图（`features/session/rounds.ts`）、通知的说法（`features/notice/tray.ts`）、远端和配对（`features/lan/rules.ts`）。
- **宿主**：接口在 `@vibevalley/protocol/host`（`packages/protocol/src/host.ts`）：`Host`（`notify`、`tray`、`voiceShortcut`、`rtc`、`titleBar`、`locale`），和手机壳的桥（`ToNative`、`FromNative`，页面这一头是 `mobileHost`）；页面在 `src/base/host.ts` 里找自己的宿主（`currentHost()`、没有宿主时的 `browserHost`）。桌面壳的 preload、手机壳各自实现它。
- **灵动岛** `apps/island`：Swift 的原生小程序（AppKit 的 `NSPanel` 里放 SwiftUI），`IslandCore` 是能离开屏幕测的消息（`Messages.swift`）和位置（`Geometry.swift`），`VibeValleyIsland` 画它；桌面壳那一半在 `apps/desktop/src/island.ts`（`glanceOf`、`startIsland`）。
- **桌面壳** `apps/desktop`：`src/main.ts`（窗口、菜单栏、通知、快捷键、单实例、退出）、`src/server.ts`（`loginShellPath`、`startServer`）、`src/preload.ts`（把宿主接口交给页面）；`scripts/build.ts`、`scripts/package.ts`（`vp run package:mac`）。
- **手机壳** `apps/mobile`：`App.tsx`（跟随当前农场选择）、`src/PairScreen.tsx`（扫码、粘贴、配对或取消）、`src/FarmScreen.tsx`（WebView 和桥）、`src/farm.ts`（`FarmConnection`：当前农场、配对和系统钥匙串提交）、`src/rtc.ts`（声网的原生 SDK）、`src/notify.ts`、`src/rules.ts`；`ios/`、`android/` 由 `expo prebuild` 从 `app.json` 生成，不进仓库（[README](apps/mobile/README.md)）。
- **检查**：`vp run web:check`、`vp run --filter @vibevalley/web e2e`、`vp run desktop:test`；手机壳是 `vp run --filter @vibevalley/mobile test` 和 `scripts/e2e.ts`。

## 模型和不变量

- **服务端是核心状态唯一的持有者。** 页面经 `GET /api/v1/state` 收整份 `StateFrame`（`state`、`inbox`、`graphs`、`view`、`effects`），状态变了就再推一份；经 `GET /api/v1/live` 收 `LiveEvent`（干活过程的一步、提醒、农机变了）。页面不读事实，`/api/v1/events` 留给命令行和调试。
- **页面不折事实，也不重写服务端的规则。** 给人看的结论由服务端算好：跟着状态走的话在出帧时填（`Session.phaseText`、`Cron.whenText`、`nextText`、`Progress.multiplier`），跟着草稿走的另开一个接口问（档案的问题 `POST /api/v1/agent/check`、新项目会被拒的第一处 `POST /api/v1/project/check`、设置会被拒的第一处 `POST /api/v1/setting/check`、记性的预览 `POST /api/v1/memory/recall`、交代冲突是工单的动作 `resolve`（`POST /api/v1/issue/act`）、播种袋的工单模板 `POST /api/v1/project/template/list`）；农机为什么不能派、额度剩几成在 `RuntimeInfo.stop`、`RuntimeInfo.quota` 里，叫什么、长什么样在 `RuntimeInfo.preset`、`RuntimeInfo.facts` 里（[档案和农机](docs/subsystems/agent.md)）；成就的说法是 `game.achievement.list`，进度在每帧的 `view.achievements`（[游戏](docs/subsystems/game.md)）。服务端和页面都要的规则在 `packages/protocol/src/rules`，页面 import 的就是服务端用的那份。
- **页面的规则只是读帧的纯函数**：哪些频道、未读几条、庄稼熟没熟、看板怎么分栏，只给页面用；跟着墙上时钟走的画面（走路、动画、小游戏的局面）也只在页面。
- **页面的话在词典里，语言读一次**：`packages/i18n/locales/{zh,en}/web.*.json`，一个目录一个命名空间（`web.issue`、`web.farm.phone`），代码里写 `t("web.issue.…")`，语言是服务端发的 `index.html` 上的 `data-locale`，开页时读定；设置里换了语言就整页重开，帧里服务端写的话也一起换。页面开起来以后经 `host.locale` 告诉宿主，桌面壳的菜单栏和灵动岛跟着说（[话放在哪](docs/subsystems/foundation.md#话放在哪)）。开机的进度条（`public/opening.html`，也写进 `index.html`）在页面的脚本之前就要说话，用不了 `t()`：它的话在 `web.json` 的 `opening`，构建时由 `vite.config.ts` 写进两份 HTML，按同一个 `data-locale` 或桌面壳给的 `?locale=` 选。桌面壳自己的应用菜单（`apps/desktop/src/menu.ts`）也照语言写，页面说了新的语言就重建。
- **一条状态流**：`base/frames.ts` 给整个页面开一条 `/api/v1/state`，断了一秒后重连；连着、在连、断了（`link`）在外框的小灯和农场的提示里说。没有模拟服务器：连不上就说连不上，页面是空的，不换成假数据。
- **REST 的读取经查询模块**（`base/query.ts`）：`QueryClient` 和 `QueryObserver` 拥有缓存、重试、轮询和请求去重，Solid 只订阅观察者的结果。一个查询键一种形状（`["projects"]` 只有 `ProjectSummary[]`）；帧里的变化让相关查询失效再读。等待、失败是结果值，`ready(query, fallback)` 选择成功数据；重新读取不挂起状态帧，换查询键时的旧值由 `placeholderData` 决定。卸载页面先退订观察者，请求回来只更新缓存。
- **干活过程由一个读取模块持有**：`SessionLogs` 为正在看的每个 Session 共享一份日志，先订阅再读快照；直播流每次连上都补读，断线期间已经完成、不再发事件的步骤也能回来。快照替换保留窗口，读取期间收到的步骤按 `seq` 和 `revision` 合并，旧直播片段不能盖掉新快照。最后一个读者离开就释放日志；工作台、农场、轨迹和消息下的步骤都经 `createSessionEvents` 读，不按帮工的阶段猜刷新时机。日志的信号不挂起同页的时间线和改动查询。
- **界面读按 id 合并的帧**：`createFrames` 把每一帧按 id `reconcile` 进 Solid 的 store，只有变了的字段触发更新；要比前后两帧的（音效、画布、来电、特效）读原始的帧（`base/frame.ts` 的 `rawFrame()`）。农场的 store、本机的选择（`base/prefs.ts`：下一单派谁、管家的长相、宠物）、toast、通话、听写是和框架无关的模块，经 `createExternal` 接进来。
- **页面分层，只往前 import**：`base` → `ui` → `ui/pixel` → `features` → 皮（`farm`、`tree`）→ `app`，一个文件只 import 自己这层和前面的（lint 的 `vibevalley/page-layers`，`scripts/oxlint-plugin.ts`）；一个 feature 只经另一个的 `index.ts` 用它，feature 之间的依赖不成环（`src/layers.test.ts`）。所以工作台不靠农场的规则和状态：农场是皮，feature 和部件都不认识它；两边都要的放在皮下面：帧在 `base/frame`，本机的选择在 `base/prefs`，额度的说法在 `features/runtime/quota`，工单的动作在 `features/issue/acts`，画在 `ui/pixel`；只有挂皮的 `app/` 认识皮。两个 feature 都要的一个字、一个格式、一个查询，放到两者下面那层，或者各留一份字，不让一个伸进另一个里。
- **图标分两套**：工作台的按钮和标记是 reicon 的线条图标（Outline，跟着字的颜色），`ui/icons.ts` 给每个意思一个图（`close`、`issues`、`check`……），`ui/Icon.tsx` 的 `<Icon name>` 只收这张表里的名字，写错编不过；勾、叉、警告自带绿、红、黄。帮工在干什么由 `actionIcon` 对到图。像素皮（`farm`、`tree`、`ui/pixel`）用 `ui/pixel` 的 `SpriteIcon` 画 `public/pixel` 的贴图。头像（`ui/Face.tsx`）、农机的 logo、项目页的岛和作物、项目地图、额度瓶、连接器的 logo 是画，不是图标，在工作台里也用 `SpriteIcon`。
- **一处响应性出错，整页停住**：一个错误逃出所有边界时 Solid 停掉整页的更新（`REACTIVITY_HALTED`），页面看着还在、不再动。`<Show>`、`<Match>` 的函数子节点拿到的值在分支收起后一读就抛，分支里还在结算的查询会读到它，所以带查询的面板按普通值 keyed、自己记住最后找到的那个；`ref` 的回调不读 `<For>` 每一项的值。Playwright 里逃出页面的错误让用例失败（`test/fixtures.ts`）。
- **宿主接口是封闭的**：每个宿主实现全部方法，没有的能力是 null，页面据此决定画不画，不问「我在哪个壳里」。桌面壳经 preload 的 `contextBridge` 给（`contextIsolation`、`sandbox`，页面碰不到 Node 和 Electron）；手机壳的 WebView 带着 `ReactNativeWebView`，`currentHost()` 见到它就建 `mobileHost`：页面把要的东西写成 JSON 发过去，壳按 id 答，通话的事件也这样送回（`window.vibevalleyFromHost`）；浏览器全是 null。
- **桌面窗口是沉浸式的**（macOS）：窗口没有自己的标题栏，页面画到顶边，红绿灯浮在左上角；宿主的 `titleBar`（`{ top: 28, left: 76 }`）说顶上那一条多高、红绿灯占到多宽。页面最前面放一条这么高的拖动条（`ui/TitleBar.tsx` 的 `WindowStrip`，`-webkit-app-region: drag`），条里的按钮、链接、输入框照样能点（`style.css` 的 `no-drag`）；工作台的侧栏顶上、农场左上角那组 HUD 让出这一条。窗口的内容区默认 1152×768，拖动时保持 3:2，农场正好铺满；拖完松手时，会让农场留边的尺寸调到最近的不留边的尺寸（主进程的 `resized`，最大化和全屏不调；[农场的皮](docs/subsystems/farm.md)「放大只用整数倍」）。从仓库跑时 Dock 上的图标是 `apps/web/public/icons/app-256.png`，打包的用 `resources/icon.icns`。其他系统和浏览器、手机是 null，用自己的标题栏。
- **通话的线路可以归宿主**：`VoiceCall` 只认 `Rtc`（`join` 出一条能 `mute`、`renew`、`leave` 的线，事件是来了、走了、字幕、两边的音量、出错、令牌快过期），有 `host.rtc` 就用宿主的（手机的原生 SDK，锁屏不断），没有就用页面自己的声网 Web SDK（`features/voice/agora.ts`）。会话、字幕、交给管家的话都还在页面里。
- **页面总在服务端的源上**：页面和接口同源，没有 CORS；桌面窗口只停在服务端的地址上，别的链接交给系统浏览器。
- **连进来的浏览器先配对**：不是 `127.0.0.1`、`localhost` 打开的页面，又没有配对的 cookie，去 `/pair`（`features/lan/PairPage.tsx`）：设备起个名字、请主人放行，那台电脑点头后把钥匙存进 `vibevalley_lan_key` 这个 cookie（`SameSite=Strict`，十年），之后的请求和流都带着它（[连接到本机](docs/subsystems/lan.md)）。
- **一个家目录一个服务端**：服务端拿 `$VIBEVALLEY_HOME/.vibevalley.lock`（[地基](docs/subsystems/foundation.md)），所以应用和终端指向同一个家目录时，后开的那个起不来。桌面壳自己单实例：第二次打开把第一个的窗口叫到前面。

## 怎么走

**开机（桌面）**

1. Electron 拿单实例锁；拿不到就退出，让已经开着的那个出来。
2. 马上开窗口，先放页面文件里的 `opening.html`（`apps/web/public`，从应用自己的文件读，不经服务端）：工作台的地色（跟着系统的主题），过一会儿淡出头像、一根细条和「叫醒农场……」；窗口底色是工作台在当前主题下的页面色，页面换主题时跟着换，所以刷新时窗口不会闪出别的颜色。
3. 问登录 shell 要 PATH（`loginShellPath`，`$SHELL -ilc`，5 秒，问不到用原来的），因为从 Finder 或登录时打开的应用拿不到 pi、claude、codex 所在的 PATH。
4. `startServer` 用 Electron 自己的 Node（`ELECTRON_RUN_AS_NODE=1`）带 tsx 起 `apps/server/src/main.ts --ready-json --web <页面>`，`VIBEVALLEY_PORT=0`，工作目录是服务端的文件夹（开发时是仓库的 `apps/server`，打包的应用是 `Contents/Resources/server`），其余配置读家目录的 `vibevalley.yaml`。stdout 和 stderr 都追加进 `$VIBEVALLEY_HOME/logs/desktop-server.log`。
5. 等收据：服务端开始答 HTTP 以后在 stdout 写一行 JSON（`url`、`pid`）。40 秒没有、或子进程先退出，就停掉它，窗口换成同一页带着原因（`?problem=`，「农场起不来：……，日志在 ……」），关掉窗口应用退出；窗口已经被关掉时弹框说。
6. 窗口换到那个地址；注册 ⌥⇧Space（被别的程序占了也照常开，页面的通话按钮还能用）。

**打开页面**：`index.html` 构建时嵌进 `opening.html` 里同一段盖子（`apps/web/vite.config.ts` 的 `opening`），所以页面的脚本还没跑起来时就是它。它在页面的脚本之前按地址和主人的选择（`localStorage` 里 `base/prefs.ts` 的那份）定样子：农场的路径是村子的地色和「进村」条，`Root` 第一次安定下来时就拿掉，农场自己的条在同一个位置接着走；其余是工作台的地色，主题也在这时写上 `<html>`，`base/opening.ts` 等第一帧、这一页的读请求和图都齐了（最多 2 秒）再让它淡出，盖着时进来的动效直接到终点（[打开和刷新](docs/style/design.md#打开和刷新)）。

**灵动岛（macOS）**：服务端起来后，桌面壳起 `VibeValleyIsland`（开发时是 `apps/island/.build/release`，`scripts/build.ts` 编它；打包的应用在 `Contents/Resources/island`），带上页面的像素字；不是 macOS 或没编出来就只是不显示。桌面壳的主进程自己订阅 `/api/v1/state`（断了一秒后重连），每一帧用 `glanceOf` 算成一份摘要：在做、等你回答、等你验收、卡住了的工单各一行，等你的在前；在做的写帮工和它这一刻在干什么（`phaseText`），等你的写等什么（词表的 `attention`、`stuck`）；刘海两边的两句也写在摘要里（`strip`，桌面壳的词表）。摘要变了才写一行 `{"glance": …}` 到岛的 stdin。岛贴着内置屏的刘海（`safeAreaInsets` 和刘海两边的菜单栏算出位置），没有内置屏时挂在主屏菜单栏正中；收起时刘海左边是在干几个，右边是等你几个；指针移上去展开成一行一张工单（最多 6 行）；点一行，岛在 stdout 写 `{"open": "<工单>"}`，桌面壳把窗口叫到前面、开到 `/issues/<工单>`。没有在做也没有等你的，岛不出来。窗口不抢焦点，所有桌面上都有，全屏的应用上不出现。桌面壳退出时关掉岛的 stdin，岛跟着退出。

**退出**：退出前先停服务端（还在起来的，等它起来再停）：SIGTERM，让它存好状态，8 秒没退就 SIGKILL；注销快捷键。macOS 上关窗口不退出，点 Dock 图标再开窗口。

**首页**：只在这台设备第一次打开农场时出来（`localStorage` 的 `vibevalley.title.seen`），之后直接进农场，菜单的「回到首页」能回去。

**工作台的路由**（`base/router.ts`、`app/App.tsx`）：`/` 打开工作台的第一个地方（聊天），或这台设备在「设置 › 通用」选的农场（`base/prefs.ts` 的 `start`）；`/farm/<项目>` 是这个项目的农场，`/farm` 进这台设备上次进的那座（`localStorage` 的 `vibevalley.farm.project`，列表还在路上时先信它；没记过时进最近有提交的那个项目的，没有项目时是 `/farm/` 那座），`/pair` 是配对；其余在 `Shell` 外框里：`/chat`、`/issues`、`/docs`、`/agents`（`/orchestrator` 也算在「帮工」下）、`/runtimes`、`/projects`、`/catalog`，最下面是 `/settings`。`/settings` 跳到「通用」；带 id 的路径打开同一页的详情；不认识的路径回工作台。

**外观**（`base/appearance.ts`，页面一开就跟着）：主题和界面大小是这台设备的偏好（`base/prefs.ts`，`localStorage`），不进 `settings.json`：手机和电脑常常想要不一样的。主题写成 `<html data-theme>`（`light`、`dark`；「跟随系统」时照 `prefers-color-scheme` 算，系统变了跟着变），再经宿主接口的 `theme` 告诉桌面壳（`nativeTheme.themeSource`），菜单、滚动条一起变。工作台的颜色全在 `style.css` 的调色板里，按用途起名（`page`、`ink`、`ok-soft`、`warn-ink`、`scrim`、`rail`……），浅色和深色各一套 `--wb-*` 值，`@theme inline static` 把颜色名接到它们上；类名里写死颜色（`bg-[#…]`）由 lint `vibevalley/no-hex-color` 拦下，农场、记忆树、像素组件和头像是画出来的，不查，它们的根元素写 `data-theme="light"`，深色进不去。一个元素和它外面的主题可以不一样（像素皮在深色的工作台里、故事的深色画框在浅色的页面里）；一个指向别的变量的自定义属性在声明它的元素上就算好了，所以调色板的名字（`--color-*`）和代码的颜色在每个有 `data-theme` 的元素上再声明一遍，`var(--color-…)` 在哪都取到最近的那个主题。界面大小（90%–125%）是 `--workbench-zoom`，只有 `Shell` 用 CSS `zoom` 缩放；农场按整数倍放大，不跟着变。

**通知和菜单栏**（`src/features/notice/Follow.tsx`，挂在每一页上）：

- 帧的 `inbox` 里新出现的来电（做完、没做成、冲突、没动静、@主人、计划拆好、计划做完、计划卡住、管家想定的定时任务）弹系统通知；开机时已经在的来电只记下不响，同一个来电只响一次（`freshOf`）；窗口在前面时不弹；话是来电自带的 `words`（[通知](docs/subsystems/notice.md)）。
- 菜单栏的标题和菜单从帧的 `state` 和 `inbox` 算（`traySummary`）：在干活的帮工数和等你的事数，每件等你的事一行（来电的 `words.tray`），再是打开农场、退出；没变就不再发给宿主。
- ⌥⇧Space 切换和管家的通话（`voiceCall.toggle`）。

**手机壳**：第一次开（或者农场忘了这台手机）是配对页：相机扫「连接到本机」的二维码，或粘贴链接，或打开 `vibevalley://pair?u=<地址>&c=<码>` 这种链接（这一种当场就请主人放行）；那台电脑点头后，钥匙和地址存进系统钥匙串（`expo-secure-store`），之后直接是 WebView。WebView 在页面加载前把钥匙写进 `vibevalley_lan_key` 的 cookie，和浏览器配对后一样；页面要去自己的 `/pair` 时（钥匙不认了），壳忘掉这个农场、回到配对页。iOS 开着 audio 后台模式和 `NSAllowsLocalNetworking`（「连接到本机」是局域网里的明文 HTTP），安卓开着明文流量。

当前农场由 `FarmConnection` 持有，初次读盘、选择新农场、配对、取消和忘记都经它。新选择、取消或退出使旧请求失效，旧答复不能改当前选择；钥匙串写入串行完成，存好才打开新农场。取消配对恢复上次保存的农场，没有旧农场就回到配对页；旧写入已开始时先恢复上次提交的选择，恢复失败留在配对页说明原因。App 和配对页只订阅选择、提交意图。

手机的每条通话线路在桥上带自己的身份；静音、续期、挂断和字幕只归这一条。原生宿主（`apps/mobile/src/host.ts`）属于当前加载的页面；重新加载、返回配对或换农场时关闭宿主，连还在等麦克风权限、等入线的电话一起取消。原生声网只有一个引擎，`rtc.ts` 在下一次入线前结束旧尝试，按频道和本机用户号认回调；旧权限答复、旧频道排队的事件和迟到的挂断不能碰新线路。异步入线失败只认带连接身份的失败状态，不把引擎的全局错误当作某条电话的结果。锁屏不关闭页面宿主，通话继续。

**打包**：`vp run package:mac` 构建页面和壳，把 `apps/server` 连同生产依赖放进 `dist/stage/server`（服务端用到的每个 workspace 包拷成真的文件夹，`src/workspace.ts` 照 `package.json` 找），electron-builder 打出 `apps/desktop/dist` 里的 `.app` 和 `.dmg`，`web/` 放进资源，`server/` 在 `afterPack` 里整个拷进去（electron-builder 的 extraResources 会丢掉 `node_modules`）。没有签名和公证。

## 和谁打交道

- **服务端（`main.ts`、`http/app.ts`）**：主接口只听 `127.0.0.1`；`--ready-json` 在开始答 HTTP 以后写收据，`--web` 让它在 `/` 提供页面，路径没有扩展名的回 `index.html`（页面自己的路由）。桌面壳只依赖收据和「SIGTERM 会存盘」这两条。
- **「连接到本机」（`lan`）**：它的监听把页面放给任何人（页面里没有农场的东西），接口和流只放带钥匙的；配对的链接是 `http://<地址>:<端口>/pair?c=<码>`，手机相机扫开就是浏览器里的 `/pair`。
- **设置（`setting`）**：设置页读写设置，保存前问 `settings/check`；钥匙从不回到页面，页面只看到来源和末四位。
- **语音（`voice`）**：通话在 `src/features/voice/call.ts`（`voiceCall`），按钮和 ⌥⇧Space 发同一个动作；Agora 的 SDK 只在那里动态 import。
- **验证脚本**：`scripts/verify-server.ts` 起一个隔离的服务端，`acceptance/page.md` 对着它用 Playwright 截图。

## 为什么这样

- **设置按用途分组，一行一项，厂商名只在组里。** 原来九个分区平铺，有的是厂商（DeepSeek、GitHub）、有的是功能（语言），加一家厂商就多一个分区；现在「选项」「帮工」「语音」「连接」四组，同一种东西（钥匙、开关）在哪一页都是同一种行，搜索才能按行找到。放弃了页内页签（语音、连接两组的几页）：页签藏在页里，搜不到，也不能直接链过去。
- **主题是这台设备的，颜色先收进调色板再换。** 一处写死的颜色在深色里就是一块错的，照抄的人越多越难改；所以先把 28 处写死的颜色改成按用途起名的调色板，再加 lint，深色只是换一套值。放弃了只改根字号做缩放：工作台里大量像素字号不跟着变。
- **手机是 React Native 壳加 WebView，不重写页面。** 扫码、钥匙串、锁屏不断的通话、系统通知这几样浏览器做不好，所以壳是原生的；其余是 WebView 里同一份页面，规则和画面不写第二遍。放弃了只用浏览器（PWA）：iOS 上推送受限、锁屏后通话会断、扫码要先开相机 app 再跳浏览器；放弃了 Tauri 的手机端：多一门 Rust，打电话还是要写原生插件。通话交给壳的原生 SDK，页面只换一层 `Rtc`：会话、字幕、和管家的往来照旧在页面里，桥上只走一条线该做的几件事。
- **一份页面，三个宿主。** 桌面、浏览器、手机各写一份界面时，规则和画面都要写几遍；一份页面由服务端提供，宿主只补它没有的能力。放弃了留在 Flutter（规则在 Go 和 Dart 写两遍，形状靠生成器搬）和 Tauri（多一门 Rust，系统 WebView 回到 WKWebView 的语音问题）。
- **页面用 Solid 2。** 帧来得密：React 每来一帧，读它的组件全部重渲染；Solid 的组件只跑一次，帧按 id 合并进 store 后只更新读了变动字段的地方，不用手写选择器和 `memo`，也没有依赖数组和为闭包读旧值写的 ref。Pixi 舞台、声网通话、两条流都是外面自己会变的东西，接成信号比 `useSyncExternalStore` 加 ref 直接。放弃了留在 React 加选择器（解决了重渲染，依赖数组和 ref 还在）、Solid 1.9（2.0 改得多，等于再迁一次）和长期两种框架并存（两套写法，agent 不知道该抄哪个）。代价是 2.0 还是 RC：`solid-js`、`@solidjs/web`、`@tanstack/solid-query`、`@solidjs/vite-plugin` 钉死在具体版本，升级单独做；模型多半只会写 1.x，`eslint-plugin-solid` 的 v2 规则（经 oxlint 的 JS 插件）挡住删掉的 API、一个参数的 effect、解构的 props 和提前 `return` 的组件，语义变了、名字没变的写法（写完马上读到旧值、读窄化的值）靠 Playwright。
- **按概念分 feature，feature 之间准用，只走出口、不成环。** 以前一个概念的页、读取、规则和字分在 `pages/`、`data/`、`rules/` 和共用的词表里，改工单要动四处；现在和服务端一样，一个概念一个文件夹。大仓库的分法在一件事上不一样：feature 之间能不能互相 import。bulletproof-react 和 Feature-Sliced Design 不准（FSD 另加 entities、widgets 两层来拼），VS Code 的 `workbench/contrib/*` 随便互相用。我们的概念本来就互相嵌着（工单详情里是帮工的干活过程，群聊里是档案的脸），全不准就得把这些都挪进上层或再加一层；随便用，环会越积越多：拆之前设置页的四栏、群聊和干活过程、工单和计划都互相依赖，原因都是放错地方的字和小函数。所以准用，但只经出口（具名导出，不用 `export *`），图不成环。FSD 的 entities、Huly 每个概念一个的契约包，在这里是 `@vibevalley/protocol`，页面不再加一层。放弃了 FSD 的六层（按「东西」还是「动作」归类，争论比收益大）和一个概念一个包（每个都要 `package.json`）。皮不拆进 feature：农场的 store、部件和 world 是一体的，「种地的词只在皮里」也靠目录分界查。
- **路由自己写。** 只要一个路径信号、`navigate` 和按前缀分发；`@solidjs/router` 的 2.0 还在预发布。
- **Electron 用自己的 Node 跑服务端。** 应用里不必再带一份 Node；服务端照样不打包，和仓库里跑的是同一份源码。代价是应用约 300 MB。
- **推折好的整份状态，页面不折。** 页面再写一份 `reduce` 就是第二份核心状态，两边改规则靠自觉对齐。推整份的代价是带宽：一份真实状态几十 KB，本机和局域网没问题；要换增量时，增量格式又是一份两端都要遵守的约定。
- **页面问服务端，不移植规则。** 页面要的只是结论；档案的问题依赖没存的草稿，记性的预览依赖主人正在打的字，都不是农场的状态，所以另开接口问。服务端和页面都要的纯规则放进 `packages/protocol`，一份代码两处用。
- **只给真实数据。** 服务端没开时换成模拟农场，提示再大也会被当成真的；没有服务端就说没有。
- **窗口先开，再等服务端。** 等服务端时没有窗口，双击以后几秒（第一次开、要建库时十来秒）屏幕上什么都没有，像没打开。加载条是一个不靠服务端、也不跑页面脚本的静态文件，所以能在服务端起来之前从应用自己的文件里打开；页面的 `index.html` 带着同一段，换页时画面不跳。放弃了在 Electron 里另画一个窗口（两份样子），和弹系统的启动画面（不像游戏，起不来时也说不了原因）。
- **灵动岛是原生的，单独一个进程。** 刘海边上要像系统的一部分：不抢焦点、所有桌面都在、点击区域就是岛的形状、动画跟着系统，这些是 AppKit 的窗口才做得好的。放在 Electron 里用 `type: 'panel'` 的网页窗口能做出样子，但它是一个 Chromium 页面挂在刘海上；写成 Node 原生插件要和 Electron 同一个进程，崩了一起倒。单独的进程经 stdin、stdout 一行一个 JSON 说话，崩了只是岛不见。不用 boring.notch 那样的私有接口把岛盖到全屏应用上：苹果的私有接口随时会变，全屏时本来也不该挡。
- **岛的数据由桌面壳的主进程读，不经页面。** 窗口关掉以后页面就不在了，靠页面推的东西会停；岛要的是农场一直在干什么。规则用 `@vibevalley/protocol` 里页面也在用的说法（`phaseText`、词典的 `shared`），摘要在主进程算好，岛只画，自己不带一个字：语言跟着桌面壳（[话放在哪](docs/subsystems/foundation.md#话放在哪)）。
- **子进程自己发布就绪地址。** 宿主先绑端口 0、读出端口、关掉再交给服务端，关掉到重绑之间端口可能被抢；从人读的日志里找地址，日志措辞就成了协议。绑定结果只有子进程知道，所以由它写一行 JSON 说出来。
- **宿主接口封闭、缺的是 null。** 页面问「我在哪个壳里」再分支，每加一个宿主就要改每一处；按能力有没有来画，加宿主只是实现一遍接口。
- **连进来的浏览器用 cookie 带钥匙。** 页面的状态流和 REST 都走 `fetch`，同源的 cookie 自动带上，页面不用改；监听只认 cookie 和 `Bearer` 头，不把钥匙转给本机的服务端。
- **首页只给第一次来的人。** 天天用的人每次都要先点「继续游戏」，点开一条通知也被首页挡住要多点一次。不做「新游戏」清档：农场里是主人的频道、账本和帮工的分支，一个按钮清掉代价太大。
- **说明收进 ⓘ，状态用图标。** 表单的字段只留名字，它是什么、怎么填放在名字旁 ⓘ 的悬停提示里（`ui/Tip.tsx` 的 `Hint`，只描述、不当标签）；钥匙在不在用、从哪来是名字旁的一个标记，悬停才说（`ui/KeyField.tsx` 的 `KeyMark`）；移除是垃圾桶，点了变成撤销，保存时才生效；保存和撤销在有改动时才出现（`SaveBar`），存好了用 toast 说。放弃了每个字段下面一行灰字：一页几十句，主人要找的那个控件反而被淹掉。
- **会动的部件用自己的无样式组件库。** 菜单、浮层、标签页、提示这类部件的键盘、焦点、ARIA 和开合，各页手写过一遍（几十处 `aria-expanded`、各自的点外面关掉，提示碰到窗口边被切掉），由 `packages/base-ui` 收成一套：照 Base UI 的部件划分（`Menu.Root`、`Menu.Trigger`……）、属性名和 data 属性（`data-open`、`data-checked`、`data-highlighted`、`data-side`），用 Solid 2 的写法重写，样式和页面测试都按 data 属性写；浮层用 `@floating-ui/dom` 贴着触发它的那个、碰边翻面，在模态对话框里时放进对话框。它的测试在真的 Chromium 里跑（Vitest 的浏览器模式），断言键盘、焦点、ARIA、位置，每个组件过一次 axe。放弃了 Kobalte、Ark UI、Corvu：都要 Solid 1；也放弃了照着 Base UI 的 React 源码逐行翻译：渲染、ref 和 effect 的模型差得远。退场动画没做，浮层关了就卸载；像素皮（`ui/pixel`）还用自己的。
- **工作台用线条图标，像素图留给皮和画。** 工作台是 Linear 那样的工作界面，像素贴图在密的版面里像一排 emoji，和本来就是矢量的状态圈、头像以外的界面对不上。图标按意思起名、集中在一张表里，同一个意思在每页是同一个图，换一套图只改这张表；像素皮仍用照 Hugeicons 画的贴图，所以两边的形状认得出来。放弃了让 `<Icon>` 看自己在哪张皮里再选图：那样每个图标都要有两份，皮的边界也藏进了组件里。用 reicon 的原生 JS 包，不用框架包：它没有 Solid 的版本，每个图标是一个返回 `<svg>` 的函数，Solid 直接放进页面。
- **零件的故事自己写一个小的，不用 Storybook。** 改零件的多半是 agent，它要一个地方看一个零件的每种状态、两种主题和窄窗口，还要能被测试逐个打开跑 axe；图鉴里那一页固定的样子做不到。Storybook 的 Solid 渲染器是给 Solid 1 的，还自带一套构建；`packages/stories` 只有格式和一个查看器，用页面自己的 Vite、Tailwind 和令牌，构建到 `dist-stories/`，不进产品的包。头几轮 axe 就找出了消息里的勾选框没有名字、代码块键盘够不着、像素木牌的字不够深，和深色的零件放进浅色里时代码和图的颜色跟错主题。
- **设置是工作台的一页。** 首页、扳手和缺钥匙的开始游戏都进 `/settings`，不另开一处设置窗口。

## 还没做的

- 手机的竖屏版面：[手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)。
- 页面关着时的推送（APNs、厂商通道）：现在页面开着时弹本地通知，关着时靠连接器。
- 连进来的设备看得到只有主人能用的地方（设置、档案的编辑），点了才被拒。
- 状态流改成增量；Windows 版；Developer ID 签名、公证和自动更新；发布渠道（alpha、beta）。

## 怎么验证

- 页面的规则：各 feature 里的 `*.test.ts`（看板、通知和菜单栏摘要、一轮的瀑布图、项目、文档的块、远端和配对……），和 `ui/pixel`、`farm` 里的；`src/layers.test.ts` 查 feature 之间不成环，lint 的 `vibevalley/page-layers` 查层的方向和出口。
- 零件：每个 `ui/`、`ui/pixel/` 的零件旁边有 `X.stories.tsx`（`src/stories.test.ts` 查），`test/stories.spec.ts` 把每个故事在它的主题里打开，没有报错、axe 通过；`vp run --filter @vibevalley/web stories` 自己看。
- 每块页面的 Playwright：`apps/web/test/*.spec.ts`，每个 worker 一个真的服务端；`shell.spec.ts` 查每个地方在自己的外框里打开，`pair.spec.ts` 查一台「手机」经「连接到本机」配对后打开工单。
- 桌面壳：`apps/desktop/test/app.spec.ts` 起整个 Electron 应用（临时家目录），查看板、系统通知、菜单栏摘要和快捷键；家目录是个文件、服务端起不来时，窗口先开在加载条上，再换成原因；服务端用照字眼干活的帮工（`VIBEVALLEY_TEST_RUNTIMES`）时，一张先问清楚的工单进了岛的摘要（「等你回答」），macOS 上岛真的起来了，点它把窗口开到那张工单。`apps/desktop/src/island.test.ts` 查摘要的规则。
- 灵动岛：`apps/island` 的 `swift test`（消息、刘海和没有刘海时的位置），CI 的 `island` 跑在 macOS 上；样子用 `--snapshot` 画成图看（`apps/island/README.md`）。
- 打包：`vp run package:mac` 后用临时家目录开 `apps/desktop/dist/mac-arm64/VibeValley.app`，`desktop-server.log` 里有收据，`curl` 那个地址拿到页面和接口。
- 真程序：`acceptance/page.md`（Playwright 对着 `scripts/verify-server.ts` 起的服务端截每一页）。
