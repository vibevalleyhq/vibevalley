package base

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vibevalley/internal/testkit"
	"vibevalley/migrations"
)

func TestDBMadeOnceAndOpenedAgain(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vibevalley.db")
	db, err := OpenDB(path)
	if err != nil {
		t.Fatal(err)
	}
	var version int
	db.QueryRow("pragma user_version").Scan(&version)
	testkit.Eq(t, version, len(migrations.Names()), "every migration ran")
	if _, err := db.Exec("insert into issue (id, number, description, created_at) values ('t1', 1, '', 1)"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	again, err := OpenDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	var n int
	again.QueryRow("select count(*) from issue").Scan(&n)
	testkit.Eq(t, n, 1, "kept")
}

func TestDBRefusesASchemaItDoesNotKnow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vibevalley.db")
	db, err := OpenDB(path)
	if err != nil {
		t.Fatal(err)
	}
	db.Exec("pragma user_version = 9")
	db.Close()
	if _, err := OpenDB(path); err == nil || !strings.Contains(err.Error(), "does not know") {
		t.Fatalf("opened: %v", err)
	}
}

func TestDBPathTreatsURICharactersAsFilename(t *testing.T) {
	path := filepath.Join(t.TempDir(), "farm?mode=ro#%.db")
	db, err := OpenDB(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}
