-- The ledger the progress is folded from, oldest first (game/ledger.go).

-- name: LedgerEntries :many
select kind, at, payload from game_ledger order by seq;

-- name: AddLedgerEntry :exec
insert into game_ledger (kind, at, payload) values (?, ?, ?);

