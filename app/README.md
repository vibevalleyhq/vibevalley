# app：VibeValley 的 Flutter 客户端

VibeValley 唯一的客户端，桌面和手机都是它。决策见 [Flutter 客户端](docs/subsystems/app.md)。

## 和服务端

- **状态**：读 `GET /api/v1/state` 折好的 `StateFrame`，自己不折事实（[architecture.md](docs/architecture.md)「核心状态」）。
- **状态以外的事**：从 `GET /api/v1/live` 只取步骤、提醒、农机的变化（`sideEvents`）；`/api/v1/events` 的 facts 留给命令行和调试。
- **命令**：`lib/gen/vibevalley.dart` 里生成的 `VibeValleyApi`，页面只从 `apiProvider` 拿它。
- **连接生命周期**：`VibeValleyServer` 同时拥有状态流和窄事件流；关闭时释放全部连接，停止重连。坏帧写入错误流，后续合法帧继续接收。
- **配置同步**：`workbenchConfigProvider` 统一分开管家与派活档案；旧刷新不覆盖新刷新，读取期间的农机推送优先于列表结果。首次加载失败保留错误，和空列表区分。
- **失败恢复**：配置页显示原因和重试；聊天发送失败保留草稿。连接器和页面资源的旧读取不能覆盖刚完成的动作结果。
- **读取的拥有者**：项目目录、每个档案的记忆、每个 Session 的轨迹由数据层按对象提供；观察轨迹会自动取回历史并接上增量。聊天层统一提供消息投影和已读生命周期，两张皮只声明当前可见的频道。
- **通话的拥有者**：当前农场的 ProviderScope 拥有 VoiceCall；页面观察通话，按钮和本机快捷键都发送同一个通话动作。切换农场时旧通话随 scope 释放。
- **规则**：帧里没有、要从状态推出来的，是 `lib/rules/` 的纯函数；客户端自己的游戏状态（工具、手机、偏好）在各自的目录。

用哪个农场（本机，或经院门配对的另一台电脑）存在偏好里（`lib/data/farm_choice.dart`）。手机上不在屏幕前时按桌面版的规则弹系统通知（`lib/host/mobile_notices.dart`）。macOS 版见 [客户端](docs/subsystems/app.md)。

## 目录

| 目录 | 管什么 |
|---|---|
| `lib/app/` | App 根：路由、ProviderScope/DesktopHost、MaterialApp |
| `lib/data/` | 服务端（状态流、事件流、接口客户端）、Riverpod 的 provider、用哪个农场 |
| `lib/gen/` | 生成的形状和接口客户端，不手改 |
| `lib/rules/` | 读核心状态的纯函数 |
| `lib/chat/` | 田头的数据和小部件：频道、消息、未读、发话；工作台的聊天页和农场的田头窗口都用它 |
| `lib/shared/` | 几张画面都用的：帮工的样子、干活过程、收成清单、朋友和额度、音效配方、小部件 |
| `lib/ui/kit/` | 像素控件：按钮、输入、选择、对话框、提示、Markdown……（[README](app/lib/ui/kit/README.md)） |
| `lib/farm/`、`lib/game/` | 农场画面、面板（地块详情、播种袋、仓库、日志、商店、任务与成就、种植计划、收成清单）、田头窗口、帮工栏、精力瓶；工具和点地的规则 |
| `lib/sprites/` | 按 `sprites.json` 读图（`atlas.dart`） |
| `lib/village/` | 像素村（Flame）：地图、寻路、帮工和狗、光照、粒子、动静；`hud.dart` 是画在上面的 HUD |
| `lib/phone/` | 手机、来电、五个小游戏 |
| `lib/workbench/<地方>/` | 工作台的各页：聊天、工单、地图、帮工和档案、管家、农具、技能书、连接器、项目、声音、院门、图鉴；`shared/` 是几页共用的 |
| `lib/shell/` | 外框：AppFrame、桌面标题栏 |
| `lib/title/` | 首页：启动、场景和菜单 |
| `lib/audio/` | 音效配方和合成 |
| `lib/debug/` | 调试台 |
| `lib/host/` | 本机外壳：macOS 桌面（拉起服务端、菜单栏、快捷键、渠道）和手机的系统通知、前台服务 |
| `lib/voice/` | 语音：通话用 Agora 的 Flutter SDK，字幕走 RTC 的 data stream；听写录一段交给服务端（`dictation.dart`） |

## 跑和打包

```bash
flutter run -d macos --dart-define=VIBEVALLEY_SERVER=http://127.0.0.1:8787   # 连一个开着的服务端
./tool/build-macos.sh                     # build/vibevalley.app（带 Go 服务端）和 build/vibevalley-arm64.dmg
./tool/build-macos.sh --channel alpha     # Alpha 渠道：自己的 bundle id 和家目录
```

第一次（和升级 `agora_rtc_engine` 以后）先跑 `./tool/agora-voice-only.sh`：macOS 和 iOS 只链语音要的 Agora 组件（插件复制到 `third_party/`，不进仓库）。Android 的 manifest 去掉了插件带来的 `READ_PHONE_STATE`。

## 形状从哪来

`lib/gen/vibevalley.dart` 是生成的：形状在服务端的 `server/internal/protocol/shapes.go` 和 `api.go`，改了以后在 `server/` 跑 `go run ./tool/shapegen`，它同时写 Go 的 `internal/protocol/gen.go` 和这个文件（[server](server/README.md#形状和规则从哪来)）。联合生成 sealed class，`switch` 能穷尽；既是事实又是事件流的成员同时实现两个。数字都是 `double`。

## 测试和对照

```bash
flutter analyze && flutter test           # 不连网：服务端用 MockClient 假的
VIBEVALLEY_SERVER=http://127.0.0.1:8899 flutter test tool/screens/live_screens_test.dart   # 每一页对着真服务端画成 build/live-*.png
```

替身都在 `test/support/`：`server.dart` 是唯一的 `FakeServer`（继承 `VibeValleyServer`，每个请求交给一个处理函数并记下来）、按「方法 路径」回答的 `Routes`、`settle`、`atlas`；`workbench.dart` 有工作台各页的 `WorkbenchBackend` 和 `pumpPage`，`farm.dart`、`shell.dart` 是农场和外壳的。测试目录跟着 `lib` 分层（`test/workbench/`、`test/farm/`、`test/village/`……），`test/support/` 是替身，`test/fixtures/` 是冻结的对照。

音效合成的对照 `test/fixtures/sfx.json` 是冻结的，没有生成它的脚本；`lib/audio/synth.dart` 有意改了声音时，同一个改动里手改它。

## 取舍

- 没有模拟服务器：调试台的命令都对着真服务端。
- Flutter 没有图片鼠标指针：农场里的工具指针画在画面上，图鉴的「指针」只展示图。
- 定时什么时候、下次什么时候，由服务端按定时自己的时区写好（`whenText`、`nextText`），客户端只显示。
