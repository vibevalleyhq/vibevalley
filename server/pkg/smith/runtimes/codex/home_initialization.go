package codex

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"vibevalley/pkg/smith/internal/executable"
)

// The first initialization of a CODEX_HOME, coordinated among this
// package's app-server clients only (home-initialization.ts): codex's
// sqlite runtime state cannot be created by two cold app-servers at once, so
// while one initializes a home, later clients for it wait their turn without
// starting a process. Only an observed successful handshake establishes
// readiness. Directory identity invalidates it when a host replaces a
// temporary home at the same path.

type initializingHome struct {
	// begin funcs of the clients waiting for this home, in arrival order.
	waiting []*queuedClient
}

var homeGate = struct {
	mu           sync.Mutex
	initializing map[string]*initializingHome
	initialized  map[string]string
}{initializing: map[string]*initializingHome{}, initialized: map[string]string{}}

func envValue(env []string, name string) string {
	value := ""
	for _, entry := range env {
		key, rest, _ := strings.Cut(entry, "=")
		if key == name {
			value = rest
		}
	}
	return value
}

func homePath(env []string, cwd string) string {
	userHome := envValue(env, "HOME")
	if runtime.GOOS == "windows" || userHome == "" {
		if home, err := os.UserHomeDir(); err == nil {
			userHome = home
		}
	}
	directory := envValue(env, "CODEX_HOME")
	if directory == "" {
		directory = filepath.Join(userHome, ".codex")
	}
	if !filepath.IsAbs(directory) {
		directory = filepath.Join(cwd, directory)
	}
	if absolute, err := filepath.Abs(directory); err == nil {
		directory = absolute
	}
	if real, err := filepath.EvalSymlinks(directory); err == nil {
		return real
	}
	return directory
}

var errStartupCancelled = errors.New("Codex app-server startup cancelled before spawn")

// queuedClient is a client waiting for its home's first initialization. Its
// existing deadline can cancel it (kill) before any process starts.
type queuedClient struct {
	state *initializingHome
	start func() appServerClient

	mu            sync.Mutex
	actual        appServerClient
	cancelled     bool
	handled       bool
	ready         chan struct{}
	subscriptions []func(appServerClient)
	exitHandlers  []func(*int)
	exitedCh      chan struct{}
	// order serializes subscribed calls, so they reach the actual client in
	// the order they were made.
	order sync.Mutex
}

func newQueuedClient(state *initializingHome, start func() appServerClient) *queuedClient {
	client := &queuedClient{state: state, start: start, ready: make(chan struct{}), exitedCh: make(chan struct{})}
	state.waiting = append(state.waiting, client)
	return client
}

// begin starts the actual client, once its home is released.
func (q *queuedClient) begin() {
	q.order.Lock()
	defer q.order.Unlock()
	q.mu.Lock()
	if q.cancelled {
		q.mu.Unlock()
		return
	}
	q.mu.Unlock()
	actual := q.start()
	q.mu.Lock()
	q.actual = actual
	subscriptions := q.subscriptions
	q.subscriptions = nil
	q.exitHandlers = nil
	close(q.ready)
	q.mu.Unlock()
	for _, subscribe := range subscriptions {
		subscribe(actual)
	}
	go func() {
		<-actual.exited()
		close(q.exitedCh)
	}()
}

func (q *queuedClient) subscribe(callback func(appServerClient)) {
	q.order.Lock()
	defer q.order.Unlock()
	q.mu.Lock()
	actual := q.actual
	if actual == nil {
		if !q.cancelled {
			q.subscriptions = append(q.subscriptions, callback)
		}
		q.mu.Unlock()
		return
	}
	q.mu.Unlock()
	callback(actual)
}

// started waits for the actual client; errStartupCancelled once killed.
func (q *queuedClient) started(ctx context.Context) (appServerClient, error) {
	select {
	case <-q.ready:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.actual == nil {
		return nil, errStartupCancelled
	}
	return q.actual, nil
}

func (q *queuedClient) spawned(ctx context.Context) error {
	actual, err := q.started(ctx)
	if err != nil {
		return err
	}
	return actual.spawned(ctx)
}

func (q *queuedClient) exited() <-chan struct{} { return q.exitedCh }

func (q *queuedClient) request(ctx context.Context, method string, params any, onSettled func(rpcOutcome)) (rpcResult, error) {
	actual, err := q.started(ctx)
	if err != nil {
		if onSettled != nil && errors.Is(err, errStartupCancelled) {
			onSettled(rpcOutcome{kind: "error", err: err})
		}
		return rpcResult{}, err
	}
	return actual.request(ctx, method, params, onSettled)
}

func (q *queuedClient) notify(method string, params any) {
	q.subscribe(func(actual appServerClient) { actual.notify(method, params) })
}

func (q *queuedClient) handle(handlers appServerHandlers) error {
	q.mu.Lock()
	if q.handled {
		q.mu.Unlock()
		return errors.New("app-server handlers are already registered")
	}
	q.handled = true
	q.mu.Unlock()
	q.subscribe(func(actual appServerClient) { _ = actual.handle(handlers) })
	return nil
}

func (q *queuedClient) mark(callback func()) {
	q.subscribe(func(actual appServerClient) { actual.mark(callback) })
}

func (q *queuedClient) onExit(handler func(*int)) {
	q.mu.Lock()
	if q.cancelled {
		q.mu.Unlock()
		go handler(nil)
		return
	}
	if q.actual == nil {
		q.exitHandlers = append(q.exitHandlers, handler)
	}
	q.mu.Unlock()
	q.subscribe(func(actual appServerClient) { actual.onExit(handler) })
}

func (q *queuedClient) kill() {
	q.mu.Lock()
	if q.actual != nil {
		actual := q.actual
		q.mu.Unlock()
		actual.kill()
		return
	}
	if q.cancelled {
		q.mu.Unlock()
		return
	}
	q.cancelled = true
	q.subscriptions = nil
	handlers := q.exitHandlers
	q.exitHandlers = nil
	close(q.ready)
	q.mu.Unlock()
	homeGate.mu.Lock()
	for index, waiting := range q.state.waiting {
		if waiting == q {
			q.state.waiting = append(q.state.waiting[:index:index], q.state.waiting[index+1:]...)
			break
		}
	}
	homeGate.mu.Unlock()
	for _, handler := range handlers {
		handler(nil)
	}
	close(q.exitedCh)
}

// resources: no process yet (waiting its turn to initialize the home), or none any more: nothing to read.
func (q *queuedClient) resources() *executable.Resources {
	q.mu.Lock()
	actual := q.actual
	q.mu.Unlock()
	if actual == nil {
		return nil
	}
	return actual.resources()
}

// ownerClient is the client initializing its home: its accepted initialize
// followed by `initialized` marks the home ready; a failed initialize or its
// exit releases the home unready.
type ownerClient struct {
	appServerClient
	release  func(success bool)
	mu       sync.Mutex
	accepted bool
}

func (o *ownerClient) request(ctx context.Context, method string, params any, onSettled func(rpcOutcome)) (rpcResult, error) {
	result, err := o.appServerClient.request(ctx, method, params, func(outcome rpcOutcome) {
		if method == "initialize" && outcome.kind == "result" {
			o.mu.Lock()
			o.accepted = true
			o.mu.Unlock()
		}
		if onSettled != nil {
			onSettled(outcome)
		}
	})
	if err != nil && method == "initialize" {
		o.appServerClient.kill()
		<-o.appServerClient.exited()
		o.release(false)
	}
	return result, err
}

func (o *ownerClient) notify(method string, params any) {
	o.appServerClient.notify(method, params)
	o.mu.Lock()
	accepted := o.accepted
	o.mu.Unlock()
	if method == "initialized" && accepted {
		o.release(true)
	}
}

// coordinateHomeInitialization starts a client with create, or queues it
// while another client initializes the same home.
func coordinateHomeInitialization(env []string, cwd string, create func() appServerClient) appServerClient {
	home := homePath(env, cwd)
	homeGate.mu.Lock()
	if active, ok := homeGate.initializing[home]; ok {
		queued := newQueuedClient(active, func() appServerClient { return coordinateHomeInitialization(env, cwd, create) })
		homeGate.mu.Unlock()
		return queued
	}
	current := identity(home)
	if current != "" && homeGate.initialized[home] == current {
		homeGate.mu.Unlock()
		return create()
	}
	delete(homeGate.initialized, home)
	state := &initializingHome{}
	homeGate.initializing[home] = state
	homeGate.mu.Unlock()
	var once sync.Once
	release := func(success bool) {
		once.Do(func() {
			observed := ""
			if success {
				observed = identity(home)
			}
			homeGate.mu.Lock()
			if observed != "" {
				homeGate.initialized[home] = observed
			}
			delete(homeGate.initializing, home)
			waiting := state.waiting
			state.waiting = nil
			homeGate.mu.Unlock()
			for _, queued := range waiting {
				queued.begin()
			}
		})
	}
	client := create()
	client.onExit(func(*int) { release(false) })
	return &ownerClient{appServerClient: client, release: release}
}
