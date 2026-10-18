---
name: verify-server
description: 改了 VibeValley 服务端（server/internal/**、server/cmd/server、server/migrations、server/pkg/db）之后，在临时的家目录里起一个真的服务端，用接口和 /api/v1/state 证明改动在跑着的程序上生效。用在：改了接口、核心状态、工单、群聊、设置、迁移；主人说「验证一下」「跑起来看看」「确认服务端能用」。只改了纯函数的规则、测试已经覆盖的，跑测试就够，不用它。
---

# 验证服务端

在临时目录里起一个和主人的数据隔开的服务端，调接口，看折好的核心状态。不碰 `~/.vibevalley`，也不占主人的 8787。

## 什么时候用

- 改了 `server/internal/handler`、`server/internal/protocol/api.go`：新的或改过的接口。
- 改了某个服务的行为（`issue`、`channel`、`setting`、`schedule`、`task`……），想看它经接口和 `/api/v1/state` 出来的样子。
- 改了 `server/migrations` 或 `server/pkg/db/queries`：新库能建、能读写。
- 改了开机的流程（`server/cmd/server`、`server/internal/workspace`）。

不用它：只改了纯函数、黄金数据和单元测试已经覆盖的；只改了注释和文档。

这个 skill 不派真的帮工：真的帮工要本机登录的农机（`claude`、`codex`、`pi`……）或 DeepSeek 的钥匙，会花钱，要先问主人。帮工的行为用 `oartest` 写测试（[server/README.md](server/README.md)）。

## 准备

1. 先跑 `cd server && go vet ./... && go test ./...`。
2. 改了形状或查询，先按 [AGENTS.md](AGENTS.md#命令) 生成代码。

## 步骤

1. 在仓库根目录跑隔离的健康检查：

   ```bash
   bun scripts/verify-server.ts
   ```

   脚本编出服务端和命令行，用临时家目录、工作目录和回环地址的空闲端口启动，收到子进程的 JSON 就绪收据后再做健康检查。结束时停服务端、删临时数据和 binary，打印证据目录；不用选端口、后台挂进程或跨 shell 记 PID。

2. 把本轮验证作为子命令交给同一脚本：

   ```bash
   bun scripts/verify-server.ts -- sh -c '"$VIBEVALLEY_VERIFY_CLI" issue list && "$VIBEVALLEY_VERIFY_CLI" state'
   ```

   子命令得到 `VIBEVALLEY_SERVER` 和 `VIBEVALLEY_VERIFY_CLI`。需要造数据或断言时，把这些步骤写进同一个验证脚本再作为子命令传入；每次调用都是一个新农场。子命令失败仍会停止服务端，并保留它的退出码。

3. 读证据目录的 `command.stdout.log`、`command.stderr.log` 和 `server.log`，核对接口结果、状态及错误。只有启动成功的 `health.json` 不能证明业务改动生效。
4. 要看客户端，在同一个子命令中先造数据、再运行 [verify-app](.agents/skills/verify-app/SKILL.md) 的截图命令。

## 证据

- 本轮执行的命令。
- 证据目录的 `ready.json`、`health.json`、`result.json`，以及与改动有关的接口或状态片段。
- `result.json` 的退出码应为 0，`stopped` 应为 true；业务断言应在子命令里完成。
- `server.log` 中的错误、panic 及其结论。

## 出错时

- **编译失败**：看 `build.stderr.log`，修好再跑。
- **启动失败或健康检查超时**：看 `server.log`、`server.stderr.log`。脚本已经停止它启动的进程。
- **清理失败**：看 `result.json` 的 `cleanupErrors`；`stopped` 为 false 时临时目录会保留，不应把它当成已收拾。
- **验证失败**：看 `command.stderr.log` 和 `command.stdout.log`；脚本不会把非零退出码改成成功。
- **接口或形状对不上**：重跑生成和构建检查；脚本每次重新编译，不复用旧 binary。

## 收拾

脚本自动停掉自己的服务端并删除临时 `home`、`work`、`bin`，不碰主人的农场。证据日志留在打印的临时目录，交付后可删。截图在 `app/build/`，照 verify-app 交付。
