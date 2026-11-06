# 仓库

仓库（`Repo`）是空间 `$VIBEVALLEY_WORK_ROOT/repos/` 下的一个 git 仓库，在农场地图上画成一座岛。`apps/server/src/repo` 负责仓库新建与克隆、工单 worktree 与分支管理、冲突预检、`.vibevalley/check` 执行、分支合并、GitHub PR 交互及提交统计。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 空间（`repos/`、`worktrees/` 与全局 `AGENTS.md`）、仓库新建与 GitHub 克隆 | 工作目录根路径配置（`work_root`，[设置和配置](docs/subsystems/setting.md#模型和不变量)） |
| 工单 worktree 与分支 `vibevalley/issue-<号>` 的创建、复用、重置与清理 | 何时派活、何时触发检查与合并、PR 轮询调度（[工单](docs/subsystems/issue.md#怎么走)） |
| 分支改动读取（`Changes`）、冲突预检（`git merge-tree`）、运行 `.vibevalley/check` | 会话生命周期与并发槽位准入控制（[帮工](docs/subsystems/session.md)） |
| 本地合并、无检出合入父分支（`mergeInto`）、推送分支与 `gh` PR 创建/查询 | 经验值、等级与成就计算（[游戏](docs/subsystems/game.md#模型和不变量)） |
| `gh` 状态检测缓存、语言统计（`tokei`）、年度提交日历与作者 commit 计数 | 仓库页与群岛地图的界面渲染（[客户端](docs/subsystems/app.md)、[农场的皮](docs/subsystems/farm.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/repo/repo.ts` | 对外 `Repo` 服务：新建/克隆、worktree、检查与合并、PR 提交、GitHub 检测与 commit 计数 |
| `apps/server/src/repo/repository.ts`、`git.ts` | 底层 git 命令拼装（`merge-tree`、`commit-tree`、`update-ref`、清理）与子进程限时执行 |
| `apps/server/src/repo/workplace.ts` | 仓库技术栈识别、PR 标题正文读取（`vibevalley-pr.md`）与对外形状（`Workplace`、`MergeFailure`） |
| `apps/web/src/features/repo/ReposPage.tsx` | 工作台仓库页（新建、概况、语言占比、提交日历） |
| `apps/web/src/farm/map/RepoMap.tsx`、`islands.ts` | 像素农场群岛地图与岛屿空位计算 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`repo.*`、`github.*`、`issue.diff.get`）。

## 模型和不变量

- **仓库即 `repos/<名字>` 下的直接子目录**：名字仅含字母、数字、`-`、`_`、`.`（最长 64 字符），禁止符号链接跳出 `repos/`。派活目标仓库不存在时自动 `git init -b main` 并生成初始提交。
- **一张工单固定一个 worktree 与一条分支**：路径为 `worktrees/<仓库>.<工单号>`，分支为 `vibevalley/issue-<工单号>`；重开或换帮工直接复用，首次创建时从基分支切出并在锁外跑一次 `.vibevalley/setup`（安装依赖并构建各包的 `dist/` 声明）。
- **同仓库写操作串行，耗时检查在锁外执行**：每个仓库一把信号量锁 `serially` 保护新建、开 worktree、合并与清理；`.vibevalley/check`（默认限时 1200 秒）在锁外运行，通过后重新进锁核对分支与基分支未变才执行合并。
- **清理回执区分现场是否保留（`WorkplaceRelease`）**：`release` 与 `clear` 返回 `{ kept, why? }`；有未提交改动或未合入提交时保留现场，仅 `kept: false` 时允许删除工单身份。
- **冲突预检与合入父分支均不污染工作区**：
  - 冲突检测用 `git merge-tree --write-tree`；子工单合入父分支（`mergeInto`）用 `merge-tree` + `commit-tree` + 带旧值校验的 `update-ref`。
- **合并和提 PR 前工作树必须干净**：`checkMerge` 先看 `git status --porcelain`；有未提交改动就以 `MergeFailure` 退回，让帮工按仓库自己的提交规范提交，不再代它生成不合规的提交说明。
- **PR 能力只读检测缓存**：开机与调 `github.refresh` 时检测 `gh` 登录及各仓库 `origin` 写权限并缓存；判断 `usesPullRequests` 只读该缓存与 `github.pr_repos` 配置。

## 怎么走

**新建或导入仓库（`repo.create`）**

1. 校验仓库名与可选的 `https://github.com/<owner>/<repo>` 地址，在仓库锁内排他创建目录。
2. 无地址时初始化空仓库并生成首个提交；有地址时，已登录 `gh` 用 `gh repo clone`，未登录用禁用交互凭据的 `git clone`（限时 3 分钟，失败删除残留目录）。

**合并与提交 PR**

1. **锁外准备**：要求工作树干净，用 `merge-tree` 预检冲突，执行 `.vibevalley/check`（`vp check --deny-warnings`、`server:check`/`web:check` 按改动范围、`docs:verify`）并记录当前分支 commit。
2. **进锁复核与执行**：确认分支 commit 未变、主分支无新增未检提交且无冲突：
   - **本地合并（`merge`）**：在仓库主检出执行 `git merge --no-edit`，成功后强制删除工单 worktree 与分支。
   - **合入父分支（`mergeInto`）**：通过 `commit-tree` 与 `update-ref` 原子推进父分支引用，清理子工单 worktree 与分支。
   - **提交 PR（`submitPullRequest`）**：`git push -u origin <分支>`，读取 `.git/vibevalley-pr.md` 调 `gh pr create` 或复用已有开放 PR。

## 和谁打交道

- **工单与帮工（`issue`、`session`）**：提供 `workplace`、`release`、`reset`、`clear`、`Changes`、`merge`、`mergeInto`、`submitPullRequest` 与 `pullRequestState`。
- **接入与游戏（`ingress`、`game`）**：向 Ingress 提供 `githubRemote` 与 `githubRequest`；向 Game 提供主人名下的 `contributions` commit 计数。

## 为什么这样

- **按工单隔离 git worktree，锁外跑检查、锁内验引用**：每个工单在独立目录修改互不踩踏；耗时测试放锁外，进锁复核 commit 未变再合并，兼顾并发开单与主分支质量。
- **用 git 底层树操作实现无检出预检与父分支合入**：`merge-tree` 和 `commit-tree` 不碰工作区文件，父工单无需维持常驻 worktree 即可接收子工单合入。
- **GitHub 检测与克隆收紧边界**：克隆仅收标准 GitHub 主页地址并禁用终端交互弹窗，PR 权限统一走后台缓存，避免网络抖动阻塞看板操作。
- **不让服务端代写提交**：自动生成的单行提交说明过不了仓库自己的提交门禁（`scripts/commit-msg.ts`）；退回帮工自己提交，每个 commit 和 PR 才都符合仓库规范。

## 还没做的

- 同一工单 worktree 内多帮工接力写锁交接：[一块地上几个人一起种](.agents/notes/proposed/architecture/2026-10-18-a-crew-on-one-plot.md)。
- 将 `.vibevalley/check` 抽成测试端口、分支合并与释放决策抽成规则层纯函数：[把模块层往下压](.agents/notes/proposed/testing/2026-10-26-press-the-module-layer-down.md)。

## 怎么验证

- `apps/server/src/repo/repo.test.ts`、`github.test.ts`、`stack.test.ts`：仓库创建与克隆、worktree 复用与释放回执、未提交改动拒绝合并、`.vibevalley/check` 门禁、无检出合入父分支与 commit 统计测试。
- `apps/server/src/flows/pull_request.test.ts`、`apps/server/src/flows/pr-follow.test.ts`、`apps/web/test/repos.spec.ts`：PR 提交与合入全流程、CI 回流、工作台仓库新建与群岛地图测试。
