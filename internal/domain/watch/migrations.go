package watch

import "embed"

// MigrationsFS holds the embedded SQLite schema migrations for the watch domain.
//
//go:embed migrations/*.sql
var MigrationsFS embed.FS
