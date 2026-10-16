# Agent Note: 查询由 sqlc 生成

Status: implemented

## Problem

Go 服务端的 SQL 都是手写在服务里的字符串（`chat/db.go`、`backlog.go`……），列和 Go 字段靠手对，表改了编译器不知道。TypeScript 时期用过 effect-sqlc，主人以为现在还在用 sqlc。工单变成一样东西（[工单是一样东西](2026-10-15-issue-is-one-thing.md)）要新写一批查询，是改过来的时机。

## Decision

- **查询写成 `.sql`，由 sqlc 生成 Go**：查询在 `server/pkg/db/queries/*.sql`，生成的包是 `server/pkg/db/generated`（包名 `generated`），配置在 `server/sqlc.yaml`。生成的不手改。
- **表结构就是迁移**：sqlc 读 `server/migrations/*.sql` 当表结构，所以不另写一份 schema。迁移也挪到了 `server/migrations`（一个只为了嵌进程序的小包 `vibevalley/migrations`），服务端启动时按名字顺序跑。
- **用 go1.27 跑**：`cd server && GOTOOLCHAIN=go1.27.2 go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate`。sqlc 不进 `go.mod`，版本钉在命令里。
- **新查询用 sqlc，老的碰到再搬**：目前只有工单（`issue.sql`）。田头、账本、记性这些老表和它们手写的查询，改到的时候连同表名改成单数一起搬过来。

## Alternatives considered

**继续手写。** 少一个工具，但字段对不上要到运行时才知道，表名改单数时也得逐个找字符串。

**ORM（gorm、ent）。** 要另写一套模型、迁移也想自己管；我们的查询不多，用 SQL 写得更直接。

**sqlc 进 `go.mod` 的 tool 依赖。** 会把 sqlc 的一大串依赖拉进服务端模块；只在改查询时跑一次，用 `go run …@版本` 就够了。

## Consequences

- 改了查询或迁移，要跑一次 sqlc；生成的代码进仓库，平时构建不需要它。
- 在过渡期，有的表用 sqlc，有的还是手写查询。
- 迁移不在 `internal/farm` 里了，看表结构去 `server/migrations`。
