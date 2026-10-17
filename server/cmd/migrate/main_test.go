package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestNewTakesTheNumberAfterTheHighest(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"0001_schema.sql", "0003_add_label.sql", "notes.txt"} {
		os.WriteFile(filepath.Join(dir, name), nil, 0o644)
	}
	if err := create(dir, "add_due"); err != nil {
		t.Fatal(err)
	}
	if err := create(dir, "Add-Due"); err == nil {
		t.Fatal("a name with capitals and dashes was taken")
	}
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if want := []string{"0001_schema.sql", "0003_add_label.sql", "0004_add_due.sql", "notes.txt"}; !slices.Equal(names, want) {
		t.Fatalf("files %q, want %q", names, want)
	}
}
