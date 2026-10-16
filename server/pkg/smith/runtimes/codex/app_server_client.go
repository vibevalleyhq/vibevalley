package codex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sort"
	"sync"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
)

// A minimal persistent JSON-RPC client over codex app-server's stdio JSONL
// transport (app-server-client.ts). Local to the codex runtime until a
// second consumer earns a shared promotion; process mechanics live in
// internal/executable.
//
// Concurrency: every inbound line is handled on the process's one delivery
// goroutine. A request's onSettled, the held frames and marks, and the
// registered handlers all run there (or, for frames held before handle,
// on the goroutine calling handle), never two at once, and never with the
// client's own lock held: they take the session's lock themselves.

// rpcResult is a request's result, decoded and as the raw text a record keeps.
type rpcResult struct {
	record jsonx.Record
	raw    json.RawMessage
}

// rpcOutcome is how a request settled, delivered as the reply line (or the
// exit) is processed: "result" (result), "error" (err, native: codex's error
// object, redacted) or "exited" (err).
type rpcOutcome struct {
	kind   string
	result rpcResult
	err    error
	native jsonx.Record
}

// rpcError is an RPC failure codex answered: its redacted message, and the
// native error as diagnostic context (TS: the error's cause).
type rpcError struct {
	message string
	cause   shared.NativeError
}

func (e *rpcError) Error() string { return e.message }

// appServerHandlers receive inbound notifications and server-initiated
// requests (frames with both `id` and `method`: approvals, user input,
// dynamic tools; the client does not answer them). params is the raw
// params object (`{}` when there is none).
type appServerHandlers struct {
	onNotification  func(method string, params json.RawMessage)
	onServerRequest func(id, method string, params json.RawMessage)
}

// appServerClient is a codex app-server, started (or queued to start, see
// home_initialization.go).
type appServerClient interface {
	// spawned is nil once the process started, its spawn error otherwise.
	spawned(ctx context.Context) error
	// exited is closed once the exit was reported to every exit handler.
	exited() <-chan struct{}
	// request sends a request and waits for its answer. onSettled, when
	// given, runs at the moment the reply line (or the exit) is processed,
	// before any later line, so a caller can record the reply in stream
	// order; the call returns afterwards. A ctx that ends first abandons the
	// wait (onSettled then never runs).
	request(ctx context.Context, method string, params any, onSettled func(rpcOutcome)) (rpcResult, error)
	notify(method string, params any)
	// handle registers the inbound handlers, once. Notifications and server
	// requests that arrived before (the app-server talks right after
	// `initialize`, before the thread exists) are held in ONE queue and
	// delivered here, in wire order across both kinds: nothing the server
	// said is lost or reordered by registration timing.
	handle(handlers appServerHandlers) error
	// mark places a callback in wire order: while frames are still held
	// (before handle) it joins the held queue and runs at flush, after every
	// frame read before it and before every frame read after; once released
	// it runs immediately. Called from a request's onSettled, it pins a
	// record exactly where the reply sat on the wire.
	mark(callback func())
	onExit(handler func(code *int))
	kill()
	// resources is the app-server's memory with everything it started; nil
	// once it exited (or while it waits its turn to start).
	resources() *executable.Resources
}

// appServerProcess is what the client uses of executable.LineProcess.
type appServerProcess interface {
	Write(text string)
	OnLine(handler func(line string))
	OnExit(handler func(code *int))
	Kill()
	Exited() <-chan struct{}
	Diagnostics() executable.Diagnostics
	Resources() *executable.Resources
}

// spawnLineProcess starts an app-server; tests replace it with a scripted
// process (TS: vi.mock of spawnLineProcess).
var spawnLineProcess = func(command string, args []string, options executable.LineOptions) (appServerProcess, error) {
	process, err := executable.Spawn(command, args, options)
	if err != nil {
		return nil, err
	}
	return process, nil
}

// appServerProcessOptions is how the app-server process is handled.
type appServerProcessOptions struct {
	// Whether its stderr may reach the host's (nil: the default).
	inheritStderr *bool
	// Applied to the text of every error the client reports (codex's error
	// message, the exit's stderr tail): a session's MCP credentials must
	// never reach one.
	redact func(string) string
	// The host's own `app-server` arguments (SessionOptions.LaunchArgs),
	// unchecked, after oar's `-c` overrides and before `--listen`.
	launchArgs []string
}

// configOverride is one `-c KEY=VALUE` launch override.
type configOverride struct{ key, value string }

// startAppServerClient starts `codex app-server` (cwd "" is the host's),
// coordinated with the other clients of its CODEX_HOME.
func startAppServerClient(command string, env map[string]*string, overrides []configOverride, cwd string, options appServerProcessOptions) appServerClient {
	environment := shared.Environment(env)
	directory := cwd
	if directory == "" {
		if current, err := os.Getwd(); err == nil {
			directory = current
		} else {
			directory = "."
		}
	}
	return coordinateHomeInitialization(environment, directory, func() appServerClient {
		return createAppServerClient(command, environment, overrides, directory, options)
	})
}

type pendingRPC struct {
	method  string
	settled func(rpcOutcome)
	done    chan rpcOutcome
}

type directClient struct {
	process  appServerProcess
	spawnErr error
	redact   func(string) string

	mu          sync.Mutex
	pending     map[int]*pendingRPC
	nextID      int
	exitFailure error
	handlers    *appServerHandlers
	handled     bool
	held        []func(appServerHandlers)
}

func createAppServerClient(command string, env []string, overrides []configOverride, cwd string, options appServerProcessOptions) appServerClient {
	// -c KEY=VALUE injects config at launch, for every thread of this
	// process (session.go sets sandbox_mode this way). thread/start can also
	// set the sandbox per thread, but its field is `sandbox`: an unknown field
	// such as `sandboxMode` is ignored without an error.
	args := []string{"app-server"}
	for _, override := range overrides {
		args = append(args, "-c", override.key+"="+override.value)
	}
	args = append(append(args, options.launchArgs...), "--listen", "stdio://")
	redact := options.redact
	if redact == nil {
		redact = func(text string) string { return text }
	}
	client := &directClient{redact: redact, pending: map[int]*pendingRPC{}, nextID: 1}
	process, err := spawnLineProcess(command, args, executable.LineOptions{Dir: cwd, Env: env, KillTree: true, InheritStderr: options.inheritStderr})
	if err != nil {
		// Go spawns synchronously; TS sees a spawn failure as an exit whose
		// diagnostics carry the error. The client starts out exited.
		client.spawnErr = err
		client.process = deadProcess{}
		client.exitFailure = executable.ProcessFailure("app-server exited", executable.Diagnostics{Error: redact(err.Error())})
		return client
	}
	client.process = process
	process.OnLine(client.onLine)
	process.OnExit(client.onProcessExit)
	return client
}

func (c *directClient) deliver(delivery func(appServerHandlers)) {
	c.mu.Lock()
	if c.handlers == nil {
		c.held = append(c.held, delivery)
		c.mu.Unlock()
		return
	}
	handlers := *c.handlers
	c.mu.Unlock()
	delivery(handlers)
}

// rawObject is a field's raw text when it is a JSON object, else `{}`.
func rawObject(fields map[string]json.RawMessage, record jsonx.Record, key string) json.RawMessage {
	if jsonx.AsRecord(record[key]) == nil {
		return json.RawMessage(`{}`)
	}
	return fields[key]
}

func (c *directClient) onLine(line string) {
	message := jsonx.ParseRecord([]byte(line))
	if message == nil {
		return
	}
	fields := jsonx.RawFields([]byte(line))
	numericID, isNumber := message["id"].(float64)
	textID, isText := message["id"].(string)
	if method, ok := message["method"].(string); ok {
		params := rawObject(fields, message, "params")
		if isNumber || isText {
			id := textID
			if isNumber {
				id = jsString(numericID)
			}
			c.deliver(func(handlers appServerHandlers) { handlers.onServerRequest(id, method, params) })
		} else {
			c.deliver(func(handlers appServerHandlers) { handlers.onNotification(method, params) })
		}
		return
	}
	if !isNumber || numericID != float64(int(numericID)) {
		return
	}
	c.mu.Lock()
	waiter, ok := c.pending[int(numericID)]
	delete(c.pending, int(numericID))
	c.mu.Unlock()
	if !ok {
		return
	}
	if failure := jsonx.AsRecord(message["error"]); failure != nil {
		cause := shared.NativeErrorCause(waiter.method, failure, c.redact)
		text, isString := failure["message"].(string)
		if !isString {
			text = "app-server error"
		}
		outcome := rpcOutcome{kind: "error", err: &rpcError{message: c.redact(text), cause: cause}, native: cause.Native}
		waiter.settled(outcome)
		waiter.done <- outcome
		return
	}
	result := jsonx.AsRecord(message["result"])
	if result == nil {
		result = jsonx.Record{}
	}
	outcome := rpcOutcome{kind: "result", result: rpcResult{record: result, raw: rawObject(fields, message, "result")}}
	waiter.settled(outcome)
	waiter.done <- outcome
}

func (c *directClient) onProcessExit(*int) {
	diagnostics := c.process.Diagnostics()
	diagnostics.Stderr = c.redact(diagnostics.Stderr)
	diagnostics.Error = c.redact(diagnostics.Error)
	failure := executable.ProcessFailure("app-server exited", diagnostics)
	c.mu.Lock()
	c.exitFailure = failure
	ids := make([]int, 0, len(c.pending))
	for id := range c.pending {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	waiters := make([]*pendingRPC, 0, len(ids))
	for _, id := range ids {
		waiters = append(waiters, c.pending[id])
	}
	// Go's LineProcess reports the exit after the last line, so no reply can
	// follow: nothing is kept for a late one (TS keeps the settled callbacks
	// until stdout drains).
	c.pending = map[int]*pendingRPC{}
	c.mu.Unlock()
	for _, waiter := range waiters {
		outcome := rpcOutcome{kind: "exited", err: failure}
		waiter.settled(outcome)
		waiter.done <- outcome
	}
}

func (c *directClient) spawned(context.Context) error { return c.spawnErr }

func (c *directClient) exited() <-chan struct{} { return c.process.Exited() }

func (c *directClient) request(ctx context.Context, method string, params any, onSettled func(rpcOutcome)) (rpcResult, error) {
	settled := onSettled
	if settled == nil {
		settled = func(rpcOutcome) {}
	}
	c.mu.Lock()
	if c.exitFailure != nil {
		failure := c.exitFailure
		c.mu.Unlock()
		settled(rpcOutcome{kind: "exited", err: failure})
		return rpcResult{}, failure
	}
	id := c.nextID
	c.nextID++
	waiter := &pendingRPC{method: method, settled: settled, done: make(chan rpcOutcome, 1)}
	c.pending[id] = waiter
	c.mu.Unlock()
	c.process.Write(jsonText(struct {
		ID     int    `json:"id"`
		Method string `json:"method"`
		Params any    `json:"params"`
	}{id, method, params}) + "\n")
	select {
	case outcome := <-waiter.done:
		if outcome.kind == "result" {
			return outcome.result, nil
		}
		return rpcResult{}, outcome.err
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return rpcResult{}, ctx.Err()
	}
}

func (c *directClient) notify(method string, params any) {
	c.process.Write(jsonText(struct {
		Method string `json:"method"`
		Params any    `json:"params"`
	}{method, params}) + "\n")
}

func (c *directClient) handle(handlers appServerHandlers) error {
	c.mu.Lock()
	if c.handled {
		c.mu.Unlock()
		return errors.New("app-server handlers are already registered")
	}
	c.handled = true
	for {
		if len(c.held) == 0 {
			c.handlers = &handlers
			c.mu.Unlock()
			return nil
		}
		batch := c.held
		c.held = nil
		c.mu.Unlock()
		for _, delivery := range batch {
			delivery(handlers)
		}
		c.mu.Lock()
	}
}

func (c *directClient) mark(callback func()) {
	c.deliver(func(appServerHandlers) { callback() })
}

func (c *directClient) onExit(handler func(code *int)) { c.process.OnExit(handler) }

func (c *directClient) kill() { c.process.Kill() }

func (c *directClient) resources() *executable.Resources { return c.process.Resources() }

// deadProcess stands for an app-server that could not be spawned: it has
// already exited, with no code.
type deadProcess struct{}

var closedChannel = func() chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}()

func (deadProcess) Write(string)                        {}
func (deadProcess) OnLine(func(string))                 {}
func (deadProcess) OnExit(handler func(*int))           { go handler(nil) }
func (deadProcess) Kill()                               {}
func (deadProcess) Exited() <-chan struct{}             { return closedChannel }
func (deadProcess) Diagnostics() executable.Diagnostics { return executable.Diagnostics{} }
func (deadProcess) Resources() *executable.Resources    { return nil }

// ignoredFrames are handlers for a client that records nothing it is told.
var ignoredFrames = appServerHandlers{
	onNotification:  func(string, json.RawMessage) {},
	onServerRequest: func(string, string, json.RawMessage) {},
}
