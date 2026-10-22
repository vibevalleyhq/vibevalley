# 项目

项目（`project`）是工作目录 `projects/` 下的一个 git 仓库，农场里是一座岛，岛上的地是它在做的工单。`apps/server/src/project`（`Projects`）管工作目录、项目的新建和导入、每张工单的 worktree 和分支，以及读改动、冲突预检、检查、合并、推送和 `gh` 这些 git 操作；什么时候做这些，由工单和计划决定。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 工作目录：`projects/` 下的项目，`worktrees/` 下的 worktree，工作目录的 `AGENTS.md` | 工作目录放在哪（配置 `work_root`，[architecture.md](docs/architecture.md)「配置」） |
| 新建项目、从 GitHub 克隆，项目名的校验 | 派活时挑哪个项目（[管家](docs/subsystems/orchestrator.md)；档案的默认项目在帮工档案上） |
| 一张工单一个 worktree 和分支：开、复用、留着、清掉 | 帮工什么时候开、换、离开（[帮工](docs/subsystems/session.md)）；一个项目同时几个帮工在干（`session/rules.ts` 的 `noRoom`，上限从这里取） |
| 改动：提交、文件和 diff、没提交的、落后几个、会不会冲突 | 完成的流程：什么时候查冲突、交回帮工、本地合还是提 PR、PR 的轮询（[工单](docs/subsystems/issue.md#怎么走)） |
| 检查（`.vibevalley/check`）、合并、推送、开 PR、查 PR 的状态、快进主分支 | 计划的分支和每一件的检查什么时候跑（[计划](docs/subsystems/task.md)） |
| GitHub 检测：`gh` 装没装、登没登录，每个项目能不能提 PR | `github.pr_projects` 里放哪些项目（主人的配置） |
| 地契：项目列表、最近一次提交、种了什么（tokei）、一年的提交 | 项目页和地图怎么画（[farm-ui.md](docs/reference/farm-ui.md) 界面 12、19） |
| 数工作目录里你名下的 commit | 经验和等级怎么算（`game/game.ts`、`game/view.ts` 的 `xpToNext`、`levelUps`；[farm-ui.md](docs/reference/farm-ui.md)「计分」） |

## 在哪

- 服务端 `apps/server/src/project`：`project.ts` 工作目录、新建和克隆、`Workplace`、改动（`Changes`）、合并前的提交、冲突预检和 `.vibevalley/check`、合并和清理、`houseRules`、推送和 PR、快进主分支、GitHub 检测、地契、数 commit，对外的形状（`Workplace`、`Merged`、`MergeFailure`）；`git.ts` 跑 git 和别的命令；`stack.ts` 认项目的栈。
- 配置（`Config`，[architecture.md](docs/architecture.md)「配置」）：`work_root`、`project.max_sessions`、`project.check_timeout_seconds`、`github.pr_projects`、`tokei`、`git_emails`。
- 没有表：项目就是磁盘上的文件夹，PR 的回执记在工单上（`Issue.pullRequest`）。
- 接口：`project.list`、`project.check`、`project.create`、`project.languages`、`project.activity`、`github.status`、`github.refresh`；工单的改动是 `issue.changes`（[capabilities.md](docs/reference/capabilities.md)）。
- 页面：项目页 `apps/web/src/pages/projects/ProjectsPage.tsx`（新建、地契、语言、开垦日历），地图 `ProjectMap.tsx`；规则在 `apps/web/src/rules/projects.ts`。

## 模型和不变量

- **工作目录**（`Config.workRoot`，环境变量 `VIBEVALLEY_WORK_ROOT`）：`projects/<名字>` 是项目，`worktrees/` 是 worktree，根上的 `AGENTS.md` 是这台机器上所有项目的约定（`houseRules`），派活时附在帮工的规矩后面。默认是 `~/vibevalley-dev`，桌面版和终端里跑的服务端一样。
- **一个项目是 `projects/` 的一个直接子文件夹**：名字以字母或数字开头，只含字母、数字、`-`、`_`、`.`，最多 64 个字符（`projectProblem`）；以 `.` 开头的、正在新建的不列出；解析符号链接以后不在 `projects/` 里的拒绝（项目不能链接到外面）。
- **派到不存在的项目就新建**（`ensure`）：`git init -b main`，没有 `.gitignore` 就写一份（依赖、构建目录、`.env`、缓存），空文件夹加一个 `README.md`，做初始提交；已经是仓库但没有提交的，补一个空的初始提交。机器没有 git 用户时用 `vibevalley <vibevalley@localhost>` 提交。
- **一张工单一个 worktree、一条分支**（`issueBranch`）：`worktrees/<项目>.<工单号>`，分支 `vibevalley/issue-<工单号>`。worktree 在就复用；只剩分支就在原分支上重建 worktree；都没有就从基分支新开：计划给的基分支，或项目在 `github.pr_projects` 里且能提 PR 时先快进的主分支，否则 `HEAD`。即时派活也先取得工单号，不按帮工编号或时间创建另一种工作区。档案关掉 worktree（`Agent.worktree`）时帮工直接在项目文件夹里干活，没有分支，也就没有可合的。
- **同一个项目里改仓库的操作串行**（`serially`，每个项目一把锁）：新建、开 worktree、合并、清理、开分支、结束 PR。检查在锁外跑，进锁以后再核对。
- **释放回执区分现场是否仍在**（`WorkplaceRelease`）：`release`、`clear` 返回 `kept`，保留时带原因。未合的改动、分支或删除失败都不能被调用方当作已释放；工单只在现场释放后才能删掉身份。`clear` 默认丢弃工作区里的未提交文件，`preserve` 用在工单换项目前，未提交的也保留；两种都不丢弃未合的提交。
- **留着和清掉**（`release`，帮工离开或派不出去时）：worktree 里有没提交的改动就整个留着；否则清掉 worktree；分支上有主分支没有的提交就留着，没有就删掉。合并成功以后强制删掉 worktree 和分支；删不掉只是一条警告，跟着成功的回执走，不把完成变成失败。起草完的 worktree 由执行停止写入后 `reset`：在锁里把工单分支 `checkout -f -B` 回主分支、`git clean -fd`，改的和提交的都不留，项目文件夹本身不重置；没开工就取消或删掉的工单 `clear`：强制删掉它的 worktree，分支上没有主分支没有的提交就删掉分支。
- **一个项目的上限**：`project.max_sessions`（默认 3）是同时在干活的帮工数，歇着的不算；`maxSessions` 把它夹在 1 到 6（`maxRunning`）之间，0 或比 6 大时是 6，跟着项目列表给页面（`ProjectSummary.maxSessions`）。它是配置，不进核心状态。
- **改动**（`Changes`，只读）：主分支是项目克隆的当前分支；列出 `<主分支>..<分支>` 的提交、`<主分支>...<分支>` 改的文件（不认改名）和行数、worktree 里没提交的（`git status --porcelain`，`??` 记成新增）、主分支多了几个提交（`behind`）、会冲突的文件（`git merge-tree --write-tree --name-only`，不碰工作区）。每个文件的 diff 最多 400 行，全部 diff 最多 40 万个 UTF-16 单位，超了的文件不带 diff。
- **合并失败分三种**（`mergeFailure.Kind`）：`conflict`（带主分支和冲突的文件）、`check`（检查没过、超时，或分支、主分支在检查后变了）、`error`（git 出错）。会冲突的合并不去试，交回帮工在自己的分支上解决。
- **合并前把剩下的改动提交**（`commitLeft`）：提交信息「合并前把没提交的改动一并提交」，`__pycache__`、`*.pyc`、`.pytest_cache`、`node_modules`、`.DS_Store` 不管项目怎么忽略都不提交。
- **检查是帮工分支上的 `.vibevalley/check`**：在 worktree 根目录直接执行（要有执行权限，没有这个文件就跳过），限时 `project.check_timeout_seconds`（默认 1200 秒），超时连同它起的子进程整组杀掉；输出只留最后 64 KB，拒绝里附最后 40 行。计划每一件的检查命令走 `Run`（`sh -c`，限时 10 分钟，输出留最后 3000 个单位）。
- **GitHub 的命令限时**：`gh` 15 秒，`gh repo clone`、`git push`、`git fetch` 3 分钟；`gh` 带 `GH_HOST=github.com`、`GH_PROMPT_DISABLED=1` 跑，原始输出不出检测函数。
- **能不能提 PR 只读缓存**：`usesPullRequests` 要项目在 `github.pr_projects` 里，且上次检测说可以（`PullRequestCapability.available`）；没检测过、命令失败或超时都算不能。

## 怎么走

**新建和导入**（`project.create`；表单边填边问 `project.check`，页面不另写校验）：

1. 校验名字和地址：GitHub 地址只收仓库主页 `https://github.com/<owner>/<repo>`，不收凭据、别的传输方式和命令行选项。
2. 在项目锁里排他地 `mkdir`：同名的文件夹、空文件夹或符号链接都拒绝（「已经存在，请换个项目名」）。新建中的名字记在 `pending`，不进项目列表。
3. 没给地址就 `ensure`（见上）。给了地址：已登录 `gh` 的用 `gh repo clone <owner/repo> <路径>`，能克隆当前账号看得见的私有仓库；没登录的用禁用凭据的 `git clone`（`credential.helper=`、`core.askPass=`、`GIT_TERMINAL_PROMPT=0`、`GIT_LFS_SKIP_SMUDGE=1`）。检测还没跑完时先同步测一次登录。完整克隆，保留历史和 origin。
4. 超过 3 分钟或失败：删掉这次建的文件夹，返回能重试的原因。导入只克隆，不派帮工、不装依赖、不跑项目。

**工单的一块地**：帮工开工时 `session` 调 `workplace(项目, 工单号, worktree, 基分支)` 拿到工作目录和分支，帮工的规矩里写明只在这里改、不切分支、不 push；帮工离开时 `release`。取消再重开、换帮工、重启都落在同一个 worktree 和分支上。

**本地合**（`merge`，工单完成、项目不提 PR 时）：

1. 锁外：`commitLeft`；进锁查冲突，没冲突就在 worktree 里把主分支合进帮工分支；出锁跑 `.vibevalley/check`，记下检查过的分支提交。
2. 进锁：分支没变过；主分支是检查过的那个提交的祖先（否则「主分支在检查期间又变了」）；再查一次冲突。
3. 在项目克隆里 `git merge --no-edit <分支>`；失败就 `merge --abort`，abort 也失败时说清主分支停在合并到一半、要手动收拾。
4. 删 worktree 和分支，回执写「N 个提交合进了 <项目> 的 <主分支>」。

**合进计划分支**（`mergeInto`，计划的一件做完）：同样锁外检查、进锁核对和查冲突，但不检出任何分支：`merge-tree --write-tree` 写出树，`commit-tree` 做合并提交（能快进就快进），`update-ref` 只从原来的位置挪，目标分支同时被挪过就不覆盖。`mergeBranch` 把计划分支合进主分支并删掉它；`openBranch` 从 `HEAD` 开计划分支。

**提 PR**（`submitPullRequest`）：分支必须是这张工单的分支；锁外提交、查冲突、检查；进锁核对分支没变、origin 是 GitHub、主分支没有冲突；`git push -u origin <分支>`；工单已有开着的 PR 就只推；否则先 `gh pr list --head <分支> --base <主分支> --state open` 找回开过但回执没存下的，再 `gh pr create`，正文是「工单 #号」、帮工的结论和检查结果（没有 `.vibevalley/check` 就写没跑检查）。每一步失败都返回能重试的原因。`PullRequestState` 用 `gh pr view --json state,mergedAt` 读成 `open`、`merged`、`closed`。

**结束 PR**（`finishPullRequest`）：进锁，能提 PR 的先快进主分支，再强制删掉工单的 worktree 和本地分支；远端分支不动。

**快进主分支**（`syncMain`，开新分支前和结束 PR 时，在锁里）：主分支取 `origin/HEAD`，没有就取当前分支；`git fetch origin <主分支>`；项目克隆不干净、本地主分支不是 `FETCH_HEAD` 的祖先或 fetch 失败，都保留本地的、记一行日志。

**GitHub 检测**（`refreshGitHub`；开机在后台跑一次，`github.refresh` 手动重跑并顺带刷新开着的 PR）：

1. `gh --version`：找不到是「没装 gh」，别的错是「gh 检测失败」。
2. `gh auth status --hostname github.com --active`：失败是「没登录 GitHub」，读不出账号是「无法确认 GitHub 登录账号」。
3. 登录了就对每个项目读 `origin`（GitHub 的 HTTPS、`ssh://`、`git@github.com:` 地址），不是 GitHub 仓库就说不是；是就 `gh repo view <owner/repo> --json viewerPermission`，`ADMIN`、`MAINTAIN`、`WRITE` 算能提 PR，别的是「没有写权限」。
4. 结果整份替换缓存；几次刷新排队，不让旧结果盖掉新的。

`github.status` 读这份缓存：安装、版本、登录、账号、检测时间和中文原因，不含命令原文和 token；还没测过时是「尚未检测 GitHub」。`project.list` 不调 `gh`，每个项目的 `pullRequest` 读缓存，新建项目或改了远端以后要 `github refresh`（没测过这个项目时是「尚未检测项目，请刷新 GitHub 状态」）。

**地契**（每次打开现算，不缓存）：

- `project.list`（`summaries`）：每个项目的名字、路径、是不是 git 仓库、`maxSessions`、`pullRequest` 和最近一次提交（`git log --all -1`）；地图半分钟问一次。
- `project.languages`：`tokei --output json`，排除锁文件、压缩文件、source map、依赖和构建目录（`leftOut`），限时 1 分钟；只有空行的语言和 `total` 不算，按代码加注释的行数排。`tokei` 配置能指定路径；没装就拒绝，说用 `brew install tokei` 或 `cargo install tokei`。
- `project.activity`：最近 53 周、所有分支、不算合并的提交，按服务端那台机器的本地日期和作者名数；还有总提交数、第一个提交（所有根提交里最早的）和最近一个。

**数 commit**（`contributions`）：在 `projects/` 下往下找最多 3 层的 git 仓库（跳过依赖和构建目录），同一个 `--git-common-dir` 只数一次，数所有分支上作者邮箱是你的提交：git 全局和这个仓库的 `user.email`，加上 `git_emails`，不分大小写。

## 和谁打交道

- **帮工（`session`）**：开工取 worktree、离开调 `release`，规矩里附 `houseRules`；`noRoom` 用 `limit` 判一个项目还能不能再开工；合并经 `session` 的 `handOver`（先让帮工歇下，再由工单、计划给的合并方式调 `merge`、`mergeInto`、`submitPullRequest`、`finishPullRequest`），`conflict` 的失败由它施加 `conflict` 事实。
- **工单（`issue`）**：决定什么时候合、走本地合还是 PR（`usesPullRequests`）；`issue.changes` 调 `Changes`，用它刷新帮工的冲突；冲突预检 `Conflict`；重开时用 `branchChanges` 看分支上有没有上次的提交；PR 的轮询调 `PullRequestState`（[工单](docs/subsystems/issue.md)）。
- **计划（`task`）**：`openBranch` 开计划分支、`changedFiles` 看一件改了哪些文件、`Run` 跑一件的检查、`mergeBranch` 把计划合进主分支、`branchChanges` 给计划的改动。
- **游戏（`game`）**：`game/game.ts` 开机、每 2 分钟、帮工干完一轮 15 秒后各调一次 `contributions`，变了施加 `commits` 事实，经验由它折。
- **管家（`orchestrator`、`tool`）**：农场现状和 `look` 工具列出 `list` 和 `root`。
- **HTTP（`handler`）**：只转发；`github.refresh` 先刷新检测，再调工单的 `refreshPullRequests`。

## 为什么这样

- **帮工在 worktree 里干，不在主人的仓库里。** 几个帮工同时改一个仓库会互相覆盖，做坏了也难撤；worktree 加分支让每一份改动可看、可撤、可以一份一份收。代价是磁盘上多了 worktree 和分支，项目必须是 git 仓库。直接在项目里改留作档案的选项（关掉 worktree），默认开着。
- **worktree 按工单开，约束放在 `Workplace` 里。** 按帮工开时，取消后重开的帮工不在原来的分支上，还会一张工单两个 worktree；按工单号算出路径，有就复用，调用方不用记。
- **冲突用 `git merge-tree` 预检，不先合再中止。** 合了再中止要碰项目克隆的工作区，中止失败还得收拾；`merge-tree` 不碰任何工作区。冲突交回帮工，不交给主人在终端里解决：帮工最清楚自己改了什么，能解决、跑测试、在结论里说怎么取舍。
- **合进计划分支用 `commit-tree` 和 `update-ref`，不检出。** 计划分支没有自己的工作区，检出就要占用项目克隆；`update-ref` 带旧值，被别人挪过就不覆盖。
- **一个项目一把锁，检查在锁外。** 两个帮工同时派到一个新项目会一起 `git init`，两次合并会一起往一条分支上合；但检查要跑几分钟，放在锁里同一个项目就开不了新 worktree。锁外检查，进锁核对分支和主分支没变。
- **合并后清理失败只是警告。** 合进去、推上去的东西撤不回来，清理失败改成失败只会让工单停在错的状态。
- **能不能提 PR 只在检测时算，读的地方只读缓存。** `gh` 慢且可能卡住，列表和完成不应每次等它；检测串行、整份替换，失败一律算不能提。
- **导入只收 GitHub 仓库主页地址，登录了 `gh` 才克隆私有仓库。** 任意 git 地址要处理认证、SSH、凭据存储和各种传输；没登录时禁用凭据，克隆不会弹出终端的认证提示卡住。完整克隆，不浅克隆：地契的日历和统计要历史。导入不派帮工：导入和用模型是两件事。
- **数代码用 tokei，没装就说怎么装。** 自己按扩展名数要维护语言表、注释语法和生成文件的判断，结果也没 tokei 准；当后备并存就是两套结果。scc 差不多但主人要的是 tokei；GitHub linguist 要 Ruby，本地太重。占比按代码加注释算：按字节会让长行的 JSON、压缩文件占太多，只按代码行 tokei 会把 Markdown 正文算成注释、文档就没了。
- **提交算所有分支、不算合并。** 只算主分支（GitHub 的算法）时，帮工还没合的活要等合进主分支才进日历；合并提交会让合并的那天重复算。
- **经验是工作目录里你名下的 commit。** 按完成的工单算奖励的是忙，失败重试也能刷；算这台机器上所有仓库会把和 VibeValley 无关的工作算进来；算所有作者会把别人的提交算成你的。帮工用这台机器的 git 用户提交，所以它们的提交算你的。
- **项目的上限是配置，跟着项目列表走，不进核心状态。** 它开机读一次、不随事实变；放进核心状态要改折法和黄金数据，只换来少问一次项目列表。地图的空位是上限减去在干活的（也不超过农场空着的地），和 `noRoom` 同一条规则 `roomLeft`：歇着的帮工占着 worktree 但不占上限。

## 还没做的

- 一块地上几个人、写的权利像接力棒一样交接：[一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)。
- 用 VibeValley 开发 VibeValley，Beta 的工作目录里放 VibeValley 自己：[用 VibeValley 开发 VibeValley](.agents/notes/proposed/process/2026-10-18-build-vibevalley-with-vibevalley.md)。

## 怎么验证

- `apps/server/src/project/project.test.ts`（真的 git 仓库，GitHub 地址改写到本地的临时仓库）：名字和地址；新项目有第一个提交、已有的文件夹被拒不碰、两个同时来；离线克隆、失败的清掉能再试；计划分支（一件合进它，它合进主分支）；分支开在别的分支所在处；从基点以来改了哪些文件（改名两个名字都算）；tokei 的输出；按天、按人数 commit；带最新提交的项目；项目的上限在农场的上限以内；一年的 commit（合并不算、只数工作目录里的）；没有 tokei 时说怎么装；帮工留下的改动提交时不带缓存；合并发布了、worktree 清不掉时回执还在；合并跑项目的检查（没有、过、不过带输出）；跑不起来的检查拒绝；工单的 worktree（重置到主分支、清空留空分支、有提交的分支留着）；工单回到同一个 worktree；本地合在带着主分支改动的树上检查；链接到工作目录外面的项目被拒。
- `project/github.test.ts`：`gh` 在不在、登没登录（不记它打的字）；地址；权限在刷新时取、摘要不问 `gh`；登出或卸了丢掉权限；私有仓库用登录的 `gh` 克隆；PR 要项目打开、有权限；先检查再推送、已经开着的 PR 找回来；PR 的正文写检查跑没跑；新工单能快进时从 origin 的 main 开始；commit 每个仓库连同它的 worktree 只数一次。
- `project/stack.test.ts`：每种标记文件、锁文件选包管理器。
- `src/flows/pull_request.test.ts`：提 PR 的项目完成时推送、开 PR、主分支不动，第二轮只推送；重启以后 PR 合了或关了，工单关上，帮工、worktree 和分支清掉。
- 页面：`apps/web/test/projects.spec.ts`（开一块新地、出现在地图上、打开地契；GitHub 地址先给名字）；`apps/web/src/rules/projects.test.ts`（空位、锁住的地、排队只算排上队的）。
