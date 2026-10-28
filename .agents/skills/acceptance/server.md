# 验收服务端

[验收](.agents/skills/acceptance/SKILL.md)的一份分册：在沙箱里调接口，看折好的核心状态；改了工单的走法，用命令行把一张工单派出去、交回来、完成。

## 什么时候用

- 改了 `apps/server/src/handlers.ts`、`apps/server/src/http`、`packages/protocol/src/api.ts`：新的或改过的接口。
- 改了某个服务的行为（`issue`、`channel`、`setting`、`cron`、`task`……），想看它经接口和 `/api/v1/state` 出来的样子。
- 改了 `apps/server/db/migrations` 或 `apps/server/db/queries`：新库能建、能读写。
- 改了开机的流程（`apps/server/src/main.ts`、`services.ts`、`http/app.ts`）。

真的帮工要本机登录的农机（`claude`、`codex`、`pi`……）或 DeepSeek 的钥匙，会花钱，要先问主人；这里用 `--scripted-helper`：pi 换成服务端测试里照工单字眼干活的帮工（`apps/server/src/testing/helper.ts`），别的农机都当没装。帮工的更多行为照样写测试（[地基](docs/subsystems/foundation.md)「测试」）。

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
   vpx scripts/verify-server.ts -- sh -c '"$VIBEVALLEY_VERIFY_CLI" issue list && "$VIBEVALLEY_VERIFY_CLI" state'
   ```

   要造数据或断言，写进同一个子命令。

3. 改了工单怎么派、怎么走、怎么交付，只用命令行走一遍：

   ```bash
   vpx scripts/verify-server.ts --scripted-helper -- sh -c '
     vv() { "$VIBEVALLEY_VERIFY_CLI" "$@"; }
     set -e
     vv issue create --json "{\"title\":\"写打卡并提交\",\"project\":\"clock\",\"assignee\":\"docs\"}"
     vv issue work 1
     vv issue status update 1 --dry-run --json "{\"status\":\"done\"}"
     vv issue status update 1 --json "{\"status\":\"done\"}"
     git -C "$(vv project list | jq -r ".[0].path")" log --oneline main
   '
   ```

   每条命令的 stdout 是一个 JSON 文档：`issue work` 等帮工交回来、打出改动（经过的状态在 stderr），`--dry-run` 答复会做什么（`{"does":[…]}`）、什么都不动，真做以后 `status` 是 `done`、`delivered` 是 `merged`，`git log` 里有帮工的提交。帮工照标题里的字眼干活（「写打卡」写 `clock.ts` 并提交，别的字眼见 `helper.ts`）；档案要用不带思考力度的（`docs`、`night`），带了的（`lab`）会被它拒。被拒的命令退出码是 3，stderr 最后一行是带 `next` 的 JSON，`next` 里的 `run` 能原样接在 `vv` 后面跑；要断言失败，用 `|| true` 接住，再读那一行。`scripts/verify-server.test.ts` 跑着同样的一遍。

4. 页面也改了的，在同一个子命令末尾接上 [page.md](.agents/skills/acceptance/page.md) 的截图命令。

## 证据

- 只用命令行走的，附上每条命令打出的 JSON（`command.stdout.log`）。
- `ready.json`、`health.json`、`result.json`，以及与改动有关的接口或状态片段。

## 出错时

- **`issue work` 被拒**：档案带了思考力度（换 `docs`、`night`），或标题里没有帮工认得的字眼（见 `helper.ts`）。
- **表结构对不上**：`db/generated` 不是最新的，`vp run --filter @vibevalley/server db:generate`。

## 收拾

沙箱自己收；没有别的要收拾的。
