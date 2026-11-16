package migrate_test

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"io"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

func openTestSQLite(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("sql.Open sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func openFileWALSQLite(t *testing.T, name string) *sql.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), name)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open file sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA foreign_keys=ON",
	} {
		if _, err := db.ExecContext(context.Background(), pragma); err != nil {
			_ = db.Close()
			t.Fatalf("%s: %v", pragma, err)
		}
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestSplitStatements(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want []string
	}{
		{
			name: "empty and comments only",
			sql:  " \n\t -- header\n /* block ; comment */ ; ; -- tail\n",
			want: nil,
		},
		{
			name: "single quoted strings with escaped quotes and semicolons",
			sql:  "INSERT INTO t VALUES ('a;b'); INSERT INTO t VALUES ('it''s;ok', '''', '--not-comment;');",
			want: []string{
				"INSERT INTO t VALUES ('a;b')",
				"INSERT INTO t VALUES ('it''s;ok', '''', '--not-comment;')",
			},
		},
		{
			name: "double quoted and backtick identifiers with semicolons and keywords",
			sql:  `CREATE TABLE "my;tbl" ("col;1" TEXT, "begin" INT, "end" INT, "case" INT); SELECT ` + "`a;b`" + ` FROM "my;tbl";`,
			want: []string{
				`CREATE TABLE "my;tbl" ("col;1" TEXT, "begin" INT, "end" INT, "case" INT)`,
				`SELECT ` + "`a;b`" + ` FROM "my;tbl"`,
			},
		},
		{
			name: "comments containing quotes and block keywords",
			sql:  "/* comment with 'quote'; BEGIN END; /*/ */\nCREATE TABLE a (id INT); -- trailing '; BEGIN\n/* end */",
			want: []string{
				"/* comment with 'quote'; BEGIN END; /*/ */\nCREATE TABLE a (id INT)",
			},
		},
		{
			name: "sqlite trigger with raise abort semicolon and multiple body statements",
			sql: `
CREATE TRIGGER trg_items_guard
BEFORE INSERT ON items
BEGIN
	SELECT RAISE(ABORT, 'a;b') WHERE NEW.title = 'bad;title';
	INSERT INTO audit_log (msg) VALUES ('ok;inserted');
END;
CREATE TABLE after_trigger (id INT);
`,
			want: []string{
				"CREATE TRIGGER trg_items_guard\nBEFORE INSERT ON items\nBEGIN\n\tSELECT RAISE(ABORT, 'a;b') WHERE NEW.title = 'bad;title';\n\tINSERT INTO audit_log (msg) VALUES ('ok;inserted');\nEND",
				"CREATE TABLE after_trigger (id INT)",
			},
		},
		{
			name: "case expressions inside and outside trigger",
			sql: `
SELECT CASE WHEN x > 0 THEN 'a;b' ELSE CASE WHEN y = 1 THEN 'c;d' ELSE 'e' END END FROM t;
CREATE TRIGGER trg_case_inside
AFTER UPDATE ON items
WHEN NEW.kind = CASE WHEN OLD.kind = 'a' THEN 'b' ELSE 'c' END
BEGIN
	UPDATE items SET label = CASE NEW.status WHEN 1 THEN 'one;1' ELSE 'other;2' END WHERE id = NEW.id;
	INSERT INTO audit_log (msg) VALUES ('updated');
END;
SELECT 42;
`,
			want: []string{
				"SELECT CASE WHEN x > 0 THEN 'a;b' ELSE CASE WHEN y = 1 THEN 'c;d' ELSE 'e' END END FROM t",
				"CREATE TRIGGER trg_case_inside\nAFTER UPDATE ON items\nWHEN NEW.kind = CASE WHEN OLD.kind = 'a' THEN 'b' ELSE 'c' END\nBEGIN\n\tUPDATE items SET label = CASE NEW.status WHEN 1 THEN 'one;1' ELSE 'other;2' END WHERE id = NEW.id;\n\tINSERT INTO audit_log (msg) VALUES ('updated');\nEND",
				"SELECT 42",
			},
		},
		{
			name: "transaction begin statements split normally",
			sql:  "BEGIN IMMEDIATE; INSERT INTO t VALUES (1); COMMIT; BEGIN; DELETE FROM t; END TRANSACTION;",
			want: []string{
				"BEGIN IMMEDIATE",
				"INSERT INTO t VALUES (1)",
				"COMMIT",
				"BEGIN",
				"DELETE FROM t",
				"END TRANSACTION",
			},
		},
		{
			name: "postgres dollar quoted body and positional parameters",
			sql:  "CREATE FUNCTION fn() RETURNS void AS $body$ BEGIN PERFORM $1; RAISE NOTICE 'x;y'; END; $body$ LANGUAGE plpgsql; SELECT $1;",
			want: []string{
				"CREATE FUNCTION fn() RETURNS void AS $body$ BEGIN PERFORM $1; RAISE NOTICE 'x;y'; END; $body$ LANGUAGE plpgsql",
				"SELECT $1",
			},
		},
		{
			name: "dot qualified column names and no trailing semicolon",
			sql:  "SELECT t.begin, t.case, t.end FROM t;\nCREATE TRIGGER trg_no_semi AFTER DELETE ON t BEGIN DELETE FROM log; END",
			want: []string{
				"SELECT t.begin, t.case, t.end FROM t",
				"CREATE TRIGGER trg_no_semi AFTER DELETE ON t BEGIN DELETE FROM log; END",
			},
		},
		{
			name: "transaction wrapping create trigger",
			sql:  "BEGIN IMMEDIATE; CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES ('x;y'); END; COMMIT;",
			want: []string{
				"BEGIN IMMEDIATE",
				"CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES ('x;y'); END",
				"COMMIT",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := migrate.SplitStatements(tc.sql)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("SplitStatements mismatch:\n got: %#v\nwant: %#v", got, tc.want)
			}
		})
	}
}

func TestParseFSValidation(t *testing.T) {
	t.Run("valid sorting and checksum", func(t *testing.T) {
		up1 := "\n  CREATE TABLE a (id INTEGER PRIMARY KEY);  \n"
		sum := sha256.Sum256([]byte(strings.TrimSpace(up1)))
		wantChecksum := hex.EncodeToString(sum[:])

		fsys := fstest.MapFS{
			"migrations/0010_add_c.up.sql":   {Data: []byte("CREATE TABLE c (id INT);")},
			"migrations/0010_add_c.down.sql": {Data: []byte("DROP TABLE c;")},
			"migrations/0002_add_b.up.sql":   {Data: []byte("CREATE TABLE b (id INT);")},
			"migrations/0002_add_b.down.sql": {Data: []byte("DROP TABLE b;")},
			"migrations/0001_init.up.sql":    {Data: []byte(up1)},
			"migrations/0001_init.down.sql":  {Data: []byte("DROP TABLE a;")},
		}

		migs, err := migrate.ParseFS(fsys, "")
		if err != nil {
			t.Fatalf("ParseFS failed: %v", err)
		}
		if len(migs) != 3 {
			t.Fatalf("got %d migrations, want 3", len(migs))
		}
		if migs[0].Version != 1 || migs[1].Version != 2 || migs[2].Version != 10 {
			t.Fatalf("unexpected version order: %+v", migs)
		}
		if migs[0].Name != "init" {
			t.Fatalf("got name %q, want init", migs[0].Name)
		}
		if migs[0].Checksum != wantChecksum {
			t.Fatalf("checksum = %q, want %q", migs[0].Checksum, wantChecksum)
		}
	})

	t.Run("root dot directory", func(t *testing.T) {
		fsys := fstest.MapFS{
			"0001_root.up.sql":   {Data: []byte("CREATE TABLE root_tbl (id INT);")},
			"0001_root.down.sql": {Data: []byte("DROP TABLE root_tbl;")},
		}
		migs, err := migrate.ParseFS(fsys, ".")
		if err != nil {
			t.Fatalf("ParseFS(.) failed: %v", err)
		}
		if len(migs) != 1 || migs[0].Version != 1 || migs[0].Name != "root" {
			t.Fatalf("unexpected migrations from root dir: %+v", migs)
		}
	})

	errCases := []struct {
		name    string
		dir     string
		files   fstest.MapFS
		wantErr error
	}{
		{
			name: "missing down migration",
			files: fstest.MapFS{
				"migrations/0001_init.up.sql": {Data: []byte("CREATE TABLE a (id INT);")},
			},
			wantErr: migrate.ErrMissingDownMigration,
		},
		{
			name: "missing up migration",
			files: fstest.MapFS{
				"migrations/0001_init.down.sql": {Data: []byte("DROP TABLE a;")},
			},
			wantErr: migrate.ErrMissingUpMigration,
		},
		{
			name: "duplicate version",
			files: fstest.MapFS{
				"migrations/0001_first.up.sql":   {Data: []byte("CREATE TABLE a (id INT);")},
				"migrations/0001_first.down.sql": {Data: []byte("DROP TABLE a;")},
				"migrations/001_second.up.sql":   {Data: []byte("CREATE TABLE b (id INT);")},
				"migrations/001_second.down.sql": {Data: []byte("DROP TABLE b;")},
			},
			wantErr: migrate.ErrInvalidMigration,
		},
		{
			name: "mismatched up and down names",
			files: fstest.MapFS{
				"migrations/0001_create_a.up.sql": {Data: []byte("CREATE TABLE a (id INT);")},
				"migrations/0001_drop_a.down.sql": {Data: []byte("DROP TABLE a;")},
			},
			wantErr: migrate.ErrInvalidMigration,
		},
		{
			name: "bad filename without direction suffix",
			files: fstest.MapFS{
				"migrations/0001_init.sql": {Data: []byte("CREATE TABLE a (id INT);")},
			},
			wantErr: migrate.ErrInvalidMigration,
		},
		{
			name: "bad filename non numeric version",
			files: fstest.MapFS{
				"migrations/abc_init.up.sql":   {Data: []byte("CREATE TABLE a (id INT);")},
				"migrations/abc_init.down.sql": {Data: []byte("DROP TABLE a;")},
			},
			wantErr: migrate.ErrInvalidMigration,
		},
		{
			name: "bad filename missing name",
			files: fstest.MapFS{
				"migrations/0001_.up.sql":   {Data: []byte("CREATE TABLE a (id INT);")},
				"migrations/0001_.down.sql": {Data: []byte("DROP TABLE a;")},
			},
			wantErr: migrate.ErrInvalidMigration,
		},
		{
			name: "zero version",
			files: fstest.MapFS{
				"migrations/0000_init.up.sql":   {Data: []byte("CREATE TABLE a (id INT);")},
				"migrations/0000_init.down.sql": {Data: []byte("DROP TABLE a;")},
			},
			wantErr: migrate.ErrInvalidMigration,
		},
		{
			name: "negative version",
			files: fstest.MapFS{
				"migrations/-001_init.up.sql":   {Data: []byte("CREATE TABLE a (id INT);")},
				"migrations/-001_init.down.sql": {Data: []byte("DROP TABLE a;")},
			},
			wantErr: migrate.ErrInvalidMigration,
		},
		{
			name: "plus prefix version",
			files: fstest.MapFS{
				"migrations/+001_init.up.sql":   {Data: []byte("CREATE TABLE a (id INT);")},
				"migrations/+001_init.down.sql": {Data: []byte("DROP TABLE a;")},
			},
			wantErr: migrate.ErrInvalidMigration,
		},
		{
			name: "empty up sql after comments",
			files: fstest.MapFS{
				"migrations/0001_init.up.sql":   {Data: []byte("-- only comment\n/* nothing */ ;")},
				"migrations/0001_init.down.sql": {Data: []byte("DROP TABLE a;")},
			},
			wantErr: migrate.ErrInvalidMigration,
		},
		{
			name: "empty down sql",
			files: fstest.MapFS{
				"migrations/0001_init.up.sql":   {Data: []byte("CREATE TABLE a (id INT);")},
				"migrations/0001_init.down.sql": {Data: []byte("   \n  ")},
			},
			wantErr: migrate.ErrInvalidMigration,
		},
		{
			name: "empty migrations directory",
			dir:  ".",
			files: fstest.MapFS{
				".gitkeep": {Data: []byte("")},
			},
			wantErr: migrate.ErrEmptyMigrations,
		},
	}

	for _, tc := range errCases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := migrate.ParseFS(tc.files, tc.dir)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("ParseFS error = %v, want errors.Is(..., %v)", err, tc.wantErr)
			}
		})
	}
}

func triggerMigrationFS() fstest.MapFS {
	return fstest.MapFS{
		"db/0001_items_table.up.sql": {Data: []byte(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				title TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'task',
				label TEXT NOT NULL DEFAULT ''
			);
			CREATE TABLE item_audit (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				msg TEXT NOT NULL
			);
		`)},
		"db/0001_items_table.down.sql": {Data: []byte(`
			DROP TABLE IF EXISTS item_audit;
			DROP TABLE IF EXISTS items;
		`)},
		"db/0002_items_trigger.up.sql": {Data: []byte(`
			CREATE TRIGGER trg_items_insert_guard
			BEFORE INSERT ON items
			BEGIN
				SELECT RAISE(ABORT, 'forbidden;title')
				WHERE NEW.title = 'bad;title';

				INSERT INTO item_audit (msg)
				VALUES (CASE WHEN NEW.kind = 'urgent' THEN 'created;urgent' ELSE 'created;normal' END);
			END;
		`)},
		"db/0002_items_trigger.down.sql": {Data: []byte(`
			DROP TRIGGER IF EXISTS trg_items_insert_guard;
			DELETE FROM item_audit;
		`)},
	}
}

func sqliteObjectExists(t *testing.T, db *sql.DB, objType, name string) bool {
	t.Helper()
	var count int
	err := db.QueryRowContext(
		context.Background(),
		`SELECT COUNT(*) FROM sqlite_master WHERE type = ? AND name = ?`,
		objType,
		name,
	).Scan(&count)
	if err != nil {
		t.Fatalf("query sqlite_master: %v", err)
	}
	return count > 0
}

func TestSQLiteLifecycleWithTriggerAndRollback(t *testing.T) {
	ctx := context.Background()
	db := openTestSQLite(t)

	var tick int64 = 1000
	clock := func() int64 {
		tick += 100
		return tick
	}

	runner, err := migrate.New(db, "core", triggerMigrationFS(), migrate.WithDir("db"), migrate.WithClock(clock))
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}

	cur, pend, err := runner.Version(ctx)
	if err != nil {
		t.Fatalf("Version before Up: %v", err)
	}
	if cur != 0 || pend != 2 {
		t.Fatalf("Version before Up = (%d, %d), want (0, 2)", cur, pend)
	}

	// Up
	applied, err := runner.Up(ctx)
	if err != nil {
		t.Fatalf("Up: %v", err)
	}
	if applied != 2 {
		t.Fatalf("Up applied = %d, want 2", applied)
	}

	// Verify trigger works for real: allowed insert writes to item_audit, forbidden title aborts.
	if _, err := db.ExecContext(ctx, `INSERT INTO items (title, kind) VALUES ('ship;go', 'urgent')`); err != nil {
		t.Fatalf("valid insert failed: %v", err)
	}
	var auditMsg string
	if err := db.QueryRowContext(ctx, `SELECT msg FROM item_audit LIMIT 1`).Scan(&auditMsg); err != nil {
		t.Fatalf("read audit_log: %v", err)
	}
	if auditMsg != "created;urgent" {
		t.Fatalf("audit msg = %q, want created;urgent", auditMsg)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO items (title) VALUES ('bad;title')`); err == nil || !strings.Contains(err.Error(), "forbidden;title") {
		t.Fatalf("expected trigger abort 'forbidden;title', got err=%v", err)
	}

	// Status
	statuses, err := runner.Status(ctx)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if len(statuses) != 2 {
		t.Fatalf("Status len = %d, want 2", len(statuses))
	}
	if !statuses[0].Applied || statuses[0].AppliedAtMs != 1100 || !statuses[1].Applied || statuses[1].AppliedAtMs != 1200 {
		t.Fatalf("unexpected statuses: %+v", statuses)
	}

	// Up again is idempotent (0 applied)
	applied, err = runner.Up(ctx)
	if err != nil {
		t.Fatalf("idempotent Up: %v", err)
	}
	if applied != 0 {
		t.Fatalf("idempotent Up applied = %d, want 0", applied)
	}

	// Down(1) drops trigger and preserves items table
	reverted, err := runner.Down(ctx, 1)
	if err != nil {
		t.Fatalf("Down(1): %v", err)
	}
	if reverted != 1 {
		t.Fatalf("Down(1) reverted = %d, want 1", reverted)
	}
	if sqliteObjectExists(t, db, "trigger", "trg_items_insert_guard") {
		t.Fatal("trigger still exists after Down(1)")
	}
	if !sqliteObjectExists(t, db, "table", "items") {
		t.Fatal("items table unexpectedly dropped after Down(1)")
	}
	// Now 'bad;title' is allowed because trigger was dropped.
	if _, err := db.ExecContext(ctx, `INSERT INTO items (title) VALUES ('bad;title')`); err != nil {
		t.Fatalf("insert after trigger drop failed: %v", err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM items WHERE title = 'bad;title'`); err != nil {
		t.Fatalf("cleanup insert: %v", err)
	}

	cur, pend, err = runner.Version(ctx)
	if err != nil || cur != 1 || pend != 1 {
		t.Fatalf("Version after Down(1) = (%d, %d, %v), want (1, 1, nil)", cur, pend, err)
	}

	// Up restores trigger
	applied, err = runner.Up(ctx)
	if err != nil {
		t.Fatalf("Up after Down(1): %v", err)
	}
	if applied != 1 {
		t.Fatalf("Up after Down(1) applied = %d, want 1", applied)
	}
	if !sqliteObjectExists(t, db, "trigger", "trg_items_insert_guard") {
		t.Fatal("trigger not restored after Up")
	}

	// DownAll removes everything in reverse order
	reverted, err = runner.DownAll(ctx)
	if err != nil {
		t.Fatalf("DownAll: %v", err)
	}
	if reverted != 2 {
		t.Fatalf("DownAll reverted = %d, want 2", reverted)
	}
	if sqliteObjectExists(t, db, "trigger", "trg_items_insert_guard") || sqliteObjectExists(t, db, "table", "items") {
		t.Fatal("objects remain after DownAll")
	}
	cur, pend, err = runner.Version(ctx)
	if err != nil || cur != 0 || pend != 2 {
		t.Fatalf("Version after DownAll = (%d, %d, %v), want (0, 2, nil)", cur, pend, err)
	}

	// UpSteps(1) then UpSteps(1) -> Up back to full state
	applied, err = runner.UpSteps(ctx, 1)
	if err != nil || applied != 1 {
		t.Fatalf("UpSteps(1) = (%d, %v), want (1, nil)", applied, err)
	}
	cur, pend, err = runner.Version(ctx)
	if err != nil || cur != 1 || pend != 1 {
		t.Fatalf("Version after UpSteps(1) = (%d, %d, %v), want (1, 1, nil)", cur, pend, err)
	}
	applied, err = runner.Up(ctx)
	if err != nil || applied != 1 {
		t.Fatalf("final Up = (%d, %v), want (1, nil)", applied, err)
	}
	if !sqliteObjectExists(t, db, "trigger", "trg_items_insert_guard") {
		t.Fatal("trigger missing after final Up")
	}
}

func TestMultipleScopesShareDatabaseWithoutColliding(t *testing.T) {
	ctx := context.Background()
	db := openFileWALSQLite(t, "shared.db")

	issueFS := fstest.MapFS{
		"migrations/0001_issue_init.up.sql":   {Data: []byte("CREATE TABLE issue_tbl (id TEXT PRIMARY KEY);")},
		"migrations/0001_issue_init.down.sql": {Data: []byte("DROP TABLE issue_tbl;")},
		"migrations/0002_issue_idx.up.sql":    {Data: []byte("ALTER TABLE issue_tbl ADD COLUMN title TEXT NOT NULL DEFAULT '';")},
		"migrations/0002_issue_idx.down.sql":  {Data: []byte("ALTER TABLE issue_tbl DROP COLUMN title;")},
	}
	vaultFS := fstest.MapFS{
		"migrations/0001_vault_init.up.sql":   {Data: []byte("CREATE TABLE vault_tbl (id TEXT PRIMARY KEY);")},
		"migrations/0001_vault_init.down.sql": {Data: []byte("DROP TABLE vault_tbl;")},
	}

	issueRunner, err := migrate.New(db, "issue", issueFS)
	if err != nil {
		t.Fatalf("issue New: %v", err)
	}
	vaultRunner, err := migrate.New(db, "vault", vaultFS)
	if err != nil {
		t.Fatalf("vault New: %v", err)
	}

	// Run both scopes concurrently under -race against shared SQLite WAL DB.
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		n, err := issueRunner.Up(ctx)
		if err == nil && n != 2 {
			errs <- errors.New("issue applied count != 2")
			return
		}
		errs <- err
	}()
	go func() {
		defer wg.Done()
		n, err := vaultRunner.Up(ctx)
		if err == nil && n != 1 {
			errs <- errors.New("vault applied count != 1")
			return
		}
		errs <- err
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent Up failed: %v", err)
		}
	}

	if cur, pend, err := issueRunner.Version(ctx); err != nil || cur != 2 || pend != 0 {
		t.Fatalf("issue Version = (%d, %d, %v), want (2, 0, nil)", cur, pend, err)
	}
	if cur, pend, err := vaultRunner.Version(ctx); err != nil || cur != 1 || pend != 0 {
		t.Fatalf("vault Version = (%d, %d, %v), want (1, 0, nil)", cur, pend, err)
	}

	// DownAll on issue does NOT touch vault.
	reverted, err := issueRunner.DownAll(ctx)
	if err != nil || reverted != 2 {
		t.Fatalf("issue DownAll = (%d, %v), want (2, nil)", reverted, err)
	}
	if sqliteObjectExists(t, db, "table", "issue_tbl") {
		t.Fatal("issue_tbl should be dropped")
	}
	if !sqliteObjectExists(t, db, "table", "vault_tbl") {
		t.Fatal("vault_tbl should remain intact")
	}
	if cur, pend, err := vaultRunner.Version(ctx); err != nil || cur != 1 || pend != 0 {
		t.Fatalf("vault Version after issue DownAll = (%d, %d, %v), want (1, 0, nil)", cur, pend, err)
	}
}

func TestMidMigrationRollbackAndChecksumMismatch(t *testing.T) {
	ctx := context.Background()
	db := openTestSQLite(t)

	fsFailing := fstest.MapFS{
		"migrations/0001_ok.up.sql":   {Data: []byte("CREATE TABLE users (id INTEGER PRIMARY KEY);")},
		"migrations/0001_ok.down.sql": {Data: []byte("DROP TABLE users;")},
		"migrations/0002_fail_midway.up.sql": {Data: []byte(`
			CREATE TABLE temp_should_rollback (id INTEGER PRIMARY KEY);
			INSERT INTO table_that_does_not_exist VALUES (1);
		`)},
		"migrations/0002_fail_midway.down.sql": {Data: []byte("DROP TABLE IF EXISTS temp_should_rollback;")},
	}

	r1, err := migrate.New(db, "app", fsFailing)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	applied, err := r1.Up(ctx)
	if err == nil {
		t.Fatal("expected error when v2 fails mid-migration")
	}
	if applied != 1 {
		t.Fatalf("applied = %d, want 1 before v2 failure", applied)
	}
	if !sqliteObjectExists(t, db, "table", "users") {
		t.Fatal("users table from v1 should exist")
	}
	if sqliteObjectExists(t, db, "table", "temp_should_rollback") {
		t.Fatal("temp_should_rollback should have been rolled back")
	}
	if cur, pend, err := r1.Version(ctx); err != nil || cur != 1 || pend != 1 {
		t.Fatalf("Version after rollback = (%d, %d, %v), want (1, 1, nil)", cur, pend, err)
	}

	// Now fix v2 and apply cleanly.
	fsClean := fstest.MapFS{
		"migrations/0001_ok.up.sql":      {Data: []byte("CREATE TABLE users (id INTEGER PRIMARY KEY);")},
		"migrations/0001_ok.down.sql":    {Data: []byte("DROP TABLE users;")},
		"migrations/0002_fixed.up.sql":   {Data: []byte("CREATE TABLE posts (id INTEGER PRIMARY KEY);")},
		"migrations/0002_fixed.down.sql": {Data: []byte("DROP TABLE posts;")},
	}
	r2, err := migrate.New(db, "app", fsClean)
	if err != nil {
		t.Fatalf("New clean: %v", err)
	}
	applied, err = r2.Up(ctx)
	if err != nil || applied != 1 {
		t.Fatalf("Up clean = (%d, %v), want (1, nil)", applied, err)
	}

	// Modify already-applied v1 with zero pending migrations -> must still fail with ErrChecksumMismatch.
	fsTamperedZeroPending := fstest.MapFS{
		"migrations/0001_ok.up.sql":      {Data: []byte("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);")},
		"migrations/0001_ok.down.sql":    {Data: []byte("DROP TABLE users;")},
		"migrations/0002_fixed.up.sql":   {Data: []byte("CREATE TABLE posts (id INTEGER PRIMARY KEY);")},
		"migrations/0002_fixed.down.sql": {Data: []byte("DROP TABLE posts;")},
	}
	rTamperedZero, err := migrate.New(db, "app", fsTamperedZeroPending)
	if err != nil {
		t.Fatalf("New tampered zero pending: %v", err)
	}
	if applied, err := rTamperedZero.Up(ctx); !errors.Is(err, migrate.ErrChecksumMismatch) || applied != 0 {
		t.Fatalf("Up tampered (0 pending) = (%d, %v), want (0, ErrChecksumMismatch)", applied, err)
	}

	// Modify already-applied v1 and add v3 -> must fail with ErrChecksumMismatch and NOT apply v3.
	fsTampered := fstest.MapFS{
		"migrations/0001_ok.up.sql":      {Data: []byte("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);")},
		"migrations/0001_ok.down.sql":    {Data: []byte("DROP TABLE users;")},
		"migrations/0002_fixed.up.sql":   {Data: []byte("CREATE TABLE posts (id INTEGER PRIMARY KEY);")},
		"migrations/0002_fixed.down.sql": {Data: []byte("DROP TABLE posts;")},
		"migrations/0003_extra.up.sql":   {Data: []byte("CREATE TABLE never_applied (id INTEGER PRIMARY KEY);")},
		"migrations/0003_extra.down.sql": {Data: []byte("DROP TABLE never_applied;")},
	}
	r3, err := migrate.New(db, "app", fsTampered)
	if err != nil {
		t.Fatalf("New tampered: %v", err)
	}
	applied, err = r3.Up(ctx)
	if !errors.Is(err, migrate.ErrChecksumMismatch) {
		t.Fatalf("Up tampered err = %v, want ErrChecksumMismatch", err)
	}
	if applied != 0 {
		t.Fatalf("Up tampered applied = %d, want 0", applied)
	}
	if sqliteObjectExists(t, db, "table", "never_applied") {
		t.Fatal("v3 must not execute after v1 checksum mismatch")
	}
}

func TestDownRollbackOnMidStatementFailure(t *testing.T) {
	ctx := context.Background()
	db := openTestSQLite(t)

	fsys := fstest.MapFS{
		"migrations/0001_tbl.up.sql": {Data: []byte("CREATE TABLE keep_me (id INTEGER PRIMARY KEY);")},
		"migrations/0001_tbl.down.sql": {Data: []byte(`
			DROP TABLE keep_me;
			DELETE FROM missing_table_causes_abort;
		`)},
	}
	runner, err := migrate.New(db, "app", fsys)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if applied, err := runner.Up(ctx); err != nil || applied != 1 {
		t.Fatalf("Up = (%d, %v), want (1, nil)", applied, err)
	}

	reverted, err := runner.Down(ctx, 1)
	if err == nil {
		t.Fatal("expected Down error on missing table")
	}
	if reverted != 0 {
		t.Fatalf("reverted = %d, want 0", reverted)
	}
	if !sqliteObjectExists(t, db, "table", "keep_me") {
		t.Fatal("keep_me table should remain after failed Down rollback")
	}
	if cur, pend, err := runner.Version(ctx); err != nil || cur != 1 || pend != 0 {
		t.Fatalf("Version after failed Down = (%d, %d, %v), want (1, 0, nil)", cur, pend, err)
	}
}

func TestRunnerValidationErrors(t *testing.T) {
	ctx := context.Background()
	fsys := fstest.MapFS{
		"migrations/0001_a.up.sql":   {Data: []byte("CREATE TABLE a (id INT);")},
		"migrations/0001_a.down.sql": {Data: []byte("DROP TABLE a;")},
	}

	if _, err := migrate.New(nil, "s", fsys); err == nil {
		t.Fatal("expected error for nil db")
	}
	db := openTestSQLite(t)
	if _, err := migrate.New(db, "   ", fsys); err == nil {
		t.Fatal("expected error for empty scope")
	}
	if _, err := migrate.New(db, "s", fsys, migrate.WithDialect(migrate.Dialect(99))); err == nil {
		t.Fatal("expected error for invalid dialect")
	}

	runner, err := migrate.New(db, "s", fsys)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := runner.UpSteps(ctx, -1); err == nil {
		t.Fatal("expected error for negative UpSteps")
	}
	if _, err := runner.Down(ctx, -1); err == nil {
		t.Fatal("expected error for negative Down steps")
	}
}

func TestPostgresDialectPlaceholders(t *testing.T) {
	ctx := context.Background()
	rec := &spyPGConnector{}
	db := sql.OpenDB(rec)
	defer db.Close()

	fsys := fstest.MapFS{
		"migrations/0001_pg.up.sql":   {Data: []byte("CREATE TABLE pg_tbl (id BIGINT PRIMARY KEY);")},
		"migrations/0001_pg.down.sql": {Data: []byte("DROP TABLE pg_tbl;")},
	}
	runner, err := migrate.New(db, "pgscope", fsys, migrate.WithDialect(migrate.DialectPostgres), migrate.WithClock(func() int64 { return 777 }))
	if err != nil {
		t.Fatalf("New pg: %v", err)
	}

	if applied, err := runner.Up(ctx); err != nil || applied != 1 {
		t.Fatalf("pg Up = (%d, %v), want (1, nil)", applied, err)
	}
	if reverted, err := runner.Down(ctx, 1); err != nil || reverted != 1 {
		t.Fatalf("pg Down = (%d, %v), want (1, nil)", reverted, err)
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()
	var sawSelect, sawInsert, sawDelete bool
	for _, q := range rec.queries {
		if strings.Contains(q, "?") {
			t.Fatalf("Postgres dialect emitted '?' placeholder in %q", q)
		}
		if strings.Contains(q, "SELECT version, name, checksum, applied_at_ms FROM schema_migrations WHERE scope = $1") {
			sawSelect = true
		}
		if strings.Contains(q, "INSERT INTO schema_migrations") && strings.Contains(q, "VALUES ($1, $2, $3, $4, $5)") {
			sawInsert = true
		}
		if strings.Contains(q, "DELETE FROM schema_migrations WHERE scope = $1 AND version = $2") {
			sawDelete = true
		}
	}
	if !sawSelect || !sawInsert || !sawDelete {
		t.Fatalf("missing expected Postgres placeholder queries: select=%v insert=%v delete=%v queries=%v", sawSelect, sawInsert, sawDelete, rec.queries)
	}
}

type spyPGConnector struct {
	mu      sync.Mutex
	queries []string
	rows    []spyMRow
}

type spyMRow struct {
	scope       string
	version     int64
	name        string
	checksum    string
	appliedAtMs int64
}

func (c *spyPGConnector) Connect(context.Context) (driver.Conn, error) {
	return &spyPGConn{parent: c}, nil
}

func (c *spyPGConnector) Driver() driver.Driver { return nil }

type spyPGConn struct {
	parent *spyPGConnector
}

func (c *spyPGConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("unused") }
func (c *spyPGConn) Close() error                        { return nil }
func (c *spyPGConn) Begin() (driver.Tx, error)           { return &spyPGTx{}, nil }
func (c *spyPGConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return &spyPGTx{}, nil
}

func (c *spyPGConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.parent.mu.Lock()
	defer c.parent.mu.Unlock()
	c.parent.queries = append(c.parent.queries, query)

	switch {
	case strings.Contains(query, "INSERT INTO schema_migrations"):
		c.parent.rows = append(c.parent.rows, spyMRow{
			scope:       args[0].Value.(string),
			version:     args[1].Value.(int64),
			name:        args[2].Value.(string),
			checksum:    args[3].Value.(string),
			appliedAtMs: args[4].Value.(int64),
		})
	case strings.Contains(query, "DELETE FROM schema_migrations"):
		scope := args[0].Value.(string)
		ver := args[1].Value.(int64)
		kept := c.parent.rows[:0]
		for _, r := range c.parent.rows {
			if r.scope == scope && r.version == ver {
				continue
			}
			kept = append(kept, r)
		}
		c.parent.rows = kept
	}
	return driver.RowsAffected(1), nil
}

func (c *spyPGConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.parent.mu.Lock()
	defer c.parent.mu.Unlock()
	c.parent.queries = append(c.parent.queries, query)

	scope := args[0].Value.(string)
	var matched []spyMRow
	for _, r := range c.parent.rows {
		if r.scope == scope {
			matched = append(matched, r)
		}
	}
	return &spyPGRows{rows: matched}, nil
}

type spyPGTx struct{}

func (t *spyPGTx) Commit() error   { return nil }
func (t *spyPGTx) Rollback() error { return nil }

type spyPGRows struct {
	rows []spyMRow
	idx  int
}

func (r *spyPGRows) Columns() []string {
	return []string{"version", "name", "checksum", "applied_at_ms"}
}
func (r *spyPGRows) Close() error { return nil }
func (r *spyPGRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	row := r.rows[r.idx]
	r.idx++
	dest[0] = row.version
	dest[1] = row.name
	dest[2] = row.checksum
	dest[3] = row.appliedAtMs
	return nil
}
