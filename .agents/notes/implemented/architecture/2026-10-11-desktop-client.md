# Agent Note: 桌面客户端：服务端在 Electron 里，窗口开服务端发的页面

Status: implemented

> 已被取代：桌面客户端现在是 Flutter 的 macOS 应用（[客户端迁到 Flutter](2026-10-13-flutter-client-over-ts-server.md)），Electron 版（`apps/desktop`）随 [一个服务端、一个客户端](../simplification/2026-10-14-one-server-one-client.md) 删掉了，只在 git 历史里。服务端在应用里、关窗口留在菜单栏、通知和菜单栏摘要是纯函数（`app/lib/desktop/notify.dart`）、⌥⇧Space 开关语音、问登录 shell 要 PATH 这些做法 Flutter 版照旧；下面是 Electron 版当时的决策。

## Problem

用 VibeValley 要先在终端里起服务端、再构建页面、开浏览器。帮工一干就是几十分钟，主人多半在别的程序里，农场的页面埋在一堆标签页里：帮工做完了、没做成、在田头上叫主人，都要切回去才看得到。关掉终端或标签页，农场就停了。语音要先把页面找出来，再点麦克风。

## Decision

`apps/desktop`：一个 macOS 的 Electron 客户端。（[desktop.md](../../../../docs/desktop.md) 现在写的是 Flutter 版。）

- **服务端在里面**：客户端先看 8787 上有没有农场。有就用它；没有就在 Electron 的 utility process 里起打包好的 `apps/server`（`dist/main.mjs`，esbuild 只打进服务端和工作区的 TypeScript 包，别的包照常从它旁边的 `node_modules` 里 import）。Electron 44 带的 Node 是 24，和仓库要求的一样。
- **窗口开服务端发的页面**：服务端设了 `VIBEVALLEY_WEB_DIR` 就在 `/` 发构建好的页面，窗口打开 `http://127.0.0.1:8787`。页面和接口同源，不用代理；本机地址是安全来源，麦克风照常能用。
- **退出时等服务端存好**：客户端自己发 SIGTERM，最多等 8 秒再强杀。不用 `child.kill()`：Chromium 在那之后 2 秒就把还活着的进程杀掉，服务端来不及存盘。服务端停的时候先断掉还开着的连接（页面的事件流不会自己结束，`server.close()` 会一直等它们）。
- **找得到农机**：从 Finder 或登录时打开的应用 PATH 很短，客户端问登录 shell 要 PATH 再交给服务端；凭据在 `$VIBEVALLEY_HOME/.env`。
- **菜单栏和通知在主进程里**：主进程订阅同一个工地事件流，用 protocol 的 `reduce` 折出一份核心状态；弹哪些通知、菜单栏写什么是 `notify.ts` 的纯函数。点通知时主进程通过预加载脚本的桥（protocol 的 `DesktopCommand`）让页面打开那块地、那个对话或那个计划。窗口在面前时不弹，页面自己会说。
- **语音快捷键是开关**：⌥⇧Space 按一下开始，再按一下挂断。语音还是页面里的那一套（Agora），窗口藏着也照常（不节流后台）。
- **关窗口不退出**：农场留在菜单栏里，Dock 图标收起来；登录时打开的话只在菜单栏里。
- **主进程用 Effect**：`FarmServer`、`FarmFeed` 是 `Context.Service` 加 `Layer`；起服务端用 `acquireRelease`，退出时 `ManagedRuntime.dispose` 把它停掉。
- **打包**：electron-builder 打 `.app` 和 `.dmg`（只有 Apple 芯片），不用证书，临时签名。服务端的生产依赖用 `pnpm deploy`（hoisted，没有符号链接）摆好，打包后再拷进 Resources（electron-builder 不往资源里放 `node_modules`）。图标、安装窗口背景、开门的图由 codex 画（`design/assets/gen.sh`），`scripts/icons.py` 裁；菜单栏的苗是脚本画的单色模板图。

## Alternatives considered

**只做外壳，连一个另外起的服务端。** 简单，但每次都要先在终端里起服务端，关掉终端农场就停，和「装上就能用」差得远。所以服务端在里面；8787 上已经有一个时照用它，开发时两种都行。

**Tauri。** 包小，但服务端是 Node：管家的 pi 跑在进程里，PGlite 是 WASM，oar 在 Node 里起各家农机。Tauri 也得带一个 Node 当旁车，省下的只是浏览器那部分；Electron 的 utility process 直接用它自带的 Node 24 跑服务端，页面的 Agora 也在 Chromium 里照旧。

**服务端跑在主进程里。** 少一个进程，但帮工的事件一多、或者服务端出错，菜单栏和窗口跟着卡死或一起崩。utility process 隔开了，退出时也能单独等它存盘。

**页面从 `file://` 或自定义协议载入，接口另走。** 页面和接口就不同源了，要处理跨域；麦克风权限也要另外放。服务端发页面，什么都不用改。

**服务端连同依赖打成一个文件。** PGlite 的 WASM、pi 的资源都按自己包的位置找文件，打进一个文件就找不到了。所以只打服务端和工作区的包，别的包照常带着。

**按住说话。** Electron 的全局快捷键只报按下、不报松开；要按住说话得装原生的键盘钩子，还要辅助功能权限。先做成开关。

**通知用页面的 Web Notification。** 页面要活着、要能分清窗口在不在面前，点了也只能回到页面；主进程的通知在窗口藏着时照样弹，点了能叫出窗口再打开地方。

**electron-forge。** 也能打 dmg；electron-builder 的 dmg 背景和图标摆放、`afterPack` 钩子正好用得上（拷依赖、临时签名）。

## Consequences

- **包大**：应用约 630 MB，dmg 约 220 MB，大半是 pi 带的各家模型 SDK。
- **没签名**：第一次打开要右键打开或在系统设置里放行；没有自动更新，新版本重装。
- **只有 macOS、只有 Apple 芯片**。Windows 和 Linux 要另处理 pi、claude、codex 的路径和 shell。
- **PATH 靠登录 shell**：shell 配置在非交互的 `-ilc` 下要能很快跑完；5 秒没回就用客户端自己的 PATH。
- 顺带修了两处服务端的问题：停的时候不再等页面的事件流（之前终端里 Ctrl+C 开着页面会卡约 20 秒）；存文件按顺序、关闭后不再存（`files.ts`）。

## Verification

- `apps/desktop/test/notify.test.ts`：哪些事件弹通知、点开去哪（帮工做完没做成、计划里的帮工不单独说、@主人 只在说完时说一次、计划拆好熟了某步没做成、错误弹而提醒不弹），菜单栏的摘要。
- 冒烟（`VIBEVALLEY_DESKTOP_SMOKE=1`，临时的家目录和端口）：仓库里跑和打包好的应用都起了自己的服务端、载入页面、桥在页面上；退出时服务端收到 SIGTERM，写了 `crew.json`、`spend.json`；把 PATH 换成 `/usr/bin:/bin`（像从 Finder 打开）也找到了 claude、codex、pi 等农机。
- dmg 挂载后有背景、卷图标、应用和「应用程序」的链接；应用是有效的临时签名。
- 还没手动试过的：在真的桌面上点通知、按快捷键说话、登录时打开。

## Deferred

- 签名、公证和自动更新。
- Windows 和 Linux。
- 按住说话（原生键盘钩子）。
- 8787 被别的程序占着时换一个端口。
- 给包瘦身：服务端只带用得上的农机 SDK。
