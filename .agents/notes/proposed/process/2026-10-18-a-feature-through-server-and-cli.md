# Agent Note: 先只用服务端和命令行，让 codex 给 VibeValley 加完一个功能

Status: proposed

## Problem

[用 VibeValley 开发 VibeValley](2026-10-18-build-vibevalley-with-vibevalley.md) 的流程从打 Beta 包讲起，中间夹着客户端、打包、换包，哪一步不通都说不清是哪一层的错。客户端只是一层皮（[先有概念，再有皮](../architecture/2026-10-15-concepts-first.md)）：它点的每个按钮都是服务端的一个接口，命令行调的也是同一套接口。只靠服务端和命令行走不通的，有了客户端也走不通。

命令行还有两个客户端没有的好处：主人和别的 agent（包括在 heybro 里干活的 Claude Code）都能照着敲，一个验证 skill 也能把整个流程写成脚本、反复跑。

## Proposal

第一个里程碑：**只开服务端、只用 `vibevalley` 命令行，让 codex 帮工给 VibeValley 加完一个功能，合进 main**。不开客户端，不打包，不经过管家（管家要 DeepSeek 的钥匙，是另一条路）。

### 谁在哪

- **农场**：在主人的检出（`~/orca/projects/heybro`）里跑 `go run ./cmd/server`，家目录 `~/.vibevalley`，工作目录 `~/vibevalley-dev`。帮工改的是工作目录里的克隆，碰不到正在跑的这份代码，所以农场不用打包。
- **项目**：`~/vibevalley-dev/projects/vibevalley`，是 `github.com/vibevalleyhq/vibevalley` 的一份克隆。
- **帮工**：种子里的 `codex` 档案。smith 以 `danger-full-access` 开 codex（`OAR_CODEX_SANDBOX` 能改），codex 能在 worktree 里提交。worktree 的 git 目录在项目的 `.git` 里，不在 worktree 下面，所以沙箱放不开时会先卡在提交这一步。codex 自己读仓库的 `AGENTS.md`。

### 一个功能怎么走（`vv` 指 `go run ./cmd/vibevalley`）

```bash
vv runtime list                                    # codex 是 available、enabled
vv project create --json '{"name":"vibevalley","github":"https://github.com/vibevalleyhq/vibevalley"}'
vv issue create --json '{"title":"…","description":"要做什么、怎么算做完、跑哪些检查","project":"vibevalley","assignee":"codex"}'
vv issue run <issue>                               # 开工，等它交回来，打出改动
vv session events <session>                        # 看它这一轮做了什么、跑了哪些检查
vv issue status <issue> --json '{"status":"todo","text":"…"}'  # 不满意就说，帮工接着干一轮
vv issue get <issue>                               # 轮询 status：先变成 in_progress，再回到 in_review 就是这一轮交回来了
vv issue status <issue> --json '{"status":"done"}'  # 收下，合进克隆的 main（合并前的检查还没有，见下）
git -C ~/vibevalley-dev/projects/vibevalley push   # 推到 origin（先手动）
git -C ~/orca/projects/heybro pull                 # 主人拉下来，重启农场，新功能就在了
```

开工、再干一轮、收下都是挪工单的状态（[改状态就是派活](../../implemented/architecture/2026-10-18-status-is-the-dispatch.md)）：`issue run` 把备选挪到待办并等它交回来，`issue status <id> --json '{"status":"todo","text":"…"}'` 再干一轮，`{"status":"done"}` 收下。

### 要补的

等一轮交回来不用新命令：工单的 `status` 由它最后一个帮工忙不忙算出来（`protocol.IssueStatusOf`），轮询 `issue get` 就行。评论以后帮工要过一会儿才忙起来，所以先等 `in_progress`，再等 `in_review`，不然刚评论完就会读到上一轮的 `in_review`。

还要补两件，按卡住的先后排：

1. **合并前的检查**：现在的合并只看有没有冲突。建议检查写在仓库里（比如 `.vibevalley/check`，一个可执行文件），跟着代码走，帮工看得见，也能改。合并前在帮工的 worktree 里、变基到主分支以后跑它；没过就不合，把输出当一条评论交回帮工，和冲突一样处理。heybro 的检查就是 `AGENTS.md` 里改完要跑的那几条。
2. **库认得出自己的表结构**：主人拉下新代码、重启农场时，基线改过的话旧库要被认出来、挪开（[上一篇](2026-10-18-build-vibevalley-with-vibevalley.md)的第 1 件）。不做的话，第一次拉到改了表结构的提交，农场就会在半路报错。

合并后推到 origin、合并前先试一个分支，都先手动做。

### 怎么开始

第一遍挑一个只改一处、一轮能做完的小活跑通。跑通以后，第 1、2 件也照这样派给 codex。

## Alternatives considered

**先打 Beta 包，在客户端里走。** 一次就把整条路走全，但出了问题分不清是客户端、打包还是服务端的错。客户端的路是命令行这条路加上画面，命令行先通，客户端只剩画面的问题。

**经过管家派活。** 更像以后天天用的样子，但多了 DeepSeek 和管家的判断这两个变数。第一个里程碑只要证明帮工能把活干完、合进去；管家派活另外验证（`verify-manager-evals`）。

**检查写在项目设置里，不进仓库。** 不用约定文件名，但检查跟代码分开了：代码改了检查没跟上，帮工也看不见合并时会跑什么。

**用 claude 不用 codex。** 两个都能用。主人选 codex，用它跑第一遍；档案换一个 `assignee`，流程不变。

## Acceptance criteria

- 照上面的命令，从空的 `~/vibevalley-dev` 开始，codex 加完一个小功能，挪到 done 合进克隆的 main，推到 origin 后主人能拉到。整个过程不开客户端。
- 评论一次，轮询 `issue get` 能看到 `in_progress` 再回到 `in_review`，`issue changes` 里有新的提交。
- 第 1 件做完以后：故意让检查失败，挪到 done 不合，帮工收到检查的输出作为评论。
- 走通以后写一个验证 skill（`verify-feature-loop`），照 [create-verification-skill](../../../skills/create-verification-skill/SKILL.md) 把这串命令写成能反复跑的样子，汇报时附上工单号、合进去的提交和检查的输出。

## Risks

- codex 一轮可能跑很久（`go test ./...`、`flutter test`），四分钟没动静农场会提醒，但不会掐断，提醒可以先不管。
- 真跑要花 codex 的钱，第一遍挑小活。
- 克隆走 https 且不带凭据，推之前可能要把 `origin` 改成 ssh 地址。
- 帮工通过 `/mcp` 在田头说话，这条路在 codex 上还没真跑过。第一遍要看 `session events` 里它有没有调到农场的工具。

## 进展

2026-10-18 第一遍走通：从空的 `~/vibevalley-dev`，`project create` 从 GitHub 克隆，codex 照工单给 `docs/development.md` 补了一节「只用命令行派一个活」（`ef0e92d`），自己跑了两遍 `docs:verify`，挪到 done 合进克隆的 main，主人的检出从克隆快进拿到它。中途重启过一次农场，帮工接着在。跑出来两件事：

- 农场的规矩写死「提交信息用一句中文」，压过了项目的约定，codex 把它当系统指令，主人在田头说也不改。规矩改成照项目的约定写，项目没说才用中文，主人另有说法的照主人（`a1a775f`）。
- 规矩在帮工开工时进它的系统提示；接着干的帮工（包括农场重启以后）拿的还是开工时那一份，新规矩只对新开的帮工有用。
