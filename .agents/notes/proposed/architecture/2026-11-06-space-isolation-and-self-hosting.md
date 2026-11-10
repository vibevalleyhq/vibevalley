# Agent Note: Space 隔离单元（repos、worktrees、pkm）与 VibeValley 自举开发全链路收敛步骤

Status: proposed

## Problem

要用 VibeValley 开发 VibeValley 自身功能（自举开发），系统需打通从“空间隔离 → 思考立项 → 派工切树 → 编码自检 → PR 与 CI 闭环 → 合并升级”的 6 个全链路阶段。当前代码已实现主干状态机与 GitHub 轮询闭环，但仍有 8 处具体断点阻碍全链路跑通：

| 阶段 | 已打通能力（现状） | 距离自举全链路的缺口（未实现） | 涉及代码 |
|---|---|---|---|
| 1. 空间隔离（`Space`） | 支持配置 `home`、`workRoot`、`pkm.root`；支持 SQLite 持久化与重启恢复（`Session.restore`） | `repos/*`、`worktrees/*` 与 `pkm/*` 分散在 `workRoot` 与 `home` 两处，未收敛为 `<space>/{repos,worktrees,pkm}` | [apps/server/src/infra/config.ts](apps/server/src/infra/config.ts)、[apps/server/src/repo/repo.ts](apps/server/src/repo/repo.ts)、[apps/server/src/pkm/pkm.ts](apps/server/src/pkm/pkm.ts) |
| 2. 立项与拆单 | 助手可查改 `Pkm`、派帮工探路起草工单（`issue.refine`）；帮工可调 `issue_split` 按 DAG 拆分子工单 | `<space>/pkm` 与仓库内 `.agents/notes/` 双轨割裂，助手无法直接检索或生成符合 `vp run notes:verify` 规范的架构提案；助手固定 `noSkills`，无法按需加载仓库级 `.agents/skills/` | [apps/server/src/orchestrator/orchestrator.ts](apps/server/src/orchestrator/orchestrator.ts)、[apps/server/src/issue/split.ts](apps/server/src/issue/split.ts) |
| 3. 切树与环境准备 | `Repo.workplace` 自动快进 `main`、切出 `<worktrees>/vibevalley.<号>` 并调用 `.vibevalley/setup` | 本仓缺少 `.vibevalley/setup`，新切出的 worktree 无 `node_modules` 与 `packages/*/dist/*.d.ts`，帮工无法直接跑类型检查与测试 | [apps/server/src/repo/repo.ts](apps/server/src/repo/repo.ts) |
| 4. 编码与本地提交 | 帮工在 worktree 内提交代码、调 `issue_report` 汇报结构化 `checks`；子工单自动跑 `verifyChild` 合入父分支 | 1. 本仓 [scripts/commit-msg.ts](scripts/commit-msg.ts) 与 [scripts/regression.ts](scripts/regression.ts) 强制要求英文 `type(scope): summary` 标题及 `## What changed`、`## Checks`、`## Not verified` 段落；2. `Repo.checkMerge` 兜底提交未提交改动时使用固定文案 `server.repo.commit.leftOver`，会被本仓提交门禁拦截 | [apps/server/src/session/prompts.ts](apps/server/src/session/prompts.ts)、[apps/server/src/repo/repo.ts](apps/server/src/repo/repo.ts) |
| 5. PR 交付与 CI 回流 | 帮工可调 `issue_pr_submit` 或 `issue_report(prSubmit=true)` 建 PR；`Ingress.pollPullRequest` 自动轮询 CI 结果与评审意见并唤醒帮工 | 1. 本仓缺少 `.vibevalley/check`，未能在 push 前拦截 `vp check`、`docs:verify`、`primitives:verify` 与锁文件漂移；2. `Ingress.pollPullRequest` 仅回传失败 Check 名称与链接，未抓取 `gh run view --log-failed` 的报错日志片段 | [apps/server/src/repo/github.ts](apps/server/src/repo/github.ts)、[apps/server/src/ingress/github.ts](apps/server/src/ingress/github.ts) |
| 6. 合并与宿主升级 | `Issue.refreshPullRequests` 监测到 PR 合并后自动快进本地 `main`、清理 worktree 并关闭工单 | 若宿主进程直接运行在 `<space>/repos/vibevalley` 源码树上，分支合并与构建会改写运行中进程文件，缺少独立宿主目录与平滑重启脚本 | [apps/server/src/issue/merge.ts](apps/server/src/issue/merge.ts)、[apps/server/src/session/session.ts](apps/server/src/session/session.ts) |

## Proposal

将工作空间统一收敛为 `Space` 隔离单元（`<space>/{repos,worktrees,pkm}`），并按以下 6 个步骤打通 VibeValley 自举开发全链路：

```text
<space>/
├── AGENTS.md                  # 当前 Space 的全局准则
├── repos/                     # 原 repos/*：主分支 Git 仓库（<space>/repos/vibevalley）
├── worktrees/                 # 工单独立工作树（<space>/worktrees/vibevalley.<issueNumber>）
└── pkm/                       # 当前 Space 的笔记库（<space>/pkm/{daily,notes,sources,.index}）
```

### 步骤 1：在配置层收敛 `<space>/{repos,worktrees,pkm}` 路径函数

1. 修改 [packages/home/src/index.ts](packages/home/src/index.ts) 与 [apps/server/src/infra/config.ts](apps/server/src/infra/config.ts)：
   - 保留 `home`（`~/.vibevalley`）存放宿主运行时状态（SQLite 库、日志、会话事件流、模型凭据）。
   - 将空间根目录下的路径推导函数统一为：
     - `reposDir(c)`：`join(c.workRoot, "repos")`（取代原 `reposDir` 的 `"repos"`）。
     - `worktreesDir(c)`：`join(c.workRoot, "worktrees")`。
     - `pkmDir(c)`：`c.pkm.root || join(c.workRoot, "pkm")`（默认值从 `join(c.home, "pkm")` 迁入 `c.workRoot`）。
2. 若检测到旧目录 `<workRoot>/repos` 存在且 `<workRoot>/repos` 不存在，启动日志输出迁移提示。

### 步骤 2：将 `Repo` 与 `Pkm` 服务切换到 `Space` 子目录

1. 修改 [apps/server/src/repo/repo.ts](apps/server/src/repo/repo.ts)：
   - 将仓库根目录从 `join(work, "repos")` 改为 `reposDir(config)`（即 `<space>/repos`）。
   - 将工作树根目录保持为 `worktreesDir(config)`（即 `<space>/worktrees`）。
2. 修改 [apps/server/src/pkm/pkm.ts](apps/server/src/pkm/pkm.ts) 与 [apps/server/src/setting/setting.ts](apps/server/src/setting/setting.ts)：
   - `Pkm` 默认读写 `<space>/pkm`。
   - 设置接口返回当前 `Space` 下的 `repos`、`worktrees`、`pkm` 实际路径。
3. 同步更新 [docs/subsystems/repo.md](docs/subsystems/repo.md)、[docs/subsystems/pkm.md](docs/subsystems/pkm.md) 与 [docs/subsystems/setting.md](docs/subsystems/setting.md)。

### 步骤 3：新增本仓 `.vibevalley/setup` 与 `.vibevalley/check` 自举脚本

1. 新增可执行脚本 `.vibevalley/setup`：
   - 在 `Repo.workplace` 切出 `<space>/worktrees/vibevalley.<号>` 后自动运行。
   - 执行 `vp install --frozen-lockfile` 与 `vp run packages:build`，确保新 worktree 具备完整依赖与子包 `.d.ts` 构建产物。
2. 新增可执行脚本 `.vibevalley/check`：
   - 在 `Repo.checkMerge`（本地合并或提交 PR 前）自动运行。
   - 依次执行 `vp check --deny-warnings`、`vp run docs:verify` 与 `vp run primitives:verify`，在本地拦截类型、lint、文档链接、Agent Notes 目录与原语表漂移。

### 步骤 4：对齐本仓提交门禁与 PR 描述模板

1. 修改 [apps/server/src/repo/repo.ts](apps/server/src/repo/repo.ts) 的 `checkMerge`：
   - 当 worktree 存在未提交改动时，不再用单行 `commitLeft` 自动生成不合规提交，而是作为门禁失败退回帮工，要求帮工按仓库 `AGENTS.md` 规范自行执行 `git commit`。
2. 对齐 `.git/vibevalley-pr.md` 生成规范：
   - 引导帮工按 [scripts/commit-msg.ts](scripts/commit-msg.ts) 与 [scripts/regression.ts](scripts/regression.ts) 要求写出 `type(scope): summary` 英文标题，以及 `## What changed`、`## Checks`、`## Not verified`（触及回归测试时含 `## Regression`）正文段落。

### 步骤 5：补齐 GitHub CI 失败日志回传

1. 修改 [apps/server/src/ingress/github.ts](apps/server/src/ingress/github.ts) 的 `pollPullRequest`：
   - 当检测到 GitHub Check 结论为 `FAILURE` 时，除回传 Check 名称与 `detailsUrl` 外，若 URL 包含 GitHub Actions job ID，额外调用 `gh run view --job <id> --log-failed` 截取末尾关键报错行放入 `Trigger.text`，使帮工无需手动查日志即可直接定位修复。

### 步骤 6：隔离自举宿主进程与目标 `Space`

1. 运行自举服务端时，宿主进程从已安装的 VibeValley 桌面包或独立宿主目录启动，不直接从 `<space>/repos/vibevalley` 启动。
2. 将 VibeValley 仓库克隆至 `<space>/repos/vibevalley` 并加入 `github.prRepos`，走“工单切出 worktree → `.vibevalley/setup` → 帮工编码提交 → `.vibevalley/check` → `issue_pr_submit` → CI 轮询修单 → 合并回 `main`”完整闭环。

## Alternatives considered

- **把 SQLite 数据库、日志与模型凭据也塞进 `<space>`**：会让纯文本工作空间混入二进制运行时状态与密钥文件；保持 `home`（`~/.vibevalley`）管宿主运行时状态、`Space` 管 `{repos,worktrees,pkm}` 更清晰。
- **在单进程内给每张 SQLite 表加 `space_id` 列实现多租户**：当前桌面端与本地服务端每次聚焦一个工作空间，通过配置切换 `Space` 根目录即可完成硬隔离，不必在 10 余张业务表与全部 RPC 载荷中冗余透传 `space_id`。
- **继续让 `Repo.checkMerge` 自动代帮工提交残留改动**：自动生成的单行提交说明无法满足本仓 [scripts/commit-msg.ts](scripts/commit-msg.ts) 的多段落结构校验，退回帮工自行提交才能保证每次 commit 合规。

## Acceptance criteria

- `<space>` 根目录下固定生成并读写 `repos/*`、`worktrees/*` 与 `pkm/*`；`pkm.root` 未显式配置时默认指向 `<space>/pkm`。
- 在 `<space>/repos/vibevalley` 上启动工单时，`<space>/worktrees/vibevalley.<号>` 自动执行 `.vibevalley/setup` 完成依赖安装与包构建。
- 工单执行本地合并或提交 PR 时，`.vibevalley/check` 自动运行 `vp check --deny-warnings`、`vp run docs:verify` 与 `vp run primitives:verify`；残留未提交文件或门禁失败时自动退回帮工修复。
- GitHub PR 的 CI 失败或评审评论能通过 `Ingress.pollPullRequest` 自动唤醒对应工单帮工完成修复并更新 PR。
- `vp test` 与 `vp run docs:verify` 全部通过。

## Risks

- 旧本地开发目录中的 `~/vibevalley-dev/repos/*` 与 `~/.vibevalley/pkm/*` 在升级后不会自动搬移文件；需在设置页与启动日志中给出明确路径提示，由用户手动迁入 `<space>/repos` 与 `<space>/pkm`。
- 每个 `<space>/worktrees/vibevalley.<号>` 在执行 `.vibevalley/setup` 时会安装依赖并构建子包，若多个工单并发启动，耗时与磁盘占用会上升；后续可利用 pnpm 全局虚存硬链加速安装。
