# 仓库

仓库（`Repo`）是空间 `$VIBEVALLEY_WORK_ROOT/repos/` 下的一个 git 仓库，在农场地图上画成一座岛。服务端的 `work/repo.rs` 管仓库新建与克隆、统计与 `gh` 检测；工单 worktree、冲突预检、`.vibevalley/check` 与合并在 `work/workplace`（`Workplace`）里，工单板只告诉它工单号、仓库和帮工的 worktree，git 操作都经 `vibevalley-git` 调系统的 `git`。已有分支推送、PR/MR 发布与轮询由独立的 `work/pull` 承担（[PR 与分支发布](docs/subsystems/pull.md)）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 空间（`repos/`、`worktrees/` 与全局 `AGENTS.md`）、仓库新建与 GitHub 克隆 | 工作目录根路径配置（`work_root`，[设置和配置](docs/subsystems/setting.md#模型和不变量)） |
| 工单 worktree 与分支 `vibevalley/issue-<号>` 的创建、复用、重置与清理 | 何时派活、何时合并与交付编排（[工单](docs/subsystems/issue.md#完成和交付)） |
| 分支改动读取（`Changes`）、冲突预检（`git merge-tree`）、运行 `.vibevalley/check`、子工单的检查（`verifyCheckout`） | 会话生命周期与并发槽位准入控制（[帮工](docs/subsystems/session.md)） |
| 本地合并、无检出合入父分支（`merge_into`） | 分支推送、PR/MR 发布、状态与 CI/评审轮询（[PR 与分支发布](docs/subsystems/pull.md)） |
| `gh` 状态检测缓存、语言统计（`tokei`）、年度提交日历与作者 commit 计数 | 经验值、等级与成就计算（[游戏](docs/subsystems/game.md#模型和不变量)）；仓库页与群岛地图渲染（[客户端](docs/subsystems/app.md)、[农场的皮](docs/subsystems/farm.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/server/src/repo.rs` | `repo.*`、`github.*`：`<工作目录>/repos` 下按名字新建或克隆、活跃度与语言（`tokei`）、`gh` 能不能开 PR |
| `crates/git/src/read.rs`、`crates/git/src/cmd.rs`、`crates/git/src/repo.rs` | git 封装：`read.rs` 纯 Rust 无子进程只读（`discover_root`、`git_dir`、`git_common_dir`、`head`、`branch_exists`、`branches`、`commit_id_fast`、`remote_url`、`global_config_value`、`worktrees`）；`cmd.rs` 基于 `tokio::process::Command`（`.kill_on_drop(true)` + 异步 stdin）并施加 5 项环境安全保护；`repo.rs` 与 `verified_merge.rs` 负责状态、diff、分支、worktree、冲突预检与无检出合入 |
| `crates/server/src/runtime/worktree/mod.rs`、`crates/server/src/runtime/worktree/check.rs` | `Workplace`：确保仓库在（`ensure_repo`）、工单的 worktree 与分支（`worktree`、`base`）、改动（`changes`）、交付（`land`）、子工单合进父分支（`join`）、帮工走时收拾 worktree 和分支（`release`）、异步 `.vibevalley/check`；不读工单板的状态 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`repo.*`、`github.*`、`issue.diff.get`）。

## 模型和不变量

- **仓库即 `repos/<名字>` 下的直接子目录**：名字仅含字母、数字、`-`、`_`、`.`（最长 64 字符），禁止符号链接跳出 `repos/`。派活目标仓库不存在时自动 `git init -b main` 并生成初始提交。
- **一张工单固定一个 worktree 与一条分支**：路径为 `worktrees/<仓库>.<工单号>`，分支为 `vibevalley/issue-<工单号>`；重开或换帮工直接复用，首次创建时从基分支切出，目标仓库有 `.vibevalley/setup` 就在锁外跑一次（脚本由目标仓库自己提供）。
- **本地交付绑定候选提交**。项目检查在临时 worktree 中读取拟合入的内容。主分支若在检查期间前进，服务重新生成候选提交并复查。
- **子工单的检查（`worktree/check.rs`）**：工单算好要过的检查（`CheckoutChecks`）：验收检查要先失败（它是兄弟们要让它通过的测试），它改的文件（相对父分支，含未提交和未跟踪的）交回去冻结；否则每个检查都要过（`sh -c`，限时 10 分钟，留末尾 3000 字），过之前和之后冻结的文件都不许动；不过就退回帮工。
- **清理时保留现场**：有未提交改动或未合入提交时保留 worktree 和分支。
- **冲突预检与合入父分支均不污染工作区**：
  - 冲突检测用 `git merge-tree --write-tree`；子工单合入父分支（`merge_into`）用 `merge-tree` + `commit-tree` + 带旧值校验的 `update-ref`。
- **工单剩余改动进入候选提交**。本地交付前，服务把工单 worktree 的剩余改动提交到工单分支。目标检出的本地修改保留。
- **PR 能力只读检测缓存**：开机与调 `github.refresh` 时检测 `gh` 登录及各仓库 `origin` 写权限并缓存。分支推送、PR 轮询与快照见 [PR 与分支发布](docs/subsystems/pull.md)。

## 怎么走

**新建或导入仓库（`repo.create`）**

1. 校验仓库名与可选的 `https://github.com/<owner>/<repo>` 地址，在仓库锁内排他创建目录。
2. 无地址时初始化空仓库并生成首个提交；有地址时，已登录 `gh` 用 `gh repo clone`，未登录用禁用交互凭据的 `git clone`（限时 3 分钟，失败删除残留目录）。

**本地合并**

1. 固定目标分支和工单分支的提交，在临时 worktree 生成候选提交。合并预检发现冲突时，保留工单并返回冲突文件。
2. 在候选提交上运行 `.vibevalley/check`。未配置脚本的仓库可直接交付。检查失败时返回末尾 40 行。检查改写候选提交或已跟踪文件时，服务也会拒绝交付。
3. 核对工单分支仍指向原提交。通过本地 Git 的旧值校验将目标分支推进到候选提交。目标前进后重新生成候选并复查。合并钩子在候选检出中执行。本地引用更新跳过推送钩子。Git 拒绝更新目标检出时，向调用方返回原因。[实现](crates/git/src/verified_merge.rs)

工单改动接口返回审查基线提交和工单文件树。文件补丁来自这两个固定的 Git 对象。工单未提交的文件也包含在补丁中。传入上次显示的文件树时，接口在 `sinceReview` 返回变化的补丁。已经通过的审查会保留文件树引用，清理工单 worktree 后仍可核对。

**发布已有分支（`repo.pr.submit`）**：已独立到 `work/pull`，规则与流程见 [PR 与分支发布](docs/subsystems/pull.md)。

## 和谁打交道

- **工单板与帮工（`work/issue`、`work/session`）**：经 `Workplace` 开、复用、清工单的 worktree，读改动，预检冲突，跑检查，合并或合入父分支。
- **PR 与分支发布（`work/pull`）**：读取空间内仓库列表与 `gh` 远端解析约定。
- **游戏（`game`）**：读仓库的 commit 计数。

## 为什么这样

- **分别保留工单改动和候选提交**。当另一张工单先合入主分支时，新候选可能产生逻辑冲突，即使 Git 仍可无冲突合并。检查候选提交能在交付前发现这种失败。
- **用 git 底层树操作实现无检出预检与父分支合入**：`merge-tree` 和 `commit-tree` 不碰工作区文件，父工单无需维持常驻 worktree 即可接收子工单合入。
- **GitHub 检测与克隆收紧边界**：克隆仅收标准 GitHub 主页地址并禁用终端交互弹窗，PR 权限统一走后台缓存，避免网络抖动阻塞看板操作。
- **不让服务端代写提交**：自动生成的单行提交说明过不了仓库自己的提交门禁（`scripts/docs/commit-msg.ts`）；退回帮工自己提交，每个 commit 和 PR 才都符合仓库规范。
- **纯 Rust 只读 + 系统 `git` 异步写（不引入 `gix`），并统一 5 项环境安全护栏**：引入 `gix`（gitoxide）会拉入数十个传递 crate 并产生与用户本地 git hooks、filter、GPG 签名的语义漂移；`read.rs` 用数百行纯 Rust 文件解析覆盖高频只读路径，复杂 revspec 与写操作统一走 `crates/git/src/cmd.rs`（剥离 8 个 `REPO_OVERRIDES` 环境变量、固定 `--no-pager -c core.quotepath=off -c color.ui=never` + `LC_ALL=C`、`GIT_TERMINAL_PROMPT=0`、只读设 `GIT_OPTIONAL_LOCKS=0`、统一 `GitError`），并由 `arch-audit` `NoRawGitCommand` 禁止在 `crates/git` 外直呼 `Command::new("git")`。

## 还没做的

- 同一工单 worktree 内多帮工接力：`#50`。
- 两级仓库寻址（`<owner>/<repo>`）与空间解耦：`#10`、`#36`。

## 怎么验证

- `crates/git/src/tests.rs`：git 封装、冲突预检与无检出合入。
- `crates/server/tests/issue_board.rs`：合并、冲突、检查失败退回、留分支。
- `apps/mac/ui/app/scenarios.test.tsx`：仓库列表、语言条与提交日历页面验证。
