CREATE TABLE IF NOT EXISTS vault_secret (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('provider_api_key', 'git_credential', 'mcp_oauth_token')),
	name TEXT NOT NULL,
	target_hosts_json TEXT NOT NULL,
	provider TEXT NOT NULL,
	envelope_version INTEGER NOT NULL,
	root_key_id TEXT NOT NULL,
	wrapped_dek_nonce BLOB NOT NULL,
	wrapped_dek BLOB NOT NULL,
	payload_nonce BLOB NOT NULL,
	ciphertext BLOB NOT NULL,
	expires_at_ms BIGINT,
	created_at_ms BIGINT NOT NULL,
	updated_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS vault_secret_kind_name_idx ON vault_secret (kind, name);
