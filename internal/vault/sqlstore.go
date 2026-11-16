package vault

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/vibevalleyhq/vibevalley/internal/vault/sqlcgen"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

// MigrationsFS embeds the SQLite migration scripts for the vault store.
//
//go:embed migrations/*.sql
var MigrationsFS embed.FS

// SQLDialect selects parameter placeholder and binary column syntax for SQLBackend.
type SQLDialect int

const (
	DialectSQLite SQLDialect = iota
	DialectPostgres
)

// SQLBackend implements Backend over any stdlib *sql.DB (SQLite or PostgreSQL).
type SQLBackend struct {
	db      *sql.DB
	dialect SQLDialect
	q       *sqlcgen.Queries
}

// NewSQLBackend creates a Backend backed by db using the specified SQL dialect.
func NewSQLBackend(db *sql.DB, dialect SQLDialect) (*SQLBackend, error) {
	if db == nil {
		return nil, errors.New("vault: sql.DB is required")
	}
	return &SQLBackend{
		db:      db,
		dialect: dialect,
		q:       sqlcgen.New(db),
	}, nil
}

// SchemaStatements returns the DDL statements creating vault_secret and its index.
func SchemaStatements(dialect SQLDialect) []string {
	blobType := "BLOB"
	if dialect == DialectPostgres {
		blobType = "BYTEA"
	}
	return []string{
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS vault_secret (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('provider_api_key', 'git_credential', 'mcp_oauth_token')),
			name TEXT NOT NULL,
			target_hosts_json TEXT NOT NULL,
			provider TEXT NOT NULL,
			envelope_version INTEGER NOT NULL,
			root_key_id TEXT NOT NULL,
			wrapped_dek_nonce %s NOT NULL,
			wrapped_dek %s NOT NULL,
			payload_nonce %s NOT NULL,
			ciphertext %s NOT NULL,
			expires_at_ms BIGINT,
			created_at_ms BIGINT NOT NULL,
			updated_at_ms BIGINT NOT NULL
		)`, blobType, blobType, blobType, blobType),
		`CREATE INDEX IF NOT EXISTS vault_secret_kind_name_idx ON vault_secret (kind, name)`,
	}
}

func isSQLiteDriver(db *sql.DB) bool {
	if db == nil || db.Driver() == nil {
		return false
	}
	return strings.Contains(strings.ToLower(fmt.Sprintf("%T", db.Driver())), "sqlite")
}

func (b *SQLBackend) ensureStatements(ctx context.Context) error {
	for _, stmt := range SchemaStatements(b.dialect) {
		if _, err := b.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("vault: ensure schema: %w", err)
		}
	}
	return nil
}

// Migrate applies embedded SQLite migrations via pkg/migrate (or Postgres DDL statements).
func (b *SQLBackend) Migrate(ctx context.Context) error {
	if b.dialect == DialectPostgres {
		return b.ensureStatements(ctx)
	}
	runner, err := migrate.New(b.db, "vault", MigrationsFS)
	if err != nil {
		return fmt.Errorf("vault: init migrator: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		return fmt.Errorf("vault: apply migrations: %w", err)
	}
	return nil
}

// EnsureSchema creates the vault_secret table and index if they do not yet exist.
// When backed by SQLite, it applies embedded migrations through pkg/migrate.
func (b *SQLBackend) EnsureSchema(ctx context.Context) error {
	if b.dialect == DialectSQLite && isSQLiteDriver(b.db) {
		return b.Migrate(ctx)
	}
	return b.ensureStatements(ctx)
}

func (b *SQLBackend) ph(index int) string {
	if b.dialect == DialectPostgres {
		return fmt.Sprintf("$%d", index)
	}
	return "?"
}

type sqlExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func marshalTargetHosts(hosts []string) (string, error) {
	if hosts == nil {
		return "[]", nil
	}
	hostsJSON, err := json.Marshal(hosts)
	if err != nil {
		return "", err
	}
	return string(hostsJSON), nil
}

func (b *SQLBackend) putEnvelopeSQLite(ctx context.Context, q *sqlcgen.Queries, env SealedEnvelope) error {
	hostsJSON, err := marshalTargetHosts(env.TargetHosts)
	if err != nil {
		return err
	}
	var expiresAt sql.NullInt64
	if env.ExpiresAtMs != nil {
		expiresAt = sql.NullInt64{Int64: *env.ExpiresAtMs, Valid: true}
	}
	return q.PutEnvelope(ctx, sqlcgen.PutEnvelopeParams{
		ID:              env.SecretID,
		Kind:            string(env.Kind),
		Name:            env.Name,
		TargetHostsJson: hostsJSON,
		Provider:        env.Provider,
		EnvelopeVersion: int64(env.Version),
		RootKeyID:       env.RootKeyID,
		WrappedDekNonce: slices.Clone(env.WrappedDEKNonce),
		WrappedDek:      slices.Clone(env.WrappedDEK),
		PayloadNonce:    slices.Clone(env.PayloadNonce),
		Ciphertext:      slices.Clone(env.Ciphertext),
		ExpiresAtMs:     expiresAt,
		CreatedAtMs:     env.CreatedAtMs,
		UpdatedAtMs:     env.UpdatedAtMs,
	})
}

func (b *SQLBackend) putEnvelopePostgres(ctx context.Context, exec sqlExecer, env SealedEnvelope) error {
	hostsJSON, err := marshalTargetHosts(env.TargetHosts)
	if err != nil {
		return err
	}

	var expiresAt any
	if env.ExpiresAtMs != nil {
		expiresAt = *env.ExpiresAtMs
	}

	query := fmt.Sprintf(`INSERT INTO vault_secret (
		id, kind, name, target_hosts_json, provider,
		envelope_version, root_key_id, wrapped_dek_nonce, wrapped_dek,
		payload_nonce, ciphertext, expires_at_ms, created_at_ms, updated_at_ms
	) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
		updated_at_ms = EXCLUDED.updated_at_ms`,
		b.ph(1), b.ph(2), b.ph(3), b.ph(4), b.ph(5),
		b.ph(6), b.ph(7), b.ph(8), b.ph(9),
		b.ph(10), b.ph(11), b.ph(12), b.ph(13), b.ph(14),
	)

	_, err = exec.ExecContext(
		ctx,
		query,
		env.SecretID,
		string(env.Kind),
		env.Name,
		hostsJSON,
		env.Provider,
		int(env.Version),
		env.RootKeyID,
		slices.Clone(env.WrappedDEKNonce),
		slices.Clone(env.WrappedDEK),
		slices.Clone(env.PayloadNonce),
		slices.Clone(env.Ciphertext),
		expiresAt,
		env.CreatedAtMs,
		env.UpdatedAtMs,
	)
	return err
}

func (b *SQLBackend) PutEnvelope(ctx context.Context, env SealedEnvelope) error {
	if b.dialect == DialectSQLite {
		return b.putEnvelopeSQLite(ctx, b.q, env)
	}
	return b.putEnvelopePostgres(ctx, b.db, env)
}

func (b *SQLBackend) GetEnvelope(ctx context.Context, id string) (SealedEnvelope, error) {
	if b.dialect == DialectSQLite {
		row, err := b.q.GetEnvelope(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return SealedEnvelope{}, ErrSecretNotFound
		}
		if err != nil {
			return SealedEnvelope{}, err
		}
		return envelopeFromModel(row)
	}

	query := fmt.Sprintf(`SELECT
		id, kind, name, target_hosts_json, provider,
		envelope_version, root_key_id, wrapped_dek_nonce, wrapped_dek,
		payload_nonce, ciphertext, expires_at_ms, created_at_ms, updated_at_ms
	FROM vault_secret WHERE id = %s`, b.ph(1))

	row := b.db.QueryRowContext(ctx, query, id)
	env, err := scanEnvelopeRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return SealedEnvelope{}, ErrSecretNotFound
	}
	return env, err
}

func (b *SQLBackend) GetEnvelopeByName(ctx context.Context, kind SecretKind, name string) (SealedEnvelope, error) {
	if b.dialect == DialectSQLite {
		row, err := b.q.GetEnvelopeByName(ctx, sqlcgen.GetEnvelopeByNameParams{
			Kind: string(kind),
			Name: name,
		})
		if errors.Is(err, sql.ErrNoRows) {
			return SealedEnvelope{}, ErrSecretNotFound
		}
		if err != nil {
			return SealedEnvelope{}, err
		}
		return envelopeFromModel(row)
	}

	query := fmt.Sprintf(`SELECT
		id, kind, name, target_hosts_json, provider,
		envelope_version, root_key_id, wrapped_dek_nonce, wrapped_dek,
		payload_nonce, ciphertext, expires_at_ms, created_at_ms, updated_at_ms
	FROM vault_secret WHERE kind = %s AND name = %s ORDER BY created_at_ms ASC, id ASC LIMIT 1`,
		b.ph(1), b.ph(2),
	)

	row := b.db.QueryRowContext(ctx, query, string(kind), name)
	env, err := scanEnvelopeRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return SealedEnvelope{}, ErrSecretNotFound
	}
	return env, err
}

func (b *SQLBackend) ListEnvelopes(ctx context.Context) ([]SealedEnvelope, error) {
	if b.dialect == DialectSQLite {
		rows, err := b.q.ListEnvelopes(ctx)
		if err != nil {
			return nil, err
		}
		out := make([]SealedEnvelope, 0, len(rows))
		for _, row := range rows {
			env, convErr := envelopeFromModel(row)
			if convErr != nil {
				return nil, convErr
			}
			out = append(out, env)
		}
		return out, nil
	}

	rows, err := b.db.QueryContext(ctx, `SELECT
		id, kind, name, target_hosts_json, provider,
		envelope_version, root_key_id, wrapped_dek_nonce, wrapped_dek,
		payload_nonce, ciphertext, expires_at_ms, created_at_ms, updated_at_ms
	FROM vault_secret ORDER BY created_at_ms ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SealedEnvelope
	for rows.Next() {
		env, scanErr := scanEnvelopeRow(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, env)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (b *SQLBackend) DeleteEnvelope(ctx context.Context, id string) error {
	if b.dialect == DialectSQLite {
		affected, err := b.q.DeleteEnvelope(ctx, id)
		if err != nil {
			return err
		}
		if affected == 0 {
			return ErrSecretNotFound
		}
		return nil
	}

	query := fmt.Sprintf(`DELETE FROM vault_secret WHERE id = %s`, b.ph(1))
	res, err := b.db.ExecContext(ctx, query, id)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err == nil && affected == 0 {
		return ErrSecretNotFound
	}
	return err
}

func (b *SQLBackend) ReplaceAllEnvelopes(ctx context.Context, envs []SealedEnvelope) error {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	if b.dialect == DialectSQLite {
		qtx := b.q.WithTx(tx)
		if err := qtx.DeleteAllEnvelopes(ctx); err != nil {
			return err
		}
		for _, env := range envs {
			if err := b.putEnvelopeSQLite(ctx, qtx, env); err != nil {
				return err
			}
		}
		return tx.Commit()
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM vault_secret`); err != nil {
		return err
	}
	for _, env := range envs {
		if err := b.putEnvelopePostgres(ctx, tx, env); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type rowScanner interface {
	Scan(dest ...any) error
}

func buildEnvelope(
	secretID string,
	kind string,
	name string,
	hostsJSON string,
	provider string,
	version int64,
	rootKeyID string,
	wrappedDEKNonce []byte,
	wrappedDEK []byte,
	payloadNonce []byte,
	ciphertext []byte,
	expiresAtMs sql.NullInt64,
	createdAtMs int64,
	updatedAtMs int64,
) (SealedEnvelope, error) {
	if version < 0 || version > 255 {
		return SealedEnvelope{}, fmt.Errorf("%w: invalid version %d", ErrCiphertextTampered, version)
	}
	env := SealedEnvelope{
		Version:         uint8(version),
		SecretID:        secretID,
		Kind:            SecretKind(kind),
		Name:            name,
		Provider:        provider,
		RootKeyID:       rootKeyID,
		WrappedDEKNonce: wrappedDEKNonce,
		WrappedDEK:      wrappedDEK,
		PayloadNonce:    payloadNonce,
		Ciphertext:      ciphertext,
		CreatedAtMs:     createdAtMs,
		UpdatedAtMs:     updatedAtMs,
	}
	if hostsJSON != "" {
		if err := json.Unmarshal([]byte(hostsJSON), &env.TargetHosts); err != nil {
			return SealedEnvelope{}, fmt.Errorf("%w: invalid target hosts json: %v", ErrCiphertextTampered, err)
		}
		if len(env.TargetHosts) == 0 {
			env.TargetHosts = nil
		}
	}
	if expiresAtMs.Valid {
		v := expiresAtMs.Int64
		env.ExpiresAtMs = &v
	}
	return cloneEnvelope(env), nil
}

func envelopeFromModel(m sqlcgen.VaultSecret) (SealedEnvelope, error) {
	return buildEnvelope(
		m.ID,
		m.Kind,
		m.Name,
		m.TargetHostsJson,
		m.Provider,
		m.EnvelopeVersion,
		m.RootKeyID,
		m.WrappedDekNonce,
		m.WrappedDek,
		m.PayloadNonce,
		m.Ciphertext,
		m.ExpiresAtMs,
		m.CreatedAtMs,
		m.UpdatedAtMs,
	)
}

func scanEnvelopeRow(scanner rowScanner) (SealedEnvelope, error) {
	var (
		secretID        string
		kind            string
		name            string
		hostsJSON       string
		provider        string
		version         int64
		rootKeyID       string
		wrappedDEKNonce []byte
		wrappedDEK      []byte
		payloadNonce    []byte
		ciphertext      []byte
		expiresAtMs     sql.NullInt64
		createdAtMs     int64
		updatedAtMs     int64
	)
	err := scanner.Scan(
		&secretID,
		&kind,
		&name,
		&hostsJSON,
		&provider,
		&version,
		&rootKeyID,
		&wrappedDEKNonce,
		&wrappedDEK,
		&payloadNonce,
		&ciphertext,
		&expiresAtMs,
		&createdAtMs,
		&updatedAtMs,
	)
	if err != nil {
		return SealedEnvelope{}, err
	}
	return buildEnvelope(
		secretID,
		kind,
		name,
		hostsJSON,
		provider,
		version,
		rootKeyID,
		wrappedDEKNonce,
		wrappedDEK,
		payloadNonce,
		ciphertext,
		expiresAtMs,
		createdAtMs,
		updatedAtMs,
	)
}
