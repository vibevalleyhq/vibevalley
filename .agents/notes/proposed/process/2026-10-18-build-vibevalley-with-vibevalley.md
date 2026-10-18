# Agent Note: 用 VibeValley 开发 VibeValley：Beta 干活，源码试改，Alpha 试包

Status: proposed

## Problem

主人想把 VibeValley 自己的活派给 VibeValley：工单派给帮工，帮工在 worktree 里改 heybro，主人看了合进 main。现在这样做有几处会出事：

- 拿来干活的农场和正在改的代码是同一份：源码里跑的服务端一重启、表结构一改，派出去的工单和田头就没了。
- 表结构只有一个基线，直接改（[不留兼容](../../implemented/architecture/2026-10-16-one-schema-no-old-data.md)）。`user_version` 数的是文件，基线改了它还是 1：新版本的服务端打开旧库不报错，跑到某条查询才炸。
- 合并在项目的检出里做：`project.go` 的 `mergeMain` 把检出当前的 HEAD 当主分支，直接在里面 `git merge`，不看工作区干不干净。heybro 的检出正是主人和别的 agent 干活的地方。
- 合并前不跑检查：普通工单收获时只看冲突，`go test`、`flutter:check`、`docs:verify` 没人跑。
- 新开的 worktree 什么都没装：没有 `flutter pub get`、`bun install`，帮工一跑检查就失败。
- 项目的路径是 `work_root/<项目名>`，三个渠道默认共用 `~/vibevalley-work`；heybro 在 `~/orca/projects`。

## Proposal

三个农场各干各的，用[已有的渠道](../../implemented/process/2026-10-12-release-channels.md)，不加新的：

| 农场 | 怎么来 | 用来 | 项目 |
|---|---|---|---|
| Beta | `bun run package:mac --channel beta` | 天天用，派 VibeValley 的活 | 主人的 heybro 检出（Beta 的 `vibevalley.yaml` 里 `work_root` 指向它的上一级） |
| 源码 | `go run ./cmd/server --config dev.yaml` 加 `flutter run` | 改 VibeValley 时试 | `dev.yaml` 里单独的 `home` 和 `work_root`，放一份 heybro 的克隆，碰不到 Beta 的项目 |
| Alpha | 源码看着可以了，`--channel alpha` 打一个包 | 装上当新的 Beta 用一阵 | 和源码一样单独一份 |

Alpha 用下来没问题，就用同一个提交打 Beta，换掉旧的。Beta 只在这个时候换，平时不动，所以帮工干到一半不会被重启打断。

光有渠道不够，下面几件要先做，做完再打第一个 Beta：

1. **库认得出自己的表结构**：服务端把 `0001_schema.sql` 的指纹记在库里（比如一张只有一行的 `core_schema` 表）。开机时指纹对不上，就把旧库挪成 `vibevalley.db.<旧指纹>`，按今天的表结构建一个新的，并在日志和田头说一声。旧数据不搬，挪开只是为了能回头看一眼。换 Beta 时工单板和田头会清空，代码和分支都在 git 里，丢不了。改表结构的提交攒着一起换，不要每次都换。
2. **合并不经过主人的检出**：主分支用项目定的名字，不用检出当前的 HEAD。合并在没有工作区的地方算：`git merge-tree --write-tree` 加 `commit-tree`，再把 `refs/heads/<主分支>` 从旧值改成新值。如果检出正停在主分支上，工作区干净就跟着快进；不干净就不合，告诉主人哪几个文件没提交。冲突照旧交回帮工，让它在自己的分支上解决。
3. **项目自己的准备和检查命令**：项目设置里加两条命令。准备命令在新 worktree 开好后跑，例如 `cd app && flutter pub get`。检查命令在合并前、帮工的分支变基到主分支以后跑。检查没过就不合，输出交回帮工，和冲突一样处理。heybro 的检查用 `AGENTS.md` 里那几条：`go vet`、`go test`、`go:deadcode`、`flutter:check`、`docs:verify`。

## Alternatives considered

**只用源码跑的服务端干活，不打包。** 最省事，但改一次服务端就得重启，派出去的活跟着断。改表结构还会清掉干活用的库。

**为 Beta 保留数据搬运。** 换包时工单不丢，但这违背了「不留兼容」。现在没有外面的用户，丢的只是本机的工单板。

**检出不干净时照样改 ref。** 主分支的 ref 往前走了，工作区却没跟着变，`git status` 会把刚合进来的改动显示成反向的未提交改动，比拒绝合并更糟。

## Acceptance criteria

- 指纹：改一下 `0001_schema.sql` 再用旧库开机，旧库被挪走，新库能读 `GET /api/v1/state`，日志里写了挪到哪。
- 合并：检出在别的分支上时，合并只动 `refs/heads/main`，工作区不变；检出停在 main 且有未提交改动时，合并被拒，并说出那几个文件。这两种都在 `project` 的测试里用真的 git 仓库测。
- 检查：故意让检查命令失败，工单不合，失败的输出出现在帮工的田头里。
- 整个流程：Beta 里派一个改文档的小工单，帮工改完、检查过了、合进 main，主人的检出里 `git log` 能看到它。

## Risks

- Beta 的家目录（`~/Library/Application Support/vibevalley Beta`）要单独填一次帮工档案、语音凭据和 `work_root`。
- 换 Beta 会清空工单板和田头。要是嫌这一步太疼，再考虑是不是给工单开一条导出的路，不在读库的地方兜底。
- 帮工通过 Beta 改的是 heybro 的 main。主人自己在检出里干活时，先提交或开分支，不然合并会被拒。
