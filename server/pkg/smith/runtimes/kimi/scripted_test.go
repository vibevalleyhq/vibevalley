package kimi

// The scripted ACP agent (../testdata/scripted-acp-agent.mjs): the Go
// port's stand-in for the TS tests' vi.mock of startAcpProcess. A real
// process answers each method as the test scripts it, and its log shows
// what was asked, with which params, in which directory.

import (
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

var scriptedAgentPath = mustAbs(filepath.Join("..", "testdata", "scripted-acp-agent.mjs"))

type scriptedAgent struct {
	t       *testing.T
	log     string
	command string
}

// result and rpcError are scripted steps.
func result(value any) map[string]any { return map[string]any{"result": value} }

func rpcError(code int, message string) map[string]any {
	return map[string]any{"error": map[string]any{"code": code, "message": message}}
}

func delayed(delay time.Duration, step map[string]any) map[string]any {
	out := map[string]any{"delayMs": delay.Milliseconds()}
	for key, value := range step {
		out[key] = value
	}
	return out
}

// newScriptedAgent writes an executable that runs the scripted agent with
// methods, through SCRIPTED_ACP in this test's environment.
func newScriptedAgent(t *testing.T, methods map[string]any) *scriptedAgent {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the scripted agent launcher is a POSIX shell script")
	}
	node := nodePath(t)
	dir := t.TempDir()
	agent := &scriptedAgent{t: t, log: filepath.Join(dir, "log.jsonl"), command: filepath.Join(dir, "agent")}
	launcher := "#!/bin/sh\nexec '" + node + "' '" + scriptedAgentPath + "' \"$@\"\n"
	if err := os.WriteFile(agent.command, []byte(launcher), 0o755); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{"log": agent.log, "methods": methods})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SCRIPTED_ACP", string(payload))
	return agent
}

func (a *scriptedAgent) installation() oar.AvailableInstallation {
	return oar.AvailableInstallation{Via: "executable", Command: a.command}
}

func (a *scriptedAgent) entries() []map[string]any {
	a.t.Helper()
	data, err := os.ReadFile(a.log)
	if err != nil {
		return nil
	}
	var out []map[string]any
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			a.t.Fatal(err)
		}
		out = append(out, entry)
	}
	return out
}

// methods is every request method, in arrival order.
func (a *scriptedAgent) methods() []string {
	out := []string{}
	for _, entry := range a.entries() {
		if method, ok := entry["method"].(string); ok {
			out = append(out, method)
		}
	}
	return out
}

// params is what the index-th request carried.
func (a *scriptedAgent) params(index int) any {
	a.t.Helper()
	requests := 0
	for _, entry := range a.entries() {
		if _, ok := entry["method"]; ok {
			if requests == index {
				return entry["params"]
			}
			requests++
		}
	}
	a.t.Fatalf("no request %d", index)
	return nil
}

// starts is each launch's {start: argv, cwd, pid}.
func (a *scriptedAgent) starts() []map[string]any {
	var out []map[string]any
	for _, entry := range a.entries() {
		if _, ok := entry["start"]; ok {
			out = append(out, entry)
		}
	}
	return out
}

// killed: every agent the reader started is gone (TS: kill called once and awaited).
func (a *scriptedAgent) killed() bool {
	a.t.Helper()
	starts := a.starts()
	if len(starts) == 0 {
		return false
	}
	for _, start := range starts {
		pid := int(start["pid"].(float64))
		if !errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return false
		}
	}
	return true
}
