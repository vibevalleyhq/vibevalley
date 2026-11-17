package vault_test

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/db"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

type memSQLRow struct {
	id              string
	kind            string
	name            string
	targetHostsJSON string
	provider        string
	envelopeVersion int64
	rootKeyID       string
	wrappedDEKNonce []byte
	wrappedDEK      []byte
	payloadNonce    []byte
	ciphertext      []byte
	expiresAtMs     any
	createdAtMs     int64
	updatedAtMs     int64
}

type memSQLDB struct {
	mu      sync.Mutex
	hasTbl  bool
	rows    map[string]memSQLRow
	failOps map[string]bool
}

type memSQLDriver struct {
	db *memSQLDB
}

func (d *memSQLDriver) Open(string) (driver.Conn, error) {
	return &memSQLConn{db: d.db}, nil
}

type memSQLConn struct {
	db     *memSQLDB
	txRows map[string]memSQLRow
	inTx   bool
}

func (c *memSQLConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("unused") }
func (c *memSQLConn) Close() error                        { return nil }
func (c *memSQLConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *memSQLConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	c.db.mu.Lock()
	defer c.db.mu.Unlock()
	c.txRows = make(map[string]memSQLRow, len(c.db.rows))
	for k, v := range c.db.rows {
		c.txRows[k] = v
	}
	c.inTx = true
	return &memSQLTx{conn: c}, nil
}

type memSQLTx struct {
	conn *memSQLConn
}

func (t *memSQLTx) Commit() error {
	t.conn.db.mu.Lock()
	defer t.conn.db.mu.Unlock()
	t.conn.db.rows = t.conn.txRows
	t.conn.txRows = nil
	t.conn.inTx = false
	return nil
}

func (t *memSQLTx) Rollback() error {
	t.conn.txRows = nil
	t.conn.inTx = false
	return nil
}

func (c *memSQLConn) targetMap() map[string]memSQLRow {
	if c.inTx {
		return c.txRows
	}
	return c.db.rows
}

func stripLeadingSQLComments(query string) string {
	q := strings.TrimSpace(query)
	for strings.HasPrefix(q, "--") {
		if idx := strings.IndexByte(q, '\n'); idx >= 0 {
			q = strings.TrimSpace(q[idx+1:])
		} else {
			return ""
		}
	}
	return q
}

func (c *memSQLConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	q := stripLeadingSQLComments(query)
	if !c.inTx {
		c.db.mu.Lock()
		defer c.db.mu.Unlock()
	}

	switch {
	case strings.HasPrefix(q, "CREATE TABLE IF NOT EXISTS vault_secret"):
		c.db.hasTbl = true
		return driver.RowsAffected(0), nil
	case strings.HasPrefix(q, "CREATE INDEX IF NOT EXISTS vault_secret_kind_name_idx"):
		if !c.db.hasTbl {
			return nil, errors.New("table missing")
		}
		return driver.RowsAffected(0), nil
	case strings.HasPrefix(q, "INSERT INTO vault_secret"):
		if !c.db.hasTbl {
			return nil, errors.New("table missing")
		}
		if len(args) != 14 {
			return nil, fmt.Errorf("expected 14 args, got %d", len(args))
		}
		row := memSQLRow{
			id:              args[0].Value.(string),
			kind:            args[1].Value.(string),
			name:            args[2].Value.(string),
			targetHostsJSON: args[3].Value.(string),
			provider:        args[4].Value.(string),
			envelopeVersion: args[5].Value.(int64),
			rootKeyID:       args[6].Value.(string),
			wrappedDEKNonce: bytes.Clone(args[7].Value.([]byte)),
			wrappedDEK:      bytes.Clone(args[8].Value.([]byte)),
			payloadNonce:    bytes.Clone(args[9].Value.([]byte)),
			ciphertext:      bytes.Clone(args[10].Value.([]byte)),
			expiresAtMs:     args[11].Value,
			createdAtMs:     args[12].Value.(int64),
			updatedAtMs:     args[13].Value.(int64),
		}
		tbl := c.targetMap()
		if existing, ok := tbl[row.id]; ok {
			row.createdAtMs = existing.createdAtMs
		}
		tbl[row.id] = row
		return driver.RowsAffected(1), nil
	case q == "DELETE FROM vault_secret":
		if c.inTx {
			c.txRows = make(map[string]memSQLRow)
		} else {
			c.db.rows = make(map[string]memSQLRow)
		}
		return driver.RowsAffected(1), nil
	case strings.HasPrefix(q, "DELETE FROM vault_secret WHERE id ="):
		id := args[0].Value.(string)
		tbl := c.targetMap()
		if _, ok := tbl[id]; !ok {
			return driver.RowsAffected(0), nil
		}
		delete(tbl, id)
		return driver.RowsAffected(1), nil
	default:
		return nil, fmt.Errorf("unexpected exec SQL: %s", q)
	}
}

func (c *memSQLConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	q := stripLeadingSQLComments(query)
	c.db.mu.Lock()
	defer c.db.mu.Unlock()
	if !c.db.hasTbl {
		return nil, errors.New("table missing")
	}

	var matched []memSQLRow
	switch {
	case strings.Contains(q, "WHERE id ="):
		id := args[0].Value.(string)
		if r, ok := c.db.rows[id]; ok {
			matched = append(matched, r)
		}
	case strings.Contains(q, "WHERE kind ="):
		kind := args[0].Value.(string)
		name := args[1].Value.(string)
		for _, r := range c.db.rows {
			if r.kind == kind && r.name == name {
				matched = append(matched, r)
			}
		}
		sortRows(matched)
		if len(matched) > 1 {
			matched = matched[:1]
		}
	default:
		for _, r := range c.db.rows {
			matched = append(matched, r)
		}
		sortRows(matched)
	}
	return &memSQLRows{rows: matched}, nil
}

func sortRows(rows []memSQLRow) {
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].createdAtMs != rows[j].createdAtMs {
			return rows[i].createdAtMs < rows[j].createdAtMs
		}
		return rows[i].id < rows[j].id
	})
}

type memSQLRows struct {
	rows []memSQLRow
	idx  int
}

func (r *memSQLRows) Columns() []string {
	return []string{
		"id", "kind", "name", "target_hosts_json", "provider",
		"envelope_version", "root_key_id", "wrapped_dek_nonce", "wrapped_dek",
		"payload_nonce", "ciphertext", "expires_at_ms", "created_at_ms", "updated_at_ms",
	}
}

func (r *memSQLRows) Close() error { return nil }

func (r *memSQLRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	row := r.rows[r.idx]
	r.idx++
	dest[0] = row.id
	dest[1] = row.kind
	dest[2] = row.name
	dest[3] = row.targetHostsJSON
	dest[4] = row.provider
	dest[5] = row.envelopeVersion
	dest[6] = row.rootKeyID
	dest[7] = bytes.Clone(row.wrappedDEKNonce)
	dest[8] = bytes.Clone(row.wrappedDEK)
	dest[9] = bytes.Clone(row.payloadNonce)
	dest[10] = bytes.Clone(row.ciphertext)
	dest[11] = row.expiresAtMs
	dest[12] = row.createdAtMs
	dest[13] = row.updatedAtMs
	return nil
}

func openTestSQLBackend(t *testing.T, dialect vault.SQLDialect) (*vault.SQLBackend, *memSQLDB) {
	t.Helper()
	mem := &memSQLDB{rows: make(map[string]memSQLRow)}
	db := sql.OpenDB(&memSQLConnector{drv: &memSQLDriver{db: mem}})
	t.Cleanup(func() { _ = db.Close() })

	backend, err := vault.NewSQLBackend(db, dialect)
	if err != nil {
		t.Fatalf("NewSQLBackend: %v", err)
	}
	if err := backend.EnsureSchema(context.Background()); err != nil {
		t.Fatalf("EnsureSchema: %v", err)
	}
	return backend, mem
}

type memSQLConnector struct {
	drv *memSQLDriver
}

func (c *memSQLConnector) Connect(context.Context) (driver.Conn, error) {
	return c.drv.Open("")
}

func (c *memSQLConnector) Driver() driver.Driver { return c.drv }

func TestSQLBackendBothDialects(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	for _, dialect := range []vault.SQLDialect{vault.DialectSQLite, vault.DialectPostgres} {
		backend, rawDB := openTestSQLBackend(t, dialect)

		rk1, err := vault.GenerateRootKey("rk-sql-1")
		if err != nil {
			t.Fatal(err)
		}
		rk2, err := vault.GenerateRootKey("rk-sql-2")
		if err != nil {
			t.Fatal(err)
		}
		kr, err := vault.NewKeyRing(rk1)
		if err != nil {
			t.Fatal(err)
		}
		store, err := vault.NewStore(kr, backend,
			vault.WithStoreLogger(slog.New(slog.NewJSONHandler(io.Discard, nil))),
			vault.WithStoreClock(func() time.Time {
				return time.UnixMilli(1700000000000).UTC()
			}),
		)
		if err != nil {
			t.Fatal(err)
		}

		const rawSecret = "sql-stored-super-secret-token-7788"
		cred := vault.Credential{
			ID:          "sql-cred-1",
			Kind:        vault.KindGitCredential,
			Name:        "gh-sql",
			TargetHosts: []string{"github.com"},
			Username:    "git-sql-user",
			Value:       vault.NewSecret(rawSecret),
		}
		if err := store.Put(ctx, cred); err != nil {
			t.Fatalf("Put: %v", err)
		}

		got, err := store.Get(ctx, cred.ID)
		if err != nil || !got.Value.Equal(cred.Value) {
			t.Fatalf("Get failed: got=%+v err=%v", got, err)
		}

		// Scan every raw SQL row column & blob for plaintext leaks.
		rawDB.mu.Lock()
		for _, row := range rawDB.rows {
			joined := append(append(row.wrappedDEK, row.ciphertext...), []byte(row.name+row.targetHostsJSON+row.provider)...)
			if bytes.Contains(joined, []byte(rawSecret)) || bytes.Contains(joined, []byte("git-sql-user")) {
				rawDB.mu.Unlock()
				t.Fatalf("plaintext secret leaked in SQL row %s", row.id)
			}
		}
		rawDB.mu.Unlock()

		// Rotate root key atomically in SQL transaction.
		if err := store.RotateRootKey(ctx, rk2); err != nil {
			t.Fatalf("RotateRootKey: %v", err)
		}
		got2, err := store.Get(ctx, cred.ID)
		if err != nil || !got2.Value.Equal(cred.Value) {
			t.Fatalf("Get after SQL rotation failed: %v", err)
		}

		if err := store.Delete(ctx, cred.ID); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		if _, err := store.Get(ctx, cred.ID); !errors.Is(err, vault.ErrSecretNotFound) {
			t.Fatalf("expected ErrSecretNotFound after Delete, got %v", err)
		}
	}
}

func TestVaultSQLiteMigrationsAndRoundTrip(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "vault-mig.db")
	sqlDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer sqlDB.Close()
	sqlDB.SetMaxOpenConns(1)

	fsys, err := db.ScopeFS("vault")
	if err != nil {
		t.Fatalf("ScopeFS(vault): %v", err)
	}
	runner, err := migrate.New(sqlDB, "vault", fsys)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}

	applied, err := runner.Up(ctx)
	if err != nil || applied != 1 {
		t.Fatalf("Up: applied=%d err=%v", applied, err)
	}
	statuses, err := runner.Status(ctx)
	if err != nil || len(statuses) != 1 || !statuses[0].Applied || statuses[0].Scope != "vault" || statuses[0].Version != 1 {
		t.Fatalf("Status after Up: %+v err=%v", statuses, err)
	}

	var tblName string
	if err := sqlDB.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name='vault_secret'`).Scan(&tblName); err != nil {
		t.Fatalf("expected table vault_secret after Up: %v", err)
	}

	reverted, err := runner.DownAll(ctx)
	if err != nil || reverted != 1 {
		t.Fatalf("DownAll: reverted=%d err=%v", reverted, err)
	}
	statusesAfterDown, err := runner.Status(ctx)
	if err != nil || len(statusesAfterDown) != 1 || statusesAfterDown[0].Applied {
		t.Fatalf("Status after DownAll: %+v err=%v", statusesAfterDown, err)
	}
	var remaining int
	if err := sqlDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vault_secret'`).Scan(&remaining); err != nil {
		t.Fatalf("count remaining vault_secret: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("expected 0 vault_secret tables after DownAll, got %d", remaining)
	}

	reapplied, err := runner.Up(ctx)
	if err != nil || reapplied != 1 {
		t.Fatalf("re-Up: applied=%d err=%v", reapplied, err)
	}

	// Verify SQLBackend.EnsureSchema and full vault.Store roundtrip over real SQLite.
	backend, err := vault.NewSQLBackend(sqlDB, vault.DialectSQLite)
	if err != nil {
		t.Fatalf("NewSQLBackend: %v", err)
	}
	if err := backend.EnsureSchema(ctx); err != nil {
		t.Fatalf("EnsureSchema on migrated SQLite: %v", err)
	}
	rk1, err := vault.GenerateRootKey("sqlite-rk-1")
	if err != nil {
		t.Fatal(err)
	}
	rk2, err := vault.GenerateRootKey("sqlite-rk-2")
	if err != nil {
		t.Fatal(err)
	}
	kr, err := vault.NewKeyRing(rk1)
	if err != nil {
		t.Fatal(err)
	}
	st, err := vault.NewStore(kr, backend,
		vault.WithStoreLogger(slog.New(slog.NewJSONHandler(io.Discard, nil))),
		vault.WithStoreClock(func() time.Time { return time.UnixMilli(1700000001000).UTC() }),
	)
	if err != nil {
		t.Fatal(err)
	}

	exp := time.UnixMilli(1800000000000).UTC()
	cred := vault.Credential{
		ID:          "real-sqlite-cred-1",
		Kind:        vault.KindProviderAPIKey,
		Name:        "anthropic",
		TargetHosts: []string{"api.anthropic.com"},
		Provider:    "anthropic",
		ExpiresAt:   &exp,
		Value:       vault.NewSecret("sk-ant-real-sqlite-test"),
	}
	if err := st.Put(ctx, cred); err != nil {
		t.Fatalf("Put: %v", err)
	}
	gotByID, err := st.Get(ctx, cred.ID)
	if err != nil || !gotByID.Value.Equal(cred.Value) {
		t.Fatalf("Get: %+v err=%v", gotByID, err)
	}
	gotByName, err := st.GetByName(ctx, vault.KindProviderAPIKey, "anthropic")
	if err != nil || !gotByName.Value.Equal(cred.Value) {
		t.Fatalf("GetByName: %+v err=%v", gotByName, err)
	}
	meta, err := st.ListMetadata(ctx)
	if err != nil || len(meta) != 1 || meta[0].ID != cred.ID {
		t.Fatalf("ListMetadata: %+v err=%v", meta, err)
	}
	if err := st.RotateRootKey(ctx, rk2); err != nil {
		t.Fatalf("RotateRootKey: %v", err)
	}
	gotAfterRot, err := st.Get(ctx, cred.ID)
	if err != nil || !gotAfterRot.Value.Equal(cred.Value) {
		t.Fatalf("Get after rotation: %+v err=%v", gotAfterRot, err)
	}
	if err := st.Delete(ctx, cred.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := st.Get(ctx, cred.ID); !errors.Is(err, vault.ErrSecretNotFound) {
		t.Fatalf("expected ErrSecretNotFound after delete, got %v", err)
	}
}
