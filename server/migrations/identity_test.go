package migrations

import (
	"database/sql"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	_ "modernc.org/sqlite"
)

func fileDSN(path string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
}

func legacyDatabase(t *testing.T, dsn string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	schema, err := fs.ReadFile(embedded, "0001_schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	// The baseline is one file; the upgrade path is tested against a next migration of the test's own.
	FS = fstest.MapFS{"0001_schema.sql": {Data: schema}, "0002_next.sql": {Data: []byte("ALTER TABLE connector_inbound ADD COLUMN probe text not null default '';")}}
	t.Cleanup(func() { FS = embedded })
	if _, err := db.Exec(string(schema)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO issue(id,number,title,description,created_at) VALUES('kept',1,'original','',1); PRAGMA user_version=1`); err != nil {
		t.Fatal(err)
	}
	return db
}

func assertVersion(t *testing.T, db *sql.DB, want int) {
	t.Helper()
	got, err := Version(db)
	if err != nil || got != want {
		t.Fatalf("version=%d want %d: %v", got, want, err)
	}
}

func assertOriginalBackup(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", fileDSN(path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	assertVersion(t, db, 1)
	var title string
	if err := db.QueryRow(`select title from issue where id='kept'`).Scan(&title); err != nil || title != "original" {
		t.Fatalf("backup payload=%q: %v", title, err)
	}
}

func TestUpOwnsActualMainFileAndOriginalBackup(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "actual.db")
	other := filepath.Join(dir, "attached.db")
	db := legacyDatabase(t, fileDSN(main))
	if _, err := db.Exec("attach database ? as other", other); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("pragma other.user_version=999"); err != nil {
		t.Fatal(err)
	}
	ran, err := Up(db)
	if err != nil || len(ran) != len(Names())-1 {
		t.Fatalf("upgrade: %v %v", ran, err)
	}
	assertVersion(t, db, len(Names()))
	assertOriginalBackup(t, main+".v1")
	if _, err := os.Stat(other + ".v1"); !os.IsNotExist(err) {
		t.Fatalf("backup associated with attached database: %v", err)
	}
	if _, err := db.Exec(`update issue set title='after upgrade' where id='kept'`); err != nil {
		t.Fatal(err)
	}
	ran, err = Up(db)
	if err != nil || len(ran) != 0 {
		t.Fatalf("repeat: %v %v", ran, err)
	}
	assertOriginalBackup(t, main+".v1")
}

func TestUpResolvesRelativeAndEscapedPathsFromSQLite(t *testing.T) {
	t.Run("relative path survives cwd change", func(t *testing.T) {
		dir := t.TempDir()
		t.Chdir(dir)
		db := legacyDatabase(t, "relative.db")
		elsewhere := t.TempDir()
		t.Chdir(elsewhere)
		if _, err := Up(db); err != nil {
			t.Fatal(err)
		}
		assertOriginalBackup(t, filepath.Join(dir, "relative.db.v1"))
		if _, err := os.Stat(filepath.Join(elsewhere, "relative.db.v1")); !os.IsNotExist(err) {
			t.Fatalf("backup followed caller cwd: %v", err)
		}
	})
	t.Run("URI escaping", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "农场 with space ?mode=ro#%.db")
		db := legacyDatabase(t, fileDSN(path))
		if _, err := Up(db); err != nil {
			t.Fatal(err)
		}
		assertOriginalBackup(t, path+".v1")
	})
}

func TestUpDetectsMemoryDatabasesWithoutCallerHints(t *testing.T) {
	for _, dsn := range []string{":memory:", "file::memory:?cache=shared", "file:owned-memory?mode=memory&cache=shared", ""} {
		t.Run(fmt.Sprintf("dsn=%s", dsn), func(t *testing.T) {
			dir := t.TempDir()
			t.Chdir(dir)
			db := legacyDatabase(t, dsn)
			if _, err := Up(db); err != nil {
				t.Fatal(err)
			}
			assertVersion(t, db, len(Names()))
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 0 {
				t.Fatalf("memory/temp database left backup artifacts: %v %v", entries, err)
			}
		})
	}
}

func TestUpBackupFailureDoesNotBeginMigrations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "farm.db")
	db := legacyDatabase(t, fileDSN(path))
	// SQLite refuses VACUUM while this connection already has a transaction.
	if _, err := db.Exec("begin"); err != nil {
		t.Fatal(err)
	}
	if _, err := Up(db); err == nil || !strings.Contains(err.Error(), "copy before migrating") {
		t.Fatalf("backup failure: %v", err)
	}
	if _, err := db.Exec("rollback"); err != nil {
		t.Fatal(err)
	}
	assertVersion(t, db, 1)
	var count int
	if err := db.QueryRow(`select count(*) from pragma_table_info('connector_inbound') where name='probe'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("migration ran despite failed backup: %d %v", count, err)
	}
}

func TestUpRollsBackBrokenMigrationAndRestoresForeignKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "farm.db")
	db := legacyDatabase(t, fileDSN(path))
	if _, err := db.Exec(`create table orphan(parent text references issue(id)); insert into orphan values('missing'); pragma foreign_keys=on`); err != nil {
		t.Fatal(err)
	}
	if _, err := Up(db); err == nil || !strings.Contains(err.Error(), "foreign key broken") {
		t.Fatalf("foreign-key failure: %v", err)
	}
	assertVersion(t, db, 1)
	assertOriginalBackup(t, path+".v1")
	var enabled, count int
	if err := db.QueryRow("pragma foreign_keys").Scan(&enabled); err != nil || enabled != 1 {
		t.Fatalf("foreign keys: %d %v", enabled, err)
	}
	if err := db.QueryRow(`select count(*) from pragma_table_info('connector_inbound') where name='probe'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed migration leaked schema: %d %v", count, err)
	}
	if _, err := db.Exec("delete from orphan"); err != nil {
		t.Fatal(err)
	}
	if _, err := Up(db); err != nil {
		t.Fatal(err)
	}
	assertVersion(t, db, len(Names()))
	assertOriginalBackup(t, path+".v1")
}
