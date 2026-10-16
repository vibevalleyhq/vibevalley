package acp

import (
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"unicode/utf8"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/observe"
)

// The terminal host (terminal.ts): ACP v1's typed terminal reverse-RPC
// surface, the commands an agent asks the client to run.
//
// Go note: TS registers each command with the executable layer's
// owned-process backstop (trackOwnedProcess); Go's executable package keeps
// that registry unexported, so a host's KillOwned does not reach terminal
// commands (smith/GAPS.md). Dispose and release still kill them.

const (
	defaultOutputLimit = 4 * 1024 * 1024
	maxOutputLimit     = 16 * 1024 * 1024
)

// EnvVariable is one ACP `{name, value}` environment entry.
type EnvVariable struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// CreateTerminalRequest is terminal/create's params.
type CreateTerminalRequest struct {
	SessionID string `json:"sessionId"`
	Command   string `json:"command"`
	// nil when absent: Grok's full shell line compatibility mode applies only then.
	Args            *[]string     `json:"args,omitempty"`
	Env             []EnvVariable `json:"env,omitempty"`
	Cwd             *string       `json:"cwd,omitempty"`
	OutputByteLimit *float64      `json:"outputByteLimit,omitempty"`
}

// CreateTerminalResponse is terminal/create's answer.
type CreateTerminalResponse struct {
	TerminalID string `json:"terminalId"`
}

// TerminalRequest names one terminal (terminal/output, wait_for_exit, kill, release).
type TerminalRequest struct {
	SessionID  string `json:"sessionId"`
	TerminalID string `json:"terminalId"`
}

// ExitStatus is how a command ended: exitCode or signal, the other null.
type ExitStatus struct {
	ExitCode *int    `json:"exitCode"`
	Signal   *string `json:"signal"`
}

// TerminalOutputResponse is terminal/output's answer.
type TerminalOutputResponse struct {
	Output     string      `json:"output"`
	Truncated  bool        `json:"truncated"`
	ExitStatus *ExitStatus `json:"exitStatus,omitempty"`
}

// TerminalHostOptions configures a host.
type TerminalHostOptions struct {
	// Compatibility for agents that put a fully quoted shell line in `command`.
	ShellCommand bool
}

type terminalState struct {
	cmd         *exec.Cmd
	exited      chan struct{}
	sessionID   string
	terminalID  string
	outputLimit int
	exitStatus  *ExitStatus
	output      string
	truncated   bool
	pending     [2][]byte
}

// TerminalHost runs commands for the agent.
type TerminalHost struct {
	cwd         string
	environment []string
	options     TerminalHostOptions

	mu        sync.Mutex
	terminals map[string]*terminalState
}

// NewTerminalHost runs commands in cwd with environment (the whole
// environment, "NAME=value") unless a request names its own.
func NewTerminalHost(cwd string, environment []string, options TerminalHostOptions) *TerminalHost {
	return &TerminalHost{cwd: cwd, environment: environment, options: options, terminals: map[string]*terminalState{}}
}

func outputLimitOf(value *float64) (int, error) {
	if value == nil {
		return defaultOutputLimit, nil
	}
	if math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0 {
		return 0, InvalidParams("ACP terminal outputByteLimit must be finite and nonnegative")
	}
	return int(math.Min(math.Floor(*value), maxOutputLimit)), nil
}

// tailAtCharacterBoundary keeps the last limit bytes of value, starting at a character.
func tailAtCharacterBoundary(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	start := len(value) - limit
	for start < len(value) && value[start]&0xC0 == 0x80 {
		start++
	}
	return value[start:]
}

func (state *terminalState) append(text string) {
	if text == "" {
		return
	}
	combined := state.output + text
	if len(combined) > state.outputLimit {
		state.truncated = true
		state.output = tailAtCharacterBoundary(combined, state.outputLimit)
	} else {
		state.output = combined
	}
}

// decode is a UTF-8 string decoder: complete characters out, an incomplete
// trailing sequence held for the next chunk (Node's StringDecoder).
func decode(pending *[]byte, chunk []byte, end bool) string {
	data := append(*pending, chunk...)
	*pending = nil
	if !end {
		cut := len(data)
		for back := 1; back <= 3 && back <= len(data); back++ {
			b := data[len(data)-back]
			if b&0xC0 == 0x80 {
				continue
			}
			if b >= 0xC0 && !utf8.FullRune(data[len(data)-back:]) {
				cut = len(data) - back
			}
			break
		}
		*pending = append([]byte(nil), data[cut:]...)
		data = data[:cut]
	}
	return strings.ToValidUTF8(string(data), "�")
}

func (h *TerminalHost) lookup(params TerminalRequest) (*terminalState, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	terminal := h.terminals[params.TerminalID]
	if terminal == nil || terminal.sessionID != params.SessionID {
		return nil, InvalidParams("Unknown ACP terminal: " + params.TerminalID)
	}
	return terminal, nil
}

// Create starts a command in its own process group.
func (h *TerminalHost) Create(params CreateTerminalRequest) (CreateTerminalResponse, error) {
	if params.Command == "" {
		return CreateTerminalResponse{}, InvalidParams("ACP terminal request requires command")
	}
	if params.Cwd != nil && !filepath.IsAbs(*params.Cwd) {
		return CreateTerminalResponse{}, InvalidParams("ACP terminal cwd must be an absolute path")
	}
	limit, err := outputLimitOf(params.OutputByteLimit)
	if err != nil {
		return CreateTerminalResponse{}, err
	}
	var cmd *exec.Cmd
	switch {
	case h.options.ShellCommand && params.Args == nil && runtime.GOOS == "windows":
		cmd = exec.Command(os.Getenv("ComSpec"), "/d", "/s", "/c", `"`+params.Command+`"`)
	case h.options.ShellCommand && params.Args == nil:
		cmd = exec.Command("/bin/sh", "-c", params.Command)
	default:
		var args []string
		if params.Args != nil {
			args = *params.Args
		}
		cmd = exec.Command(params.Command, args...)
	}
	cmd.Dir = h.cwd
	if params.Cwd != nil {
		cmd.Dir = *params.Cwd
	}
	env := append([]string{}, h.environment...)
	if h.environment == nil {
		env = os.Environ()
	}
	for _, variable := range params.Env {
		env = append(env, variable.Name+"="+variable.Value)
	}
	cmd.Env = env
	// Its own process group (POSIX): kill and release reach the command and
	// everything it started, not only the shell that launched it.
	executable.ConfigureGroup(cmd)
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		return CreateTerminalResponse{}, InternalError(err.Error())
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		return CreateTerminalResponse{}, InternalError(err.Error())
	}
	cmd.Stdout, cmd.Stderr = stdoutW, stderrW
	if err := cmd.Start(); err != nil {
		for _, file := range []*os.File{stdoutR, stdoutW, stderrR, stderrW} {
			_ = file.Close()
		}
		return CreateTerminalResponse{}, InternalError(err.Error())
	}
	_ = stdoutW.Close()
	_ = stderrW.Close()
	state := &terminalState{cmd: cmd, exited: make(chan struct{}), sessionID: params.SessionID, terminalID: observe.NewUUID(), outputLimit: limit}
	h.mu.Lock()
	h.terminals[state.terminalID] = state
	h.mu.Unlock()
	var readers sync.WaitGroup
	for stream, reader := range []*os.File{stdoutR, stderrR} {
		readers.Add(1)
		go func() {
			defer readers.Done()
			defer func() { _ = reader.Close() }()
			buffer := make([]byte, 32*1024)
			for {
				n, err := reader.Read(buffer)
				if n > 0 {
					h.mu.Lock()
					state.append(decode(&state.pending[stream], buffer[:n], false))
					h.mu.Unlock()
				}
				if err != nil {
					return
				}
			}
		}()
	}
	go func() {
		processState, _ := cmd.Process.Wait()
		// Node's `close`: the process ended and its output pipes closed.
		readers.Wait()
		status := &ExitStatus{}
		if processState != nil {
			if code, ok := executable.ExitStatus(processState); ok {
				status.ExitCode = &code
			} else if name := executable.SignalName(processState); name != "" {
				status.Signal = &name
			}
		}
		h.mu.Lock()
		state.append(decode(&state.pending[0], nil, true))
		state.append(decode(&state.pending[1], nil, true))
		state.exitStatus = status
		h.mu.Unlock()
		close(state.exited)
	}()
	return CreateTerminalResponse{TerminalID: state.terminalID}, nil
}

// Output is the output so far, and the exit status once the command ended.
func (h *TerminalHost) Output(params TerminalRequest) (TerminalOutputResponse, error) {
	state, err := h.lookup(params)
	if err != nil {
		return TerminalOutputResponse{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return TerminalOutputResponse{Output: state.output, Truncated: state.truncated, ExitStatus: state.exitStatus}, nil
}

// WaitForExit blocks until the command ended.
func (h *TerminalHost) WaitForExit(params TerminalRequest) (ExitStatus, error) {
	state, err := h.lookup(params)
	if err != nil {
		return ExitStatus{}, err
	}
	<-state.exited
	h.mu.Lock()
	defer h.mu.Unlock()
	return *state.exitStatus, nil
}

// Kill asks the command's group to stop (SIGTERM).
func (h *TerminalHost) Kill(params TerminalRequest) (map[string]any, error) {
	state, err := h.lookup(params)
	if err != nil {
		return nil, err
	}
	select {
	case <-state.exited:
	default:
		executable.SignalGroup(state.cmd.Process, false)
	}
	return map[string]any{}, nil
}

// Release forgets the terminal and kills what is left of it.
func (h *TerminalHost) Release(params TerminalRequest) (map[string]any, error) {
	state, err := h.lookup(params)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	delete(h.terminals, state.terminalID)
	h.mu.Unlock()
	stopTerminal(state)
	return map[string]any{}, nil
}

// stopTerminal kills the group: until both pipes close, something may still
// hold them (the command, or a process it started); killing the group
// reaches them all, so the wait ends.
func stopTerminal(state *terminalState) {
	select {
	case <-state.exited:
		return
	default:
	}
	executable.SignalGroup(state.cmd.Process, true)
	<-state.exited
}

// Dispose kills every unreleased command and waits for each to end.
func (h *TerminalHost) Dispose() {
	h.mu.Lock()
	active := make([]*terminalState, 0, len(h.terminals))
	for _, state := range h.terminals {
		active = append(active, state)
	}
	h.terminals = map[string]*terminalState{}
	h.mu.Unlock()
	var stopping sync.WaitGroup
	for _, state := range active {
		stopping.Add(1)
		go func() {
			defer stopping.Done()
			stopTerminal(state)
		}()
	}
	stopping.Wait()
}
