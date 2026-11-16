package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMultiRepoWorktreeTerminalLifecycleAndPathContainment(t *testing.T) {
	t.Parallel()

	rootA := filepath.Join(t.TempDir(), "repo-a-wt")
	rootB := filepath.Join(t.TempDir(), "repo-b-wt")
	outside := filepath.Join(t.TempDir(), "outside")
	for _, dir := range []string{rootA, rootB, outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	subDirA := filepath.Join(rootA, "pkg")
	if err := os.MkdirAll(subDirA, 0o755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink(outside, filepath.Join(rootA, "escape-link")); err != nil {
			t.Fatal(err)
		}
	}

	tc := NewTerminalController(ExecTerminalFactory{})
	defer tc.CloseAll()

	if err := tc.RegisterRepoRoot("repo-a", rootA); err != nil {
		t.Fatalf("RegisterRepoRoot A: %v", err)
	}
	if err := tc.RegisterRepoRoot("repo-b", rootB); err != nil {
		t.Fatalf("RegisterRepoRoot B: %v", err)
	}

	// Reject relative cwd, traversal outside worktree, and symlink escape.
	for _, bad := range []TerminalSpawnSpec{
		{ID: "bad-rel", RepoID: "repo-a", Cwd: "pkg"},
		{ID: "bad-outside", RepoID: "repo-a", Cwd: outside},
		{ID: "bad-cross-repo", RepoID: "repo-a", Cwd: rootB},
		{ID: "bad-dotdot", RepoID: "repo-a", Cwd: filepath.Join(rootA, "..", "outside")},
	} {
		if _, err := tc.Spawn(context.Background(), bad); !errors.Is(err, ErrTerminalPathDenied) {
			t.Fatalf("Spawn(%+v): got err=%v, want ErrTerminalPathDenied", bad, err)
		}
	}
	if runtime.GOOS != "windows" {
		if _, err := tc.Spawn(context.Background(), TerminalSpawnSpec{
			ID:     "bad-symlink",
			RepoID: "repo-a",
			Cwd:    filepath.Join(rootA, "escape-link"),
		}); !errors.Is(err, ErrTerminalPathDenied) {
			t.Fatalf("symlink escape: got err=%v, want ErrTerminalPathDenied", err)
		}
	}

	var mu sync.Mutex
	outputs := make(map[string]*bytes.Buffer)
	exits := make(map[string]int)
	exitCh := make(chan string, 4)

	unsub := tc.Subscribe(
		func(id string, data []byte) {
			mu.Lock()
			buf := outputs[id]
			if buf == nil {
				buf = &bytes.Buffer{}
				outputs[id] = buf
			}
			buf.Write(data)
			mu.Unlock()
		},
		func(id string, code int) {
			mu.Lock()
			exits[id] = code
			mu.Unlock()
			exitCh <- id
		},
	)
	defer unsub()

	var cmdA, cmdB []string
	if runtime.GOOS == "windows" {
		cmdA = []string{"cmd", "/c", "more"}
		cmdB = []string{"cmd", "/c", "echo repo-b-ready"}
	} else {
		cmdA = []string{"/bin/sh", "-c", "IFS= read -r line; printf 'A:%s\\n' \"$line\"; sleep 5"}
		cmdB = []string{"/bin/sh", "-c", "pwd; echo repo-b-ready"}
	}

	infoA, err := tc.Spawn(context.Background(), TerminalSpawnSpec{
		ID:      "term-a",
		RepoID:  "repo-a",
		Cwd:     subDirA,
		Cols:    100,
		Rows:    30,
		Command: cmdA,
	})
	if err != nil {
		t.Fatalf("Spawn term-a: %v", err)
	}
	if infoA.PID <= 0 || !infoA.Running || infoA.Cols != 100 || infoA.Rows != 30 {
		t.Fatalf("unexpected infoA: %+v", infoA)
	}

	if _, err := tc.Spawn(context.Background(), TerminalSpawnSpec{
		ID:      "term-b",
		RepoID:  "repo-b",
		Command: cmdB,
	}); err != nil {
		t.Fatalf("Spawn term-b: %v", err)
	}

	if listA := tc.ListByRepo("repo-a"); len(listA) != 1 || listA[0].ID != "term-a" {
		t.Fatalf("ListByRepo(repo-a) = %+v", listA)
	}
	if all := tc.List(); len(all) != 2 {
		t.Fatalf("List() len = %d, want 2", len(all))
	}

	// Write input to term-a and wait for echoed output.
	if err := tc.Write("term-a", []byte("hello-worktree\n")); err != nil {
		t.Fatalf("Write term-a: %v", err)
	}
	if err := tc.Resize("term-a", 120, 40); err != nil {
		t.Fatalf("Resize term-a: %v", err)
	}
	inspected, err := tc.Inspect("term-a")
	if err != nil || inspected.Cols != 120 || inspected.Rows != 40 {
		t.Fatalf("Inspect after resize: info=%+v err=%v", inspected, err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		outA := ""
		if b := outputs["term-a"]; b != nil {
			outA = b.String()
		}
		outB := ""
		if b := outputs["term-b"]; b != nil {
			outB = b.String()
		}
		mu.Unlock()
		if strings.Contains(outA, "A:hello-worktree") && strings.Contains(outB, "repo-b-ready") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	mu.Lock()
	gotA := outputs["term-a"].String()
	gotB := outputs["term-b"].String()
	mu.Unlock()
	if !strings.Contains(gotA, "A:hello-worktree") {
		t.Fatalf("term-a output missing echoed text: %q", gotA)
	}
	if !strings.Contains(gotB, "repo-b-ready") {
		t.Fatalf("term-b output missing ready text: %q", gotB)
	}

	// Wait for term-b natural exit, and explicitly kill term-a.
	select {
	case id := <-exitCh:
		if id != "term-b" {
			t.Fatalf("expected term-b to exit first, got %q", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for term-b exit")
	}

	if err := tc.Kill("term-a"); err != nil {
		t.Fatalf("Kill term-a: %v", err)
	}
	if _, err := tc.Inspect("term-a"); !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("expected ErrTerminalNotFound after Kill, got %v", err)
	}
}
