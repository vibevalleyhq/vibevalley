// The farm's schema by hand. The server brings its database up to date at start too; this is for looking, and for writing
// the next migration. The database is the server's: db in the configuration, as cmd/server reads it.
//
//	go run ./cmd/migrate status              # which version the database is at, and what has not run
//	go run ./cmd/migrate up                  # run what has not run (a copy of the database is kept beside it first)
//	go run ./cmd/migrate new add_label       # write migrations/000N_add_label.sql, the next one; run from server/
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"vibevalley/internal/base"
	"vibevalley/migrations"
)

func main() {
	configFile := flag.String("config", "", "the YAML configuration (default $VIBEVALLEY_HOME/vibevalley.yaml, if it is there)")
	dir := flag.String("dir", "migrations", "where new writes the file: the migrations folder of the source")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: migrate [--config FILE] status | up | new NAME")
		flag.PrintDefaults()
	}
	flag.Parse()
	args := flag.Args()
	if len(args) == 0 {
		flag.Usage()
		os.Exit(2)
	}
	var err error
	switch args[0] {
	case "status":
		err = status(*configFile)
	case "up":
		err = up(*configFile)
	case "new":
		if len(args) != 2 {
			flag.Usage()
			os.Exit(2)
		}
		err = create(*dir, args[1])
	default:
		flag.Usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "migrate:", err)
		os.Exit(1)
	}
}

func dbPath(configFile string) (string, error) {
	cfg, err := base.LoadConfig(configFile)
	if err != nil {
		return "", err
	}
	return cfg.DB(), nil
}

func status(configFile string) error {
	path, err := dbPath(configFile)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err != nil {
		fmt.Printf("%s: not made yet; the server or migrate up makes it\n", path)
		return nil
	}
	db, err := base.OpenDBAsIs(path)
	if err != nil {
		return err
	}
	defer db.Close()
	done, err := migrations.Version(db)
	if err != nil {
		return err
	}
	names := migrations.Names()
	fmt.Printf("%s: version %d of %d\n", path, done, len(names))
	if done > len(names) {
		fmt.Println("  newer than these migrations: a newer server made it")
	}
	for i, name := range names {
		mark := "ran"
		if i >= done {
			mark = "to run"
		}
		fmt.Printf("  %-6s  %s\n", mark, name)
	}
	return nil
}

func up(configFile string) error {
	path, err := dbPath(configFile)
	if err != nil {
		return err
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
	}
	db, err := base.OpenDBAsIs(path)
	if err != nil {
		return err
	}
	defer db.Close()
	ran, err := migrations.Up(db, path)
	for _, name := range ran {
		fmt.Println("ran", name)
	}
	if err != nil {
		return err
	}
	if len(ran) == 0 {
		fmt.Printf("%s is up to date\n", path)
	}
	return nil
}

var (
	nameOK   = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	numbered = regexp.MustCompile(`^(\d{4})_.*\.sql$`)
)

// The number after the highest in dir: the embedded list is the built one, and the file is for the next build.
func create(dir, name string) error {
	if !nameOK.MatchString(name) {
		return fmt.Errorf("%q: a name is lower case words with underscores, like add_label", name)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("%s: %w (run from server/, or give --dir)", dir, err)
	}
	next := 1
	for _, e := range entries {
		if m := numbered.FindStringSubmatch(e.Name()); m != nil {
			n, _ := strconv.Atoi(m[1])
			next = max(next, n+1)
		}
	}
	path := filepath.Join(dir, fmt.Sprintf("%04d_%s.sql", next, name))
	body := fmt.Sprintf("-- %s. Runs once, after the ones before it, in one transaction; tables are singular.\n", strings.ReplaceAll(name, "_", " "))
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		return err
	}
	fmt.Println("wrote", path)
	fmt.Println("then: sqlc generate (it reads migrations/ as the schema), and the server runs it at its next start")
	return nil
}
