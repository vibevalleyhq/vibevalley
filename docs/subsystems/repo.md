# 仓库

仓库（`Repo`）是空间 `$VIBEVALLEY_WORK_ROOT/repos/` 下的一个 git 仓库，在农场地图上画成一座岛。服务端的 `modules/repo.rs` 管仓库新建与克隆、统计与 `gh` 检测，`modules/publish.rs` 发布已有分支；工单 worktree、冲突预检、`.vibevalley/check` 与合并在工单板（`vibevalley-issues`）里，git 操作都经 `vibevalley-git` 调系统的 `git`。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 空间（`repos/`、`worktrees/` 与全局 `AGENTS.md`）、仓库新建与 GitHub 克隆 | 工作目录根路径配置（`work_root`，[设置和配置](docs/subsystems/setting.md#模型和不变量)） |
| 工单 worktree 与分支 `vibevalley/issue-<号>` 的创建、复用、重置与清理 | 何时派活、何时合并、合并和跟 PR 的编排（[工单](docs/subsystems/issue.md#完成和交付)） |
| 分支改动读取（`Changes`）、冲突预检（`git merge-tree`）、运行 `.vibevalley/check`、子工单的检查（`verifyCheckout`） | 会话生命周期与并发槽位准入控制（[帮工](docs/subsystems/session.md)） |
| 本地合并、无检出合入父分支（`merge_into`）、推送已有分支并开 PR/MR | 经验值、等级与成就计算（[游戏](docs/subsystems/game.md#模型和不变量)） |
| `gh` 状态检测缓存、语言统计（`tokei`）、年度提交日历与作者 commit 计数 | 仓库页与群岛地图的界面渲染（[客户端](docs/subsystems/app.md)、[农场的皮](docs/subsystems/farm.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/vibevalley-server/src/modules/repo.rs` | `repo.*`、`github.*`：`<工作目录>/repos` 下按名字新建或克隆、活跃度与语言（`tokei`）、`gh` 能不能开 PR |
| `crates/vibevalley-server/src/modules/publish.rs` | `repo.pr.submit`：推送已有分支并开 GitHub PR 或 GitLab.com MR |
| `crates/vibevalley-git/src/repo.rs` | git 封装：状态、diff、分支、worktree、冲突预检（`merge_check`）、无检出合入（`merge_into`：`merge-tree` + `commit-tree` + `update-ref`） |
| `crates/vibevalley-issues/src/lib.rs`、`crates/vibevalley-issues/src/git.rs`、`crates/vibevalley-issues/src/check.rs` | 工单的 worktree 与分支、合并交付、跑 `.vibevalley/check` |

接口见 [capabilities.md](docs/reference/capabilities.md)（`repo.*`、`github.*`、`issue.diff.get`）。

## 模型和不变量

- **仓库即 `repos/<名字>` 下的直接子目录**：名字仅含字母、数字、`-`、`_`、`.`（最长 64 字符），禁止符号链接跳出 `repos/`。派活目标仓库不存在时自动 `git init -b main` 并生成初始提交。
- **一张工单固定一个 worktree 与一条分支**：路径为 `worktrees/<仓库>.<工单号>`，分支为 `vibevalley/issue-<工单号>`；重开或换帮工直接复用，首次创建时从基分支切出，目标仓库有 `.vibevalley/setup` 就在锁外跑一次（脚本由目标仓库自己提供）。
- **同仓库写操作串行，本地合并的耗时检查在锁外执行**：新建、开 worktree、合并与清理按仓库串行；`.vibevalley/check`（默认限时 1200 秒）在锁外运行，通过后重新进锁核对分支与基分支未变才执行合并。
- **子工单的检查（`check.rs`）**：工单算好要过的检查（`CheckoutChecks`）：验收检查要先失败（它是兄弟们要让它通过的测试），它改的文件（相对父分支，含未提交和未跟踪的）交回去冻结；否则每个检查都要过（`sh -c`，限时 10 分钟，留末尾 3000 字），过之前和之后冻结的文件都不许动；不过就退回帮工。
- **清理时保留现场**：有未提交改动或未合入提交时保留 worktree 和分支。
- **冲突预检与合入父分支均不污染工作区**：
  - 冲突检测用 `git merge-tree --write-tree`；子工单合入父分支（`merge_into`）用 `merge-tree` + `commit-tree` + 带旧值校验的 `update-ref`。
- **合并前工作树必须干净**：有未提交改动就退回，让帮工按仓库自己的提交规范提交，不再代它生成不合规的提交说明。
- **PR 能力只读检测缓存**：开机与调 `github.refresh` 时检测 `gh` 登录及各仓库 `origin` 写权限并缓存。工单走 PR 交付、PR 快照与 CI 日志：Rust 版还没有。

## 怎么走

**新建或导入仓库（`repo.create`）**

1. 校验仓库名与可选的 `https://github.com/<owner>/<repo>` 地址，在仓库锁内排他创建目录。
2. 无地址时初始化空仓库并生成首个提交；有地址时，已登录 `gh` 用 `gh repo clone`，未登录用禁用交互凭据的 `git clone`（限时 3 分钟，失败删除残留目录）。

**本地合并**

1. **锁外准备**：要求工作树干净，用 `merge-tree` 预检冲突，执行目标仓库自己提供的 `.vibevalley/check`（`check.rs`：没有这个文件记 `not-run`，退出码非 0 就把末尾 40 行交回帮工）并记录当前分支 commit。
2. **进锁复核与执行**：确认分支 commit 未变、主分支无新增未检提交且无冲突：
   - **本地合并**：在仓库主检出执行 `git merge --no-edit`，成功后强制删除工单 worktree 与分支。
   - **合入父分支（`merge_into`）**：通过 `commit-tree` 与 `update-ref` 原子推进父分支引用，清理子工单 worktree 与分支。


**发布已有分支（`repo.pr.submit`）**

本机用户显式给出检出根目录、分支、完整 SHA、base、标题和正文。检出可在空间外，不注册仓库。接口的 `can` 只有 `user`，HTTP 拒绝 Bearer 身份；远程设备、助手和帮工工具不暴露此操作。本机回环监听仍是用户的信任边界。

发布按仓库共用 Git 目录串行，拒绝脏目录、detached HEAD、分支或 SHA 不符、默认/base 分支、多远端、多个 URL、读写仓库不一致及 URL 重写配置。GitHub.com 用 gh，GitLab.com 用 glab；工具缺失、未登录、返回无法解码均拒绝。未知主机与自建 GitLab 不支持。

正式发布取得目标分支，预检冲突，执行检出的 `.vibevalley/check`，再核对工作树、HEAD、远端配置和 base SHA。检查的 PATH 优先使用目标检出的 `node_modules/.bin`，移除宿主带入的其他检出工具路径。推送使用明确 URL 和 `<SHA>:refs/heads/<branch>`，不强推，不自动提交或切分支。平台查询开放 PR/MR 后复用或创建；只有得到校验过的链接才返回发布成功。

`dryRun` 只读取检出与平台信息，不 fetch、不运行检查、不推送或创建请求。回执的 `check` 区分 `preview`、`passed`、`not-run`；没有脚本不算检查通过。推送后平台失败明确说明 SHA 已推送但链接未确认；重试查询已有请求。失败、取消和成功均保留用户的原检出。网络中断或取消时，远端可能已接收操作，应查询后重试。

工单走 PR 交付还没接到这条流程上。

## 和谁打交道

- **工单板（`vibevalley-issues`）**：开、复用、清工单的 worktree，读改动，预检冲突，跑检查，合并或合入父分支。
- **游戏（`game`）**：读仓库的 commit 计数。

## 为什么这样

- **按工单隔离 git worktree，锁外跑检查、锁内验引用**：每个工单在独立目录修改互不踩踏；耗时测试放锁外，进锁复核 commit 未变再合并，兼顾并发开单与主分支质量。
- **用 git 底层树操作实现无检出预检与父分支合入**：`merge-tree` 和 `commit-tree` 不碰工作区文件，父工单无需维持常驻 worktree 即可接收子工单合入。
- **GitHub 检测与克隆收紧边界**：克隆仅收标准 GitHub 主页地址并禁用终端交互弹窗，PR 权限统一走后台缓存，避免网络抖动阻塞看板操作。
- **不让服务端代写提交**：自动生成的单行提交说明过不了仓库自己的提交门禁（`scripts/docs/commit-msg.ts`）；退回帮工自己提交，每个 commit 和 PR 才都符合仓库规范。

## 还没做的

- 工单走 PR 交付、跟 CI 与评审：Rust 版还没有。
- 同一工单 worktree 内多帮工接力：[一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)。

## 怎么验证

- `crates/vibevalley-git/src/tests.rs`：git 封装、冲突预检与无检出合入。
- `crates/vibevalley-issues/tests/board.rs`：合并、冲突、检查失败退回、留分支。
- `crates/vibevalley-server/tests/publish.rs`：发布已有分支的预览、推送、拒绝与只许用户发布。
- `apps/web/test/repos.spec.ts`：工作台仓库新建与群岛地图。
