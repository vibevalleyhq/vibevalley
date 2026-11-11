# 验收服务端

[验收](.agents/skills/vv-acceptance/SKILL.md)的一份分册：在沙箱里调接口，看折好的核心状态；改了工单的走法，用命令行把一张工单派出去、交回来、完成。

## 什么时候用

- 改了 `apps/server/src/gateway/http/handlers.ts`、`apps/server/src/gateway/http`、`packages/protocol/src/api.ts`：新的或改过的接口。
- 改了某个服务的行为（`issue`、`channel`、`setting`、`cron`、`task`……），想看它经接口和 `/api/v1/state` 出来的样子。
- 改了 `apps/server/db/migrations` 或 `apps/server/db/queries`：新库能建、能读写。
- 改了开机的流程（`apps/server/src/main.ts`、`services.ts`、`http/app.ts`）。

真的帮工要本机登录的农机（`claude`、`codex`、`pi`……）或 DeepSeek 的钥匙，会花钱，要先问用户；这里用 `--scripted-helper`：pi 换成服务端测试里照工单字眼干活的帮工（`apps/server/src/testing/worker.ts`），别的农机都当没装。帮工的更多行为照样写测试（[地基](docs/subsystems/foundation.md)「测试」）。

## 准备

1. `vp run server:check`。
2. 改了查询或表结构，先 `vp run --filter @vibevalley/server db:generate`；改了接口，先 `vp run capabilities`。

## 步骤

1. 只看服务端起得来：

   ```bash
   vpx scripts/verify-server.ts
   ```

2. 调这次改动的接口、看状态：

   ```bash
   vpx scripts/verify-server.ts -- sh -c '"$VIBEVALLEY_VERIFY_CLI" issue list --format json'
   ```

   要造数据或断言，写进同一个子命令。

3. 改了工单怎么派、怎么走、怎么交付，只用命令行走一遍：

   ```bash
   vpx scripts/verify-server.ts --scripted-helper -- sh -c '
     vv() { "$VIBEVALLEY_VERIFY_CLI" "$@"; }
     set -e
     vv issue create 写打卡并提交 --repo clock --agent docs
     vv issue status 1 todo
     vv issue show 1 --watch --timeout 60
     vv issue diff 1 --format json
     vv issue status 1 done --dry-run --format json
     vv issue status 1 done --format json
     git -C "$(vv repo list --format json | jq -r ".[0].path")" log --oneline main
   '
   ```

   带 `--format json` 的命令，stdout 是一个 JSON 文档（不带是给人和 agent 读的短文字）：`issue status 1 todo` 派出去，`issue show --watch` 等帮工交回来（经过的状态在 stderr），`issue diff` 是改动，`--dry-run` 答复会做什么（`{"does":[…]}`）、什么都不动，真做以后 `status` 是 `done`、`delivered` 是 `merged`，`git log` 里有帮工的提交。帮工照标题里的字眼干活（「写打卡」写 `clock.ts` 并提交，别的字眼见 `helper.ts`）；档案要用不带思考力度的（`docs`、`night`），带了的（`lab`）会被它拒。被拒的命令退出码是 3，stderr 最后一行是带 `next` 的 JSON，`next` 里的 `run` 能原样接在 `vv` 后面跑；要断言失败，用 `|| true` 接住，再读那一行。`scripts/release/verify-server.test.ts` 跑着同样的一遍。

4. 页面也改了的，在同一个子命令末尾接上 [page.md](.agents/skills/vv-acceptance/references/page.md) 的截图命令。

### 真实帮工的 CLI 与连接观测

仅在用户已授权真实农机验收时执行；需要本机 Codex 登录，会消耗模型额度。普通规则先跑服务端的 `src/modules/runtime/access.test.ts`、`src/modules/session/worker.test.ts`、`src/flows/worker-cli.test.ts`、`src/modules/issue/watch.test.ts`，以及 CLI 的 `src/issue-watch*.test.ts`、`src/worker.test.ts`。在各包目录运行 `env -u OAR_SUBAGENT_DEPTH vp test run <文件>`，根目录的测试配置只收集 scripts。

1. 把下列脚本存到独立临时证据目录的 `worker.sh`。它只创建沙箱项目，凭证文件只写入假令牌，不读取真实令牌。

```sh
#!/bin/sh
set -eu
vv() { "$VIBEVALLEY_VERIFY_CLI" "$@"; }
vv runtime list --format json
vv repo create acceptance --format json
agent_id=$(vv agent create acceptance --runtime codex --format json | jq -r .id)
vv agent list --format json | jq --arg id "$agent_id" '.[] | select(.id == $id) | .mcpServers=[{type:"http",name:"acceptance-broken",url:"http://127.0.0.1:1/mcp",headers:{}}]' > "$VIBEVALLEY_HOME/agent.json"
curl --noproxy '*' -fsS -H 'Content-Type: application/json' --data-binary "@$VIBEVALLEY_HOME/agent.json" "$VIBEVALLEY_SERVER/api/v1/agent/update"
printf '{"endpoint":"%s/mcp","token":"invalid-acceptance-token"}' "$VIBEVALLEY_SERVER" > "$VIBEVALLEY_HOME/invalid.json"
chmod 600 "$VIBEVALLEY_HOME/invalid.json"
set +e
apps/cli/node_modules/.bin/vpx apps/cli/src/worker.ts --worker-access-file "$VIBEVALLEY_HOME/invalid.json" doctor
invalid_code=$?
set -e
echo "invalid credential exit=$invalid_code"
test "$invalid_code" -ne 0
vv issue create 'Verify isolated worker access' --repo acceptance --agent "$agent_id" --description 'This is an authorized acceptance test. Do not edit code or commit. Use the absolute required worker CLI from your launch instructions. Run doctor, then print only NO_PROXY and no_proxy (no other environment variables). Check both contain 127.0.0.1,localhost,::1. Call the worker CLI report with {"summary":"isolated worker CLI acceptance passed","prSubmit":false,"checks":[{"criterion":0,"result":"met","proof":"doctor returned 0 and both loopback bypass variables include required hosts"}]}. Do not call MCP tools; this verifies the independent CLI. Do not launch other agents.' --format json
vv issue status 1 todo --format json
vv issue watch 1 --jsonl
vv issue show 1 --format json
vv session list --format json
```

2. 在仓库根目录执行 `env -u NO_PROXY -u no_proxy -u OAR_SUBAGENT_DEPTH vpx scripts/release/verify-server.ts -- sh <证据目录>/worker.sh`，保存命令、HEAD、stdout、stderr 和退出码。沙箱独立分配服务端及语音端口，不复用桌面服务。清除代理例外变量只影响这条验收命令；需要既有代理条目的合并规则由最低层回归测试覆盖。
3. 核对输出：非法凭证退出码为 3；watch 的 `state.sessions[].toolConnections` 中 `acceptance-broken` 为 `failed`，对应 `run/error` 事件含 `connection.status: failed`；Codex 经绝对 CLI 的 doctor 和 report 都返回成功，两个代理例外变量都有三个回环地址，最后 `settled: true`。agent 只用 CLI 交活；可选 MCP 的失败不应阻塞该入口。没有连接事件时只能判 unknown。
4. 核对 `result.json` 的 `code: 0`、`stopped: true` 和空 `cleanupErrors`。健康检查、agent 自述或单独的命令退出码不能替代上述轨迹与状态。日志留在临时目录，不放进会随 worktree 删除的 dist。

## 证据

- 只用命令行走的，附上每条命令打出的 JSON（`command.stdout.log`）。
- `ready.json`、`health.json`、`result.json`，以及与改动有关的接口或状态片段。

## 出错时

- **`issue status 1 todo` 被拒**：档案带了思考力度（换 `docs`、`night`），或标题里没有帮工认得的字眼（见 `helper.ts`）。
- **表结构对不上**：`db/generated` 不是最新的，`vp run --filter @vibevalley/server db:generate`。

## 收拾

沙箱自己收；没有别的要收拾的。
