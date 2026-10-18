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

1. 先跑 `bun run flutter:check`。
2. 使用 [verify-server](../verify-server/SKILL.md) 的隔离脚本；它自动选择回环空闲端口并传入 `VIBEVALLEY_SERVER`，不连接主人的 8787。

## 步骤

1. 在仓库根目录造一张工单并画工单页：

   ```bash
   bun scripts/verify-server.ts -- sh -c '
     "$VIBEVALLEY_VERIFY_CLI" issue create --json "{\"title\":\"截图验收\"}" &&
     cd app &&
     VIBEVALLEY_PAGES=tickets flutter test tool/screens/live_screens_test.dart
   '
   ```

   `command.stdout.log` 应有 `All tests passed!`，截图是 `app/build/live-tickets.png`。改别的页面时，在同一个子命令里造它需要的数据，再替换页面名；新农场没有上一轮的 fixture。

2. 打开截图，对照改动检查内容、用语、溢出和重叠。空状态只能证明空状态，不能代替列表、卡片和详情验收。
3. 按需要在截图命令前设置条件：
   - `VIBEVALLEY_SCREEN=390x844`：手机大小；默认 1440×900。
   - `VIBEVALLEY_EXTRA='名字=/路由,…'`：额外页面。路由里的 `|文字` 会点击对应文本或 tooltip。
   - `VIBEVALLEY_FRAMES=40,90,150`：点击后这些毫秒各画一帧。
4. 改代码后重新执行同一条命令；脚本会重新编译和启动服务端。

## 证据

- 执行命令、打印的证据目录及 `command.stdout.log` 中的 `All tests passed!`。
- 和改动有关的截图路径，以及截图里对应的变化。
- 改了布局时，附一张 390×844 的截图。

## 出错时

- **服务端起不来**：按 verify-server 读证据目录中的构建和服务日志。
- **某页超时或空白**：看 `command.stderr.log` 和 `server.log`，确认 fixture 已在当前子命令中创建。
- **路由打不开**：页面名和路径在 `app/tool/screens/live_screens_test.dart` 的 `pages`，应与 `app/lib/app/router.dart` 对上；有动态 ID 的详情页用 `VIBEVALLEY_EXTRA` 传入当前 fixture 的实际路径。

## 收拾

隔离脚本自动停止服务端、删临时农场和 binary，保留证据日志。`app/build/` 的截图不进 git，不必删除。
