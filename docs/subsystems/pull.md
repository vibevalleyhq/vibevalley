# PR 与分支发布

`pull` 模块（`Pull`）负责已有分支的远端 PR/MR 发布（`repo.pr.submit`）、开放 PR/MR 状态轮询（`refresh`）、GitHub PR 的 CI 检查与评审/评论轮询（`poll`），以及 `vv://github/...` 快照读取（`snapshot`）。独立发布的分支（`issue_id = null`）与关联工单的 PR 共用同一张 `pull` 表。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 已有分支的检出预检、按 SHA 推送及 GitHub PR / GitLab.com MR 创建或复用（`publish`） | 仓库新建与克隆、工单 worktree 创建与本地合并、`gh` 登录与仓库写权限缓存（[仓库](docs/subsystems/repo.md)） |
| `pull` 表持久化（含 `known_events` JSON 列），由 `ctx.service.issue` 按 `(repo, number)` 与 `issue_id` 直接索引读取 | 工单状态机、何时完成交付与路由规则（[工单](docs/subsystems/issue.md#完成和交付)） |
| 开放 PR/MR 状态轮询（`refresh`），关联工单的 PR 变为 `merged` 或 `closed` 时自动清空 `known_events` 并通知 `Board::settle_pull_async` 结清 | 帮工的工作目录在谁手里、会话交接与轨迹记录（[帮工](docs/subsystems/session.md)） |
| GitHub 开放 PR 的 GraphQL/REST 分页快照（`snapshot`）、失败 Actions job 日志提取、CI SHA-256 指纹比对与评审/评论轮询（`poll`） | `vv://github/...` 会话权限裁剪与分页缓存（[助手](docs/subsystems/orchestrator.md)、`crates/server/src/agent/mcp/resource.rs`） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/server/src/issue/pull/mod.rs` | `Pull` 模块入口：导出 `Pull`、`publish`、`poll`、`snapshot` |
| `crates/server/src/service/issue.rs` | `IssueService`（PR 查询与落库）：管理 `pull` 与 `pull.known_events` 读写并提供 `prefers_pull_for_issue` 与按工单批量映射 `pulls_by_issue_map` |
| `crates/server/src/repo/publish.rs` | `Publisher`：检出与远端校验、锁外 `.vibevalley/check`、按 `<SHA>:refs/heads/<branch>` 推送、GitHub（`gh`）与 GitLab.com（`glab`）查询和创建 |
| `crates/server/src/issue/pull/snapshot.rs` | `Pull::snapshot_async`：GitHub PR 检查、评审、评论与行内评审线程的 GraphQL/REST 分页快照、CI SHA-256 指纹与失败 Actions job 日志提取 |
| `crates/server/src/issue/pull/poll.rs` | `Pull` 轮询：CI 指纹变化检测、跳过当前登录者自发评论，以及同轮机器人评审去重（`bot_round_key`、`bot_round`） |
| `crates/server/src/db/entity/pull.rs`、`crates/server/src/db/migration/` | 表 `pull`（`unique (repo, number)`、可空 `issue_id references issue(id) on delete set null`、索引 `pull_by_issue` 与 `known_events` JSON 列）的 SeaORM 实体与迁移 |
| `crates/server/src/agent/mcp/resource.rs` | 将 `vv://github/<repo>/pulls/<n>`（及 `/checks`、`/reviews`、`/comments`）接入 `Pull::snapshot_async` |

接口见 [capabilities.md](docs/reference/capabilities.md)（`repo.pr.submit`）。

## 模型和不变量

- **独立 PR 与工单 PR 同表存储**：`pull` 表按 `(repo, number)` 唯一，`issue_id` 可空（`on delete set null`）。`repo.pr.submit` 可在空间外检出上直接发布而不绑工单；若检出属于空间内仓库或其 worktree，自动归入对应仓库名，否则记远端 `<owner>/<repo>`。
- **工单关联按需经 `ctx.service.issue` 投影**：`prefers_pull_for_issue` 选出每张工单的主 PR（开放优先，其次按更新时间与编号）；切片投影与 `orchestration/issue.rs` 通过 `pulls_by_issue_map` 单批查出，工单表不存 `pull_request` 列，工单模块不依赖平台 CLI 与轮询细节。
- **本机用户边界**：`repo.pr.submit` 的 `can` 仅含 `user`，HTTP 拒绝 Bearer 身份；助手和帮工工具不暴露此入口。
- **推送前校验与非破坏性发布**：按仓库共用 Git 目录串行，拒绝脏工作树、detached HEAD、分支或 SHA 不符、默认/base 分支、多远端、读写仓库不一致及 URL 重写配置；推送显式指定 URL 与 `<SHA>:refs/heads/<branch>`，不强推、不代写提交、不切分支。
- **完整快照与同轮评审归并**：`snapshot` 任一分页请求失败即放弃整次快照，不把残缺结果当成空列表；失败 Actions 检查带 job 链接时，用 `gh run view --job <id> --log-failed` 取末尾失败日志。同一次 Review 及其附带行内评论共享同一个 `bot_round_key`（只计一轮机器人评审），已收下的键写入 `pull.known_events` JSON 数组，并在 PR 转为 `merged` 或 `closed` 时自动清空。

## 怎么走

**发布已有分支（`Pull::publish_async` / `repo.pr.submit`）**

1. 校验检出根目录、分支、完整 SHA、base、标题与远端主机（GitHub.com 用 `gh`，GitLab.com 用 `glab`）；`dryRun` 只读取检出与平台信息并返回 `check: "preview"`，不 fetch、不跑检查、不推送。
2. 正式发布先 fetch 目标分支、用 `merge-tree` 预检冲突，并在检出目录执行 `.vibevalley/check`（PATH 优先目标检出的 `node_modules/.bin`，移除宿主带入的其他检出工具路径；无脚本记 `not-run`）。
3. 复核工作树、HEAD、远端配置与 base SHA 未变后推送分支，查询或创建开放 PR/MR，并在 `pull` 表写入或更新记录；推送后平台失败明确说明 SHA 已推送但链接未确认，重试可查询已有请求。

**轮询状态与 GitHub 事件（`refresh`、`poll`）**

1. 开机后每 `github.pr_poll_seconds` 秒（默认 180 秒）运行 `refresh`：逐条查询 `pull` 表中 `open` 记录的远端状态；变为 `merged` 或 `closed` 时更新 `pull.state` 并清空 `known_events`，同时通知关联工单执行 `Board::settle_pull_async`。
2. 随后运行 `poll`：对仍为 `open` 的 GitHub PR 拉取快照，按 SHA-256 计算 CI 指纹（`check_fingerprint`、`check_revision`）并在有失败或全绿时提取失败日志，对未收下且非当前登录者自发的评审与评论按 `bot_round_key` 去重写入 `pull.known_events`。

## 和谁打交道

- **仓库（`repo`）**：读空间内仓库列表以归属检出路径，与 `repos` 共用 `gh` 远端解析约定。
- **工单（`issue`）**：切片投影与 `orchestration/issue.rs` 通过 `pulls_by_issue_map` / `Pull::of_issue_async` 填充 `Issue.pull_request`，状态变化与结清时调用 `Board::refresh_issue_async`、`Board::settle_pull_async`。
- **MCP 资源（`mcp`）**：`crates/server/src/agent/mcp/resource.rs` 调用 `Pull::snapshot_async` 为助手和帮工提供 `vv://github/<repo>/pulls/<n>`（及 `/checks`、`/reviews`、`/comments`）分页读取。

## 为什么这样

- **PR 独立成模块，工单表不存 GitHub 细节**：分支发布既服务工单，也服务本机独立分支（`issue_id = null`），并支持 GitLab.com 发布；把 `pull` 独立成 `issue/pull` 并直接落库 `known_events`，使 `issue/` 不依赖平台 CLI 与轮询实现，也省去额外从表。
- **`issue` 更新用 `ON CONFLICT DO UPDATE` 保护外键**：`pull.issue_id`（以及 `cron.issue_id`、`note.issue`）均带 `references issue(id) on delete set null`，工单表的 `PutIssue` 不使用 `INSERT OR REPLACE`（在 SQLite 中等价于删除后重建），避免每次更新工单时静默清空外键。

## 怎么验证

- `crates/server/tests/publish.rs`：发布已有分支的预览、推送、门禁拒绝、只许用户发布与 `pull` 持久化测试。
- `crates/server/src/issue/pull/tests.rs`：主 PR 排名（`best_pull_for_issue`）、`refresh` 状态结清与 `known_events` 清空、`poll` CI 指纹与同轮机器人评审去重、`snapshot` 分页与失败日志提取。
