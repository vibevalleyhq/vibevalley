# Agent Note: 只有一份表结构，不认旧数据

Status: implemented

## Problem

服务端一路改名（heybro 到 vibevalley，`Helper` 到 `Worker`，`foreman` 到 `manager`，表名改单数），每改一次就多一段搬旧数据的代码：`vibevalley migrate` 搬旧名字下的家，`vibevalley import` 导 TypeScript 服务端的 PGlite，开机时把 `crew.json`、`foreman/`、旧的环境变量和旧的计划改成新名字，迁移一个接一个地改表名、改存着的值，重建表来改 `check`。这些代码只为了少数几份旧农场，却留在每次启动的路上；看表结构要把十几个迁移在脑子里叠起来，查询一半在 sqlc、一半是手写的字符串，表名单复数混着。项目还没有外部用户，这是把它们一次清掉的时候。

## Decision

- **不留兼容**：存盘的格式只有现在这一种。`vibevalley.db` 的表、家目录里的文件（`state.json`、`workers.json`、`manager/`、`activities/`）、环境变量（`VIBEVALLEY_MANAGER_*`）都只认现在的名字，没有读旧名字、改写旧文件、搬旧数据的代码。`internal/migrate`、`vibevalley migrate`、`vibevalley import` 和 `tool/dump-pglite.ts` 删了。改名就直接改代码和存盘的名字。
- **能迁就迁一次**（后来补的）：旧数据能在功能不变的前提下改成现在的样子的，迁一次，之后代码只认现在的样子。家目录的文件在服务加载时改好写回：`config.json` 里缺动物或衣服的档案，由 `agent/cast.go` 按客户端一直在用的同一个挑法补上（看起来和补之前一样），存档案时也补；客户端的 `castOf` 从此只给它不认识的档案（帮工的档案删了、档案还没读到）挑动物。改不成现在的样子的旧数据，仍然不读。
- **一份表结构**：`server/migrations/0001_schema.sql` 是整个库，按主人分段（田头、工单和执行、计划的经过、定时、账本、记性、连接器、院门）。以后改表是它后面的新文件（`go run ./cmd/migrate new 名字` 写出下一个），按名字顺序各跑一次：服务端开机时跑，也可以 `cmd/migrate up` 手动跑，`cmd/migrate status` 看库在第几版。跑的是 `migrations.Up`：跑之前把库留一份 `vibevalley.db.v<n>`，遇到 `user_version` 比它认识的迁移还多的库就不开，免得旧的服务端写坏新的库。`cmd/migrate` 只跑这些迁移文件。
- **表名用单数**，开关的列写 `boolean`。
- **SQL 只在 sqlc**：全部查询在 `server/pkg/db/queries/`，一张表一个文件（[查询由 sqlc 生成](2026-10-15-sqlc-queries.md)）；服务里不手写 SQL，只有 `base/db.go` 跑迁移。

## Alternatives considered

**照旧每次改名写一个迁移和一段搬文件的代码。** 有了外部用户以后就得这样，但现在付出的是每条启动路径上的分支和测试，换来的是几份可以重开的开发用农场。

**把迁移压成一份，但留着 `migrate`、`import`。** 两个命令只认 heybro、vibefarm 和 TypeScript 服务端留下的家，那些家已经搬完了；留着它们，代码里就一直有旧名字，`import` 还得跟着每次表结构的改动一起改。

**库是旧的就整个删掉重建。** 不用写迁移，但改表就丢掉田头、账本和记性；有了以后的迁移文件，重建只是第一次建库。

## Consequences

- 旧格式的家（旧名字的目录、旧的 `vibevalley.db`）打不开：`vibevalley.db` 的 `user_version` 对不上时服务端拒绝启动，要把家目录移走，从空的农场开始。开发时的农场就是这样重开的。
- 以后真有用户了，改存盘的名字要重新写迁移；那时在 `0001_schema.sql` 后面加文件，并把这篇换成新的决定。
- 看表结构只看一个文件，看一张表怎么读写只看同名的查询文件。

## Verification

- `internal/base/db_test.go`：新库按表结构建好、再开一次不重跑；`user_version` 比认识的多的库被拒绝。
- `sqlc diff` 没有差别；`go vet ./... && go test ./...` 通过。
