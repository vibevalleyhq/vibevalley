-- name: ReadSeqCounter :one
SELECT last_number FROM seq_counter WHERE name = ?1;

-- name: WriteSeqCounter :exec
INSERT INTO seq_counter (name, last_number) VALUES (?1, ?2)
ON CONFLICT(name) DO UPDATE SET last_number = excluded.last_number;
