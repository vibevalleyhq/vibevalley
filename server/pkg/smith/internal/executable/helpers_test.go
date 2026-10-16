//go:build !windows

package executable

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// fixtures is tests/fixtures, shared with the TS suite.
const fixtures = "../../testdata/fixtures"

// requireNode is the node executable the .mjs fixtures run on; the test is
// skipped without one.
func requireNode(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	return node
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join(fixtures, name))
	if err != nil {
		t.Fatal(err)
	}
	return path
}

// eventually polls predicate until it holds; false when within passes first.
func eventually(predicate func() bool, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for !predicate() {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || !errors.Is(err, syscall.ESRCH)
}

// gone polls kill(pid, 0) until ESRCH; false when the pid outlives within.
func gone(pid int, within time.Duration) bool {
	return eventually(func() bool { return !alive(pid) }, within)
}

// agentTree is the pids agent-tree.mjs reports.
type agentTree struct {
	Agent      int `json:"agent"`
	Grandchild int `json:"grandchild"`
}

// treeProbe is one fake agent's scratch directory (tests/fixtures/process-tree.ts withTreeProbe).
type treeProbe struct {
	t        *testing.T
	dir      string
	env      []string
	pidFile  string
	lateFile string
	reported []int
}

type treeProbeOptions struct {
	ignoreSigterm bool
	detachTool    bool
	lateTool      bool
}

func newTreeProbe(t *testing.T, options treeProbeOptions) *treeProbe {
	t.Helper()
	dir := t.TempDir()
	probe := &treeProbe{t: t, dir: dir, pidFile: filepath.Join(dir, "pids.json"), lateFile: filepath.Join(dir, "late.pid")}
	probe.env = append(os.Environ(), "OAR_FIXTURE_PIDS="+probe.pidFile)
	if options.ignoreSigterm {
		probe.env = append(probe.env, "OAR_FIXTURE_IGNORE_SIGTERM=1")
	}
	if options.detachTool {
		probe.env = append(probe.env, "OAR_FIXTURE_DETACH_TOOL=1")
	}
	if options.lateTool {
		probe.env = append(probe.env, "OAR_FIXTURE_LATE_TOOL="+probe.lateFile)
	}
	// A failed test must not leak what the agent reported.
	t.Cleanup(func() {
		if data, err := os.ReadFile(probe.lateFile); err == nil {
			var pid int
			if json.Unmarshal(data, &pid) == nil {
				probe.reported = append(probe.reported, pid)
			}
		}
		for _, pid := range probe.reported {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	return probe
}

func (p *treeProbe) tree() agentTree {
	p.t.Helper()
	if !eventually(func() bool { _, err := os.Stat(p.pidFile); return err == nil }, 10*time.Second) {
		p.t.Fatalf("the fake agent never reported its pids in %s", p.pidFile)
	}
	data, err := os.ReadFile(p.pidFile)
	if err != nil {
		p.t.Fatal(err)
	}
	var tree agentTree
	if err := json.Unmarshal(data, &tree); err != nil {
		p.t.Fatal(err)
	}
	p.reported = append(p.reported, tree.Agent, tree.Grandchild)
	return tree
}

func (p *treeProbe) lateTool() int {
	p.t.Helper()
	if !eventually(func() bool { _, err := os.Stat(p.lateFile); return err == nil }, 10*time.Second) {
		p.t.Fatalf("the fake agent never reported a late tool in %s", p.lateFile)
	}
	data, err := os.ReadFile(p.lateFile)
	if err != nil {
		p.t.Fatal(err)
	}
	var pid int
	if err := json.Unmarshal(data, &pid); err != nil {
		p.t.Fatal(err)
	}
	p.reported = append(p.reported, pid)
	return pid
}

// waitExited waits for a line process's exit report.
func waitExited(t *testing.T, p *LineProcess, within time.Duration) {
	t.Helper()
	select {
	case <-p.Exited():
	case <-time.After(within):
		t.Fatal("the process did not exit")
	}
}

// script writes an executable sh script into dir.
func script(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
