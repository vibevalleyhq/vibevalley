# PR 与分支发布

`pull` 模块（`Pulls`）负责已有分支的远端 PR/MR 发布（`repo.pr.submit`）、开放 PR/MR 状态轮询（`refresh`）、GitHub PR 的 CI 检查与评审/评论轮询（`poll`），以及 `vv://github/...` 快照读取（`snapshot`）。独立发布的分支（`issue_id = null`）与关联工单的 PR 共用同一套 `pull` 与 `pull_event` 表。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 已有分支的检出预检、按 SHA 推送及 GitHub PR / GitLab.com MR 创建或复用（`publish`） | 仓库新建与克隆、工单 worktree 创建与本地合并、`gh` 登录与仓库写权限缓存（[仓库](docs/subsystems/repo.md)） |
| `pull` 与 `pull_event` 表持久化（`server.db`）、同步内存索引 `PullIndex`（按 `(repo, number)` 与 `issue_id` 读取） | 工单状态机、何时完成交付与路由规则（[工单](docs/subsystems/issue.md#完成和交付)） |
| 开放 PR/MR 状态轮询（`refresh`），关联工单的 PR 变为 `merged` 或 `closed` 时通知 `Board::settle_pull` 结清 | 帮工的工作目录在谁手里、会话交接与轨迹记录（[帮工](docs/subsystems/session.md)） |
| GitHub 开放 PR 的 GraphQL/REST 分页快照（`snapshot`）、失败 Actions job 日志提取、CI SHA-256 指纹比对与评审/评论轮询（`poll`） | `vv://github/...` 会话权限裁剪与分页缓存（[助手](docs/subsystems/orchestrator.md)、`crates/server/src/team/mcp/resource.rs`） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/server/src/work/pull/mod.rs` | `Pulls` 总入口：注册 `repo.pr.submit`、通过 `Board::use_pull_of_issue` 注入 `Issue.pull_request` 投影、驱动周期 `refresh` 与 `poll` |
| `crates/server/src/work/pull/store.rs` | `PullStore` 与同步内存索引 `PullIndex`：管理 `pull`、`pull_event` 读写并维护每张工单的当前 PR 投影 |
| `crates/server/src/work/pull/publish.rs` | `Publisher`：检出与远端校验、锁外 `.vibevalley/check`、按 `<SHA>:refs/heads/<branch>` 推送、GitHub（`gh`）与 GitLab.com（`glab`）查询和创建 |
| `crates/server/src/work/pull/snapshot.rs` | `Pulls::snapshot`：GitHub PR 检查、评审、评论与行内评审线程的 GraphQL/REST 分页快照、CI SHA-256 指纹与失败 Actions job 日志提取 |
| `crates/server/src/work/pull/poll.rs` | `Pulls::poll`：CI 指纹变化检测、跳过当前登录者自发评论，以及同轮机器人评审去重（`bot_round_key`、`bot_round`） |
| `crates/server/src/db/entities/work_pull.rs`、`crates/server/src/db/migration/` | 表 `pull`（`unique (repo, number)`、可空 `issue_id references issue(id) on delete set null`）与 `pull_event`（`pull_id references pull(id) on delete cascade`）的 SeaORM 实体与迁移 |
| `crates/server/src/team/mcp/resource.rs` | 将 `vv://github/<repo>/pulls/<n>`（及 `/checks`、`/reviews`、`/comments`）接入 `Pulls::snapshot` |

接口见 [capabilities.md](docs/reference/capabilities.md)（`repo.pr.submit`）。

## 模型和不变量

- **独立 PR 与工单 PR 同表存储**：`pull` 表按 `(repo, number)` 唯一，`issue_id` 可空（`on delete set null`）。`repo.pr.submit` 可在空间外检出上直接发布而不绑工单；若检出属于空间内仓库或其 worktree，自动归入对应仓库名，否则记远端 `<owner>/<repo>`。
- **工单关联通过窄回调同步投影**：`PullIndex` 维护每张工单的当前 PR（开放优先，其次按更新时间与编号）；`Pulls::open` 通过 `Board::use_pull_of_issue` 挂载投影回调，工单表不存 `pull_request` 列，工单模块不依赖平台 CLI 与轮询细节。
- **本机用户边界**：`repo.pr.submit` 的 `can` 仅含 `user`，HTTP 拒绝 Bearer 身份；助手和帮工工具不暴露此入口。
- **推送前校验与非破坏性发布**：按仓库共用 Git 目录串行，拒绝脏工作树、detached HEAD、分支或 SHA 不符、默认/base 分支、多远端、读写仓库不一致及 URL 重写配置；推送显式指定 URL 与 `<SHA>:refs/heads/<branch>`，不强推、不代写提交、不切分支。
- **完整快照与同轮评审归并**：`snapshot` 任一分页请求失败即放弃整次快照，不把残缺结果当成空列表；失败 Actions 检查带 job 链接时，用 `gh run view --job <id> --log-failed` 取末尾失败日志。同一次 Review 及其附带行内评论共享同一个 `bot_round_key`（只计一轮机器人评审），已收下的键写入 `pull_event`（`primary key (pull_id, key)`）。

## 怎么走

**发布已有分支（`Pulls::publish` / `repo.pr.submit`）**

1. 校验检出根目录、分支、完整 SHA、base、标题与远端主机（GitHub.com 用 `gh`，GitLab.com 用 `glab`）；`dryRun` 只读取检出与平台信息并返回 `check: "preview"`，不 fetch、不跑检查、不推送。
2. 正式发布先 fetch 目标分支、用 `merge-tree` 预检冲突，并在检出目录执行 `.vibevalley/check`（PATH 优先目标检出的 `node_modules/.bin`，移除宿主带入的其他检出工具路径；无脚本记 `not-run`）。
3. 复核工作树、HEAD、远端配置与 base SHA 未变后推送分支，查询或创建开放 PR/MR，并在 `pull` 表写入或更新记录；推送后平台失败明确说明 SHA 已推送但链接未确认，重试可查询已有请求。

**轮询状态与 GitHub 事件（`Pulls::refresh`、`Pulls::poll`）**

1. 开机后每 `github.pr_poll_seconds` 秒（默认 180 秒）运行 `refresh`：逐条查询 `pull` 表中 `open` 记录的远端状态；变为 `merged` 或 `closed` 时更新 `pull.state`，并通知关联工单执行 `Board::settle_pull` 或 `Board::refresh_issue`。
2. 随后运行 `poll`：对仍为 `open` 的 GitHub PR 拉取快照，按 SHA-256 计算 CI 指纹（`check_fingerprint`、`check_revision`）并在有失败或全绿时提取失败日志，对未收下且非当前登录者自发的评审与评论按 `bot_round_key` 去重写入 `pull_event`。

## 和谁打交道

- **仓库（`repo`）**：读空间内仓库列表以归属检出路径，与 `repos` 共用 `gh` 远端解析约定。
- **工单（`issue`）**：通过 `Board::use_pull_of_issue` 提供 `Issue.pull_request` 投影，状态变化与结清时调用 `Board::refresh_issue`、`Board::settle_pull`。
- **MCP 资源（`mcp`）**：`crates/server/src/team/mcp/resource.rs` 调用 `Pulls::snapshot` 为助手和帮工提供 `vv://github/<repo>/pulls/<n>`（及 `/checks`、`/reviews`、`/comments`）分页读取。

## 为什么这样

- **PR 独立成模块，工单表不存 GitHub 细节**：分支发布既服务工单，也服务本机独立分支（`issue_id = null`），并支持 GitLab.com 发布；把 `pull` 与 `pull_event` 独立成 `work/pull` 并通过回调挂载到 `Board`，使 `work/issue` 完全不依赖平台 CLI 与轮询实现。
- **`issue` 更新用 `ON CONFLICT DO UPDATE` 保护外键**：`pull.issue_id`（以及 `cron.issue_id`、`artifact.issue`）均带 `references issue(id) on delete set null`，工单表的 `PutIssue` 不使用 `INSERT OR REPLACE`（在 SQLite 中等价于删除后重建），避免每次更新工单时静默清空外键。

## 怎么验证

- `crates/server/tests/publish.rs`：发布已有分支的预览、推送、门禁拒绝、只许用户发布与 `pull` 持久化测试。
- `crates/server/src/work/pull/` 模块单元测试：`PullIndex` 同步投影、`refresh` 状态结清、`poll` CI 指纹与同轮机器人评审去重、`snapshot` 分页与失败日志提取。
