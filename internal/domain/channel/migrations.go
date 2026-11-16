package channel

import "embed"

// MigrationsFS holds the embedded SQLite schema migrations for the channel domain.
//
//go:embed migrations/*.sql
var MigrationsFS embed.FS
