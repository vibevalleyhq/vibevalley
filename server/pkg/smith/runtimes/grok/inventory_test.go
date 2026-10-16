package grok

// grok's cases of tests/inventory.test.ts. TS mocks spawnLineProcess; here
// a fake `grok inspect` (../testdata/fake-inspect.mjs) runs.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

var fakeInspectPath = mustAbs(filepath.Join("..", "testdata", "fake-inspect.mjs"))

type fakeInspect struct {
	t       *testing.T
	command string
	log     string
	pids    string
}

func newFakeInspect(t *testing.T, mode, output string) *fakeInspect {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake launcher is a POSIX shell script")
	}
	dir := t.TempDir()
	fake := &fakeInspect{t: t, command: filepath.Join(dir, "grok"), log: filepath.Join(dir, "log.jsonl"), pids: filepath.Join(dir, "pids.json")}
	launcher := "#!/bin/sh\nexec '" + nodePath(t) + "' '" + fakeInspectPath + "' \"$@\"\n"
	if err := os.WriteFile(fake.command, []byte(launcher), 0o755); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]any{"log": fake.log, "mode": mode, "output": output, "pids": fake.pids})
	t.Setenv("FAKE_INSPECT", string(config))
	return fake
}

func (f *fakeInspect) installation() oar.AvailableInstallation {
	return oar.AvailableInstallation{Via: "executable", Command: f.command}
}

func (f *fakeInspect) entries() []map[string]any {
	data, _ := os.ReadFile(f.log)
	var out []map[string]any
	for _, line := range strings.Split(string(data), "\n") {
		if line != "" {
			var entry map[string]any
			_ = json.Unmarshal([]byte(line), &entry)
			out = append(out, entry)
		}
	}
	return out
}

// tree is the fake's pid and its detached grandchild's, once it wrote them.
func (f *fakeInspect) tree() (int, int) {
	f.t.Helper()
	if !eventually(func() bool { _, err := os.Stat(f.pids); return err == nil }, 10*time.Second) {
		f.t.Fatal("the fake never reported its pids")
	}
	time.Sleep(20 * time.Millisecond)
	data, _ := os.ReadFile(f.pids)
	var pids struct{ Agent, Grandchild int }
	if err := json.Unmarshal(data, &pids); err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() {
		_ = syscall.Kill(pids.Agent, syscall.SIGKILL)
		_ = syscall.Kill(pids.Grandchild, syscall.SIGKILL)
	})
	return pids.Agent, pids.Grandchild
}

func gone(pid int) bool {
	return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
}

func TestTimeoutReleasesTheOwnedDiscoveryProcessAndWhatItStarted(t *testing.T) {
	fake := newFakeInspect(t, "hang", "")
	read := readAsync(func() (oar.InventoryResult[oar.SkillEntry], error) {
		return Skills(context.Background(), fake.installation(), oar.InventoryOptions{Timeout: 5 * time.Second})
	})
	agent, grandchild := fake.tree()
	result := <-read
	if result.err != nil || result.value.Kind != "unavailable" || result.value.Code != "timeout" {
		t.Fatalf("%+v %v", result.value, result.err)
	}
	// killTree: the grandchild left the group, and still goes with the tree.
	if !eventually(func() bool { return gone(agent) && gone(grandchild) }, 10*time.Second) {
		t.Fatalf("survived: agent %v grandchild %v", !gone(agent), !gone(grandchild))
	}
}

// TS: the kill is called once and the read settles only after the child ends.
func TestInventoryTimeoutWaitsForTeardownBeforeReturning(t *testing.T) {
	fake := newFakeInspect(t, "slow-term", "")
	begin := time.Now()
	read := readAsync(func() (oar.InventoryResult[oar.SkillEntry], error) {
		return Skills(context.Background(), fake.installation(), oar.InventoryOptions{Timeout: 5 * time.Second})
	})
	agent, _ := fake.tree()
	result := <-read
	elapsed := time.Since(begin)
	if result.err != nil || result.value.Kind != "unavailable" || result.value.Code != "timeout" {
		t.Fatalf("%+v %v", result.value, result.err)
	}
	if !gone(agent) {
		t.Fatal("the read answered before its process ended")
	}
	// The fake takes 300 ms to end after SIGTERM.
	if elapsed < 5*time.Second+250*time.Millisecond {
		t.Fatalf("answered after %v, before the teardown", elapsed)
	}
}

func TestMalformedNativeListNeverBecomesAnEmptySuccess(t *testing.T) {
	fake := newFakeInspect(t, "print", "{}")
	result, err := MCPServers(context.Background(), fake.installation(), oar.InventoryOptions{})
	if err != nil || result.Kind != "unavailable" || result.Code != "query_failed" {
		t.Fatalf("%+v %v", result, err)
	}
}

func TestIndependentDiscoveryNeverAuthenticatesOrCreatesASession(t *testing.T) {
	fake := newFakeInspect(t, "print", `{"mcpServers":[{"name":"compat","source":"project","command":"secret","target":"secret"}]}`)
	result, err := MCPServers(context.Background(), fake.installation(), oar.InventoryOptions{})
	if err != nil || result.Kind != "ok" || result.View != "discovered" {
		t.Fatalf("%+v %v", result, err)
	}
	jsonEqual(t, result.Items, `[{"id": "compat", "name": "compat", "source": "project"}]`)
	entries := fake.entries()
	if len(entries) == 0 {
		t.Fatal("no start logged")
	}
	jsonEqual(t, entries[0]["argv"], []string{"inspect", "--json"})
	for _, entry := range entries {
		if _, wrote := entry["stdin"]; wrote {
			t.Fatalf("wrote to stdin: %v", entry)
		}
	}
}

type settled[T any] struct {
	value T
	err   error
}

// readAsync runs read on its own goroutine; the channel carries its answer.
func readAsync[T any](read func() (T, error)) <-chan settled[T] {
	out := make(chan settled[T], 1)
	go func() {
		value, err := read()
		out <- settled[T]{value, err}
	}()
	return out
}
