# Agent Note: 查询由 sqlc 生成

Status: implemented

## Problem

Go 服务端的 SQL 都是手写在服务里的字符串（像当时的 `channel/db.go`，和待办的 `backlog.go`，待办并进工单以后删了），列和 Go 字段靠手对，表改了编译器不知道。TypeScript 时期用过 effect-sqlc，主人以为现在还在用 sqlc。工单变成一样东西（[工单是一样东西](2026-10-15-issue-is-one-thing.md)）要新写一批查询，是改过来的时机。

## Decision

- **查询写成 `.sql`，由 sqlc 生成 Go**：查询在 `server/pkg/db/queries/*.sql`，生成的包是 `server/pkg/db/generated`（包名 `generated`），配置在 `server/sqlc.yaml`。生成的不手改。
- **一张表一个文件**：`queries/` 里每个文件以它的表命名（`issue.sql`、`message.sql`、`delivery.sql`……），只放主要读写这张表的查询，生成的 `generated/<表>.sql.go` 也就一张表一个；跨表的联查放在它返回的那张表的文件里（田头的「未读」在 `conversation.sql`）。服务里不手写 SQL，服务自己的包只把生成的行读成它的形状（像 `channel/db.go`）。
- **表结构就是迁移**：sqlc 读 `server/migrations/*.sql` 当表结构，所以不另写一份 schema。迁移在 `server/migrations`（一个只为了嵌进程序的小包 `vibevalley/migrations`），服务端启动时按名字顺序跑；现在只有一个 `0001_schema.sql`（[只有一份表结构，不认旧数据](2026-10-16-one-schema-no-old-data.md)）。开关的列写 `boolean`，生成的 Go 就是 `bool`。
- **用 go1.27 跑**：`cd server && GOTOOLCHAIN=go1.27.2 go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate`。sqlc 不进 `go.mod`，版本钉在命令里。

## Alternatives considered

**继续手写。** 少一个工具，但字段对不上要到运行时才知道，表名改单数时也得逐个找字符串。

**按服务分文件（`channel.sql` 一个放田头的全部）。** 和 Go 的包对得上，但一张表被几个服务读写时没有一个家，改一张表要翻好几个文件；按表分，改表结构时要看的查询就在同名的文件里。

**ORM（gorm、ent）。** 要另写一套模型、迁移也想自己管；我们的查询不多，用 SQL 写得更直接。

**sqlc 进 `go.mod` 的 tool 依赖。** 会把 sqlc 的一大串依赖拉进服务端模块；只在改查询时跑一次，用 `go run …@版本` 就够了。

## Consequences

- 改了查询或迁移，要跑一次 sqlc；生成的代码进仓库，平时构建不需要它。
- 看表结构去 `server/migrations`，看某张表被怎么读写去 `queries/<表>.sql`。
- sqlc 推不出类型的表达式（`coalesce`、`max` 这类）要写 `cast(… as integer)`；可能为空的算出来的列写成 `coalesce(…, '')`，读的一边把空串当没有。
