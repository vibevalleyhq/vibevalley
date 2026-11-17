package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

type fakePTYSession struct {
	mu      sync.Mutex
	info    TerminalInfo
	written [][]byte
	resizes [][2]int
	killed  bool
	done    chan struct{}
	onData  func([]byte)
	onExit  func(int)
}

func (f *fakePTYSession) Write(data []byte) error {
	f.mu.Lock()
	f.written = append(f.written, append([]byte(nil), data...))
	f.mu.Unlock()
	return nil
}

func (f *fakePTYSession) Resize(cols, rows int) error {
	f.mu.Lock()
	f.info.Cols = cols
	f.info.Rows = rows
	f.resizes = append(f.resizes, [2]int{cols, rows})
	f.mu.Unlock()
	return nil
}

func (f *fakePTYSession) Kill() error {
	f.mu.Lock()
	wasKilled := f.killed
	f.killed = true
	f.info.Running = false
	f.info.Exited = true
	f.mu.Unlock()
	if !wasKilled {
		close(f.done)
	}
	return nil
}

func (f *fakePTYSession) Inspect() TerminalInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.info
}

func (f *fakePTYSession) Done() <-chan struct{} {
	return f.done
}

type fakePTYFactory struct {
	mu       sync.Mutex
	sessions map[string]*fakePTYSession
}

func (f *fakePTYFactory) Spawn(_ context.Context, spec TerminalSpawnSpec, onData func([]byte), onExit func(int)) (TerminalSession, error) {
	sess := &fakePTYSession{
		info: TerminalInfo{
			ID:           spec.ID,
			WorktreePath: spec.WorktreePath,
			Cwd:          spec.Cwd,
			Command:      "/bin/zsh",
			PID:          43210,
			Cols:         spec.Cols,
			Rows:         spec.Rows,
			Running:      true,
		},
		done:   make(chan struct{}),
		onData: onData,
		onExit: onExit,
	}
	f.mu.Lock()
	if f.sessions == nil {
		f.sessions = map[string]*fakePTYSession{}
	}
	f.sessions[spec.ID] = sess
	f.mu.Unlock()
	return sess, nil
}

type fakeUpdateDriver struct {
	mu        sync.Mutex
	state     HostUpdateState
	checkNext HostUpdateState
	checkErr  error
	installed int
}

func (d *fakeUpdateDriver) State(_ context.Context) HostUpdateState {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.state
}

func (d *fakeUpdateDriver) Check(_ context.Context) (HostUpdateState, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.checkErr != nil {
		return HostUpdateState{}, d.checkErr
	}
	d.state = d.checkNext
	return d.checkNext, nil
}

func (d *fakeUpdateDriver) Install(_ context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.installed++
	return nil
}

func TestRegisterDesktopHostAndMyGoTypeScript(t *testing.T) {
	terms := NewTerminalController(&fakePTYFactory{})
	defer terms.CloseAll()

	host := NewDesktopHostService(NewIslandController(IslandOptions{}), terms, DesktopHostConfig{
		Version: "1.2.3",
		Channel: "dev",
	})
	defer host.Close()

	if err := RegisterDesktopHost(host); err != nil {
		t.Fatalf("RegisterDesktopHost: %v", err)
	}
	// Second registration is idempotent via sync.Once.
	if err := RegisterDesktopHost(host); err != nil {
		t.Fatalf("RegisterDesktopHost repeat: %v", err)
	}

	ts, err := mygo.GenerateTypeScript()
	if err != nil {
		t.Fatalf("mygo.GenerateTypeScript: %v", err)
	}
	out := string(ts)
	for _, want := range []string{
		"DesktopHost",
		"Notify",
		"Tray",
		"UpdateState",
		"PtySpawn",
		"PtyWrite",
		"Status",
		"Quit",
		"desktop:ptyData",
		"desktop:ptyExit",
		"desktop:update",
		"desktop:voiceShortcut",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("generated TypeScript missing %q:\n%s", want, out)
		}
	}
}

func TestPreloadScriptInstallsChordAndDesktopHost(t *testing.T) {
	t.Parallel()

	preload := ChordBridgePreloadScript()
	for _, needle := range []string{
		"window.__vibevalleyChordTransport",
		"ChordLink.StreamFrames",
		"ChordLink.SendFrame",
		"window.vibevalleyHost",
		`name: "desktop"`,
		`"DesktopHost."`,
		`invoke("Notify"`,
		`invoke("Tray"`,
		`invoke("Locale"`,
		`invoke("Reveal"`,
		`invoke("Theme"`,
		`invoke("Framing"`,
		`invoke("Opening"`,
		`invoke("UpdateState"`,
		`invoke("UpdateCheck"`,
		`invoke("UpdateInstall"`,
		`invoke("CliState"`,
		`invoke("CliInstall"`,
		`invoke("CliRemove"`,
		`invoke("PtySpawn"`,
		`invoke("PtyWrite"`,
		`invoke("PtyResize"`,
		`invoke("PtyKill"`,
		`invoke("PtyInspect"`,
		"desktop:voiceShortcut",
		"desktop:update",
		"desktop:ptyData",
		"desktop:ptyExit",
		"Alt+Shift+Space",
		"titleBar",
	} {
		if !strings.Contains(preload, needle) {
			t.Fatalf("ChordBridgePreloadScript missing %q", needle)
		}
	}
}

func TestDesktopHostMethodsNotifyTrayLocaleThemeFramingOpening(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	island := NewIslandController(IslandOptions{})

	var (
		gotNotice  HostNotice
		gotLocale  string
		gotTheme   string
		gotFraming string
		gotOpening HostOpening
	)
	host := NewDesktopHostService(island, nil, DesktopHostConfig{
		Version: "0.2.0",
		OnNotify: func(n HostNotice) {
			gotNotice = n
		},
		OnLocale: func(loc string) {
			gotLocale = loc
		},
		OnTheme: func(th string) {
			gotTheme = th
		},
		OnFraming: func(m string) {
			gotFraming = m
		},
		OnOpening: func(op HostOpening) {
			gotOpening = op
		},
	})
	defer host.Close()

	rpc := host.Service()

	if err := rpc.Notify(ctx, HostNotice{}); err == nil {
		t.Fatal("expected error for empty Notice")
	}
	if err := rpc.Notify(ctx, HostNotice{Title: "Build done", Body: "All tests green"}); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if gotNotice.Title != "Build done" || gotNotice.Body != "All tests green" {
		t.Fatalf("unexpected Notice callback payload: %#v", gotNotice)
	}

	// Tray updates IslandController when HasEmbeddedStack is false.
	if err := rpc.Tray(ctx, HostTraySummary{
		Title: "1 waiting",
		Lines: []string{"Waiting on you: Approve PR", "Agent running tests"},
	}); err != nil {
		t.Fatalf("Tray: %v", err)
	}
	issues := island.State().Issues
	if len(issues) != 2 {
		t.Fatalf("expected 2 issues projected onto IslandController, got %#v", issues)
	}
	if issues[0].Status != contract.IssueReview || issues[1].Status != contract.IssueInProgress {
		t.Fatalf("unexpected projected issue statuses: %#v", issues)
	}

	// Empty tray lines clears IslandController issues.
	if err := rpc.Tray(ctx, HostTraySummary{Title: "idle", Lines: nil}); err != nil {
		t.Fatalf("Tray clear: %v", err)
	}
	if len(island.State().Issues) != 0 {
		t.Fatalf("expected IslandController issues cleared on empty tray, got %#v", island.State().Issues)
	}

	// When embedded stack owns the island, Tray does not overwrite real Stack issues.
	realIssue := contract.IssueView{ID: "real-1", Title: "Stack Issue", Status: contract.IssueInProgress}
	island.SetIssues([]contract.IssueView{realIssue})
	host.SyncStack(true, "http://127.0.0.1:9999")
	if err := rpc.Tray(ctx, HostTraySummary{Title: "override", Lines: []string{"should not overwrite"}}); err != nil {
		t.Fatalf("Tray with embedded stack: %v", err)
	}
	if got := island.State().Issues; len(got) != 1 || got[0].ID != "real-1" {
		t.Fatalf("Tray overwrote embedded stack issues: %#v", got)
	}

	// Locale validation & delivery.
	if err := rpc.Locale(ctx, "zh-CN"); err != nil {
		t.Fatalf("Locale zh-CN: %v", err)
	}
	if gotLocale != "zh-CN" {
		t.Fatalf("gotLocale = %q, want zh-CN", gotLocale)
	}
	if err := rpc.Locale(ctx, "invalid locale!"); err == nil {
		t.Fatal("expected invalid locale error")
	}

	// Theme validation & delivery.
	for _, th := range []string{"light", "dark", "system"} {
		if err := rpc.Theme(ctx, th); err != nil {
			t.Fatalf("Theme(%s): %v", th, err)
		}
		if gotTheme != th {
			t.Fatalf("gotTheme = %q, want %q", gotTheme, th)
		}
	}
	if err := rpc.Theme(ctx, "sepia"); err == nil {
		t.Fatal("expected error for invalid theme")
	}

	// Framing & 3:2 snapping helper.
	if err := rpc.Framing(ctx, "free"); err != nil {
		t.Fatalf("Framing free: %v", err)
	}
	if gotFraming != "free" {
		t.Fatalf("gotFraming = %q, want free", gotFraming)
	}
	if err := rpc.Framing(ctx, "bad"); err == nil {
		t.Fatal("expected error for invalid framing mode")
	}
	if w, h := snapFarmSize(1152, 768); w != 1152 || h != 768 {
		t.Fatalf("snapFarmSize exact 3x = (%d,%d), want (1152,768)", w, h)
	}
	if w, h := snapFarmSize(400, 300); w != farmMinWidth || h != farmMinHeight {
		t.Fatalf("snapFarmSize min clamp = (%d,%d), want (%d,%d)", w, h, farmMinWidth, farmMinHeight)
	}

	// Opening phases.
	if err := rpc.Opening(ctx, HostOpening{Phase: "loading", Progress: 55}); err != nil {
		t.Fatalf("Opening loading: %v", err)
	}
	if gotOpening.Phase != "loading" || gotOpening.Progress != 55 {
		t.Fatalf("gotOpening = %#v", gotOpening)
	}
	if err := rpc.Opening(ctx, HostOpening{Phase: "loading", Progress: 101}); err == nil {
		t.Fatal("expected error for progress > 100")
	}
	if err := rpc.Opening(ctx, HostOpening{Phase: "unknown", Progress: 10}); err == nil {
		t.Fatal("expected error for unknown opening phase")
	}
}

func TestDesktopHostRevealContainment(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	allowedHome := t.TempDir()
	allowedRepo := t.TempDir()
	outside := t.TempDir()

	allowedFile := filepath.Join(allowedRepo, "README.md")
	if err := os.WriteFile(allowedFile, []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	outsideFile := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(outsideFile, []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}

	var revealed string
	host := NewDesktopHostService(nil, nil, DesktopHostConfig{
		HomeDir:   allowedHome,
		RepoRoots: []string{allowedRepo},
		OnReveal:  func(p string) { revealed = p },
	})
	defer host.Close()

	if err := host.Reveal(ctx, allowedFile); err != nil {
		t.Fatalf("Reveal allowed file: %v", err)
	}
	canonAllowed, _ := canonicalizePath(allowedFile)
	if revealed != canonAllowed {
		t.Fatalf("revealed = %q, want %q", revealed, canonAllowed)
	}

	if err := host.Reveal(ctx, outsideFile); err == nil {
		t.Fatal("expected error revealing file outside allowed roots")
	}
	if err := host.Reveal(ctx, "relative/path"); err == nil {
		t.Fatal("expected error revealing relative path")
	}
	if err := host.Reveal(ctx, allowedFile+"\x00bad"); err == nil {
		t.Fatal("expected error revealing path containing NUL")
	}

	if runtime.GOOS != "windows" {
		escapeLink := filepath.Join(allowedRepo, "escape")
		if err := os.Symlink(outside, escapeLink); err != nil {
			t.Fatal(err)
		}
		if err := host.Reveal(ctx, filepath.Join(escapeLink, "secret.txt")); err == nil {
			t.Fatal("expected symlink escape reveal to be denied")
		}
	}
}

func TestDesktopHostCommandLineSymlinkLifecycle(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink test")
	}

	ctx := context.Background()
	binDir := t.TempDir()
	launcher := filepath.Join(t.TempDir(), "vibe")
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\necho ok\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	host := NewDesktopHostService(nil, nil, DesktopHostConfig{
		CLICommand:  "vibevalley",
		CLILauncher: launcher,
		CLIBinDir:   binDir,
		Getenv: func(k string) string {
			if k == "PATH" {
				return binDir + string(os.PathListSeparator) + "/usr/bin"
			}
			return ""
		},
	})
	defer host.Close()

	rpc := host.Service()

	st, err := rpc.CliState(ctx)
	if err != nil {
		t.Fatalf("CliState initial: %v", err)
	}
	if st.Installed || st.Taken || !st.OnPath || st.Command != "vibevalley" {
		t.Fatalf("unexpected initial CliState: %#v", st)
	}

	st, err = rpc.CliInstall(ctx)
	if err != nil {
		t.Fatalf("CliInstall: %v", err)
	}
	if !st.Installed || st.Taken {
		t.Fatalf("expected installed=true after CliInstall: %#v", st)
	}

	st, err = rpc.CliRemove(ctx)
	if err != nil {
		t.Fatalf("CliRemove: %v", err)
	}
	if st.Installed || st.Taken {
		t.Fatalf("expected installed=false after CliRemove: %#v", st)
	}

	// Occupy target link with a third-party binary -> taken=true and CliInstall refuses.
	if err := os.WriteFile(st.Link, []byte("#!/bin/sh\necho foreign\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	st, err = rpc.CliState(ctx)
	if err != nil {
		t.Fatalf("CliState taken: %v", err)
	}
	if !st.Taken || st.Installed {
		t.Fatalf("expected taken=true, installed=false: %#v", st)
	}
	if _, err := rpc.CliInstall(ctx); err == nil {
		t.Fatal("expected CliInstall to refuse when link is taken")
	}
}

func TestDesktopHostUpdateWatchCheckInstall(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	newFarm := true
	drv := &fakeUpdateDriver{
		state: HostUpdateState{Tag: "idle", Version: "1.0.0"},
		checkNext: HostUpdateState{
			Tag:     "ready",
			Version: "1.0.0",
			Next:    "1.1.0",
			Notes:   []string{"New Go host"},
			NewFarm: &newFarm,
			Page:    "https://vibevalley.dev/releases/v1.1.0",
		},
	}

	var events []HostUpdateState
	host := NewDesktopHostService(nil, nil, DesktopHostConfig{
		Version:      "1.0.0",
		UpdateDriver: drv,
		OnUpdate:     func(st HostUpdateState) { events = append(events, st) },
	})
	defer host.Close()

	rpc := host.Service()
	st, err := rpc.UpdateState(ctx)
	if err != nil || st.Tag != "idle" {
		t.Fatalf("UpdateState = (%#v, %v)", st, err)
	}

	if err := rpc.UpdateCheck(ctx); err != nil {
		t.Fatalf("UpdateCheck: %v", err)
	}
	if len(events) != 2 || events[0].Tag != "checking" || events[1].Tag != "ready" || events[1].Next != "1.1.0" {
		t.Fatalf("unexpected update events: %#v", events)
	}

	if err := rpc.UpdateInstall(ctx); err != nil {
		t.Fatalf("UpdateInstall: %v", err)
	}
	if drv.installed != 1 {
		t.Fatalf("expected driver Install called once, got %d", drv.installed)
	}

	// Driver error emits failed update event.
	drv.checkErr = errors.New("network timeout")
	if err := rpc.UpdateCheck(ctx); err == nil {
		t.Fatal("expected UpdateCheck error")
	}
	if last := events[len(events)-1]; last.Tag != "failed" || !strings.Contains(last.Why, "network timeout") {
		t.Fatalf("expected failed update event, got %#v", last)
	}
}

func TestDesktopHostTerminalPTYBridgeAndBase64Events(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	repoRoot := t.TempDir()
	outside := t.TempDir()
	factory := &fakePTYFactory{}
	terms := NewTerminalController(factory, repoRoot)
	defer terms.CloseAll()

	var (
		mu       sync.Mutex
		dataEvts []HostPtyDataEvent
		exitEvts []HostPtyExitEvent
		shortcut int
	)
	host := NewDesktopHostService(nil, terms, DesktopHostConfig{
		RepoRoots:       []string{repoRoot},
		OnPtyData:       func(ev HostPtyDataEvent) { mu.Lock(); dataEvts = append(dataEvts, ev); mu.Unlock() },
		OnPtyExit:       func(ev HostPtyExitEvent) { mu.Lock(); exitEvts = append(exitEvts, ev); mu.Unlock() },
		OnVoiceShortcut: func() { mu.Lock(); shortcut++; mu.Unlock() },
	})

	rpc := host.Service()

	// Reject cwd outside registered repo root.
	if _, err := rpc.PtySpawn(ctx, HostPtySpawnInput{ID: "bad", Cwd: outside, Cols: 80, Rows: 24}); err == nil {
		t.Fatal("expected PtySpawn outside root to fail")
	}

	spawned, err := rpc.PtySpawn(ctx, HostPtySpawnInput{ID: "term-1", Cwd: repoRoot, Cols: 100, Rows: 30})
	if err != nil {
		t.Fatalf("PtySpawn: %v", err)
	}
	if spawned.PID != 43210 {
		t.Fatalf("PID = %d, want 43210", spawned.PID)
	}

	// Base64 decode on PtyWrite.
	wantBytes := []byte("echo hello\r\n")
	if err := rpc.PtyWrite(ctx, HostPtyWriteInput{
		ID:   "term-1",
		Data: base64.StdEncoding.EncodeToString(wantBytes),
	}); err != nil {
		t.Fatalf("PtyWrite: %v", err)
	}
	if err := rpc.PtyWrite(ctx, HostPtyWriteInput{ID: "term-1", Data: "!!!not-base64!!!"}); err == nil {
		t.Fatal("expected error for invalid base64 in PtyWrite")
	}

	sess := factory.sessions["term-1"]
	if sess == nil || len(sess.written) != 1 || !slices.Equal(sess.written[0], wantBytes) {
		t.Fatalf("unexpected written bytes on PTY session: %#v", sess)
	}

	if err := rpc.PtyResize(ctx, HostPtyResizeInput{ID: "term-1", Cols: 120, Rows: 40}); err != nil {
		t.Fatalf("PtyResize: %v", err)
	}
	info, err := rpc.PtyInspect(ctx, "term-1")
	if err != nil {
		t.Fatalf("PtyInspect: %v", err)
	}
	canonRoot, _ := canonicalizePath(repoRoot)
	if info.Cwd != canonRoot || info.Command != "/bin/zsh" {
		t.Fatalf("PtyInspect = %#v, want cwd=%q cmd=/bin/zsh", info, canonRoot)
	}

	// Simulate PTY output & exit -> base64 data & exit events forwarded to DesktopHostService.
	sess.onData([]byte("hello pty"))
	sess.onExit(7)

	host.TriggerVoiceShortcut()

	mu.Lock()
	if len(dataEvts) != 1 || dataEvts[0].ID != "term-1" {
		mu.Unlock()
		t.Fatalf("unexpected dataEvts: %#v", dataEvts)
	}
	decoded, decErr := base64.StdEncoding.DecodeString(dataEvts[0].Data)
	if decErr != nil || string(decoded) != "hello pty" {
		mu.Unlock()
		t.Fatalf("decoded PTY event = (%q, %v), want hello pty", string(decoded), decErr)
	}
	if len(exitEvts) != 1 || exitEvts[0].ID != "term-1" || exitEvts[0].Code != 7 {
		mu.Unlock()
		t.Fatalf("unexpected exitEvts: %#v", exitEvts)
	}
	if shortcut != 1 {
		mu.Unlock()
		t.Fatalf("shortcut count = %d, want 1", shortcut)
	}
	mu.Unlock()

	if err := rpc.PtyKill(ctx, "term-1"); err != nil {
		t.Fatalf("PtyKill: %v", err)
	}

	// After Close(), terminal output is no longer delivered and voice shortcut is ignored.
	host.Close()
	sess.onData([]byte("after close"))
	host.TriggerVoiceShortcut()

	mu.Lock()
	defer mu.Unlock()
	if len(dataEvts) != 1 || shortcut != 1 {
		t.Fatalf("events fired after host.Close(): data=%d shortcut=%d", len(dataEvts), shortcut)
	}
}

func TestDesktopHostControlUnixSocketAndDesktopAppClose(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("Unix socket test")
	}

	sockDir, err := os.MkdirTemp("", "vhctrl-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sockDir) })
	sockPath := filepath.Join(sockDir, "desktop.sock")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var (
		openedRoute string
		quitCount   int
	)
	host := NewDesktopHostService(nil, nil, DesktopHostConfig{
		Version:   "0.3.0",
		Channel:   "beta",
		ServerURL: "http://127.0.0.1:8787",
		OnOpen:    func(r string) { openedRoute = r },
		OnQuit:    func() { quitCount++ },
	})
	defer host.Close()

	ln, done, err := host.ListenControlUnix(ctx, sockPath)
	if err != nil {
		t.Fatalf("ListenControlUnix: %v", err)
	}
	defer func() {
		_ = ln.Close()
		<-done
	}()

	callCtrl := func(req desktopControlReq) desktopControlResp {
		conn, dErr := net.Dial("unix", sockPath)
		if dErr != nil {
			t.Fatalf("dial %s: %v", sockPath, dErr)
		}
		defer conn.Close()

		b, _ := json.Marshal(req)
		if _, wErr := conn.Write(append(b, '\n')); wErr != nil {
			t.Fatalf("write control req: %v", wErr)
		}
		line, rErr := bufio.NewReader(conn).ReadBytes('\n')
		if rErr != nil {
			t.Fatalf("read control resp: %v", rErr)
		}
		var resp desktopControlResp
		if uErr := json.Unmarshal(line, &resp); uErr != nil {
			t.Fatalf("unmarshal control resp: %v", uErr)
		}
		return resp
	}

	// status
	resp := callCtrl(desktopControlReq{ID: 1, Call: "status"})
	if !resp.OK {
		t.Fatalf("status failed: %s", resp.Error)
	}
	outBytes, _ := json.Marshal(resp.Output)
	var st HostStatus
	if err := json.Unmarshal(outBytes, &st); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if st.Name != "VibeValley" || st.Version != "0.3.0" || st.Channel != "beta" || st.Server != "http://127.0.0.1:8787" {
		t.Fatalf("unexpected HostStatus: %#v", st)
	}

	// open valid and invalid routes
	resp = callCtrl(desktopControlReq{ID: 2, Call: "open", Input: json.RawMessage(`"/repos"`)})
	if !resp.OK || openedRoute != "/repos" {
		t.Fatalf("open /repos = (%#v, openedRoute=%q)", resp, openedRoute)
	}
	resp = callCtrl(desktopControlReq{ID: 3, Call: "open", Input: json.RawMessage(`"repos"`)})
	if resp.OK {
		t.Fatal("expected open without leading '/' to fail")
	}

	// updateState & quit & unknown
	resp = callCtrl(desktopControlReq{ID: 4, Call: "updateState"})
	if !resp.OK {
		t.Fatalf("updateState failed: %s", resp.Error)
	}
	resp = callCtrl(desktopControlReq{ID: 5, Call: "quit"})
	if !resp.OK || quitCount != 1 {
		t.Fatalf("quit = (%#v, quitCount=%d)", resp, quitCount)
	}
	resp = callCtrl(desktopControlReq{ID: 6, Call: "bogus"})
	if resp.OK {
		t.Fatal("expected unknown method error")
	}

	// Verify NewDesktopApp wires Host and Close cleanly.
	app, err := NewDesktopApp(context.Background(), DesktopConfig{
		HomeDir:       t.TempDir(),
		ServerURL:     "http://127.0.0.1:8787",
		RepoRoots:     []string{t.TempDir()},
		HeadlessCheck: true,
	}, DesktopDeps{
		Keychain:        NewMemoryKeychainDriver(),
		TerminalFactory: &fakePTYFactory{},
	})
	if err != nil {
		t.Fatalf("NewDesktopApp: %v", err)
	}
	if app.Host == nil {
		t.Fatal("expected DesktopApp.Host to be initialized")
	}
	if !strings.Contains(app.WebConfig.PreloadJS, "window.vibevalleyHost") {
		t.Fatal("expected DesktopApp.WebConfig.PreloadJS to contain window.vibevalleyHost")
	}
	if err := app.Close(); err != nil {
		t.Fatalf("DesktopApp.Close: %v", err)
	}
}
