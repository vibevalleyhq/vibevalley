# Agent Note: 服务端的库从 PGlite 换成 SQLite，查询由仓库里的 SQLite 生成器写成代码

Status: implemented

## Problem

服务端的库是 PGlite（编成 WASM 的 Postgres，[地基](docs/subsystems/foundation.md)）：开机要加载几十 MB 的 wasm，新建一个库要跑一遍基线（内存里约 570 ms），测试为此留了一池清空复用的库和一套盯 DDL 的触发器；桌面版要带着 wasm。查询的类型由 effect-sqlc 读 Postgres 的表结构推出来，这是当初选 PGlite 的主要理由。

主人要换成 SQLite：Node 24 自带 `node:sqlite`，开一个库几毫秒，全文检索有自带的 FTS5，笔记（[笔记](docs/subsystems/pkm.md)）和记性的检索都能用它。缺的是从 SQL 生成带类型的查询代码：effect-sqlc 只认 Postgres。

## Decision

1. **生成器**：`apps/server/scripts/sqlite-generate.ts` 取代 effect-sqlc 和 `db-generate.ts`（任务名 `db:generate`、`db:check` 不变）。它在内存的 `node:sqlite` 里跑 `db/migrations/0001_schema.up.sql`，读出每张表的列（类型、`not null`、`check (x in (…))` 的取值），再逐条 prepare `db/queries/*.sql`，用 `StatementSync.columns()` 认出每个结果列来自哪张表的哪一列。输出和 effect-sqlc 同样形状的 `db/generated/<表>.sql.ts`（`XParams`、`XResult`、`XSql`、`Effect.fn` 的查询函数，`:one`、`:many`、`:exec`）和 `types.ts`（取值的字面量）；服务的代码照旧 `db.run(q.x(…))`。
2. **查询的写法**沿用 `sqlc.arg(name)`、`sqlc.narg(name)`，生成器换成 SQLite 的 `?N`（同名同号），写 `$N` 的报错。SQLite 推不出参数和算出来的列的类型，所以：
   - 参数的类型从上下文推：`列 = sqlc.arg(x)` 这类比较、`insert (列…) values (…)` 的位置、`set 列 = …`、`max`/`min`/`coalesce` 的另一边、`limit`/`offset`；推不出的写 `sqlc.arg(x)::int`。
   - 算出来的列写 `表达式::类型 as 名字`，可空的在类型后加 `?`（`::bool?`）；`::表.列` 照那一列的类型（左连接出来的写 `::session_run.started_at?`）。
   - 类型：`int`、`real`、`text`、`bool`、`json`，数组 `text[]`、`int[]`（编成 JSON 文本，查询里用 `json_each(…)` 展开）。布尔存 0 和 1，生成的 Schema 两头转（`SqliteBoolean`）。
   - 推不出、写错的，生成器报出哪个文件哪一条、怎么写，不生成。
3. **表结构**改写成 SQLite：枚举换成 `text` 加 `check (列 in (…))`，生成的类型仍是字面量；`double precision` 换 `real`；`jsonb` 换 `text`；`lateral` 改成相关子查询或 CTE。Postgres 的自增列和 `mailbox_order` 序列由触发器做（`channel_participant_seq`、`mailbox_trigger_seq`、`connector_inbound_seq`、`mailbox_delivery_position` 等）；`RETURNING` 看不到 AFTER 触发器写的值，所以要马上用的位置在 insert 里算出来。
4. **全文检索用 FTS5**：记性的 `memory_term`（外部内容表，由触发器跟着 `memory` 改，中文照旧由 gse 先切成词），按 `bm25` 排；笔记的 `pkm_term`（每页每块一行，`Pkm` 读文件时写，开机清空重建）。
5. **运行时**：`infra/db.ts` 用 `@effect/sql-sqlite-node`（`node:sqlite`，桌面壳的 Node 也带着它和 FTS5），文件在家目录 `db/vibevalley.db`，开着外键；新库在一个事务里跑基线。基线的 hash 记法和换了基线就把旧库挪到一边的规矩不变。内存库每个农场新开一个，删掉了清空复用的池和盯 DDL 的触发器。

## Alternatives considered

- **给 effect-sqlc 加一个 SQLite 引擎。** 和 Postgres 共用切分、命名和 Schema 的生成，但要改另一个仓库；主人选了在这个仓库里单独写。
- **继续用 PGlite，笔记的检索放进 `tsvector`。** 改动最小，但留着 wasm 的开机和测试成本，也用不上 FTS5。
- **手写查询代码，不生成。** 两百多条查询，参数和结果的 Schema 手写会和 SQL 漂开；生成器加检查才挡得住。

## Consequences

- 参数类型推错不会被库拦下（SQLite 不校验类型）：生成器推不出就报错，不猜；`schema.test.ts` 和各模块的测试兜底。
- 写库快了以后，读「交了没看」这类中间状态的测试抓不到那一刻：测试改成比时间或让扮演的帮工按真的时机读输入，不靠库慢（[契约按概念分](.agents/notes/implemented/architecture/2026-11-04-contract-by-concept.md)）。
- 测试里看重试次数不能再读 Postgres 的序列，改读日志（`src/testing/refuse.ts` 的 `heard`）。

## Verification

- `vp run server:check`、`vp run web:check`、`vp run docs:verify`、`vp run deadcode` 通过；`db:check` 查生成的代码是最新的。生成的代码和原来 effect-sqlc 写的逐个字段比过。
- `apps/server/package.json` 不再依赖 `@electric-sql/pglite`、`@effect/sql-pglite`。
- 在隔开的服务端上试过记性的检索（FTS5 的分数）和笔记的检索（中英文的词都按 `bm25` 排出来）。
