# Agent Note: 用 VibeValley 开发 VibeValley：Beta 干活，源码试改，Alpha 试包

Status: proposed

## Problem

主人想把 VibeValley 自己的活派给 VibeValley：工单派给帮工，帮工在 worktree 里改 heybro，主人看了合进 main。现在这样做有几处会出事：

- 拿来干活的农场和正在改的代码是同一份：源码里跑的服务端一重启、表结构一改，派出去的工单和田头就没了。
- 表结构只有一个基线，直接改（[不留兼容](../../implemented/architecture/2026-10-16-one-schema-no-old-data.md)）。`user_version` 数的是文件，基线改了它还是 1：新版本的服务端打开旧库不报错，跑到某条查询才炸。
- 合并在项目的检出里做：`project.go` 的 `mergeMain` 把检出当前的 HEAD 当主分支，直接在里面 `git merge`，不看工作区干不干净。
- 合并前不跑检查：普通工单收获时只看冲突，`go test`、`flutter:check`、`docs:verify` 没人跑。
- 三个渠道原来共用一个工作目录 `~/vibevalley-work`，项目和 worktree 混在一起：两个农场的帮工会在同一份项目里干活。

## Proposal

三个农场各干各的，用[已有的渠道](../../implemented/process/2026-10-12-release-channels.md)，不加新的：

| 农场 | 怎么来 | 用来 | 工作目录 |
|---|---|---|---|
| Beta | `bun run package:mac --channel beta` | 天天用，派 VibeValley 的活 | `~/vibevalley-beta` |
| 源码 | `go run ./cmd/server` 加 `flutter run` | 改 VibeValley 时试 | `~/vibevalley-dev` |
| Alpha | 源码看着可以了，`--channel alpha` 打一个包 | 装上当新的 Beta 用一阵 | `~/vibevalley-alpha` |

每个工作目录里 `projects/` 是项目，`worktrees/` 是帮工的 worktree：VibeValley 自己是 `~/vibevalley-beta/projects/vibevalley`（heybro 的一份克隆），帮工的地是 `~/vibevalley-beta/worktrees/vibevalley.<帮工>-<时间>`，小地图上一个项目一座岛，岛上的地就是这些 worktree。农场合进的是自己那份克隆的 main，主人在别处的检出经 origin 拉取，碰不到。这一条已经做了：服务端的默认是 `~/vibevalley-dev`，打包的应用按渠道（`channel.dart` 的 `workFolder`）。

Alpha 用下来没问题，就用同一个提交打 Beta，换掉旧的。Beta 只在这个时候换，平时不动，所以帮工干到一半不会被重启打断。

光有渠道不够，下面几件要先做。打 Beta 之前，先只用服务端和命令行走通一遍（[先只用服务端和命令行](2026-10-18-a-feature-through-server-and-cli.md)），这几件也在那条路上做：

1. **库认得出自己的表结构**：服务端把 `0001_schema.sql` 的指纹记在库里（比如一张只有一行的 `core_schema` 表）。开机时指纹对不上，就把旧库挪成 `vibevalley.db.<旧指纹>`，按今天的表结构建一个新的，并在日志和田头说一声。旧数据不搬，挪开只是为了能回头看一眼。换 Beta 时工单板和田头会清空，代码和分支都在 git 里，丢不了。改表结构的提交攒着一起换，不要每次都换。
2. **合并认准主分支、不卷进没提交的改动**：农场的项目是自己的克隆，主人不在里面干活，但直接在项目里干的帮工（不开 worktree 的）会留下改动。主分支用项目定的名字，不用检出当前的 HEAD；合并在没有工作区的地方算（`git merge-tree --write-tree` 加 `commit-tree`，再改 `refs/heads/<主分支>`）。检出停在主分支上时，工作区干净就跟着快进，不干净就不合，说出哪几个文件。冲突照旧交回帮工。
3. **合并前的检查**：合并前在帮工的分支变基到主分支以后跑项目的检查；没过就不合，输出交回帮工，和冲突一样处理。检查放在哪见[那篇](2026-10-18-a-feature-through-server-and-cli.md)。新开的 worktree 不用另外准备：实测 `flutter analyze` 会自己装依赖，Go 用本机的模块缓存。

## Alternatives considered

**只用源码跑的服务端干活，不打包。** 最省事，但改一次服务端就得重启，派出去的活跟着断。改表结构还会清掉干活用的库。

**为 Beta 保留数据搬运。** 换包时工单不丢，但这违背了「不留兼容」。现在没有外面的用户，丢的只是本机的工单板。

**检出不干净时照样改 ref。** 主分支的 ref 往前走了，工作区却没跟着变，`git status` 会把刚合进来的改动显示成反向的未提交改动，比拒绝合并更糟。

## Acceptance criteria

- 指纹：改一下 `0001_schema.sql` 再用旧库开机，旧库被挪走，新库能读 `GET /api/v1/state`，日志里写了挪到哪。
- 目录：Beta 派到 `vibevalley` 的活，worktree 开在 `~/vibevalley-beta/worktrees/vibevalley.<帮工>-<时间>`；源码跑的服务端开在 `~/vibevalley-dev` 下。
- 合并：检出在别的分支上时，合并只动 `refs/heads/main`，工作区不变；检出停在 main 且有未提交改动时，合并被拒，并说出那几个文件。这两种都在 `project` 的测试里用真的 git 仓库测。
- 检查：故意让检查命令失败，工单不合，失败的输出出现在帮工的田头里。
- 整个流程：Beta 里派一个改文档的小工单，帮工改完、检查过了、合进农场那份克隆的 main，推到 origin 以后主人的检出能拉到它。

## Risks

- Beta 的家目录（`~/Library/Application Support/vibevalley Beta`）要单独填一次帮工档案和语音凭据；`~/vibevalley-beta/projects/vibevalley` 要先克隆好。
- 换 Beta 会清空工单板和田头。要是嫌这一步太疼，再考虑是不是给工单开一条导出的路，不在读库的地方兜底。
- 农场那份克隆的 main 和 origin 会分叉：谁来推、什么时候推，先由主人手动做；以后可以做成合并后可选地推一次。
- 原来 `~/vibevalley-work` 下的项目不搬（不留兼容），要用就自己挪进新工作目录的 `projects/`。
