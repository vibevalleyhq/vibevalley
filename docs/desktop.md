# macOS 应用

Flutter 客户端的 macOS 版：Go 服务端在应用里面，另有菜单栏、系统通知和语音快捷键。Dart 这一半在 `app/lib/desktop/`，Swift 那一半在 `app/macos/Runner/`，两边经方法通道 `vibevalley/desktop` 说话（[理由](../.agents/notes/implemented/architecture/2026-10-11-desktop-client.md)）。

## 服务端在里面

- 应用带着 Go 服务端（`Contents/MacOS/vibevalley-server`）。画第一帧之前，`launcher.dart` 在 127.0.0.1 上找一个空闲端口把它拉起，等 `GET /api/health` 答应（最多 40 秒，失败换端口再试，最多三次）；起不来就弹框说原因和日志在哪。
- 退出时先给服务端发 SIGTERM，让它存好状态；8 秒还没退就强行结束。
- **家目录**是 `~/Library/Application Support/vibevalley`，和终端里跑的 `~/.vibevalley` 不是同一个农场。日志在 `~/Library/Logs/vibevalley/server.log`。
- **PATH**：从 Finder 打开的应用找不到 pi、claude、codex，所以先问登录 shell 要 PATH 再交给服务端。
- **用别的电脑的农场**：在「院门」页粘贴配对链接，那边点头以后就用那台电脑的农场，不再拉起自己的服务端（[server.md](server.md)「院门」）。
- 调试时用 `--dart-define=VIBEVALLEY_SERVER=http://…` 连一个开着的服务端，`VIBEVALLEY_SERVER_BIN` 换一个服务端程序。

## 渠道

三个渠道可以同时装、同时开，打包时定（`build-macos.sh --channel`；`lib/desktop/channel.dart`；[理由](../.agents/notes/implemented/process/2026-10-12-release-channels.md)）：

| 渠道 | 应用 | bundle id | 家目录 |
|---|---|---|---|
| release | `vibevalley.app` | `dev.vibevalley.app` | `~/Library/Application Support/vibevalley` |
| beta | `vibevalley Beta.app` | `dev.vibevalley.app.beta` | `…/vibevalley Beta` |
| alpha | `vibevalley Alpha.app` | `dev.vibevalley.app.alpha` | `…/vibevalley Alpha` |

家目录各是各的，Alpha 的数据库迁移碰不到你天天用的农场；工作目录共用。

## 窗口

- 窗口按游戏画面（384×256）的整数倍开，拖动时锁住比例、松手吸到最近的整数倍（`MainFlutterWindow.swift`）。标题条由游戏画（`lib/shell/desktop_title_bar.dart`）。
- 关掉窗口，农场照常在菜单栏里跑；只开一个实例。
- 应用不在沙箱里（要起服务端、让帮工干活）；权限只要麦克风。

## 菜单栏

图标是一棵苗，旁边写在干活的帮工数和等你处理的事数（`2 · 1!`）。菜单里是现在的情况、每件等你的事、打开农场、和管家说话、登录时打开、退出。摘要和等你的事都从帧里的 `inbox` 算（`lib/desktop/notify.dart` 的 `traySummary`）。

## 通知

窗口不在你面前时，帧里新出现的来电（做完、没做成、没动静、冲突、@主人、计划的事）、成就和农场出错弹系统通知，点开回到对应的地方。规则在 `lib/desktop/notify.dart`（纯函数），点通知要做的事是 `lib/desktop/command.dart` 的 `DesktopCommand`。

## 快捷键

**⌥⇧Space**：在任何程序里按一下开始和管家语音说话，再按一下挂断（[voice.md](voice.md)）。

## 打包和安装

`bun run package:mac`（`app/tool/build-macos.sh`）在 `app/build/` 下打出 `vibevalley.app` 和 `vibevalley-arm64.dmg`。第一次先跑 `app/tool/agora-voice-only.sh`。

应用只做了临时签名，第一次打开要在 Finder 里右键 →「打开」。没有自动更新，新版本重新装。
