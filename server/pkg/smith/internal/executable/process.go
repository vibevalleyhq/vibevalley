// Package executable is process plumbing shared by every runtime
// (packages/oar/src/shared/executable): long-lived line processes that own
// their process group, one-shot runs, PATH resolution, version probes and
// process-tree resources.
package executable

import (
	"bufio"
	"io"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// KillGrace is how long a process asked to stop (SIGTERM) gets before it is
// killed outright (SIGKILL). Generous on purpose: claude answers SIGTERM with
// a shutdown that runs its SessionEnd hooks.
const KillGrace = 10 * time.Second

// KillGraceFromEnv is OAR_KILL_GRACE_MS when it holds a nonnegative number of
// milliseconds, else KillGrace.
func KillGraceFromEnv() time.Duration {
	configured := strings.TrimSpace(os.Getenv("OAR_KILL_GRACE_MS"))
	if configured == "" {
		return KillGrace
	}
	value, err := strconv.ParseFloat(configured, 64)
	if err != nil || value < 0 || math.IsInf(value, 0) || math.IsNaN(value) {
		return KillGrace
	}
	return time.Duration(value * float64(time.Millisecond))
}

// exitDrain is how long, after the process exits, its stdout may stay open
// (a descendant holding the pipe) before the exit is reported anyway.
const exitDrain = 500 * time.Millisecond

// LineOptions configures a line process.
type LineOptions struct {
	Dir string
	// The whole environment ("NAME=value"); nil inherits the host's.
	Env []string
	// Forward the child's stderr to the host's; default OAR_CHILD_STDERR=inherit.
	InheritStderr *bool
	// Kill also ends descendants that left the process group (POSIX), or the
	// whole tree (Windows).
	KillTree bool
}

// Diagnostics is a bounded observation of native process failure.
type Diagnostics struct {
	ExitCode *int   `json:"exitCode"`
	Signal   string `json:"signal"`
	Stderr   string `json:"stderr"`
	Timeout  time.Duration
	Error    string `json:"error,omitempty"`
}

// LineProcess is a long-lived child whose stdout is read line by line.
//
// Ordering: line handlers run one line at a time on one goroutine, in
// stdout order; exit handlers run on that same goroutine after the last
// line was delivered (stdout reached EOF, or exitDrain passed after the
// exit), so an exit is never reported before output the process wrote
// before it ended.
type LineProcess struct {
	cmd     *exec.Cmd
	options LineOptions
	stdin   *os.File
	stdout  *os.File

	mu           sync.Mutex
	lineHandlers []func(string)
	exitHandlers []func(code *int)
	exitCode     *int
	exitSignal   string
	ended        bool
	exitedCh     chan struct{}
	processDone  chan struct{}
	stdinClosed  bool
	escalation   *time.Timer
	descendants  []ProcessEntry
	stderr       *StderrTail
	reading      bool
	readyLines   chan struct{}
}

// Spawn starts command with piped stdio in a process group of its own (POSIX).
func Spawn(command string, args []string, options LineOptions) (*LineProcess, error) {
	cmd := exec.Command(command, args...)
	cmd.Dir = options.Dir
	cmd.Env = options.Env
	ConfigureGroup(cmd)
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		closeAll(stdinR, stdinW)
		return nil, err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		closeAll(stdinR, stdinW, stdoutR, stdoutW)
		return nil, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinR, stdoutW, stderrW
	if err := cmd.Start(); err != nil {
		closeAll(stdinR, stdinW, stdoutR, stdoutW, stderrR, stderrW)
		return nil, spawnFailure(command, err)
	}
	closeAll(stdinR, stdoutW, stderrW)
	track(cmd.Process)
	p := &LineProcess{
		cmd:         cmd,
		options:     options,
		stdin:       stdinW,
		stdout:      stdoutR,
		exitedCh:    make(chan struct{}),
		processDone: make(chan struct{}),
		stderr:      &StderrTail{},
		readyLines:  make(chan struct{}),
	}
	inherit := os.Getenv("OAR_CHILD_STDERR") == "inherit"
	if options.InheritStderr != nil {
		inherit = *options.InheritStderr
	}
	// Always drain stderr, or a verbose child blocks before its next reply.
	go func() {
		buffer := make([]byte, 32*1024)
		for {
			n, err := stderrR.Read(buffer)
			if n > 0 {
				p.stderr.Append(buffer[:n])
				if inherit {
					_, _ = os.Stderr.Write(buffer[:n])
				}
			}
			if err != nil {
				_ = stderrR.Close()
				return
			}
		}
	}()
	go func() {
		state, _ := cmd.Process.Wait()
		forget(cmd.Process)
		p.mu.Lock()
		if state != nil {
			if status, ok := ExitStatus(state); ok {
				p.exitCode = &status
			} else {
				p.exitSignal = SignalName(state)
			}
		}
		descendants := p.descendants
		p.descendants = nil
		if p.escalation != nil {
			p.escalation.Stop()
		}
		p.mu.Unlock()
		if len(descendants) > 0 {
			// The child stopped before its SIGKILL: what it left running of
			// its tree now belongs to nobody, and goes before the exit.
			KillEntries(descendants, ReadProcessTable())
		}
		close(p.processDone)
	}()
	go p.dispatch()
	return p, nil
}

func closeAll(files ...*os.File) {
	for _, file := range files {
		_ = file.Close()
	}
}

// dispatch reads stdout lines once a handler asks for them, then reports the exit.
func (p *LineProcess) dispatch() {
	lines := make(chan string, 256)
	eof := make(chan struct{})
	go func() {
		<-p.readyLines
		reader := bufio.NewReaderSize(p.stdout, 64*1024)
		for {
			line, err := reader.ReadString('\n')
			if trimmed := strings.TrimSpace(line); trimmed != "" {
				lines <- trimmed
			}
			if err != nil {
				close(eof)
				return
			}
		}
	}()
	deliver := func(line string) {
		p.mu.Lock()
		handlers := append([]func(string){}, p.lineHandlers...)
		p.mu.Unlock()
		for _, handler := range handlers {
			handler(line)
		}
	}
	// Once eof is closed every line the reader read is in the channel.
	drainRemaining := func() {
		for {
			select {
			case line := <-lines:
				deliver(line)
			default:
				return
			}
		}
	}
	untilEOF := func() {
		for {
			select {
			case line := <-lines:
				deliver(line)
			case <-eof:
				drainRemaining()
				return
			}
		}
	}
	processDone := p.processDone
	var drainTimer <-chan time.Time
	for {
		select {
		case line := <-lines:
			deliver(line)
		case <-eof:
			drainRemaining()
			<-p.processDone
			p.finish()
			return
		case <-processDone:
			processDone = nil
			p.mu.Lock()
			if !p.reading {
				// Nobody reads the lines: the exit is all there is to report.
				p.reading = true
				close(p.readyLines)
				p.mu.Unlock()
				_ = p.stdout.Close()
				untilEOF()
				p.finish()
				return
			}
			p.mu.Unlock()
			drainTimer = time.After(exitDrain)
		case <-drainTimer:
			// A descendant holds stdout: report the exit without its EOF.
			_ = p.stdout.Close()
			untilEOF()
			p.finish()
			return
		}
	}
}

func (p *LineProcess) finish() {
	p.mu.Lock()
	if p.ended {
		p.mu.Unlock()
		return
	}
	p.ended = true
	code := p.exitCode
	handlers := append([]func(*int){}, p.exitHandlers...)
	p.exitHandlers = nil
	p.mu.Unlock()
	_ = p.stdout.Close()
	for _, handler := range handlers {
		handler(code)
	}
	close(p.exitedCh)
}

// Pid is the child's process id.
func (p *LineProcess) Pid() int { return p.cmd.Process.Pid }

// Write writes to stdin; a no-op once Kill closed it or the child is gone.
func (p *LineProcess) Write(text string) {
	p.mu.Lock()
	closed := p.stdinClosed
	p.mu.Unlock()
	if closed {
		return
	}
	_, _ = io.WriteString(p.stdin, text)
}

// OnLine adds a handler for complete, trimmed, non-empty stdout lines.
// Reading starts with the first handler.
func (p *LineProcess) OnLine(handler func(line string)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lineHandlers = append(p.lineHandlers, handler)
	if !p.reading {
		p.reading = true
		close(p.readyLines)
	}
}

// OnExit adds a handler that fires exactly once with the exit code (nil for
// a signal); immediately (on a new goroutine) when the process already ended.
func (p *LineProcess) OnExit(handler func(code *int)) {
	p.mu.Lock()
	if p.ended {
		code := p.exitCode
		p.mu.Unlock()
		go handler(code)
		return
	}
	p.exitHandlers = append(p.exitHandlers, handler)
	p.mu.Unlock()
}

// Exited is closed once the exit was reported (after the exit handlers ran).
func (p *LineProcess) Exited() <-chan struct{} { return p.exitedCh }

// ExitCode is the exit code once exited; nil for a signal or while running.
func (p *LineProcess) ExitCode() *int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exitCode
}

// HasEnded reports whether the exit was reported.
func (p *LineProcess) HasEnded() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.ended
}

// Diagnostics is the native status and the last 8 KiB of stderr.
func (p *LineProcess) Diagnostics() Diagnostics {
	p.mu.Lock()
	defer p.mu.Unlock()
	return Diagnostics{ExitCode: p.exitCode, Signal: p.exitSignal, Stderr: p.stderr.Text()}
}

// CloseStdin ends the child's stdin, the orderly shutdown request of a
// stdio protocol (pi's RPC mode). Idempotent; Write is a no-op afterwards.
func (p *LineProcess) CloseStdin() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.stdinClosed {
		p.stdinClosed = true
		_ = p.stdin.Close()
	}
}

// Kill stops the process and everything it started: close stdin, SIGTERM its
// process group, and SIGKILL the group if it still runs after the grace; with
// KillTree, its descendants outside the group too. Idempotent; a no-op after
// the exit.
func (p *LineProcess) Kill() {
	p.mu.Lock()
	select {
	case <-p.processDone:
		p.closeStdinLocked()
		p.mu.Unlock()
		return
	default:
	}
	if p.escalation != nil {
		p.closeStdinLocked()
		p.mu.Unlock()
		return
	}
	pid := p.cmd.Process.Pid
	tree := p.options.KillTree
	p.escalation = time.AfterFunc(KillGraceFromEnv(), func() {
		select {
		case <-p.processDone:
			return
		default:
		}
		if !tree {
			SignalGroup(p.cmd.Process, true)
			return
		}
		table := ReadProcessTable()
		now := DescendantsOf(table, pid)
		SignalGroup(p.cmd.Process, true)
		p.mu.Lock()
		recorded := p.descendants
		p.descendants = nil
		p.mu.Unlock()
		KillEntries(append(recorded, now...), table)
	})
	p.mu.Unlock()
	if tree {
		// Read while the child runs: once it is gone, what left its group is
		// re-parented and no longer found below it.
		descendants := DescendantsOf(ReadProcessTable(), pid)
		p.mu.Lock()
		p.descendants = descendants
		p.mu.Unlock()
	}
	SignalGroup(p.cmd.Process, false)
	// TS ends stdin first, but Node flushes that end on a later tick, after
	// the synchronous SIGTERM: a child that exits on EOF still sees the signal.
	p.mu.Lock()
	p.closeStdinLocked()
	p.mu.Unlock()
}

func (p *LineProcess) closeStdinLocked() {
	if !p.stdinClosed {
		p.stdinClosed = true
		_ = p.stdin.Close()
	}
}

// Resources is the child's memory with its group and descendants; nil once it has exited.
func (p *LineProcess) Resources() *Resources {
	select {
	case <-p.processDone:
		return nil
	default:
	}
	return ProcessTreeResources(p.cmd.Process.Pid)
}
