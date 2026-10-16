//go:build !windows

package claude

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// Ports the claude cases of tests/session-dispose.test.ts,
// tests/session-resources.test.ts, tests/process-host-exit.test.ts,
// tests/session-env.test.ts and tests/refused-session-options.test.ts,
// against the real process plumbing and a stand-in agent
// (tests/fixtures/fake-agent-process.mjs) that ignores every stdin line.

func cOpenAgent(t *testing.T, probe *cTreeProbe) oar.Session {
	t.Helper()
	session, err := Session(testContext(t), oar.AvailableInstallation{Via: "executable", Command: cFakeAgentBinary(t, probe.dir)}, oar.SessionOptions{Cwd: probe.dir, Env: probe.env})
	if err != nil {
		t.Fatal(err)
	}
	return session
}

// POSIX: the runtime process leads a process group of its own.
func TestDisposeSettlesWithinTheGraceEvenWhenTheRuntimeIgnoresSigterm(t *testing.T) {
	t.Setenv("OAR_KILL_GRACE_MS", "500")
	cWithTreeProbe(t, true, false, func(probe *cTreeProbe) {
		session := cOpenAgent(t, probe)
		tree := probe.tree()
		started := time.Now()
		if err := session.Dispose(context.Background()); err != nil {
			t.Fatal(err)
		}
		if elapsed := time.Since(started); elapsed >= executable.KillGraceFromEnv()+2*time.Second {
			t.Fatalf("dispose settled %s after it was called", elapsed)
		}
		records := session.Records()
		request, response := records[len(records)-2], records[len(records)-1]
		if request.Kind != oar.KindRequest || request.Request.Kind != oar.RequestDispose || response.Kind != oar.KindResponse {
			t.Fatalf("the stream ends with %s", jsonText(records[len(records)-2:]))
		}
		// The observed (SIGKILLed) exit answers the dispose.
		if response.RequestID != request.ID {
			t.Fatalf("answers %s", response.RequestID)
		}
		assertJSON(t, response.Response, `{"kind":"exited","code":null}`)
		if !cProcessGone(tree.Agent, 5*time.Second) || !cProcessGone(tree.Grandchild, 5*time.Second) {
			t.Fatal("the runtime or the tool it started survived")
		}
	})
}

// claude's Bash tool runs each command in a session of its own, out of the
// runtime's group: dispose must reach it whether the runtime stops on
// SIGTERM (and leaves the tool behind) or only the SIGKILL ends it.
func TestDisposeTakesDownAToolThatLeftTheRuntimesProcessGroup(t *testing.T) {
	t.Setenv("OAR_KILL_GRACE_MS", "500")
	for _, ignoreSigterm := range []bool{true, false} {
		cWithTreeProbe(t, ignoreSigterm, true, func(probe *cTreeProbe) {
			session := cOpenAgent(t, probe)
			tree := probe.tree()
			if err := session.Dispose(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !cProcessGone(tree.Agent, 5*time.Second) || !cProcessGone(tree.Grandchild, time.Second) {
				t.Fatalf("ignoreSigterm %v: the runtime or the tool it started survived", ignoreSigterm)
			}
		})
	}
}

// A process the size of a Node process: some megabytes resident.
const cNodeRSS = 10 * 1024 * 1024

func TestResourcesCountTheRuntimeAndWhatItStarted(t *testing.T) {
	for _, detachTool := range []bool{false, true} {
		cWithTreeProbe(t, false, detachTool, func(probe *cTreeProbe) {
			ctx := testContext(t)
			session := cOpenAgent(t, probe)
			probe.tree()
			if !session.CanReadResources() {
				t.Fatal("no resources reader")
			}
			resources, err := session.Resources(ctx)
			if err != nil {
				t.Fatal(err)
			}
			// The agent and the tool it started, whether or not the tool left its group.
			if resources == nil || resources.Processes != 2 || resources.RSS <= 2*cNodeRSS {
				t.Fatalf("detachTool %v: resources = %+v", detachTool, resources)
			}
			if err := session.Dispose(ctx); err != nil {
				t.Fatal(err)
			}
			if after, err := session.Resources(ctx); err != nil || after != nil {
				t.Fatalf("after dispose: %+v %v", after, err)
			}
		})
	}
}

// Go has no process exit hook (GAPS.md): a host calls executable.KillOwned
// on its shutdown path. TS tests/process-host-exit.test.ts: a live session's
// runtime and its tool, including one that left the runtime's group (oar#210),
// are gone after the host's backstop without a dispose.
func TestHostBackstopKillsALiveSessionAndItsTools(t *testing.T) {
	for _, detachTool := range []bool{false, true} {
		cWithTreeProbe(t, true, detachTool, func(probe *cTreeProbe) {
			session := cOpenAgent(t, probe)
			tree := probe.tree()
			executable.KillOwned()
			if !cProcessGone(tree.Agent, 5*time.Second) || !cProcessGone(tree.Grandchild, 5*time.Second) {
				t.Fatalf("detachTool %v: surviving %+v", detachTool, tree)
			}
			_ = session.Dispose(context.Background())
		})
	}
}

// Deletion and overrides reach the runtime and its tools without changing the host.
func TestSessionEnvReachesClaudeAndItsToolsWithoutChangingTheHost(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "env.json")
	for _, key := range []string{"OAR_ENV_REMOVE", "OAR_ENV_OVERRIDE", "OAR_ENV_KEEP", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"} {
		t.Setenv(key, "inherited")
	}
	env := map[string]*string{"OAR_ENV_CAPTURE_PATH": oar.String(file), "OAR_ENV_REMOVE": nil, "OAR_ENV_OVERRIDE": oar.String("replacement"), "OAR_ENV_EMPTY": oar.String("")}
	command := cFakeAgentBinary(t, dir, "--import", cFixtureURL(t, "env-capture.mjs"), cFakeAgentFixture(t), "session")
	ctx := testContext(t)
	session, err := Session(ctx, oar.AvailableInstallation{Via: "executable", Command: command}, oar.SessionOptions{Cwd: dir, Env: env})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Dispose(ctx) }()
	eventually(t, "the captured environment", func() bool { _, err := os.Stat(file); return err == nil })
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	// claude's parent-session markers are removed (environment.go).
	expected := `{"OAR_ENV_OVERRIDE":"replacement","OAR_ENV_KEEP":"inherited","OAR_ENV_EMPTY":""}`
	var captured any
	if err := json.Unmarshal(data, &captured); err != nil {
		t.Fatal(err)
	}
	assertJSON(t, captured, `{"runtime":`+expected+`,"tool":`+expected+`}`)
	if os.Getenv("OAR_ENV_REMOVE") != "inherited" || os.Getenv("OAR_ENV_OVERRIDE") != "inherited" {
		t.Fatal("the host environment changed")
	}
	encoded, _ := json.Marshal(session.Records())
	if regexp.MustCompile(`OAR_ENV_|replacement`).Match(encoded) {
		t.Fatal("the environment reached the records")
	}
}

func TestClaudeDeclaresNoRefusedSessionOptions(t *testing.T) {
	if refused := Runtime().RefusedSessionOptions; len(refused) != 0 {
		t.Fatalf("refused = %v", refused)
	}
	// Empty lists are no option given, so nothing refuses them.
	for _, options := range []oar.SessionOptions{{Cwd: "/tmp", MCPServers: []oar.McpServer{}}, {Cwd: "/tmp", DisallowedTools: []string{}}, {Cwd: "/tmp", AdditionalDirectories: []string{}}} {
		if err := shared.RefuseSessionOptions(Runtime().RefusedSessionOptions, options); err != nil {
			t.Fatal(err)
		}
	}
}

// claude would open unnamed without a word: a blank name or one with a NUL is refused before anything starts.
func TestABlankNameOrOneWithANulIsRefusedBeforeAnythingStarts(t *testing.T) {
	nowhere := oar.AvailableInstallation{Via: "executable", Command: "/nonexistent/oar-probe"}
	for _, name := range []string{"", "   ", "a\x00b"} {
		_, err := Runtime().Session(testContext(t), nowhere, oar.SessionOptions{Cwd: "/tmp", Name: oar.String(name)})
		var unsupported *oar.UnsupportedOptionError
		if !errors.As(err, &unsupported) || unsupported.Option != "name" || unsupported.Message != "name must not be blank or contain NUL characters" {
			t.Fatalf("name %q: %v", name, err)
		}
	}
}
