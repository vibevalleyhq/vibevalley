package shared

import (
	"os"
	"os/exec"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/executable"
)

// The process half of shared/login.ts: spawnLoginProcess. A vendor login
// command runs over three pipes (no terminal), in its own process group on
// POSIX, both output streams read through ReadLoginStream.
//
// Go: the TS host-exit backstop (trackOwnedProcess) is not applied:
// internal/executable keeps its owned-process set unexported, so a login
// command is not reached by executable.KillOwned (GAPS.md).

// loginPipeDrain is how long, after the command exits, something it started
// may keep the output pipes before the exit is reported anyway.
const loginPipeDrain = 2 * time.Second

// LoginProcess is a running login command.
type LoginProcess struct {
	cmd    *exec.Cmd
	stdin  *os.File
	exited chan struct{}

	mu          sync.Mutex
	exit        LoginProcessExit
	running     bool
	stopped     bool
	inputClosed bool
}

// Exited is closed once the command has exited (or failed to start); Exit then says how.
func (p *LoginProcess) Exited() <-chan struct{} { return p.exited }

// Exit is how the command ended; meaningful once Exited is closed.
func (p *LoginProcess) Exit() LoginProcessExit {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exit
}

// Write writes to the command's stdin; a no-op once it has exited or its input was closed.
func (p *LoginProcess) Write(text string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.running || p.inputClosed || p.stdin == nil {
		return
	}
	// A write racing the exit fails with EPIPE; the exit reports the outcome.
	_, _ = p.stdin.WriteString(text)
}

// CloseInput ends the command's stdin: it reads nothing more.
func (p *LoginProcess) CloseInput() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closeInputLocked()
}

func (p *LoginProcess) closeInputLocked() {
	if !p.inputClosed && p.stdin != nil {
		p.inputClosed = true
		_ = p.stdin.Close()
	}
}

// Stop stops the command and everything it started: SIGTERM to its process
// group, SIGKILL to the group after the grace period (the tree on Windows).
// Idempotent.
func (p *LoginProcess) Stop() {
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return
	}
	p.stopped = true
	p.closeInputLocked()
	running := p.running
	p.mu.Unlock()
	if running && p.cmd.Process != nil {
		executable.SignalGroup(p.cmd.Process, false)
		// Kept after the command exits: what it started may outlive it in the group.
		process := p.cmd.Process
		time.AfterFunc(executable.KillGraceFromEnv(), func() { executable.SignalGroup(process, true) })
	}
}

// SpawnLoginProcess runs a login command over pipes (no terminal), in its
// own process group on POSIX, reading stdout and stderr alike. Nothing it
// prints is logged or forwarded except through handlers, which run on two
// goroutines (one per stream), so a handler that shares state locks it.
// env is the whole environment (nil: the host's). A command that cannot
// start ends at once with Exit().Error set, as Node reports a spawn error.
func SpawnLoginProcess(command string, args []string, env []string, handlers LoginOutputHandlers) *LoginProcess {
	p := &LoginProcess{exited: make(chan struct{})}
	cmd := exec.Command(command, args...)
	cmd.Env = env
	executable.ConfigureGroup(cmd)
	p.cmd = cmd
	fail := func(err error, files ...*os.File) *LoginProcess {
		for _, file := range files {
			_ = file.Close()
		}
		p.exit = LoginProcessExit{Error: (&executable.SpawnError{Command: command, Err: err}).Error()}
		close(p.exited)
		return p
	}
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return fail(err)
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		return fail(err, stdinR, stdinW)
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		return fail(err, stdinR, stdinW, stdoutR, stdoutW)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinR, stdoutW, stderrW
	if err := cmd.Start(); err != nil {
		return fail(err, stdinR, stdinW, stdoutR, stdoutW, stderrR, stderrW)
	}
	// Owned like every other child, so a host's KillOwned takes a login down too.
	executable.Track(cmd.Process)
	_ = stdinR.Close()
	_ = stdoutW.Close()
	_ = stderrW.Close()
	p.stdin = stdinW
	p.running = true
	var readers sync.WaitGroup
	readers.Add(2)
	read := func(file *os.File, stream LoginStream) {
		defer readers.Done()
		ReadLoginStream(file, stream, handlers)
	}
	go read(stdoutR, LoginStdout)
	go read(stderrR, LoginStderr)
	readersDone := make(chan struct{})
	go func() {
		readers.Wait()
		close(readersDone)
	}()
	go func() {
		_ = cmd.Wait()
		executable.Forget(cmd.Process)
		exit := LoginProcessExit{}
		if state := cmd.ProcessState; state != nil {
			if code, ok := executable.ExitStatus(state); ok {
				exit.ExitCode = &code
			} else {
				exit.Signal = executable.SignalName(state)
			}
		}
		p.mu.Lock()
		p.running = false
		p.mu.Unlock()
		// Every line is read before the exit is reported, unless something the
		// command started holds the output pipes open.
		select {
		case <-readersDone:
		case <-time.After(loginPipeDrain):
			_ = stdoutR.Close()
			_ = stderrR.Close()
		}
		p.mu.Lock()
		p.exit = exit
		p.closeInputLocked()
		p.mu.Unlock()
		close(p.exited)
	}()
	return p
}
