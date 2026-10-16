# macOS 应用

Flutter 客户端（`app`）的 macOS 版：农场在自己的窗口里，Go 服务端在应用里面，另有菜单栏、系统通知、语音快捷键和登录时打开。Dart 这一半在 `app/lib/desktop/`，Swift 那一半在 `app/macos/Runner/`（`AppDelegate.swift`、`MainFlutterWindow.swift`），两边经方法通道 `vibevalley/desktop` 说话。为什么这样做见 [客户端迁到 Flutter](../.agents/notes/implemented/architecture/2026-10-13-flutter-client-over-ts-server.md) 和 [desktop-client](../.agents/notes/implemented/architecture/2026-10-11-desktop-client.md)。

## 服务端在里面

- 应用里带着 Go 服务端（`Contents/MacOS/vibevalley-server`，就是 `server/cmd/vibevalley`）。画第一帧之前，`launcher.dart` 在 127.0.0.1 上找一个空闲端口把它作为子进程拉起，等到 `GET /api/health` 答应（第一次要建数据库，最多等 40 秒）；服务端起来前就退出了（多半是端口刚被别人占了），换一个端口再试，最多三次。起不来就弹一个框说原因和日志在哪，然后退出。
- 退出应用时先停服务端：发 SIGTERM，服务端存好 `farm.json`、`crew.json`、数据库再退出；8 秒还没退就强行结束。整个退出最多等 12 秒。
- **家目录**：`~/Library/Application Support/vibevalley`（`VIBEVALLEY_HOME`；Alpha、Beta 用各自的，见「渠道」），和在终端里跑的 `cmd/vibevalley`（默认 `~/.vibevalley`）不是同一个农场。工作目录照常是 `~/vibevalley-work`（`VIBEVALLEY_WORK_ROOT`）。已经设了的 `VIBEVALLEY_HOME`、`VIBEVALLEY_WORK_ROOT` 优先。从别处搬一个农场过来用 `vibevalley import`（[server](../server/README.md)）。
- 服务端的输出追加到 `~/Library/Logs/vibevalley/server.log`（渠道的应用名代替 `vibevalley`）。
- **PATH**：从 Finder 或登录时打开的应用，PATH 里没有 pi、claude、codex 装的地方。应用先问你的登录 shell 要 PATH（`$SHELL -ilc`），再交给服务端。
- **凭据**：DeepSeek 和 Agora 的钥匙在首页的「设置」里填（存在 `$VIBEVALLEY_HOME/settings.json`）。别的要给服务端的环境变量放在 `$VIBEVALLEY_HOME/.env`，已经设了的环境变量优先。
- **用别的电脑的农场**：在「院门」页粘贴那台电脑给的配对链接，那边点了头以后，应用就用那台电脑的农场，整个界面在新农场上重新开始。选择存在偏好里，下次打开时不拉起自己的服务端；切回本机时再拉起。本机农场已经在跑的话，切走以后它照常运行（[server.md](server.md)「院门」）。
- 调试时不拉起自己的服务端：`--dart-define=VIBEVALLEY_SERVER=http://…` 连一个开着的服务端；`VIBEVALLEY_SERVER_BIN` 换一个服务端程序；`flutter run` 出来的应用里没有服务端时连 `http://127.0.0.1:8787`。

## 渠道

应用分三个渠道打包，可以同时装、同时开（`lib/desktop/channel.dart`；[理由](../.agents/notes/implemented/process/2026-10-12-release-channels.md)）。渠道在打包时定（`--dart-define=VIBEVALLEY_CHANNEL`，`tool/build-macos.sh --channel` 替你传）：

| 渠道 | 应用 | bundle id | 家目录 |
|---|---|---|---|
| release | VibeValley | `dev.vibevalley.app` | `~/Library/Application Support/vibevalley` |
| beta | VibeValley Beta | `dev.vibevalley.app.beta` | `~/Library/Application Support/vibevalley Beta` |
| alpha | VibeValley Alpha | `dev.vibevalley.app.alpha` | `~/Library/Application Support/vibevalley Alpha` |

- 家目录分开：Alpha 的数据库迁移碰不到你天天用的农场；田头、帮工、账本、钥匙（`settings.json`、`.env`）各是各的。工作目录是共用的，项目是你的。
- 端口不会撞：每个应用自己找空闲端口。
- 窗口标题和菜单栏的提示后面写着渠道（「码农场物语 · Alpha」）。
- 语音快捷键大家一样，先开的那个占着；后开的在系统日志里说一声。

## 窗口

- **大小跟着游戏**：像素农场的画面是 384×256（`MainFlutterWindow.swift` 的 `screen`），按整数倍画。窗口打开时取屏幕放得下的最大倍数，最小 2 倍；拖动改大小时锁住比例，松手后吸到最近的整数倍，四周不留边（`MainFlutterWindow.swift`）。
- **标题条是游戏画的**：系统的标题栏藏起来，农场在最上面画一条 28 像素的标题条（`lib/shell/desktop_title_bar.dart`），写着窗口名，红绿灯按钮在它上面；拖它移动窗口，双击和系统标题栏一样。
- 关掉窗口，农场照常在菜单栏里跑，Dock 上的图标也收起来；从菜单栏「打开农场」或再点一次应用回来。只开一个：第二次打开只是把第一个的窗口叫出来。
- 应用不在沙箱里（它要起服务端，帮工在工作目录里干活、要上网）；权限只要麦克风，第一次说话时系统会问。

## 菜单栏

图标是一棵苗。旁边的字：在干活的帮工数，和等你处理的事数（`2 · 1!`）；都没有就不写字。

点开的菜单：

- 现在的情况：还没开工、几个帮工在干活；每件等你的事（谁做完了可以收、谁没做成、谁的活会冲突、谁好一阵没动静、哪个计划等你看或可以收获、哪一步没做成）；田头几条没读。
- 打开农场；和管家说话（⌥⇧Space）。
- 登录时打开（勾上以后，登录时应用在菜单栏里开着，不弹窗口）。
- 退出。

摘要由服务端推来的帧算（`lib/desktop/notify.dart` 的 `traySummary`），等你的事就是帧里的 `inbox`。

## 通知

农场窗口不在你面前时（藏着、或者你在别的程序里），这些事弹系统通知；点通知回到农场（你停在工作台的某一页或首页时也先回到农场），打开它说的那个地方：

| 什么时候 | 点开 |
|---|---|
| 一个帮工这一轮做完了、没做成 | 它的地 |
| 一个帮工好一阵没动静、它的活合进主分支会冲突 | 它的地 |
| 田头上有人 @主人 | 那个对话 |
| 计划拆好了、某一步没做成、都做完了可以收获 | 计划板上的那个计划 |
| 一个成就到了一档、做完一个新手任务、发现一个彩蛋 | 任务与成就 |
| 农场出错（红色的提醒） | 农场 |

前四种是帧里新出现的来电，应用打开时已经在的不响。规则在 `lib/desktop/notify.dart`，和菜单栏的摘要一起，是纯函数；点通知要做的事是 `command.dart` 的 `DesktopCommand`（和 protocol 的 `desktop.ts` 同一个 JSON）。

## 快捷键

**⌥⇧Space**（Option + Shift + 空格）：在任何程序里按一下，开始和管家语音说话；再按一下挂断。窗口不用叫出来。被别的程序占了时，菜单栏里的「和管家说话」照样能用。语音见 [voice.md](voice.md)。

## 打包和安装

`bun run package:mac`（就是 `app/tool/build-macos.sh`，`--channel alpha|beta` 打别的渠道）：不带 cgo 编出 Go 服务端放进应用，Flutter 按 release 构建，在 `app/build/` 下打出 `vibevalley.app` 和 `vibevalley-arm64.dmg`（Apple 芯片）。第一次先跑 `tool/agora-voice-only.sh`（[app](../app/README.md#跑和打包)）。

- 应用没有用开发者证书签名，只做了临时签名，第一次打开要在 Finder 里右键 →「打开」，或者在「系统设置 → 隐私与安全性」里点「仍要打开」。
- 没有自动更新：新版本重新打包、重新装。
