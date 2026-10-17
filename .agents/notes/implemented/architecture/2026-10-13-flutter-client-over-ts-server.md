# Agent Note: 客户端迁到 Flutter，完整复刻网页版

Status: implemented

## Problem

主人想在手机（iOS、Android）和桌面（macOS、Windows）上都用 VibeValley，一套客户端代码管所有端。当时只有网页和包着它的 Electron 桌面版：手机上没有可用的客户端，语音在 WebView 里不如原生 SDK 稳，Electron 的包也重。

能拿来做多端的东西里，主人倾向 Flutter：一套 Dart 代码出 iOS、Android、macOS、Windows 的原生应用，Agora 有官方的 Flutter SDK（RTC 和 RTM），对话式 AI 的官方示例也有 Flutter 版。还有一个选项是连后端一起换：smith（现在在 `server/pkg/smith`）是 oar 的 Go 移植，行为测试和 TS 版一致，可以在它上面包一个 Go 服务端。

难处在于 VibeValley 的规矩是**核心状态只有一份**（[理由](2026-10-11-farm-core-state.md)）：protocol 的形状、`reduce` 和规则用 TypeScript 写一次，服务端、页面、模拟服务器共用。一个不同语言的客户端，最容易长出第二份。

## Decision

**Flutter 客户端（`app`）是唯一的客户端，完整复刻了网页版，规则只在服务端一份。** 说明在 [app/README.md](../../../../app/README.md)，桌面版的行为见 [desktop.md](../../../../docs/reference/desktop.md)。Electron 版删掉了（[一个服务端、一个客户端](../simplification/2026-10-14-one-server-one-client.md)），网页先冻结、后来也删了（[网页退役](../simplification/2026-10-14-retire-the-web-page.md)）。

1. **服务端是核心状态唯一的持有者**：Go 服务端（[服务端用 Go 重写](2026-10-13-go-server-on-smith.md)）。Flutter 经 `VibeValleyApi` 发命令，经 `GET /api/v1/state` 收**折好的** `CoreState`（状态变了就再推一整份，至多每 200 毫秒一份），不折事实、不写 `reduce`。`/api/v1/events` 当时留给冻结的网页（网页删了以后这条流照旧带着事实），Flutter 只读它去掉事实以后的部分（步骤、提醒、农机的变化）。
2. **游戏规则在 protocol 里。** 帮工在哪块地、做过什么、本轮的工具和计数、碰过的文件（`Helper.play`），等级和经验、地块（`view`）、来电（当时在 `view` 里，现在是 `StateFrame` 的 `inbox`，[Inbox](2026-10-15-inbox.md)），升级、成就这类一次性的特效（`StateFrame` 的效果）都是 `CoreState` 的字段或由它推出来，在 `Reduce`、`ViewOf` 和 `EffectsOf` 里算，服务端推下来。只属于画面、跟着墙上时钟走的（散步、走位、动画、小游戏的局面）在 Dart 里写，照 core 的测试移植。
3. **像素村用 Flame 写**：地图（LDtk）、精灵、A* 寻路（`engine/nav` 逐行移植）、走路和动画、光照（`engine/pixi/light.ts` 的两遍延迟光照改写成 Flutter 的 `FragmentProgram` 着色器）。Flame 只当画面和点击这一层，借它的游戏循环、精灵、相机和点击区域；地图怎么读、寻路、光照是自己的代码（`app/lib/village/`）。村子每一帧都照服务端折好的 `CoreState` 和视图摆，只多出跟着时钟走的东西（走路、姿势、动画、狗的一天），事实、地块和帮工的状态都不在 Flame 的组件里。所以它不和「核心状态只有一份」冲突：网页上当初不选 Phaser 这类完整框架，怕的是框架当主人、自带一份场景和角色的状态（[像素村](../feature/2026-10-11-pixel-village.md)），这里没有让它当主人。
4. **形状不手抄**（后来改由 Go 的形状生成，[形状的源头是 Go](2026-10-15-go-owns-the-shapes.md)）：当时 `tools/export-schemas.ts` 从 protocol 导出 OpenAPI 和 `CoreState` 的 JSON Schema，`app/tool/dart_types.ts` 生成 Dart 的类型；现在服务端的 `tool/shapegen` 写 `lib/gen/vibevalley.dart`，`bun run flutter:check` 检查它是否最新、跑 `flutter analyze` 和 `flutter test`。
5. **帧里没有的规则移植成 Dart**：网页从核心状态推出来、服务端帧里没给的（阶段的说法、计划的规则、成就和称号、未读、额度……）照 protocol 移植，集中在 `lib/rules/`，每个文件写明 TypeScript 出处。
6. **语音用 Agora 的 Flutter SDK**，只链语音要的部分（`tool/agora-voice-only.sh`）；macOS 上字幕和 agent 的状态走 RTC 的 data stream（服务端请 agent 时固定走 data stream）。
7. **macOS 版把服务端带在应用里**：Go 服务端放在 `Contents/MacOS/vibevalley-server`，开机在一个空闲的回环端口作为子进程拉起，退出时停掉；家目录 `~/Library/Application Support/vibevalley`；alpha、beta、release 三个渠道照 [release-channels](../process/2026-10-12-release-channels.md) 的规矩各是一个应用（`tool/build-macos.sh --channel`）。菜单栏、通知、语音快捷键、登录时打开在 `lib/host/` 和 `macos/Runner`。

### 怎么落的

- 帮工的玩法数据是 `Helper.play`（哪块地、最近 30 步、这一轮的工具数、各种工具的次数、碰过的文件和命令），`Reduce` 从 `hired`、`turn`、`doing` 折出来；字段是可选的，旧的 `state.json` 照样读，服务端重启时给没有地的帮工补一块（`WithStations`）。
- 人在某块地上播种：`SayRequest.bed` 交给服务端，服务端记 10 秒，下一个 `hired` 事实带上这块地（`station`），`Reduce` 据此分地。
- 由状态推出来的（等级、地块的作物和牌子 `view.plots`）和事实带来的效果（金币、升级、成就、没做成的惩罚）在 protocol 的 `game_view.go`（`server/internal/protocol/game_view.go`；当时是 TypeScript 的 `view.ts`）；农场手机的来电当时也在 `view` 里，现在是 `StateFrame` 的 `inbox`（`inbox.go`）。`/api/v1/state` 每一帧是 `StateFrame`（状态、`inbox`、计划、`view`、这段时间的效果）。
- protocol 里要进 Dart 的 schema 带了 `identifier`，JSON Schema 和 OpenAPI 里成了有名字的定义，生成的 Dart 类和 protocol 同名（`CoreState`、`Helper`、`HelperPlay`、`GameEffect`……）。形状改由 Go 写以后，Dart 的类名由 Go 的类型名推出来，撞名的用 `//vibevalley:dart` 指定。
- **分组并行写的**：控件库先做（`lib/ui/kit`），像素村、手机、外框、桌面、聊天、两组配置页、农场画面各占自己的目录；路由和页面的类名先定好，各组只换自己的占位文件。
- **对照**：`tool/screens/` 的两个工具对着同一个服务端，一个用 Flutter 自己的组件把每一页画成 PNG，一个用无头 Chrome 截网页版同一页，逐页对照着改。截网页的那个随网页删了，留下的是 `tool/screens/live_screens_test.dart`。
- **音效**：网页在浏览器里实时合成；Flutter 把同样的合成照搬成 Dart、渲染成 WAV 播放，和 TypeScript 的合成逐样本比对（当时由 `tool/sfx_fixture.ts` 算出 `test/fixtures/sfx.json`；网页删了以后这份冻结，脚本也删了）。

## Verification

验证时（2026-10-13，M2 Max）量到的：

服务端的 `Site.states` 和 `GET /api/v1/state` 最早加在 TypeScript 服务端（已删），现在是 Go 的 `Site.States`（`internal/core/site.go`）；Dart 的类型现在由服务端的 `tool/shapegen` 生成。

- **整份推状态**：主人真实农场的一份状态 66 KB，其中收成 `reports` 40 KB、种植计划 13.6 KB、田头 11.7 KB。管家一个字一个字说时每 200 毫秒一份，约 330 KB/秒：本机和局域网没问题，手机走蜂窝网偏重。真接手机前先把 `reports` 拿出状态流（分页取），或改成增量。Dart 解码这份真实状态 0.4 毫秒。
- **生成 Dart 类型**：quicktype 不能用：`_tag` 联合被压成一个字段都可空的类，缺省的可选枚举直接空指针崩。改成自己写的小生成器（`tool/dart_types.ts`，约 200 行）：联合生成 sealed class，`switch` 能穷尽；主人真实农场的状态能完整读出来。Effect 的 JSON 让每个数字也可以是 `"NaN"`、`"Infinity"`，导出时按「CoreState 的数字都是有限的」收成 `number`。
- **macOS 应用**：Flutter 3.47 经 Swift Package Manager 构建 Agora 插件，不需要 CocoaPods。插件把 Agora SDK 的扩展全链进来，Release 版 198 MB（压缩 112 MB）。只留核心、AI 降噪、AI 回声消除（`tool/agora-voice-only.sh` 改插件的 `Package.swift`）以后是 132 MB（压缩 60 MB）：去掉的扩展在 RtcKit 里是弱链接，集成测试里引擎照样能开音频和降噪；屏幕共享扩展和 RtcKit 重复的类（启动时的警告）也一起没了。iOS 的插件用同一份 `Package.swift` 写法，脚本对它做一样的裁剪（还去掉屏幕共享用的 ReplayKit）；Android 照旧用完整 SDK。剩下的大头是 RtcKit 本身（60 MB，带着视频引擎）和 Flutter（29 MB）；Agora 的纯语音 SDK 更小，但 Flutter 插件经 Iris 绑的是完整版，要换得自己绑。
- **把服务端带进去**：现在桌面版的服务端是 315 MB 的 `node_modules`，再加一份 Node（115 MB），和裁过的 Flutter 应用加起来约 560 MB，现在的 Electron 版是 633 MB。服务端打得更彻底（`effect` 等不带自己文件的包打进 `dist`）能把 `node_modules` 压到几十 MB，但 Node 本体 115 MB 是下限。换成 Go 服务端（smith 的 `cmd/oar` 是 8.5 MB，整个服务端估计 20–30 MB）整个应用约 160 MB，代价见下面「Why not 后端也换成 Go」。
- **语音（macOS 上实测通了）**：Flutter 的 `agora_rtm` 只有 Android 和 iOS，声网官方的 Flutter 示例（Shengwang-Community/conversational-ai-quickstart-native 的 `flutter/`）也只做这两端、字幕和状态走 RTM。macOS 上改走 RTC 的 data stream：服务端请 agent 时设 `data_channel: datastream` 并关掉 `enable_rtm`（原来由客户端带 `captions` 选，后来 RTM 没人用，固定成 data stream）（开着 RTM 时 agent 照旧发到 RTM，data stream 上什么都没有）。data stream 上有字幕（`user.transcription`、`assistant.transcription`）、打断、agent 自己的状态（`message.state`）和延迟（`message.metrics`），每条切成 `id|第几块|共几块|base64`。踩过的坑：
  - 要用服务端给的数字 uid 加入（`joinChannel`，和网页的 `Number(uid)` 一样）；用字符串账号加入会分到另一个 uid，agent 只听服务端给的那个，等 30 秒没人就走了。
  - 音频照官方示例设：直播频道、`audioScenarioAiClient`、一组 `che.audio.*` 参数（AI 回声消除和降噪的低延迟模式）。
- **还没测**：用「农场的管家」接电话（测试服务端用的是声网托管的大模型）；手机（这台机器没有 Android SDK 和 iOS 模拟器运行时）；中文输入法和 Markdown 的手感；Flame 画农场的工作量。

## Alternatives considered

### Why not 后端也换成 Go（smith）？（当初的理由；后来换了）

后来主人要「一个 MyGo 就能搞定一切」，服务端换成了 Go（[服务端用 Go 重写](2026-10-13-go-server-on-smith.md)），下面这段是当时没换的理由。smith 补上了当初没选 Go 的理由（Go 版接不上真实的 runtime），但它只是 oar 这一层：驱动帮工的编码 agent。服务端约 1.56 万行（田头、项目、收获、种植计划、定时、连接器、语音线路、轨迹），管家用的 `@heybro/agent`、`agent-core`、`ai` 约 5900 行，protocol 的 `reduce` 和规则约 3800 行，都要用 Go 重写。Go 服务端加 Dart 客户端，形状和 `reduce` 就成了两份、两种语言；跑 pi 时 smith 还要内嵌一个 Node 进程，去不掉 Node。等哪天真要去掉 Node 服务端，再拿 smith 换 oar 这一块。

**客户端也重写 `reduce`（Dart 里一份）。** 客户端能离线地自己折事实，但就是第二份核心状态，两边改规则要一起改、靠自觉对齐。推折好的状态省掉这一份，代价是带宽，验证里量。

**Tauri 2 或 Capacitor 包现在的网页。** 一行逻辑不改就能上手机和桌面，最省；但界面还是网页，手机上的手感和语音在 WebView 里的稳定性是主人想换的原因。

**像素村先用 WebView 嵌网页版，最后再重写。** 能先把别的界面迁完，但过渡期 Flutter 版要带着整个网页和 Pixi，最难的一块拖到最后；主人选了一开始就用 Flame 写。

**像素村不用游戏框架，用 Flutter 的 `CustomPainter` 自己画。** 少一个依赖，但游戏循环、精灵的批量绘制、点击区域、相机都要自己写；Flame 在这些之外只多一层很薄的组件树，也不管状态。

**用建在 Flame 上的 RPG 框架（比如 Bonfire）。** 地图、角色、碰撞、存档都是现成的，但它们要当主人：角色的位置和状态存在框架里，正是网页上不选 Phaser 的理由。

**玩法数据在 Dart 里从事实流重新折一遍。** 服务端不用改，但 core 的这部分规则就有了 TS 和 Dart 两份。

**React Native。** 能直接用 `@heybro/core` 和 protocol（它们本来就不碰 DOM），但像素农场的 Pixi 要套 WebView 或换渲染，桌面端也弱。

**MyGo（Go 加 WKWebView 的原型）。** 换的是桌面的宿主，界面还是网页，不解决手机。

## Consequences

- 一套 Dart 代码，macOS 应用约 180 MB（带 Go 服务端约 19 MB 和裁过的 Agora），dmg 约 95 MB；Electron 版是 633 MB。
- **玩法数据只在 protocol 里折**：Flutter 读 `CoreState` 和 `view`，没有第二份 `Reduce`；当时冻结的网页还用 TypeScript 的 `reduce`，靠 Go 的对照测试守住（[服务端用 Go 重写](2026-10-13-go-server-on-smith.md)），网页删了以后规则只在 Go（[网页退役](../simplification/2026-10-14-retire-the-web-page.md)）。
- **Dart 里的规则副本**：`lib/rules/` 是 protocol 规则的又一份，protocol 改了要跟着改；能挪进服务端帧里的（像 `view` 那样）就挪过去，Dart 这份随之删掉。
- **整份推状态偏重**：田头消息多、管家说话时一个字一个字长，整份 `CoreState` 每 200 毫秒一份；本机没问题，手机走蜂窝网时要换成增量，增量的格式又是一份要两端一致的约定。`reports` 后来整个从核心状态里去掉了（[仓库就是收获了的工单](../feature/2026-10-16-warehouse-is-harvested-issues.md)）。
- **Dart 代码生成器是自己写的**（当时是 `tool/dart_types.ts`，现在是服务端的 `tool/shapegen`）：形状用到新写法时要跟着改，不认识的写法直接报错。
- **和网页版不同的地方**：没有浏览器里的模拟服务器和剧本；没有图片鼠标指针（[app/README.md](../../../../app/README.md)「取舍」）。

## Deferred

- 手机版（iOS、Android）和连到主人电脑上的农场：另起了决策，见 [院门](../feature/2026-10-14-yard-gate.md)、[手机上的通知](../feature/2026-10-14-phone-notifications.md)。
- Windows。
