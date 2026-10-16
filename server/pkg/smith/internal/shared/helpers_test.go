package shared

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

// nodeOrSkip is the node on PATH; the fixtures are node scripts.
func nodeOrSkip(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	absolute, err := filepath.Abs(node)
	if err != nil {
		t.Fatal(err)
	}
	return absolute
}

// fixture is a file in the repository's tests/fixtures.
func fixture(t *testing.T, name string) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "..", "testdata", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func posixOnly(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX only")
	}
}

// script writes an executable sh script.
func script(t *testing.T, dir, name, body string) string {
	t.Helper()
	file := filepath.Join(dir, name)
	if err := os.WriteFile(file, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return file
}

// readState reads a fixture's JSON state file.
func readState(t *testing.T, file string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func writeState(t *testing.T, file string, state map[string]any) {
	t.Helper()
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// jsonEqual compares a value's JSON with the expected JSON text, as deepEqual on the TS shapes.
func jsonEqual(t *testing.T, got any, want string) {
	t.Helper()
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var left, right any
	if err := json.Unmarshal(encoded, &left); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &right); err != nil {
		t.Fatalf("bad expectation %s: %v", want, err)
	}
	if !reflect.DeepEqual(left, right) {
		t.Fatalf("got  %s\nwant %s", encoded, want)
	}
}

// eventually polls check until it holds or timeout passes.
func eventually(timeout time.Duration, check func() bool) bool {
	deadline := time.Now().Add(timeout)
	for {
		if check() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func errorsAs(err error, target any) bool { return errors.As(err, target) }
