-- The ledger the progress is folded from, oldest first (game/ledger.go).

-- name: LedgerEntries :many
select kind, at, payload from ledger order by seq;

-- name: AddLedgerEntry :exec
insert into ledger (kind, at, payload) values (?, ?, ?);

-- name: CountLedgerKind :one
select count(*) from ledger where kind = ?;
