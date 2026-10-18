// Package bridge serves OAR runtimes over newline-delimited JSON-RPC 2.0 on
// stdio, so a host in another language (and the TS behavior suite,
// sea-trial/harness/go-bridge.ts) can drive Go sessions. Every record a
// session appends is pushed as a `session.record` notification, in seq
// order. Control replies follow the notifications through their response seq, so
// clients can apply the reply against their mirror without another progress barrier.
package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

type request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// Server holds the open sessions of one connection.
type Server struct {
	registry *oar.RuntimeRegistry
	writeMu  sync.Mutex
	out      *bufio.Writer
	writeErr error

	mu       sync.Mutex
	sessions map[string]*openSession
	next     int
}

type openSession struct {
	session oar.Session
	records *observe.RecordSubscription
	mu      sync.Mutex
	closed  bool
	err     error
}

func (s *openSession) close(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return s.err
	}
	s.closed = true
	s.err = errors.Join(s.session.Dispose(ctx), s.records.Close(ctx))
	return s.err
}

// Serve answers requests from in until it ends, then disposes every open session.
func Serve(ctx context.Context, registry *oar.RuntimeRegistry, in io.Reader, out io.Writer) error {
	requestCtx, stopRequests := context.WithCancel(ctx)
	defer stopRequests()
	server := &Server{registry: registry, out: bufio.NewWriter(out), sessions: map[string]*openSession{}}
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 1024*1024), 256*1024*1024)
	var wg sync.WaitGroup
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		if len(line) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := server.handle(requestCtx, req.Method, req.Params)
			server.reply(req.ID, result, err)
		}()
	}
	stopRequests()
	wg.Wait()
	server.mu.Lock()
	open := server.sessions
	server.sessions = map[string]*openSession{}
	server.mu.Unlock()
	disposeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := scanner.Err()
	for _, entry := range open {
		err = errors.Join(err, entry.close(disposeCtx))
	}
	return errors.Join(err, server.outputError())
}

func (s *Server) write(message any) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		encoded, _ = json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "bridge.error", "params": map[string]any{"message": err.Error()}})
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.writeErr != nil {
		return s.writeErr
	}
	if _, err := s.out.Write(encoded); err != nil {
		s.writeErr = err
		return err
	}
	if err := s.out.WriteByte('\n'); err != nil {
		s.writeErr = err
		return err
	}
	s.writeErr = s.out.Flush()
	return s.writeErr
}

func (s *Server) outputError() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.writeErr
}

func (s *Server) reply(id json.RawMessage, result any, err error) {
	if len(id) == 0 {
		return
	}
	if err != nil {
		s.write(map[string]any{"jsonrpc": "2.0", "id": id, "error": errorOf(err)})
		return
	}
	s.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

// errorOf carries the typed open errors across, so the client rebuilds the same classes.
func errorOf(err error) rpcError {
	data := map[string]any{"name": "Error"}
	var unsupported *oar.UnsupportedOptionError
	var notFound *oar.SessionNotFoundError
	var unavailable *oar.SessionUnavailableError
	var failure *oar.RuntimeFailureError
	switch {
	case errors.As(err, &unsupported):
		data = map[string]any{"name": "UnsupportedOptionError", "option": unsupported.Option}
	case errors.As(err, &notFound):
		data = map[string]any{"name": "SessionNotFoundError", "sessionId": notFound.SessionID, "method": notFound.Method, "native": rawOrEmpty(notFound.Native)}
	case errors.As(err, &unavailable):
		data = map[string]any{"name": "SessionUnavailableError", "sessionId": unavailable.SessionID, "reason": unavailable.Reason, "method": unavailable.Method, "native": rawOrEmpty(unavailable.Native)}
	case errors.As(err, &failure):
		data = map[string]any{"name": "RuntimeFailureError", "failure": failure.Failure}
		if failure.Credential != "" {
			data["credential"] = failure.Credential
		}
		if failure.Status != nil {
			data["status"] = *failure.Status
		}
	case errors.Is(err, oar.ErrControlUnsupported):
		data = map[string]any{"name": "ControlUnsupported"}
	}
	return rpcError{Code: -32000, Message: err.Error(), Data: data}
}

func rawOrEmpty(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("{}")
	}
	return raw
}

func decode[T any](params json.RawMessage) (T, error) {
	var value T
	if len(params) == 0 {
		return value, nil
	}
	err := json.Unmarshal(params, &value)
	return value, err
}

type runtimeParams struct {
	Runtime      string                    `json:"runtime"`
	Installation oar.AvailableInstallation `json:"installation"`
	Options      json.RawMessage           `json:"options"`
}

type inputParams struct {
	Session string `json:"session"`
	Input   string `json:"input"`
	Options struct {
		InputID string           `json:"inputId"`
		Images  []oar.InputImage `json:"images"`
		Origin  *oar.InputOrigin `json:"origin"`
	} `json:"options"`
	InputID string `json:"inputId"`
}

// openOptions is SessionOptions as the TS client sends it (env values may be null).
type openOptions struct {
	oar.SessionOptions
	LaunchArgs []string `json:"launchArgs"`
}

type timeoutOptions struct {
	Cwd       string `json:"cwd"`
	TimeoutMs int64  `json:"timeoutMs"`
	Line      string `json:"line"`
}

func (o timeoutOptions) timeout() time.Duration { return time.Duration(o.TimeoutMs) * time.Millisecond }

func (s *Server) runtime(id string) (oar.Runtime, error) {
	return s.registry.Require(id)
}

func (s *Server) session(handle string) (oar.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.sessions[handle]
	if !ok {
		return nil, fmt.Errorf("no open session %q", handle)
	}
	return entry.session, nil
}

func describe(runtime oar.Runtime) map[string]any {
	present := []string{"session"}
	add := func(name string, ok bool) {
		if ok {
			present = append(present, name)
		}
	}
	add("installation", runtime.Installation != nil)
	add("installPlan", runtime.InstallPlan != nil)
	add("install", runtime.Install != nil)
	add("accountUsage", runtime.AccountUsage != nil)
	add("listModels", runtime.ListModels != nil)
	add("checkUpdate", runtime.CheckUpdate != nil)
	add("upgrade", runtime.Upgrade != nil)
	add("login", runtime.Login != nil)
	add("logout", runtime.Logout != nil)
	add("authStatus", runtime.AuthStatus != nil)
	refused := map[string]string{}
	for option, reason := range runtime.RefusedSessionOptions {
		refused[string(option)] = reason
	}
	return map[string]any{
		"id":                    runtime.ID,
		"brand":                 runtime.Brand,
		"present":               present,
		"installLines":          runtime.InstallLines,
		"refusedSessionOptions": refused,
	}
}

func (s *Server) handle(ctx context.Context, method string, params json.RawMessage) (any, error) {
	switch method {
	case "bridge.syncEnv":
		// Test hosts set process environment between opens (pi's agent dir,
		// OAR_*_BIN pins); the bridge takes the host's whole environment over.
		var env map[string]string
		if err := json.Unmarshal(params, &env); err != nil {
			return nil, err
		}
		os.Clearenv()
		for name, value := range env {
			_ = os.Setenv(name, value)
		}
		return map[string]any{}, nil
	case "runtimes.list":
		var out []map[string]any
		for _, runtime := range s.registry.List() {
			out = append(out, describe(runtime))
		}
		return out, nil
	case "runtime.describe":
		p, err := decode[runtimeParams](params)
		if err != nil {
			return nil, err
		}
		runtime, err := s.runtime(p.Runtime)
		if err != nil {
			return nil, err
		}
		return describe(runtime), nil
	case "runtime.installation":
		p, err := decode[runtimeParams](params)
		if err != nil {
			return nil, err
		}
		runtime, err := s.runtime(p.Runtime)
		if err != nil {
			return nil, err
		}
		if runtime.Installation == nil {
			return nil, oar.ErrControlUnsupported
		}
		return runtime.Installation(ctx, oar.InstallationOptions{})
	case "runtime.listModels", "runtime.accountUsage", "runtime.checkUpdate", "runtime.authStatus", "runtime.skills", "runtime.commands", "runtime.mcpServers", "runtime.tools", "runtime.installPlan", "runtime.logout", "runtime.upgrade", "runtime.install":
		return s.utility(ctx, method, params)
	case "session.open":
		return s.open(ctx, params)
	case "session.prompt", "session.steer", "session.queue":
		p, err := decode[inputParams](params)
		if err != nil {
			return nil, err
		}
		session, err := s.session(p.Session)
		if err != nil {
			return nil, err
		}
		options := oar.InputOptions{InputID: p.Options.InputID, Images: p.Options.Images, Origin: p.Options.Origin}
		var outcome oar.ControlOutcome
		switch method {
		case "session.prompt":
			outcome, err = session.Prompt(ctx, p.Input, options)
		case "session.steer":
			outcome, err = session.Steer(ctx, p.Input, options)
		default:
			outcome, err = session.Queue(ctx, p.Input, options)
		}
		if err != nil {
			return nil, err
		}
		return s.controlResult(ctx, p.Session, outcome)
	case "session.withdraw":
		p, err := decode[inputParams](params)
		if err != nil {
			return nil, err
		}
		session, err := s.session(p.Session)
		if err != nil {
			return nil, err
		}
		outcome, err := session.Withdraw(ctx, p.InputID)
		if err != nil {
			return nil, err
		}
		return s.controlResult(ctx, p.Session, outcome)
	case "session.abort":
		p, err := decode[inputParams](params)
		if err != nil {
			return nil, err
		}
		session, err := s.session(p.Session)
		if err != nil {
			return nil, err
		}
		outcome, err := session.Abort(ctx)
		if err != nil {
			return nil, err
		}
		return s.controlResult(ctx, p.Session, outcome)
	case "session.resources":
		p, err := decode[inputParams](params)
		if err != nil {
			return nil, err
		}
		session, err := s.session(p.Session)
		if err != nil {
			return nil, err
		}
		return session.Resources(ctx)
	case "session.contextBreakdown":
		p, err := decode[inputParams](params)
		if err != nil {
			return nil, err
		}
		session, err := s.session(p.Session)
		if err != nil {
			return nil, err
		}
		return session.ContextBreakdown(ctx)
	case "session.dispose":
		p, err := decode[inputParams](params)
		if err != nil {
			return nil, err
		}
		session, err := s.session(p.Session)
		if err != nil {
			return nil, err
		}
		if err := session.Dispose(ctx); err != nil {
			return nil, err
		}
		records := session.Records()
		if len(records) > 0 {
			if err := s.confirm(ctx, p.Session, records[len(records)-1].Seq); err != nil {
				return nil, err
			}
		}
		return map[string]any{"records": len(records)}, nil
	case "session.close":
		p, err := decode[inputParams](params)
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		entry, ok := s.sessions[p.Session]
		delete(s.sessions, p.Session)
		s.mu.Unlock()
		if ok {
			if err := entry.close(ctx); err != nil {
				return nil, err
			}
		}
		return map[string]any{}, nil
	}
	return nil, fmt.Errorf("unknown method %q", method)
}

func (s *Server) confirm(ctx context.Context, handle string, seq int64) error {
	s.mu.Lock()
	entry := s.sessions[handle]
	s.mu.Unlock()
	if entry == nil {
		return fmt.Errorf("unknown session %q", handle)
	}
	if err := entry.records.Through(ctx, seq); err != nil {
		return err
	}
	return s.outputError()
}

func (s *Server) controlResult(ctx context.Context, handle string, outcome oar.ControlOutcome) (any, error) {
	if err := s.confirm(ctx, handle, outcome.Response.Seq); err != nil {
		return nil, err
	}
	return map[string]any{"request": outcome.Request, "response": outcome.Response}, nil
}

func (s *Server) open(ctx context.Context, params json.RawMessage) (any, error) {
	p, err := decode[runtimeParams](params)
	if err != nil {
		return nil, err
	}
	runtime, err := s.runtime(p.Runtime)
	if err != nil {
		return nil, err
	}
	options, err := decode[openOptions](p.Options)
	if err != nil {
		return nil, err
	}
	options.SessionOptions.LaunchArgs = options.LaunchArgs
	session, err := runtime.Session(ctx, p.Installation, options.SessionOptions)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.next++
	handle := fmt.Sprintf("s%d", s.next)
	s.mu.Unlock()
	records := observe.SubscribeRecords(session, func(record oar.RawEvent) {
		s.write(map[string]any{"jsonrpc": "2.0", "method": "session.record", "params": map[string]any{"session": handle, "record": record}})
	}, &oar.Cursor{SessionID: session.ID(), AfterSeq: -1})
	s.mu.Lock()
	s.sessions[handle] = &openSession{session: session, records: records}
	s.mu.Unlock()
	return map[string]any{
		"session":          handle,
		"id":               session.ID(),
		"capabilities":     session.Capabilities(),
		"steer":            session.CanSteer(),
		"withdraw":         session.CanWithdraw(),
		"resources":        session.CanReadResources(),
		"contextBreakdown": session.CanReadContextBreakdown(),
		"recordsAtOpen":    len(session.Records()),
	}, nil
}

func (s *Server) utility(ctx context.Context, method string, params json.RawMessage) (any, error) {
	p, err := decode[runtimeParams](params)
	if err != nil {
		return nil, err
	}
	runtime, err := s.runtime(p.Runtime)
	if err != nil {
		return nil, err
	}
	options, err := decode[timeoutOptions](p.Options)
	if err != nil {
		return nil, err
	}
	missing := func() (any, error) { return nil, oar.ErrControlUnsupported }
	switch method {
	case "runtime.listModels":
		if runtime.ListModels == nil {
			return missing()
		}
		return runtime.ListModels(ctx, p.Installation, oar.ListModelsOptions{Cwd: options.Cwd, Timeout: options.timeout()})
	case "runtime.accountUsage":
		if runtime.AccountUsage == nil {
			return missing()
		}
		return runtime.AccountUsage(ctx, p.Installation, oar.AccountUsageReadOptions{Timeout: options.timeout()})
	case "runtime.checkUpdate":
		if runtime.CheckUpdate == nil {
			return missing()
		}
		return runtime.CheckUpdate(ctx, p.Installation, oar.UpdateCheckOptions{Timeout: options.timeout()})
	case "runtime.authStatus":
		if runtime.AuthStatus == nil {
			return missing()
		}
		return runtime.AuthStatus(ctx, p.Installation, oar.AuthStatusOptions{Timeout: options.timeout()})
	case "runtime.logout":
		if runtime.Logout == nil {
			return missing()
		}
		return runtime.Logout(ctx, p.Installation, oar.LogoutOptions{Timeout: options.timeout()})
	case "runtime.upgrade":
		if runtime.Upgrade == nil {
			return missing()
		}
		return runtime.Upgrade(ctx, p.Installation, oar.UpgradeOptions{Timeout: options.timeout()})
	case "runtime.installPlan":
		if runtime.InstallPlan == nil {
			return missing()
		}
		return runtime.InstallPlan(ctx, oar.InstallOptions{Timeout: options.timeout(), Line: options.Line})
	case "runtime.install":
		if runtime.Install == nil {
			return missing()
		}
		return runtime.Install(ctx, oar.InstallOptions{Timeout: options.timeout(), Line: options.Line})
	case "runtime.skills":
		return runtime.Skills(ctx, p.Installation, oar.InventoryOptions{Cwd: options.Cwd, Timeout: options.timeout()})
	case "runtime.commands":
		return runtime.Commands(ctx, p.Installation, oar.InventoryOptions{Cwd: options.Cwd, Timeout: options.timeout()})
	case "runtime.mcpServers":
		return runtime.MCPServers(ctx, p.Installation, oar.InventoryOptions{Cwd: options.Cwd, Timeout: options.timeout()})
	case "runtime.tools":
		return runtime.Tools(ctx, p.Installation, oar.InventoryOptions{Cwd: options.Cwd, Timeout: options.timeout()})
	}
	return missing()
}
