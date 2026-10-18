// The farm's schema by hand. The server brings its database up to date at start too; this is for looking. The database is
// the server's: db in the configuration, as cmd/server reads it. The schema is one baseline (migrations/0001_schema.sql),
// changed in place: there is no next migration to write.
//
//	go run ./cmd/migrate status              # which version the database is at, and what has not run
//	go run ./cmd/migrate up                  # run what has not run (a copy of the database is kept beside it first)
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"vibevalley/internal/base"
	"vibevalley/migrations"
)

func main() {
	configFile := flag.String("config", "", "the YAML configuration (default $VIBEVALLEY_HOME/vibevalley.yaml, if it is there)")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: migrate [--config FILE] status | up")
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
	ran, err := migrations.Up(db)
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
