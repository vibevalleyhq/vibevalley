package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

var (
	// ErrTerminalPathDenied is returned when a requested terminal cwd escapes allowed repo worktrees.
	ErrTerminalPathDenied = errors.New("terminal: cwd outside allowed repository worktree roots")
	// ErrTerminalNotFound is returned when targeting an unknown terminal session ID.
	ErrTerminalNotFound = errors.New("terminal: session not found")
	// ErrTerminalExists is returned when spawning with an already active session ID.
	ErrTerminalExists = errors.New("terminal: session already exists")
)

// TerminalSpawnSpec configures a multi-repo worktree terminal session.
type TerminalSpawnSpec struct {
	ID           string   `json:"id"`
	RepoID       string   `json:"repoId,omitempty"`
	WorktreePath string   `json:"worktreePath,omitempty"`
	Cwd          string   `json:"cwd,omitempty"`
	Command      []string `json:"command,omitempty"`
	Env          []string `json:"env,omitempty"`
	Cols         int      `json:"cols,omitempty"`
	Rows         int      `json:"rows,omitempty"`
}

// TerminalInfo reports the runtime metadata of a managed terminal session.
type TerminalInfo struct {
	ID           string `json:"id"`
	RepoID       string `json:"repoId,omitempty"`
	WorktreePath string `json:"worktreePath"`
	Cwd          string `json:"cwd"`
	Command      string `json:"command"`
	PID          int    `json:"pid"`
	Cols         int    `json:"cols"`
	Rows         int    `json:"rows"`
	Running      bool   `json:"running"`
	Exited       bool   `json:"exited"`
	ExitCode     int    `json:"exitCode"`
}

// TerminalSession is the runtime handle to one active terminal/PTY process.
type TerminalSession interface {
	Write(data []byte) error
	Resize(cols, rows int) error
	Kill() error
	Inspect() TerminalInfo
	Done() <-chan struct{}
}

// TerminalSessionFactory spawns a concrete TerminalSession (e.g. Ghostty or Exec).
type TerminalSessionFactory interface {
	Spawn(ctx context.Context, spec TerminalSpawnSpec, onData func([]byte), onExit func(int)) (TerminalSession, error)
}

// TerminalController manages multi-repo worktree terminal sessions with path containment.
type TerminalController struct {
	mu           sync.RWMutex
	factory      TerminalSessionFactory
	repoRoots    map[string]string
	allowedRoots []string
	sessions     map[string]*managedTerminal
	listeners    map[uint64]terminalListener
	nextListener uint64
}

type terminalListener struct {
	onData func(id string, data []byte)
	onExit func(id string, code int)
}

type managedTerminal struct {
	spec    TerminalSpawnSpec
	session TerminalSession
}

// NewTerminalController creates a TerminalController enforcing allowedRoots containment.
// When factory is nil, ExecTerminalFactory is used by default so tests never trigger network downloads.
func NewTerminalController(factory TerminalSessionFactory, allowedRoots ...string) *TerminalController {
	if factory == nil {
		factory = ExecTerminalFactory{}
	}
	tc := &TerminalController{
		factory:   factory,
		repoRoots: make(map[string]string),
		sessions:  make(map[string]*managedTerminal),
		listeners: make(map[uint64]terminalListener),
	}
	for _, r := range allowedRoots {
		_ = tc.AddAllowedRoot(r)
	}
	return tc
}

// RegisterRepoRoot binds repoID to a repository/worktree root directory and allows spawning inside it.
func (tc *TerminalController) RegisterRepoRoot(repoID, rootPath string) error {
	if strings.TrimSpace(repoID) == "" {
		return errors.New("terminal: repoId must be non-empty")
	}
	norm, err := canonicalizePath(rootPath)
	if err != nil {
		return fmt.Errorf("terminal: invalid repo root %q: %w", rootPath, err)
	}
	tc.mu.Lock()
	tc.repoRoots[repoID] = norm
	tc.addRootLocked(norm)
	tc.mu.Unlock()
	return nil
}

// AddAllowedRoot registers an allowed workspace/worktree root directory.
func (tc *TerminalController) AddAllowedRoot(rootPath string) error {
	if strings.TrimSpace(rootPath) == "" {
		return errors.New("terminal: root path cannot be empty")
	}
	norm, err := canonicalizePath(rootPath)
	if err != nil {
		return err
	}
	tc.mu.Lock()
	tc.addRootLocked(norm)
	tc.mu.Unlock()
	return nil
}

func (tc *TerminalController) addRootLocked(norm string) {
	for _, existing := range tc.allowedRoots {
		if existing == norm {
			return
		}
	}
	tc.allowedRoots = append(tc.allowedRoots, norm)
}

// Subscribe registers callbacks for terminal stdout/stderr chunks and exit codes.
func (tc *TerminalController) Subscribe(onData func(id string, data []byte), onExit func(id string, code int)) func() {
	tc.mu.Lock()
	id := tc.nextListener + 1
	tc.nextListener = id
	tc.listeners[id] = terminalListener{onData: onData, onExit: onExit}
	tc.mu.Unlock()
	return func() {
		tc.mu.Lock()
		delete(tc.listeners, id)
		tc.mu.Unlock()
	}
}

// Spawn validates worktree path containment and starts a new terminal session.
func (tc *TerminalController) Spawn(ctx context.Context, spec TerminalSpawnSpec) (TerminalInfo, error) {
	if strings.TrimSpace(spec.ID) == "" {
		return TerminalInfo{}, errors.New("terminal: session id is required")
	}
	if spec.Cols <= 0 {
		spec.Cols = 80
	}
	if spec.Rows <= 0 {
		spec.Rows = 24
	}
	if spec.Cols < 2 || spec.Cols > 1000 || spec.Rows < 1 || spec.Rows > 1000 {
		return TerminalInfo{}, fmt.Errorf("terminal: invalid grid size %dx%d", spec.Cols, spec.Rows)
	}

	resolvedCwd, worktreePath, err := tc.resolveAndAuthorizeCwd(spec)
	if err != nil {
		return TerminalInfo{}, err
	}
	spec.Cwd = resolvedCwd
	spec.WorktreePath = worktreePath

	tc.mu.Lock()
	if _, exists := tc.sessions[spec.ID]; exists {
		tc.mu.Unlock()
		return TerminalInfo{}, fmt.Errorf("%w: %s", ErrTerminalExists, spec.ID)
	}
	tc.mu.Unlock()

	id := spec.ID
	sess, err := tc.factory.Spawn(
		ctx,
		spec,
		func(data []byte) { tc.emitData(id, data) },
		func(code int) { tc.emitExit(id, code) },
	)
	if err != nil {
		return TerminalInfo{}, err
	}

	tc.mu.Lock()
	if _, exists := tc.sessions[spec.ID]; exists {
		tc.mu.Unlock()
		_ = sess.Kill()
		return TerminalInfo{}, fmt.Errorf("%w: %s", ErrTerminalExists, spec.ID)
	}
	tc.sessions[spec.ID] = &managedTerminal{spec: spec, session: sess}
	tc.mu.Unlock()

	return sess.Inspect(), nil
}

func (tc *TerminalController) resolveAndAuthorizeCwd(spec TerminalSpawnSpec) (cwd string, worktree string, err error) {
	tc.mu.RLock()
	repoRoot := ""
	if spec.RepoID != "" {
		repoRoot = tc.repoRoots[spec.RepoID]
	}
	roots := append([]string(nil), tc.allowedRoots...)
	tc.mu.RUnlock()

	candidate := strings.TrimSpace(spec.Cwd)
	if candidate == "" {
		candidate = strings.TrimSpace(spec.WorktreePath)
	}
	if candidate == "" {
		candidate = repoRoot
	}
	if candidate == "" {
		return "", "", fmt.Errorf("%w: missing cwd and repo worktree", ErrTerminalPathDenied)
	}
	if strings.ContainsRune(candidate, 0) || !filepath.IsAbs(candidate) {
		return "", "", fmt.Errorf("%w: %q must be an absolute path", ErrTerminalPathDenied, candidate)
	}

	normCwd, err := canonicalizePath(candidate)
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrTerminalPathDenied, err)
	}

	if repoRoot != "" {
		if !isWithinRoot(normCwd, repoRoot) {
			return "", "", fmt.Errorf("%w: %q is outside repo %q root %q", ErrTerminalPathDenied, normCwd, spec.RepoID, repoRoot)
		}
		return normCwd, repoRoot, nil
	}

	if len(roots) == 0 {
		return "", "", fmt.Errorf("%w: no allowed worktree roots registered", ErrTerminalPathDenied)
	}
	for _, root := range roots {
		if isWithinRoot(normCwd, root) {
			wt := root
			if spec.WorktreePath != "" {
				if normWT, err := canonicalizePath(spec.WorktreePath); err == nil && isWithinRoot(normWT, root) {
					wt = normWT
				}
			}
			return normCwd, wt, nil
		}
	}
	return "", "", fmt.Errorf("%w: %q", ErrTerminalPathDenied, normCwd)
}

func (tc *TerminalController) emitData(id string, data []byte) {
	if len(data) == 0 {
		return
	}
	tc.mu.RLock()
	listeners := make([]terminalListener, 0, len(tc.listeners))
	for _, l := range tc.listeners {
		if l.onData != nil {
			listeners = append(listeners, l)
		}
	}
	tc.mu.RUnlock()

	cp := append([]byte(nil), data...)
	for _, l := range listeners {
		l.onData(id, cp)
	}
}

func (tc *TerminalController) emitExit(id string, code int) {
	tc.mu.RLock()
	listeners := make([]terminalListener, 0, len(tc.listeners))
	for _, l := range tc.listeners {
		if l.onExit != nil {
			listeners = append(listeners, l)
		}
	}
	tc.mu.RUnlock()

	for _, l := range listeners {
		l.onExit(id, code)
	}
}

func (tc *TerminalController) get(id string) (*managedTerminal, error) {
	tc.mu.RLock()
	mt, ok := tc.sessions[id]
	tc.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrTerminalNotFound, id)
	}
	return mt, nil
}

// Write delivers raw input bytes to session id.
func (tc *TerminalController) Write(id string, data []byte) error {
	mt, err := tc.get(id)
	if err != nil {
		return err
	}
	return mt.session.Write(data)
}

// Resize updates the terminal grid dimensions of session id.
func (tc *TerminalController) Resize(id string, cols, rows int) error {
	if cols < 2 || cols > 1000 || rows < 1 || rows > 1000 {
		return fmt.Errorf("terminal: invalid grid size %dx%d", cols, rows)
	}
	mt, err := tc.get(id)
	if err != nil {
		return err
	}
	return mt.session.Resize(cols, rows)
}

// Kill terminates session id and waits for its process handle to exit.
func (tc *TerminalController) Kill(id string) error {
	mt, err := tc.get(id)
	if err != nil {
		return err
	}
	err = mt.session.Kill()
	<-mt.session.Done()
	tc.mu.Lock()
	delete(tc.sessions, id)
	tc.mu.Unlock()
	return err
}

// Inspect returns the current metadata of session id.
func (tc *TerminalController) Inspect(id string) (TerminalInfo, error) {
	mt, err := tc.get(id)
	if err != nil {
		return TerminalInfo{}, err
	}
	return mt.session.Inspect(), nil
}

// List returns snapshots of all tracked terminal sessions sorted by ID.
func (tc *TerminalController) List() []TerminalInfo {
	tc.mu.RLock()
	out := make([]TerminalInfo, 0, len(tc.sessions))
	for _, mt := range tc.sessions {
		out = append(out, mt.session.Inspect())
	}
	tc.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ListByRepo returns snapshots of all terminal sessions associated with repoID.
func (tc *TerminalController) ListByRepo(repoID string) []TerminalInfo {
	all := tc.List()
	out := make([]TerminalInfo, 0, len(all))
	for _, info := range all {
		if info.RepoID == repoID {
			out = append(out, info)
		}
	}
	return out
}

// CloseAll kills all active terminal sessions and waits for their exit.
func (tc *TerminalController) CloseAll() error {
	tc.mu.Lock()
	targets := make([]*managedTerminal, 0, len(tc.sessions))
	for id, mt := range tc.sessions {
		targets = append(targets, mt)
		delete(tc.sessions, id)
	}
	tc.mu.Unlock()

	var firstErr error
	for _, mt := range targets {
		if err := mt.session.Kill(); err != nil && firstErr == nil {
			firstErr = err
		}
		<-mt.session.Done()
	}
	return firstErr
}

// ExecTerminalFactory runs interactive subprocesses via stdlib os/exec pipes without
// requiring external native libraries or network downloads.
type ExecTerminalFactory struct{}

func (ExecTerminalFactory) Spawn(_ context.Context, spec TerminalSpawnSpec, onData func([]byte), onExit func(int)) (TerminalSession, error) {
	argv := spec.Command
	if len(argv) == 0 {
		argv = defaultShellCommand()
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = spec.Cwd
	cmd.Env = append(os.Environ(), spec.Env...)
	cmd.Env = append(cmd.Env,
		"TERM=xterm-256color",
		fmt.Sprintf("COLUMNS=%d", spec.Cols),
		fmt.Sprintf("LINES=%d", spec.Rows),
	)
	configureTerminalCmd(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	s := &execTerminalSession{
		spec:    spec,
		cmd:     cmd,
		stdin:   stdin,
		command: strings.Join(argv, " "),
		cols:    spec.Cols,
		rows:    spec.Rows,
		running: true,
		done:    make(chan struct{}),
	}

	var ioWG sync.WaitGroup
	ioWG.Add(2)
	pump := func(r io.Reader) {
		defer ioWG.Done()
		buf := make([]byte, 4096)
		for {
			n, rerr := r.Read(buf)
			if n > 0 && onData != nil {
				onData(buf[:n])
			}
			if rerr != nil {
				return
			}
		}
	}
	go pump(stdout)
	go pump(stderr)

	go func() {
		ioWG.Wait()
		waitErr := cmd.Wait()
		code := 0
		if waitErr != nil {
			var exitErr *exec.ExitError
			if errors.As(waitErr, &exitErr) {
				code = exitErr.ExitCode()
			} else {
				code = -1
			}
		}
		s.mu.Lock()
		s.running = false
		s.exited = true
		s.exitCode = code
		s.mu.Unlock()
		close(s.done)
		if onExit != nil {
			onExit(code)
		}
	}()

	return s, nil
}

type execTerminalSession struct {
	spec    TerminalSpawnSpec
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	command string
	done    chan struct{}

	mu       sync.Mutex
	cols     int
	rows     int
	running  bool
	exited   bool
	exitCode int
}

func (s *execTerminalSession) Write(data []byte) error {
	s.mu.Lock()
	running := s.running
	s.mu.Unlock()
	if !running {
		return errors.New("terminal: process has exited")
	}
	_, err := s.stdin.Write(data)
	return err
}

func (s *execTerminalSession) Resize(cols, rows int) error {
	s.mu.Lock()
	s.cols = cols
	s.rows = rows
	s.mu.Unlock()
	return nil
}

func (s *execTerminalSession) Kill() error {
	_ = s.stdin.Close()
	return killTerminalCmd(s.cmd)
}

func (s *execTerminalSession) Done() <-chan struct{} {
	return s.done
}

func (s *execTerminalSession) Inspect() TerminalInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	pid := 0
	if s.cmd.Process != nil {
		pid = s.cmd.Process.Pid
	}
	return TerminalInfo{
		ID:           s.spec.ID,
		RepoID:       s.spec.RepoID,
		WorktreePath: s.spec.WorktreePath,
		Cwd:          s.spec.Cwd,
		Command:      s.command,
		PID:          pid,
		Cols:         s.cols,
		Rows:         s.rows,
		Running:      s.running,
		Exited:       s.exited,
		ExitCode:     s.exitCode,
	}
}

// GhosttyTerminalFactory integrates github.com/egoist/mygo/plugins/terminal (Ghostty VT)
// for GPU-accelerated native terminal views in live MyGo desktop windows.
type GhosttyTerminalFactory struct{}

func (GhosttyTerminalFactory) Spawn(_ context.Context, spec TerminalSpawnSpec, _ func([]byte), onExit func(int)) (TerminalSession, error) {
	if err := terminal.Load(); err != nil {
		return nil, fmt.Errorf("terminal: load libghostty-vt: %w", err)
	}
	done := make(chan struct{})
	var closeOnce sync.Once
	term, err := terminal.New(terminal.Options{
		Command: spec.Command,
		Dir:     spec.Cwd,
		Env:     spec.Env,
		OnExit: func(code int) {
			closeOnce.Do(func() { close(done) })
			if onExit != nil {
				onExit(code)
			}
		},
	})
	if err != nil {
		return nil, err
	}
	return &ghosttyTerminalSession{
		spec: spec,
		term: term,
		done: done,
	}, nil
}

type ghosttyTerminalSession struct {
	spec TerminalSpawnSpec
	term *terminal.Terminal
	done chan struct{}
}

func (g *ghosttyTerminalSession) Write(data []byte) error {
	g.term.Send(data)
	return nil
}

func (g *ghosttyTerminalSession) Resize(cols, rows int) error {
	g.term.Resize(cols, rows)
	return nil
}

func (g *ghosttyTerminalSession) Kill() error {
	g.term.Close()
	return nil
}

func (g *ghosttyTerminalSession) Done() <-chan struct{} {
	return g.done
}

func (g *ghosttyTerminalSession) Inspect() TerminalInfo {
	cols, rows := g.term.Size()
	exited := false
	select {
	case <-g.term.Done():
		exited = true
	default:
	}
	code := g.term.ExitCode()
	cwd := g.term.Dir()
	if cwd == "" {
		cwd = g.spec.Cwd
	}
	return TerminalInfo{
		ID:           g.spec.ID,
		RepoID:       g.spec.RepoID,
		WorktreePath: g.spec.WorktreePath,
		Cwd:          cwd,
		Command:      g.term.Title(),
		Cols:         cols,
		Rows:         rows,
		Running:      !exited,
		Exited:       exited,
		ExitCode:     code,
	}
}

// RenderTerminalView mounts a Ghostty-backed terminal session into a MyGo native UI tree.
func RenderTerminalView(c *ui.Context, sess TerminalSession) ui.Element {
	if g, ok := sess.(*ghosttyTerminalSession); ok && g.term != nil {
		return terminal.View(c, g.term).Fill()
	}
	return ui.Box(c)
}

func defaultShellCommand() []string {
	if runtime.GOOS == "windows" {
		if comspec := os.Getenv("COMSPEC"); comspec != "" {
			return []string{comspec}
		}
		return []string{"cmd.exe"}
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		return []string{sh}
	}
	if runtime.GOOS == "darwin" {
		return []string{"/bin/zsh"}
	}
	return []string{"/bin/sh"}
}

func canonicalizePath(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		return filepath.Clean(resolved), nil
	}
	if errors.Is(err, os.ErrNotExist) {
		parent := filepath.Dir(abs)
		if parentResolved, pErr := filepath.EvalSymlinks(parent); pErr == nil {
			return filepath.Clean(filepath.Join(parentResolved, filepath.Base(abs))), nil
		}
		return filepath.Clean(abs), nil
	}
	return "", err
}

func isWithinRoot(target, root string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
