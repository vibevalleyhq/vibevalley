-- name: PutEnvelope :exec
INSERT INTO vault_secret (
	id, kind, name, target_hosts_json, provider,
	envelope_version, root_key_id, wrapped_dek_nonce, wrapped_dek,
	payload_nonce, ciphertext, expires_at_ms, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
	kind = EXCLUDED.kind,
	name = EXCLUDED.name,
	target_hosts_json = EXCLUDED.target_hosts_json,
	provider = EXCLUDED.provider,
	envelope_version = EXCLUDED.envelope_version,
	root_key_id = EXCLUDED.root_key_id,
	wrapped_dek_nonce = EXCLUDED.wrapped_dek_nonce,
	wrapped_dek = EXCLUDED.wrapped_dek,
	payload_nonce = EXCLUDED.payload_nonce,
	ciphertext = EXCLUDED.ciphertext,
	expires_at_ms = EXCLUDED.expires_at_ms,
	updated_at_ms = EXCLUDED.updated_at_ms;

-- name: GetEnvelope :one
SELECT
	id, kind, name, target_hosts_json, provider,
	envelope_version, root_key_id, wrapped_dek_nonce, wrapped_dek,
	payload_nonce, ciphertext, expires_at_ms, created_at_ms, updated_at_ms
FROM vault_secret
WHERE id = ?;

-- name: GetEnvelopeByName :one
SELECT
	id, kind, name, target_hosts_json, provider,
	envelope_version, root_key_id, wrapped_dek_nonce, wrapped_dek,
	payload_nonce, ciphertext, expires_at_ms, created_at_ms, updated_at_ms
FROM vault_secret
WHERE kind = ? AND name = ?
ORDER BY created_at_ms ASC, id ASC
LIMIT 1;

-- name: ListEnvelopes :many
SELECT
	id, kind, name, target_hosts_json, provider,
	envelope_version, root_key_id, wrapped_dek_nonce, wrapped_dek,
	payload_nonce, ciphertext, expires_at_ms, created_at_ms, updated_at_ms
FROM vault_secret
ORDER BY created_at_ms ASC, id ASC;

-- name: DeleteEnvelope :execrows
DELETE FROM vault_secret WHERE id = ?;

-- name: DeleteAllEnvelopes :exec
DELETE FROM vault_secret;
