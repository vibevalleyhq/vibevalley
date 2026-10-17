# Agent Note: 表按模块命名

Status: implemented

## Problem

一个库里有 16 个领域模块的表，表名是一个全局的命名空间。原来的表名只是概念：`message`、`participant`、`run`、`ledger`、`delivery`。频道模块占了 `message`，以后通知、连接器、artifact 要「消息」「投递」时就没有名字可用；`delivery` 就是这样，2026-10-17 改成了 `message_delivery`，主人指出它会和 artifact 的投递撞。`lan_gate`、`lan_device` 用的是旧的名字 lan，模块已经叫 gate。索引名也是全局的，跟着表名走。

## Decision

- 表名是 `<模块>` 或 `<模块>_<概念>`，单数；模块是拥有这张表的 `server/internal` 包。模块的主表可以就叫模块名（`issue`、`schedule`、`memory`、`gate`）。
- 索引名以它的表名开头：`channel_message_by_sender`。
- 一张表的查询在 `pkg/db/queries/<表>.sql`。
- 迁移 `0004_tables_by_module.sql` 改了 12 张表：频道的 8 张加 `channel_` 前缀（`message_delivery` 成了 `channel_delivery`），`run` 是 `session_run`，`ledger` 是 `game_ledger`，`lan_gate`、`lan_device` 是 `gate`、`gate_device`；它们的索引照原样重建，换上新名字。
- 检查：`migrations/names_test.go` 跑完全部迁移，查每张表的前缀是一个领域模块（不含 `base`、`handler`、`protocol`、`workspace`、`mcp` 和测试工具）、每个索引以表名开头、每张表有自己的查询文件。加一张不合的表，`go test ./...` 失败。

## Alternatives considered

**只在撞上时改名。** `delivery` 就是这样被发现的；每次撞上都要一个迁移，还要先有人发现。

**每个模块一个 SQLite 库。** 名字彻底分开，但跨模块的外键（`issue_session` → `issue`、频道消息 → 参与者）和一个事务里写两个模块的表都没了。

## Consequences

- sqlc 生成的类型跟着表名：`generated.ChannelMessage`、`generated.SessionRun`。
- 写裸 SQL 的测试要用新表名。

## Verification

- `go test ./migrations/`：命名检查；临时加一张 `widget` 表和索引 `by_id`，三条都报出来。
- `migrations_test.go`：带旧数据的库迁到最新，行和外键都在。
