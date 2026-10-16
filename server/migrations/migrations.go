// Package migrations: run at start in name order, each once (internal/base/db.go); sqlc reads them as the schema of the queries in pkg/db/queries.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
