package db_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sqlc writes generated/<name>.sql.go for each queries/<name>.sql but never removes one: a query file renamed or deleted
// leaves its old Go behind, which still compiles. Each generated query file has its source.
func TestGeneratedHasItsQueries(t *testing.T) {
	files, err := filepath.Glob("generated/*.sql.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("no generated queries: %v", err)
	}
	for _, f := range files {
		source := filepath.Join("queries", strings.TrimSuffix(filepath.Base(f), ".go"))
		if _, err := os.Stat(source); err != nil {
			t.Errorf("%s has no %s: delete it, sqlc does not", f, source)
		}
	}
}
