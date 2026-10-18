# Agent Note: 服务端测试用脚本扮演帮工

Status: implemented

## Problem

帮工的逻辑（派活、汇报、收获、冲突、上限、重启后接回、没动静）要能反复测。用真实的 runtime 跑测试要联网、要登录、花钱，而且慢、不稳定。

## Decision

`cd server && go test ./...`（每个服务的包有自己的测试，用 `world_test.go` 的 `newWorld` 建它和它下面的服务；一路走过好几个包的在 `internal/workspace`，见 [一个概念一个包](.agents/notes/implemented/architecture/2026-10-16-a-package-per-concept.md)；当初是 TypeScript 服务端的 vitest 测试，随它一起删了，这一套原样搬到了 Go）：

- 帮工由 smith（oar 的 Go 移植）的 `oartest`（`server/pkg/smith/oartest`）扮演，对应 oar 的 `scriptedRuntime`：一个真实的会话（同样的记录、同样的折叠、同样的控制语义），没有程序、登录和模型。脚本按工单里的字眼行事：跑一条命令、提交一个文件、写一个版本、发呆、失败、解决冲突。
- 每个测试在临时目录里用真的 git 仓库和 worktree。
- 核心状态的 `Reduce` 和推导是纯函数，单独测；读会话事件、读汇报、上限也是（`internal/session/facts.go`、`internal/session/rules.go`；protocol 的规则在 `server/internal/protocol/*_test.go`），一个事件进去、事实出来，不开会话（[规则是纯函数](docs/subsystems/session.md)）。

## Alternatives considered

**用真实的 pi 跑。** 联网、花钱、慢，结果还不固定；真实运行留给手动验证。

**把 oar（现在是 smith）整个换成假的。** 测不到它的事件折叠和报告时机，正是最容易出错的地方。

## Consequences

服务端的这些测试（当时在 `internal/farm` 一个包里，一百四十多个）二十来秒跑完，不花钱。代价是脚本不是模型：模型会不会照规矩写「结论」、会不会自己解决冲突，只能真实运行时验证。
