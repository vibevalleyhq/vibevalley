-- The ledger the progress is folded from, oldest first (game/ledger.ts). Ids are made in time order.

-- name: LedgerEntries :many
-- bound: every entry: progress is folded from the whole ledger, again under changed rules (a few a day).
select kind, at, payload from game_ledger order by id;

-- name: AddLedgerEntry :exec
insert into game_ledger (id, kind, at, payload) values (sqlc.arg(id), sqlc.arg(kind), sqlc.arg(at), sqlc.arg(payload));
