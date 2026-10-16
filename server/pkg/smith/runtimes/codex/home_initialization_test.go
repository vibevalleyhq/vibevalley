package codex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/codex/codex-home-initialization.test.ts.

func freshHome(t *testing.T) string {
	home, err := os.MkdirTemp("", "oar-first-home-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	real, err := filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

// coldHome models the observed native failure: a second cold initializer cannot start.
type coldHome struct {
	mu          sync.Mutex
	initialized bool
	coldActive  bool
	children    []*fakeProcess
	replies     []func()
	firstReady  chan func()
	firstOnce   sync.Once
}

func coldNativeHome(t *testing.T) *coldHome {
	native := &coldHome{firstReady: make(chan func(), 1)}
	useSpawner(t, func(index int) *fakeProcess {
		native.mu.Lock()
		number := len(native.children) + 1
		collides := !native.initialized && native.coldActive
		if !native.initialized {
			native.coldActive = true
		}
		native.mu.Unlock()
		fake := newFakeProcess(func(text string, child *fakeProcess) {
			message := jsonx.ParseRecord([]byte(text))
			id, ok := message["id"].(float64)
			if !ok {
				return
			}
			if collides {
				child.emitStderr("sqlite initialization failed")
				child.end(intPtr(1), "")
				return
			}
			threadID := "thread-" + jsonText(number)
			reply := func() {
				result := jsonx.Record{}
				if message["method"] != "initialize" {
					result = jsonx.Record{"thread": jsonx.Record{"id": threadID}, "model": "gpt-5.5"}
				}
				chunk := jsonText(jsonx.Record{"id": id, "result": result}) + "\n"
				if message["method"] == "thread/start" {
					chunk += jsonText(jsonx.Record{"method": "thread/started", "params": jsonx.Record{"thread": jsonx.Record{"id": threadID}}}) + "\n"
				}
				child.emit(chunk)
			}
			native.mu.Lock()
			first := message["method"] == "initialize" && !native.initialized
			native.mu.Unlock()
			if !first {
				reply()
				return
			}
			finish := func() {
				native.mu.Lock()
				native.initialized = true
				native.mu.Unlock()
				reply()
			}
			native.mu.Lock()
			native.replies = append(native.replies, finish)
			native.mu.Unlock()
			native.firstOnce.Do(func() { native.firstReady <- finish })
		})
		if !collides {
			fake.OnExit(func(*int) {
				native.mu.Lock()
				native.coldActive = false
				native.mu.Unlock()
			})
		}
		native.mu.Lock()
		native.children = append(native.children, fake)
		native.mu.Unlock()
		return fake
	})
	return native
}

func (c *coldHome) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.children)
}

func (c *coldHome) child(index int) *fakeProcess {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.children[index]
}

func homeEnv(home string) map[string]*string {
	return map[string]*string{"CODEX_HOME": oar.String(home)}
}

func asyncRequest(t *testing.T, client appServerClient, method string) chan error {
	done := make(chan error, 1)
	go func() {
		_, err := client.request(testContext(t), method, jsonx.Record{}, nil)
		done <- err
	}()
	return done
}

func TestConcurrentSessionsOnAFreshHomeWaitForTheFirstNativeInitialization(t *testing.T) {
	home := freshHome(t)
	native := coldNativeHome(t)
	type opened struct {
		session oar.Session
		err     error
	}
	results := make(chan opened, 8)
	for range 8 {
		go func() {
			session, err := Session(testContext(t), testInstallation, oar.SessionOptions{Cwd: home, Env: homeEnv(home)})
			results <- opened{session, err}
		}()
	}
	release := <-native.firstReady
	// Let every opener reach the gate before the first initialization finishes.
	time.Sleep(50 * time.Millisecond)
	beforeReady := native.count()
	release()
	for range 8 {
		result := <-results
		if result.err != nil {
			t.Fatalf("an open failed: %v", result.err)
		}
		// Waiting must not move the open marker past a same-chunk notification.
		eventually(t, "thread/started", func() bool { return len(result.session.Records()) >= 2 })
		records := result.session.Records()
		sameJSON(t, []string{records[0].Frame.Type, records[1].Frame.Type}, `["thread/start","thread/started"]`)
		_ = result.session.Dispose(testContext(t))
	}
	if beforeReady != 1 {
		t.Fatalf("%d app-servers before the first initialization", beforeReady)
	}
}

func TestAQueuedClientCanBeKilledWithoutSpawningLaterOrBlockingTheInitializer(t *testing.T) {
	home := freshHome(t)
	native := coldNativeHome(t)
	first := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	initialize := asyncRequest(t, first, "initialize")
	queued := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	failed := asyncRequest(t, queued, "initialize")
	queued.kill()
	if err := <-failed; err == nil || !strings.Contains(err.Error(), "cancelled before spawn") {
		t.Fatalf("err %v", err)
	}
	<-queued.exited()
	(<-native.firstReady)()
	if err := <-initialize; err != nil {
		t.Fatal(err)
	}
	first.notify("initialized", jsonx.Record{})
	if native.count() != 1 {
		t.Fatalf("%d app-servers", native.count())
	}
	first.kill()
}

func TestAnInitializersUnexpectedExitReleasesItsHomeWithoutMarkingItReady(t *testing.T) {
	home := freshHome(t)
	native := coldNativeHome(t)
	first := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	failed := asyncRequest(t, first, "initialize")
	second := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	succeeding := asyncRequest(t, second, "initialize")
	eventually(t, "the first request", func() bool { return len(native.child(0).requests()) == 1 })
	native.child(0).end(intPtr(1), "")
	if err := <-failed; err == nil || !strings.Contains(err.Error(), "app-server exited") {
		t.Fatalf("err %v", err)
	}
	eventually(t, "the second initializer", func() bool {
		native.mu.Lock()
		defer native.mu.Unlock()
		return len(native.replies) == 2
	})
	native.mu.Lock()
	reply := native.replies[1]
	native.mu.Unlock()
	reply()
	if err := <-succeeding; err != nil {
		t.Fatal(err)
	}
	second.notify("initialized", jsonx.Record{})
	if native.count() != 2 {
		t.Fatalf("%d app-servers", native.count())
	}
	second.kill()
}

func TestARejectedInitializeWaitsForProcessExitBeforeStartingTheNextInitializer(t *testing.T) {
	home := freshHome(t)
	native := coldNativeHome(t)
	first := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	child := native.child(0)
	kills := make(chan struct{}, 4)
	child.mu.Lock()
	child.killHook = func() { kills <- struct{}{} }
	child.mu.Unlock()
	failed := asyncRequest(t, first, "initialize")
	second := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	third := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	eventually(t, "the request", func() bool { return len(child.requests()) == 1 })
	child.emitJSON(jsonx.Record{"id": 1, "error": jsonx.Record{"message": "native initialization failed"}})
	select {
	case <-kills:
	case <-time.After(5 * time.Second):
		t.Fatal("the initializer was not killed")
	}
	time.Sleep(20 * time.Millisecond)
	if native.count() != 1 {
		t.Fatalf("%d app-servers before the exit", native.count())
	}
	child.end(intPtr(1), "")
	if err := <-failed; err == nil || !strings.Contains(err.Error(), "native initialization failed") {
		t.Fatalf("err %v", err)
	}
	eventually(t, "the next initializer", func() bool { return native.count() == 2 })
	third.kill()
	second.kill()
}

func TestDifferentHomesDoNotWaitForOneAnother(t *testing.T) {
	home, other := freshHome(t), freshHome(t)
	native := coldNativeHome(t)
	first := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	second := startAppServerClient("codex", homeEnv(other), nil, "", appServerProcessOptions{})
	if native.count() != 2 {
		t.Fatalf("%d app-servers", native.count())
	}
	first.kill()
	second.kill()
}

func TestAHomeAliasSharesTheSameInitializationGate(t *testing.T) {
	for _, kind := range []string{"relative", "trailing-separator", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			home, parent := freshHome(t), freshHome(t)
			alias := filepath.Join(parent, "alias")
			switch kind {
			case "relative":
				alias = filepath.Base(home)
			case "trailing-separator":
				alias = home + string(filepath.Separator)
			default:
				if err := os.Symlink(home, alias); err != nil {
					t.Fatal(err)
				}
			}
			native := coldNativeHome(t)
			first := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
			second := startAppServerClient("codex", homeEnv(alias), nil, filepath.Dir(home), appServerProcessOptions{})
			if native.count() != 1 {
				t.Fatalf("%d app-servers", native.count())
			}
			second.kill()
			first.kill()
			<-first.exited()
		})
	}
}

func TestLaterClientsOnAnInitializedHomeStartConcurrently(t *testing.T) {
	home := freshHome(t)
	native := coldNativeHome(t)
	first := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	initialize := asyncRequest(t, first, "initialize")
	second := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	(<-native.firstReady)()
	if err := <-initialize; err != nil {
		t.Fatal(err)
	}
	// The response alone does not release the next process before initialized.
	if native.count() != 1 {
		t.Fatalf("%d app-servers", native.count())
	}
	first.notify("initialized", jsonx.Record{})
	first.kill()
	third := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	if native.count() != 3 {
		t.Fatalf("%d app-servers", native.count())
	}
	second.kill()
	third.kill()
}

func TestAnAccountQueryKeepsItsExistingDeadlineWhileQueuedForInitialization(t *testing.T) {
	home := freshHome(t)
	t.Setenv("CODEX_HOME", home)
	native := coldNativeHome(t)
	first := startAppServerClient("codex", nil, nil, "", appServerProcessOptions{})
	usage := readFromAppServer(context.Background(), "codex", 321*time.Millisecond, defaultAccountClient)
	sameJSON(t, usage.kind, `"error"`)
	if native.count() != 1 {
		t.Fatalf("%d app-servers", native.count())
	}
	first.kill()
	if native.count() != 1 {
		t.Fatalf("%d app-servers", native.count())
	}
}

func TestReplacingAHomeAtTheSamePathInvalidatesObservedReadiness(t *testing.T) {
	parent := freshHome(t)
	home := filepath.Join(parent, "home")
	if err := os.Mkdir(home, 0o755); err != nil {
		t.Fatal(err)
	}
	native := coldNativeHome(t)
	first := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	initialize := asyncRequest(t, first, "initialize")
	(<-native.firstReady)()
	if err := <-initialize; err != nil {
		t.Fatal(err)
	}
	first.notify("initialized", jsonx.Record{})
	first.kill()
	<-first.exited()
	if err := os.Rename(home, filepath.Join(parent, "old")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(home, 0o755); err != nil {
		t.Fatal(err)
	}
	second := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	third := startAppServerClient("codex", homeEnv(home), nil, "", appServerProcessOptions{})
	if native.count() != 2 {
		t.Fatalf("%d app-servers", native.count())
	}
	third.kill()
	second.kill()
}
