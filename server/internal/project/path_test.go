package project

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkplaceRefusesProjectSymlinkOutsideRoot(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	p := projects(t, root)
	if _, err := p.Workplace("escape", "session", false, ""); err == nil {
		t.Fatal("accepted project outside work root")
	}
	entries, err := os.ReadDir(outside)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("modified outside directory: %v", entries)
	}
}
