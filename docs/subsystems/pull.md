# PR 与分支发布

`pull` 模块（`Pull`）负责已有分支与工单分支的远端 PR/MR 发布、状态轮询，以及 GitHub PR 的 CI 检查、评审与评论跟进。独立发布的分支（`repo.pr.submit`，`issue_id = null`）与绑定工单的 PR 共用同一套 `pull` 表与轮询回路。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 已有分支与工单分支的预检、按 SHA 推送及 GitHub PR / GitLab.com MR 创建或复用 | 仓库新建与克隆、工单 worktree 创建与本地合并、`gh` 登录与仓库写权限缓存（[仓库](docs/subsystems/repo.md)） |
| `pull` 与 `pull_event` 表持久化、内存 `PullIndex`（按 `(repo, number)` 与 `issue_id` 同步读取） | 工单状态机、何时完成交付、蓄水池与路由规则（[工单](docs/subsystems/issue.md#完成和交付)） |
| 开放 PR/MR 状态轮询（`refresh`），关联工单合入或关闭时协调工作区收尾与工单结清 | 帮工的工作目录在谁手里、会话交接与唤醒投递（[帮工](docs/subsystems/session.md)） |
| GitHub 开放 PR 的 GraphQL/REST 分页快照（`snapshot`）、失败 Actions 日志提取（`failedJobLog`）、CI 指纹比对与评审/评论触发（`poll`） | `vv://github/...` 会话权限裁剪与分页缓存（[助手](docs/subsystems/orchestrator.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/modules/pull/pull.ts` | 对外 `Pull` 服务：分支发布、工单提 PR（`submitForIssue`）、状态查询、快照与失败日志、周期 `refresh` 与 `poll`，并向 `Issue.usePull` 注册 `IssuePullPort` |
| `apps/server/src/modules/pull/store.ts` | `makePullStore` 与内存 `PullIndex`：写操作在 `db.afterCommit` 同步内存索引，`ofIssue` 与 `find` 同步读取已提交状态 |
| `apps/server/src/modules/pull/publish.ts`、`hosting.ts` | 检出与远端校验、锁外 `.vibevalley/check`、按 `<SHA>:refs/heads/<branch>` 推送、GitHub（`gh`）与 GitLab.com（`glab`）远端查询和创建 |
| `apps/server/src/modules/pull/pullSnapshot.ts` | GitHub PR 检查、评审、评论与行内评审线程的 GraphQL/REST 分页快照，以及失败 Actions job 日志提取 |
| 表 `pull`、`pull_event` | PR/MR 记录（`platform`、`repo`、`number`、`state`、可空 `issue_id`、`check_fingerprint`、`check_revision`）与已收下的评审/评论键及机器人轮次 |

接口见 [capabilities.md](docs/reference/capabilities.md)（`repo.pr.submit`）。

## 模型和不变量

- **独立 PR 与工单 PR 同表存储**：`pull` 表按 `(repo, number)` 唯一，`issue_id` 可空（`on delete set null`）。`repo.pr.submit` 可在空间外检出上直接发布而不绑工单；若检出属于空间内仓库或其 worktree，自动归入对应仓库名，否则记远端 `<owner>/<repo>`。
- **工单关联通过窄端口同步投影**：`PullIndex` 在 `db.afterCommit` 维护每张工单的当前 PR（开放优先，其次按更新时间与编号）；`Pull` 启动时经 `Issue.usePull` 注入 `usesPullRequests`、`ofIssue` 与 `submitForIssue`，工单模块不持有 GitHub 逻辑或 PR 列。
- **本机用户边界**：`repo.pr.submit` 的 `can` 仅含 `user`，HTTP 拒绝 Bearer 身份；远程设备、助手和帮工工具不暴露此入口。
- **推送前校验与非破坏性发布**：按仓库共用 Git 目录串行（`Repo.serially`），拒绝脏工作树、detached HEAD、分支或 SHA 不符、默认/base 分支、多远端、读写仓库不一致及 URL 重写配置；推送显式指定 URL 与 `<SHA>:refs/heads/<branch>`，不强推、不代写提交、不切分支。
- **完整快照与同轮评审归并**：`snapshot` 任一分页请求失败即放弃整次快照，不把残缺结果当成空列表；失败 Actions 检查带 job 链接时，用 `gh run view --job <id> --log-failed` 取末尾 40 行。同一次 Review 及其附带行内评论共享同一个 `bot_round_key`（只计一轮机器人评审），触发器与 `pull` / `pull_event` 游标在同一事务落库。

## 怎么走

**发布分支（`Pull.publish` / `repo.pr.submit`）**

1. 校验检出根目录、分支、完整 SHA、base、标题与远端主机（GitHub.com 用 `gh`，GitLab.com 用 `glab`）；`dryRun` 只读取检出与平台信息并返回 `check: "preview"`。
2. 正式发布先 fetch 目标分支、用 `merge-tree` 预检冲突，并在检出目录执行 `.vibevalley/check`（PATH 优先目标检出的 `node_modules/.bin`，移除宿主带入的其他检出工具路径；无脚本记 `not-run`）。
3. 复核工作树、HEAD、远端配置与 base SHA 未变后推送分支，查询或创建开放 PR/MR，在 `pull` 表写入或更新记录。工单入口（`submitForIssue`）额外校验 `vibevalley/issue-<号>` 分支、读取 Git 目录内的 `vibevalley-pr.md`，并在工单串发送去重交付通知、为 GitHub PR 订阅 `github:<repo>#<n>`。

**轮询状态与 GitHub 事件（`Pull.refresh`、`Pull.poll`）**

1. 开机后每 `github.pr_poll_seconds` 秒（默认 180 秒）先跑 `refresh`：逐条查询 `pull` 表中 `open` 记录的远端状态。变为 `merged` 或 `closed` 时，若关联工单以该 PR 收尾（`finishesWithPullRequest`），在场帮工经 `Session.handOver` 交接并调 `Repo.finishPullRequest` 清理检出，随后在同一事务内更新 `pull.state` 与 `Issue.settlePull`；否则仅更新 `pull.state` 并刷新工单投影。
2. 再跑 `poll`：对仍为 `open` 的 GitHub PR 拉取快照。CI 指纹变化且存在失败或全部跑完时，同事务写入 `session_trigger` 与新 `check_fingerprint` / `check_revision`；未收下且非当前登录者自发的评审与评论，同事务写入 `session_trigger` 与 `pull_event`（计算 `botRound`），提交后交 `Issue.route` 进订阅工单的蓄水池。无关联工单且无订阅者时仅推进游标，不产生悬空触发。

## 和谁打交道

- **仓库（`repo`）**：读 `root`、`list`、`usesPullRequests`，借 `serially` 串行访问 Git 目录，PR 结清时调 `finishPullRequest` 清理工单 worktree 与分支。
- **工单（`issue`）**：经 `usePull` 提供 `IssuePullPort`，读 `find`、`onBoard`、`subscribed`，订阅 `github:<repo>#<n>`（`subscribe`），状态变更与结清调 `refreshPull`、`settlePull`，CI 与评审触发交 `route`。
- **帮工与频道（`session`、`channel`）**：同事务调用 `Session.recordTrigger`，PR 结清时调 `live` 与 `handOver`；工单提 PR 后经 `Channel.openThreadAbout` 与 `notice` 发送串内卡片。
- **网关与工具（`gateway/http`、`gateway/tool`）**：HTTP `repo.pr.submit` 调 `Pull.publish`；`tool/resource.ts` 调 `Pull.snapshot` 读取 `vv://github/<repo>/pulls/<n>` 快照。

## 为什么这样

- **PR 独立成模块，工单表不存 GitHub 细节**：分支发布既服务工单，也服务本机独立分支（`issue_id = null`），并支持 GitLab.com 发布；把 `pull` 与 `pull_event` 从 `issue` 拆出并通过窄端口反向挂载，使 `issue` 模块完全不依赖平台 CLI 与轮询细节。
- **游标与触发同事务提交**：`check_fingerprint` 或 `pull_event` 与 `session_trigger` 在同一事务写入；中途失败一并回滚，重启后未路由的触发由 `Issue` 重放，不会漏投或重复计入机器人评审轮次。

## 怎么验证

- `apps/server/src/modules/pull/pull.test.ts`、`publish.test.ts`、`hosting.test.ts`：内存索引与事务回滚、CI 指纹与评审同轮归并、独立 PR 游标推进、分支发布门禁与 GitHub/GitLab 适配测试。
- `apps/server/src/flows/pull_request.test.ts`、`apps/server/src/flows/pr-follow.test.ts`、`apps/server/src/flows/parent-pr.test.ts`：工单提 PR、CI/评审回流与合入结清全流程测试。
