//go:build !windows

package codex

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

// Ports the codex rows of tests/session-dispose.test.ts,
// session-resources.test.ts and session-env.test.ts, driving the real
// adapter against tests/fixtures/fake-agent-process.mjs (it speaks just
// enough app-server to open a thread).

const fakeAgentScript = "../../testdata/fixtures/fake-agent-process.mjs"

type agentTree struct {
	Agent      int `json:"agent"`
	Grandchild int `json:"grandchild"`
}

type treeProbe struct {
	dir     string
	pidFile string
	env     map[string]*string
}

func withTreeProbe(t *testing.T, ignoreSigterm, detachTool bool) *treeProbe {
	t.Helper()
	dir := t.TempDir()
	probe := &treeProbe{dir: dir, pidFile: filepath.Join(dir, "pids.json"), env: map[string]*string{
		"OAR_FIXTURE_PIDS": oar.String(filepath.Join(dir, "pids.json")),
		// A home of its own, so the gate never waits on another test's.
		"CODEX_HOME": oar.String(filepath.Join(dir, "codex-home")),
	}}
	if ignoreSigterm {
		probe.env["OAR_FIXTURE_IGNORE_SIGTERM"] = oar.String("1")
	}
	if detachTool {
		probe.env["OAR_FIXTURE_DETACH_TOOL"] = oar.String("1")
	}
	t.Cleanup(func() {
		if data, err := os.ReadFile(probe.pidFile); err == nil {
			var tree agentTree
			if json.Unmarshal(data, &tree) == nil {
				for _, pid := range []int{tree.Agent, tree.Grandchild} {
					if pid > 0 {
						_ = syscall.Kill(pid, syscall.SIGKILL)
					}
				}
			}
		}
	})
	return probe
}

func (p *treeProbe) tree(t *testing.T) agentTree {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if data, err := os.ReadFile(p.pidFile); err == nil {
			var tree agentTree
			if err := json.Unmarshal(data, &tree); err != nil {
				t.Fatal(err)
			}
			return tree
		}
		if time.Now().After(deadline) {
			t.Fatalf("the fake agent never reported its pids in %s", p.pidFile)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// fakeAgentBinary is a POSIX launcher that execs node (with nodeArgs, else the fake agent) keeping its pid.
func fakeAgentBinary(t *testing.T, dir string, nodeArgs ...string) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	if len(nodeArgs) == 0 {
		script, err := filepath.Abs(fakeAgentScript)
		if err != nil {
			t.Fatal(err)
		}
		nodeArgs = []string{script}
	}
	quoted := []string{fmt.Sprintf("%q", node)}
	for _, arg := range nodeArgs {
		quoted = append(quoted, fmt.Sprintf("%q", arg))
	}
	binary := filepath.Join(dir, "fake-agent")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexec "+strings.Join(quoted, " ")+" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return binary
}

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func goneWithin(pid int, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for alive(pid) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}

func openFakeAgent(t *testing.T, probe *treeProbe) oar.Session {
	t.Helper()
	session, err := Session(testContext(t), oar.AvailableInstallation{Via: "executable", Command: fakeAgentBinary(t, probe.dir)}, oar.SessionOptions{Cwd: probe.dir, Env: probe.env})
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func TestDisposeSettlesWithinTheGracePeriodEvenWhenTheRuntimeIgnoresSIGTERM(t *testing.T) {
	t.Setenv("OAR_KILL_GRACE_MS", "500")
	probe := withTreeProbe(t, true, false)
	session := openFakeAgent(t, probe)
	tree := probe.tree(t)
	started := time.Now()
	if err := session.Dispose(testContext(t)); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > 2500*time.Millisecond {
		t.Fatalf("dispose settled %s after it was called", elapsed)
	}
	records := session.Records()
	request, response := records[len(records)-2], records[len(records)-1]
	if request.Kind != oar.KindRequest || request.Request.Kind != oar.RequestDispose || response.Kind != oar.KindResponse {
		t.Fatalf("the stream ends with %s", jsonOf(t, records[len(records)-2:]))
	}
	sameJSON(t, map[string]any{"requestId": response.RequestID, "body": response.Response}, jsonText(map[string]any{"requestId": request.ID, "body": map[string]any{"kind": "exited", "code": nil}}))
	if !goneWithin(tree.Agent, 5*time.Second) || !goneWithin(tree.Grandchild, 5*time.Second) {
		t.Fatal("the runtime or the tool it started outlived dispose")
	}
}

func TestDisposeTakesDownAToolThatLeftTheRuntimesProcessGroup(t *testing.T) {
	t.Setenv("OAR_KILL_GRACE_MS", "500")
	for _, ignoreSigterm := range []bool{true, false} {
		t.Run(fmt.Sprint(ignoreSigterm), func(t *testing.T) {
			probe := withTreeProbe(t, ignoreSigterm, true)
			session := openFakeAgent(t, probe)
			tree := probe.tree(t)
			if err := session.Dispose(testContext(t)); err != nil {
				t.Fatal(err)
			}
			if !goneWithin(tree.Agent, 5*time.Second) || !goneWithin(tree.Grandchild, time.Second) {
				t.Fatal("the runtime or the tool it started outlived dispose")
			}
		})
	}
}

// A process the size of a Node process: some megabytes resident.
const nodeRSS = 10 * 1024 * 1024

func TestResourcesCountTheRuntimeAndWhatItStarted(t *testing.T) {
	for _, detachTool := range []bool{false, true} {
		t.Run(fmt.Sprint(detachTool), func(t *testing.T) {
			probe := withTreeProbe(t, false, detachTool)
			session := openFakeAgent(t, probe)
			probe.tree(t)
			if !session.CanReadResources() {
				t.Fatal("no resources reader")
			}
			resources, err := session.Resources(testContext(t))
			if err != nil || resources == nil || resources.Processes != 2 || resources.RSS <= 2*nodeRSS {
				t.Fatalf("resources %+v %v", resources, err)
			}
			if err := session.Dispose(testContext(t)); err != nil {
				t.Fatal(err)
			}
			if after, _ := session.Resources(testContext(t)); after != nil {
				t.Fatalf("resources after dispose %+v", after)
			}
		})
	}
}

func TestDeletionAndOverridesReachTheRuntimeAndItsToolsWithoutChangingTheHost(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "env.json")
	for _, key := range []string{"OAR_ENV_REMOVE", "OAR_ENV_OVERRIDE", "OAR_ENV_KEEP", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"} {
		t.Setenv(key, "inherited")
	}
	capture, _ := filepath.Abs("../../testdata/fixtures/env-capture.mjs")
	agent, _ := filepath.Abs(fakeAgentScript)
	command := fakeAgentBinary(t, dir, "--import", "file://"+capture, agent, "session")
	env := map[string]*string{"OAR_ENV_CAPTURE_PATH": oar.String(file), "OAR_ENV_REMOVE": nil, "OAR_ENV_OVERRIDE": oar.String("replacement"), "OAR_ENV_EMPTY": oar.String(""), "CODEX_HOME": oar.String(filepath.Join(dir, "codex-home"))}
	session, err := Session(testContext(t), oar.AvailableInstallation{Via: "executable", Command: command}, oar.SessionOptions{Cwd: dir, Env: env})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Dispose(testContext(t)) }()
	eventually(t, "the captured environment", func() bool {
		_, err := os.Stat(file)
		return err == nil
	})
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	expected := `{"OAR_ENV_OVERRIDE":"replacement","OAR_ENV_KEEP":"inherited","OAR_ENV_EMPTY":"","CLAUDECODE":"inherited","CLAUDE_CODE_ENTRYPOINT":"inherited"}`
	sameJSON(t, json.RawMessage(data), `{"runtime":`+expected+`,"tool":`+expected+`}`)
	if os.Getenv("OAR_ENV_REMOVE") != "inherited" || os.Getenv("OAR_ENV_OVERRIDE") != "inherited" {
		t.Fatal("the host's environment changed")
	}
	if recorded := jsonOf(t, session.Records()); strings.Contains(recorded, "OAR_ENV_") || strings.Contains(recorded, "replacement") {
		t.Fatalf("the environment was recorded: %s", recorded)
	}
}
