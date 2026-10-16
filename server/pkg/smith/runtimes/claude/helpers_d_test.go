package claude

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/oar"
)

// Go equivalents of tests/fixtures/login-fixtures.ts, login-interaction.ts,
// update-fixtures.ts and process-tree.ts gone().

// useSpawn replaces spawnLineProcess with spawn for the test.
func useSpawn(t *testing.T, spawn func(command string, args []string, options executable.LineOptions) (claudeProcess, error)) {
	t.Helper()
	previous := spawnLineProcess
	spawnLineProcess = spawn
	t.Cleanup(func() { spawnLineProcess = previous })
}

// stubbornProcess is a fake whose Kill only counts (TS: vi.spyOn(fake, "kill").mockImplementation(() => {})).
type stubbornProcess struct {
	*fakeProcess
	mu    sync.Mutex
	kills int
}

func (p *stubbornProcess) Kill() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.kills++
}

func (p *stubbornProcess) killCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.kills
}

// useRunExecutable replaces runExecutable for the test.
func useRunExecutable(t *testing.T, run func(ctx context.Context, command string, args []string, options executable.RunOptions) executable.Result) {
	t.Helper()
	previous := runExecutable
	runExecutable = run
	t.Cleanup(func() { runExecutable = previous })
}

// loginNodeOrSkip is the node on PATH; the fake CLIs are node scripts.
func loginNodeOrSkip(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLIs are sh launchers")
	}
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

// fakeCli is a fake vendor CLI (one of the fake-*-login.mjs scripts), driven
// by a JSON state file it also writes back to.
type fakeCli struct {
	command   string
	stateFile string
}

func newFakeLoginCli(t *testing.T, dir, name, script string, state map[string]any) fakeCli {
	t.Helper()
	node := loginNodeOrSkip(t)
	stateFile := filepath.Join(dir, name+".json")
	encoded, _ := json.Marshal(state)
	if err := os.WriteFile(stateFile, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	fixture, err := filepath.Abs(filepath.Join("..", "..", "testdata", "fixtures", script))
	if err != nil {
		t.Fatal(err)
	}
	command := filepath.Join(dir, name)
	body := "#!/bin/sh\nexec \"" + node + "\" \"" + fixture + "\" \"${OAR_FAKE_STATE:-" + stateFile + "}\" \"$@\"\n"
	if err := os.WriteFile(command, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	// macOS takes up to ~0.6 s on the first run of a new executable, which
	// a 1 s deadline under test cannot absorb: run the wrapper once first,
	// against a state file of its own (as the codex login tests do).
	warmState := filepath.Join(dir, name+"-warm.json")
	if err := os.WriteFile(warmState, []byte(`{"version":"0.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	warm := exec.Command(command, "--version")
	warm.Env = append(os.Environ(), "OAR_FAKE_STATE="+warmState)
	_ = warm.Run()
	return fakeCli{command: command, stateFile: stateFile}
}

// read is the state file as the fake last wrote it.
func (f fakeCli) read(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile(f.stateFile)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

// reportedPid is a pid the fake reported in its state.
func (f fakeCli) reportedPid(t *testing.T, key string) int {
	t.Helper()
	pid, ok := f.read(t)[key].(float64)
	if !ok {
		t.Fatalf("the fake reported no %s", key)
	}
	return int(pid)
}

// gone reports whether pid ends within the time (process-tree.ts gone); it
// SIGKILLs a survivor so a failed test does not leak.
func pidGone(pid int, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for {
		if err := syscall.Kill(pid, 0); err != nil && !errors.Is(err, syscall.EPERM) {
			return true
		}
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// recordedInteraction records what the driver showed and answers prompts
// from a script: a string answers, "never" leaves the prompt open until the
// login's context ends, an error fails it. onPrompt runs as each prompt opens.
type recordedInteraction struct {
	mu       sync.Mutex
	answers  []any
	events   []oar.ProviderLoginEvent
	prompts  []oar.ProviderLoginPrompt
	onPrompt func(oar.ProviderLoginPrompt)
}

func newRecordedInteraction(answers ...any) *recordedInteraction {
	return &recordedInteraction{answers: answers}
}

func (r *recordedInteraction) interaction() oar.ProviderLoginInteraction {
	return oar.ProviderLoginInteraction{
		OnEvent: func(event oar.ProviderLoginEvent) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.events = append(r.events, event)
		},
		Prompt: func(ctx context.Context, prompt oar.ProviderLoginPrompt) (string, error) {
			r.mu.Lock()
			r.prompts = append(r.prompts, prompt)
			index := len(r.prompts) - 1
			var answer any = "never"
			if index < len(r.answers) {
				answer = r.answers[index]
			}
			onPrompt := r.onPrompt
			r.mu.Unlock()
			if onPrompt != nil {
				onPrompt(prompt)
			}
			if err, ok := answer.(error); ok {
				return "", err
			}
			if answer == "never" {
				<-ctx.Done()
				return "", ctx.Err()
			}
			return answer.(string), nil
		},
	}
}

func (r *recordedInteraction) recorded() ([]oar.ProviderLoginEvent, []oar.ProviderLoginPrompt) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]oar.ProviderLoginEvent(nil), r.events...), append([]oar.ProviderLoginPrompt(nil), r.prompts...)
}

// releaseServer serves fixed answers by path (update-fixtures.ts startReleaseServer).
type releaseServer struct {
	base   string
	mu     sync.Mutex
	routes map[string]releaseRoute
}

type releaseRoute struct {
	status int
	body   string
}

func startReleaseServer(t *testing.T) *releaseServer {
	t.Helper()
	server := &releaseServer{routes: map[string]releaseRoute{}}
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.mu.Lock()
		route, ok := server.routes[r.URL.Path]
		server.mu.Unlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		w.WriteHeader(route.status)
		_, _ = w.Write([]byte(route.body))
	}))
	t.Cleanup(httpServer.Close)
	server.base = httpServer.URL
	return server
}

func (s *releaseServer) set(path string, status int, body string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.routes[path] = releaseRoute{status, body}
}

// leaksNothing: the pasted value and its authorization code never show.
func leaksNothing(t *testing.T, code string, values ...any) {
	t.Helper()
	head, _, _ := strings.Cut(code, "#")
	for _, part := range []string{code, head} {
		for _, value := range values {
			if encoded := jsonText(value); strings.Contains(encoded, part) {
				t.Fatalf("%q leaked into %s", part, encoded)
			}
		}
	}
}
