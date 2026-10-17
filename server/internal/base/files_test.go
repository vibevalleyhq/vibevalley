package base

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestFileWriterDoesNotFollowAnExistingTemporarySymlink(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	victim := filepath.Join(dir, "other")
	if err := os.WriteFile(victim, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	oldTemp := fmt.Sprintf("%s.%d.1.tmp", path, os.Getpid())
	if err := os.Symlink(victim, oldTemp); err != nil {
		t.Fatal(err)
	}
	if err := NewFileWriter(path, 0600).Write(func() ([]byte, error) { return []byte("new"), nil }); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(victim)
	if err != nil || string(body) != "keep" {
		t.Fatalf("unrelated file changed: %q %v", body, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("mode: %v %v", info, err)
	}
}

func TestFileWriterCleansUpWhenRenameFails(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := NewFileWriter(path, 0600).Write(func() ([]byte, error) { return []byte("secret"), nil }); err == nil {
		t.Fatal("saved over directory")
	}
	files, err := filepath.Glob(path + ".*.tmp")
	if err != nil || len(files) != 0 {
		t.Fatalf("left temporary files: %v %v", files, err)
	}
}
