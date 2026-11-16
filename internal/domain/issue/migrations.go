package issue

import "embed"

// MigrationsFS holds the embedded SQLite schema migrations for the issue domain.
//
//go:embed migrations/*.sql
var MigrationsFS embed.FS
