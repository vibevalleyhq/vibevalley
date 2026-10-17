package migrations

import (
	"database/sql"
	"os"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// A table is <module> or <module>_<thing>, the module a package in server/internal, so one module's table never takes a name
// another needs; an index starts with its table's name; each table's queries are pkg/db/queries/<table>.sql (AGENTS.md).
func TestNamesFollowTheModules(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := Up(db); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir("../internal")
	if err != nil {
		t.Fatal(err)
	}
	// The foundation, the HTTP layer, the shapes and the test kits own no table.
	notDomains := map[string]bool{"base": true, "handler": true, "protocol": true, "workspace": true, "testkit": true, "golden": true, "mcp": true}
	var modules []string
	for _, e := range entries {
		if e.IsDir() && !notDomains[e.Name()] {
			modules = append(modules, e.Name())
		}
	}
	ofAModule := func(table string) bool {
		for _, m := range modules {
			if table == m || strings.HasPrefix(table, m+"_") {
				return true
			}
		}
		return false
	}
	// A full-text table keeps its index in tables of its own (<table>_data, _idx, _content, _docsize, _config): SQLite's, not
	// a module's, and never queried.
	shadow := map[string]bool{}
	virtual, err := db.Query("select name from sqlite_master where type = 'table' and sql like 'CREATE VIRTUAL TABLE%'")
	if err != nil {
		t.Fatal(err)
	}
	for virtual.Next() {
		var name string
		if err := virtual.Scan(&name); err != nil {
			t.Fatal(err)
		}
		for _, part := range []string{"data", "idx", "content", "docsize", "config"} {
			shadow[name+"_"+part] = true
		}
	}
	virtual.Close()
	rows, err := db.Query("select type, name, tbl_name from sqlite_master where type in ('table', 'index') and name not like 'sqlite_%'")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var kind, name, table string
		if err := rows.Scan(&kind, &name, &table); err != nil {
			t.Fatal(err)
		}
		if shadow[name] || shadow[table] {
			continue
		}
		switch kind {
		case "table":
			if !ofAModule(name) {
				t.Errorf("table %s: name it <module>_<thing> after the package that owns it (%s)", name, strings.Join(modules, ", "))
			}
			if _, err := os.Stat("../pkg/db/queries/" + name + ".sql"); err != nil {
				t.Errorf("table %s has no pkg/db/queries/%s.sql", name, name)
			}
		case "index":
			if !strings.HasPrefix(name, table+"_") {
				t.Errorf("index %s: start it with its table's name, %s_", name, table)
			}
		}
	}
}

// While the architecture is still taking shape, the schema is changed in place, not migrated: the old database is thrown
// away (AGENTS.md「不留兼容」). A second file here would be a migration someone wrote anyway.
func TestTheSchemaIsOneBaseline(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var sqlFiles []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			sqlFiles = append(sqlFiles, e.Name())
		}
	}
	if len(sqlFiles) != 1 || sqlFiles[0] != "0001_schema.sql" {
		t.Fatalf("migrations: %v; change 0001_schema.sql in place and delete the old database instead of adding a migration", sqlFiles)
	}
}
