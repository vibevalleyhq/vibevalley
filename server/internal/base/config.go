package base

import (
	"os"
	"path/filepath"
)

// Config is where the farm keeps its things and where helpers work.
type Config struct {
	// Home is $VIBEVALLEY_HOME: settings, the farm's state, the database.
	Home string
	// WorkRoot is $VIBEVALLEY_WORK_ROOT: the projects helpers work in.
	WorkRoot string
	// DBPath is the database file; ":memory:" in tests. Empty: Home/farm.db.
	DBPath  string
	Version string
}

// DefaultConfig reads VIBEVALLEY_HOME, VIBEVALLEY_WORK_ROOT and VIBEVALLEY_DB, defaulting to ~/.vibevalley,
// ~/vibevalley-work and Home/farm.db. A farm kept under the project's old names is moved here once by
// `vibevalley migrate` (migrate.go); nothing else reads the old names.
func DefaultConfig() Config {
	home, _ := os.UserHomeDir()
	cfg := Config{Home: filepath.Join(home, ".vibevalley"), WorkRoot: filepath.Join(home, "vibevalley-work"), Version: "0.1.0"}
	if v := os.Getenv("VIBEVALLEY_HOME"); v != "" {
		cfg.Home = v
	}
	if v := os.Getenv("VIBEVALLEY_WORK_ROOT"); v != "" {
		cfg.WorkRoot = v
	}
	cfg.DBPath = dbPathFrom(os.Getenv("VIBEVALLEY_DB"))
	return cfg
}

// dbPathFrom reads VIBEVALLEY_DB: `memory` keeps the database in memory, as the TypeScript server's did; a folder (the
// TypeScript server's VIBEVALLEY_DB was PGlite's folder) holds farm.db; anything else is the file. Empty: Home/farm.db.
func dbPathFrom(v string) string {
	switch {
	case v == "":
		return ""
	case v == "memory":
		return ":memory:"
	}
	if info, err := os.Stat(v); err == nil && info.IsDir() {
		return filepath.Join(v, "farm.db")
	}
	return v
}
