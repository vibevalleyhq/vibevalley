//go:build !windows

package claude

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

// The Go port of tests/fixtures/process-tree.ts (POSIX).

// cFakeAgentFixture is the stand-in agent (tests/fixtures/fake-agent-process.mjs).
func cFakeAgentFixture(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs("../../testdata/fixtures/fake-agent-process.mjs")
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func cFixtureURL(t *testing.T, name string) string {
	t.Helper()
	path, err := filepath.Abs("../../testdata/fixtures/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return "file://" + path
}

// cFakeAgentBinary writes an executable that execs node with entry (default:
// the fake agent), so the agent keeps the launcher's pid (POSIX).
func cFakeAgentBinary(t *testing.T, dir string, entry ...string) string {
	t.Helper()
	if len(entry) == 0 {
		entry = []string{cFakeAgentFixture(t)}
	}
	node, err := cLookNode()
	if err != nil {
		t.Skip("node is not on PATH")
	}
	quoted := []string{`"` + node + `"`}
	for _, arg := range entry {
		quoted = append(quoted, `"`+arg+`"`)
	}
	binary := filepath.Join(dir, "fake-agent")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexec "+strings.Join(quoted, " ")+" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return binary
}

func cLookNode() (string, error) {
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		candidate := filepath.Join(dir, "node")
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("node not found")
}

// cAgentTree is the pids a fake agent reports (agent-tree.mjs).
type cAgentTree struct {
	Agent      int `json:"agent"`
	Grandchild int `json:"grandchild"`
}

// cTreeProbe is one fake agent's scratch directory: the env that grows its
// tree, and where it reports it.
type cTreeProbe struct {
	t        *testing.T
	dir      string
	env      map[string]*string
	pidFile  string
	reported []int
}

func (p *cTreeProbe) tree() cAgentTree {
	p.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if data, err := os.ReadFile(p.pidFile); err == nil {
			var tree cAgentTree
			if err := json.Unmarshal(data, &tree); err == nil {
				p.reported = append(p.reported, tree.Agent, tree.Grandchild)
				return tree
			}
		}
		if time.Now().After(deadline) {
			p.t.Fatalf("the fake agent never reported its pids in %s", p.pidFile)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// cWithTreeProbe runs body with a probe; afterwards it SIGKILLs whatever the
// agent reported that still lives and removes the directory.
func cWithTreeProbe(t *testing.T, ignoreSigterm, detachTool bool, body func(probe *cTreeProbe)) {
	t.Helper()
	dir, err := os.MkdirTemp("", "oar-process-tree-")
	if err != nil {
		t.Fatal(err)
	}
	probe := &cTreeProbe{t: t, dir: dir, pidFile: filepath.Join(dir, "pids.json"), env: map[string]*string{}}
	probe.env["OAR_FIXTURE_PIDS"] = oar.String(probe.pidFile)
	if ignoreSigterm {
		probe.env["OAR_FIXTURE_IGNORE_SIGTERM"] = oar.String("1")
	}
	if detachTool {
		probe.env["OAR_FIXTURE_DETACH_TOOL"] = oar.String("1")
	}
	defer func() {
		for _, pid := range probe.reported {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
		_ = os.RemoveAll(dir)
	}()
	body(probe)
}

func cProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// cProcessGone polls until pid is gone; false when it outlives within.
func cProcessGone(pid int, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for cProcessAlive(pid) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}
