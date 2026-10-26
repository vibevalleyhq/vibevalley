---
name: acceptance
description: 改完 VibeValley 的代码之后，在真的程序上验收：起一个和主人的数据隔开的服务端，看接口和 /api/v1/state（apps/server/**、packages/protocol）、截页面的图（apps/web/**）、在模拟器上走手机壳的配对（apps/mobile/**、packages/host、apps/server/src/lan）、用真模型重放管家的评测（管家的提示、工具描述、agent/brain，花钱，先问主人）。用在：主人说「验证一下」「验收」「跑起来看看」「截个图」「手机上看看」「跑一下管家的评测」；改了接口、服务、表结构、页面、手机壳之后汇报之前。只改了纯函数、测试已经覆盖的，跑测试就够。
---

# 验收

测试和检查之后的那一段：程序真的起来、接口真的返回、页面真的画出来、手机真的配上。每一块的做法在同目录的一份分册里，先照下表找到要读的那份，只读用得上的。

## 什么时候用

| 改了什么 | 读哪份 | 证明什么 |
|---|---|---|
| `apps/server/src/**`、`apps/server/db`、`packages/protocol` 的接口或形状；开机的流程 | [server.md](.agents/skills/acceptance/server.md) | 隔开的服务端起得来，接口和 `/api/v1/state` 里有这次的改动；工单能派、交回、完成 |
| `apps/web/src/**`、`apps/web/public` 的画面、组件、贴图 | [page.md](.agents/skills/acceptance/page.md) | 对着真的服务端，页面画出来是对的（截图） |
| `apps/mobile/**`、`packages/host`、`apps/server/src/lan`、页面里调宿主的地方 | [mobile.md](.agents/skills/acceptance/mobile.md) | 安卓模拟器上的真应用配对、经「连接到本机」打开页面、桥让手机弹通知、重开直接回农场 |
| 管家的提示、`apps/server/src/tool` 的工具描述、`agent/brain` 拼提示和压缩的办法；加了管家的样例 | [orchestrator-evals.md](.agents/skills/acceptance/orchestrator-evals.md) | 用真模型重放每个样例 5 次，以前修好的错没回来，新的修好了 |

一次改动碰了几块，就读几份，在同一个沙箱子命令里一起做（造数据、调接口、截图）。

不用它：只改了纯函数、黄金数据和单元测试已经覆盖的；只改了注释和文档。

**管家的评测连网、花钱：跑之前先问主人。** 没问、没钥匙时只做那份分册里离线的部分，汇报里写明在线的那半没跑。这里也不派真的帮工（要本机登录的农机或钥匙）；要走一遍派活，用沙箱的 `--scripted-helper`（[server.md](.agents/skills/acceptance/server.md)）。

## 准备

1. 先跑和改动有关的最窄的检查：服务端 `vp run server:check`，页面和手机壳 `vp run web:check`（它也构建出 `apps/web/dist`）。
2. 照分册的「准备」做它要的事（生成代码、构建、起模拟器、钥匙）。

## 步骤

1. 照上表选出分册，读它。
2. 除了管家的评测，都用同一个沙箱，在仓库根目录跑：

   ```bash
   vpx scripts/verify-server.ts [--scripted-helper] -- <这一轮的子命令>
   ```

   它用 Node 和 tsx 从 `apps/server` 起服务端，临时的家目录和工作目录、回环地址的空闲端口，环境里去掉一切钥匙，不碰 `~/.vibevalley`，也不占主人的 8787；`apps/web/dist` 在的话一起提供页面。子命令拿到 `VIBEVALLEY_SERVER`（服务端的地址）和 `VIBEVALLEY_VERIFY_CLI`（连着它的命令行，`help` 列出全部接口）。每次调用是一个新农场，要的数据在同一个子命令里造。

3. 照分册的「步骤」写子命令、跑。
4. 读脚本打印的证据目录：`command.stdout.log`、`command.stderr.log`、`server.stdout.log`、`server.stderr.log`，核对结果。只有启动成功的 `health.json` 不能证明改动生效。

## 证据

说「验收过了」时，附上：

- 执行的命令和打印的证据目录；`result.json` 的 `code` 是 0、`stopped` 是 true。
- 分册「证据」一节要的东西：接口的 JSON、截图、模拟器的那几行、评测的表。
- 日志里的错误和对它们的结论。

## 出错时

- **服务端起不来或健康检查超时**：看 `server.stdout.log`、`server.stderr.log`（类型错误、表结构对不上、端口）。脚本已经停掉它起的进程。
- **子命令失败**：看 `command.stderr.log` 和 `command.stdout.log`；脚本不会把非零退出码改成成功。
- **清理失败**：看 `result.json` 的 `cleanupErrors`；`stopped` 为 false 时临时目录会留着，不要当成已收拾。
- **接口或形状对不上**：跑 `vp run server:check` 和 `vp run web:check`；服务端每次从源码起，没有旧的构建。
- 各块自己的失败在分册的「出错时」。

## 收拾

沙箱脚本自己停掉服务端、删掉临时的 `home`、`work`，证据日志留在打印的临时目录，交付后可删。截图（`apps/web/.screens/`、`apps/mobile/.screens/`）不进 git。模拟器照 [mobile.md](.agents/skills/acceptance/mobile.md) 停。
