# Agent Note: 用 VibeValley 开发 VibeValley

Status: proposed

## Problem

主人想把 VibeValley 自己的活派给 VibeValley：工单派给帮工，帮工在 worktree 里改 heybro，验收过了合进 main。开始时这样做有几处会出事：

- 拿来干活的农场和正在改的代码是同一份：源码里跑的服务端一重启、表结构一改，派出去的工单和田头就没了。
- 表结构只有一个基线，直接改（[不留兼容](../../implemented/architecture/2026-10-16-one-schema-no-old-data.md)）。`user_version` 数的是文件，基线改了它还是 1：新版本的服务端打开旧库不报错，跑到某条查询才炸。
- 合并在项目的检出里做，把检出当前的 HEAD 当主分支，不看工作区干不干净；合并前也不跑检查。
- 三个渠道共用一个工作目录 `~/vibevalley-work`，两个农场的帮工会在同一份项目里干活。
- 客户端、打包、换包都夹在中间，哪一步不通都说不清是哪一层的错。

## Proposal

**先只用服务端和命令行走通，再用渠道把干活的农场和正在改的代码分开。**

### 第一步：只靠服务端和命令行

客户端只是一层皮（[先有概念，再有皮](../architecture/2026-10-15-concepts-first.md)），它点的每个按钮都是服务端的一个接口。所以先只开服务端、只用 `vibevalley` 命令行，让 codex 给 VibeValley 加完一个功能、合进 main，不开客户端、不打包、不经过管家。

```bash
vv project create --json '{"name":"vibevalley","github":"https://github.com/vibevalleyhq/vibevalley"}'
vv issue create --json '{"title":"…","description":"要做什么、怎么算做完、跑哪些检查","project":"vibevalley","assignee":"codex"}'
vv issue run <issue>                                            # 挪到待办，等它交回来，打出改动
vv issue status <issue> --json '{"status":"todo","text":"…"}'   # 不满意：再干一轮
vv issue accept <issue> --json '{"pass":true}'                  # 验收
vv issue status <issue> --json '{"status":"done"}'              # 收获
```

等一轮交回来不用新命令：轮询 `issue get`，先等 `in_progress` 再等 `in_review`（刚带话完会先读到上一轮的 `in_review`）。

### 第二步：三个农场各干各的

用[已有的渠道](../../implemented/process/2026-10-12-release-channels.md)，不加新的：

| 农场 | 怎么来 | 用来 | 工作目录 |
|---|---|---|---|
| Beta | `bun run package:mac --channel beta` | 天天用，派 VibeValley 的活 | `~/vibevalley-beta` |
| 源码 | `go run ./cmd/server` 加 `flutter run` | 改 VibeValley 时试 | `~/vibevalley-dev` |
| Alpha | 源码看着可以了，`--channel alpha` 打一个包 | 装上当新的 Beta 用一阵 | `~/vibevalley-alpha` |

每个工作目录里 `projects/` 是项目，`worktrees/<项目>.<工单号>` 是工单的 worktree。农场合进的是自己那份克隆的 main（走 PR 的项目在 GitHub 上合），主人在别处的检出经 origin 拉取，碰不到。Alpha 用下来没问题，就用同一个提交打 Beta，换掉旧的；Beta 只在这个时候换。

### 进展

- **命令行这条路走通了**（2026-10-18）：从空的 `~/vibevalley-dev`，codex 照工单改文档、改服务端，合进 main；之后一天里 codex 做了合并前的检查、工单拥有分支和 worktree、检测 `gh`、收获提 PR、地块详情合一，都是这样派、这样收的。
- **工作目录分开**：服务端默认 `~/vibevalley-dev`，打包的应用按渠道（`channel.dart` 的 `workFolder`）。
- **合并前的检查**：仓库里的 `.vibevalley/check`，合并前在帮工的 worktree 里、锁外跑，没过就不合，输出交回帮工（[server.md](../../../../docs/reference/server.md)「项目和收获」）。
- **合并不碰主人的检出**：合进农场自己的克隆；走 PR 的项目在 GitHub 上合，农场再从 origin 快进（[工单](../../../../docs/subsystems/issue.md)）。
- **验收**：每张工单都有，过了才算结果（[工单](../../../../docs/subsystems/issue.md)）。

跑的时候学到的：

- 农场的规矩写死「提交信息用一句中文」，压过了项目的约定，codex 把它当系统指令，主人在田头说也不改。规矩改成照项目的约定写，项目没说才用中文，主人另有说法的照主人。
- 规矩在帮工开工时进它的系统提示；接着干的帮工（包括农场重启以后）拿的还是开工时那一份，新规矩只对新开的帮工有用。
- 并行的两个帮工各自过了检查，合在一起的 main 没人查：本地收获的检查要包含主分支的合并结果，走 PR 的靠 CI。
- 新克隆的仓库要先 `flutter pub get` 才查得准格式（`app/tool/format-check.sh` 先装依赖）。

### 还没做的

1. **库认得出自己的表结构**：服务端把 `0001_schema.sql` 的指纹记在库里（比如一张只有一行的 `core_schema` 表）。开机时指纹对不上，就把旧库挪成 `vibevalley.db.<旧指纹>`，按今天的表结构建一个新的，并在日志和田头说一声。现在每次改基线都要手动把开发农场的库挪开。
2. **打第一个 Beta 天天用**：Beta 的家目录要填一次帮工档案和语音凭据，`~/vibevalley-beta/projects/vibevalley` 要先克隆好；vibevalley 本身加进 `github.pr_projects` 以后，收获就是开 PR。
3. **验证 skill**：把命令行这条路写成 `verify-feature-loop`，照 [create-verification-skill](../../../skills/create-verification-skill/SKILL.md) 写成能反复跑的样子。

## Alternatives considered

**先打 Beta 包，在客户端里走。** 一次就把整条路走全，但出了问题分不清是客户端、打包还是服务端的错。

**只用源码跑的服务端干活，不打包。** 最省事，但改一次服务端就得重启，派出去的活跟着断；改表结构还会清掉干活用的库。

**经过管家派活。** 更像以后天天用的样子，但多了 DeepSeek 和管家的判断两个变数；管家派活另外验证（`verify-manager-evals`）。

**检查写在项目设置里，不进仓库。** 不用约定文件名，但检查跟代码分开了，帮工也看不见合并时会跑什么。

**为 Beta 保留数据搬运。** 换包时工单不丢，但违背「不留兼容」；现在没有外面的用户，丢的只是本机的工单板。

## Acceptance criteria

- 指纹：改一下 `0001_schema.sql` 再用旧库开机，旧库被挪走，新库能读 `GET /api/v1/state`，日志里写了挪到哪。
- Beta：Beta 里派一个小工单，帮工改完、检查过了、验收过了、收获（开 PR 或合进克隆的 main），主人的检出能拉到它。
- `verify-feature-loop` 照着跑一遍，汇报附上工单号、合进去的提交和检查的输出。

## Risks

- 换 Beta 会清空工单板和田头。要是嫌这一步太疼，再考虑给工单开一条导出的路，不在读库的地方兜底。
- 主人自己在检出里直接提交到 main，会和 PR 合进来的冲突，要先推。
- 真跑要花 codex 的钱，验证挑小活。
