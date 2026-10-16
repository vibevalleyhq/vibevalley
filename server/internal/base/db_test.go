package base

import (
	"database/sql"
	"path/filepath"
	"testing"

	"vibevalley/internal/farmtest"
	"vibevalley/migrations"
)

// A database made before issues had titles: its issues are split into a title and a description, and a copy of it as
// it was stays beside it.
func TestDBMigratesIssueTitles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "farm.db")
	old, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	names := []string{"0001_farm.sql", "0002_lan.sql", "0003_backlog.sql", "0004_backlog_order.sql", "0005_backlog_queue.sql", "0006_issue.sql"}
	for _, name := range names {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := old.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	for _, q := range []string{
		"pragma user_version = 6",
		"insert into issue (id, text, created_at) values ('t1', '  写打卡\n\n细节在 README\n', 1), ('t2', '一行', 2)",
	} {
		if _, err := old.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	old.Close()
	db, err := OpenDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	got := map[string][2]string{}
	rows, err := db.Query("select id, title, description from issue")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, title, description string
		if err := rows.Scan(&id, &title, &description); err != nil {
			t.Fatal(err)
		}
		got[id] = [2]string{title, description}
	}
	farmtest.Eq(t, got, map[string][2]string{"t1": {"写打卡", "细节在 README"}, "t2": {"一行", ""}}, "split")
	copied, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path+".v6"))
	if err != nil {
		t.Fatal(err)
	}
	defer copied.Close()
	var text string
	if err := copied.QueryRow("select text from issue where id = 't2'").Scan(&text); err != nil {
		t.Fatalf("the copy as it was: %v", err)
	}
}
