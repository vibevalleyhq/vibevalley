package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// ACP method names and protocol version, as @agentclientprotocol/sdk 1.4.0
// defines them (schema AGENT_METHODS / CLIENT_METHODS / PROTOCOL_VERSION).
const (
	ProtocolVersion = 1

	MethodInitialize          = "initialize"
	MethodAuthenticate        = "authenticate"
	MethodSessionNew          = "session/new"
	MethodSessionLoad         = "session/load"
	MethodSessionResume       = "session/resume"
	MethodSessionList         = "session/list"
	MethodSessionClose        = "session/close"
	MethodSessionSetMode      = "session/set_mode"
	MethodSessionSetModel     = "session/set_model"
	MethodSessionSetConfig    = "session/set_config_option"
	MethodSessionPrompt       = "session/prompt"
	MethodSessionCancel       = "session/cancel"
	MethodSessionUpdate       = "session/update"
	MethodRequestPermission   = "session/request_permission"
	MethodTerminalCreate      = "terminal/create"
	MethodTerminalOutput      = "terminal/output"
	MethodTerminalWaitForExit = "terminal/wait_for_exit"
	MethodTerminalKill        = "terminal/kill"
	MethodTerminalRelease     = "terminal/release"
	methodCancelRequest       = "$/cancel_request"
)

// RequestError is a JSON-RPC error answer (the SDK's RequestError): its
// message and data already passed through the process's redactor, and the
// redacted native answer in Cause (TS: the error's non-enumerable `cause`).
type RequestError struct {
	Code    int
	Message string
	// Data is the redacted `data`; HasData false when the answer had none.
	Data    any
	HasData bool
	// DataRaw is Data as the agent ordered it (redacted), for JSON.stringify readings.
	DataRaw json.RawMessage
	Cause   *NativeCause
}

func (e *RequestError) Error() string { return e.Message }

// Unwrap exposes the native cause.
func (e *RequestError) Unwrap() error {
	if e.Cause == nil {
		return nil
	}
	return e.Cause
}

// NativeCause is a failed native call's diagnostic context
// (shared.NativeError), usable as an error cause.
type NativeCause struct {
	shared.NativeError
}

func (c *NativeCause) Error() string {
	message, _ := c.Native["message"].(string)
	return c.Method + ": " + message
}

// MarshalJSON is the TS cause's JSON: {method, native}.
func (c *NativeCause) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{"method": c.Method, "native": c.Native})
}

// NewRequestError is an error answer a client handler returns (the SDK's
// `new RequestError(code, message, data)`); data nil is no data.
func NewRequestError(code int, message string, data any) *RequestError {
	failure := &RequestError{Code: code, Message: message, Data: data, HasData: data != nil}
	if data != nil {
		failure.DataRaw = jsonx.Marshal(data)
	}
	return failure
}

// InvalidParams is RequestError.invalidParams(undefined, message).
func InvalidParams(message string) *RequestError {
	return NewRequestError(-32602, "Invalid params: "+message, nil)
}

// InternalError is RequestError.internalError(undefined, message).
func InternalError(message string) *RequestError {
	return NewRequestError(-32603, "Internal error: "+message, nil)
}

// RequestHandler answers one agent→client request. It runs on the reader,
// in wire order; the reply function it returns runs on a goroutine of its
// own (a terminal wait may take minutes) and its answer is written back.
type RequestHandler func(id string, params json.RawMessage) (reply func() (any, error))

// NotificationHandler receives one notification on the reader, in wire
// order; afterOpen says it arrived after a session/new|resume|load answer.
type NotificationHandler func(params json.RawMessage, afterOpen bool)

// ClientApp is the client side of the connection: which agent→client
// requests and notifications it routes. Unrouted requests are answered
// "Method not found"; unrouted notifications are dropped unseen, as the SDK
// does.
type ClientApp struct {
	requests      map[string]RequestHandler
	notifications map[string]NotificationHandler
}

// NewClient is an app routing nothing (the SDK's `client({name})`).
func NewClient() *ClientApp {
	return &ClientApp{requests: map[string]RequestHandler{}, notifications: map[string]NotificationHandler{}}
}

// OnRequest routes a request method.
func (c *ClientApp) OnRequest(method string, handler RequestHandler) *ClientApp {
	c.requests[method] = handler
	return c
}

// OnNotification routes a notification method.
func (c *ClientApp) OnNotification(method string, handler NotificationHandler) *ClientApp {
	c.notifications[method] = handler
	return c
}

// Handle adapts a plain function to a RequestHandler.
func Handle(answer func(params json.RawMessage) (any, error)) RequestHandler {
	return func(_ string, params json.RawMessage) func() (any, error) {
		return func() (any, error) { return answer(params) }
	}
}

// ProcessOptions configures StartProcess.
type ProcessOptions struct {
	Dir string
	// The whole environment; nil inherits the host's.
	Env []string
	// Session MCP credentials must not appear in protocol error messages, data or causes.
	Redact func(string) string
	// Track notification arrival relative to the native session-open answer.
	Opening *Opening
}

type pendingRequest struct {
	method string
	done   func(json.RawMessage, error)
	timer  *time.Timer
}

// Process is a stdio ACP agent and the JSON-RPC connection over it (process.ts AcpProcess).
type Process struct {
	child   *executable.LineProcess
	app     *ClientApp
	redact  func(string) string
	opening *Opening

	mu        sync.Mutex
	nextID    int64
	pending   map[int64]*pendingRequest
	closed    bool
	ended     bool
	exitCode  *int
	exitHooks []func(code *int)

	writeMu    sync.Mutex
	writeQueue [][]byte
	writeWake  chan struct{}
	writeDone  chan struct{}
}

var anonymousRequests atomic.Int64

// StartProcess spawns command as an ACP agent (killTree, as TS) connected to app.
func StartProcess(command string, args []string, app *ClientApp, options ProcessOptions) (*Process, error) {
	child, err := executable.Spawn(command, args, executable.LineOptions{Dir: options.Dir, Env: options.Env, KillTree: true})
	if err != nil {
		return nil, err
	}
	if app == nil {
		app = NewClient()
	}
	redact := options.Redact
	if redact == nil {
		redact = func(text string) string { return text }
	}
	p := &Process{
		child:     child,
		app:       app,
		redact:    redact,
		opening:   options.Opening,
		pending:   map[int64]*pendingRequest{},
		writeWake: make(chan struct{}, 1),
		writeDone: make(chan struct{}),
	}
	if p.opening == nil {
		p.opening = NewOpening()
	}
	go p.writer()
	child.OnLine(p.handleLine)
	child.OnExit(p.handleExit)
	return p, nil
}

// writer drains the write queue, so no caller ever blocks on the stdin pipe.
func (p *Process) writer() {
	for {
		select {
		case <-p.writeWake:
		case <-p.writeDone:
			return
		}
		for {
			p.writeMu.Lock()
			if len(p.writeQueue) == 0 {
				p.writeMu.Unlock()
				break
			}
			next := p.writeQueue[0]
			p.writeQueue = p.writeQueue[1:]
			p.writeMu.Unlock()
			p.child.Write(string(next))
		}
	}
}

func (p *Process) send(message any) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(message); err != nil {
		return
	}
	p.writeMu.Lock()
	p.writeQueue = append(p.writeQueue, buffer.Bytes())
	p.writeMu.Unlock()
	select {
	case p.writeWake <- struct{}{}:
	default:
	}
}

type wireRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

type wireNotification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

type wireError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type wireResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *wireError      `json:"error,omitempty"`
}

// Call sends one request; done runs once with the result or the error, on
// the reader goroutine (an answer, or the process exit) or on the deadline's
// timer. timeout 0 is no deadline (prompts, whose lifetime cancel controls).
// When the process is already closed it returns the process-exited error and
// done never runs (withAcpDeadline's early check).
func (p *Process) Call(method string, params any, timeout time.Duration, done func(json.RawMessage, error)) error {
	p.mu.Lock()
	if p.closed {
		code := p.exitCode
		p.mu.Unlock()
		return ProcessExitedError(code)
	}
	id := p.nextID
	p.nextID++
	request := &pendingRequest{method: method, done: done}
	p.pending[id] = request
	if timeout > 0 {
		request.timer = time.AfterFunc(timeout, func() {
			p.mu.Lock()
			if p.pending[id] != request {
				p.mu.Unlock()
				return
			}
			delete(p.pending, id)
			p.mu.Unlock()
			// The SDK's cancellation: the agent may stop the work; the process lives on.
			p.send(wireNotification{JSONRPC: "2.0", Method: methodCancelRequest, Params: map[string]any{"requestId": id}})
			done(nil, RequestTimeoutError(method, timeout))
		})
	}
	p.mu.Unlock()
	p.opening.Outgoing(strconv.FormatInt(id, 10), method)
	if params == nil {
		params = map[string]any{}
	}
	p.send(wireRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params})
	return nil
}

// Request is withAcpDeadline around one request: it blocks for the answer.
// A passed deadline is the timeout Error; the process exiting meanwhile is
// the process-exited Error with its code; an error answer is a
// *RequestError. ctx bounds only the wait.
func (p *Process) Request(ctx context.Context, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	type answer struct {
		result json.RawMessage
		err    error
	}
	answers := make(chan answer, 1)
	if err := p.Call(method, params, timeout, func(result json.RawMessage, err error) {
		answers <- answer{result, err}
	}); err != nil {
		return nil, err
	}
	select {
	case got := <-answers:
		return got.result, got.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Notify sends a notification.
func (p *Process) Notify(method string, params any) error {
	p.mu.Lock()
	closed, code := p.closed, p.exitCode
	p.mu.Unlock()
	if closed {
		return ProcessExitedError(code)
	}
	p.send(wireNotification{JSONRPC: "2.0", Method: method, Params: params})
	return nil
}

type wireMessage struct {
	ID     json.RawMessage `json:"id"`
	Method *string         `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

func (p *Process) handleLine(line string) {
	var message wireMessage
	// An invalid NDJSON frame is skipped; the connection recovers.
	if err := json.Unmarshal([]byte(line), &message); err != nil {
		return
	}
	switch {
	case message.Method != nil && message.ID != nil:
		p.handleRequest(message)
	case message.Method != nil:
		p.handleNotification(*message.Method, message.Params)
	case message.ID != nil:
		p.handleResponse(message)
	}
}

func (p *Process) handleResponse(message wireMessage) {
	idText := string(bytes.TrimSpace(message.ID))
	p.opening.Response(idText, message.Result != nil && message.Error == nil)
	id, err := strconv.ParseInt(idText, 10, 64)
	if err != nil {
		return
	}
	p.mu.Lock()
	request := p.pending[id]
	if request == nil || p.closed {
		// Unknown, timed out, or the connection is closing: the exit settles what is pending.
		p.mu.Unlock()
		return
	}
	delete(p.pending, id)
	if request.timer != nil {
		request.timer.Stop()
	}
	p.mu.Unlock()
	if message.Error != nil {
		request.done(nil, p.requestError(request.method, message.Error))
		return
	}
	result := message.Result
	if result == nil {
		result = json.RawMessage("null")
	}
	request.done(result, nil)
}

// requestError redacts an error answer: message, data and the native cause
// (keys included). No unredacted text stays down the cause chain.
func (p *Process) requestError(method string, raw json.RawMessage) *RequestError {
	record := jsonx.ParseRecord(raw)
	if record == nil {
		record = jsonx.Record{"code": -32603.0, "message": "Internal error"}
	}
	code, _ := jsonx.Num(record, "code")
	message := jsonx.Str(record, "message")
	native := jsonx.Record{"code": record["code"], "message": record["message"]}
	data, hasData := record["data"]
	if hasData {
		native["data"] = data
	}
	cause := shared.NativeErrorCause(method, native, p.redact)
	failure := &RequestError{Code: int(code), Message: p.redact(message), Data: cause.Native["data"], HasData: hasData, Cause: &NativeCause{cause}}
	if hasData {
		rawData := jsonx.RawFields(raw)["data"]
		if redacted, _, err := jsonx.MapStrings(rawData, p.redact); err == nil {
			failure.DataRaw = redacted
		}
	}
	return failure
}

func (p *Process) handleNotification(method string, params json.RawMessage) {
	afterOpen := p.opening.Notification()
	handler := p.app.notifications[method]
	if handler == nil {
		return
	}
	if params == nil {
		params = json.RawMessage("null")
	}
	handler(params, afterOpen)
}

func (p *Process) handleRequest(message wireMessage) {
	method := *message.Method
	id := requestIDOf(message.ID)
	handler := p.app.requests[method]
	if handler == nil {
		p.respond(message.ID, nil, NewRequestError(-32601, `"Method not found": `+method, map[string]any{"method": method}))
		return
	}
	params := message.Params
	if params == nil {
		params = json.RawMessage("null")
	}
	reply := handler(id, params)
	go func() {
		result, err := reply()
		p.respond(message.ID, result, err)
	}()
}

func requestIDOf(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	trimmed := string(bytes.TrimSpace(raw))
	if trimmed == "null" {
		return "acp-client-" + strconv.FormatInt(anonymousRequests.Add(1), 10)
	}
	return trimmed
}

func (p *Process) respond(id json.RawMessage, result any, err error) {
	if err == nil {
		if result == nil {
			result = json.RawMessage("null")
		}
		p.send(wireResponse{JSONRPC: "2.0", ID: id, Result: result})
		return
	}
	p.send(wireResponse{JSONRPC: "2.0", ID: id, Error: errorAnswer(err)})
}

// errorAnswer is the SDK's errorToResult: a RequestError keeps its code,
// message and data; anything else is -32603 with the message as details.
func errorAnswer(err error) *wireError {
	if requestErr, ok := err.(*RequestError); ok {
		answer := &wireError{Code: requestErr.Code, Message: requestErr.Message}
		if requestErr.HasData {
			answer.Data = requestErr.Data
		}
		return answer
	}
	details := err.Error()
	if parsed, ok := jsonx.Parse([]byte(details)); ok {
		return &wireError{Code: -32603, Message: "Internal error", Data: parsed}
	}
	return &wireError{Code: -32603, Message: "Internal error", Data: map[string]any{"details": details}}
}

func (p *Process) handleExit(code *int) {
	p.mu.Lock()
	p.ended = true
	p.closed = true
	p.exitCode = code
	pending := p.pending
	p.pending = map[int64]*pendingRequest{}
	hooks := p.exitHooks
	p.exitHooks = nil
	p.mu.Unlock()
	close(p.writeDone)
	for _, request := range pending {
		if request.timer != nil {
			request.timer.Stop()
		}
	}
	for _, request := range pending {
		request.done(nil, ProcessExitedError(code))
	}
	for _, hook := range hooks {
		hook(code)
	}
}

// OnExit runs hook once with the exit code, on the reader goroutine after
// every pending request was rejected; at once (on a goroutine) when the
// process already exited.
func (p *Process) OnExit(hook func(code *int)) {
	p.mu.Lock()
	if p.ended {
		code := p.exitCode
		p.mu.Unlock()
		go hook(code)
		return
	}
	p.exitHooks = append(p.exitHooks, hook)
	p.mu.Unlock()
}

// Exited is closed once the exit was reported and its hooks ran.
func (p *Process) Exited() <-chan struct{} { return p.child.Exited() }

// Closed reports a process that exited or whose connection was closed by Kill.
func (p *Process) Closed() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.closed
}

// ExitCode is the exit code once exited (nil for a signal or while running).
func (p *Process) ExitCode() *int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exitCode
}

// Kill closes the connection and stops the agent with everything it
// started. Pending requests reject with the process-exited error once the
// exit is observed. Idempotent.
func (p *Process) Kill() {
	p.mu.Lock()
	if p.ended {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.mu.Unlock()
	p.child.Kill()
}

// Redact is the process's redactor.
func (p *Process) Redact(text string) string { return p.redact(text) }

// Resources is the agent's memory with everything it started; nil once it exited.
func (p *Process) Resources() *oar.SessionResources {
	resources := p.child.Resources()
	if resources == nil {
		return nil
	}
	return &oar.SessionResources{RSS: resources.RSS, Processes: resources.Processes}
}

// Diagnostics is the agent's native status and stderr tail.
func (p *Process) Diagnostics() executable.Diagnostics { return p.child.Diagnostics() }
