# 验收服务端

[验收](.agents/skills/vv-acceptance/SKILL.md)的一份分册：在沙箱里调接口，看折好的核心状态；改了工单的走法，用命令行和接口把一张工单派出去、交回来、完成。

## 什么时候用

- 改了 `internal/domain/gateway/**`、`packages/protocol/src/api.ts`：新的或改过的接口。
- 改了某个服务的行为（`issue`、`channel`、`setting`、`cron`……），想看它经接口和 `/api/v1/state` 出来的样子。
- 改了 `internal/domain/*/migrations`、`queries.sql` 或 `internal/durable/store/{migrations,queries.sql}`：新库能建、能读写。
- 改了开机的流程（`cmd/vibe-server/main.go`、`internal/domain/stack/stack.go`、`internal/domain/gateway/gateway.go`）。

真的帮工要本机登录的农机（`claude`、`codex`、`pi`……）或模型钥匙，会花钱，要先问用户；这里用 `--scripted-helper`：沙箱挂接 `scripts/release/verify-server.ts` 里的脚本帮工（设好 `VIBEVALLEY_AGENT_STARTERS`）。帮工与回放的更多行为照样写 Go 测试（[地基](docs/subsystems/foundation.md)「测试」）。

## 准备

1. `vp run server:check`。
2. 改了 SQL 查询或表结构，先 `vp run go:sqlc`；改了契约或接口，先 `vpx scripts/gen/go-contract.ts --write` 与 `vp run capabilities`。

## 步骤

1. 只看服务端起得来：

   ```bash
   vpx scripts/release/verify-server.ts
   ```

2. 调这次改动的接口、看状态：

   ```bash
   vpx scripts/release/verify-server.ts -- sh -c '"$VIBEVALLEY_VERIFY_CLI" issue list --json'
   ```

   要造数据或断言，写进同一个子命令。

3. 改了工单怎么派、怎么走、怎么交付，在沙箱里走一遍（与 `scripts/release/verify-server.test.ts` 同路）：

   ```bash
   vpx scripts/release/verify-server.ts --scripted-helper -- sh -c '
     vv() { "$VIBEVALLEY_VERIFY_CLI" "$@"; }
     set -e
     curl -fsS -H "Content-Type: application/json" -d "{\"name\":\"clock\"}" "$VIBEVALLEY_SERVER/api/v1/repo/create" >/dev/null
     created=$(vv issue create 写打卡并提交 --repo clock --agent docs --json)
     id=$(printf "%s" "$created" | jq -r .id)
     vv issue status "$id" todo --json >/dev/null
     until [ "$(vv issue get "$id" --json | jq -r .status)" = "in_review" ]; do sleep 0.2; done
     curl -fsS -H "Content-Type: application/json" -d "{\"id\":\"$id\"}" "$VIBEVALLEY_SERVER/api/v1/issue/diff/get"
     curl -fsS -H "Content-Type: application/json" -d "{\"id\":\"$id\",\"status\":\"done\"}" "$VIBEVALLEY_SERVER/api/v1/issue/status/previewUpdate"
     vv issue status "$id" done --json
   '
   ```

   带 `--json` 的命令 stdout 是 JSON 文档（不带是短文字）：`issue status "$id" todo` 派出去，轮询 `issue get` 等帮工交回（进入 `in_review`），`/api/v1/issue/diff/get` 看改动，`/api/v1/issue/status/previewUpdate` 预演交付、`issue status "$id" done` 真正合入交付；详情以 `scripts/release/verify-server.ts` 与 `scripts/release/verify-server.test.ts` 为准。

4. 页面也改了的，在同一个子命令末尾接上 [page.md](.agents/skills/vv-acceptance/references/page.md) 的截图命令。

### 真实帮工的 CLI 与连接观测

仅在用户已授权真实农机验收时执行；需要本机 Codex 登录，会消耗模型额度。普通规则先跑 Go 侧测试：`env -u GOROOT CGO_ENABLED=0 go test -count=1 ./internal/domain/agent/... ./internal/domain/stack/... ./internal/domain/gateway/... ./cmd/vibe/... ./pkg/oar/...`。

1. 把下列脚本存到独立临时证据目录的 `worker.sh`。它只创建沙箱项目，不读取外部账号配置文件。

```sh
#!/bin/sh
set -eu
vv() { "$VIBEVALLEY_VERIFY_CLI" "$@"; }
vv runtime list --json
curl -fsS -H 'Content-Type: application/json' -d '{"name":"acceptance"}' "$VIBEVALLEY_SERVER/api/v1/repo/create" >/dev/null
agent_id=$(curl -fsS -H 'Content-Type: application/json' -d '{"name":"acceptance","runtime":"codex"}' "$VIBEVALLEY_SERVER/api/v1/agent/create" | jq -r .id)
vv doctor --json
vv issue create 'Verify isolated worker access' --repo acceptance --agent "$agent_id" --description 'This is an authorized acceptance test. Do not edit code or commit. Run doctor, print NO_PROXY and no_proxy, and verify loopback bypass variables include 127.0.0.1,localhost,::1. Do not launch other agents.' --json
```

2. 派工、跟踪状态流与完成工单时，对照 `/api/v1/state`、会话轨迹及 `vibe doctor --json` 输出；清除代理环境变量只影响沙箱命令：

```sh
env -u NO_PROXY -u no_proxy -u OAR_SUBAGENT_DEPTH vpx scripts/release/verify-server.ts -- sh <证据目录>/worker.sh
```

3. 核对 `command.stdout.log`、`server.stderr.log` 与 `result.json`（`code: 0`、`stopped: true` 和空 `cleanupErrors`）。健康检查或 agent 自述不能替代上述轨迹与状态。日志留在临时目录，不放进工作树。

## 证据

- 只用命令行和接口走的，附上每步输出（`command.stdout.log`）。
- `ready.json`、`health.json`、`result.json`，以及与改动有关的接口或状态片段。

## 出错时

- **starter agent（如 `docs`）不存在**：`verify-server.ts` 仅在 `--scripted-helper` 时写入 `VIBEVALLEY_AGENT_STARTERS`（默认含 `docs`）；不用该开关时需先调 `/api/v1/agent/create` 建档案。
- **表结构或生成产物对不上**：先跑 `vp run go:sqlc`、`vpx scripts/gen/go-contract.ts --write` 与 `vp run server:check`。

## 收拾

沙箱自己收；没有别的要收拾的。
