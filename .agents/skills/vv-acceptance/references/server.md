# 验收服务端

[验收](.agents/skills/vv-acceptance/SKILL.md)的一份分册：在沙箱里调接口，看按域切片（`/api/v1/slice/{name}`：`board`、`sessions`、`collab`、`inbox`、`ops` 与独立 `farm`）；改了工单的走法，用命令行把一张工单派出去、交回来、完成。

## 什么时候用

- 改了 `crates/server`（模块、端点、开机的 [start.rs](crates/server/src/start.rs)、[main.rs](crates/server/src/main.rs)）、`crates/core`、`crates/server/src/transport/http`：新的或改过的接口、服务的行为、表结构。
- 改了 `crates/protocol` 的接口或形状（生成到 `packages/protocol`）。
- 改了命令行 `crates/cli`。

真的帮工要本机登录的农机（`claude`、`codex`……）或 DeepSeek 的钥匙，会花钱，要先问用户；这里用 `--scripted-helper`：沙箱设 `VIBEVALLEY_TEST_RUNTIMES=1`，服务端只装一个照工单字眼干活的替身农机 `pi`（[testing.rs](crates/server/src/testing.rs)），别的农机都当没装。帮工的更多行为照样写测试（`crates/server/tests/`）。

## 准备

1. `vp run rust:check`（至少跑改动所在 crate 的 `cargo test -p <crate>`）。
2. `cargo build -p vibevalley-server -p vibevalley-cli`：沙箱用 `${CARGO_TARGET_DIR:-target}/debug` 下的两个二进制（`VIBEVALLEY_SERVER_BIN` 可指定别的服务端），不会替你构建；改了代码没重新构建，验的就是旧的。
3. 改了接口，先 `vp run capabilities`。

## 步骤

1. 只看服务端起得来：

   ```bash
   vpx scripts/release/verify-server.ts
   ```

2. 调这次改动的接口、看切片快照（`state --json` 拉全量 6 路快照，`state --slice <board|sessions|collab|inbox|ops|farm> [--watch] --json` 读或流式看单个 `/api/v1/slice/{name}`）：

   ```bash
   vpx scripts/release/verify-server.ts -- sh -c '"$VIBEVALLEY_VERIFY_CLI" state --slice board --json && "$VIBEVALLEY_VERIFY_CLI" issue list --json'
   ```

   要造数据或断言，写进同一个子命令。

3. 改了工单怎么派、怎么走、怎么交付，只用命令行走一遍：

   ```bash
   vpx scripts/release/verify-server.ts --scripted-helper -- sh -c '
     vv() { "$VIBEVALLEY_VERIFY_CLI" "$@"; }
     set -e
     vv issue create 写打卡并提交 --repo clock --agent docs
     vv issue status 1 todo
     vv issue show 1 --watch --timeout 60
     vv issue diff 1 --json
     vv issue status 1 done --dry-run --json
     vv issue status 1 done --json
     git -C "$(vv repo list --json | jq -r ".[0].path")" log --oneline main
   '
   ```

   带 `--json` 的命令，stdout 是一个 JSON 文档（不带是给人和 agent 读的短文字）：`issue status 1 todo` 派出去，`issue show --watch` 等帮工交回来（经过的状态在 stderr），`issue diff` 是改动，`--dry-run` 答复会做什么（`{"does":[…]}`）、什么都不动，真做以后 `status` 是 `done`、`delivered` 是 `merged`，`git log` 里有帮工的提交。帮工照标题里的字眼干活（「提交」写 `clock.ts` 并提交，别的字眼见 [testing.rs](crates/server/src/testing.rs)）。被拒的命令退出码是 3，stderr 最后一行是带 `next` 的 JSON，`next` 里的 `run` 能原样接在 `vv` 后面跑；要断言失败，用 `|| true` 接住，再读那一行。`scripts/release/verify-server.test.ts` 跑着同样的一遍。

4. 页面也改了的，再照 [app.md](.agents/skills/vv-acceptance/references/app.md) 起应用截图。

### 真实帮工的 MCP

仅在用户已授权真实农机验收时执行；需要本机登录的 Codex 或 Claude Code，会消耗模型额度。先跑最低层的测试：`cargo test -p vibevalley-server --test session --test mcp`、`cargo test -p vibevalley-cli`。

1. 子命令里建仓库和用真农机的档案（`vv repo create acceptance`、`vv agent create acceptance --runtime codex`），建一张只让帮工经 `vibevalley` MCP 调 `session_list` 再调 `issue_report` 交回的工单，派出去，`vv issue watch 1 --json` 看到工具调用与交回。
2. 非法 Bearer 令牌请求 `POST /mcp` 被拒（401/403 或 JSON-RPC 鉴权错误），响应不回显有效凭证。
3. 不带 `--scripted-helper` 执行：`env -u OAR_SUBAGENT_DEPTH vpx scripts/release/verify-server.ts -- sh <证据目录>/worker.sh`，保存命令、HEAD、stdout、stderr 和退出码。健康检查、agent 自述或单独的退出码不能替代工单的轨迹与状态。

## 证据

- 只用命令行走的，附上每条命令打出的 JSON（`command.stdout.log`）。
- `ready.json`、`health.json`、`result.json`，以及与改动有关的接口或状态片段。

## 出错时

- **`issue status 1 todo` 被拒或帮工不动**：没带 `--scripted-helper`，或标题里没有帮工认得的字眼（见 [testing.rs](crates/server/src/testing.rs)）。
- **行为还是旧的**：没重新 `cargo build -p vibevalley-server -p vibevalley-cli`，或 `CARGO_TARGET_DIR` 和构建时不同。

## 收拾

沙箱自己收；没有别的要收拾的。
