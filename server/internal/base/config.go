package base

import (
	"os"
	"path/filepath"
)

type Config struct {
	Home     string
	WorkRoot string
	// ":memory:" in tests. Empty: Home/farm.db.
	DBPath  string
	Version string
}

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

// `memory` keeps the database in memory; a folder holds farm.db; anything else is the file.
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
