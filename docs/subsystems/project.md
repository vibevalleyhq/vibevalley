# 项目

项目（`project`）是工作目录 `projects/` 下的一个 git 仓库，农场里是一座岛，岛上的地是它在做的工单。`internal/project`（`project.Service`）管工作目录、项目的新建和导入、每张工单的 worktree 和分支，以及读改动、冲突预检、检查、合并、推送和 `gh` 这些 git 操作；什么时候做这些，由工单和种植计划决定。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 工作目录：`projects/` 下的项目，`worktrees/` 下的 worktree，工作目录的 `AGENTS.md` | 工作目录放在哪（配置 `work_root`，[architecture.md](../architecture.md)「配置」；打包的应用按渠道，[desktop.md](../reference/desktop.md)「渠道」） |
| 新建项目、从 GitHub 克隆，项目名的校验 | 派活时挑哪个项目（[管家](manager.md)；档案的默认项目在帮工档案上） |
| 一张工单一个 worktree 和分支：开、复用、留着、清掉 | 帮工什么时候开、换、离开（[帮工](session.md)）；一个项目同时几个帮工在干（`session/rules.go` 的 `noRoom`，上限从这里取） |
| 收成清单：提交、文件和 diff、没提交的、落后几个、会不会冲突 | 收获的流程：什么时候查冲突、交回帮工、本地合还是提 PR、PR 的轮询（[工单](issue.md#怎么走)） |
| 检查（`.vibevalley/check`）、合并、推送、开 PR、查 PR 的状态、快进主分支 | 种植计划的分支和每一件的检查什么时候跑（[种植计划](task.md)） |
| GitHub 检测：`gh` 装没装、登没登录，每个项目能不能提 PR | `github.pr_projects` 里放哪些项目（主人的配置） |
| 地契：项目列表、最近一次提交、种了什么（tokei）、一年的提交 | 项目页和地图怎么画（[farm-ui.md](../reference/farm-ui.md) 界面 12、19） |
| 数工作目录里你名下的 commit | 经验和等级怎么算（`game/commits.go`、protocol 的 `XPToNext`、`LevelUps`；[farm-ui.md](../reference/farm-ui.md)「计分」） |

## 在哪

- 服务端 `server/internal/project`：`project.go` 工作目录、新建和克隆、`Workplace`、收成清单、合并和清理、`HouseRules`；`check.go` 合并前的提交、冲突预检和 `.vibevalley/check`；`pull_request.go` 推送、开 PR、查 PR、结束 PR、快进主分支；`github.go` GitHub 检测；`codebase.go` 地契；`contributions.go` 数 commit；`types.go` 对外的形状（`Workplace`、`Merged`、`MergeFailure`）。
- 配置（`base.Config`，[architecture.md](../architecture.md)「配置」）：`work_root`、`project.max_sessions`、`project.check_timeout_seconds`、`github.pr_projects`、`tokei`、`git_emails`。
- 没有表：项目就是磁盘上的文件夹，PR 的回执记在工单上（`Issue.pullRequest`）。
- 接口：`project.list`、`project.check`、`project.create`、`project.languages`、`project.activity`、`github.status`、`github.refresh`；收成清单是工单的 `issue.changes`（[capabilities.md](../reference/capabilities.md)）。
- 客户端：项目页 `workbench/projects/`（`projects_page.dart`，规则在 `codebase.dart`，新建在 `new_project_dialog.dart`），地图 `workbench/map/`（规则在 `map_rules.dart`）。

## 模型和不变量

- **工作目录**（`Config.WorkRoot`，环境变量 `VIBEVALLEY_WORK_ROOT`）：`projects/<名字>` 是项目，`worktrees/` 是 worktree，根上的 `AGENTS.md` 是这台机器上所有项目的约定（`HouseRules`），派活时附在帮工的规矩后面。终端里跑的服务端默认 `~/vibevalley-dev`；macOS 应用按渠道各用一个：`~/vibevalley`、`~/vibevalley-beta`、`~/vibevalley-alpha`（`app/lib/host/channel.dart` 的 `workFolder`），起服务端时设进 `VIBEVALLEY_WORK_ROOT`。几个渠道的项目和 worktree 互不相碰。
- **一个项目是 `projects/` 的一个直接子文件夹**：名字以字母或数字开头，只含字母、数字、`-`、`_`、`.`，最多 64 个字符（`projectProblem`）；以 `.` 开头的、正在新建的不列出；解析符号链接以后不在 `projects/` 里的拒绝（项目不能链接到外面）。
- **派到不存在的项目就新建**（`ensure`）：`git init -b main`，没有 `.gitignore` 就写一份（依赖、构建目录、`.env`、缓存），空文件夹加一个 `README.md`，做初始提交；已经是仓库但没有提交的，补一个空的初始提交。机器没有 git 用户时用 `vibevalley <vibevalley@localhost>` 提交。
- **一张工单一个 worktree、一条分支**（`IssueBranch`）：`worktrees/<项目>.<工单号>`，分支 `vibevalley/issue-<工单号>`。worktree 在就复用；只剩分支就在原分支上重建 worktree；都没有就从基分支新开：种植计划给的基分支，或项目在 `github.pr_projects` 里且能提 PR 时先快进的主分支，否则 `HEAD`。不挂工单的直接派活用 `worktrees/<项目>.<帮工>-<时间>` 和 `vibevalley/<帮工>-<时间>`。档案关掉 worktree（`Agent.Worktree`）时帮工直接在项目文件夹里干活，没有分支，也就没有可合的。
- **同一个项目里改仓库的操作串行**（`serially`，每个项目一把锁）：新建、开 worktree、合并、清理、开分支、结束 PR。检查在锁外跑，进锁以后再核对。
- **留着和清掉**（`Release`，帮工离开或派不出去时）：worktree 里有没提交的改动就整个留着；否则清掉 worktree；分支上有主分支没有的提交就留着，没有就删掉。合并成功以后强制删掉 worktree 和分支；删不掉只是一条警告，跟着成功的回执走，不把收获变成失败。
- **一个项目的上限**：`project.max_sessions`（默认 3）是同时在干活的帮工数，歇着的不算；`Slots` 把它夹在 1 到 6（`protocol.MaxRunning`）之间，0 或比 6 大时是 6，跟着项目列表给客户端（`ProjectSummary.slots`）。它是配置，不进核心状态。
- **收成清单**（`Changes`，只读）：主分支是项目克隆的当前分支；列出 `<主分支>..<分支>` 的提交、`<主分支>...<分支>` 改的文件（不认改名）和行数、worktree 里没提交的（`git status --porcelain`，`??` 记成新增）、主分支多了几个提交（`behind`）、会冲突的文件（`git merge-tree --write-tree --name-only`，不碰工作区）。每个文件的 diff 最多 400 行，全部 diff 最多 40 万个 UTF-16 单位，超了的文件不带 diff。
- **合并失败分三种**（`MergeFailure.Kind`）：`conflict`（带主分支和冲突的文件）、`check`（检查没过、超时，或分支、主分支在检查后变了）、`error`（git 出错）。会冲突的合并不去试，交回帮工在自己的分支上解决。
- **合并前把剩下的改动提交**（`commitLeft`）：提交信息「合并前把没提交的改动一并提交」，`__pycache__`、`*.pyc`、`.pytest_cache`、`node_modules`、`.DS_Store` 不管项目怎么忽略都不提交。
- **检查是帮工分支上的 `.vibevalley/check`**：在 worktree 根目录直接执行（要有执行权限，没有这个文件就跳过），限时 `project.check_timeout_seconds`（默认 1200 秒），超时连同它起的子进程整组杀掉；输出只留最后 64 KB，拒绝里附最后 40 行。种植计划每一件的检查命令走 `Run`（`sh -c`，限时 10 分钟，输出留最后 3000 个单位）。
- **GitHub 的命令限时**：`gh` 15 秒，`gh repo clone`、`git push`、`git fetch` 3 分钟；`gh` 带 `GH_HOST=github.com`、`GH_PROMPT_DISABLED=1` 跑，原始输出不出检测函数。
- **能不能提 PR 只读缓存**：`UsesPullRequests` 要项目在 `github.pr_projects` 里，且上次检测说可以（`PullRequestCapability.Available`）；没检测过、命令失败或超时都算不能。

## 怎么走

**新建和导入**（`project.create`；表单边填边问 `project.check`，客户端不另写校验）：

1. 校验名字和地址：GitHub 地址只收仓库主页 `https://github.com/<owner>/<repo>`，不收凭据、别的传输方式和命令行选项。
2. 在项目锁里排他地 `mkdir`：同名的文件夹、空文件夹或符号链接都拒绝（「已经存在，请换个项目名」）。新建中的名字记在 `pending`，不进项目列表。
3. 没给地址就 `ensure`（见上）。给了地址：已登录 `gh` 的用 `gh repo clone <owner/repo> <路径>`，能克隆当前账号看得见的私有仓库；没登录的用禁用凭据的 `git clone`（`credential.helper=`、`core.askPass=`、`GIT_TERMINAL_PROMPT=0`、`GIT_LFS_SKIP_SMUDGE=1`）。检测还没跑完时先同步测一次登录。完整克隆，保留历史和 origin。
4. 超过 3 分钟或失败：删掉这次建的文件夹，返回能重试的原因。导入只克隆，不派帮工、不装依赖、不跑项目。

**工单的一块地**：帮工开工时 `session` 调 `Workplace(项目, 帮工, worktree, 基分支, 工单号)` 拿到工作目录和分支，帮工的规矩里写明只在这里改、不切分支、不 push；帮工离开时 `Release`。取消再重开、换帮工、重启都落在同一个 worktree 和分支上。

**本地合**（`Merge`，工单收获、项目不提 PR 时）：

1. 锁外：`commitLeft`；进锁查冲突，没冲突就在 worktree 里把主分支合进帮工分支；出锁跑 `.vibevalley/check`，记下检查过的分支提交。
2. 进锁：分支没变过；主分支是检查过的那个提交的祖先（否则「主分支在检查期间又变了」）；再查一次冲突。
3. 在项目克隆里 `git merge --no-edit <分支>`；失败就 `merge --abort`，abort 也失败时说清主分支停在合并到一半、要手动收拾。
4. 删 worktree 和分支，回执写「N 个提交合进了 <项目> 的 <主分支>」。

**合进计划分支**（`MergeInto`，种植计划的一件做完）：同样锁外检查、进锁核对和查冲突，但不检出任何分支：`merge-tree --write-tree` 写出树，`commit-tree` 做合并提交（能快进就快进），`update-ref` 只从原来的位置挪，目标分支同时被挪过就不覆盖。`MergeBranch` 把计划分支合进主分支并删掉它；`OpenBranch` 从 `HEAD` 开计划分支。

**提 PR**（`SubmitPullRequest`）：分支必须是这张工单的分支；锁外提交、查冲突、检查；进锁核对分支没变、origin 是 GitHub、主分支没有冲突；`git push -u origin <分支>`；工单已有开着的 PR 就只推；否则先 `gh pr list --head <分支> --base <主分支> --state open` 找回开过但回执没存下的，再 `gh pr create`，正文是「工单 #号」、帮工的结论和检查结果（没有 `.vibevalley/check` 就写没跑检查）。每一步失败都返回能重试的原因。`PullRequestState` 用 `gh pr view --json state,mergedAt` 读成 `open`、`merged`、`closed`。

**结束 PR**（`FinishPullRequest`）：进锁，能提 PR 的先快进主分支，再强制删掉工单的 worktree 和本地分支；远端分支不动。

**快进主分支**（`syncMain`，开新分支前和结束 PR 时，在锁里）：主分支取 `origin/HEAD`，没有就取当前分支；`git fetch origin <主分支>`；项目克隆不干净、本地主分支不是 `FETCH_HEAD` 的祖先或 fetch 失败，都保留本地的、记一行日志。

**GitHub 检测**（`RefreshGitHub`；开机在后台跑一次，`github.refresh` 手动重跑并顺带刷新开着的 PR）：

1. `gh --version`：找不到是「没装 gh」，别的错是「gh 检测失败」。
2. `gh auth status --hostname github.com --active`：失败是「没登录 GitHub」，读不出账号是「无法确认 GitHub 登录账号」。
3. 登录了就对每个项目读 `origin`（GitHub 的 HTTPS、`ssh://`、`git@github.com:` 地址），不是 GitHub 仓库就说不是；是就 `gh repo view <owner/repo> --json viewerPermission`，`ADMIN`、`MAINTAIN`、`WRITE` 算能提 PR，别的是「没有写权限」。
4. 结果整份替换缓存；几次刷新排队，不让旧结果盖掉新的。

`github.status`、`setting.check` 的 `github` 读同一份缓存：安装、版本、登录、账号、检测时间和中文原因，不含命令原文和 token；还没测过时是「尚未检测 GitHub」。`project.list` 不调 `gh`，每个项目的 `pullRequest` 读缓存，新建项目或改了远端以后要 `github refresh`（没测过这个项目时是「尚未检测项目，请刷新 GitHub 状态」）。

**地契**（每次打开现算，不缓存）：

- `project.list`（`Summaries`）：每个项目的名字、路径、是不是 git 仓库、`slots`、`pullRequest` 和最近一次提交（`git log --all -1`）；地图半分钟问一次。
- `project.languages`：`tokei --output json`，排除锁文件、压缩文件、source map、依赖和构建目录（`leftOut`），限时 1 分钟；只有空行的语言和 `Total` 不算，按代码加注释的行数排。`tokei` 配置能指定路径；没装就拒绝，说用 `brew install tokei` 或 `cargo install tokei`。
- `project.activity`：最近 53 周、所有分支、不算合并的提交，按服务端那台机器的本地日期和作者名数；还有总提交数、第一个提交（所有根提交里最早的）和最近一个。

**数 commit**（`Contributions`）：在 `projects/` 下往下找最多 3 层的 git 仓库（跳过依赖和构建目录），同一个 `--git-common-dir` 只数一次，数所有分支上作者邮箱是你的提交：git 全局和这个仓库的 `user.email`，加上 `git_emails`，不分大小写。

## 和谁打交道

- **帮工（`session`）**：开工调 `Workplace`、离开调 `Release`，规矩里附 `HouseRules`；`noRoom` 用 `Limit` 判一个项目还能不能再开工；收获经 `session` 的 `harvest`（先让帮工歇下，再调 `Merge`、`MergeInto`、`SubmitPullRequest`、`FinishPullRequest`），`conflict` 的失败由它施加 `FactConflict`。
- **工单（`issue`）**：决定什么时候收获、走本地合还是 PR（`UsesPullRequests`）；`issue.changes` 调 `Changes`，用它刷新帮工的冲突；冲突预检 `Conflict`；重开时用 `BranchChanges` 看分支上有没有上次的提交；PR 的轮询调 `PullRequestState`（[工单](issue.md)）。
- **种植计划（`task`）**：`OpenBranch` 开计划分支、`ChangedFiles` 看一件改了哪些文件、`Run` 跑一件的检查、`MergeBranch` 把计划合进主分支、`BranchChanges` 给计划的收成清单。
- **游戏（`game`）**：`game/commits.go` 开机、每 2 分钟、帮工干完一轮 15 秒后各调一次 `Contributions`，变了施加 `commits` 事实，经验由它折。
- **管家（`manager`、`tool`）**：农场现状和 `look` 工具列出 `List` 和 `Root`。
- **HTTP（`handler`）**：只转发；`github.refresh` 先刷新检测，再调工单的 `RefreshPullRequests`。

## 为什么这样

- **帮工在 worktree 里干，不在主人的仓库里。** 几个帮工同时改一个仓库会互相覆盖，做坏了也难撤；worktree 加分支让每一份改动可看、可撤、可以一份一份收。代价是磁盘上多了 worktree 和分支，项目必须是 git 仓库。直接在项目里改留作档案的选项（关掉 worktree），默认开着。
- **worktree 按工单开，约束放在 `Workplace` 里。** 按帮工开时，取消后重开的帮工不在原来的分支上，还会一张工单两个 worktree；按工单号算出路径，有就复用，调用方不用记。
- **冲突用 `git merge-tree` 预检，不先合再中止。** 合了再中止要碰项目克隆的工作区，中止失败还得收拾；`merge-tree` 不碰任何工作区。冲突交回帮工，不交给主人在终端里解决：帮工最清楚自己改了什么，能解决、跑测试、在结论里说怎么取舍。
- **合进计划分支用 `commit-tree` 和 `update-ref`，不检出。** 计划分支没有自己的工作区，检出就要占用项目克隆；`update-ref` 带旧值，被别人挪过就不覆盖。
- **一个项目一把锁，检查在锁外。** 两个帮工同时派到一个新项目会一起 `git init`，两次收获会一起往一条分支上合；但检查要跑几分钟，放在锁里同一个项目就开不了新 worktree。锁外检查，进锁核对分支和主分支没变。
- **合并后清理失败只是警告。** 合进去、推上去的东西撤不回来，清理失败改成失败只会让工单停在错的状态。
- **能不能提 PR 只在检测时算，读的地方只读缓存。** `gh` 慢且可能卡住，列表和收获不应每次等它；检测串行、整份替换，失败一律算不能提。
- **导入只收 GitHub 仓库主页地址，登录了 `gh` 才克隆私有仓库。** 任意 git 地址要处理认证、SSH、凭据存储和各种传输；没登录时禁用凭据，克隆不会弹出终端的认证提示卡住。完整克隆，不浅克隆：地契的日历和统计要历史。导入不派帮工：导入和用模型是两件事。
- **数代码用 tokei，没装就说怎么装。** 自己按扩展名数要维护语言表、注释语法和生成文件的判断，结果也没 tokei 准；当后备并存就是两套结果。scc 差不多但主人要的是 tokei；GitHub linguist 要 Ruby，本地太重。占比按代码加注释算：按字节会让长行的 JSON、压缩文件占太多，只按代码行 tokei 会把 Markdown 正文算成注释、文档就没了。
- **提交算所有分支、不算合并。** 只算主分支（GitHub 的算法）时，帮工还没收的活要等收获才进日历；合并提交会让收获的那天重复算。
- **经验是工作目录里你名下的 commit。** 按完成的工单算奖励的是忙，失败重试也能刷；算这台机器上所有仓库会把和 VibeValley 无关的工作算进来；算所有作者会把别人的提交算成你的。帮工用这台机器的 git 用户提交，所以它们的提交算你的。
- **项目的上限是配置，跟着项目列表走，不进核心状态。** 它开机读一次、不随事实变；放进核心状态要改折法和黄金数据，只换来少问一次项目列表。地图的空位是上限减去在干活的（也不超过农场空着的地），和 `noRoom` 一致：歇着的帮工占着 worktree 但不占上限。

## 还没做的

- 一块地上几个人、写的权利像接力棒一样交接：[一块地上几个人一起种](../../.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)。
- 用 VibeValley 开发 VibeValley，Beta 的工作目录里放 VibeValley 自己：[用 VibeValley 开发 VibeValley](../../.agents/notes/proposed/process/2026-10-18-build-vibevalley-with-vibevalley.md)。

## 怎么验证

- `project/project_test.go`（真的 git 仓库，GitHub 地址改写到本地的临时仓库）：`TestSessionsProjectNamesAndAddresses`、`TestSessionsNewProjectsAndDuplicates`、`TestSessionsCloneOffline`、`TestCheckSaysWhatCreateWouldRefuse`（新建、导入、拒绝覆盖、失败清理）；`TestIssueWorkplaceLifecycle`（按工单复用、只剩分支时重建、清理）；`TestSessionsLeftOversCommittedWithoutCaches`；`TestMergeRunsProjectCheck`、`TestMergeCheckTimeoutAndOutputTail`、`TestMergeCheckMustBeExecutable`、`TestMergeCheckOutsideProjectLock`、`TestLocalHarvestChecksTheCombinedTree`、`TestPublishedMergeKeepsReceiptWhenWorktreeCleanupFails`、`TestSessionsTaskBranchMerges`、`TestSessionsChangedFilesSinceTheBase`；地契的 `TestSessionsTokeiOutput`、`TestSessionsTokeiCounts`、`TestSessionsWithoutTokei`、`TestSessionsActivityOf`、`TestSessionsAYearOfCommits`、`TestSessionsProjectsWithTheirNewestCommit`、`TestSessionsSlotsAreTheProjectLimitWithinTheBeds`。
- `project/path_test.go` 的 `TestWorkplaceRefusesProjectSymlinkOutsideRoot`；`contributions_test.go` 的 `TestContributionObservationOwnsNestedRepositoriesAndWorktreeIdentity`。
- `project/github_test.go`：`TestGitHubProbe`、`TestGitHubPermissionsAndCache`、`TestGitHubOrigins`、`TestGitHubRefreshClearsPermissionsWhenLoggedOut`、`TestPrivateCloneUsesLoggedInGitHub`；`pull_request_test.go`：`TestPullRequestRequiresOptInAndCapability`、`TestPullRequestFailuresAndRecovery`、`TestPullRequestCheckDescription`、`TestPullRequestSyncMain`。
- `workspace/work_test.go`：`TestTwoSentToANewProjectAtOnce`、`TestLimitsOnProjectAndRuntime`、`TestChangesBeforeAMerge`、`TestConflictingBranchStaysUntilResolved`、`TestMergeClearsTheWorktree`、`TestMovingToDoneRefusesFailedProjectCheck`、`TestIssueWorktreeSurvivesCancellationAndReopen`；`workspace/pull_request_test.go` 的 `TestPullRequestHarvest`；`game/commits_test.go` 的 `TestSessionsCommitsCountedOncePerRepository`。
- 客户端：`test/workbench/projects_test.dart`、`test/workbench/map_test.dart`（空位、锁住的地、排队只算排上队的）；`test/host/folders_test.dart`（渠道的工作目录）。
