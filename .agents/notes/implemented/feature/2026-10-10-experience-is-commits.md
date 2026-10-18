# Agent Note: 农场经验就是你的 commit

Status: implemented

## Problem

最早经验来自完成的工单：派得越多、做得越多，等级越高。这奖励的是忙，不是落地的代码：一张工单做完但没人要，也算经验。

## Decision

经验就是工作目录（`VIBEVALLEY_WORK_ROOT`）下所有 git 仓库里你名下的 commit 数（`server/internal/game/commits.go`）：

- 只算帮工干活的目录，所有分支都算（帮工在自己分支上的提交也算，它们用这台机器的 git 用户提交），同一仓库的多个 worktree 只算一次。
- 「你名下」按作者邮箱：git 全局和各仓库的 user.email，加上 `git_emails`。
- 服务端启动时、每 2 分钟、帮工干完一轮 15 秒后各数一次，变了就施加 `commits` 事实。
- 等级曲线：从 Lv.n 到 Lv.n+1 要 `10n` 个 commit；第一次数出 commit 数时只定下等级，不放升级横幅（protocol 的 `XPToNext`、`LevelUps`，`server/internal/protocol/game_view.go`）。

金币和连胜跟着收进主分支的活走（[achievements](.agents/notes/implemented/feature/2026-10-11-achievements.md)），不加经验（[farm-ui.md](docs/reference/farm-ui.md)「计分」）。

## Alternatives considered

**按完成的工单算。** 奖励忙碌，不奖励落地；失败重试也能刷。

**算这台机器上所有仓库的 commit。** 会把和 VibeValley 无关的工作也算进来；主人选了「只算帮工干活的目录」。

**算所有作者的 commit。** 别人的提交不是你的农场。

## Consequences

升级和真实产出挂钩，等级换客户端、跨重启都一样（以服务端为准）。代价是要定期扫目录、跑 git。
