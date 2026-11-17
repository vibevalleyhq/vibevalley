-- name: ListLedgerPayloads :many
SELECT payload_json
FROM game_ledger
ORDER BY seq ASC;

-- name: InsertLedgerEntry :exec
INSERT INTO game_ledger (seq, kind, payload_json, created_at_ms)
VALUES (?, ?, ?, ?);
