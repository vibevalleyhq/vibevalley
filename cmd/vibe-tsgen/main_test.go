package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func copyContractToTempRoot(t *testing.T) string {
	t.Helper()
	repoRoot, err := findRepoRoot()
	if err != nil {
		t.Fatalf("findRepoRoot: %v", err)
	}
	tmp := t.TempDir()
	srcDir := filepath.Join(repoRoot, "pkg", "contract")
	dstDir := filepath.Join(tmp, "pkg", "contract")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(srcDir, entry.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", entry.Name(), err)
		}
		if err := os.WriteFile(filepath.Join(dstDir, entry.Name()), data, 0o644); err != nil {
			t.Fatalf("write %s: %v", entry.Name(), err)
		}
	}
	return tmp
}

func TestCLIWriteAndCheck(t *testing.T) {
	tmp := copyContractToTempRoot(t)

	var out, errBuf bytes.Buffer
	if err := run([]string{"--check", "--root", tmp}, &out, &errBuf); err == nil {
		t.Fatal("expected --check to fail before files are generated")
	}

	out.Reset()
	errBuf.Reset()
	if err := run([]string{"--write", "--root", tmp}, &out, &errBuf); err != nil {
		t.Fatalf("--write failed: %v", err)
	}
	if !strings.Contains(out.String(), "shapes.ts") || !strings.Contains(out.String(), "schema.ts") {
		t.Fatalf("unexpected --write output: %q", out.String())
	}

	out.Reset()
	if err := run([]string{"--check", "--root", tmp}, &out, &errBuf); err != nil {
		t.Fatalf("--check after --write failed: %v", err)
	}
	if !strings.Contains(out.String(), "up to date") {
		t.Fatalf("unexpected --check output: %q", out.String())
	}

	shapesPath := filepath.Join(tmp, "packages", "protocol", "src", "go-contract", "shapes.ts")
	if err := os.WriteFile(shapesPath, []byte("// drifted\n"), 0o644); err != nil {
		t.Fatalf("corrupt shapes.ts: %v", err)
	}
	if err := run([]string{"--check", "--root", tmp}, &out, &errBuf); err == nil {
		t.Fatal("expected --check to fail after shapes.ts drifted")
	}
}

func TestCLIValidationErrors(t *testing.T) {
	var out, errBuf bytes.Buffer
	for _, args := range [][]string{
		{},
		{"--write", "--check"},
		{"--write", "extra"},
	} {
		out.Reset()
		errBuf.Reset()
		if err := run(args, &out, &errBuf); err == nil {
			t.Errorf("expected error for args %v", args)
		}
	}
}
