# 客户端

VibeValley 只有一份界面：Solid 2 写的页面 `apps/web`，由服务端在 `/` 提供，桌面壳、浏览器和手机的壳打开的都是它。它读服务端折好的帧（`StateFrame`），经 `@vibevalley/protocol` 的 `VibeValleyApi` 发命令，自己不折事实、不重写服务端的规则；`/` 是像素农场（`src/farm`），其余是工作台（`src/pages`）。桌面版是 Electron 壳 `apps/desktop`：用自己的 Node 带着服务端起来、打开它的页面，另有菜单栏、系统通知和语音快捷键；手机的壳是 `apps/mobile`（Expo、React Native）：扫码配对，在 WebView 里打开那台电脑经「连接到本机」放出的页面，另有系统通知和锁屏也不断的通话。两个壳都经 `@vibevalley/host` 给页面。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 状态流、重连、连不上时说什么 | 帧里有什么、怎么折（[architecture.md](docs/architecture.md)「核心状态」、`frameOf`） |
| 页面的目录和数据层：一条状态流、Solid Query 的读取、共用的 store | 形状和接口的定义（`packages/protocol`） |
| 工作台的路由和外框、首页 | 规则本身：能不能派、档案的问题、下回想起什么、冲突怎么交代（各自的子系统，页面问服务端） |
| 宿主接口：通知、菜单栏、语音快捷键、宿主自己的通话线路、窗口没有自己的标题栏时让出的地方；没有的是 null | 像素农场的画面、玩法和面板（[farm.md](docs/subsystems/farm.md)；每页的内容见 [farm-ui.md](docs/reference/farm-ui.md)「界面清单」） |
| 桌面壳：服务端子进程的生命周期和就绪、窗口、单实例、打包；手机壳：配对、WebView、通知、通话 | 服务端的监听、家目录租约（[地基](docs/subsystems/foundation.md)） |
| 连进来的浏览器：先配对，钥匙存在 cookie | 「连接到本机」的配对和鉴权（[连接到本机](docs/subsystems/lan.md)）；语音通话（[语音](docs/subsystems/voice.md)） |

包的对外约定（目录表、规矩、命令）在 [apps/web/README.md](apps/web/README.md) 和 [农场的 README](apps/web/src/farm/README.md)，这里不重复。

## 在哪

- **组合**：`apps/web/src/main.tsx`：没配对的远端浏览器先去 `/pair`，再画 `app/App.tsx`：`Root`（路由、状态流、农场的 store、查询的缓存、一个 `<Loading>`）里是 `Follow`（通知、菜单栏、快捷键）、路由和 `ToastHost`。
- **数据层** `src/data/`：`frames.ts`（状态流，和框架无关：`subscribe`、`get`）、`frame.ts`（接成 Solid 的 store：`createFrames`、`useFrames`、`useCore`）、`external.ts`（`createExternal`：把框架无关的 store 接成信号）、`api.ts`（`api`、`reasonOf`）、`live.ts`（`/api/v1/live`）、`sessionLogs.ts`（每个 Session 的快照、增量与重连补读）、`sessions.ts`（页面的日志订阅）、`query.ts`（`queries`、`ready` 和按对象的读取）、`agents.ts`、`issues.ts`。
- **工作台** `src/app/`：`router.ts` 是路由（浏览器历史上的一个信号，`navigate`），`A.tsx` 是页内的链接，`places.ts` 是左栏的地方，`Shell.tsx` 是外框；每个地方一个 `src/pages/<地方>/`，共用的版面在 `pages/kit.tsx`，共用的组件在 `src/ui/`。
- **页面的规则** `src/rules/`：只读帧和回答的纯函数（看板的分栏、频道的未读、一轮的瀑布图、通知的说法、远端和配对），各带 vitest。
- **宿主** `packages/host`：`Host`（`notify`、`tray`、`voiceShortcut`、`rtc`、`titleBar`）、`currentHost()`、没有宿主时的 `browserHost`；`mobile.ts` 是手机壳和页面之间的桥（`ToNative`、`FromNative`、`mobileHost`）。
- **桌面壳** `apps/desktop`：`src/main.ts`（窗口、菜单栏、通知、快捷键、单实例、退出）、`src/server.ts`（`loginShellPath`、`startServer`）、`src/preload.ts`（把宿主接口交给页面）；`scripts/build.ts`、`scripts/package.ts`（`bun run package:mac`）。
- **手机壳** `apps/mobile`：`App.tsx`（跟随当前农场选择）、`src/PairScreen.tsx`（扫码、粘贴、配对或取消）、`src/FarmScreen.tsx`（WebView 和桥）、`src/farm.ts`（`FarmConnection`：当前农场、配对和系统钥匙串提交）、`src/rtc.ts`（声网的原生 SDK）、`src/notify.ts`、`src/rules.ts`；`ios/`、`android/` 由 `expo prebuild` 从 `app.json` 生成，不进仓库（[README](apps/mobile/README.md)）。
- **检查**：`bun run web:check`、`cd apps/web && bun run test`、`bun run desktop:test`；手机壳是 `cd apps/mobile && bun run check && bun run test` 和 `scripts/e2e.ts`。

## 模型和不变量

- **服务端是核心状态唯一的持有者。** 页面经 `GET /api/v1/state` 收整份 `StateFrame`（`state`、`inbox`、`graphs`、`view`、`effects`），状态变了就再推一份；经 `GET /api/v1/live` 收 `LiveEvent`（干活过程的一步、提醒、农机变了）。页面不读事实，`/api/v1/events` 留给命令行和调试。
- **页面不折事实，也不重写服务端的规则。** 给人看的结论由服务端算好：跟着状态走的话在出帧时填（`Session.phaseText`、`Recurrence.whenText`、`nextText`、`Progress.multiplier`），跟着草稿走的另开一个接口问（档案的问题 `POST /api/v1/agents/check`、新项目会被拒的第一处 `POST /api/v1/projects/check`、设置会被拒的第一处 `POST /api/v1/settings/check`、记性的预览 `GET /api/v1/memories/{agent}/recall`、交代冲突是工单的动作 `resolve`（`POST /api/v1/issues/{id}/act`）、播种袋的工单模板 `GET /api/v1/projects/{id}/templates`）；农机为什么不能派、额度剩几成在 `RuntimeInfo.stop`、`RuntimeInfo.quota` 里，叫什么、长什么样在 `RuntimeInfo.preset`、`RuntimeInfo.facts` 里（[档案和农机](docs/subsystems/agent.md)）；成就的说法是 `game.achievements`，进度在每帧的 `view.achievements`（[游戏](docs/subsystems/game.md)）。服务端和页面都要的规则在 `packages/protocol/src/rules`，页面 import 的就是服务端用的那份。
- **`src/rules/` 只是读帧的纯函数**：哪些频道、未读几条、庄稼熟没熟、看板怎么分栏，只给页面用；跟着墙上时钟走的画面（走路、动画、小游戏的局面）也只在页面。
- **一条状态流**：`data/frames.ts` 给整个页面开一条 `/api/v1/state`，断了一秒后重连；连着、在连、断了（`link`）在外框的小灯和农场的提示里说。没有模拟服务器：连不上就说连不上，页面是空的，不换成假数据。
- **REST 的读取经查询模块**（`data/query.ts`）：`QueryClient` 和 `QueryObserver` 拥有缓存、重试、轮询和请求去重，Solid 只订阅观察者的结果。一个查询键一种形状（`["projects"]` 只有 `ProjectSummary[]`）；帧里的变化让相关查询失效再读。等待、失败是结果值，`ready(query, fallback)` 选择成功数据；重新读取不挂起状态帧，换查询键时的旧值由 `placeholderData` 决定。卸载页面先退订观察者，请求回来只更新缓存。
- **干活过程由一个读取模块持有**：`SessionLogs` 为正在看的每个 Session 共享一份日志，先订阅再读快照；直播流每次连上都补读，断线期间已经完成、不再发事件的步骤也能回来。快照替换保留窗口，读取期间收到的步骤按 `seq` 和 `revision` 合并，旧直播片段不能盖掉新快照。最后一个读者离开就释放日志；工作台、农场、轨迹和消息下的步骤都经 `createSessionEvents` 读，不按帮工的阶段猜刷新时机。日志的信号不挂起同页的时间线和改动查询。
- **界面读按 id 合并的帧**：`createFrames` 把每一帧按 id `reconcile` 进 Solid 的 store，只有变了的字段触发更新；要比前后两帧的（音效、画布、来电、特效）读原始的帧（`rawFrame()`）。农场的 store、toast、通话、听写是和框架无关的模块，经 `createExternal` 接进来。
- **一处响应性出错，整页停住**：一个错误逃出所有边界时 Solid 停掉整页的更新（`REACTIVITY_HALTED`），页面看着还在、不再动。`<Show>`、`<Match>` 的函数子节点拿到的值在分支收起后一读就抛，分支里还在结算的查询会读到它，所以带查询的面板按普通值 keyed、自己记住最后找到的那个；`ref` 的回调不读 `<For>` 每一项的值。Playwright 里逃出页面的错误让用例失败（`test/fixtures.ts`）。
- **宿主接口是封闭的**：每个宿主实现全部方法，没有的能力是 null，页面据此决定画不画，不问「我在哪个壳里」。桌面壳经 preload 的 `contextBridge` 给（`contextIsolation`、`sandbox`，页面碰不到 Node 和 Electron）；手机壳的 WebView 带着 `ReactNativeWebView`，`currentHost()` 见到它就建 `mobileHost`：页面把要的东西写成 JSON 发过去，壳按 id 答，通话的事件也这样送回（`window.vibevalleyFromHost`）；浏览器全是 null。
- **桌面窗口是沉浸式的**（macOS）：窗口没有自己的标题栏，页面画到顶边，红绿灯浮在左上角；宿主的 `titleBar`（`{ top: 28, left: 76 }`）说顶上那一条多高、红绿灯占到多宽。页面最前面放一条这么高的拖动条（`app/TitleBar.tsx` 的 `WindowStrip`，`-webkit-app-region: drag`），条里的按钮、链接、输入框照样能点（`style.css` 的 `no-drag`）；工作台的侧栏顶上、农场左上角那组 HUD 让出这一条。窗口的内容区默认 1152×768，拖动时保持 3:2，农场正好铺满（[农场的皮](docs/subsystems/farm.md)「放大只用整数倍」）。从仓库跑时 Dock 上的图标是 `apps/web/public/icons/app-256.png`，打包的用 `resources/icon.icns`。其他系统和浏览器、手机是 null，用自己的标题栏。
- **通话的线路可以归宿主**：`VoiceCall` 只认 `Rtc`（`join` 出一条能 `mute`、`renew`、`leave` 的线，事件是来了、走了、字幕、两边的音量、出错、令牌快过期），有 `host.rtc` 就用宿主的（手机的原生 SDK，锁屏不断），没有就用页面自己的声网 Web SDK（`voice/agora.ts`）。会话、字幕、交给管家的话都还在页面里。
- **页面总在服务端的源上**：页面和接口同源，没有 CORS；桌面窗口只停在服务端的地址上，别的链接交给系统浏览器。
- **连进来的浏览器先配对**：不是 `127.0.0.1`、`localhost` 打开的页面，又没有配对的 cookie，去 `/pair`（`src/pages/pair`）：设备起个名字、请主人放行，那台电脑点头后把钥匙存进 `vibevalley_lan_key` 这个 cookie（`SameSite=Strict`，十年），之后的请求和流都带着它（[连接到本机](docs/subsystems/lan.md)）。
- **一个家目录一个服务端**：服务端拿 `$VIBEVALLEY_HOME/.vibevalley.lock`（[地基](docs/subsystems/foundation.md)），所以应用和终端指向同一个家目录时，后开的那个起不来。桌面壳自己单实例：第二次打开把第一个的窗口叫到前面。

## 怎么走

**开机（桌面）**

1. Electron 拿单实例锁；拿不到就退出，让已经开着的那个出来。
2. 问登录 shell 要 PATH（`loginShellPath`，`$SHELL -ilc`，5 秒，问不到用原来的），因为从 Finder 或登录时打开的应用拿不到 pi、claude、codex 所在的 PATH。
3. `startServer` 用 Electron 自己的 Node（`ELECTRON_RUN_AS_NODE=1`）带 tsx 起 `apps/server/src/main.ts --ready-json --web <页面>`，`VIBEVALLEY_PORT=0`，工作目录是服务端的文件夹（开发时是仓库的 `apps/server`，打包的应用是 `Contents/Resources/server`），其余配置读家目录的 `vibevalley.yaml`。stdout 和 stderr 都追加进 `$VIBEVALLEY_HOME/logs/desktop-server.log`。
4. 等收据：服务端开始答 HTTP 以后在 stdout 写一行 JSON（`url`、`pid`）。40 秒没有、或子进程先退出，就停掉它，弹框说原因和日志在哪，应用退出。
5. 开窗口到那个地址；注册 ⌥⇧Space（被别的程序占了也照常开，页面的通话按钮还能用）。

**退出**：退出前先停服务端：SIGTERM，让它存好状态，8 秒没退就 SIGKILL；注销快捷键。macOS 上关窗口不退出，点 Dock 图标再开窗口。

**首页**：只在这台设备第一次打开农场时出来（`localStorage` 的 `vibevalley.title.seen`），之后直接进农场，菜单的「回到首页」能回去。

**工作台的路由**（`app/router.ts`、`app/App.tsx`）：`/farm/<项目>` 是这个项目的农场，`/` 进这台设备上次进的那座（`localStorage` 的 `vibevalley.farm.project`，列表还在路上时先信它；没记过时进最近有提交的那个项目的，没有项目时是 `/farm/` 那座），`/pair` 是配对；其余在 `Shell` 外框里：`/chat`、`/issues`、`/docs`、`/agents`（`/orchestrator` 也算在「帮工」下）、`/runtimes`、`/projects`、`/catalog`，最下面是 `/settings`。`/settings` 跳到 DeepSeek 分区；带 id 的路径打开同一页的详情；不认识的路径回农场。

**通知和菜单栏**（`src/app/Follow.tsx`，挂在每一页上）：

- 帧的 `inbox` 里新出现的来电（做完、没做成、冲突、没动静、@主人、计划拆好、计划熟了、计划卡住、管家想定的定时）弹系统通知；开机时已经在的来电只记下不响，同一个来电只响一次（`freshOf`）；窗口在前面时不弹；话是来电自带的 `words`（[通知](docs/subsystems/notice.md)）。
- 菜单栏的标题和菜单从帧的 `state` 和 `inbox` 算（`traySummary`）：在干活的帮工数和等你的事数，每件等你的事一行（来电的 `words.tray`），再是打开农场、退出；没变就不再发给宿主。
- ⌥⇧Space 切换和管家的通话（`voiceCall.toggle`）。

**手机壳**：第一次开（或者农场忘了这台手机）是配对页：相机扫「连接到本机」的二维码，或粘贴链接，或打开 `vibevalley://pair?u=<地址>&c=<码>` 这种链接（这一种当场就请主人放行）；那台电脑点头后，钥匙和地址存进系统钥匙串（`expo-secure-store`），之后直接是 WebView。WebView 在页面加载前把钥匙写进 `vibevalley_lan_key` 的 cookie，和浏览器配对后一样；页面要去自己的 `/pair` 时（钥匙不认了），壳忘掉这个农场、回到配对页。iOS 开着 audio 后台模式和 `NSAllowsLocalNetworking`（「连接到本机」是局域网里的明文 HTTP），安卓开着明文流量。

当前农场由 `FarmConnection` 持有，初次读盘、选择新农场、配对、取消和忘记都经它。新选择、取消或退出使旧请求失效，旧答复不能改当前选择；钥匙串写入串行完成，存好才打开新农场。取消配对恢复上次保存的农场，没有旧农场就回到配对页；旧写入已开始时先恢复上次提交的选择，恢复失败留在配对页说明原因。App 和配对页只订阅选择、提交意图。

手机的每条通话线路在桥上带自己的身份；静音、续期、挂断和字幕只归这一条。原生宿主（`apps/mobile/src/host.ts`）属于当前加载的页面；重新加载、返回配对或换农场时关闭宿主，连还在等麦克风权限、等入线的电话一起取消。原生声网只有一个引擎，`rtc.ts` 在下一次入线前结束旧尝试，按频道和本机用户号认回调；旧权限答复、旧频道排队的事件和迟到的挂断不能碰新线路。异步入线失败只认带连接身份的失败状态，不把引擎的全局错误当作某条电话的结果。锁屏不关闭页面宿主，通话继续。

**打包**：`bun run package:mac` 构建页面和壳，把 `apps/server` 连同生产依赖放进 `dist/stage/server`（`packages/protocol` 拷成真的文件夹），electron-builder 打出 `apps/desktop/dist` 里的 `.app` 和 `.dmg`，`web/` 放进资源，`server/` 在 `afterPack` 里整个拷进去（electron-builder 的 extraResources 会丢掉 `node_modules`）。没有签名和公证。

## 和谁打交道

- **服务端（`main.ts`、`http/app.ts`）**：主接口只听 `127.0.0.1`；`--ready-json` 在开始答 HTTP 以后写收据，`--web` 让它在 `/` 提供页面，路径没有扩展名的回 `index.html`（页面自己的路由）。桌面壳只依赖收据和「SIGTERM 会存盘」这两条。
- **「连接到本机」（`lan`）**：它的监听把页面放给任何人（页面里没有农场的东西），接口和流只放带钥匙的；配对的链接是 `http://<地址>:<端口>/pair?c=<码>`，手机相机扫开就是浏览器里的 `/pair`。
- **设置（`setting`）**：设置页读写设置，保存前问 `settings/check`；钥匙从不回到页面，页面只看到来源和末四位。
- **语音（`voice`）**：通话在 `src/voice/call.ts`（`voiceCall`），按钮和 ⌥⇧Space 发同一个动作；Agora 的 SDK 只在那里动态 import。
- **验证脚本**：`scripts/verify-server.ts` 起一个隔离的服务端，`verify-app` 对着它用 Playwright 截图。

## 为什么这样

- **手机是 React Native 壳加 WebView，不重写页面。** 扫码、钥匙串、锁屏不断的通话、系统通知这几样浏览器做不好，所以壳是原生的；其余是 WebView 里同一份页面，规则和画面不写第二遍。放弃了只用浏览器（PWA）：iOS 上推送受限、锁屏后通话会断、扫码要先开相机 app 再跳浏览器；放弃了 Tauri 的手机端：多一门 Rust，打电话还是要写原生插件。通话交给壳的原生 SDK，页面只换一层 `Rtc`：会话、字幕、和管家的往来照旧在页面里，桥上只走一条线该做的几件事。
- **一份页面，三个宿主。** 桌面、浏览器、手机各写一份界面时，规则和画面都要写几遍；一份页面由服务端提供，宿主只补它没有的能力。放弃了留在 Flutter（规则在 Go 和 Dart 写两遍，形状靠生成器搬）和 Tauri（多一门 Rust，系统 WebView 回到 WKWebView 的语音问题）。
- **页面用 Solid 2。** 帧来得密：React 每来一帧，读它的组件全部重渲染；Solid 的组件只跑一次，帧按 id 合并进 store 后只更新读了变动字段的地方，不用手写选择器和 `memo`，也没有依赖数组和为闭包读旧值写的 ref。Pixi 舞台、声网通话、两条流都是外面自己会变的东西，接成信号比 `useSyncExternalStore` 加 ref 直接。放弃了留在 React 加选择器（解决了重渲染，依赖数组和 ref 还在）、Solid 1.9（2.0 改得多，等于再迁一次）和长期两种框架并存（两套写法，agent 不知道该抄哪个）。代价是 2.0 还是 RC：`solid-js`、`@solidjs/web`、`@tanstack/solid-query`、`@solidjs/vite-plugin` 钉死在具体版本，升级单独做；模型多半只会写 1.x，`eslint-plugin-solid` 的 v2 规则（经 oxlint 的 JS 插件）挡住删掉的 API、一个参数的 effect、解构的 props 和提前 `return` 的组件，语义变了、名字没变的写法（写完马上读到旧值、读窄化的值）靠 Playwright。
- **路由自己写。** 只要一个路径信号、`navigate` 和按前缀分发；`@solidjs/router` 的 2.0 还在预发布。
- **Electron 用自己的 Node 跑服务端。** 应用里不必再带一份 Node；服务端照样不打包，和仓库里跑的是同一份源码。代价是应用约 300 MB。
- **推折好的整份状态，页面不折。** 页面再写一份 `reduce` 就是第二份核心状态，两边改规则靠自觉对齐。推整份的代价是带宽：一份真实状态几十 KB，本机和局域网没问题；要换增量时，增量格式又是一份两端都要遵守的约定。
- **页面问服务端，不移植规则。** 页面要的只是结论；档案的问题依赖没存的草稿，记性的预览依赖主人正在打的字，都不是农场的状态，所以另开接口问。服务端和页面都要的纯规则放进 `packages/protocol`，一份代码两处用。
- **只给真实数据。** 服务端没开时换成模拟农场，提示再大也会被当成真的；没有服务端就说没有。
- **子进程自己发布就绪地址。** 宿主先绑端口 0、读出端口、关掉再交给服务端，关掉到重绑之间端口可能被抢；从人读的日志里找地址，日志措辞就成了协议。绑定结果只有子进程知道，所以由它写一行 JSON 说出来。
- **宿主接口封闭、缺的是 null。** 页面问「我在哪个壳里」再分支，每加一个宿主就要改每一处；按能力有没有来画，加宿主只是实现一遍接口。
- **连进来的浏览器用 cookie 带钥匙。** 页面的状态流和 REST 都走 `fetch`，同源的 cookie 自动带上，页面不用改；监听只认 cookie 和 `Bearer` 头，不把钥匙转给本机的服务端。
- **首页只给第一次来的人。** 天天用的人每次都要先点「继续游戏」，点开一条通知也被首页挡住要多点一次。不做「新游戏」清档：农场里是主人的田头、账本和帮工的分支，一个按钮清掉代价太大。
- **设置是工作台的一页。** 首页、扳手和缺钥匙的开始游戏都进 `/settings`，不另开一处设置窗口。

## 还没做的

- 手机的竖屏版面：[手机竖屏版面](.agents/notes/proposed/feature/2026-10-09-mobile-layout.md)。
- 页面关着时的推送（APNs、厂商通道）：现在页面开着时弹本地通知，关着时靠连接器。
- 连进来的设备看得到只有主人能用的地方（设置、档案的编辑），点了才被拒。
- 状态流改成增量；Windows 版；Developer ID 签名、公证和自动更新；发布渠道（alpha、beta）。

## 怎么验证

- 页面的规则：`apps/web/src/rules/*.test.ts`（看板、通知和菜单栏摘要、一轮的瀑布图、项目、文档的块、远端和配对……）。
- 每块页面的 Playwright：`apps/web/test/*.spec.ts`，每个 worker 一个真的服务端；`shell.spec.ts` 查每个地方在自己的外框里打开，`pair.spec.ts` 查一台「手机」经「连接到本机」配对后打开工单。
- 桌面壳：`apps/desktop/test/app.spec.ts` 起整个 Electron 应用（临时家目录），查看板、系统通知、菜单栏摘要和快捷键。
- 打包：`bun run package:mac` 后用临时家目录开 `apps/desktop/dist/mac-arm64/VibeValley.app`，`desktop-server.log` 里有收据，`curl` 那个地址拿到页面和接口。
- 真程序：`verify-app`（Playwright 对着 `scripts/verify-server.ts` 起的服务端截每一页）。
