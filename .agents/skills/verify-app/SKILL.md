---
name: verify-app
description: 改了 VibeValley 的客户端（app/lib/**、app/assets）之后，对着一个真的服务端把页面画成截图，看改动画出来对不对。用在：改了工作台、农场、田头的页面或组件，改了样式、布局、贴图；主人说「看看界面」「截个图」「确认页面对了」。不开 flutter run 的窗口，截图由 app/tool/screens/live_screens_test.dart 画。
---

# 验证客户端

`flutter test` 用的是假的服务端，只能证明组件按假数据画得出来。这个 skill 连一个真的服务端，把页面画成 PNG，拿眼睛看。

## 什么时候用

- 改了 `app/lib/desk`、`app/lib/farm`、`app/lib/village`、`app/lib/chat`、`app/lib/shared`、`app/lib/ui` 的画面。
- 改了 `app/assets` 的贴图、字体。
- 改了形状，想看服务端的新字段在页面上画出来。

不用它：只改了 `app/lib/data` 里的请求、测试已经覆盖的；只改了测试。

## 准备

1. 先过检查：

   ```bash
   bun run flutter:check
   ```

2. 开一个隔开的服务端：照 [verify-server](../verify-server/SKILL.md) 的第 1–2 步，在 8899 上起来。不连主人的 8787，那是主人的数据。
3. 页面要有东西画，先用接口造数据：要看哪一页，就调那一页对应的接口，例如工单页建一张工单（verify-server 第 3 步）。空的页面看不出列表、卡片对不对；没造数据的页面显示空状态的文字，这是正常的。

## 步骤

1. 画出要看的页面。页面的名字和路由在 `app/tool/screens/live_screens_test.dart` 的 `pages` 里；`VIBEVALLEY_PAGES` 只画这几页：

   ```bash
   cd app && VIBEVALLEY_SERVER=http://127.0.0.1:8899 VIBEVALLEY_PAGES=tickets,chat flutter test tool/screens/live_screens_test.dart
   ```

   成功时最后一行是 `All tests passed!`，每页一张 `app/build/live-<页>.png`。两页大约 20 秒。

2. 打开截图看（Read 工具能直接读 PNG），对照改动：该出现的东西在不在、字是不是中文和农场的叫法、有没有溢出和重叠。
3. 按需要换条件再画：
   - 手机大小：加 `VIBEVALLEY_SCREEN=390x844`（默认 1440x900）。
   - `pages` 里没有的页面：加 `VIBEVALLEY_EXTRA='名字=/路由,…'`；路由写成 `/路由|字` 会在页面起来后点一下那段字（或 tooltip 是它的按钮）。
   - 点了以后的过渡：加 `VIBEVALLEY_FRAMES=40,90,150`，另外画 `live-<页>@<ms>ms.png`。
4. 改了代码，重跑第 1 步。改了服务端的代码，先照 verify-server 重启服务端。

## 证据

说「验证过了」时，给主人看：

- 第 1 步的命令和 `All tests passed!`。
- 和改动有关的截图路径（`app/build/live-<页>.png`），并说清截图里哪一处是这次的改动。
- 改了布局的，附一张 `VIBEVALLEY_SCREEN=390x844` 的。

## 出错时

- **连不上服务端，页面是空的或报错**：服务端没起来或端口不对。`curl -s http://127.0.0.1:8899/api/v1/health` 先确认。
- **截图里是旧的样子**：服务端是旧的二进制，或者形状改了没跑 `shapegen`。
- **某一页超时**：页面一直在转，多半在等一个服务端没给的数据。看服务端日志里那一页请求的接口。
- **路由打不开**：`pages` 里的路由跟着 `app/lib/app/router.dart` 改，改了路由要同步改 `pages`。

## 收拾

- 照 verify-server 的「收拾」停掉服务端、删掉临时目录。
- `app/build/` 在 `.gitignore` 里，截图不用删，也不进仓库。
