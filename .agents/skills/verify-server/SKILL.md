---
name: verify-server
description: 改了 VibeValley 服务端（apps/server/src/**、apps/server/db、packages/protocol 的接口或形状）之后，在临时的家目录里起一个真的服务端，用接口和 /api/v1/state 证明改动在跑着的程序上生效。用在：改了接口、核心状态、工单、群聊、设置、表结构；主人说「验证一下」「跑起来看看」「确认服务端能用」。只改了纯函数的规则、测试已经覆盖的，跑测试就够，不用它。
---

# 验证服务端

在临时目录里起一个和主人的数据隔开的服务端，调接口，看折好的核心状态。不碰 `~/.vibevalley`，也不占主人的 8787。

## 什么时候用

- 改了 `apps/server/src/handlers.ts`、`apps/server/src/http`、`packages/protocol/src/api.ts`：新的或改过的接口。
- 改了某个服务的行为（`issue`、`channel`、`setting`、`recurrence`、`task`……），想看它经接口和 `/api/v1/state` 出来的样子。
- 改了 `apps/server/db/migrations` 或 `apps/server/db/queries`：新库能建、能读写。
- 改了开机的流程（`apps/server/src/main.ts`、`services.ts`、`http/app.ts`）。

不用它：只改了纯函数、黄金数据和单元测试已经覆盖的；只改了注释和文档。

这个 skill 不派真的帮工：真的帮工要本机登录的农机（`claude`、`codex`、`pi`……）或 DeepSeek 的钥匙，会花钱，要先问主人。要把一张工单真的派出去、交回来、完成，用 `--scripted-helper`（步骤 3）：pi 换成服务端测试里照工单字眼干活的帮工（`apps/server/src/testing/helper.ts`），别的农机都当没装。帮工的更多行为照样写测试（[地基](docs/subsystems/foundation.md)「测试」）。

## 准备

1. 先跑 `bun run server:check`。
2. 改了查询或表结构，先 `cd apps/server && npm run db:generate`；改了接口，先 `bun run capabilities`。

## 步骤

1. 在仓库根目录跑隔离的健康检查：

   ```bash
   bun scripts/verify-server.ts
   ```

   脚本用 Node 和 tsx 从 `apps/server` 起服务端，用临时家目录、工作目录和回环地址的空闲端口，环境里去掉一切钥匙；收到子进程的 JSON 就绪收据后做健康检查。`apps/web/dist` 在的话一起提供页面。结束时停服务端、删临时数据，打印证据目录。

2. 把本轮验证作为子命令交给同一脚本：

   ```bash
   bun scripts/verify-server.ts -- sh -c '"$VIBEVALLEY_VERIFY_CLI" issue list && "$VIBEVALLEY_VERIFY_CLI" state'
   ```

   子命令得到 `VIBEVALLEY_SERVER`（服务端的地址）和 `VIBEVALLEY_VERIFY_CLI`（连着它的命令行，`help` 列出全部接口）。需要造数据或断言时，把这些步骤写进同一个子命令；每次调用都是一个新农场。子命令失败仍会停止服务端，并保留它的退出码。

3. 改了工单怎么派、怎么走、怎么交付，只用命令行走一遍：

   ```bash
   bun scripts/verify-server.ts --scripted-helper -- sh -c '
     vv() { "$VIBEVALLEY_VERIFY_CLI" "$@"; }
     set -e
     vv issue create --json "{\"title\":\"写打卡并提交\",\"project\":\"clock\",\"assignee\":\"docs\"}"
     vv issue run 1
     vv issue status 1 --dry-run --json "{\"status\":\"done\"}"
     vv issue status 1 --json "{\"status\":\"done\"}"
     git -C "$(vv project list | jq -r ".[0].path")" log --oneline main
   '
   ```

   每条命令的 stdout 是一个 JSON 文档：`issue run` 等帮工交回来、打出改动（经过的状态在 stderr），`--dry-run` 答复会做什么（`{"does":[…]}`）、什么都不动，真做以后 `status` 是 `done`、`delivered` 是 `merged`，`git log` 里有帮工的提交。帮工照标题里的字眼干活（「写打卡」写 `clock.ts` 并提交，别的字眼见 `helper.ts`）；档案要用不带思考力度的（`docs`、`night`），带了的（`lab`）会被它拒。被拒的命令退出码是 3，stderr 最后一行是带 `next` 的 JSON，`next` 里的 `run` 能原样接在 `vv` 后面跑；要断言失败，用 `|| true` 接住，再读那一行。`scripts/verify-server.test.ts` 跑着同样的一遍。

4. 读证据目录的 `command.stdout.log`、`command.stderr.log` 和 `server.stdout.log`、`server.stderr.log`，核对接口结果、状态及错误。只有启动成功的 `health.json` 不能证明业务改动生效。
5. 要看页面，先 `bun run --filter vibevalley-web build`，再在同一个子命令中造数据、跑 [verify-app](.agents/skills/verify-app/SKILL.md) 的截图命令。

## 证据

- 本轮执行的命令；只用命令行走的，附上每条命令打出的 JSON（`command.stdout.log`）。
- 证据目录的 `ready.json`、`health.json`、`result.json`，以及与改动有关的接口或状态片段。
- `result.json` 的退出码应为 0，`stopped` 应为 true；业务断言应在子命令里完成。
- 服务端日志中的错误和它们的结论。

## 出错时

- **启动失败或健康检查超时**：看 `server.stdout.log`、`server.stderr.log`（类型错误、表结构对不上、端口）。脚本已经停止它启动的进程。
- **清理失败**：看 `result.json` 的 `cleanupErrors`；`stopped` 为 false 时临时目录会保留，不应把它当成已收拾。
- **验证失败**：看 `command.stderr.log` 和 `command.stdout.log`；脚本不会把非零退出码改成成功。
- **接口或形状对不上**：跑 `bun run server:check` 和 `bun run web:check`；服务端每次从源码起，没有旧的构建。

## 收拾

脚本自动停掉自己的服务端并删除临时 `home`、`work`，不碰主人的农场。证据日志留在打印的临时目录，交付后可删。截图在 `apps/web/.screens/`，照 verify-app 交付。
