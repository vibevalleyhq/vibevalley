package antigravity

// Ported from tests/acp/acp-session-antigravity.test.ts,
// tests/acp/antigravity-disallowed-tools.test.ts and the antigravity entries
// of tests/acp/acp-session-mcp-servers.test.ts.

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/oar"
)

// startAntigravity runs the real profile against the fixture's
// "antigravity" mode (agy_acp_server 1.2.1), only the launch line swapped.
func startAntigravity(t *testing.T, options oar.SessionOptions, preload ...string) (oar.Session, error) {
	t.Helper()
	profile := Profile
	args := append(append([]string{}, preload...), fixture, "antigravity")
	profile.Args = acp.StaticArgs(args...)
	if options.Cwd == "" {
		options.Cwd, _ = os.Getwd()
	}
	session, err := acp.Session(profile)(testContext(t), nodeInstallation(t), options)
	if err == nil {
		t.Cleanup(func() { _ = session.Dispose(context.Background()) })
	}
	return session, err
}

func mustStart(t *testing.T, options oar.SessionOptions, preload ...string) oar.Session {
	t.Helper()
	session, err := startAntigravity(t, options, preload...)
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func lastText(t *testing.T, session oar.Session, input string) string {
	t.Helper()
	if run := promptAndWait(t, session, input); run.Kind != "ended" {
		t.Fatal(run.Kind)
	}
	last := ""
	for _, line := range describeAll(session.Records()) {
		if strings.HasPrefix(line, "event agent_message_chunk") {
			last = line
		}
	}
	return last
}

func TestOpensWithoutAuthenticateAndRunsInYoloAgainAfterResume(t *testing.T) {
	first := mustStart(t, oar.SessionOptions{})
	if contains(describeAll(first.Records()), "event authenticate") {
		t.Fatal("authenticated")
	}
	if got := lastText(t, first, "mode"); got != "event agent_message_chunk → text:mode:yolo" {
		t.Fatal(got)
	}
	if err := first.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	resumed := mustStart(t, oar.SessionOptions{Resume: first.ID()})
	if resumed.ID() != first.ID() {
		t.Fatal(resumed.ID())
	}
	if got := lastText(t, resumed, "mode"); got != "event agent_message_chunk → text:mode:yolo" {
		t.Fatal(got)
	}
}

type agentTree struct {
	Agent      int `json:"agent"`
	Grandchild int `json:"grandchild"`
}

func gone(pid int, within time.Duration) bool {
	return eventually(func() bool { return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) }, within)
}

// tests/fixtures/process-tree.ts withTreeProbe({ignoreSigterm: false}): the
// agent, preloaded with agent-tree.mjs, starts a grandchild tool and reports both pids.
func TestDisposeEndsTheProcessWithoutUnadvertisedClose(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX signals and kill(pid, 0)")
	}
	for _, keepAlive := range []bool{false, true} {
		t.Run(map[bool]string{false: "plain", true: "held open by a tool"}[keepAlive], func(t *testing.T) {
			var options oar.SessionOptions
			var preload []string
			pidFile := filepath.Join(t.TempDir(), "pids.json")
			if keepAlive {
				options.Env = map[string]*string{"OAR_FIXTURE_PIDS": oar.String(pidFile)}
				preload = []string{"--import", (&url.URL{Scheme: "file", Path: mustAbs(filepath.Join(fixturesDir, "agent-tree.mjs"))}).String()}
			}
			session := mustStart(t, options, preload...)
			var tree *agentTree
			if keepAlive {
				if !eventually(func() bool { _, err := os.Stat(pidFile); return err == nil }, 10*time.Second) {
					t.Fatal("the fake agent never reported its pids")
				}
				data, _ := os.ReadFile(pidFile)
				tree = &agentTree{}
				if err := json.Unmarshal(data, tree); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					_ = syscall.Kill(tree.Agent, syscall.SIGKILL)
					_ = syscall.Kill(tree.Grandchild, syscall.SIGKILL)
				})
			}
			if err := session.Dispose(context.Background()); err != nil {
				t.Fatal(err)
			}
			records := session.Records()
			tail := describeAll(records[len(records)-2:])
			if tail[0] != "request dispose" || tail[1] != "response exited" {
				t.Fatalf("tail %q", tail)
			}
			exit := records[len(records)-1].Response
			// The fixture exits 3 on session/close; a POSIX dispose is a signal exit.
			if exit.ExitCode != nil {
				t.Fatalf("session/close must not be sent; exit code %d", *exit.ExitCode)
			}
			if tree != nil && (!gone(tree.Agent, 5*time.Second) || !gone(tree.Grandchild, 5*time.Second)) {
				t.Fatalf("tree survived: %+v", *tree)
			}
		})
	}
}

func TestModelSwitchGoesThroughTheConfigOptionAndEffortIsRefused(t *testing.T) {
	session := mustStart(t, oar.SessionOptions{Model: "requested-y"})
	if opening := describeAll(session.Records()); !contains(opening, "event session/set_config_option → model:requested-y") {
		t.Fatalf("%q", opening)
	}
	if model := session.Model().Value; model == nil || *model != "requested-y" {
		t.Fatal(model)
	}
	_, err := startAntigravity(t, oar.SessionOptions{Effort: "high"})
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "effort" || unsupported.Message != "session/new advertises no thought_level config option, so effort high cannot be applied" {
		t.Fatalf("got %#v", err)
	}
}

func TestTurnEndsOnThePromptAnswerAlone(t *testing.T) {
	session := mustStart(t, oar.SessionOptions{})
	run := promptAndWait(t, session, "hello")
	if run.Kind != "ended" || run.Outcome.Kind != "completed" {
		t.Fatalf("run %+v", run)
	}
	for _, record := range session.Records() {
		if record.Kind == oar.KindFrame && record.Frame.Type == "usage_update" {
			t.Fatal("no usage_update expected")
		}
	}
}

func TestProfileDropsPrivilegesOnlyOnLinuxAndRefusesASystemPrompt(t *testing.T) {
	jsonEqual(t, AcpArgs("linux"), []string{"--uid="})
	jsonEqual(t, AcpArgs("darwin"), []string{})
	jsonEqual(t, AcpArgs("windows"), []string{})
	if !Profile.ModelViaConfigOption || Profile.SelectAuthMethod != nil || Profile.Capabilities.Attribution != "opaque" {
		t.Fatal("profile shape")
	}
	if Profile.ValidateOptions(oar.SessionOptions{Cwd: "/", SystemPrompt: oar.String("x")}) == nil {
		t.Fatal("systemPrompt accepted")
	}
	if Profile.ValidateOptions(oar.SessionOptions{Cwd: "/", AppendSystemPrompt: oar.String("x")}) == nil {
		t.Fatal("appendSystemPrompt accepted")
	}
	if err := Profile.ValidateOptions(oar.SessionOptions{Cwd: "/"}); err != nil {
		t.Fatal(err)
	}
}

func TestYoloIsFoundInModesOrTheModeConfigOption(t *testing.T) {
	record := func(text string) map[string]any {
		var value map[string]any
		_ = json.Unmarshal([]byte(text), &value)
		return value
	}
	if !SupportsYolo(record(`{"modes":{"availableModes":[{"id":"default"},{"id":"yolo"}]}}`)) {
		t.Fatal("modes")
	}
	if !SupportsYolo(record(`{"configOptions":[{"id":"mode","options":[{"value":"default"},{"value":"yolo"}]}]}`)) {
		t.Fatal("config option")
	}
	if SupportsYolo(record(`{"modes":{"availableModes":[{"id":"default"}]},"configOptions":[]}`)) {
		t.Fatal("none")
	}
}

func TestReadsItsReleaseFromTheBuildLabelLine(t *testing.T) {
	if got := ReadVersion("Built on Mon Sep 22 2026\nBuild label: 1.2.1\nBuild target: agy_acp_server\n"); got != "1.2.1" {
		t.Fatal(got)
	}
	if got := ReadVersion("v24.0.0\n"); got != "" {
		t.Fatal(got)
	}
	// Node's `--version` has no Build label, so the snapshot carries no version rather than a wrong one.
	node := nodePath(t)
	t.Setenv("OAR_ANTIGRAVITY_BIN", node)
	snapshot, err := Installation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, snapshot, map[string]any{"kind": "available", "via": "executable", "command": node})
}

// ─── antigravity-disallowed-tools.test.ts ──────────────────────────────────

func TestNativeBuiltinDenylistUsesTheSameMetaOnCreateAndResume(t *testing.T) {
	for _, resume := range []string{"", "old-session"} {
		options := oar.SessionOptions{Cwd: "/nonexistent", DisallowedTools: []string{"run_command", "view_file"}, Resume: resume}
		if err := ToolDenials(options); err != nil {
			t.Fatal(err)
		}
		jsonEqual(t, Profile.SessionMeta(options), map[string]any{"agy": map[string]any{"disabledTools": []string{"run_command", "view_file"}}})
		if meta := Profile.SessionMeta(oar.SessionOptions{Cwd: "/nonexistent"}); meta != nil {
			t.Fatalf("meta %v", meta)
		}
		jsonEqual(t, Profile.SessionMeta(oar.SessionOptions{Cwd: "/nonexistent", DisallowedTools: []string{}}), map[string]any{"agy": map[string]any{"disabledTools": []string{}}})
	}
}

func TestMixedSupportedAndUnsupportedNamesFailBeforeSpawning(t *testing.T) {
	_, err := Session(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "/nonexistent"}, oar.SessionOptions{
		Cwd: "/nonexistent", Resume: "old-session", DisallowedTools: []string{"run_command", "mcp__probe__echo", "client_view_file", "RUN_COMMAND"},
	})
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "disallowedTools" || !strings.Contains(err.Error(), `["mcp__probe__echo","client_view_file","RUN_COMMAND"]`) {
		t.Fatalf("got %#v", err)
	}
}

// ─── acp-session-mcp-servers.test.ts (antigravity) ─────────────────────────

func openLog(t *testing.T) (string, func() []any) {
	file := filepath.Join(t.TempDir(), "opens.jsonl")
	return file, func() []any {
		data, err := os.ReadFile(file)
		out := []any{}
		if err != nil {
			return out
		}
		for _, line := range strings.Split(string(data), "\n") {
			if line == "" {
				continue
			}
			var value any
			if err := json.Unmarshal([]byte(line), &value); err != nil {
				t.Fatal(err)
			}
			out = append(out, value)
		}
		return out
	}
}

var credentialServers = []oar.McpServer{
	{Name: "echo", Command: "/bin/echo-server", Env: map[string]string{"OAR_ECHO_TOKEN": "stdio-secret-value"}},
	{Name: "remote", Type: "http", URL: "http://127.0.0.1:9/mcp", Headers: map[string]string{"Authorization": "Bearer http-secret-value"}},
}

func TestRefusesAnEntryCarryingACredentialBeforeItStarts(t *testing.T) {
	for _, server := range credentialServers {
		t.Run(server.Name, func(t *testing.T) {
			file, read := openLog(t)
			_, err := startAntigravity(t, oar.SessionOptions{MCPServers: []oar.McpServer{server}, Env: map[string]*string{"FAKE_ACP_MCP_LOG": &file, "FAKE_ACP_MCP_HTTP": oar.String("1")}})
			var unsupported *oar.UnsupportedOptionError
			if !errors.As(err, &unsupported) || unsupported.Option != "mcpServers" {
				t.Fatalf("got %#v", err)
			}
			want := `stores a session's MCP servers, env and header values included, in plain text in its conversation database, where they outlive the session; it attaches no entry with env or headers ("` + server.Name + `")`
			if !strings.Contains(err.Error(), want) {
				t.Fatal(err)
			}
			jsonEqual(t, read(), []any{})
		})
	}
}

func TestAttachesEntriesWithoutCredentials(t *testing.T) {
	file, read := openLog(t)
	bare := []oar.McpServer{{Name: "echo", Command: "/bin/echo-server", Env: map[string]string{}}, {Name: "remote", Type: "http", URL: "http://127.0.0.1:9/mcp"}}
	session := mustStart(t, oar.SessionOptions{MCPServers: bare, Env: map[string]*string{"FAKE_ACP_MCP_LOG": &file, "FAKE_ACP_MCP_HTTP": oar.String("1")}})
	if err := session.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, read(), json.RawMessage(`[{"method":"session/new","mcpServers":[
		{"name":"echo","command":"/bin/echo-server","args":[],"env":[]},
		{"type":"http","name":"remote","url":"http://127.0.0.1:9/mcp","headers":[]}]}]`))
}
