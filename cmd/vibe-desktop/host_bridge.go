package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"

	"github.com/egoist/mygo"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

const (
	desktopAppName       = "VibeValley"
	desktopVoiceShortcut = "Alt+Shift+Space"
	desktopCLICommand    = "vibevalley"

	farmBaseWidth    = 384
	farmBaseHeight   = 256
	farmMinWidth     = farmBaseWidth * 2
	farmMinHeight    = farmBaseHeight * 2
	freeMinWidth     = 720
	freeMinHeight    = 480
	defaultAppVer    = "0.1.0-dev"
	defaultChannel   = "dev"
	controlReadLimit = 1 << 20
)

var localeTagPattern = regexp.MustCompile(`^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$`)

// MyGo typed events pushed to the workbench WebView window.
var (
	DesktopPtyDataEvent       = mygo.NewEvent[HostPtyDataEvent]("desktop:ptyData")
	DesktopPtyExitEvent       = mygo.NewEvent[HostPtyExitEvent]("desktop:ptyExit")
	DesktopUpdateEvent        = mygo.NewEvent[HostUpdateState]("desktop:update")
	DesktopVoiceShortcutEvent = mygo.NewEvent[struct{}]("desktop:voiceShortcut")
)

// HostNotice matches packages/protocol/src/host.ts Notice.
type HostNotice struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

// HostTraySummary matches packages/protocol/src/host.ts TraySummary.
type HostTraySummary struct {
	Title string   `json:"title"`
	Lines []string `json:"lines"`
}

// HostOpening matches packages/protocol/src/host.ts Opening.
type HostOpening struct {
	Phase    string  `json:"phase"`
	Progress float64 `json:"progress"`
}

// HostUpdateState matches packages/protocol/src/host.ts UpdateState discriminated union.
type HostUpdateState struct {
	Tag     string   `json:"_tag"`
	Version string   `json:"version"`
	Next    string   `json:"next,omitempty"`
	Percent *float64 `json:"percent,omitempty"`
	Notes   []string `json:"notes,omitempty"`
	NewFarm *bool    `json:"newFarm,omitempty"`
	Page    string   `json:"page,omitempty"`
	Why     string   `json:"why,omitempty"`
}

// HostCommandLineState matches packages/protocol/src/host.ts CommandLineState.
type HostCommandLineState struct {
	Command   string `json:"command"`
	Link      string `json:"link"`
	Installed bool   `json:"installed"`
	OnPath    bool   `json:"onPath"`
	Taken     bool   `json:"taken"`
}

// HostPtySpawnInput matches packages/protocol/src/host.ts PtySpawn.
type HostPtySpawnInput struct {
	ID   string `json:"id"`
	Cwd  string `json:"cwd"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// HostPtySpawned matches packages/protocol/src/host.ts PtySpawned.
type HostPtySpawned struct {
	PID int `json:"pid"`
}

// HostPtyWriteInput matches packages/protocol/src/host.ts PtyWrite.
type HostPtyWriteInput struct {
	ID   string `json:"id"`
	Data string `json:"data"`
}

// HostPtyResizeInput matches packages/protocol/src/host.ts PtyResize.
type HostPtyResizeInput struct {
	ID   string `json:"id"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// HostPtyInfo matches packages/protocol/src/host.ts PtyInfo.
type HostPtyInfo struct {
	Cwd     string `json:"cwd"`
	Command string `json:"command"`
}

// HostPtyDataEvent matches packages/protocol/src/host.ts PtyData.
type HostPtyDataEvent struct {
	ID   string `json:"id"`
	Data string `json:"data"`
}

// HostPtyExitEvent matches packages/protocol/src/host.ts PtyExit.
type HostPtyExitEvent struct {
	ID   string `json:"id"`
	Code int    `json:"code"`
}

// HostStatus matches packages/protocol/src/host.ts DesktopStatus.
type HostStatus struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Channel string `json:"channel"`
	Server  string `json:"server,omitempty"`
}

// HostUpdateDriver abstracts update state checks and installation for testing and production feeds.
type HostUpdateDriver interface {
	State(ctx context.Context) HostUpdateState
	Check(ctx context.Context) (HostUpdateState, error)
	Install(ctx context.Context) error
}

// DesktopHostConfig configures DesktopHostService runtime behavior and optional test hooks.
type DesktopHostConfig struct {
	Version          string
	Channel          string
	ServerURL        string
	BasePageURL      string
	HomeDir          string
	RepoRoots        []string
	RevealRoots      []string
	HasEmbeddedStack bool

	CLICommand  string
	CLILauncher string
	CLIBinDir   string
	Getenv      func(string) string

	UpdateDriver HostUpdateDriver

	OnNotify        func(HostNotice)
	OnTray          func(HostTraySummary)
	OnLocale        func(string)
	OnReveal        func(string)
	OnTheme         func(string)
	OnFraming       func(string)
	OnOpening       func(HostOpening)
	OnOpen          func(string)
	OnQuit          func()
	OnRestart       func()
	OnUpdate        func(HostUpdateState)
	OnVoiceShortcut func()
	OnPtyData       func(HostPtyDataEvent)
	OnPtyExit       func(HostPtyExitEvent)
}

type desktopControlReq struct {
	ID    int64           `json:"id"`
	Call  string          `json:"call"`
	Input json.RawMessage `json:"input,omitempty"`
}

type desktopControlResp struct {
	ID     int64  `json:"id"`
	OK     bool   `json:"ok"`
	Output any    `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
}

// DesktopHostService implements window.vibevalleyHost native operations, terminal event forwarding,
// and desktopControl local socket commands.
type DesktopHostService struct {
	cfg    DesktopHostConfig
	island *IslandController
	terms  *TerminalController

	mu          sync.Mutex
	win         *mygo.Window
	tray        *mygo.Tray
	updateState HostUpdateState
	lastNotice  *HostNotice
	lastTray    *HostTraySummary
	lastLocale  string
	lastTheme   string
	lastFraming string
	lastOpening *HostOpening
	closed      bool

	unsubTerm func()
}

// DesktopHostRPC is the MyGo-bindable IPC facade bound as "DesktopHost".
type DesktopHostRPC struct {
	host *DesktopHostService
}

var (
	bindDesktopHostOnce sync.Once
	bindDesktopHostErr  error
)

// NewDesktopHostService constructs DesktopHostService and subscribes to TerminalController output/exit events.
func NewDesktopHostService(island *IslandController, terms *TerminalController, cfg DesktopHostConfig) *DesktopHostService {
	if strings.TrimSpace(cfg.Version) == "" {
		cfg.Version = defaultAppVer
	}
	if strings.TrimSpace(cfg.Channel) == "" {
		cfg.Channel = defaultChannel
	}
	if strings.TrimSpace(cfg.CLICommand) == "" {
		cfg.CLICommand = desktopCLICommand
	}
	if cfg.Getenv == nil {
		cfg.Getenv = os.Getenv
	}

	initialUpdate := HostUpdateState{Tag: "idle", Version: cfg.Version}
	if cfg.UpdateDriver != nil {
		initialUpdate = cfg.UpdateDriver.State(context.Background())
		if initialUpdate.Tag == "" {
			initialUpdate.Tag = "idle"
		}
		if initialUpdate.Version == "" {
			initialUpdate.Version = cfg.Version
		}
	}

	s := &DesktopHostService{
		cfg:         cfg,
		island:      island,
		terms:       terms,
		updateState: initialUpdate,
		lastTheme:   "system",
		lastFraming: "farm",
	}

	if terms != nil {
		s.unsubTerm = terms.Subscribe(s.handlePtyData, s.handlePtyExit)
	}
	return s
}

// Service returns the MyGo-bindable RPC facade for DesktopHostService.
func (s *DesktopHostService) Service() *DesktopHostRPC {
	return &DesktopHostRPC{host: s}
}

// RegisterDesktopHost binds s once per process under the MyGo service name "DesktopHost".
func RegisterDesktopHost(s *DesktopHostService) error {
	if s == nil {
		return errors.New("desktop host: nil service")
	}
	bindDesktopHostOnce.Do(func() {
		defer func() {
			if r := recover(); r != nil {
				bindDesktopHostErr = fmt.Errorf("desktop host: bind failed: %v", r)
			}
		}()
		mygo.BindAs("DesktopHost", s.Service())
	})
	return bindDesktopHostErr
}

// AttachWindow binds the main Workbench *mygo.Window for PTY/update/shortcut events and framing.
func (s *DesktopHostService) AttachWindow(w *mygo.Window) {
	s.mu.Lock()
	s.win = w
	s.mu.Unlock()
}

// AttachTray binds an OS menu bar *mygo.Tray whose title reflects Tray summaries when ready.
func (s *DesktopHostService) AttachTray(tray *mygo.Tray) {
	s.mu.Lock()
	s.tray = tray
	s.mu.Unlock()
}

// SyncStack updates embedded stack state and server URL after stack attachment.
func (s *DesktopHostService) SyncStack(hasEmbedded bool, serverURL string) {
	s.mu.Lock()
	s.cfg.HasEmbeddedStack = hasEmbedded
	if strings.TrimSpace(serverURL) != "" {
		s.cfg.ServerURL = strings.TrimSpace(serverURL)
	}
	s.mu.Unlock()
}

// Close detaches listeners and prevents subsequent event emissions.
func (s *DesktopHostService) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	unsub := s.unsubTerm
	s.unsubTerm = nil
	s.win = nil
	s.tray = nil
	s.mu.Unlock()

	if unsub != nil {
		unsub()
	}
}

// RegisterVoiceShortcut binds the desktop global shortcut (Alt+Shift+Space) and pushes desktop:voiceShortcut events.
func (s *DesktopHostService) RegisterVoiceShortcut() error {
	if !mygo.App.IsReady() {
		return nil
	}
	return mygo.GlobalShortcut.Register(desktopVoiceShortcut, func() {
		s.TriggerVoiceShortcut()
	})
}

// TriggerVoiceShortcut emits a voiceShortcut event to the attached window and configured callback.
func (s *DesktopHostService) TriggerVoiceShortcut() {
	s.mu.Lock()
	w := s.win
	closed := s.closed
	cb := s.cfg.OnVoiceShortcut
	s.mu.Unlock()

	if closed {
		return
	}
	if w != nil && !w.IsDestroyed() {
		_ = DesktopVoiceShortcutEvent.Emit(w, struct{}{})
	}
	if cb != nil {
		cb()
	}
}

func (s *DesktopHostService) handlePtyData(id string, data []byte) {
	ev := HostPtyDataEvent{
		ID:   id,
		Data: base64.StdEncoding.EncodeToString(data),
	}
	s.mu.Lock()
	w := s.win
	closed := s.closed
	cb := s.cfg.OnPtyData
	s.mu.Unlock()

	if closed {
		return
	}
	if w != nil && !w.IsDestroyed() {
		_ = DesktopPtyDataEvent.Emit(w, ev)
	}
	if cb != nil {
		cb(ev)
	}
}

func (s *DesktopHostService) handlePtyExit(id string, code int) {
	ev := HostPtyExitEvent{
		ID:   id,
		Code: code,
	}
	s.mu.Lock()
	w := s.win
	closed := s.closed
	cb := s.cfg.OnPtyExit
	s.mu.Unlock()

	if closed {
		return
	}
	if w != nil && !w.IsDestroyed() {
		_ = DesktopPtyExitEvent.Emit(w, ev)
	}
	if cb != nil {
		cb(ev)
	}
}

func (s *DesktopHostService) emitUpdate(st HostUpdateState) {
	s.mu.Lock()
	s.updateState = st
	w := s.win
	closed := s.closed
	cb := s.cfg.OnUpdate
	s.mu.Unlock()

	if closed {
		return
	}
	if w != nil && !w.IsDestroyed() {
		_ = DesktopUpdateEvent.Emit(w, st)
	}
	if cb != nil {
		cb(st)
	}
}

// Notify displays a desktop notification when App is ready and records it for inspection.
func (s *DesktopHostService) Notify(ctx context.Context, notice HostNotice) error {
	if strings.TrimSpace(notice.Title) == "" && strings.TrimSpace(notice.Body) == "" {
		return errors.New("notify: title or body is required")
	}

	s.mu.Lock()
	copied := notice
	s.lastNotice = &copied
	cb := s.cfg.OnNotify
	s.mu.Unlock()

	if mygo.App.IsReady() {
		n := mygo.NewNotification(mygo.NotificationOptions{
			Title: notice.Title,
			Body:  notice.Body,
		})
		_ = n.ShowContext(ctx)
	}
	if cb != nil {
		cb(notice)
	}
	return nil
}

// Tray updates the desktop tray state and projects summary lines onto IslandController when no embedded stack owns it.
func (s *DesktopHostService) Tray(_ context.Context, summary HostTraySummary) error {
	s.mu.Lock()
	cloned := HostTraySummary{
		Title: summary.Title,
		Lines: append([]string(nil), summary.Lines...),
	}
	s.lastTray = &cloned
	tray := s.tray
	cb := s.cfg.OnTray
	hasEmbedded := s.cfg.HasEmbeddedStack
	s.mu.Unlock()

	if tray != nil && mygo.App.IsReady() && runtime.GOOS == "darwin" {
		tray.SetTitle(summary.Title)
	}
	if s.island != nil && !hasEmbedded {
		issues := projectTrayIssues(summary)
		s.island.SetIssues(issues)
	}
	if cb != nil {
		cb(cloned)
	}
	return nil
}

func projectTrayIssues(summary HostTraySummary) []contract.IssueView {
	if len(summary.Lines) == 0 {
		return nil
	}
	issues := make([]contract.IssueView, 0, len(summary.Lines))
	for i, line := range summary.Lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		status := contract.IssueInProgress
		lower := strings.ToLower(trimmed)
		if strings.Contains(lower, "wait") || strings.Contains(lower, "review") || strings.Contains(lower, "need") {
			status = contract.IssueReview
		}
		issues = append(issues, contract.IssueView{
			ID:     fmt.Sprintf("tray-%d", i+1),
			Title:  trimmed,
			Status: status,
			RepoID: summary.Title,
		})
	}
	return issues
}

// Locale applies the desktop UI locale.
func (s *DesktopHostService) Locale(_ context.Context, locale string) error {
	tag := strings.TrimSpace(locale)
	if !localeTagPattern.MatchString(tag) {
		return fmt.Errorf("locale: invalid tag %q", locale)
	}

	s.mu.Lock()
	s.lastLocale = tag
	cb := s.cfg.OnLocale
	s.mu.Unlock()

	if mygo.App.IsReady() {
		mygo.App.SetLocale(tag)
	}
	if cb != nil {
		cb(tag)
	}
	return nil
}

// Reveal opens a path in Finder/file manager only when canonicalized inside allowed home or repository roots.
func (s *DesktopHostService) Reveal(_ context.Context, path string) error {
	if strings.TrimSpace(path) == "" || strings.ContainsRune(path, '\x00') {
		return errors.New("reveal denied: invalid path")
	}
	if !filepath.IsAbs(path) {
		return fmt.Errorf("reveal denied: path %q must be absolute", path)
	}

	canon, err := canonicalizePath(path)
	if err != nil {
		return fmt.Errorf("reveal denied: %w", err)
	}
	if !s.isRevealAllowed(canon) {
		return fmt.Errorf("reveal denied: %q is outside allowed home and repository roots", path)
	}

	if mygo.App.IsReady() {
		mygo.Shell.ShowItemInFolder(canon)
	}

	s.mu.Lock()
	cb := s.cfg.OnReveal
	s.mu.Unlock()
	if cb != nil {
		cb(canon)
	}
	return nil
}

func (s *DesktopHostService) allowedRevealRoots() []string {
	var raw []string
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		raw = append(raw, home)
	}
	if strings.TrimSpace(s.cfg.HomeDir) != "" {
		raw = append(raw, s.cfg.HomeDir)
	}
	raw = append(raw, s.cfg.RepoRoots...)
	raw = append(raw, s.cfg.RevealRoots...)
	if s.terms != nil {
		s.terms.mu.RLock()
		raw = append(raw, s.terms.allowedRoots...)
		for _, r := range s.terms.repoRoots {
			raw = append(raw, r)
		}
		s.terms.mu.RUnlock()
	}

	seen := map[string]struct{}{}
	roots := make([]string, 0, len(raw))
	for _, r := range raw {
		if strings.TrimSpace(r) == "" {
			continue
		}
		canon, err := canonicalizePath(r)
		if err != nil {
			continue
		}
		if _, ok := seen[canon]; ok {
			continue
		}
		seen[canon] = struct{}{}
		roots = append(roots, canon)
	}
	return roots
}

func (s *DesktopHostService) isRevealAllowed(canonTarget string) bool {
	for _, root := range s.allowedRevealRoots() {
		if isWithinRoot(canonTarget, root) {
			return true
		}
	}
	return false
}

// Theme applies light, dark, or system appearance to MyGo and the attached window background.
func (s *DesktopHostService) Theme(_ context.Context, theme string) error {
	var src mygo.ThemeSource
	var bgColor string
	switch theme {
	case "system":
		src = mygo.ThemeSystem
		bgColor = "light-dark(#fcfcfb, #151413)"
	case "light":
		src = mygo.ThemeLight
		bgColor = "#fcfcfb"
	case "dark":
		src = mygo.ThemeDark
		bgColor = "#151413"
	default:
		return fmt.Errorf("theme: unsupported choice %q (expected light, dark, or system)", theme)
	}

	s.mu.Lock()
	s.lastTheme = theme
	w := s.win
	cb := s.cfg.OnTheme
	s.mu.Unlock()

	if mygo.App.IsReady() {
		mygo.Theme.SetSource(src)
	}
	if w != nil && !w.IsDestroyed() {
		_ = w.SetBackgroundColor(bgColor)
	}
	if cb != nil {
		cb(theme)
	}
	return nil
}

// Framing switches between 3:2 integer-snapped "farm" framing and "free" workbench resizing.
func (s *DesktopHostService) Framing(_ context.Context, mode string) error {
	switch mode {
	case "farm", "free":
	default:
		return fmt.Errorf("framing: unsupported mode %q (expected farm or free)", mode)
	}

	s.mu.Lock()
	s.lastFraming = mode
	w := s.win
	cb := s.cfg.OnFraming
	s.mu.Unlock()

	if w != nil && !w.IsDestroyed() {
		if mode == "farm" {
			w.SetMinimumSize(farmMinWidth, farmMinHeight)
			bounds := w.ContentBounds()
			snapW, snapH := snapFarmSize(bounds.Width, bounds.Height)
			if bounds.Width != snapW || bounds.Height != snapH {
				w.SetContentSize(snapW, snapH)
			}
		} else {
			w.SetMinimumSize(freeMinWidth, freeMinHeight)
		}
	}
	if cb != nil {
		cb(mode)
	}
	return nil
}

func snapFarmSize(curW, curH int) (int, int) {
	scaleW := curW / farmBaseWidth
	scaleH := curH / farmBaseHeight
	scale := scaleW
	if scaleH < scale {
		scale = scaleH
	}
	if scale < 2 {
		scale = 2
	}
	return farmBaseWidth * scale, farmBaseHeight * scale
}

// Opening records startup loading phases and ensures the main window becomes visible when ready.
func (s *DesktopHostService) Opening(_ context.Context, opening HostOpening) error {
	switch opening.Phase {
	case "connecting", "reading", "loading", "ready", "waiting", "failed":
	default:
		return fmt.Errorf("opening: unsupported phase %q", opening.Phase)
	}
	if opening.Progress < 0 || opening.Progress > 100 {
		return fmt.Errorf("opening: progress %v out of range [0, 100]", opening.Progress)
	}

	s.mu.Lock()
	copied := opening
	s.lastOpening = &copied
	w := s.win
	cb := s.cfg.OnOpening
	s.mu.Unlock()

	if opening.Phase == "ready" && w != nil && !w.IsDestroyed() {
		w.Show()
	}
	if cb != nil {
		cb(copied)
	}
	return nil
}

// UpdateState returns the current application update state.
func (s *DesktopHostService) UpdateState(ctx context.Context) (HostUpdateState, error) {
	s.mu.Lock()
	driver := s.cfg.UpdateDriver
	current := s.updateState
	s.mu.Unlock()

	if driver != nil {
		st := driver.State(ctx)
		if st.Tag != "" {
			s.mu.Lock()
			s.updateState = st
			s.mu.Unlock()
			return st, nil
		}
	}
	return current, nil
}

// UpdateCheck checks for newer desktop releases and pushes desktop:update events.
func (s *DesktopHostService) UpdateCheck(ctx context.Context) error {
	s.mu.Lock()
	ver := s.cfg.Version
	driver := s.cfg.UpdateDriver
	s.mu.Unlock()

	s.emitUpdate(HostUpdateState{Tag: "checking", Version: ver})

	if driver == nil {
		s.emitUpdate(HostUpdateState{Tag: "idle", Version: ver})
		return nil
	}

	next, err := driver.Check(ctx)
	if err != nil {
		s.emitUpdate(HostUpdateState{Tag: "failed", Version: ver, Why: err.Error()})
		return err
	}
	if next.Tag == "" {
		next.Tag = "idle"
	}
	if next.Version == "" {
		next.Version = ver
	}
	s.emitUpdate(next)
	return nil
}

// UpdateInstall invokes the configured update installer when an update is ready.
func (s *DesktopHostService) UpdateInstall(ctx context.Context) error {
	s.mu.Lock()
	driver := s.cfg.UpdateDriver
	ver := s.cfg.Version
	cur := s.updateState
	s.mu.Unlock()

	if driver != nil {
		return driver.Install(ctx)
	}
	if cur.Tag != "ready" {
		return errors.New("update install: no downloaded update ready to install")
	}
	s.emitUpdate(HostUpdateState{
		Tag:     "manual",
		Version: ver,
		Next:    cur.Next,
		Why:     "noBuild",
		Page:    cur.Page,
	})
	return nil
}

func (s *DesktopHostService) resolveCLIPaths() (command, launcher, binDir string) {
	command = s.cfg.CLICommand
	if command == "" {
		command = desktopCLICommand
	}
	launcher = strings.TrimSpace(s.cfg.CLILauncher)
	if launcher == "" {
		if exe, err := os.Executable(); err == nil {
			candidate := filepath.Join(filepath.Dir(exe), "vibe")
			if runtime.GOOS == "windows" {
				candidate += ".exe"
			}
			if info, stErr := os.Stat(candidate); stErr == nil && !info.IsDir() {
				launcher = candidate
			}
		}
	}
	binDir = strings.TrimSpace(s.cfg.CLIBinDir)
	if binDir == "" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			binDir = filepath.Join(home, ".local", "bin")
		}
	}
	return command, launcher, binDir
}

func pathContainsDir(pathEnv, dir string) bool {
	if strings.TrimSpace(dir) == "" || strings.TrimSpace(pathEnv) == "" {
		return false
	}
	cleanDir := filepath.Clean(dir)
	for _, entry := range filepath.SplitList(pathEnv) {
		if strings.TrimSpace(entry) == "" {
			continue
		}
		if filepath.Clean(entry) == cleanDir {
			return true
		}
	}
	return false
}

// CliState inspects the symlink installation status of the vibevalley CLI command.
func (s *DesktopHostService) CliState(_ context.Context) (HostCommandLineState, error) {
	command, launcher, binDir := s.resolveCLIPaths()
	if binDir == "" {
		return HostCommandLineState{}, errors.New("cli state: cannot determine user bin directory")
	}
	link := filepath.Join(binDir, command)
	onPath := pathContainsDir(s.cfg.Getenv("PATH"), binDir)

	info, err := os.Lstat(link)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return HostCommandLineState{
				Command:   command,
				Link:      link,
				Installed: false,
				OnPath:    onPath,
				Taken:     false,
			}, nil
		}
		return HostCommandLineState{}, fmt.Errorf("cli state: lstat %s: %w", link, err)
	}

	installed := false
	if info.Mode()&os.ModeSymlink != 0 && launcher != "" {
		target, rErr := os.Readlink(link)
		if rErr == nil {
			if !filepath.IsAbs(target) {
				target = filepath.Join(filepath.Dir(link), target)
			}
			if filepath.Clean(target) == filepath.Clean(launcher) {
				installed = true
			}
		}
	}

	return HostCommandLineState{
		Command:   command,
		Link:      link,
		Installed: installed,
		OnPath:    onPath,
		Taken:     !installed,
	}, nil
}

// CliInstall creates the symlink at ~/.local/bin/vibevalley -> launcher unless already taken by another binary.
func (s *DesktopHostService) CliInstall(ctx context.Context) (HostCommandLineState, error) {
	st, err := s.CliState(ctx)
	if err != nil {
		return HostCommandLineState{}, err
	}
	if st.Taken {
		return st, fmt.Errorf("cli install: %s is already occupied by another binary", st.Link)
	}
	if st.Installed {
		return st, nil
	}
	_, launcher, binDir := s.resolveCLIPaths()
	if launcher == "" {
		return st, errors.New("cli install: no launcher binary configured for this build")
	}
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return st, fmt.Errorf("cli install: mkdir %s: %w", binDir, err)
	}
	if err := os.Symlink(launcher, st.Link); err != nil {
		return st, fmt.Errorf("cli install: symlink %s -> %s: %w", st.Link, launcher, err)
	}
	return s.CliState(ctx)
}

// CliRemove removes the installed CLI symlink if managed by this launcher.
func (s *DesktopHostService) CliRemove(ctx context.Context) (HostCommandLineState, error) {
	st, err := s.CliState(ctx)
	if err != nil {
		return HostCommandLineState{}, err
	}
	if st.Installed {
		if err := os.Remove(st.Link); err != nil && !errors.Is(err, os.ErrNotExist) {
			return st, fmt.Errorf("cli remove: %w", err)
		}
	}
	return s.CliState(ctx)
}

func (s *DesktopHostService) requireTerminals() (*TerminalController, error) {
	if s.terms == nil {
		return nil, errors.New("terminal: controller unavailable")
	}
	return s.terms, nil
}

// PtySpawn starts a managed terminal PTY session under a registered repository root.
func (s *DesktopHostService) PtySpawn(ctx context.Context, in HostPtySpawnInput) (HostPtySpawned, error) {
	terms, err := s.requireTerminals()
	if err != nil {
		return HostPtySpawned{}, err
	}
	info, err := terms.Spawn(ctx, TerminalSpawnSpec{
		ID:   in.ID,
		Cwd:  in.Cwd,
		Cols: in.Cols,
		Rows: in.Rows,
	})
	if err != nil {
		return HostPtySpawned{}, err
	}
	return HostPtySpawned{PID: info.PID}, nil
}

// PtyWrite decodes base64 input bytes and writes them to the PTY master fd.
func (s *DesktopHostService) PtyWrite(_ context.Context, in HostPtyWriteInput) error {
	terms, err := s.requireTerminals()
	if err != nil {
		return err
	}
	raw, err := base64.StdEncoding.DecodeString(in.Data)
	if err != nil {
		return fmt.Errorf("pty write: decode base64: %w", err)
	}
	return terms.Write(in.ID, raw)
}

// PtyResize adjusts PTY window columns and rows.
func (s *DesktopHostService) PtyResize(_ context.Context, in HostPtyResizeInput) error {
	terms, err := s.requireTerminals()
	if err != nil {
		return err
	}
	return terms.Resize(in.ID, in.Cols, in.Rows)
}

// PtyKill terminates a running PTY session.
func (s *DesktopHostService) PtyKill(_ context.Context, id string) error {
	terms, err := s.requireTerminals()
	if err != nil {
		return err
	}
	return terms.Kill(id)
}

// PtyInspect returns live cwd and foreground command metadata for a PTY session.
func (s *DesktopHostService) PtyInspect(_ context.Context, id string) (HostPtyInfo, error) {
	terms, err := s.requireTerminals()
	if err != nil {
		return HostPtyInfo{}, err
	}
	info, err := terms.Inspect(id)
	if err != nil {
		return HostPtyInfo{}, err
	}
	return HostPtyInfo{
		Cwd:     info.Cwd,
		Command: info.Command,
	}, nil
}

// Status reports desktop runtime status matching packages/protocol/src/host.ts desktopControl.status.
func (s *DesktopHostService) Status(_ context.Context) (HostStatus, error) {
	return HostStatus{
		Name:    desktopAppName,
		Version: s.cfg.Version,
		Channel: s.cfg.Channel,
		Server:  s.cfg.ServerURL,
	}, nil
}

// Open navigates the attached workbench window to a relative route (such as "/repos") and focuses it.
func (s *DesktopHostService) Open(_ context.Context, path string) error {
	cleaned := strings.TrimSpace(path)
	if cleaned == "" {
		cleaned = "/"
	}
	if !strings.HasPrefix(cleaned, "/") || strings.ContainsRune(cleaned, '\x00') {
		return fmt.Errorf("open: route %q must start with '/'", path)
	}

	s.mu.Lock()
	w := s.win
	base := strings.TrimRight(s.cfg.BasePageURL, "/")
	cb := s.cfg.OnOpen
	s.mu.Unlock()

	if w != nil && !w.IsDestroyed() {
		target := cleaned
		if base != "" {
			target = base + cleaned
		}
		if pg := w.Page(); pg != nil {
			if err := pg.LoadURL(target); err != nil {
				return err
			}
		}
		w.Show()
	}
	if cb != nil {
		cb(cleaned)
	}
	return nil
}

// Restart triggers desktop restart callback (or quits cleanly when no restart hook is attached).
func (s *DesktopHostService) Restart(ctx context.Context) error {
	s.mu.Lock()
	cb := s.cfg.OnRestart
	s.mu.Unlock()
	if cb != nil {
		cb()
		return nil
	}
	return s.Quit(ctx)
}

// Quit invokes shutdown hooks and terminates the MyGo application when running.
func (s *DesktopHostService) Quit(_ context.Context) error {
	s.mu.Lock()
	cb := s.cfg.OnQuit
	s.mu.Unlock()

	if cb != nil {
		cb()
	}
	if mygo.App.IsReady() {
		go mygo.App.Quit()
	}
	return nil
}

// ListenControlUnix opens an NDJSON desktopControl Unix domain socket at sockPath for `vibe app`.
func (s *DesktopHostService) ListenControlUnix(ctx context.Context, sockPath string) (io.Closer, <-chan struct{}, error) {
	if strings.TrimSpace(sockPath) == "" {
		return nil, nil, errors.New("desktop control: empty socket path")
	}
	if err := os.MkdirAll(filepath.Dir(sockPath), 0o700); err != nil {
		return nil, nil, err
	}
	_ = os.Remove(sockPath)

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return nil, nil, err
	}
	_ = os.Chmod(sockPath, 0o600)

	done := make(chan struct{})
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()
	go func() {
		defer close(done)
		defer func() { _ = os.Remove(sockPath) }()
		for {
			conn, aErr := ln.Accept()
			if aErr != nil {
				return
			}
			go s.serveControlConn(ctx, conn)
		}
	}()
	return ln, done, nil
}

func (s *DesktopHostService) serveControlConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	scanner := bufio.NewScanner(io.LimitReader(conn, controlReadLimit))
	scanner.Buffer(make([]byte, 0, 16*1024), controlReadLimit)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req desktopControlReq
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			b, _ := json.Marshal(desktopControlResp{OK: false, Error: err.Error()})
			_, _ = conn.Write(append(b, '\n'))
			continue
		}
		resp := s.dispatchControlCall(ctx, req)
		b, _ := json.Marshal(resp)
		_, _ = conn.Write(append(b, '\n'))
	}
}

func (s *DesktopHostService) dispatchControlCall(ctx context.Context, req desktopControlReq) desktopControlResp {
	switch req.Call {
	case "status":
		st, err := s.Status(ctx)
		if err != nil {
			return desktopControlResp{ID: req.ID, OK: false, Error: err.Error()}
		}
		return desktopControlResp{ID: req.ID, OK: true, Output: st}
	case "open":
		var route string
		if len(req.Input) > 0 && string(req.Input) != "null" {
			if err := json.Unmarshal(req.Input, &route); err != nil {
				return desktopControlResp{ID: req.ID, OK: false, Error: err.Error()}
			}
		}
		if err := s.Open(ctx, route); err != nil {
			return desktopControlResp{ID: req.ID, OK: false, Error: err.Error()}
		}
		return desktopControlResp{ID: req.ID, OK: true}
	case "quit":
		if err := s.Quit(ctx); err != nil {
			return desktopControlResp{ID: req.ID, OK: false, Error: err.Error()}
		}
		return desktopControlResp{ID: req.ID, OK: true}
	case "restart":
		if err := s.Restart(ctx); err != nil {
			return desktopControlResp{ID: req.ID, OK: false, Error: err.Error()}
		}
		return desktopControlResp{ID: req.ID, OK: true}
	case "updateState":
		st, err := s.UpdateState(ctx)
		if err != nil {
			return desktopControlResp{ID: req.ID, OK: false, Error: err.Error()}
		}
		return desktopControlResp{ID: req.ID, OK: true, Output: st}
	case "updateCheck":
		if err := s.UpdateCheck(ctx); err != nil {
			return desktopControlResp{ID: req.ID, OK: false, Error: err.Error()}
		}
		return desktopControlResp{ID: req.ID, OK: true}
	case "updateInstall":
		if err := s.UpdateInstall(ctx); err != nil {
			return desktopControlResp{ID: req.ID, OK: false, Error: err.Error()}
		}
		return desktopControlResp{ID: req.ID, OK: true}
	default:
		return desktopControlResp{ID: req.ID, OK: false, Error: "unknown control method: " + req.Call}
	}
}

// MyGo RPC facade forwarding cleanly to DesktopHostService without exposing lifecycle/helper methods.

func (r *DesktopHostRPC) Notify(ctx context.Context, notice HostNotice) error {
	return r.host.Notify(ctx, notice)
}

func (r *DesktopHostRPC) Tray(ctx context.Context, summary HostTraySummary) error {
	return r.host.Tray(ctx, summary)
}

func (r *DesktopHostRPC) Locale(ctx context.Context, locale string) error {
	return r.host.Locale(ctx, locale)
}

func (r *DesktopHostRPC) Reveal(ctx context.Context, path string) error {
	return r.host.Reveal(ctx, path)
}

func (r *DesktopHostRPC) Theme(ctx context.Context, theme string) error {
	return r.host.Theme(ctx, theme)
}

func (r *DesktopHostRPC) Framing(ctx context.Context, mode string) error {
	return r.host.Framing(ctx, mode)
}

func (r *DesktopHostRPC) Opening(ctx context.Context, opening HostOpening) error {
	return r.host.Opening(ctx, opening)
}

func (r *DesktopHostRPC) UpdateState(ctx context.Context) (HostUpdateState, error) {
	return r.host.UpdateState(ctx)
}

func (r *DesktopHostRPC) UpdateCheck(ctx context.Context) error {
	return r.host.UpdateCheck(ctx)
}

func (r *DesktopHostRPC) UpdateInstall(ctx context.Context) error {
	return r.host.UpdateInstall(ctx)
}

func (r *DesktopHostRPC) CliState(ctx context.Context) (HostCommandLineState, error) {
	return r.host.CliState(ctx)
}

func (r *DesktopHostRPC) CliInstall(ctx context.Context) (HostCommandLineState, error) {
	return r.host.CliInstall(ctx)
}

func (r *DesktopHostRPC) CliRemove(ctx context.Context) (HostCommandLineState, error) {
	return r.host.CliRemove(ctx)
}

func (r *DesktopHostRPC) PtySpawn(ctx context.Context, in HostPtySpawnInput) (HostPtySpawned, error) {
	return r.host.PtySpawn(ctx, in)
}

func (r *DesktopHostRPC) PtyWrite(ctx context.Context, in HostPtyWriteInput) error {
	return r.host.PtyWrite(ctx, in)
}

func (r *DesktopHostRPC) PtyResize(ctx context.Context, in HostPtyResizeInput) error {
	return r.host.PtyResize(ctx, in)
}

func (r *DesktopHostRPC) PtyKill(ctx context.Context, id string) error {
	return r.host.PtyKill(ctx, id)
}

func (r *DesktopHostRPC) PtyInspect(ctx context.Context, id string) (HostPtyInfo, error) {
	return r.host.PtyInspect(ctx, id)
}

func (r *DesktopHostRPC) Status(ctx context.Context) (HostStatus, error) {
	return r.host.Status(ctx)
}

func (r *DesktopHostRPC) Open(ctx context.Context, path string) error {
	return r.host.Open(ctx, path)
}

func (r *DesktopHostRPC) Quit(ctx context.Context) error {
	return r.host.Quit(ctx)
}

func (r *DesktopHostRPC) Restart(ctx context.Context) error {
	return r.host.Restart(ctx)
}
