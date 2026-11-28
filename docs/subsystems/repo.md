# 仓库

仓库（`Repo`）是空间 `$VIBEVALLEY_WORK_ROOT/repos/` 下的一个 git 仓库，在农场地图上画成一座岛。服务端的 `crates/server/src/repo/` 管仓库新建与克隆、目录发现、只读改动读取、统计与 `gh` 检测；git 操作统一经 `vibevalley-git` 调系统的 `git`。服务端不再创建、合并或清理工单 worktree 或分支，分支与 `git worktree` 由 Agent 自治管理；已有分支推送、PR/MR 发布与轮询由独立的 `crates/server/src/issue/pull/` 与 `crates/server/src/repo/publish.rs` 承担（[PR 与分支发布](docs/subsystems/pull.md)）。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 空间（`repos/` 与全局 `AGENTS.md`）、仓库新建与 GitHub 克隆、仓库目录解析 | 工作目录根路径配置（`work_root`，[设置和配置](docs/subsystems/setting.md#模型和不变量)） |
| 面向审查的只读目录差异读取（`diff_dir_async`）与已有分支发布预检（`Publisher`） | 工单状态机、多态交付凭据与纯 DAG 拆单（[工单](docs/subsystems/issue.md#完成和交付)） |
| `gh` 状态检测缓存、语言统计（`vibevalley-files`）、年度提交日历与作者 commit 计数 | 会话生命周期、无目录会话与并发槽位准入控制（[帮工](docs/subsystems/session.md)） |
| 桌面端本地 Git 侧栏所需的 `crates/git` 底层封装 | 分支与 `git worktree` 自治创建、本地提交与验证（执行会话内的 Agent 自主负责） |
| PR/MR 推送门禁与远端解析辅助（`repo/publish.rs`） | PR 状态与 CI/评审轮询（[PR 与分支发布](docs/subsystems/pull.md)）；仓库页与群岛地图渲染（[客户端](docs/subsystems/app.md)、[农场的皮](docs/subsystems/farm.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/server/src/repo/`（`mod.rs`、`local.rs`、`publish.rs`、`github.rs`、`stats.rs`） | `repo.*`、`github.*`：`<工作目录>/repos` 下按名字新建或克隆、目录解析与只读 diff、活跃度与语言（`vibevalley_files::count_loc`）、`gh` 能不能开 PR、`Publisher` 分支推送预检 |
| `crates/files/src/loc.rs` | 纯 Rust 并行代码行与语言统计（跳过二进制、`.gitignore` 与锁文件/构建目录） |
| `crates/git/src/read.rs`、`crates/git/src/cmd.rs`、`crates/git/src/repo.rs` | git 封装：`read.rs` 纯 Rust 无子进程只读（`discover_root`、`git_dir`、`git_common_dir`、`head`、`branch_exists`、`branches`、`commit_id_fast`、`remote_url`、`global_config_value`、`worktrees`）；`cmd.rs` 基于 `tokio::process::Command`（`.kill_on_drop(true)` + 异步 stdin）并施加 5 项环境安全保护；供 `crates/server/src/repo/` 与桌面端 `apps/mac/crates/workspace` 本地 Git 侧栏共用 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`repo.*`、`github.*`、`issue.diff.get`）。

## 模型和不变量

- **仓库即 `repos/<名字>` 下的直接子目录**：名字仅含字母、数字、`-`、`_`、`.`（最长 64 字符），禁止符号链接跳出 `repos/`。
- **工单上的 `repo` 字段只是可选上下文提示**：服务端不再为工单创建 `worktrees/` 目录、不创建或合并 `vibevalley/issue-<号>` 分支，也不代写提交；Agent 根据任务决定直接在仓库目录工作或自行 `git worktree add`，并通过 `DeliveryReceipt` 回写交付凭据。
- **PR 能力只读检测缓存**：开机与调 `github.refresh` 时检测 `gh` 登录及各仓库 `origin` 写权限并缓存。分支推送、PR 轮询与快照见 [PR 与分支发布](docs/subsystems/pull.md)。

## 怎么走

**新建或导入仓库（`repo.create`）**

1. 校验仓库名与可选的 `https://github.com/<owner>/<repo>` 地址，在仓库锁内排他创建目录。
2. 无地址时初始化空仓库并生成首个提交；有地址时，已登录 `gh` 用 `gh repo clone`，未登录用禁用交互凭据的 `git clone`（限时 3 分钟，失败删除残留目录）。

**读取审查差异（`issue.diff.get`）**

`Repo::diff_dir_async` 读取工单会话当前目录（或仓库目录）的只读工作区状态与补丁，供评审视图与只读评审 Agent 查看，不修改任何分支或工作区状态。

**发布已有分支（`repo.pr.submit`）**：规则与流程见 [PR 与分支发布](docs/subsystems/pull.md)。

## 和谁打交道

- **工单板（`issue`）**：按 `repo` 提示解析仓库目录、读取只读目录差异，不包含任何 worktree 生命周期或分支合并调用。
- **PR 与分支发布（`issue/pull`）**：复用 `repo/publish.rs` 的 `Publisher`、空间内仓库列表与 `gh` 远端解析约定。
- **游戏（`game`）**：读仓库的 commit 计数。
- **桌面工作区（`apps/mac/crates/workspace`）**：复用 `crates/git` 为用户提供本地 Git 侧栏。

## 为什么这样

- **控制面彻底退出 Git/Worktree 保姆层（`#36`）**：服务端不拦截分支、不替 Agent 建 worktree、不自动合并父子分支，消除本地合并冲突与脏状态锁死，同时支持零仓库约束的无目录会话（`#118`）。
- **GitHub 检测与克隆收紧边界**：克隆仅收标准 GitHub 主页地址并禁用终端交互弹窗，PR 权限统一走后台缓存，避免网络抖动阻塞看板操作。
- **纯 Rust 只读 + 系统 `git` 异步写（不引入 `gix`），并统一 5 项环境安全护栏**：引入 `gix`（gitoxide）会拉入数十个传递 crate 并产生与用户本地 git hooks、filter、GPG 签名的语义漂移；`read.rs` 用数百行纯 Rust 文件解析覆盖高频只读路径，复杂 revspec 与写操作统一走 `crates/git/src/cmd.rs`（剥离 8 个 `REPO_OVERRIDES` 环境变量、固定 `--no-pager -c core.quotepath=off -c color.ui=never` + `LC_ALL=C`、`GIT_TERMINAL_PROMPT=0`、只读设 `GIT_OPTIONAL_LOCKS=0`、统一 `GitError`），并由 `arch-audit` `NoRawGitCommand` 禁止在 `crates/git` 外直呼 `Command::new("git")`。

## 怎么验证

- `crates/git/src/tests.rs`：git 封装与环境护栏验证。
- `crates/server/tests/issue_board.rs`、`crates/server/tests/publish.rs`：Agent 自治目录执行、`DeliveryReceipt` 回写、无目录会话与 `repo.pr.submit` 发布门禁验证。
- `apps/mac/ui/app/scenarios.test.tsx`：仓库列表、语言条与提交日历页面验证。
