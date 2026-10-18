# Agent Note: 只有一份表结构，不认旧数据

Status: implemented

## Problem

服务端一路改名（heybro 到 vibevalley，`Helper` 到 `Worker`，`foreman` 到 `manager`，表名改单数），每改一次就多一段搬旧数据的代码：`vibevalley migrate` 搬旧名字下的家，`vibevalley import` 导 TypeScript 服务端的 PGlite，开机时把 `crew.json`、`foreman/`、旧的环境变量和旧的计划改成新名字，迁移一个接一个地改表名、改存着的值，重建表来改 `check`。这些代码只为了少数几份旧农场，却留在每次启动的路上；看表结构要把十几个迁移在脑子里叠起来，查询一半在 sqlc、一半是手写的字符串，表名单复数混着。项目还没有外部用户，这是把它们一次清掉的时候。

## Decision

- **不留兼容，架构成形期不为兼容放慢**：存盘的格式只有现在这一种。`vibevalley.db` 的表、家目录里的文件（`state.json`、`workers.json`、`manager/`、`activities/`）、环境变量（`VIBEVALLEY_MANAGER_*`）都只认现在的名字，没有读旧名字、改写旧文件、搬旧数据的代码。`internal/migrate`、`vibevalley migrate`、`vibevalley import` 和 `tool/dump-pglite.ts` 删了。改名就直接改代码和存盘的名字。
- **不搬旧数据**：改了存盘的格式，旧数据作废：本机的 `vibevalley.db` 和家目录里的旧文件删掉重建，不写导入器、不写迁移里的数据搬运，启动时只认今天的名字。2026-10-18 主人定的：架构还在成形，搬数据的代码会让每一步都更小心、更慢。以前 TypeScript 的农场用 `server/tool/import-ts` 跑过一次导入、Go 时代的旧家也搬过一次（[一次性迁移](2026-10-17-one-way-migration.md)），那是这条之前的事。
- **一份表结构，就地改**：`server/migrations/0001_schema.sql` 是整个库，按主人分段（田头、工单和执行、任务的经过、定时、账本、记性、连接器、院门）。改表直接改它，不另加迁移；`migrations` 的 `TestTheSchemaIsOneBaseline` 查这个目录只有它一个 `.sql`。2026-10-18 把当时的 `0002`–`0006` 并了进来，`cmd/migrate new` 删了。服务端开机时跑 `migrations.Up`，也可以 `cmd/migrate up` 手动跑，`cmd/migrate status` 看库在第几版；遇到 `user_version` 比它认识的迁移还多的库就不开（旧库就是这样作废的）。`Up` 升级前留备份、失败回滚这条路径，测试换一套自己的迁移（`migrations.FS` 是可换的 `fs.FS`）来测。
- **迁移只接数据库连接**：`Up(db)` 从实际 SQLite `main` 识别文件，备份、版本和迁移固定在同一连接；不让启动入口与命令行各自保证 `db` 和另一个路径参数指向同一份数据。具体约定见 [migrations](../../../../server/migrations/README.md)。
- **表名用单数**，开关的列写 `boolean`。
- **SQL 只在 sqlc**：全部查询在 `server/pkg/db/queries/`，一张表一个文件（[查询由 sqlc 生成](2026-10-15-sqlc-queries.md)）；服务里不手写 SQL，只有 `base/db.go` 跑迁移。

## Alternatives considered

**照旧每次改名写一个迁移和一段搬文件的代码。** 有了外部用户以后就得这样，但现在付出的是每条启动路径上的分支和测试，换来的是几份可以重开的开发用农场。

**改表写迁移、搬数据只跑一次（这条的上一版）。** 比长期兜底好，但每次改名仍要写重建表、改 `check`、改存下的取值的 SQL，还要测它；2026-10-18 把种植计划改成 Task 时，光是搬数据的迁移就要重建四张表。架构还在变，这份成本不值得，改成作废重建。

**把迁移压成一份，但留着 `migrate`、`import`。** 两个命令只认 heybro、vibefarm 和 TypeScript 服务端留下的家，那些家已经搬完了；留着它们，代码里就一直有旧名字，`import` 还得跟着每次表结构的改动一起改。

**库是旧的就整个删掉重建。** 不用写迁移，但改表就丢掉田头、账本和记性；有了以后的迁移文件，重建只是第一次建库。

**保留 `Up(db, path)`。** 看起来只多一个字符串，实际要求每个调用者保证备份目标与连接数据源一致；URI 内存库、转义路径和工作目录变化会把这份配对知识继续散在入口。SQLite 已经知道实际主库身份，迁移直接使用它。

## Consequences

- 旧格式的家（旧名字的目录、旧的 `vibevalley.db`）打不开，除非先用一次性导入器搬成今天的形状；搬不了的把家目录移走，从空的农场开始。
- 以后真有用户了，改存盘的名字要重新写迁移；那时在 `0001_schema.sql` 后面加文件，并把这篇换成新的决定。
- 看表结构只看一个文件，看一张表怎么读写只看同名的查询文件。

## Verification

- `internal/base/db_test.go`：新库按表结构建好、再开一次不重跑；`user_version` 比认识的多的库被拒绝。
- `sqlc diff` 没有差别；`go vet ./... && go test ./...` 通过。
