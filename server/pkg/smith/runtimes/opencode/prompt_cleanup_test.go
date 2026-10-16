package opencode

// Ported from tests/opencode/prompt-cleanup.test.ts: the ACP open is
// replaced by a scripted session and `opencode debug config` answers `{}`
// (no default_agent, so `build`).

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

var notSpawned = oar.AvailableInstallation{Via: "executable", Command: "not-spawned", Version: "1.18.35"}

// opening records what each open received and answers with session.
type opening struct {
	mu      sync.Mutex
	options []oar.SessionOptions
	answer  func(oar.SessionOptions) (oar.Session, error)
}

func (o *opening) open(_ context.Context, _ oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
	o.mu.Lock()
	o.options = append(o.options, options)
	answer := o.answer
	o.mu.Unlock()
	return answer(options)
}

func (o *opening) calls() []oar.SessionOptions {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]oar.SessionOptions{}, o.options...)
}

func scriptedSession(t *testing.T) oar.Session {
	t.Helper()
	runtime := oartest.Runtime(oartest.Options{ID: "cleanup", Turn: func(*oartest.Turn) error { return nil }})
	cwd, _ := os.Getwd()
	session, err := runtime.Session(context.Background(), oar.AvailableInstallation{Via: "bundled"}, oar.SessionOptions{Cwd: cwd})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Dispose(context.Background()) })
	return session
}

// setup opens every ACP session as native, through a recorded opening.
func setup(t *testing.T, native oar.Session) *opening {
	useRunner(t, ok("{}"))
	recorded := &opening{answer: func(oar.SessionOptions) (oar.Session, error) { return native, nil }}
	useOpening(t, recorded.open)
	return recorded
}

func temporaryFile(t *testing.T, options oar.SessionOptions) string {
	t.Helper()
	content := options.Env["OPENCODE_CONFIG_CONTENT"]
	if content == nil {
		t.Fatal("no overlay")
	}
	var overlay struct {
		Instructions []string `json:"instructions"`
	}
	if err := json.Unmarshal([]byte(*content), &overlay); err != nil || len(overlay.Instructions) == 0 {
		t.Fatalf("%s %v", *content, err)
	}
	return overlay.Instructions[0]
}

func exists(file string) bool {
	_, err := os.Stat(file)
	return err == nil
}

func openOpencode(t *testing.T, options oar.SessionOptions) oar.Session {
	t.Helper()
	if options.Cwd == "" {
		options.Cwd, _ = os.Getwd()
	}
	session, err := Session(context.Background(), notSpawned, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Dispose(context.Background()) })
	return session
}

func TestBaselineOpensDirectlyWithoutInjectingConfiguration(t *testing.T) {
	recorded := setup(t, scriptedSession(t))
	cwd, _ := os.Getwd()
	options := oar.SessionOptions{Cwd: cwd, Env: map[string]*string{"OPENCODE_CONFIG_CONTENT": oar.String("existing")}}
	openOpencode(t, options)
	calls := recorded.calls()
	if len(calls) != 1 || calls[0].Env["OPENCODE_CONFIG_CONTENT"] != options.Env["OPENCODE_CONFIG_CONTENT"] || len(calls[0].Env) != 1 {
		t.Fatalf("%+v", calls)
	}
}

// disposeProbe checks the instructions file is still there while the child disposes.
type disposeProbe struct {
	oar.Session
	file    func() string
	present bool
	once    sync.Once
}

func (d *disposeProbe) Dispose(ctx context.Context) error {
	d.once.Do(func() { d.present = exists(d.file()) })
	return d.Session.Dispose(ctx)
}

func TestConcurrentDisposalsWaitForTheChildBeforeRemovingItsInstructions(t *testing.T) {
	var file string
	probe := &disposeProbe{Session: scriptedSession(t), file: func() string { return file }}
	recorded := setup(t, probe)
	session := openOpencode(t, oar.SessionOptions{AppendSystemPrompt: oar.String("extra")})
	file = temporaryFile(t, recorded.calls()[0])
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() { defer wait.Done(); _ = session.Dispose(context.Background()) }()
	}
	wait.Wait()
	if !probe.present {
		t.Fatal("the instructions were removed before the child was disposed")
	}
	if exists(file) {
		t.Fatal("the instructions outlived the session")
	}
}

func TestAnExitBeforeHostDisposalRemovesInstructions(t *testing.T) {
	native := scriptedSession(t)
	recorded := setup(t, native)
	openOpencode(t, oar.SessionOptions{AppendSystemPrompt: oar.String("extra")})
	file := temporaryFile(t, recorded.calls()[0])
	if err := native.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !eventually(func() bool { return !exists(file) }, 5e9) {
		t.Fatal("the instructions outlived the exit")
	}
}

func TestFailedACPOpenCleansUpTheFileItReceived(t *testing.T) {
	useRunner(t, ok("{}"))
	var file string
	recorded := &opening{answer: func(options oar.SessionOptions) (oar.Session, error) {
		file = temporaryFile(t, options)
		if !exists(file) {
			t.Error("the instructions were not written before the open")
		}
		return nil, errors.New("native open failed")
	}}
	useOpening(t, recorded.open)
	cwd, _ := os.Getwd()
	_, err := Session(context.Background(), notSpawned, oar.SessionOptions{Cwd: cwd, AppendSystemPrompt: oar.String("extra")})
	if err == nil || !strings.Contains(err.Error(), "native open failed") {
		t.Fatal(err)
	}
	if exists(file) {
		t.Fatal("the instructions outlived the failed open")
	}
}

func TestAPromptAndMcpServersTogetherBothReachTheACPOpen(t *testing.T) {
	for _, c := range []struct {
		name    string
		options oar.SessionOptions
		overlay func(t *testing.T, overlay map[string]any)
	}{
		{"systemPrompt", oar.SessionOptions{SystemPrompt: oar.String("replacement")}, func(t *testing.T, overlay map[string]any) {
			jsonEqual(t, overlay["agent"], map[string]any{"build": map[string]any{"prompt": "replacement"}})
		}},
		{"appendSystemPrompt", oar.SessionOptions{AppendSystemPrompt: oar.String("extra")}, func(t *testing.T, overlay map[string]any) {
			if files, _ := overlay["instructions"].([]any); len(files) != 1 {
				t.Fatalf("%v", overlay)
			}
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			recorded := setup(t, scriptedSession(t))
			servers := []oar.McpServer{{Name: "probe", Command: "not-spawned", Env: map[string]string{"TOKEN": "value"}}}
			options := c.options
			options.MCPServers = servers
			openOpencode(t, options)
			opened := recorded.calls()[0]
			jsonEqual(t, opened.MCPServers, servers)
			var overlay map[string]any
			if err := json.Unmarshal([]byte(*opened.Env["OPENCODE_CONFIG_CONTENT"]), &overlay); err != nil {
				t.Fatal(err)
			}
			c.overlay(t, overlay)
		})
	}
}

func TestAnMcpListWithARepeatedNameFailsBeforePromptPreparationAndACPOpening(t *testing.T) {
	recorded := setup(t, scriptedSession(t))
	probe := oar.McpServer{Name: "probe", Command: "not-spawned"}
	cwd, _ := os.Getwd()
	_, err := Session(context.Background(), notSpawned, oar.SessionOptions{Cwd: cwd, AppendSystemPrompt: oar.String("extra"), MCPServers: []oar.McpServer{probe, probe}})
	if err == nil || !strings.Contains(err.Error(), `mcpServers names "probe" twice`) {
		t.Fatal(err)
	}
	if len(recorded.calls()) != 0 {
		t.Fatal("opened")
	}
}
