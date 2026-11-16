// Package replaytest provides an offline fixture replay harness and argv/permission
// verification helpers for pkg/oar runtime drivers without network or real CLI binaries.
package replaytest

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/pkg/oar"
)

// FileSnapshot captures on-disk permissions and content of a file flag at spawn time.
type FileSnapshot struct {
	Flag    string
	Path    string
	DirPath string
	Exists  bool
	Mode    fs.FileMode
	DirMode fs.FileMode
	Content []byte
	Err     error
}

// LaunchRecord captures one driver invocation of Launcher.Launch along with snapshots of secret/prompt files.
type LaunchRecord struct {
	Spec      oar.LaunchSpec
	EnvMap    map[string]string
	FlagFiles map[string]FileSnapshot
}

// StdinHandler reacts to one JSON line written to the fake CLI's stdin.
type StdinHandler func(proc *ScriptedProcess, line []byte)

// Launcher implements oar.Launcher completely offline for deterministic replay testing.
type Launcher struct {
	Handler      StdinHandler
	PreloadLines []string
	LaunchErr    error

	mu        sync.Mutex
	launches  []LaunchRecord
	processes []*ScriptedProcess
}

// NewLauncher creates a replay Launcher driven by the supplied StdinHandler.
func NewLauncher(handler StdinHandler) *Launcher {
	return &Launcher{Handler: handler}
}

// Launch records spec and on-disk secret file snapshots, then starts a ScriptedProcess.
func (l *Launcher) Launch(ctx context.Context, spec oar.LaunchSpec) (oar.Process, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	rec := LaunchRecord{
		Spec: oar.LaunchSpec{
			Command: spec.Command,
			Args:    slices.Clone(spec.Args),
			Dir:     spec.Dir,
			Env:     slices.Clone(spec.Env),
		},
		EnvMap:    parseEnvMap(spec.Env),
		FlagFiles: snapshotFlagFiles(spec.Args),
	}

	l.mu.Lock()
	l.launches = append(l.launches, rec)
	launchErr := l.LaunchErr
	preload := slices.Clone(l.PreloadLines)
	handler := l.Handler
	l.mu.Unlock()

	if launchErr != nil {
		return nil, launchErr
	}

	proc := newScriptedProcess(handler, preload)
	l.mu.Lock()
	l.processes = append(l.processes, proc)
	l.mu.Unlock()
	return proc, nil
}

// Launches returns copies of all recorded launch specs.
func (l *Launcher) Launches() []LaunchRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]LaunchRecord, len(l.launches))
	copy(out, l.launches)
	return out
}

// LastLaunch returns the most recent recorded launch, if any.
func (l *Launcher) LastLaunch() (LaunchRecord, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.launches) == 0 {
		return LaunchRecord{}, false
	}
	return l.launches[len(l.launches)-1], true
}

// LaunchCount returns how many times Launch was invoked.
func (l *Launcher) LaunchCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.launches)
}

// Processes returns all ScriptedProcess handles created by this Launcher.
func (l *Launcher) Processes() []*ScriptedProcess {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.processes)
}

func parseEnvMap(env []string) map[string]string {
	out := make(map[string]string, len(env))
	for _, entry := range env {
		k, v, ok := strings.Cut(entry, "=")
		if ok {
			out[k] = v
		}
	}
	return out
}

func snapshotFlagFiles(args []string) map[string]FileSnapshot {
	watched := map[string]bool{
		"--system-prompt-file":        true,
		"--append-system-prompt-file": true,
		"--mcp-config":                true,
	}
	snaps := make(map[string]FileSnapshot)
	for i := 0; i < len(args)-1; i++ {
		flag := args[i]
		if !watched[flag] {
			continue
		}
		path := args[i+1]
		snap := FileSnapshot{
			Flag:    flag,
			Path:    path,
			DirPath: filepath.Dir(path),
		}
		if dinfo, err := os.Stat(snap.DirPath); err == nil {
			snap.DirMode = dinfo.Mode().Perm()
		} else {
			snap.Err = err
		}
		if finfo, err := os.Stat(path); err == nil {
			snap.Exists = true
			snap.Mode = finfo.Mode().Perm()
			data, rerr := os.ReadFile(path)
			if rerr != nil {
				snap.Err = rerr
			} else {
				snap.Content = data
			}
		} else if snap.Err == nil {
			snap.Err = err
		}
		snaps[flag] = snap
	}
	return snaps
}

// ScriptedProcess simulates a bidirectional stdio agent subprocess completely in memory.
type ScriptedProcess struct {
	stdinPipe  *memPipe
	stdoutPipe *memPipe
	stderrPipe *memPipe
	handler    StdinHandler

	mu          sync.Mutex
	stdinLines  [][]byte
	interrupted int
	exitStat    oar.ExitStatus
	doneCh      chan struct{}
	closeOnce   sync.Once
}

func newScriptedProcess(handler StdinHandler, preload []string) *ScriptedProcess {
	p := &ScriptedProcess{
		stdinPipe:  newMemPipe(),
		stdoutPipe: newMemPipe(),
		stderrPipe: newMemPipe(),
		handler:    handler,
		doneCh:     make(chan struct{}),
	}
	for _, line := range preload {
		p.EmitRawLine(line)
	}
	go p.consumeStdin()
	return p
}

func (p *ScriptedProcess) Stdin() io.WriteCloser { return p.stdinPipe }
func (p *ScriptedProcess) Stdout() io.ReadCloser { return p.stdoutPipe }
func (p *ScriptedProcess) Stderr() io.ReadCloser { return p.stderrPipe }

func (p *ScriptedProcess) Wait() (oar.ExitStatus, error) {
	<-p.doneCh
	p.mu.Lock()
	st := p.exitStat
	p.mu.Unlock()
	return st, nil
}

func (p *ScriptedProcess) Interrupt() error {
	p.mu.Lock()
	p.interrupted++
	p.mu.Unlock()
	return nil
}

// InterruptCount returns how many OS Interrupt signals were delivered to this process.
func (p *ScriptedProcess) InterruptCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.interrupted
}

// Close closes stdin/stdout/stderr and marks the process exited.
func (p *ScriptedProcess) Close() error {
	p.Exit(0)
	return nil
}

// Exit terminates the scripted process with the given exit code and closes stdout/stderr.
func (p *ScriptedProcess) Exit(code int) {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.exitStat = oar.ExitStatus{Code: code}
		p.mu.Unlock()
		_ = p.stdinPipe.Close()
		_ = p.stdoutPipe.Close()
		_ = p.stderrPipe.Close()
		close(p.doneCh)
	})
}

// EmitJSON marshals v as one NDJSON line onto the fake CLI's stdout.
func (p *ScriptedProcess) EmitJSON(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	p.EmitRawBytes(data)
}

// EmitRawLine writes a raw string line onto the fake CLI's stdout.
func (p *ScriptedProcess) EmitRawLine(line string) {
	p.EmitRawBytes([]byte(line))
}

// EmitRawBytes writes raw bytes followed by newline onto the fake CLI's stdout.
func (p *ScriptedProcess) EmitRawBytes(line []byte) {
	buf := make([]byte, len(line)+1)
	copy(buf, line)
	buf[len(line)] = '\n'
	_, _ = p.stdoutPipe.Write(buf)
}

// StdinLines returns copies of all lines written to the fake CLI's stdin.
func (p *ScriptedProcess) StdinLines() [][]byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([][]byte, len(p.stdinLines))
	for i, line := range p.stdinLines {
		out[i] = slices.Clone(line)
	}
	return out
}

func (p *ScriptedProcess) consumeStdin() {
	br := bufio.NewReaderSize(p.stdinPipe, 64*1024)
	for {
		line, err := br.ReadBytes('\n')
		trimmed := bytes.TrimRight(line, "\r\n")
		if len(bytes.TrimSpace(trimmed)) > 0 {
			cp := slices.Clone(trimmed)
			p.mu.Lock()
			p.stdinLines = append(p.stdinLines, cp)
			p.mu.Unlock()
			if p.handler != nil {
				p.handler(p, cp)
			}
		}
		if err != nil {
			return
		}
	}
}

type memPipe struct {
	mu     sync.Mutex
	cond   *sync.Cond
	buf    bytes.Buffer
	closed bool
}

func newMemPipe() *memPipe {
	m := &memPipe{}
	m.cond = sync.NewCond(&m.mu)
	return m
}

func (m *memPipe) Write(p []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return 0, errors.New("replaytest: write on closed pipe")
	}
	n, err := m.buf.Write(p)
	m.cond.Broadcast()
	return n, err
}

func (m *memPipe) Read(p []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for m.buf.Len() == 0 && !m.closed {
		m.cond.Wait()
	}
	if m.buf.Len() == 0 && m.closed {
		return 0, io.EOF
	}
	return m.buf.Read(p)
}

func (m *memPipe) Close() error {
	m.mu.Lock()
	m.closed = true
	m.cond.Broadcast()
	m.mu.Unlock()
	return nil
}
