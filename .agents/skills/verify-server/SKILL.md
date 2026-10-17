---
name: verify-server
description: 改了 VibeValley 服务端（server/internal/**、server/cmd/server、server/migrations、server/pkg/db）之后，在临时的家目录里起一个真的服务端，用接口和 /api/state 证明改动在跑着的程序上生效。用在：改了接口、核心状态、工单、群聊、设置、迁移；主人说「验证一下」「跑起来看看」「确认服务端能用」。只改了纯函数的规则、测试已经覆盖的，跑测试就够，不用它。
---

# 验证服务端

在临时目录里起一个和主人的数据隔开的服务端，调接口，看折好的核心状态。不碰 `~/.vibevalley`，也不占主人的 8787。

## 什么时候用

- 改了 `server/internal/handler`、`server/internal/protocol/api.go`：新的或改过的接口。
- 改了某个服务的行为（`issue`、`channel`、`setting`、`schedule`、`playbook`……），想看它经接口和 `/api/state` 出来的样子。
- 改了 `server/migrations` 或 `server/pkg/db/queries`：新库能建、能读写。
- 改了开机的流程（`server/cmd/server`、`server/internal/workspace`）。

不用它：只改了纯函数、黄金数据和单元测试已经覆盖的；只改了注释和文档。

这个 skill 不派真的帮工：真的帮工要本机登录的农机（`claude`、`codex`、`pi`……）或 DeepSeek 的钥匙，会花钱，要先问主人。帮工的行为用 `oartest` 写测试（[server/README.md](../../../server/README.md)）。

## 准备

1. 先过检查，失败就不用往下走：

   ```bash
   cd server && go vet ./... && go test ./...
   ```

2. 改了 `shapes.go` 或 `api.go`，先生成：`cd server && go run ./tool/shapegen`。改了 `pkg/db/queries` 或 `migrations`，先跑 sqlc（命令见 [AGENTS.md](../../../AGENTS.md#命令)）。
3. 选一个空着的端口，下面用 8899。`lsof -iTCP:8899 -sTCP:LISTEN` 没有输出就是空的。

## 步骤

1. 建临时目录，编出服务端。用 `go build` 而不是 `go run`，这样停的时候能按路径找到进程：

   ```bash
   V=$(mktemp -d) && mkdir -p $V/home $V/work && echo $V
   cd server && go build -o $V/server ./cmd/server
   ```

   如果每条命令跑在新的 shell 里（agent 的 Bash 工具就是这样），`$V` 不会留下来：记下 `echo` 出的路径，后面每条命令前面都加上 `V=<这个路径>`。

2. 在后台起服务端，等它答健康检查：

   ```bash
   VIBEVALLEY_HOME=$V/home VIBEVALLEY_WORK_ROOT=$V/work VIBEVALLEY_PORT=8899 $V/server --log $V/server.log > $V/stdout.log 2>&1 & disown
   for i in $(seq 1 30); do curl -sf http://127.0.0.1:8899/api/health && break; sleep 0.5; done
   ```

   `disown` 让服务端在这条命令的 shell 退出后还活着。成功时输出 `{"ok":true,"version":"…"}`，`$V/server.log` 里有 `vibevalley: listening on http://127.0.0.1:8899`。

3. 调改动涉及的接口。全部接口在 `server/internal/protocol/api.go` 的 `//vibevalley:route` 注释里，请求和返回的形状在 `shapes.go`。例如新建一张工单：

   ```bash
   curl -s -X POST http://127.0.0.1:8899/api/issues -H 'content-type: application/json' -d '{"title":"verify smoke"}'
   ```

   返回新工单，`"status":"backlog"`。

4. 读折好的核心状态，确认改动出现在该出现的字段里。`/api/state` 是 SSE，第一帧就是全量：

   ```bash
   curl -sN --max-time 2 http://127.0.0.1:8899/api/state | head -c 2000
   ```

   第一行是 `data: {"state":{…},"inbox":[…],"plans":[…],"view":{…},"effects":[…]}`。上一步的工单在 `state.issues` 里。

5. 要看副作用（声音、提示）的，读 `GET /api/events`（SSE）。要看库里的，用 `sqlite3 $V/home/vibevalley.db`。
6. 改了服务端的代码要再看一次：先停（见「收拾」），重新 `go build`，再从第 2 步起。服务端不自动重载。
7. 要连客户端一起看，服务端开着，接着用 [verify-app](../verify-app/SKILL.md)。

## 证据

说「验证过了」时，给主人看：

- 第 2 步健康检查的输出。
- 第 3 步的请求和返回（去掉无关的字段）。
- 第 4 步 `/api/state` 里和改动有关的那一段。
- 服务端日志里有没有 `error`、`panic`：`grep -iE 'error|panic' $V/server.log`。

## 出错时

- **健康检查一直不答**：看 `$V/stdout.log` 和 `$V/server.log`。`address already in use` 是端口被占，换一个端口。迁移失败会在开机时报出来，修迁移。
- **接口返回 404**：路由没注册，或者服务端还是旧的二进制。确认 `api.go` 里有这个 `//vibevalley:route`、跑过 `shapegen`、重新 `go build` 过。
- **状态里没有新字段**：新字段要在 `shapes.go` 里加、在 `protocol` 的 `Reduce` 里折（[AGENTS.md](../../../AGENTS.md#规矩)「核心状态只有一份」）。
- **读到了主人的数据**：`VIBEVALLEY_HOME` 没设上。停掉，检查第 2 步的命令。

## 收拾

```bash
pkill -f "$V/server"
rm -rf "$V"
```

`pgrep -f "$V/server"` 没有输出，`curl -s --max-time 1 http://127.0.0.1:8899/api/health` 也没有输出，就是停了。
