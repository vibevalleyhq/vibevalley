package farm

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"vibevalley/internal/base"
)

// Moving a farm from the TypeScript server (apps/server, removed) to this one. The TypeScript server kept the same
// files in its home (farm.json, config.json, crew.json, spend.json, settings.json, .env, foreman/, steps/, logs/…),
// which are copied as they are, and its database in PGlite (<home>/db), which only Node can open: tool/dump-pglite.ts
// writes it out as JSON, and Import puts those rows into SQLite with the same ids and seq numbers, so threads, read
// cursors, deliveries and the connectors' outbox stay pointed at the right messages. The tables are the same, column
// for column (migrations/0001_farm.sql folds the PostgreSQL migrations); only the types change: timestamptz →
// milliseconds, jsonb → JSON text, boolean → 0/1.

// ImportOptions is what to import and where.
type ImportOptions struct {
	// From is the TypeScript server's home (~/.heybro, ~/.heybro-beta, ~/.heybro-alpha).
	From string
	// Into is this server's home; created when missing.
	Into string
	// Dump is tool/dump-pglite.ts's JSON of From's database. Required when From has a database.
	Dump string
	// Force imports into a farm that already has things in it: its database is replaced, its files overwritten.
	Force bool
}

// ImportReport is what was imported: names and counts only, never what the files or rows say.
type ImportReport struct {
	Files []string
	// Tables is each table's rows in the dump and in farm.db after the import.
	Tables []ImportTable
	// Skipped is what the dump had that this server does not keep (the PostgreSQL migrator's own table).
	Skipped []string
}

type ImportTable struct {
	Name           string
	Dumped, Stored int
}

// importDump is tool/dump-pglite.ts's output.
type importDump struct {
	Format    string                     `json:"format"`
	Version   int                        `json:"version"`
	Tables    map[string]importDumpTable `json:"tables"`
	Sequences map[string]int64           `json:"sequences"`
}

type importDumpTable struct {
	Columns []struct {
		Name string `json:"name"`
		Type string `json:"type"`
	} `json:"columns"`
	Rows []map[string]json.RawMessage `json:"rows"`
}

// importTables is farm.db's tables in an order where what a row points at comes first (the foreign keys are also
// deferred to the commit: conversations and messages point at each other).
var importTables = []string{
	"participants", "conversations", "messages", "mentions", "follows", "read_cursors", "seen_marks", "deliveries",
	"playbook_events", "ledger", "memories", "connector_accounts", "connector_inbound", "connector_outbox", "schedules",
}

// importNotKept is what a dump may have that is not the farm's: the PostgreSQL migrator's bookkeeping.
var importNotKept = []string{"effect_sql_migrations"}

// importLeftBehind is what is not copied from the TypeScript home: its database (the dump carries it) and the dump.
var importLeftBehind = []string{"db", "pglite-dump.json"}

// DumpCommand is how to make the dump of a TypeScript home's database.
func DumpCommand(from string) string {
	return fmt.Sprintf("node server/tool/dump-pglite.ts %s %s", from, filepath.Join(from, "pglite-dump.json"))
}

// Import copies a TypeScript server's farm into this server's home. The server must not be running on Into.
func Import(opts ImportOptions) (ImportReport, error) {
	var report ImportReport
	if opts.From == "" || opts.Into == "" {
		return report, errors.New("import: the TypeScript home and --into are both required")
	}
	from, err := filepath.Abs(opts.From)
	if err != nil {
		return report, err
	}
	into, err := filepath.Abs(opts.Into)
	if err != nil {
		return report, err
	}
	if from == into {
		return report, errors.New("import: the Go farm needs a home of its own, not the TypeScript server's")
	}
	if !importLooksLikeHome(from) {
		return report, fmt.Errorf("import: %s is not a heybro home (no farm.json, config.json or db/)", from)
	}
	hasDB := importExists(filepath.Join(from, "db", "PG_VERSION"))
	var dump *importDump
	switch {
	case opts.Dump != "":
		if dump, err = importReadDump(opts.Dump); err != nil {
			return report, err
		}
	case hasDB:
		return report, fmt.Errorf("import: %s has a PGlite database; dump it first and pass --dump:\n  %s", from, DumpCommand(from))
	}
	if !opts.Force {
		if why := importHasFarm(into); why != "" {
			return report, fmt.Errorf("import: %s already has a farm (%s); --force replaces it", into, why)
		}
	}
	if err := os.MkdirAll(into, 0o755); err != nil {
		return report, err
	}
	if report.Files, err = importCopy(from, into); err != nil {
		return report, err
	}
	// A fresh database: what an earlier start of this server put there (the square, the three participants) would
	// clash with the dump's rows of the same.
	dbPath := filepath.Join(into, "farm.db")
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(dbPath + suffix); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return report, err
		}
	}
	db, err := base.OpenDB(dbPath)
	if err != nil {
		return report, err
	}
	defer db.Close()
	if dump != nil {
		if report.Tables, report.Skipped, err = importRows(db, dump); err != nil {
			return report, err
		}
	}
	db.Close()
	// The TypeScript server called the farm's own runtime "heybro", as the project was called then.
	if _, err := rewriteHome(into, oldIDReplacements()); err != nil {
		return report, err
	}
	return report, nil
}

func importExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func importLooksLikeHome(dir string) bool {
	for _, name := range []string{"farm.json", "config.json", "db"} {
		if importExists(filepath.Join(dir, name)) {
			return true
		}
	}
	return false
}

// importHasFarm says why `into` holds a farm worth keeping; "" when it is empty or only what a first start seeds.
func importHasFarm(into string) string {
	if body, err := os.ReadFile(filepath.Join(into, "farm.json")); err == nil {
		var kept struct {
			Helpers   []json.RawMessage `json:"helpers"`
			Reports   []json.RawMessage `json:"reports"`
			Playbooks []json.RawMessage `json:"playbooks"`
		}
		if json.Unmarshal(body, &kept) != nil || len(kept.Helpers)+len(kept.Reports)+len(kept.Playbooks) > 0 {
			return "farm.json"
		}
	}
	if entries, err := os.ReadDir(filepath.Join(into, "steps")); err == nil && len(entries) > 0 {
		return "steps/"
	}
	dbPath := filepath.Join(into, "farm.db")
	if !importExists(dbPath) {
		return ""
	}
	db, err := base.OpenDB(dbPath)
	if err != nil {
		return "farm.db, unreadable"
	}
	defer db.Close()
	for _, table := range []string{"messages", "ledger", "memories", "schedules", "playbook_events", "connector_accounts"} {
		var n int
		if err := db.QueryRow("select count(*) from " + table).Scan(&n); err != nil || n > 0 {
			return "farm.db: " + table
		}
	}
	return ""
}

func importReadDump(path string) (*importDump, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("import: the dump: %w", err)
	}
	var dump importDump
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&dump); err != nil {
		return nil, fmt.Errorf("import: the dump is not JSON: %w", err)
	}
	if dump.Format != "heybro-pglite-dump" || dump.Version != 1 {
		return nil, fmt.Errorf("import: %s is not a dump from tool/dump-pglite.ts (format %q, version %d)", path, dump.Format, dump.Version)
	}
	return &dump, nil
}

// importCopy copies the TypeScript home's files, all but its database, keeping each file's mode (settings.json and
// .env stay readable by their owner only). It returns the top-level names copied.
func importCopy(from, into string) ([]string, error) {
	entries, err := os.ReadDir(from)
	if err != nil {
		return nil, err
	}
	var copied []string
	for _, e := range entries {
		if slices.Contains(importLeftBehind, e.Name()) || strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		if err := importCopyTree(filepath.Join(from, e.Name()), filepath.Join(into, e.Name())); err != nil {
			return copied, fmt.Errorf("import: copying %s: %w", e.Name(), err)
		}
		copied = append(copied, e.Name())
	}
	return copied, nil
}

func importCopyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			return os.MkdirAll(target, info.Mode().Perm()|0o700)
		case info.Mode().IsRegular():
			return importCopyFile(path, target, info.Mode().Perm())
		default:
			// Sockets, links: nothing the farm keeps.
			return nil
		}
	})
}

func importCopyFile(src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chmod(dst, mode)
}

// importColumn is a farm.db column as SQLite describes it.
type importColumn struct {
	name    string
	notNull bool
}

// importRows puts the dump's rows into farm.db in one transaction, then sets each table's autoincrement to where the
// PostgreSQL sequence stood: a seq handed out once (a message deleted since) is never handed out again.
func importRows(db *sql.DB, dump *importDump) ([]ImportTable, []string, error) {
	var skipped []string
	for name := range dump.Tables {
		if !slices.Contains(importTables, name) {
			if !slices.Contains(importNotKept, name) {
				return nil, nil, fmt.Errorf("import: the dump has a table this server does not know: %s", name)
			}
			skipped = append(skipped, name)
		}
	}
	slices.Sort(skipped)
	tx, err := db.Begin()
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("pragma defer_foreign_keys = on"); err != nil {
		return nil, nil, err
	}
	var tables []ImportTable
	for _, name := range importTables {
		t, ok := dump.Tables[name]
		if !ok {
			continue
		}
		columns, err := importColumns(tx, name)
		if err != nil {
			return nil, nil, err
		}
		types := map[string]string{}
		for _, c := range t.Columns {
			types[c.Name] = c.Type
			if !slices.ContainsFunc(columns, func(k importColumn) bool { return k.name == c.Name }) {
				return nil, nil, fmt.Errorf("import: %s.%s is in the dump but not in farm.db", name, c.Name)
			}
		}
		var names []string
		for _, c := range columns {
			if _, ok := types[c.name]; ok {
				names = append(names, c.name)
			}
		}
		insert := fmt.Sprintf("insert into %s (%s) values (%s)", name, strings.Join(names, ", "), base.Placeholders(len(names)))
		for i, row := range t.Rows {
			args := make([]any, len(names))
			for j, col := range names {
				notNull := columns[slices.IndexFunc(columns, func(k importColumn) bool { return k.name == col })].notNull
				if args[j], err = importValue(row[col], types[col], notNull); err != nil {
					return nil, nil, fmt.Errorf("import: %s row %d, %s: %w", name, i+1, col, err)
				}
			}
			if _, err := tx.Exec(insert, args...); err != nil {
				return nil, nil, fmt.Errorf("import: %s row %d: %w", name, i+1, err)
			}
		}
		tables = append(tables, ImportTable{Name: name, Dumped: len(t.Rows)})
	}
	for key, last := range dump.Sequences {
		table, column, ok := strings.Cut(key, ".")
		if !ok || !slices.Contains(importTables, table) {
			continue
		}
		var highest sql.NullInt64
		if err := tx.QueryRow(fmt.Sprintf("select max(%s) from %s", column, table)).Scan(&highest); err != nil {
			return nil, nil, fmt.Errorf("import: sequence %s: %w", key, err)
		}
		seq := max(last, highest.Int64)
		if seq <= 0 {
			continue
		}
		if _, err := tx.Exec("delete from sqlite_sequence where name = ?", table); err != nil {
			return nil, nil, err
		}
		if _, err := tx.Exec("insert into sqlite_sequence (name, seq) values (?, ?)", table, seq); err != nil {
			return nil, nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, fmt.Errorf("import: %w", err)
	}
	for i := range tables {
		if err := db.QueryRow("select count(*) from " + tables[i].Name).Scan(&tables[i].Stored); err != nil {
			return nil, nil, err
		}
	}
	return tables, skipped, nil
}

func importColumns(q interface {
	Query(string, ...any) (*sql.Rows, error)
}, table string) ([]importColumn, error) {
	rows, err := q.Query("select name, \"notnull\" from pragma_table_info(?) order by cid", table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []importColumn
	for rows.Next() {
		var c importColumn
		if err := rows.Scan(&c.name, &c.notNull); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// importValue is a dumped value as farm.db keeps it, by its PostgreSQL type.
func importValue(raw json.RawMessage, pgType string, notNull bool) (any, error) {
	isNull := len(raw) == 0 || string(raw) == "null"
	switch pgType {
	case "jsonb", "json":
		// SQL null and JSON null both come out of PGlite as null: a column that cannot be null held JSON's.
		if isNull {
			if notNull {
				return "null", nil
			}
			return nil, nil
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, raw); err != nil {
			return nil, err
		}
		return compact.String(), nil
	}
	if isNull {
		return nil, nil
	}
	switch pgType {
	case "timestamp with time zone", "timestamp without time zone", "integer", "bigint", "smallint":
		var n json.Number
		if err := json.Unmarshal(raw, &n); err != nil {
			return nil, fmt.Errorf("not a number: %w", err)
		}
		v, err := n.Int64()
		if err != nil {
			f, ferr := n.Float64()
			if ferr != nil {
				return nil, err
			}
			v = int64(f)
		}
		return v, nil
	case "boolean":
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		if b {
			return int64(1), nil
		}
		return int64(0), nil
	case "text", "character varying":
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, err
		}
		return s, nil
	default:
		return nil, fmt.Errorf("a column of type %s this import does not know", pgType)
	}
}
